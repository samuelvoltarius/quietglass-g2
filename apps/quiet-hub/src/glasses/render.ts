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

/** Native contextual menu for the page; the SDK validates count, ids and the 32-byte labels. */
export function buildMenu(menu: MenuSpec | null): MenuContainerProperty | undefined {
  if (menu === null || menu.items.length === 0) return undefined;
  return new MenuContainerProperty({
    menuItems: menu.items.map((item) => new MenuItemProperty({ itemName: item.label, itemID: item.id })),
  });
}

function pageParts(view: ScreenView, menu: MenuSpec | null) {
  const menuObject = buildMenu(menu);
  return {
    containerTotalNum: 4,
    textObject: [
      // The header leaves the top-right corner to the face; the body runs full width below it.
      text(CONTAINER.header, view.header, 1, false, ICON_WIDTH, brightnessOf(view, CONTAINER.header)),
      // Exactly one container may capture input; the body owns it.
      text(CONTAINER.body, view.body.join(NL), 2, true, 0, brightnessOf(view, CONTAINER.body)),
      text(CONTAINER.footer, view.footer, 3, false, 0, brightnessOf(view, CONTAINER.footer)),
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
}

function text(spec: ContainerSpec, content: string, zOrderIndex: number, captureEvents: boolean, rightGap = 0, brightness = MAX_TEXT_BRIGHTNESS): TextContainerProperty {
  return new TextContainerProperty({
    // Omitted = device default 4; only a dimmed container carries the field.
    ...(brightness === MAX_TEXT_BRIGHTNESS ? {} : { textColor: brightness }),
    containerID: spec.id,
    containerName: spec.name,
    xPosition: 0,
    yPosition: spec.y,
    width: SCREEN_WIDTH - rightGap,
    height: spec.height,
    paddingLength: 4,
    zOrderIndex,
    isEventCapture: captureEvents ? 1 : 0,
    content: content || " ",
  });
}

/** Creates the startup page. The caller must invoke this exactly once. */
export async function createPage(bridge: EvenAppBridge, view: ScreenView, icon: PixelIcon, menu: MenuSpec | null = null): Promise<RenderResult> {
  const page = buildPage(view, menu);
  sentLength.clear();
  try {
    // Measured on real glasses (13.10.2026): the first page of a bridge is one
    // rebuild (result ignored) and then exactly one create. The rebuild also
    // revives a page that survived a WebView reload, where a second create fails.
    const rebuilt = await bridge.rebuildPageContainer(new RebuildPageContainer(pageParts(view, menu))).catch(() => false);
    const result = await bridge.createStartUpPageContainer(page);
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
    const ok = await bridge.rebuildPageContainer(new RebuildPageContainer(pageParts(view, menu)));
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

  try {
    for (const [spec, content, before] of updates) {
      const brightness = brightnessOf(view, spec);
      // A forced redraw (no previous view: foreground / reconnect) restates the brightness too.
      const brightnessChanged = previous === null || (sentBrightness.get(spec.id) ?? MAX_TEXT_BRIGHTNESS) !== brightness;
      if (before !== undefined && before === content && !brightnessChanged) continue;
      renderStats.upgrades += 1;
      await bridge.textContainerUpgrade(new TextContainerUpgrade({
        containerID: spec.id,
        containerName: spec.name,
        ...guarded(spec.id, content),
        ...(brightnessChanged ? { textColor: brightness } : {}),
      }));
      if (brightnessChanged) sentBrightness.set(spec.id, brightness);
    }
    if (iconKey(icon) === lastIconKey) return { ok: true };
    return updatePixel(bridge, icon);
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

async function updatePixel(bridge: EvenAppBridge, icon: PixelIcon): Promise<RenderResult> {
  try {
    const imageData = await renderPixelIcon(icon);
    renderStats.images += 1;
    const result = await bridge.updateImageRawData(new ImageRawDataUpdate({
      containerID: 4,
      containerName: "pixel-icon",
      imageData,
    }));
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
