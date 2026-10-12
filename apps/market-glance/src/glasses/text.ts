import { CreateStartUpPageContainer, RebuildPageContainer, StartUpPageCreateResult, TextContainerProperty, TextContainerUpgrade, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
export interface TextView { readonly header: string; readonly body: readonly string[]; readonly footer: string; }
const parts = [{ id: 1, name: "header", y: 0, height: 34 }, { id: 2, name: "body", y: 36, height: 214 }, { id: 3, name: "footer", y: 252, height: 34 }] as const;
function page(view: TextView): CreateStartUpPageContainer { const content = [view.header, view.body.join("\n"), view.footer]; return new CreateStartUpPageContainer({ containerTotalNum: 3, textObject: parts.map((part, index) => new TextContainerProperty({ containerID: part.id, containerName: part.name, xPosition: 0, yPosition: part.y, width: 576, height: part.height, paddingLength: 4, zOrderIndex: index + 1, isEventCapture: part.id === 2 ? 1 : 0, content: content[index] || " " })) }); }
export async function createTextPage(bridge: EvenAppBridge, view: TextView): Promise<boolean> { const next = page(view); try { await bridge.rebuildPageContainer(new RebuildPageContainer({ ...next })); } catch { /* firmware path */ } try { return await bridge.createStartUpPageContainer(next) === StartUpPageCreateResult.success; } catch { return false; } }

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

export async function updateTextPage(bridge: EvenAppBridge, view: TextView): Promise<boolean> { const content = [view.header, view.body.join("\n"), view.footer]; try { for (let index = 0; index < parts.length; index += 1) { const part = parts[index]; if (part) await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: part.id, containerName: part.name, ...guarded(part.id, content[index] ?? "") })); } return true; } catch { return false; } }
