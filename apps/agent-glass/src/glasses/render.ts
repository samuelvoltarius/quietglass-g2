import {
  CreateStartUpPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  RebuildPageContainer,
  StartUpPageCreateResult,
  type EvenAppBridge,
} from "@evenrealities/even_hub_sdk";
import type { AgentView } from "./view";
import { bitmapKey, type Bitmap } from "./gfx";
import { ImageLink, imageContainer, type ImageSlot } from "./images";
import { ICON_HEIGHT, ICON_WIDTH } from "./face";

/**
 * Renders the agent session onto the G2.
 *
 * Layout is fixed at three stacked text containers on the 576 x 288 display.
 * After the page exists, updates go through `textContainerUpgrade`, which
 * changes text without rebuilding the page — on real hardware a rebuild falls
 * back to a full page creation and costs seconds, discarding input meanwhile.
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

/** The face in the top-right corner of the header. */
export const FACE: ImageSlot = {
  id: 4, name: "face", x: SCREEN_WIDTH - ICON_WIDTH, y: 1, width: ICON_WIDTH, height: ICON_HEIGHT, z: 4,
};

const link = new ImageLink();

export function buildPage(view: AgentView): CreateStartUpPageContainer {
  return new CreateStartUpPageContainer({
    containerTotalNum: 4,
    imageObject: [imageContainer(FACE)],
    textObject: [
      // The header leaves the top-right corner to the face.
      text(CONTAINER.header, view.header, 1, false, ICON_WIDTH),
      // Exactly one container may capture input; the body owns it.
      text(CONTAINER.body, view.body.join("\n"), 2, true),
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
 * Creates the page. `rebuildPageContainer` is deliberately called first even
 * though it is reported to always fail on hardware: the call itself registers
 * event routing, and skipping it leaves the app deaf to input.
 */
export async function createPage(bridge: EvenAppBridge, view: AgentView, face: Bitmap): Promise<RenderResult> {
  const page = buildPage(view);
  sentLength.clear();
  link.reset();
  try {
    await bridge.rebuildPageContainer(new RebuildPageContainer({ ...page }));
  } catch {
    // Expected on current firmware; the creation below is the real path.
  }

  try {
    const result = await bridge.createStartUpPageContainer(page);
    if (result === StartUpPageCreateResult.success) return pushFace(bridge, face);
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

/** Counters for tests and diagnostics. */
export const renderStats = { upgrades: 0 };

async function pushFace(bridge: EvenAppBridge, face: Bitmap): Promise<RenderResult> {
  const sent = await link.push(bridge, FACE, face);
  return sent.ok ? { ok: true } : { ok: false, reason: sent.reason ?? "image failed" };
}

/** Content key of a picture, to compare frames without sending them. */
export function faceKey(face: Bitmap): string {
  return bitmapKey(face);
}

/** Only the containers whose text changed are written; the face only when its picture changed. */
export async function updatePage(
  bridge: EvenAppBridge,
  view: AgentView,
  face: Bitmap,
  previous: AgentView | null = null,
): Promise<RenderResult> {
  const updates: Array<[ContainerSpec, string, string | undefined]> = [
    [CONTAINER.header, view.header, previous?.header],
    [CONTAINER.body, view.body.join(NL), previous?.body.join(NL)],
    [CONTAINER.footer, view.footer, previous?.footer],
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
    return await pushFace(bridge, face);
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
