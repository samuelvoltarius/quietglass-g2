import { CreateStartUpPageContainer, RebuildPageContainer, StartUpPageCreateResult, TextContainerProperty, TextContainerUpgrade, type EvenAppBridge } from "@evenrealities/even_hub_sdk";

export interface TextView { readonly header: string; readonly body: readonly string[]; readonly footer: string; }
export interface RenderResult { readonly ok: boolean; readonly reason?: string; }
const parts = [
  { id: 1, name: "header", y: 0, height: 34 },
  { id: 2, name: "body", y: 36, height: 214 },
  { id: 3, name: "footer", y: 252, height: 34 },
] as const;

function page(view: TextView): CreateStartUpPageContainer {
  const content = [view.header, view.body.join("\n"), view.footer];
  return new CreateStartUpPageContainer({
    containerTotalNum: 3,
    textObject: parts.map((part, index) => new TextContainerProperty({
      containerID: part.id, containerName: part.name, xPosition: 0, yPosition: part.y,
      width: 576, height: part.height, paddingLength: 4, zOrderIndex: index + 1,
      isEventCapture: part.id === 2 ? 1 : 0, content: content[index] ?? "",
    })),
  });
}

export async function createTextPage(bridge: EvenAppBridge, view: TextView): Promise<RenderResult> {
  const next = page(view);
  try { await bridge.rebuildPageContainer(new RebuildPageContainer({ ...next })); } catch { /* firmware path */ }
  try {
    const result = await bridge.createStartUpPageContainer(next);
    return result === StartUpPageCreateResult.success ? { ok: true } : { ok: false, reason: `create:${String(result)}` };
  } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error) }; }
}

export async function updateTextPage(bridge: EvenAppBridge, view: TextView): Promise<RenderResult> {
  const content = [view.header, view.body.join("\n"), view.footer];
  try {
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      if (!part) continue;
      await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: part.id, containerName: part.name, content: content[index] ?? "" }));
    }
    return { ok: true };
  } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error) }; }
}
