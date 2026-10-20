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
import type { CaptionView } from "./view";
import { tileSlots, type TileSend, type TileSlot } from "../screen/sender";
import { ICON_HEIGHT, ICON_WIDTH, iconKey, iconPng, type PixelIcon } from "./icon";

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

export function bounded<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: no answer from the glasses within ${ms} ms`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Renders the captions onto the G2.
 *
 * Layout is fixed at three stacked text containers on the 576 x 288 display.
 * After the page exists, updates go through `textContainerUpgrade`, which
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
  readonly width?: number;
}

/** Layout: sign top right in the header, captions on the full width below. */
const CONTAINER: Readonly<Record<"header" | "body" | "footer", ContainerSpec>> = {
  header: { id: 1, name: "header", y: 0, height: 32, width: SCREEN_WIDTH - ICON_WIDTH },
  body: { id: 2, name: "body", y: 36, height: 214 },
  footer: { id: 3, name: "footer", y: 252, height: 34 },
};
const ICON = { id: 4, name: "sign" } as const;

export interface RenderResult {
  readonly ok: boolean;
  /** Present when page creation failed, for the caller to surface or log. */
  readonly reason?: string;
}

/** 0.7.0: one item of the glasses' side menu (id > 0, label at most 32 bytes). */
export interface MenuItemSpec { readonly id: number; readonly label: string }
export interface MenuSpec {
  /** Changes exactly when the glasses need a different menu (=> one rebuild). */
  readonly key: string;
  readonly items: readonly MenuItemSpec[];
}

/** The side menu as the SDK wants it (`menuObject` of the page), as in Quiet Hub. */
export function buildMenu(menu: MenuSpec | null): MenuContainerProperty | undefined {
  if (menu === null || menu.items.length === 0) return undefined;
  return new MenuContainerProperty({
    menuItems: menu.items.map((item) => new MenuItemProperty({ itemName: item.label, itemID: item.id })),
  });
}

export function buildPage(view: CaptionView, menu: MenuSpec | null = null): CreateStartUpPageContainer {
  const menuObject = buildMenu(menu);
  return new CreateStartUpPageContainer({
    ...(menuObject === undefined ? {} : { menuObject }),
    containerTotalNum: 4,
    textObject: [
      text(CONTAINER.header, view.header, 1, false),
      // Exactly one container may capture input; the body owns it.
      text(CONTAINER.body, view.body.join("\n"), 2, true),
      text(CONTAINER.footer, view.footer, 3, false),
    ],
    imageObject: [new ImageContainerProperty({
      containerID: ICON.id,
      containerName: ICON.name,
      xPosition: SCREEN_WIDTH - ICON_WIDTH,
      yPosition: 1,
      width: ICON_WIDTH,
      height: ICON_HEIGHT,
      zOrderIndex: 4,
    })],
  });
}

function text(
  spec: ContainerSpec,
  content: string,
  zOrderIndex: number,
  captureEvents: boolean,
): TextContainerProperty {
  return new TextContainerProperty({
    containerID: spec.id,
    containerName: spec.name,
    xPosition: 0,
    yPosition: spec.y,
    width: spec.width ?? SCREEN_WIDTH,
    height: spec.height,
    paddingLength: 4,
    zOrderIndex,
    isEventCapture: captureEvents ? 1 : 0,
    content: content || " ",
  });
}

/** Bridges that already have their startup page. */
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

/**
 * Puts the page on the glasses. Measured on real glasses (13.10.2026):
 * - the very first page needs a `rebuildPageContainer` call BEFORE the
 *   creation - without it Babel 0.2.5 no longer saw any tap;
 * - `createStartUpPageContainer` must run only once - a second creation
 *   (OpenGlance Nav 0.5.1) left the app deaf too. Later calls rebuild.
 */
export async function createPage(bridge: EvenAppBridge, view: CaptionView, menu: MenuSpec | null = null): Promise<RenderResult> {
  return installPage(bridge, buildPage(view, menu));
}

/** The summary cockpit's page (QUS v1): four image tiles over the display and one empty text container that owns the input. */
export const COCKPIT_TILES = tileSlots(21, "babel");
const COCKPIT_INPUT_ID = 20;

export function buildCockpitPage(menu: MenuSpec | null = null): CreateStartUpPageContainer {
  const menuObject = buildMenu(menu);
  return new CreateStartUpPageContainer({
    ...(menuObject === undefined ? {} : { menuObject }),
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

export const createCockpitPage = (bridge: EvenAppBridge, menu: MenuSpec | null = null): Promise<RenderResult> =>
  installPage(bridge, buildCockpitPage(menu));

/** One image tile to the glasses; resolves true on success. */
export async function sendTile(bridge: EvenAppBridge, slot: TileSlot, imageData: Uint8Array): Promise<boolean> {
  const result = await bounded(bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: slot.id, containerName: slot.name, imageData })), IMAGE_CALL_MS, "image " + slot.name);
  return result === ImageRawDataUpdateResult.success;
}

/**
 * The tile sender's write function. It writes only while `allowed()` says so: not while the system exit dialog
 * may be on screen and not after the cockpit page has been left (its containers are gone).
 */
export function guardedTileSend(bridge: EvenAppBridge, allowed: () => boolean): TileSend {
  return (slot, png) => (allowed() ? sendTile(bridge, slot, png) : Promise.resolve(false));
}

async function installPage(bridge: EvenAppBridge, page: CreateStartUpPageContainer): Promise<RenderResult> {
  // A new page has an empty image container: the sign must be sent again.
  lastIcon.delete(bridge);
  if (started.has(bridge)) {
    try {
      const ok = await bounded(bridge.rebuildPageContainer(new RebuildPageContainer({ ...page })), PAGE_CALL_MS, "rebuild");
      return ok ? { ok: true } : { ok: false, reason: "rebuild refused" };
    } catch (error) {
      return { ok: false, reason: errorMessage(error) };
    }
  }
  try {
    await bounded(bridge.rebuildPageContainer(new RebuildPageContainer({ ...page })), PAGE_CALL_MS, "rebuild");
  } catch {
    // Expected to fail before the first page; the call still registers input.
  }
  try {
    const result = await bounded(bridge.createStartUpPageContainer(page), PAGE_CALL_MS, "create page");
    if (result === StartUpPageCreateResult.success) { started.add(bridge); return { ok: true }; }
    return { ok: false, reason: describeCreateResult(result) };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

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

export async function updatePage(bridge: EvenAppBridge, view: CaptionView): Promise<RenderResult> {
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

/** Last sign sent per bridge, so an unchanged frame is never sent again. */
const lastIcon = new WeakMap<object, string>();
/** Bridges that cannot draw images (no canvas, no API): stop trying after a few failures. */
const iconFailures = new WeakMap<object, number>();

/**
 * Sends the header sign. Cheap when nothing changed (same frame = no call);
 * never throws - a missing sign must not stop the captions.
 */
export async function updateIcon(bridge: EvenAppBridge, icon: PixelIcon): Promise<boolean> {
  const key = iconKey(icon);
  if (lastIcon.get(bridge) === key) return true;
  if ((iconFailures.get(bridge) ?? 0) >= 3) return false;
  const fail = (): boolean => { iconFailures.set(bridge, (iconFailures.get(bridge) ?? 0) + 1); return false; };
  try {
    if (typeof (bridge as { updateImageRawData?: unknown }).updateImageRawData !== "function") return fail();
    const imageData = await iconPng(icon);
    const result = await bounded(bridge.updateImageRawData(new ImageRawDataUpdate({
      containerID: ICON.id,
      containerName: ICON.name,
      imageData,
    })), IMAGE_CALL_MS, "icon image");
    if (result === ImageRawDataUpdateResult.success) {
      lastIcon.set(bridge, key);
      iconFailures.set(bridge, 0);
      return true;
    }
    return fail();
  } catch {
    return fail();
  }
}
