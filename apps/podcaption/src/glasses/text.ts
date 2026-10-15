import { CreateStartUpPageContainer, MenuContainerProperty, MenuItemProperty, RebuildPageContainer, StartUpPageCreateResult, TextContainerProperty, TextContainerUpgrade, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
export interface TextView { readonly header: string; readonly body: readonly string[]; readonly footer: string; }
export interface RenderResult { readonly ok: boolean; readonly reason?: string; }
const parts = [{ id: 1, name: "header", y: 0, height: 34 }, { id: 2, name: "body", y: 36, height: 214 }, { id: 3, name: "footer", y: 252, height: 34 }] as const;
/** QIS v1.2: one item of the glasses' side menu (id > 0, label at most 32 bytes). */
export interface MenuItemSpec { readonly id: number; readonly label: string }
export interface MenuSpec {
  /** Changes exactly when the glasses need a different menu (=> one rebuild). */
  readonly key: string;
  readonly items: readonly MenuItemSpec[];
}
/** The side menu as the SDK wants it (`menuObject` of the page), as in Babel and Quiet Hub. */
export function buildMenu(menu: MenuSpec | null): MenuContainerProperty | undefined {
  if (menu === null || menu.items.length === 0) return undefined;
  return new MenuContainerProperty({ menuItems: menu.items.map((item) => new MenuItemProperty({ itemName: item.label, itemID: item.id })) });
}
function makePage(view: TextView, menu: MenuSpec | null = null): CreateStartUpPageContainer {
  const content = [view.header, view.body.join("\n"), view.footer];
  const menuObject = buildMenu(menu);
  return new CreateStartUpPageContainer({ ...(menuObject === undefined ? {} : { menuObject }), containerTotalNum: 3, textObject: parts.map((part, index) => new TextContainerProperty({
    containerID: part.id, containerName: part.name, xPosition: 0, yPosition: part.y, width: 576, height: part.height,
    paddingLength: 4, zOrderIndex: index + 1, isEventCapture: part.id === 2 ? 1 : 0, content: content[index] || " ",
  })) });
}
/** Bridges that already have their startup page: createStartUpPageContainer runs once, later pages are rebuilds. */
const started = new WeakSet<object>();
/**
 * Every call into the glasses is bounded. Draws run one after another, so one
 * answer that never comes (a Bluetooth write lost on the way) used to freeze
 * the display for good on its last page. A call that times out counts as
 * failed: the caller marks the page broken and the next draw rebuilds it.
 */
export const PAGE_CALL_MS = 8_000;
export const TEXT_CALL_MS = 5_000;
export const IMAGE_CALL_MS = 10_000;

function bounded<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: no answer from the glasses within ${ms} ms`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function createTextPage(bridge: EvenAppBridge, view: TextView, menu: MenuSpec | null = null): Promise<RenderResult> {
  const next = makePage(view, menu);
  if (started.has(bridge)) {
    try { const ok = await bounded(bridge.rebuildPageContainer(new RebuildPageContainer({ ...next })), PAGE_CALL_MS, "rebuild"); return ok ? { ok: true } : { ok: false, reason: "rebuild refused" }; }
    catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error) }; }
  }
  try { await bounded(bridge.rebuildPageContainer(new RebuildPageContainer({ ...next })), PAGE_CALL_MS, "rebuild"); } catch { /* expected */ }
  try { const result = await bounded(bridge.createStartUpPageContainer(next), PAGE_CALL_MS, "create page"); if (result === StartUpPageCreateResult.success) { started.add(bridge); return { ok: true }; } return { ok: false, reason: `create:${String(result)}` }; }
  catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error) }; }
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
  const text = (content || " ").slice(0, TEXT_HARD_CAP);
  const length = Math.max(sentLength.get(specId) ?? 0, text.length);
  sentLength.set(specId, text.length);
  return { content: text, contentLength: length };
}

export async function updateTextPage(bridge: EvenAppBridge, view: TextView): Promise<RenderResult> {
  const content = [view.header, view.body.join("\n"), view.footer];
  try {
    for (let index = 0; index < parts.length; index += 1) { const part = parts[index]; if (part) await bounded(bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: part.id, containerName: part.name, ...guarded(part.id, content[index] ?? "") })), TEXT_CALL_MS, "text " + part.name); }
    return { ok: true };
  } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error) }; }
}
