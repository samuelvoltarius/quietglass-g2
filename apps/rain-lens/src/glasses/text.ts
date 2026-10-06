import { CreateStartUpPageContainer, ImageContainerProperty, ImageRawDataUpdate, ImageRawDataUpdateResult, RebuildPageContainer, StartUpPageCreateResult, TextContainerProperty, TextContainerUpgrade, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { CHART } from "../weather/chart";
import { ICONS } from "../weather/icons";
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
      paddingLength: 4, zOrderIndex: index + 1, isEventCapture: part.name === "body" ? 1 : 0, content: content[index] ?? "",
    })),
    imageObject: [ICONS, CHART].map((image, index) => new ImageContainerProperty({ containerID: image.id, containerName: image.name, xPosition: image.x, yPosition: image.y, width: image.width, height: image.height, zOrderIndex: parts.length + 1 + index })),
  });
}

/** One image write; the lane decides when. */
export async function sendImage(bridge: EvenAppBridge, target: ImageTarget, imageData: Uint8Array): Promise<boolean> {
  const result = await bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: target.id, containerName: target.name, imageData }));
  return result === ImageRawDataUpdateResult.success;
}

export async function createTextPage(bridge: EvenAppBridge, view: TextView): Promise<RenderResult> {
  const next = page(view);
  try { await bridge.rebuildPageContainer(new RebuildPageContainer({ ...next })); } catch { /* firmware path */ }
  try {
    const result = await bridge.createStartUpPageContainer(next);
    return result === StartUpPageCreateResult.success ? { ok: true } : { ok: false, reason: `create:${String(result)}` };
  } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error) }; }
}

/** Upgrades only the containers whose text changed since `previous`. */
export async function updateTextPage(bridge: EvenAppBridge, view: TextView, previous?: TextView): Promise<RenderResult> {
  const content = contents(view); const before = previous ? contents(previous) : [];
  try {
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      if (!part || content[index] === before[index]) continue;
      await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: part.id, containerName: part.name, content: content[index] ?? "" }));
    }
    return { ok: true };
  } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error) }; }
}
