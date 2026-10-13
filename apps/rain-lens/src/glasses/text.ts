import { CreateStartUpPageContainer, ImageContainerProperty, ImageRawDataUpdate, ImageRawDataUpdateResult, RebuildPageContainer, StartUpPageCreateResult, TextContainerProperty, TextContainerUpgrade, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { CHART } from "../weather/chart";
import { ICONS } from "../weather/icons";
import { RADAR_TILES } from "../radar/layout";
import type { ImageTarget } from "./lane";

/**
 * One fixed layout for every view: header, four body rows beside the icon
 * column, the 12-hour chart below them with its numbers to its right, and the
 * footer. The layout never changes, so swiping between views and refreshing
 * are text updates only. Images are not written here: they go through the
 * image lane (lane.ts) via `sendImage`, so a transfer never holds up the text.
 */
export interface TextView { readonly header: string; readonly body: readonly string[]; readonly side: readonly string[]; readonly footer: string; }
export interface RenderResult { readonly ok: boolean; readonly reason?: string; }
const parts = [
  { id: 1, name: "header", x: 0, y: 0, width: 576, height: 34 },
  { id: 2, name: "body", x: 104, y: 36, width: 472, height: 110 },
  { id: 5, name: "chart-text", x: CHART.x + CHART.width + 4, y: CHART.y, width: 576 - CHART.x - CHART.width - 4, height: CHART.height },
  { id: 3, name: "footer", x: 0, y: 252, width: 576, height: 34 },
] as const;

const contents = (view: TextView): string[] => [view.header, view.body.join("\n"), view.side.join("\n"), view.footer];

function page(view: TextView): CreateStartUpPageContainer {
  const content = contents(view);
  return new CreateStartUpPageContainer({
    containerTotalNum: parts.length + 2,
    textObject: parts.map((part, index) => new TextContainerProperty({
      containerID: part.id, containerName: part.name, xPosition: part.x, yPosition: part.y, width: part.width, height: part.height,
      paddingLength: 4, zOrderIndex: index + 1, isEventCapture: part.name === "body" ? 1 : 0, content: content[index] || " ",
    })),
    imageObject: [ICONS, CHART].map((image, index) => new ImageContainerProperty({ containerID: image.id, containerName: image.name, xPosition: image.x, yPosition: image.y, width: image.width, height: image.height, zOrderIndex: parts.length + 1 + index })),
  });
}

/** One image write; the lane decides when. */
export async function sendImage(bridge: EvenAppBridge, target: ImageTarget, imageData: Uint8Array): Promise<boolean> {
  const result = await bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: target.id, containerName: target.name, imageData }));
  return result === ImageRawDataUpdateResult.success;
}

/** `createStartUpPageContainer` runs once per bridge; every later page is a rebuild. */
const started = new WeakSet<object>();

async function installPage(bridge: EvenAppBridge, next: CreateStartUpPageContainer): Promise<RenderResult> {
  sentLength.clear();
  if (started.has(bridge)) {
    try {
      const ok = await bridge.rebuildPageContainer(new RebuildPageContainer({ ...next }));
      return ok ? { ok: true } : { ok: false, reason: "rebuild refused" };
    } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error) }; }
  }
  try {
    // Measured on real glasses: the first page needs one rebuild call before the creation
    // (it registers input); the result is ignored.
    await bridge.rebuildPageContainer(new RebuildPageContainer({ ...next }));
  } catch {
    // Expected to fail before the first page.
  }
  try {
    const result = await bridge.createStartUpPageContainer(next);
    if (result === StartUpPageCreateResult.success) { started.add(bridge); return { ok: true }; }
    return { ok: false, reason: `create:${String(result)}` };
  } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error) }; }
}

export async function createTextPage(bridge: EvenAppBridge, view: TextView): Promise<RenderResult> {
  return installPage(bridge, page(view));
}

/** Upgrades only the containers whose text changed since `previous`. */

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

export async function updateTextPage(bridge: EvenAppBridge, view: TextView, previous?: TextView): Promise<RenderResult> {
  const content = contents(view); const before = previous ? contents(previous) : [];
  try {
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      if (!part || content[index] === before[index]) continue;
      await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: part.id, containerName: part.name, ...guarded(part.id, content[index] ?? "") }));
    }
    return { ok: true };
  } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error) }; }
}

/**
 * The radar page: four image containers (2 x 2) cover the display, three text
 * containers sit on top - the header with the frame time, a note in the middle
 * (only while there is no picture) and the footer with the source credit. The
 * footer owns the input. Switching to and from the weather page is a rebuild.
 */
export interface RadarView { readonly header: string; readonly note: string; readonly footer: string; }
const radarParts = [
  { id: 1, name: "header", x: 0, y: 0, width: 576, height: 34 },
  { id: 2, name: "radar-note", x: 40, y: 96, width: 496, height: 90 },
  { id: 3, name: "footer", x: 0, y: 252, width: 576, height: 34 },
] as const;
const radarContents = (view: RadarView): string[] => [view.header, view.note, view.footer];

function radarPage(view: RadarView): CreateStartUpPageContainer {
  const content = radarContents(view);
  return new CreateStartUpPageContainer({
    containerTotalNum: radarParts.length + RADAR_TILES.length,
    textObject: radarParts.map((part, index) => new TextContainerProperty({
      containerID: part.id, containerName: part.name, xPosition: part.x, yPosition: part.y, width: part.width, height: part.height,
      paddingLength: 4, zOrderIndex: RADAR_TILES.length + 1 + index, isEventCapture: part.name === "footer" ? 1 : 0, content: content[index] || " ",
    })),
    imageObject: RADAR_TILES.map((image, index) => new ImageContainerProperty({ containerID: image.id, containerName: image.name, xPosition: image.x, yPosition: image.y, width: image.width, height: image.height, zOrderIndex: index + 1 })),
  });
}

export async function createRadarPage(bridge: EvenAppBridge, view: RadarView): Promise<RenderResult> {
  return installPage(bridge, radarPage(view));
}

/** Upgrades only the radar texts that changed since `previous`. */
export async function updateRadarText(bridge: EvenAppBridge, view: RadarView, previous?: RadarView): Promise<RenderResult> {
  const content = radarContents(view); const before = previous ? radarContents(previous) : [];
  try {
    for (let index = 0; index < radarParts.length; index += 1) {
      const part = radarParts[index];
      if (!part || content[index] === before[index]) continue;
      await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: part.id, containerName: part.name, ...guarded(part.id, content[index] ?? "") }));
    }
    return { ok: true };
  } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error) }; }
}
