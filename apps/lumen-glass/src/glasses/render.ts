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
import type { LumenView } from "./view";
import { ICON_HEIGHT, ICON_WIDTH, renderPixelIcon, type PixelIcon } from "./pixel";

/**
 * Renders the moth and quest onto the G2.
 *
 * Layout is fixed at three stacked text containers on the 576 x 288 display.
 * After the page exists, updates go through `textContainerUpgrade`, which
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
  body: { id: 2, name: "body", y: 36, height: 214 },
  footer: { id: 3, name: "footer", y: 252, height: 34 },
};

export interface RenderResult {
  readonly ok: boolean;
  /** Present when page creation failed, for the caller to surface or log. */
  readonly reason?: string;
}

export function buildPage(view: LumenView, icon?: PixelIcon): CreateStartUpPageContainer {
  return new CreateStartUpPageContainer({
    containerTotalNum: icon ? 4 : 3,
    textObject: [
      // The header leaves the top-right corner to the moth; the body runs full width below it.
      text(CONTAINER.header, view.header, 1, false, icon ? ICON_WIDTH : 0),
      // Exactly one container may capture input; the body owns it.
      text(CONTAINER.body, view.body.join("\n"), 2, true),
      text(CONTAINER.footer, view.footer, 3, false),
    ],
    imageObject: icon ? [new ImageContainerProperty({ containerID: 4, containerName: "pixel-icon", xPosition: SCREEN_WIDTH - ICON_WIDTH, yPosition: 1, width: ICON_WIDTH, height: ICON_HEIGHT, zOrderIndex: 4 })] : [],
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
 * Puts the page on the glasses: created once per bridge, every later call
 * (reconnect) rebuilds it. The caller resends all images afterwards.
 */
const started = new WeakSet<object>();

export async function createPage(bridge: EvenAppBridge, view: LumenView, icon?: PixelIcon): Promise<RenderResult> {
  const page = buildPage(view, icon);
  sentLength.clear();
  // One creation per bridge, then only rebuilds: a rebuild before the first
  // creation or a second creation leaves the page without its input route.
  if (started.has(bridge)) {
    try {
      const ok = await bridge.rebuildPageContainer(new RebuildPageContainer({ ...page }));
      return ok ? pageWithIcon(bridge, icon) : { ok: false, reason: "rebuild refused" };
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
    if (result === StartUpPageCreateResult.success) { started.add(bridge); return pageWithIcon(bridge, icon); }
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

export async function updatePage(bridge: EvenAppBridge, view: LumenView, icon?: PixelIcon): Promise<RenderResult> {
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
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
  return pageWithIcon(bridge, icon);
}

/** Sends only the corner sprite; used by the animation clock. */
export function updateIcon(bridge: EvenAppBridge, icon: PixelIcon): Promise<RenderResult> {
  return updatePixel(bridge, icon);
}

/**
 * The page stands once it was created or rebuilt; a moth image that did not
 * arrive is retried with the next wing beat, it is no reason to build the
 * whole page again (which costs seconds and swallows taps).
 */
async function pageWithIcon(bridge: EvenAppBridge, icon?: PixelIcon): Promise<RenderResult> {
  const pixel = await updatePixel(bridge, icon);
  if (!pixel.ok) console.warn("[lumen] moth image failed:", pixel.reason);
  return { ok: true };
}

async function updatePixel(bridge: EvenAppBridge, icon?: PixelIcon): Promise<RenderResult> {
  if (!icon) return { ok: true };
  try {
    const imageData = await renderPixelIcon(icon);
    const result = await bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: 4, containerName: "pixel-icon", imageData }));
    return result === ImageRawDataUpdateResult.success ? { ok: true } : { ok: false, reason: `image:${String(result)}` };
  } catch (error) { return { ok: false, reason: errorMessage(error) }; }
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
