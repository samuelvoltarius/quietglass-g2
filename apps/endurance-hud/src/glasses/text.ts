import { CreateStartUpPageContainer, ImageContainerProperty, MenuContainerProperty, MenuItemProperty, ImageRawDataUpdate, ImageRawDataUpdateResult, RebuildPageContainer, StartUpPageCreateResult, TextContainerProperty, TextContainerUpgrade, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { renderPixelIcon, type PixelIcon } from "./pixel";

/**
 * Every call into the glasses is bounded. Draws run one after another, so a
 * single answer that never comes (a Bluetooth write lost on the way) used to
 * freeze the display for good on its last page. A call that times out counts
 * as failed: the draw fails, the page is marked broken and the next draw
 * rebuilds it.
 */
export const PAGE_CALL_MS = 8_000;
export const TEXT_CALL_MS = 5_000;
export const IMAGE_CALL_MS = 10_000;

export function bounded<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: no answer from the glasses within ${ms} ms`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
export interface TextView { readonly header: string; readonly body: readonly string[]; readonly footer: string; }
/** The glasses' side menu (QIS v1.2): ids are never 0, labels at most 32 bytes. */
export interface MenuSpec { readonly items: readonly { readonly id: number; readonly label: string }[]; }
const parts = [{ id: 1, name: "header", y: 0, height: 34 }, { id: 2, name: "body", y: 36, height: 214 }, { id: 3, name: "footer", y: 252, height: 34 }] as const;
function page(view: TextView, icon?: PixelIcon, menu?: MenuSpec): CreateStartUpPageContainer { const content = [view.header, view.body.join("\n"), view.footer]; return new CreateStartUpPageContainer({ containerTotalNum: icon ? 4 : 3, textObject: parts.map((part, index) => new TextContainerProperty({ containerID: part.id, containerName: part.name, xPosition: part.id === 2 && icon ? 104 : 0, yPosition: part.y, width: part.id === 2 && icon ? 472 : 576, height: part.height, paddingLength: 4, zOrderIndex: index + 1, isEventCapture: part.id === 2 ? 1 : 0, content: content[index] || " " })), imageObject: icon ? [new ImageContainerProperty({ containerID: 4, containerName: "pixel-icon", xPosition: 0, yPosition: 36, width: 96, height: 144, zOrderIndex: 4 })] : [], ...(menu && menu.items.length > 0 ? { menuObject: new MenuContainerProperty({ menuItems: menu.items.map((item) => new MenuItemProperty({ itemName: item.label, itemID: item.id })) }) } : {}) }); }
async function updatePixel(bridge: EvenAppBridge, icon?: PixelIcon): Promise<boolean> { if (!icon) return true; try { const imageData = await renderPixelIcon(icon); return await bounded(bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: 4, containerName: "pixel-icon", imageData })), IMAGE_CALL_MS, "image pixel-icon") === ImageRawDataUpdateResult.success; } catch { return false; } }
export async function createTextPage(bridge: EvenAppBridge, view: TextView, icon?: PixelIcon, menu?: MenuSpec): Promise<boolean> { const next = page(view, icon, menu); try { await bounded(bridge.rebuildPageContainer(new RebuildPageContainer({ ...next })), PAGE_CALL_MS, "rebuild"); } catch { /* firmware path */ } try { return await bounded(bridge.createStartUpPageContainer(next), PAGE_CALL_MS, "create page") === StartUpPageCreateResult.success && await updatePixel(bridge, icon); } catch { return false; } }

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

export async function updateTextPage(bridge: EvenAppBridge, view: TextView, icon?: PixelIcon): Promise<boolean> { const content = [view.header, view.body.join("\n"), view.footer]; try { for (let index = 0; index < parts.length; index += 1) { const part = parts[index]; if (part) await bounded(bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: part.id, containerName: part.name, ...guarded(part.id, content[index] ?? "") })), TEXT_CALL_MS, "text " + part.name); } return updatePixel(bridge, icon); } catch { return false; } }
