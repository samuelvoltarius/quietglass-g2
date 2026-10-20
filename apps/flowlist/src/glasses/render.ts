import {
  CreateStartUpPageContainer,
  ImageContainerProperty,
  ImageRawDataUpdate,
  ImageRawDataUpdateResult,
  MenuContainerProperty,
  MenuItemProperty,
  TextContainerProperty,
  TextContainerUpgrade,
  RebuildPageContainer,
  StartUpPageCreateResult,
  type EvenAppBridge,
} from "@evenrealities/even_hub_sdk";
import type { FlowView } from "./view";
import { encodeBitmap } from "./pixel";
import { BAR_IMAGE_HEIGHT, BAR_IMAGE_WIDTH, type Bitmap } from "./progressbar";
import { drawStepHalves, STEP_LEFT, STEP_RIGHT, type StepLayout } from "./stepimage";
import { tileSlots, type TileSend, type TileSlot } from "../screen/sender";

/**
 * Renders the checklist onto the G2.
 *
 * Layout is fixed at three stacked text containers on the 576 x 288 display,
 * with the progress bar image in the right half of the header row. After the
 * page exists, updates go through `textContainerUpgrade`, which
 * changes text without rebuilding the page — on real hardware a rebuild falls
 * back to a full page creation and costs seconds, discarding input meanwhile.
 */

export const SCREEN_WIDTH = 576;
export const SCREEN_HEIGHT = 288;

interface ContainerSpec {
  readonly id: number;
  readonly name: string;
  readonly y: number;
  readonly height: number;
}

const CONTAINER: Readonly<Record<"header" | "body" | "footer", ContainerSpec>> = {
  header: { id: 1, name: "header", y: 0, height: 32 },
  // Four rows of support under the big step picture (y 34 … 130).
  body: { id: 2, name: "body", y: 132, height: 118 },
  footer: { id: 3, name: "footer", y: 252, height: 34 },
};

export interface RenderResult {
  readonly ok: boolean;
  /** Present when page creation failed, for the caller to surface or log. */
  readonly reason?: string;
}

/** The header text keeps the left half; the bar takes the right half of that row. */
export const HEADER_TEXT_PX = 288;
export const PROGRESS_BAR = { id: 4, name: "progress", x: 292, y: 4 } as const;

/** QIS v1.2: one item of the glasses' side menu (id > 0, label at most 32 bytes). */
export interface MenuItemSpec { readonly id: number; readonly label: string }
export interface MenuSpec { readonly items: readonly MenuItemSpec[] }

/** The side menu as the SDK wants it (`menuObject` of the page), as in Babel Glass. */
export function buildMenu(menu: MenuSpec | null): MenuContainerProperty | undefined {
  if (menu === null || menu.items.length === 0) return undefined;
  return new MenuContainerProperty({
    menuItems: menu.items.map((item) => new MenuItemProperty({ itemName: item.label, itemID: item.id })),
  });
}

export function buildPage(view: FlowView, menu: MenuSpec | null = null): CreateStartUpPageContainer {
  const menuObject = buildMenu(menu);
  return new CreateStartUpPageContainer({
    ...(menuObject === undefined ? {} : { menuObject }),
    containerTotalNum: 6,
    textObject: [
      text(CONTAINER.header, view.header, 1, false, HEADER_TEXT_PX),
      // Exactly one container may capture input; the body owns it.
      text(CONTAINER.body, view.body.join("\n"), 2, true),
      text(CONTAINER.footer, view.footer, 3, false),
    ],
    // Image containers take 20-288 x 20-144 px.
    imageObject: [
      new ImageContainerProperty({
        containerID: PROGRESS_BAR.id, containerName: PROGRESS_BAR.name, xPosition: PROGRESS_BAR.x, yPosition: PROGRESS_BAR.y,
        width: BAR_IMAGE_WIDTH, height: BAR_IMAGE_HEIGHT, zOrderIndex: 4,
      }),
      ...[STEP_LEFT, STEP_RIGHT].map((half, index) => new ImageContainerProperty({
        containerID: half.id, containerName: half.name, xPosition: half.x, yPosition: half.y,
        width: half.width, height: half.height, zOrderIndex: 5 + index,
      })),
    ],
  });
}

/** A text page without images (start page, task list): header, body, footer across the full width. */
export function buildTextPage(view: FlowView): CreateStartUpPageContainer {
  return new CreateStartUpPageContainer({
    containerTotalNum: 3,
    textObject: [
      text(CONTAINER.header, view.header, 1, false),
      // Exactly one container may capture input; the body owns it.
      text({ ...CONTAINER.body, y: 36, height: 214 }, view.body.join("\n"), 2, true),
      text(CONTAINER.footer, view.footer, 3, false),
    ],
  });
}

/** The cockpit's four image containers; one empty text container under them owns the input. */
export const COCKPIT_TILES = tileSlots(21, "flowlist");
const COCKPIT_INPUT_ID = 20;

export function buildCockpitPage(): CreateStartUpPageContainer {
  return new CreateStartUpPageContainer({
    containerTotalNum: 1 + COCKPIT_TILES.length,
    textObject: [new TextContainerProperty({
      containerID: COCKPIT_INPUT_ID, containerName: "cockpit-input", xPosition: 0, yPosition: 0, width: SCREEN_WIDTH, height: SCREEN_HEIGHT,
      paddingLength: 0, zOrderIndex: 1, isEventCapture: 1, content: " ",
    })],
    imageObject: COCKPIT_TILES.map((tile, index) => new ImageContainerProperty({
      containerID: tile.id, containerName: tile.name, xPosition: tile.x, yPosition: tile.y, width: tile.width, height: tile.height, zOrderIndex: index + 2,
    })),
  });
}

function text(
  spec: ContainerSpec,
  content: string,
  zOrderIndex: number,
  captureEvents: boolean,
  width = SCREEN_WIDTH,
): TextContainerProperty {
  return new TextContainerProperty({
    containerID: spec.id,
    containerName: spec.name,
    xPosition: 0,
    yPosition: spec.y,
    width,
    height: spec.height,
    paddingLength: 4,
    zOrderIndex,
    isEventCapture: captureEvents ? 1 : 0,
    content: content || " ",
  });
}

/**
 * Every call into the glasses is bounded. Draws run one after another, so a
 * single answer that never comes (a Bluetooth write lost on the way) used to
 * freeze the display for good on whatever it showed last. A call that times
 * out counts as failed: the caller marks the page broken and the next draw
 * rebuilds it.
 */
export const PAGE_CALL_MS = 8_000;
export const TEXT_CALL_MS = 5_000;
export const IMAGE_CALL_MS = 10_000;

function bounded<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: no answer from the glasses within ${ms} ms`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Puts the page on the glasses: created once per bridge, every later call
 * (reconnect) rebuilds it. The caller resends all images afterwards.
 */
const started = new WeakSet<object>();

/**
 * The next page goes the way of the very first one again (rebuild + create).
 * Needed after the system's exit dialog was cancelled: on the real glasses the
 * dialog takes the page away, and a plain rebuild no longer reaches it (store
 * review 16.10.2026: "after No, double-tap can no longer open the exit window").
 */
export function forgetPage(bridge: EvenAppBridge): void {
  started.delete(bridge);
}

async function installPage(bridge: EvenAppBridge, page: CreateStartUpPageContainer): Promise<RenderResult> {
  sentLength.clear();
  // One creation per bridge, then only rebuilds: a rebuild before the first
  // creation or a second creation leaves the page without its input route.
  if (started.has(bridge)) {
    try {
      const ok = await bounded(bridge.rebuildPageContainer(new RebuildPageContainer({ ...page })), PAGE_CALL_MS, "rebuild");
      return ok ? { ok: true } : { ok: false, reason: "rebuild refused" };
    } catch (error) {
      return { ok: false, reason: errorMessage(error) };
    }
  }
  try {
    // Measured on real glasses: the first page needs one rebuild call before the creation
    // (it registers input); the result is ignored.
    await bounded(bridge.rebuildPageContainer(new RebuildPageContainer({ ...page })), PAGE_CALL_MS, "rebuild");
  } catch {
    // Expected to fail before the first page.
  }
  try {
    const result = await bounded(bridge.createStartUpPageContainer(page), PAGE_CALL_MS, "create page");
    if (result === StartUpPageCreateResult.success) { started.add(bridge); return { ok: true }; }
    return { ok: false, reason: describeCreateResult(result) };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

/** The run page: the step picture, the progress bar and three text containers. A rebuild without the menu would clear it, so every rebuild supplies it again. */
export const createPage = (bridge: EvenAppBridge, view: FlowView, menu: MenuSpec | null = null): Promise<RenderResult> =>
  installPage(bridge, buildPage(view, menu));
export const createTextPage = (bridge: EvenAppBridge, view: FlowView): Promise<RenderResult> =>
  installPage(bridge, buildTextPage(view));
export const createCockpitPage = (bridge: EvenAppBridge): Promise<RenderResult> =>
  installPage(bridge, buildCockpitPage());

/** Fast path: change the text of the three containers in place. */

/**
 * Ghost-text guard for `textContainerUpgrade`: the lens blanks exactly
 * `contentLength` characters, so it must always be at least the length the
 * container held before, or leftovers of the old text stay visible. Text is
 * additionally capped at the ~900-character firmware hard limit.
 */
const TEXT_HARD_CAP = 900;
const sentLength = new Map<number, number>();

function guarded(specId: number, content: string): { content: string; contentLength: number } {
  const text = (content || " ").slice(0, TEXT_HARD_CAP);
  const length = Math.max(sentLength.get(specId) ?? 0, text.length);
  sentLength.set(specId, text.length);
  return { content: text, contentLength: length };
}

export async function updatePage(bridge: EvenAppBridge, view: FlowView): Promise<RenderResult> {
  const updates: Array<[ContainerSpec, string]> = [
    [CONTAINER.header, view.header],
    [CONTAINER.body, view.body.join("\n")],
    [CONTAINER.footer, view.footer],
  ];

  try {
    for (const [spec, content] of updates) {
      await bounded(bridge.textContainerUpgrade(new TextContainerUpgrade({
        containerID: spec.id,
        containerName: spec.name,
        ...guarded(spec.id, content),
      })), TEXT_CALL_MS, "text " + spec.name);
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

/**
 * Sends the progress bar. Separate from the text on purpose: an image is a
 * slow BLE transfer, and the caller runs it on its own lane (image-sync.ts).
 */
export async function sendProgressBar(bridge: EvenAppBridge, bitmap: Bitmap): Promise<RenderResult> {
  try {
    const imageData = await encodeBitmap(bitmap);
    const result = await bounded(bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: PROGRESS_BAR.id, containerName: PROGRESS_BAR.name, imageData })), IMAGE_CALL_MS, "image " + PROGRESS_BAR.name);
    return result === ImageRawDataUpdateResult.success ? { ok: true } : { ok: false, reason: `image:${String(result)}` };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

/** Sends the current step picture: the left and the right half, one after the other. */
export async function sendStepImage(bridge: EvenAppBridge, layout: StepLayout | null): Promise<RenderResult> {
  try {
    const halves = drawStepHalves(layout);
    for (const [index, half] of [STEP_LEFT, STEP_RIGHT].entries()) {
      const imageData = await encodeBitmap(halves[index]!);
      const result = await bounded(bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: half.id, containerName: half.name, imageData })), IMAGE_CALL_MS, "image " + half.name);
      if (result !== ImageRawDataUpdateResult.success) return { ok: false, reason: `image:${String(result)}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

/** One image tile to the glasses; resolves true on success. */
export async function sendTile(bridge: EvenAppBridge, slot: TileSlot, imageData: Uint8Array): Promise<boolean> {
  const result = await bounded(bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: slot.id, containerName: slot.name, imageData })), IMAGE_CALL_MS, "image " + slot.name);
  return result === ImageRawDataUpdateResult.success;
}

/**
 * The tile sender's write function. It writes only while `allowed()` says so: not while the system exit
 * dialog may be on screen (a page call could cover it) and not after the cockpit page has been left.
 * A refused tile counts as failed and is tried again with the next frame.
 */
export function guardedTileSend(bridge: EvenAppBridge, allowed: () => boolean): TileSend {
  return (slot, png) => (allowed() ? sendTile(bridge, slot, png) : Promise.resolve(false));
}

export function describeCreateResult(result: StartUpPageCreateResult): string {
  switch (result) {
    case StartUpPageCreateResult.success: return "success";
    case StartUpPageCreateResult.invalid: return "page rejected as invalid";
    case StartUpPageCreateResult.oversize: return "page exceeds the display budget";
    case StartUpPageCreateResult.outOfMemory: return "glasses are out of memory";
    default: return `unknown result (${String(result)})`;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
