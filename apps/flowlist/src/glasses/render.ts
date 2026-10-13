import {
  CreateStartUpPageContainer,
  ImageContainerProperty,
  ImageRawDataUpdate,
  ImageRawDataUpdateResult,
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

export function buildPage(view: FlowView): CreateStartUpPageContainer {
  return new CreateStartUpPageContainer({
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
 * Puts the page on the glasses: created once per bridge, every later call
 * (reconnect) rebuilds it. The caller resends all images afterwards.
 */
const started = new WeakSet<object>();

export async function createPage(bridge: EvenAppBridge, view: FlowView): Promise<RenderResult> {
  const page = buildPage(view);
  sentLength.clear();
  // One creation per bridge, then only rebuilds: a rebuild before the first
  // creation or a second creation leaves the page without its input route.
  if (started.has(bridge)) {
    try {
      const ok = await bridge.rebuildPageContainer(new RebuildPageContainer({ ...page }));
      return ok ? { ok: true } : { ok: false, reason: "rebuild refused" };
    } catch (error) {
      return { ok: false, reason: errorMessage(error) };
    }
  }
  try {
    // Measured on real glasses: the first page needs one rebuild call before the creation
    // (it registers input); the result is ignored.
    await bridge.rebuildPageContainer(new RebuildPageContainer({ ...page }));
  } catch {
    // Expected to fail before the first page.
  }
  try {
    const result = await bridge.createStartUpPageContainer(page);
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

export async function updatePage(bridge: EvenAppBridge, view: FlowView): Promise<RenderResult> {
  const updates: Array<[ContainerSpec, string]> = [
    [CONTAINER.header, view.header],
    [CONTAINER.body, view.body.join("\n")],
    [CONTAINER.footer, view.footer],
  ];

  try {
    for (const [spec, content] of updates) {
      await bridge.textContainerUpgrade(new TextContainerUpgrade({
        containerID: spec.id,
        containerName: spec.name,
        ...guarded(spec.id, content),
      }));
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
    const result = await bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: PROGRESS_BAR.id, containerName: PROGRESS_BAR.name, imageData }));
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
      const result = await bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: half.id, containerName: half.name, imageData }));
      if (result !== ImageRawDataUpdateResult.success) return { ok: false, reason: `image:${String(result)}` };
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
