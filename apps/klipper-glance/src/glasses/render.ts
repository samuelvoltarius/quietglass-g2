import {
  CreateStartUpPageContainer,
  MenuContainerProperty,
  MenuItemProperty,
  TextContainerProperty,
  TextContainerUpgrade,
  RebuildPageContainer,
  StartUpPageCreateResult,
  type EvenAppBridge,
} from "@evenrealities/even_hub_sdk";
import type { ScreenView } from "./screen";
import type { Layout, PrintView } from "./views";
import type { Bitmap } from "./gfx";
import { ImageLink, imageContainer, bounded, PAGE_CALL_MS, TEXT_CALL_MS, type ImageSlot } from "./images";
import { CURVE_HEIGHT, CURVE_WIDTH, RING_SIZE } from "./charts";
import { VIEW_HEIGHT, VIEW_WIDTH } from "./layers";

/**
 * Renders a view onto the G2.
 *
 * Two page layouts on the 576 x 288 display:
 *
 *  - "print": header on top, a 144 x 144 progress ring at the left, the print
 *    text beside it, the 288 x 64 nozzle curve below the ring with the two
 *    temperature lines next to it, footer at the bottom;
 *  - "plain": header, seven body rows, footer — everything that is not a print
 *    in progress, and the control screen;
 *  - "model": header, the 576 x 216 layer view as four 288 x 108 image tiles,
 *    footer (the header captures input here).
 *
 * `createStartUpPageContainer` runs exactly once. A change of layout is the
 * only reason to `rebuildPageContainer`; everything else goes through
 * `textContainerUpgrade` and `updateImageRawData`, and only when something
 * changed — on real hardware a rebuild costs seconds and discards input.
 */

const NL = String.fromCharCode(10);
export const SCREEN_WIDTH = 576;
export const SCREEN_HEIGHT = 288;

interface TextSpec {
  readonly id: number;
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const HEADER: TextSpec = { id: 1, name: "header", x: 0, y: 0, width: SCREEN_WIDTH, height: 32 };
const FOOTER: TextSpec = { id: 3, name: "footer", x: 0, y: 252, width: SCREEN_WIDTH, height: 34 };
const BODY: Readonly<Record<Exclude<Layout, "model">, TextSpec>> = {
  plain: { id: 2, name: "body", x: 0, y: 36, width: SCREEN_WIDTH, height: 214 },
  print: { id: 2, name: "body", x: RING_SIZE + 8, y: 36, width: SCREEN_WIDTH - RING_SIZE - 8, height: RING_SIZE + 2 },
};
/** Model layout: header and footer only, the picture in between. */
const MODEL_HEADER: TextSpec = { id: 1, name: "header", x: 0, y: 0, width: SCREEN_WIDTH, height: 32 };
const MODEL_TOP = 34;
export const MODEL_TILES: readonly ImageSlot[] = [0, 1, 2, 3].map((i) => ({
  id: 10 + i,
  name: "tile" + i,
  x: (i % 2) * (VIEW_WIDTH / 2),
  y: MODEL_TOP + Math.floor(i / 2) * (VIEW_HEIGHT / 2),
  width: VIEW_WIDTH / 2,
  height: VIEW_HEIGHT / 2,
  z: 10 + i,
}));

const TEMPS: TextSpec = { id: 6, name: "temps", x: CURVE_WIDTH + 8, y: 186, width: SCREEN_WIDTH - CURVE_WIDTH - 8, height: CURVE_HEIGHT };

export const RING: ImageSlot = { id: 4, name: "ring", x: 0, y: 36, width: RING_SIZE, height: RING_SIZE, z: 4 };
export const CURVE: ImageSlot = { id: 5, name: "curve", x: 0, y: 186, width: CURVE_WIDTH, height: CURVE_HEIGHT, z: 5 };

export interface Frames {
  readonly ring: Bitmap;
  readonly curve: Bitmap;
  /** The four layer-view tiles (model layout only). */
  readonly tiles?: readonly Bitmap[] | undefined;
}

export interface RenderResult {
  readonly ok: boolean;
  /** Present when page creation failed, for the caller to surface or log. */
  readonly reason?: string;
}

const link = new ImageLink();

/** QIS v1.2: one item of the glasses' side menu (id > 0, label at most 32 bytes). */
export interface MenuItemSpec { readonly id: number; readonly label: string }
export interface MenuSpec { readonly items: readonly MenuItemSpec[] }

/** The side menu as the SDK wants it (`menuObject` of the page), as in Quiet Hub. */
export function buildMenu(menu: MenuSpec | null): MenuContainerProperty | undefined {
  if (menu === null || menu.items.length === 0) return undefined;
  return new MenuContainerProperty({
    menuItems: menu.items.map((item) => new MenuItemProperty({ itemName: item.label, itemID: item.id })),
  });
}

function pageParts(view: ScreenView | PrintView, layout: Layout, menu: MenuSpec | null) {
  const menuObject = buildMenu(menu);
  const withMenu = <T extends object>(parts: T): T & { menuObject?: MenuContainerProperty } =>
    menuObject === undefined ? parts : { ...parts, menuObject };
  if (layout === "model") {
    const texts = [text(MODEL_HEADER, view.header, 1, true), text(FOOTER, view.footer, 3, false)];
    return withMenu({ containerTotalNum: texts.length + MODEL_TILES.length, textObject: texts, imageObject: MODEL_TILES.map(imageContainer) });
  }
  const print = layout === "print";
  const temps = print && "temps" in view ? view.temps.join(NL) : "";
  const texts = [
    text(HEADER, view.header, 1, false),
    // Exactly one container may capture input; the body owns it.
    text(BODY[layout], view.body.join(NL), 2, true),
    text(FOOTER, view.footer, 3, false),
    ...(print ? [text(TEMPS, temps, 6, false)] : []),
  ];
  return withMenu({
    containerTotalNum: texts.length + (print ? 2 : 0),
    textObject: texts,
    ...(print ? { imageObject: [imageContainer(RING), imageContainer(CURVE)] } : {}),
  });
}

export function buildPage(view: ScreenView | PrintView, layout: Layout = "plain", menu: MenuSpec | null = null): CreateStartUpPageContainer {
  return new CreateStartUpPageContainer(pageParts(view, layout, menu));
}

function text(spec: TextSpec, content: string, zOrderIndex: number, captureEvents: boolean): TextContainerProperty {
  return new TextContainerProperty({
    containerID: spec.id,
    containerName: spec.name,
    xPosition: spec.x,
    yPosition: spec.y,
    width: spec.width,
    height: spec.height,
    paddingLength: 4,
    zOrderIndex,
    isEventCapture: captureEvents ? 1 : 0,
    content: content || " ",
  });
}

/**
 * Puts a page on the glasses. The very first time on a bridge, one
 * `rebuildPageContainer` goes out first (result ignored, failure swallowed: on
 * real glasses it is what registers the input route) and then
 * `createStartUpPageContainer` runs exactly once. Every later page - also
 * another layout - replaces it with `rebuildPageContainer`; a second creation
 * would be refused as "invalid".
 */
const started = new WeakSet<EvenAppBridge>();

async function installPage(bridge: EvenAppBridge, view: ScreenView | PrintView, layout: Layout, frames: Frames, menu: MenuSpec | null = null): Promise<RenderResult> {
  // A rebuild without the menu would clear it, so every page carries it again.
  const page = buildPage(view, layout, menu);
  sentLength.clear();
  link.reset();
  try {
    if (!started.has(bridge)) {
      try {
        await bounded(bridge.rebuildPageContainer(new RebuildPageContainer({ ...page })), PAGE_CALL_MS, "rebuild");
      } catch {
        // Expected on current firmware; the creation below is the real path.
      }
      const result = await bounded(bridge.createStartUpPageContainer(page), PAGE_CALL_MS, "create page");
      if (result !== StartUpPageCreateResult.success) return { ok: false, reason: describeCreateResult(result) };
      started.add(bridge);
    } else {
      const ok = await bounded(bridge.rebuildPageContainer(new RebuildPageContainer({ ...page })), PAGE_CALL_MS, "rebuild");
      // A refused rebuild leaves the old page in place.
      if (!ok) return { ok: false, reason: "rebuild refused" };
    }
    return pushImages(bridge, layout, frames);
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

export const createPage = installPage;
export const rebuildPage = installPage;

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

/** Counters for tests and diagnostics. */
export const renderStats = { upgrades: 0 };

/** Sends the ring and the curve when they changed (the plain layout has neither). */
async function pushImages(bridge: EvenAppBridge, layout: Layout, frames: Frames): Promise<RenderResult> {
  if (layout === "model") {
    for (const [index, slot] of MODEL_TILES.entries()) {
      const tile = frames.tiles?.[index];
      if (!tile) continue;
      const sent = await link.push(bridge, slot, tile);
      if (!sent.ok) return { ok: false, reason: sent.reason ?? "image failed" };
    }
    return { ok: true };
  }
  if (layout !== "print") return { ok: true };
  for (const [slot, frame] of [[RING, frames.ring], [CURVE, frames.curve]] as const) {
    const sent = await link.push(bridge, slot, frame);
    if (!sent.ok) return { ok: false, reason: sent.reason ?? "image failed" };
  }
  return { ok: true };
}

/** Only the containers whose text changed are written; pictures only when they changed. */
export async function updatePage(
  bridge: EvenAppBridge,
  view: ScreenView | PrintView,
  layout: Layout,
  frames: Frames,
  previous: ScreenView | PrintView | null = null,
): Promise<RenderResult> {
  const temps = (v: ScreenView | PrintView | null): string | undefined => (v === null ? undefined : "temps" in v ? v.temps.join(NL) : "");
  const updates: Array<[TextSpec, string, string | undefined]> = layout === "model" ? [
    [MODEL_HEADER, view.header, previous?.header],
    [FOOTER, view.footer, previous?.footer],
  ] : [
    [HEADER, view.header, previous?.header],
    [BODY[layout], view.body.join(NL), previous?.body.join(NL)],
    [FOOTER, view.footer, previous?.footer],
    ...(layout === "print" ? [[TEMPS, temps(view) ?? "", temps(previous)] as [TextSpec, string, string | undefined]] : []),
  ];

  try {
    for (const [spec, content, before] of updates) {
      if (before !== undefined && before === content) continue;
      renderStats.upgrades += 1;
      await bounded(bridge.textContainerUpgrade(new TextContainerUpgrade({
        containerID: spec.id,
        containerName: spec.name,
        ...guarded(spec.id, content),
      })), TEXT_CALL_MS, "text " + spec.name);
    }
    return await pushImages(bridge, layout, frames);
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
