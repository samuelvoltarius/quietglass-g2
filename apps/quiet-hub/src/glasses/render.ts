import {
  CreateStartUpPageContainer,
  ImageContainerProperty,
  ImageRawDataUpdate,
  ImageRawDataUpdateResult,
  MAX_TEXT_BRIGHTNESS,
  MIN_TEXT_BRIGHTNESS,
  MenuContainerProperty,
  MenuItemProperty,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  StartUpPageCreateResult,
  type EvenAppBridge,
} from "@evenrealities/even_hub_sdk";
import type { ScreenView } from "./screen";
import { ICON_HEIGHT, ICON_WIDTH, renderPixelIcon, type PixelIcon } from "./pixel";
import type { MenuSpec } from "../hub/model";

/**
 * Renders a view onto the G2.
 *
 * Layout is fixed at three stacked text containers on the 576 x 288 display.
 * `createStartUpPageContainer` is called exactly once by main. After the page
 * exists, updates go through `textContainerUpgrade`, which
 * changes text without rebuilding the page — on real hardware a rebuild falls
 * back to a full page creation and costs seconds, discarding input meanwhile.
 * Lists are drawn as text with a `>` marker; the page actions live in the native
 * contextual menu (`menuObject`), which is re-supplied on every rebuild.
 */

const NL = String.fromCharCode(10);
export const SCREEN_WIDTH = 576;
export const SCREEN_HEIGHT = 288;

interface ContainerSpec {
  readonly id: number;
  readonly name: string;
  readonly y: number;
  readonly height: number;
}

const CONTAINER: Readonly<Record<"header" | "body" | "footer" | "side", ContainerSpec>> = {
  header: { id: 1, name: "header", y: 0, height: 32 },
  body: { id: 2, name: "body", y: 36, height: 214 },
  footer: { id: 3, name: "footer", y: 252, height: 34 },
  // Split page (Zuhause): the right column next to the list, same height as the body.
  side: { id: 5, name: "side", y: 36, height: 214 },
};

/** Where the right column of a split page starts (list ~30 characters, state ~21). */
export const SPLIT_X = 336;

export interface RenderResult {
  readonly ok: boolean;
  /** Present when page creation failed, for the caller to surface or log. */
  readonly reason?: string;
}

/** Native contextual menu for the page; the SDK validates count, ids and the 32-byte labels. */
export function buildMenu(menu: MenuSpec | null): MenuContainerProperty | undefined {
  if (menu === null || menu.items.length === 0) return undefined;
  return new MenuContainerProperty({
    menuItems: menu.items.map((item) => new MenuItemProperty({ itemName: item.label, itemID: item.id })),
  });
}

function pageParts(view: ScreenView, menu: MenuSpec | null) {
  const menuObject = buildMenu(menu);
  const split = view.side !== undefined;
  return {
    containerTotalNum: split ? 5 : 4,
    textObject: [
      // The header leaves the top-right corner to the face; the body runs full width below it.
      text(CONTAINER.header, view.header, 1, false, ICON_WIDTH, brightnessOf(view, CONTAINER.header)),
      // Exactly one container may capture input; the body owns it (on a split page: the list).
      text(CONTAINER.body, view.body.join(NL), 2, true, split ? SCREEN_WIDTH - SPLIT_X : 0, brightnessOf(view, CONTAINER.body)),
      text(CONTAINER.footer, view.footer, 3, false, 0, brightnessOf(view, CONTAINER.footer)),
      ...(split ? [text(CONTAINER.side, (view.side ?? []).join(NL), 5, false, 0, brightnessOf(view, CONTAINER.side), SPLIT_X)] : []),
    ],
    imageObject: [new ImageContainerProperty({
      containerID: 4,
      containerName: "pixel-icon",
      xPosition: SCREEN_WIDTH - ICON_WIDTH,
      yPosition: 1,
      width: ICON_WIDTH,
      height: ICON_HEIGHT,
      zOrderIndex: 4,
    })],
    ...(menuObject === undefined ? {} : { menuObject }),
  };
}

export function buildPage(view: ScreenView, menu: MenuSpec | null = null): CreateStartUpPageContainer {
  return new CreateStartUpPageContainer(pageParts(view, menu));
}

/**
 * Text brightness per container (SDK 0.0.16: `textColor` 0..4, 4 = default).
 * Normal views use 4; the quiet view keeps header and body at 0 and only the
 * footer's "·" at 1. Changed in place by `textContainerUpgrade`, never by a rebuild.
 */
export function brightnessOf(view: ScreenView, spec: ContainerSpec): number {
  if (view.dim !== true) return MAX_TEXT_BRIGHTNESS;
  return spec.id === CONTAINER.footer.id ? MIN_TEXT_BRIGHTNESS + 1 : MIN_TEXT_BRIGHTNESS;
}

/** Brightness the glasses hold per container; unknown = the default 4 of a fresh page. */
const sentBrightness = new Map<number, number>();

function rememberPageBrightness(view: ScreenView): void {
  sentBrightness.clear();
  for (const spec of Object.values(CONTAINER)) sentBrightness.set(spec.id, brightnessOf(view, spec));
  pageSplit = view.side !== undefined;
}

/** The page on the glasses has the right column (set on every create / rebuild). */
let pageSplit = false;

function text(spec: ContainerSpec, content: string, zOrderIndex: number, captureEvents: boolean, rightGap = 0, brightness = MAX_TEXT_BRIGHTNESS, x = 0): TextContainerProperty {
  return new TextContainerProperty({
    // Omitted = device default 4; only a dimmed container carries the field.
    ...(brightness === MAX_TEXT_BRIGHTNESS ? {} : { textColor: brightness }),
    containerID: spec.id,
    containerName: spec.name,
    xPosition: x,
    yPosition: spec.y,
    width: SCREEN_WIDTH - rightGap - x,
    height: spec.height,
    paddingLength: 4,
    zOrderIndex,
    isEventCapture: captureEvents ? 1 : 0,
    content: content || " ",
  });
}

/**
 * Every call into the glasses is bounded. Draws run one after another, so one
 * answer that never comes (a Bluetooth write lost on the way) used to freeze
 * the display for good on its last page. A call that times out counts as
 * failed: the caller marks the page broken and the next draw rewrites it.
 */
export const PAGE_CALL_MS = 8_000;
export const TEXT_CALL_MS = 5_000;
export const IMAGE_CALL_MS = 10_000;

function bounded<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: no answer from the glasses within ${ms} ms`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Creates the startup page. The caller must invoke this exactly once. */
export async function createPage(bridge: EvenAppBridge, view: ScreenView, icon: PixelIcon, menu: MenuSpec | null = null): Promise<RenderResult> {
  const page = buildPage(view, menu);
  sentLength.clear();
  try {
    // Measured on real glasses (13.10.2026): the first page of a bridge is one
    // rebuild (result ignored) and then exactly one create. The rebuild also
    // revives a page that survived a WebView reload, where a second create fails.
    const rebuilt = await bounded(bridge.rebuildPageContainer(new RebuildPageContainer(pageParts(view, menu))), PAGE_CALL_MS, "rebuild").catch(() => false);
    const result = await bounded(bridge.createStartUpPageContainer(page), PAGE_CALL_MS, "create page");
    if (result === StartUpPageCreateResult.success || rebuilt === true) { renderStats.creates += 1; lastIconKey = ""; rememberPageBrightness(view); return updatePixel(bridge, icon); }
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

/**
 * The menu changed (another page): the only reason for a rebuild. The new
 * `menuObject` is supplied again because a rebuild without it clears the menu.
 * On hardware a rebuild may fail; the text still updates through the fast path.
 */
export async function rebuildPage(bridge: EvenAppBridge, view: ScreenView, icon: PixelIcon, menu: MenuSpec | null): Promise<RenderResult> {
  try {
    renderStats.rebuilds += 1;
    const ok = await bounded(bridge.rebuildPageContainer(new RebuildPageContainer(pageParts(view, menu))), PAGE_CALL_MS, "rebuild");
    // A refused rebuild leaves the old page (and its text lengths) in place.
    if (!ok) return { ok: false, reason: "rebuild refused" };
    lastIconKey = "";
    sentLength.clear();
    rememberPageBrightness(view);
    return updatePixel(bridge, icon);
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

/** Counters for tests and diagnostics: how often the page was built vs. patched. */
export const renderStats = { creates: 0, rebuilds: 0, upgrades: 0, images: 0 };

let lastIconKey = "";
const iconKey = (icon: PixelIcon): string => icon.join("/");

/** Only the containers whose text changed are written; the icon only when it changed. */
export async function updatePage(bridge: EvenAppBridge, view: ScreenView, icon: PixelIcon, previous: ScreenView | null = null): Promise<RenderResult> {
  const updates: Array<[ContainerSpec, string, string | undefined]> = [
    [CONTAINER.header, view.header, previous?.header],
    [CONTAINER.body, view.body.join(NL), previous?.body.join(NL)],
    [CONTAINER.footer, view.footer, previous?.footer],
  ];
  // Only a page built with the right column has it; an empty column is blanked, never left stale.
  if (pageSplit) updates.push([CONTAINER.side, (view.side ?? []).join(NL), previous === null ? undefined : (previous.side ?? []).join(NL)]);

  try {
    for (const [spec, content, before] of updates) {
      const brightness = brightnessOf(view, spec);
      // A forced redraw (no previous view: foreground / reconnect) restates the brightness too.
      const brightnessChanged = previous === null || (sentBrightness.get(spec.id) ?? MAX_TEXT_BRIGHTNESS) !== brightness;
      if (before !== undefined && before === content && !brightnessChanged) continue;
      renderStats.upgrades += 1;
      await bounded(bridge.textContainerUpgrade(new TextContainerUpgrade({
        containerID: spec.id,
        containerName: spec.name,
        ...guarded(spec.id, content),
        ...(brightnessChanged ? { textColor: brightness } : {}),
      })), TEXT_CALL_MS, "text " + spec.name);
      if (brightnessChanged) sentBrightness.set(spec.id, brightness);
    }
    if (iconKey(icon) === lastIconKey) return { ok: true };
    return updatePixel(bridge, icon);
  } catch (error) {
    // Unknown what the glasses show now: write every box and the icon again next time.
    sentLength.clear();
    sentBrightness.clear();
    lastIconKey = "";
    return { ok: false, reason: errorMessage(error) };
  }
}

async function updatePixel(bridge: EvenAppBridge, icon: PixelIcon): Promise<RenderResult> {
  try {
    const imageData = await renderPixelIcon(icon);
    renderStats.images += 1;
    const result = await bounded(bridge.updateImageRawData(new ImageRawDataUpdate({
      containerID: 4,
      containerName: "pixel-icon",
      imageData,
    })), IMAGE_CALL_MS, "image pixel-icon");
    if (result === ImageRawDataUpdateResult.success) lastIconKey = iconKey(icon);
    return result === ImageRawDataUpdateResult.success
      ? { ok: true }
      : { ok: false, reason: `image:${String(result)}` };
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
