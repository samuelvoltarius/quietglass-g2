import {
  CreateStartUpPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  RebuildPageContainer,
  StartUpPageCreateResult,
  type EvenAppBridge,
} from "@evenrealities/even_hub_sdk";
import type { ScreenView } from "./screen";
import { createBitmap, type Bitmap } from "./gfx";
import { ImageLink, imageContainer, type ImageSlot } from "./images";
import { BAR_HEIGHT, BAR_WIDTH, ICON_HEIGHT, ICON_WIDTH } from "./charts";

/**
 * Renders a view onto the G2.
 *
 * Two page layouts on the 576 x 288 display, both with the sign in the
 * top-right corner of the header (the header text ends 64 px before):
 *
 *  - "plain": seven body rows and the footer;
 *  - "schedule": six body rows, and the day bar (a 288 x 20 image) in a strip
 *    above the footer.
 *
 * `createStartUpPageContainer` runs exactly once; a change of layout is a
 * `rebuildPageContainer`. Everything else goes through `textContainerUpgrade`
 * and `updateImageRawData`, and only when something changed.
 */

const NL = String.fromCharCode(10);
export const SCREEN_WIDTH = 576;
export const SCREEN_HEIGHT = 288;

export type Layout = "plain" | "schedule";

interface ContainerSpec {
  readonly id: number;
  readonly name: string;
  readonly y: number;
  readonly height: number;
}

const HEADER: ContainerSpec = { id: 1, name: "header", y: 0, height: 32 };
const FOOTER: ContainerSpec = { id: 3, name: "footer", y: 252, height: 34 };
const BODY: Readonly<Record<Layout, ContainerSpec>> = {
  plain: { id: 2, name: "body", y: 36, height: 214 },
  schedule: { id: 2, name: "body", y: 36, height: 188 },
};

export const SIGN: ImageSlot = {
  id: 4, name: "sign", x: SCREEN_WIDTH - ICON_WIDTH, y: 1, width: ICON_WIDTH, height: ICON_HEIGHT, z: 4,
};
/** Centred above the footer. */
export const BAR: ImageSlot = {
  id: 5, name: "daybar", x: (SCREEN_WIDTH - BAR_WIDTH) / 2, y: 228, width: BAR_WIDTH, height: BAR_HEIGHT, z: 5,
};

export interface Frames {
  readonly sign: Bitmap;
  /** Schedule layout only; null leaves the strip empty (no times in the schedule). */
  readonly bar: Bitmap | null;
}

export interface RenderResult {
  readonly ok: boolean;
  /** Present when page creation failed, for the caller to surface or log. */
  readonly reason?: string;
}

const link = new ImageLink();

function pageParts(view: ScreenView, layout: Layout) {
  const images = layout === "schedule" ? [SIGN, BAR] : [SIGN];
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

export function buildPage(view: ScreenView, layout: Layout = "plain"): CreateStartUpPageContainer {
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
 * Puts a page on the glasses. The very first time on a bridge, one
 * `rebuildPageContainer` goes out first (result ignored, failure swallowed: on
 * real glasses it is what registers the input route) and then
 * `createStartUpPageContainer` runs exactly once. Every later page - also
 * another layout - replaces it with `rebuildPageContainer`; a second creation
 * would be refused as "invalid".
 */
const started = new WeakSet<EvenAppBridge>();

async function installPage(bridge: EvenAppBridge, view: ScreenView, layout: Layout, frames: Frames): Promise<RenderResult> {
  const page = buildPage(view, layout);
  sentLength.clear();
  link.reset();
  try {
    if (!started.has(bridge)) {
      try {
        await bridge.rebuildPageContainer(new RebuildPageContainer({ ...page }));
      } catch {
        // Expected on current firmware; the creation below is the real path.
      }
      const result = await bridge.createStartUpPageContainer(page);
      if (result !== StartUpPageCreateResult.success) return { ok: false, reason: describeCreateResult(result) };
      started.add(bridge);
    } else {
      const ok = await bridge.rebuildPageContainer(new RebuildPageContainer({ ...page }));
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

async function pushImages(bridge: EvenAppBridge, layout: Layout, frames: Frames): Promise<RenderResult> {
  const sign = await link.push(bridge, SIGN, frames.sign);
  if (!sign.ok) return { ok: false, reason: sign.reason ?? "image failed" };
  if (layout !== "schedule") return { ok: true };
  if (frames.bar === null && !link.has(BAR.id)) return { ok: true };
  const bar = await link.push(bridge, BAR, frames.bar ?? createBitmap(BAR.width, BAR.height));
  return bar.ok ? { ok: true } : { ok: false, reason: bar.reason ?? "image failed" };
}

/** Only the containers whose text changed are written; pictures only when they changed. */
export async function updatePage(
  bridge: EvenAppBridge,
  view: ScreenView,
  layout: Layout,
  frames: Frames,
  previous: ScreenView | null = null,
): Promise<RenderResult> {
  const updates: Array<[ContainerSpec, string, string | undefined]> = [
    [HEADER, view.header, previous?.header],
    [BODY[layout], view.body.join(NL), previous?.body.join(NL)],
    [FOOTER, view.footer, previous?.footer],
  ];

  try {
    for (const [spec, content, before] of updates) {
      if (before !== undefined && before === content) continue;
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
