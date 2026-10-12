import {
  CreateStartUpPageContainer,
  ImageContainerProperty,
  ImageRawDataUpdate,
  ImageRawDataUpdateResult,
  TextContainerProperty,
  TextContainerUpgrade,
  StartUpPageCreateResult,
  type EvenAppBridge,
} from "@evenrealities/even_hub_sdk";
import type { ScreenView } from "./screen";
import { renderPixelIcon, type PixelIcon } from "./pixel";

/**
 * Renders a view onto the G2.
 *
 * Layout is fixed at three stacked text containers on the 576 x 288 display.
 * `createStartUpPageContainer` is called exactly once by main. After the page
 * exists, updates go through `textContainerUpgrade`, which
 * changes text without rebuilding the page — on real hardware a rebuild falls
 * back to a full page creation and costs seconds, discarding input meanwhile.
 * Menus are therefore drawn as text with a `>` marker, not as list containers.
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

export function buildPage(view: ScreenView): CreateStartUpPageContainer {
  return new CreateStartUpPageContainer({
    containerTotalNum: 4,
    textObject: [
      text(CONTAINER.header, view.header, 1, false),
      // Exactly one container may capture input; the body owns it.
      text(CONTAINER.body, view.body.join("\n"), 2, true, true),
      text(CONTAINER.footer, view.footer, 3, false),
    ],
    imageObject: [new ImageContainerProperty({
      containerID: 4,
      containerName: "pixel-icon",
      xPosition: 0,
      yPosition: 44,
      width: 96,
      height: 144,
      zOrderIndex: 4,
    })],
  });
}

function text(spec: ContainerSpec, content: string, zOrderIndex: number, captureEvents: boolean, compact = false): TextContainerProperty {
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

/** Creates the startup page. The caller must invoke this exactly once. */
export async function createPage(bridge: EvenAppBridge, view: ScreenView, icon: PixelIcon): Promise<RenderResult> {
  const page = buildPage(view);
  try {
    const result = await bridge.createStartUpPageContainer(page);
    if (result === StartUpPageCreateResult.success) return updatePixel(bridge, icon);
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

export async function updatePage(bridge: EvenAppBridge, view: ScreenView, icon: PixelIcon): Promise<RenderResult> {
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
    return updatePixel(bridge, icon);
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

async function updatePixel(bridge: EvenAppBridge, icon: PixelIcon): Promise<RenderResult> {
  try {
    const imageData = await renderPixelIcon(icon);
    const result = await bridge.updateImageRawData(new ImageRawDataUpdate({
      containerID: 4,
      containerName: "pixel-icon",
      imageData,
    }));
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
