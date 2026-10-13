import {
  CreateStartUpPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  RebuildPageContainer,
  StartUpPageCreateResult,
  type EvenAppBridge,
} from "@evenrealities/even_hub_sdk";
import type { StatusView } from "./view";
import { createBitmap, type Bitmap } from "./gfx";
import { ImageLink, imageContainer, type ImageSlot } from "./images";
import { ICON_HEIGHT, ICON_WIDTH, SPARK_HEIGHT, SPARK_WIDTH } from "./charts";

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

export type Layout = "graph" | "list";

interface ContainerSpec {
  readonly id: number;
  readonly name: string;
  readonly y: number;
  readonly height: number;
}

const HEADER: ContainerSpec = { id: 1, name: "header", y: 0, height: 32 };
const FOOTER: ContainerSpec = { id: 3, name: "footer", y: 252, height: 34 };
const BODY: Readonly<Record<Layout, ContainerSpec>> = {
  list: { id: 2, name: "body", y: 36, height: 214 },
  graph: { id: 2, name: "body", y: 36, height: 122 },
};

/** Rows the body holds in each layout. */
export const BODY_ROWS: Readonly<Record<Layout, number>> = { list: 7, graph: 4 };

/** The sign in the top-right corner of the header. */
export const SIGN: ImageSlot = {
  id: 4, name: "sign", x: SCREEN_WIDTH - ICON_WIDTH, y: 1, width: ICON_WIDTH, height: ICON_HEIGHT, z: 4,
};

/** Three sparkline slots side by side under the body. */
export const SPARKS: readonly ImageSlot[] = [0, 1, 2].map((i) => ({
  id: 5 + i, name: `spark${i + 1}`, x: i * (SPARK_WIDTH + 6), y: 164, width: SPARK_WIDTH, height: SPARK_HEIGHT, z: 5 + i,
}));

export interface Frames {
  readonly sign: Bitmap;
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
  const images = layout === "graph" ? [SIGN, ...SPARKS] : [SIGN];
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

export function buildPage(view: StatusView, layout: Layout = "list"): CreateStartUpPageContainer {
  return new CreateStartUpPageContainer(pageParts(view, layout));
}

function text(spec: ContainerSpec, content: string, zOrderIndex: number, captureEvents: boolean, rightGap = 0): TextContainerProperty {
  return new TextContainerProperty({
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

/**
 * Creates the page. `rebuildPageContainer` is deliberately called first even
 * though it is reported to always fail on hardware: the call itself registers
 * event routing, and skipping it leaves the app deaf to input.
 */
export async function createPage(bridge: EvenAppBridge, view: StatusView, layout: Layout, frames: Frames): Promise<RenderResult> {
  const page = buildPage(view, layout);
  try {
    await bridge.rebuildPageContainer(new RebuildPageContainer({ ...page }));
  } catch {
    // Expected on current firmware; the creation below is the real path.
  }

  sentLength.clear();
  link.reset();
  try {
    const result = await bridge.createStartUpPageContainer(page);
    if (result === StartUpPageCreateResult.success) return pushImages(bridge, layout, frames);
    return { ok: false, reason: describeCreateResult(result) };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

/** Another layout needs another container set: the one case for a rebuild. */
export async function rebuildPage(bridge: EvenAppBridge, view: StatusView, layout: Layout, frames: Frames): Promise<RenderResult> {
  try {
    const ok = await bridge.rebuildPageContainer(new RebuildPageContainer(pageParts(view, layout)));
    // A refused rebuild leaves the old page (and its text lengths) in place.
    if (!ok) return { ok: false, reason: "rebuild refused" };
    sentLength.clear();
    link.reset();
    return pushImages(bridge, layout, frames);
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

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
  const sign = await link.push(bridge, SIGN, frames.sign);
  if (!sign.ok) return { ok: false, reason: sign.reason ?? "image failed" };
  if (layout !== "graph") return { ok: true };
  for (const [index, slot] of SPARKS.entries()) {
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
  const updates: Array<[ContainerSpec, string, string | undefined]> = [
    [HEADER, view.header, previous?.header],
    [BODY[layout], view.body.join(NL), previous?.body.join(NL)],
    [FOOTER, view.footer, previous?.footer],
  ];

  try {
    for (const [spec, content, before] of updates) {
      if (before !== undefined && before === content) continue;
      renderStats.upgrades += 1;
      await bridge.textContainerUpgrade(new TextContainerUpgrade({
        containerID: spec.id,
        containerName: spec.name,
        ...guarded(spec.id, content),
      }));
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
