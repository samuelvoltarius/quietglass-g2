import {
  CreateStartUpPageContainer,
  MenuContainerProperty,
  MenuItemProperty,
  ImageContainerProperty,
  ImageRawDataUpdate,
  ImageRawDataUpdateResult,
  TextContainerProperty,
  TextContainerUpgrade,
  RebuildPageContainer,
  StartUpPageCreateResult,
  type EvenAppBridge,
} from "@evenrealities/even_hub_sdk";
import type { ClockView } from "./view";
import { encodeBitmap } from "./pixel";
import { DAY_BAR_HEIGHT, DAY_BAR_WIDTH, type Bitmap } from "./daybar";

/**
 * Renders the time tracker onto the G2.
 *
 * Layout is fixed at three stacked text containers on the 576 x 288 display,
 * plus the day bar image beside the body. After the page exists, updates go through `textContainerUpgrade`, which
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
  body: { id: 2, name: "body", y: 36, height: 214 },
  footer: { id: 3, name: "footer", y: 252, height: 34 },
};

export interface RenderResult {
  readonly ok: boolean;
  /** Present when page creation failed, for the caller to surface or log. */
  readonly reason?: string;
}

/** The day bar sits where the pixel icon was: left of the body, below the header. */
export const DAY_BAR = { id: 4, name: "day-bar", x: 0, y: 36 } as const;

/** One item of the glasses' side menu (id > 0, label at most 32 bytes). QIS v1.2. */
export interface MenuItemSpec { readonly id: number; readonly label: string }
export interface MenuSpec {
  /** Changes exactly when the glasses need a different menu (=> one rebuild). */
  readonly key: string;
  readonly items: readonly MenuItemSpec[];
}

/** The side menu as the SDK wants it (`menuObject` of the page), as in Babel Glass. */
export function buildMenu(menu: MenuSpec | null): MenuContainerProperty | undefined {
  if (menu === null || menu.items.length === 0) return undefined;
  return new MenuContainerProperty({
    menuItems: menu.items.map((item) => new MenuItemProperty({ itemName: item.label, itemID: item.id })),
  });
}

export function buildPage(view: ClockView, menu: MenuSpec | null = null): CreateStartUpPageContainer {
  const menuObject = buildMenu(menu);
  return new CreateStartUpPageContainer({
    ...(menuObject === undefined ? {} : { menuObject }),
    containerTotalNum: 4,
    textObject: [
      text(CONTAINER.header, view.header, 1, false),
      // Exactly one container may capture input; the body owns it.
      text(CONTAINER.body, view.body.join("\n"), 2, true, true),
      text(CONTAINER.footer, view.footer, 3, false),
    ],
    // Image containers take 20-288 x 20-144 px; the bar uses 96 x 144.
    imageObject: [new ImageContainerProperty({
      containerID: DAY_BAR.id, containerName: DAY_BAR.name, xPosition: DAY_BAR.x, yPosition: DAY_BAR.y,
      width: DAY_BAR_WIDTH, height: DAY_BAR_HEIGHT, zOrderIndex: 4,
    })],
  });
}

function text(
  spec: ContainerSpec,
  content: string,
  zOrderIndex: number,
  captureEvents: boolean,
  compact = false,
): TextContainerProperty {
  return new TextContainerProperty({
    containerID: spec.id,
    containerName: spec.name,
    xPosition: compact ? 104 : 0,
    yPosition: spec.y,
    width: compact ? SCREEN_WIDTH - 104 : SCREEN_WIDTH,
    height: spec.height,
    paddingLength: 4,
    zOrderIndex,
    isEventCapture: captureEvents ? 1 : 0,
    content: content || " ",
  });
}

/** Bridges that already have their one start-up page. */
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
 * Every call into the glasses is bounded. Draws run one after another, so one
 * answer that never comes (a Bluetooth write lost on the way) used to freeze
 * the display for good on its last page. A call that times out counts as
 * failed: the caller marks the page broken and the next draw rebuilds it.
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
 * (after a failure, a reconnect or a return to the foreground) rebuilds it.
 * A second `createStartUpPageContainer` leaves the glasses deaf to input
 * (measured on real glasses with OpenGlance 0.5.1). The caller resends the
 * day bar afterwards.
 */
export async function createPage(bridge: EvenAppBridge, view: ClockView, menu: MenuSpec | null = null): Promise<RenderResult> {
  const page = buildPage(view, menu);
  sentLength.clear();
  if (started.has(bridge)) {
    try {
      const ok = await bounded(bridge.rebuildPageContainer(new RebuildPageContainer({ ...page })), PAGE_CALL_MS, "rebuild");
      return ok ? { ok: true } : { ok: false, reason: "rebuild refused" };
    } catch (error) {
      return { ok: false, reason: errorMessage(error) };
    }
  }
  try {
    // The first page needs one rebuild call before the creation (it registers
    // input on real glasses); its result is ignored.
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

export async function updatePage(bridge: EvenAppBridge, view: ClockView): Promise<RenderResult> {
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
    // Unknown what the glasses show now: forget what was sent.
    sentLength.clear();
    return { ok: false, reason: errorMessage(error) };
  }
}

/**
 * Sends the day bar. Separate from the text on purpose: an image is a slow
 * BLE transfer, and the caller runs it on its own lane (see image-sync.ts).
 */
export async function sendDayBar(bridge: EvenAppBridge, bitmap: Bitmap): Promise<RenderResult> {
  try {
    const imageData = await encodeBitmap(bitmap);
    const result = await bounded(bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: DAY_BAR.id, containerName: DAY_BAR.name, imageData })), IMAGE_CALL_MS, "image " + DAY_BAR.name);
    return result === ImageRawDataUpdateResult.success ? { ok: true } : { ok: false, reason: `image:${String(result)}` };
  } catch (error) { return { ok: false, reason: errorMessage(error) }; }
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
