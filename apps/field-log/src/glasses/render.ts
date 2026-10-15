import {
  CreateStartUpPageContainer,
  MenuContainerProperty,
  MenuItemProperty,
  TextContainerProperty,
  TextContainerUpgrade,
  RebuildPageContainer,
  StartUpPageCreateResult,
  type EvenAppBridge,
} from "@evenrealities/even_hub_sdk";
import type { LogView } from "./view";

/**
 * Renders the inspection log onto the G2.
 *
 * Layout is fixed at three stacked text containers on the 576 x 288 display.
 * After the page exists, updates go through `textContainerUpgrade`, which
 * changes text without rebuilding the page — on real hardware a rebuild falls
 * back to a full page creation and costs seconds, discarding input meanwhile.
 */

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

/** QIS v1.2: one item of the glasses' side menu (id > 0, label at most 32 bytes). */
export interface MenuItemSpec { readonly id: number; readonly label: string }
export interface MenuSpec { readonly items: readonly MenuItemSpec[] }

/** The side menu as the SDK wants it (`menuObject` of the page), as in Babel Glass. */
export function buildMenu(menu: MenuSpec | null): MenuContainerProperty | undefined {
  if (menu === null || menu.items.length === 0) return undefined;
  return new MenuContainerProperty({
    menuItems: menu.items.map((item) => new MenuItemProperty({ itemName: item.label, itemID: item.id })),
  });
}

export function buildPage(view: LogView, menu: MenuSpec | null = null): CreateStartUpPageContainer {
  const menuObject = buildMenu(menu);
  return new CreateStartUpPageContainer({
    ...(menuObject === undefined ? {} : { menuObject }),
    containerTotalNum: 3,
    textObject: [
      text(CONTAINER.header, view.header, 1, false),
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
): TextContainerProperty {
  return new TextContainerProperty({
    containerID: spec.id,
    containerName: spec.name,
    xPosition: 0,
    yPosition: spec.y,
    width: SCREEN_WIDTH,
    height: spec.height,
    paddingLength: 4,
    zOrderIndex,
    isEventCapture: captureEvents ? 1 : 0,
    content: content || " ",
  });
}

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
 * Puts the page on the glasses: created once per bridge, every later call
 * (reconnect) rebuilds it. The caller resends all images afterwards.
 */
const started = new WeakSet<object>();

export async function createPage(bridge: EvenAppBridge, view: LogView, menu: MenuSpec | null = null): Promise<RenderResult> {
  // A rebuild without the menu would clear it, so every rebuild supplies it again.
  const page = buildPage(view, menu);
  sentLength.clear();
  // One creation per bridge, then only rebuilds: a rebuild before the first
  // creation or a second creation leaves the page without its input route.
  if (started.has(bridge)) {
    try {
      const ok = await bounded(bridge.rebuildPageContainer(new RebuildPageContainer({ ...page })), PAGE_CALL_MS, "rebuild");
      return ok ? { ok: true } : { ok: false, reason: "rebuild refused" };
    } catch (error) {
      return { ok: false, reason: errorMessage(error) };
    }
  }
  try {
    // Measured on real glasses: the first page needs one rebuild call before the creation
    // (it registers input); the result is ignored.
    await bounded(bridge.rebuildPageContainer(new RebuildPageContainer({ ...page })), PAGE_CALL_MS, "rebuild");
  } catch {
    // Expected to fail before the first page.
  }
  try {
    const result = await bounded(bridge.createStartUpPageContainer(page), PAGE_CALL_MS, "create page");
    if (result === StartUpPageCreateResult.success) { started.add(bridge); return { ok: true }; }
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

export async function updatePage(bridge: EvenAppBridge, view: LogView): Promise<RenderResult> {
  const updates: Array<[ContainerSpec, string]> = [
    [CONTAINER.header, view.header],
    [CONTAINER.body, view.body.join("\n")],
    [CONTAINER.footer, view.footer],
  ];

  try {
    for (const [spec, content] of updates) {
      await bounded(bridge.textContainerUpgrade(new TextContainerUpgrade({
        containerID: spec.id,
        containerName: spec.name,
        ...guarded(spec.id, content),
      })), TEXT_CALL_MS, "text " + spec.name);
    }
    return { ok: true };
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
