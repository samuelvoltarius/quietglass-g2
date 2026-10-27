import {
  CreateStartUpPageContainer,
  RebuildPageContainer,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
  type EvenAppBridge,
} from "@evenrealities/even_hub_sdk";
import type { PageView } from "./view";

/**
 * One text page on the G2 (576 x 288): header, full-width body (owns the
 * input), footer. The first page on a bridge is one ignored rebuild and then
 * exactly one create; after that only `textContainerUpgrade`, and only for the
 * texts that changed. `forgetPage` makes the next draw go the first-page way
 * again (after the exit dialog was cancelled, skill 1a).
 */

const NL = String.fromCharCode(10);
export const SCREEN_WIDTH = 576;
export const PAGE_CALL_MS = 8_000;
export const TEXT_CALL_MS = 5_000;

interface TextSpec { readonly id: number; readonly name: string; readonly y: number; readonly height: number }
const HEADER: TextSpec = { id: 1, name: "header", y: 0, height: 32 };
const BODY: TextSpec = { id: 2, name: "body", y: 36, height: 214 };
const FOOTER: TextSpec = { id: 3, name: "footer", y: 252, height: 34 };

export function bounded<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: no answer from the glasses within ${ms} ms`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function text(spec: TextSpec, content: string, capture: boolean): TextContainerProperty {
  return new TextContainerProperty({
    containerID: spec.id, containerName: spec.name, xPosition: 0, yPosition: spec.y, width: SCREEN_WIDTH, height: spec.height,
    paddingLength: 4, zOrderIndex: spec.id, isEventCapture: capture ? 1 : 0, content: content || " ",
  });
}

export function bodyText(view: PageView): string {
  return view.body.join(NL);
}

export function buildPage(view: PageView): CreateStartUpPageContainer {
  return new CreateStartUpPageContainer({
    containerTotalNum: 3,
    // Exactly one container captures input: the body.
    textObject: [text(HEADER, view.header, false), text(BODY, bodyText(view), true), text(FOOTER, view.footer, false)],
  });
}

const started = new WeakSet<EvenAppBridge>();
const sentLength = new Map<number, number>();

export function forgetPage(bridge: EvenAppBridge): void {
  started.delete(bridge);
}

export interface RenderResult { readonly ok: boolean; readonly reason?: string }

export async function createPage(bridge: EvenAppBridge, view: PageView): Promise<RenderResult> {
  const page = buildPage(view);
  sentLength.clear();
  try {
    if (!started.has(bridge)) {
      try {
        await bounded(bridge.rebuildPageContainer(new RebuildPageContainer({ ...page })), PAGE_CALL_MS, "rebuild");
      } catch {
        // Expected before the first creation; it registers the input route on real glasses.
      }
      const result = await bounded(bridge.createStartUpPageContainer(page), PAGE_CALL_MS, "create page");
      if (result !== StartUpPageCreateResult.success) return { ok: false, reason: `create result ${String(result)}` };
      started.add(bridge);
    } else {
      const ok = await bounded(bridge.rebuildPageContainer(new RebuildPageContainer({ ...page })), PAGE_CALL_MS, "rebuild");
      if (!ok) return { ok: false, reason: "rebuild refused" };
    }
    for (const [spec, content] of [[HEADER, view.header], [BODY, bodyText(view)], [FOOTER, view.footer]] as const) sentLength.set(spec.id, content.length);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** The lens blanks `contentLength` characters: never less than before, or old text stays visible. */
function guarded(id: number, content: string): { content: string; contentLength: number } {
  const value = (content || " ").slice(0, 900);
  const length = Math.max(sentLength.get(id) ?? 0, value.length);
  sentLength.set(id, value.length);
  return { content: value, contentLength: length };
}

export async function updatePage(bridge: EvenAppBridge, view: PageView, previous: PageView): Promise<RenderResult> {
  const updates: Array<[TextSpec, string, string]> = [
    [HEADER, view.header, previous.header],
    [BODY, bodyText(view), bodyText(previous)],
    [FOOTER, view.footer, previous.footer],
  ];
  try {
    for (const [spec, content, before] of updates) {
      if (before === content) continue;
      await bounded(bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: spec.id, containerName: spec.name, ...guarded(spec.id, content) })), TEXT_CALL_MS, "text " + spec.name);
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
