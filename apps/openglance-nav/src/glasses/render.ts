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
import type { GlassLayout, NavView } from "./view";
import { renderPixelIcon, type PixelIcon } from "./pixel";

/**
 * Renders the navigation onto the G2.
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

/**
 * Overview layout: the route image (288 x 144, the largest image container
 * the G2 accepts) top centre, a short label left of it, and three rows of
 * turn text plus the footer below. Same container ids and names as the turn
 * layout, so the text fast path works unchanged in both.
 */
const OVERVIEW_MAP = { id: 4, name: "overview-map", x: 144, y: 0, width: 288, height: 144 } as const;
const OVERVIEW_TEXT: Readonly<Record<"header" | "body" | "footer", { x: number; y: number; width: number; height: number }>> = {
  header: { x: 0, y: 0, width: 140, height: 32 },
  body: { x: 0, y: 148, width: SCREEN_WIDTH, height: 102 },
  footer: { x: 0, y: 252, width: SCREEN_WIDTH, height: 34 },
};

export interface RenderResult {
  readonly ok: boolean;
  /** Present when page creation failed, for the caller to surface or log. */
  readonly reason?: string;
}

export function buildPage(view: NavView, icon?: PixelIcon, layout: GlassLayout = "turns"): CreateStartUpPageContainer {
  if (layout === "overview") return buildOverviewPage(view);
  return new CreateStartUpPageContainer({
    containerTotalNum: icon ? 4 : 3,
    textObject: [
      text(CONTAINER.header, view.header, 1, false),
      // Exactly one container may capture input; the body owns it.
      text(CONTAINER.body, view.body.join("\n"), 2, true, Boolean(icon)),
      text(CONTAINER.footer, view.footer, 3, false),
    ],
    imageObject: icon ? [new ImageContainerProperty({ containerID: 4, containerName: "pixel-icon", xPosition: 0, yPosition: 36, width: 96, height: 144, zOrderIndex: 4 })] : [],
  });
}

function buildOverviewPage(view: NavView): CreateStartUpPageContainer {
  const place = (spec: ContainerSpec, box: { x: number; y: number; width: number; height: number }, content: string, z: number, capture: boolean): TextContainerProperty =>
    new TextContainerProperty({
      containerID: spec.id,
      containerName: spec.name,
      xPosition: box.x,
      yPosition: box.y,
      width: box.width,
      height: box.height,
      paddingLength: 4,
      zOrderIndex: z,
      isEventCapture: capture ? 1 : 0,
      content,
    });
  return new CreateStartUpPageContainer({
    containerTotalNum: 4,
    textObject: [
      place(CONTAINER.header, OVERVIEW_TEXT.header, view.header, 1, false),
      place(CONTAINER.body, OVERVIEW_TEXT.body, view.body.join("\n"), 2, true),
      place(CONTAINER.footer, OVERVIEW_TEXT.footer, view.footer, 3, false),
    ],
    imageObject: [new ImageContainerProperty({
      containerID: OVERVIEW_MAP.id, containerName: OVERVIEW_MAP.name,
      xPosition: OVERVIEW_MAP.x, yPosition: OVERVIEW_MAP.y,
      width: OVERVIEW_MAP.width, height: OVERVIEW_MAP.height, zOrderIndex: 4,
    })],
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
export async function createPage(bridge: EvenAppBridge, view: NavView, icon?: PixelIcon): Promise<RenderResult> {
  const page = buildPage(view, icon);
  try {
    await bridge.rebuildPageContainer(new RebuildPageContainer({ ...page }));
  } catch {
    // Expected on current firmware; the creation below is the real path.
  }

  try {
    const result = await bridge.createStartUpPageContainer(page);
    if (result === StartUpPageCreateResult.success) return updatePixel(bridge, icon);
    return { ok: false, reason: describeCreateResult(result) };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

/** Fast path: change the text of the three containers in place. */
export async function updatePage(bridge: EvenAppBridge, view: NavView, icon?: PixelIcon): Promise<RenderResult> {
  const updated = await updateTexts(bridge, view);
  return updated.ok ? updatePixel(bridge, icon) : updated;
}

async function updateTexts(bridge: EvenAppBridge, view: NavView): Promise<RenderResult> {
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

/**
 * Creates the overview page. Switching layout needs a new page — on hardware
 * that takes a moment, which is acceptable for a swipe the user chose.
 */
export async function createOverviewPage(bridge: EvenAppBridge, view: NavView, png: Uint8Array): Promise<RenderResult> {
  const page = buildPage(view, undefined, "overview");
  try {
    await bridge.rebuildPageContainer(new RebuildPageContainer({ ...page }));
  } catch {
    // Expected on current firmware; the creation below is the real path.
  }
  try {
    const result = await bridge.createStartUpPageContainer(page);
    if (result === StartUpPageCreateResult.success) return updateOverviewImage(bridge, png);
    return { ok: false, reason: describeCreateResult(result) };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

/** Text in place; the image only when it changed (`png` null = unchanged). */
export async function updateOverviewPage(bridge: EvenAppBridge, view: NavView, png: Uint8Array | null): Promise<RenderResult> {
  const updated = await updateTexts(bridge, view);
  if (!updated.ok || !png) return updated;
  return updateOverviewImage(bridge, png);
}

async function updateOverviewImage(bridge: EvenAppBridge, png: Uint8Array): Promise<RenderResult> {
  try {
    const result = await bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: OVERVIEW_MAP.id, containerName: OVERVIEW_MAP.name, imageData: png }));
    return result === ImageRawDataUpdateResult.success ? { ok: true } : { ok: false, reason: `image:${String(result)}` };
  } catch (error) { return { ok: false, reason: errorMessage(error) }; }
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
