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
import type { StatusView } from "./view";
import { SIDE_MENU } from "./actions-view";
import { createBitmap, type Bitmap } from "./gfx";
import { ImageLink, imageContainer, bounded, PAGE_CALL_MS, TEXT_CALL_MS, IMAGE_CALL_MS, type ImageSlot } from "./images";

export { PAGE_CALL_MS, TEXT_CALL_MS, IMAGE_CALL_MS, bounded };
import { ICON_HEIGHT, ICON_WIDTH, SPARK_HEIGHT, SPARK_WIDTH } from "./charts";
import { FLEET_ROWS, ROW_HEIGHT, ROW_WIDTH } from "./fleet";

/**
 * Renders the status dashboard onto the G2.
 *
 * Two page layouts on the 576 x 288 display, both with the status sign in the
 * top-right corner of the header:
 *
 *  - "graph": a four-row body and, below it, up to three sparkline images
 *    (CPU, GPU, RAM of the source in focus);
 *  - "list": the plain seven-row body, for sources without load metrics and
 *    for the actions screen.
 *
 * `createStartUpPageContainer` runs exactly once. A change of layout is the
 * only reason to `rebuildPageContainer`; everything else goes through
 * `textContainerUpgrade` and `updateImageRawData`, and only when something
 * changed — on real hardware a rebuild costs seconds and discards input.
 */

const NL = String.fromCharCode(10);
export const SCREEN_WIDTH = 576;
export const SCREEN_HEIGHT = 288;

export type Layout = "graph" | "list" | "fleet" | "detail";

interface ContainerSpec {
  readonly id: number;
  readonly name: string;
  readonly y: number;
  readonly height: number;
}

const HEADER: ContainerSpec = { id: 1, name: "header", y: 0, height: 32 };
const FOOTER: ContainerSpec = { id: 3, name: "footer", y: 252, height: 34 };
const BODY: Readonly<Record<"graph" | "list" | "detail", ContainerSpec>> = {
  list: { id: 2, name: "body", y: 36, height: 214 },
  graph: { id: 2, name: "body", y: 36, height: 122 },
  detail: { id: 2, name: "body", y: 34, height: 162 },
};

/** Rows the body holds in each layout (the fleet layout has one text per machine instead). */
export const BODY_ROWS: Readonly<Record<Layout, number>> = { list: 7, graph: 4, fleet: FLEET_ROWS, detail: 5 };

/**
 * The fleet layout: one row per machine, a 288 x 54 picture (light, name,
 * load line) with its own text beside it. Four pictures and no sign: the
 * lights say what the sign would.
 */
const ROW_TOP = 34;
export const FLEET_IMAGES: readonly ImageSlot[] = Array.from({ length: FLEET_ROWS }, (_, i) => ({
  id: 4 + i, name: `machine${i + 1}`, x: 0, y: ROW_TOP + i * ROW_HEIGHT, width: ROW_WIDTH, height: ROW_HEIGHT, z: 3 + FLEET_ROWS + i,
}));
const FLEET_TEXTS: readonly ContainerSpec[] = Array.from({ length: FLEET_ROWS }, (_, i) => ({
  id: 10 + i, name: `row${i + 1}`, y: ROW_TOP + i * ROW_HEIGHT, height: ROW_HEIGHT,
}));
const FLEET_TEXT_X = ROW_WIDTH + 4;

/** The sign in the top-right corner of the header. */
export const SIGN: ImageSlot = {
  id: 4, name: "sign", x: SCREEN_WIDTH - ICON_WIDTH, y: 1, width: ICON_WIDTH, height: ICON_HEIGHT, z: 4,
};

/** Three sparkline slots side by side under the body. */
export const SPARKS: readonly ImageSlot[] = [0, 1, 2].map((i) => ({
  id: 5 + i, name: `spark${i + 1}`, x: i * (SPARK_WIDTH + 6), y: 164, width: SPARK_WIDTH, height: SPARK_HEIGHT, z: 5 + i,
}));

/** The detail page of one machine: lower sparklines, so the values get five rows. */
export const DETAIL_SPARK_HEIGHT = 50;
export const DETAIL_SPARKS: readonly ImageSlot[] = [0, 1, 2].map((i) => ({
  id: 5 + i, name: `spark${i + 1}`, x: i * (SPARK_WIDTH + 6), y: 200, width: SPARK_WIDTH, height: DETAIL_SPARK_HEIGHT, z: 5 + i,
}));

const sparkSlots = (layout: Layout): readonly ImageSlot[] => (layout === "detail" ? DETAIL_SPARKS : layout === "graph" ? SPARKS : []);

export interface Frames {
  readonly sign: Bitmap;
  /** Fleet layout only: one picture per machine row. */
  readonly rows?: readonly Bitmap[];
  /** One entry per slot; null leaves the slot empty. Ignored in the list layout. */
  readonly sparks: readonly (Bitmap | null)[];
}

export interface RenderResult {
  readonly ok: boolean;
  /** Present when page creation failed, for the caller to surface or log. */
  readonly reason?: string;
}

const link = new ImageLink();

function pageParts(view: StatusView, layout: Layout) {
  if (layout === "fleet") {
    return {
      containerTotalNum: 2 + FLEET_ROWS * 2,
      imageObject: FLEET_IMAGES.map(imageContainer),
      textObject: [
        text(HEADER, view.header, 1, false),
        // The first row owns the input; any gesture reaches it wherever the eye is.
        ...FLEET_TEXTS.map((spec, i) => text(spec, view.body[i] ?? "", 2 + i, i === 0, 0, FLEET_TEXT_X)),
        text(FOOTER, view.footer, 2 + FLEET_ROWS, false),
      ],
    };
  }
  const images = [SIGN, ...sparkSlots(layout)];
  return {
    containerTotalNum: 3 + images.length,
    imageObject: images.map(imageContainer),
    textObject: [
      // The header leaves the top-right corner to the sign.
      text(HEADER, view.header, 1, false, ICON_WIDTH),
      // Exactly one container may capture input; the body owns it.
      text(BODY[layout], view.body.join(NL), 2, true),
      text(FOOTER, view.footer, 3, false),
    ],
  };
}

/** One item of the glasses' side menu (id > 0, label at most 32 bytes). QIS v1.2. */
export interface MenuItemSpec { readonly id: number; readonly label: string }
export interface MenuSpec {
  /** Changes exactly when the glasses need a different menu (=> one rebuild). */
  readonly key: string;
  readonly items: readonly MenuItemSpec[];
}

/** The side menu as the SDK wants it (`menuObject` of the page), as in Babel Glass. */
export function buildMenu(menu: MenuSpec | null): MenuContainerProperty | undefined {
  if (!SIDE_MENU || menu === null || menu.items.length === 0) return undefined;
  return new MenuContainerProperty({
    menuItems: menu.items.map((item) => new MenuItemProperty({ itemName: item.label, itemID: item.id })),
  });
}

export function buildPage(view: StatusView, layout: Layout = "list", menu: MenuSpec | null = null): CreateStartUpPageContainer {
  const menuObject = buildMenu(menu);
  return new CreateStartUpPageContainer({ ...pageParts(view, layout), ...(menuObject === undefined ? {} : { menuObject }) });
}

function text(spec: ContainerSpec, content: string, zOrderIndex: number, captureEvents: boolean, rightGap = 0, x = 0): TextContainerProperty {
  return new TextContainerProperty({
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
 * Puts a page on the glasses. The very first time on a bridge, one
 * `rebuildPageContainer` goes out first (result ignored, failure swallowed: on
 * real glasses it is what registers the input route) and then
 * `createStartUpPageContainer` runs exactly once. Every later page - also
 * another layout - replaces it with `rebuildPageContainer`; a second creation
 * would be refused as "invalid".
 */
const started = new WeakSet<EvenAppBridge>();

async function installPage(bridge: EvenAppBridge, view: StatusView, layout: Layout, frames: Frames, menu: MenuSpec | null = null): Promise<RenderResult> {
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

/** Sends the sign and the sparklines that changed; a slot that lost its series is blanked once. */
async function pushImages(bridge: EvenAppBridge, layout: Layout, frames: Frames): Promise<RenderResult> {
  if (layout === "fleet") {
    for (const [index, slot] of FLEET_IMAGES.entries()) {
      const frame = frames.rows?.[index] ?? null;
      if (frame === null && !link.has(slot.id)) continue;
      const sent = await link.push(bridge, slot, frame ?? createBitmap(slot.width, slot.height));
      if (!sent.ok) return { ok: false, reason: sent.reason ?? "image failed" };
    }
    return { ok: true };
  }
  const sign = await link.push(bridge, SIGN, frames.sign);
  if (!sign.ok) return { ok: false, reason: sign.reason ?? "image failed" };
  for (const [index, slot] of sparkSlots(layout).entries()) {
    const frame = frames.sparks[index] ?? null;
    if (frame === null && !link.has(slot.id)) continue;
    const sent = await link.push(bridge, slot, frame ?? createBitmap(slot.width, slot.height));
    if (!sent.ok) return { ok: false, reason: sent.reason ?? "image failed" };
  }
  return { ok: true };
}

/** Only the containers whose text changed are written; pictures only when they changed. */
export async function updatePage(
  bridge: EvenAppBridge,
  view: StatusView,
  layout: Layout,
  frames: Frames,
  previous: StatusView | null = null,
): Promise<RenderResult> {
  const updates: Array<[ContainerSpec, string, string | undefined]> = layout === "fleet"
    ? [
        [HEADER, view.header, previous?.header],
        ...FLEET_TEXTS.map((spec, i): [ContainerSpec, string, string | undefined] => [spec, view.body[i] ?? "", previous ? previous.body[i] ?? "" : undefined]),
        [FOOTER, view.footer, previous?.footer],
      ]
    : [
        [HEADER, view.header, previous?.header],
        [BODY[layout], view.body.join(NL), previous?.body.join(NL)],
        [FOOTER, view.footer, previous?.footer],
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
