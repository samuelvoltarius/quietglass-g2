import {
  CreateStartUpPageContainer,
  ImageContainerProperty,
  ImageRawDataUpdate,
  ImageRawDataUpdateResult,
  TextContainerProperty,
  TextContainerUpgrade,
  RebuildPageContainer,
  MenuContainerProperty,
  MenuItemProperty,
  StartUpPageCreateResult,
  type EvenAppBridge,
} from "@evenrealities/even_hub_sdk";
import type { MenuSpec } from "../route/menu";
import type { Scene } from "../route/scene";
import {
  BODY_BOX, BODY_ID, FOOTER_BOX, FOOTER_ID, HEADER_BOX, HEADER_ID, IMAGES, SCREEN_HEIGHT, SCREEN_WIDTH,
  type Box, type ImageSpec, type PageKind,
} from "./layout";

/**
 * Renders the departure board, the ride and the guide onto the G2.
 *
 * Four page kinds exist (see layout.ts); the text page has three stacked text
 * containers, the picture pages swap the header for up to four images. After
 * a page exists, updates go through `textContainerUpgrade` and
 * `updateImageRawData`, which change text and pictures without rebuilding the
 * page - on real hardware a rebuild costs seconds and discards input meanwhile.
 * Only a change of the page kind or of the menu rebuilds.
 */

export { SCREEN_HEIGHT, SCREEN_WIDTH };
export type { PageKind };

export interface RenderResult {
  readonly ok: boolean;
  /** Present when page creation failed, for the caller to surface or log. */
  readonly reason?: string;
  /** The page is there, but a picture did not go through; it is sent again with the next draw. */
  readonly partial?: boolean;
}

/** Native contextual menu of the page; the SDK checks count, ids and the 32-byte labels. */
export function buildMenu(menu: MenuSpec | null): MenuContainerProperty | undefined {
  if (menu === null || menu.items.length === 0) return undefined;
  return new MenuContainerProperty({
    menuItems: menu.items.map((item) => new MenuItemProperty({ itemName: item.label, itemID: item.id })),
  });
}

function text(id: number, name: string, box: Box, content: string, z: number, capture: boolean): TextContainerProperty {
  return new TextContainerProperty({
    containerID: id,
    containerName: name,
    xPosition: box.x,
    yPosition: box.y,
    width: box.width,
    height: box.height,
    paddingLength: 4,
    zOrderIndex: z,
    isEventCapture: capture ? 1 : 0,
    content: content || " ",
  });
}

function image(spec: ImageSpec, z: number): ImageContainerProperty {
  return new ImageContainerProperty({
    containerID: spec.id, containerName: spec.name,
    xPosition: spec.x, yPosition: spec.y, width: spec.width, height: spec.height, zOrderIndex: z,
  });
}

function pageParts(scene: Scene, menu: MenuSpec | null) {
  const menuObject = buildMenu(menu);
  const { view, kind } = scene;
  const images = IMAGES[kind];
  // Images sit below the text (lower z), so the text may overlay them; every z is used once.
  let z = images.length;
  const textObject = [
    ...(kind === "text" ? [text(HEADER_ID, "header", HEADER_BOX, view.header, ++z, false)] : []),
    // Exactly one container may capture input; the body owns it.
    text(BODY_ID, "body", BODY_BOX[kind], view.body.join("\n"), ++z, true),
    text(FOOTER_ID, "footer", FOOTER_BOX, view.footer, ++z, false),
  ];
  return {
    containerTotalNum: textObject.length + images.length,
    textObject,
    ...(images.length > 0 ? { imageObject: images.map((spec, index) => image(spec, index + 1)) } : {}),
    ...(menuObject === undefined ? {} : { menuObject }),
  };
}

export function buildPage(scene: Scene, menu: MenuSpec | null = null): CreateStartUpPageContainer {
  return new CreateStartUpPageContainer(pageParts(scene, menu));
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
  const shown = (content || " ").slice(0, TEXT_HARD_CAP);
  const length = Math.max(sentLength.get(specId) ?? 0, shown.length);
  sentLength.set(specId, shown.length);
  return { content: shown, contentLength: length };
}

/** What each image container shows on the glasses, by container id: pictures are sent only when this changes. */
const shown = new Map<number, string>();

/** Bridges that already have their startup page: every later page is a rebuild. */
const started = new WeakSet<object>();

/**
 * Every call into the glasses is bounded. Draws run one after another, so a
 * single answer that never comes (a Bluetooth write lost on the way) used to
 * freeze the display for good on whatever it showed last. A call that times
 * out counts as failed: the caller marks the page broken and the next draw
 * rebuilds it.
 */
export const PAGE_CALL_MS = 8_000;
export const TEXT_CALL_MS = 5_000;
export const IMAGE_CALL_MS = 10_000;

function bounded<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: no answer from the glasses within ${ms} ms`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Puts a page on the glasses: created exactly once per bridge, every later
 * page a `rebuildPageContainer` - the order Quiet Hub uses and that takes
 * input on real glasses. A rebuild before the first creation, or a second
 * creation, left OpenGlance Nav 0.5.1 deaf to taps and unable to exit.
 */
async function installPage(bridge: EvenAppBridge, page: CreateStartUpPageContainer): Promise<RenderResult> {
  sentLength.clear();
  shown.clear();
  if (!started.has(bridge)) {
    // Measured on real glasses: the very first page needs a rebuild call before
    // the creation, or taps are never delivered (Babel 0.2.5).
    try { await bounded(bridge.rebuildPageContainer(new RebuildPageContainer({ ...page })), PAGE_CALL_MS, "rebuild"); } catch { /* expected before the first page */ }
    try {
      const result = await bounded(bridge.createStartUpPageContainer(page), PAGE_CALL_MS, "create page");
      if (result === StartUpPageCreateResult.success) { started.add(bridge); return { ok: true }; }
      return { ok: false, reason: describeCreateResult(result) };
    } catch (error) {
      return { ok: false, reason: errorMessage(error) };
    }
  }
  try {
    const ok = await bounded(bridge.rebuildPageContainer(new RebuildPageContainer({ ...page })), PAGE_CALL_MS, "rebuild");
    return ok ? { ok: true } : { ok: false, reason: "rebuild refused" };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

/** Creates the page (or replaces it after a lost connection) and sends all of its pictures. */
export async function createPage(bridge: EvenAppBridge, scene: Scene, menu: MenuSpec | null = null): Promise<RenderResult> {
  const installed = await installPage(bridge, buildPage(scene, menu));
  return installed.ok ? updateImages(bridge, scene) : installed;
}

/**
 * Another page kind or another menu means a rebuild: the one reason to pay
 * for it. `menuObject` is supplied again because a rebuild without it would
 * clear the menu. A refused rebuild leaves the old page in place; the caller
 * then falls back to the fast path so the text at least moves on.
 */
export async function rebuildPage(bridge: EvenAppBridge, scene: Scene, menu: MenuSpec | null): Promise<RenderResult> {
  try {
    const ok = await bounded(bridge.rebuildPageContainer(new RebuildPageContainer(pageParts(scene, menu))), PAGE_CALL_MS, "rebuild");
    if (!ok) return { ok: false, reason: "rebuild refused" };
    sentLength.clear();
    shown.clear();
    return updateImages(bridge, scene);
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

/** Fast path: text in place, and only the pictures that changed - each one crosses Bluetooth. */
export async function updatePage(bridge: EvenAppBridge, scene: Scene): Promise<RenderResult> {
  const { view, kind } = scene;
  const updates: Array<[number, string, string]> = [
    ...(kind === "text" ? [[HEADER_ID, "header", view.header] as [number, string, string]] : []),
    [BODY_ID, "body", view.body.join("\n")],
    [FOOTER_ID, "footer", view.footer],
  ];
  try {
    for (const [id, name, content] of updates) {
      await bounded(bridge.textContainerUpgrade(new TextContainerUpgrade({
        containerID: id,
        containerName: name,
        ...guarded(id, content),
      })), TEXT_CALL_MS, "text " + name);
    }
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
  return updateImages(bridge, scene);
}

/**
 * Sends the pictures that changed. A picture that does not go through never
 * fails the page: before, it marked the page as lost, and the next draw
 * rebuilt it - every two seconds, for as long as the picture kept failing,
 * each rebuild swallowing the taps meant to leave. Now the text stays, the
 * picture is forgotten and tried again with the next draw.
 */
async function updateImages(bridge: EvenAppBridge, scene: Scene): Promise<RenderResult> {
  let partial = false;
  for (const picture of scene.images) {
    if (shown.get(picture.id) === picture.key) continue;
    const spec = IMAGES[scene.kind].find((candidate) => candidate.id === picture.id);
    if (!spec) continue;
    try {
      const imageData = await picture.render();
      const result = await bounded(bridge.updateImageRawData(new ImageRawDataUpdate({
        containerID: spec.id, containerName: spec.name, imageData,
      })), IMAGE_CALL_MS, "image " + spec.name);
      if (result === ImageRawDataUpdateResult.success) { shown.set(picture.id, picture.key); continue; }
      console.warn("[nextstop] picture not taken:", spec.name, String(result));
    } catch (error) {
      console.warn("[nextstop] picture failed:", spec.name, errorMessage(error));
    }
    shown.delete(picture.id);
    partial = true;
  }
  return partial ? { ok: true, partial: true } : { ok: true };
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
