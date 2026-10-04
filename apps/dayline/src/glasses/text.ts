import { CreateStartUpPageContainer, ImageContainerProperty, ImageRawDataUpdate, ImageRawDataUpdateResult, RebuildPageContainer, StartUpPageCreateResult, TextContainerProperty, TextContainerUpgrade, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { renderPixelIcon, type PixelIcon } from "./pixel";
export interface TextView { readonly header: string; readonly body: readonly string[]; readonly footer: string; }
export interface RenderResult { readonly ok: boolean; readonly reason?: string; }
const parts = [{ id: 1, name: "header", y: 0, height: 34 }, { id: 2, name: "body", y: 36, height: 214 }, { id: 3, name: "footer", y: 252, height: 34 }] as const;
function makePage(view: TextView, icon?: PixelIcon): CreateStartUpPageContainer {
  const content = [view.header, view.body.join("\n"), view.footer];
  return new CreateStartUpPageContainer({ containerTotalNum: icon ? 4 : 3, textObject: parts.map((part, index) => new TextContainerProperty({
    containerID: part.id, containerName: part.name, xPosition: part.id === 2 && icon ? 104 : 0, yPosition: part.y, width: part.id === 2 && icon ? 472 : 576, height: part.height,
    paddingLength: 4, zOrderIndex: index + 1, isEventCapture: part.id === 2 ? 1 : 0, content: content[index] ?? "",
  })), imageObject: icon ? [new ImageContainerProperty({ containerID: 4, containerName: "pixel-icon", xPosition: 0, yPosition: 36, width: 96, height: 144, zOrderIndex: 4 })] : [] });
}
async function updatePixel(bridge: EvenAppBridge, icon?: PixelIcon): Promise<RenderResult> { if (!icon) return { ok: true }; try { const imageData = await renderPixelIcon(icon); const result = await bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: 4, containerName: "pixel-icon", imageData })); return result === ImageRawDataUpdateResult.success ? { ok: true } : { ok: false, reason: `image:${String(result)}` }; } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error) }; } }
export async function createTextPage(bridge: EvenAppBridge, view: TextView, icon?: PixelIcon): Promise<RenderResult> {
  const next = makePage(view, icon); try { await bridge.rebuildPageContainer(new RebuildPageContainer({ ...next })); } catch { /* expected */ }
  try { const result = await bridge.createStartUpPageContainer(next); return result === StartUpPageCreateResult.success ? updatePixel(bridge, icon) : { ok: false, reason: `create:${String(result)}` }; }
  catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error) }; }
}
export async function updateTextPage(bridge: EvenAppBridge, view: TextView, icon?: PixelIcon): Promise<RenderResult> {
  const content = [view.header, view.body.join("\n"), view.footer];
  try {
    for (let index = 0; index < parts.length; index += 1) { const part = parts[index]; if (part) await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: part.id, containerName: part.name, content: content[index] ?? "" })); }
    return updatePixel(bridge, icon);
  } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error) }; }
}
