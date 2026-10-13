import {
  CreateStartUpPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  RebuildPageContainer,
  StartUpPageCreateResult,
  type EvenAppBridge,
} from "@evenrealities/even_hub_sdk";
import type { CadenceView } from "./view";
import type { Bitmap } from "./gfx";
import { ImageLink, imageContainer, type ImageSlot } from "./images";
import { BPM_HEIGHT, BPM_WIDTH, PENDULUM_HEIGHT, PENDULUM_WIDTH } from "./charts";

/**
 * Renders the metronome onto the G2.
 *
 * One layout on the 576 x 288 display: header with the sign in its top-right
 * corner, the big tempo number (image) at the left and the pendulum (image)
 * beside it, the beat dots and info lines below, the footer at the bottom.
 * Text goes through `textContainerUpgrade`, pictures through
 * `updateImageRawData`, both only when something changed.
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

export const ICON_WIDTH = 64;
export const ICON_HEIGHT = 30;

const CONTAINER: Readonly<Record<"header" | "body" | "footer", ContainerSpec>> = {
  header: { id: 1, name: "header", y: 0, height: 32 },
  body: { id: 2, name: "body", y: 138, height: 112 },
  footer: { id: 3, name: "footer", y: 252, height: 34 },
};

export const ICON: ImageSlot = { id: 4, name: "pixel-icon", x: SCREEN_WIDTH - ICON_WIDTH, y: 1, width: ICON_WIDTH, height: ICON_HEIGHT, z: 4 };
export const BPM: ImageSlot = { id: 5, name: "bpm", x: 0, y: 40, width: BPM_WIDTH, height: BPM_HEIGHT, z: 5 };
export const PENDULUM: ImageSlot = { id: 6, name: "pendulum", x: BPM_WIDTH + 24, y: 36, width: PENDULUM_WIDTH, height: PENDULUM_HEIGHT, z: 6 };

export interface Frames {
  readonly icon: Bitmap;
  readonly bpm: Bitmap;
  readonly pendulum: Bitmap;
}

export interface RenderResult {
  readonly ok: boolean;
  /** Present when page creation failed, for the caller to surface or log. */
  readonly reason?: string;
}

const link = new ImageLink();

export function buildPage(view: CadenceView): CreateStartUpPageContainer {
  return new CreateStartUpPageContainer({
    containerTotalNum: 6,
    imageObject: [ICON, BPM, PENDULUM].map(imageContainer),
    textObject: [
      // The header leaves the top-right corner to the sign.
      text(CONTAINER.header, view.header, 1, false, ICON_WIDTH),
      // Exactly one container may capture input; the body owns it.
      text(CONTAINER.body, view.body.join(NL), 2, true),
      text(CONTAINER.footer, view.footer, 3, false),
    ],
  });
}

function text(
  spec: ContainerSpec,
  content: string,
  zOrderIndex: number,
  captureEvents: boolean,
  rightGap = 0,
): TextContainerProperty {
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
 * Puts the page on the glasses. The very first time on a bridge, one
 * `rebuildPageContainer` goes out first (result ignored, failure swallowed: on
 * real glasses it is what registers the input route) and then
 * `createStartUpPageContainer` runs exactly once. A page needed again later is
 * a rebuild; a second creation would be refused as "invalid".
 */
const started = new WeakSet<EvenAppBridge>();

export async function createPage(bridge: EvenAppBridge, view: CadenceView, frames: Frames): Promise<RenderResult> {
  const page = buildPage(view);
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
      if (!ok) return { ok: false, reason: "rebuild refused" };
    }
    return pushImages(bridge, frames);
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

async function pushImages(bridge: EvenAppBridge, frames: Frames): Promise<RenderResult> {
  for (const [slot, frame] of [[ICON, frames.icon], [BPM, frames.bpm], [PENDULUM, frames.pendulum]] as const) {
    const sent = await link.push(bridge, slot, frame);
    if (!sent.ok) return { ok: false, reason: sent.reason ?? "image failed" };
  }
  return { ok: true };
}

/** Only the containers whose text changed are written; pictures only when they changed. */
export async function updatePage(
  bridge: EvenAppBridge,
  view: CadenceView,
  frames: Frames,
  previous: CadenceView | null = null,
): Promise<RenderResult> {
  const updates: Array<[ContainerSpec, string, string | undefined]> = [
    [CONTAINER.header, view.header, previous?.header],
    [CONTAINER.body, view.body.join(NL), previous?.body.join(NL)],
    [CONTAINER.footer, view.footer, previous?.footer],
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
    return await pushImages(bridge, frames);
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
