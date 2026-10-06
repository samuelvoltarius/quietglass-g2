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
import type { NoiseView } from "./view";
import { DOSE_BAR, METER } from "./gauge";
import type { ImageTarget } from "./lane";

/**
 * Renders the noise readout onto the G2.
 *
 * Layout is fixed on the 576 x 288 display: header, a four-row body beside
 * the level meter, the dose bar below the body, and the footer. The layout
 * never changes, so after the page exists every text update goes through
 * `textContainerUpgrade` — on real hardware a rebuild falls back to a full
 * page creation and costs seconds, discarding input meanwhile.
 *
 * Images are not written here: they travel through the image lane
 * (`lane.ts`) via `sendImage`, so a transfer never holds up the text.
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
  // Four rows; the dose bar sits below them.
  body: { id: 2, name: "body", y: 36, height: 120 },
  footer: { id: 3, name: "footer", y: 252, height: 34 },
};

export interface RenderResult {
  readonly ok: boolean;
  /** Present when page creation failed, for the caller to surface or log. */
  readonly reason?: string;
}

export function buildPage(view: NoiseView): CreateStartUpPageContainer {
  return new CreateStartUpPageContainer({
    containerTotalNum: 5,
    textObject: [
      text(CONTAINER.header, view.header, 1, false),
      // Exactly one container may capture input; the body owns it.
      text(CONTAINER.body, view.body.join("\n"), 2, true, true),
      text(CONTAINER.footer, view.footer, 3, false),
    ],
    imageObject: [METER, DOSE_BAR].map((image, index) => new ImageContainerProperty({
      containerID: image.id, containerName: image.name, xPosition: image.x, yPosition: image.y, width: image.width, height: image.height, zOrderIndex: 4 + index,
    })),
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
    content,
  });
}

/**
 * Creates the page. `rebuildPageContainer` is deliberately called first even
 * though it is reported to always fail on hardware: the call itself registers
 * event routing, and skipping it leaves the app deaf to input.
 */
export async function createPage(bridge: EvenAppBridge, view: NoiseView): Promise<RenderResult> {
  const page = buildPage(view);
  try {
    await bridge.rebuildPageContainer(new RebuildPageContainer({ ...page }));
  } catch {
    // Expected on current firmware; the creation below is the real path.
  }

  try {
    const result = await bridge.createStartUpPageContainer(page);
    if (result === StartUpPageCreateResult.success) return { ok: true };
    return { ok: false, reason: describeCreateResult(result) };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

/** Fast path: change the text of the three containers in place. */
export async function updatePage(bridge: EvenAppBridge, view: NoiseView): Promise<RenderResult> {
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
        content,
      }));
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

/** One image write; the lane decides when. */
export async function sendImage(bridge: EvenAppBridge, target: ImageTarget, imageData: Uint8Array): Promise<boolean> {
  const result = await bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: target.id, containerName: target.name, imageData }));
  return result === ImageRawDataUpdateResult.success;
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
