import { CreateStartUpPageContainer, ImageContainerProperty, ImageRawDataUpdate, ImageRawDataUpdateResult, MenuContainerProperty, MenuItemProperty, RebuildPageContainer, StartUpPageCreateResult, TextContainerProperty, TextContainerUpgrade, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { CHART } from "../weather/chart";
import { ICONS } from "../weather/icons";
import { RADAR_TILES } from "../radar/layout";
import type { ImageTarget } from "./lane";
import { tileSlots } from "../screen/sender";

/** QIS v1.2: one item of the glasses' side menu (id > 0, label at most 32 bytes). */
export interface MenuItemSpec { readonly id: number; readonly label: string }
export interface MenuSpec {
  /** Changes exactly when the glasses need a different menu (=> one rebuild). */
  readonly key: string;
  readonly items: readonly MenuItemSpec[];
}
/** The side menu every page of the app carries (weather, radar, cockpit); set before a page is built. */
let pageMenu: MenuSpec | null = null;
export function setPageMenu(menu: MenuSpec | null): void { pageMenu = menu; }
/** The side menu as the SDK wants it (`menuObject` of the page), as in Babel and Quiet Hub. */
export function buildMenu(menu: MenuSpec | null): MenuContainerProperty | undefined {
  if (menu === null || menu.items.length === 0) return undefined;
  return new MenuContainerProperty({ menuItems: menu.items.map((item) => new MenuItemProperty({ itemName: item.label, itemID: item.id })) });
}
const withMenu = (): { menuObject?: MenuContainerProperty } => { const menuObject = buildMenu(pageMenu); return menuObject === undefined ? {} : { menuObject }; };

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
    ...withMenu(),
    containerTotalNum: parts.length + 2,
    textObject: parts.map((part, index) => new TextContainerProperty({
      containerID: part.id, containerName: part.name, xPosition: part.x, yPosition: part.y, width: part.width, height: part.height,
      paddingLength: 4, zOrderIndex: index + 1, isEventCapture: part.name === "body" ? 1 : 0, content: content[index] || " ",
    })),
    imageObject: [ICONS, CHART].map((image, index) => new ImageContainerProperty({ containerID: image.id, containerName: image.name, xPosition: image.x, yPosition: image.y, width: image.width, height: image.height, zOrderIndex: parts.length + 1 + index })),
  });
}

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

/** One image write; the lane decides when. */
export async function sendImage(bridge: EvenAppBridge, target: ImageTarget, imageData: Uint8Array): Promise<boolean> {
  const result = await bounded(bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: target.id, containerName: target.name, imageData })), IMAGE_CALL_MS, "image " + target.name);
  return result === ImageRawDataUpdateResult.success;
}

/** `createStartUpPageContainer` runs once per bridge; every later page is a rebuild. */
const started = new WeakSet<object>();

/**
 * The next page goes the way of the very first one again (rebuild + create).
 * Needed after the system's exit dialog was cancelled: on the real glasses the
 * dialog takes the page away, and a plain rebuild no longer reaches it (store
 * review 16.10.2026: "after No, double-tap can no longer open the exit window").
 */
export function forgetPage(bridge: EvenAppBridge): void {
  started.delete(bridge);
}

async function installPage(bridge: EvenAppBridge, next: CreateStartUpPageContainer): Promise<RenderResult> {
  sentLength.clear();
  if (started.has(bridge)) {
    try {
      const ok = await bounded(bridge.rebuildPageContainer(new RebuildPageContainer({ ...next })), PAGE_CALL_MS, "rebuild");
      return ok ? { ok: true } : { ok: false, reason: "rebuild refused" };
    } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error) }; }
  }
  try {
    // Measured on real glasses: the first page needs one rebuild call before the creation
    // (it registers input); the result is ignored.
    await bounded(bridge.rebuildPageContainer(new RebuildPageContainer({ ...next })), PAGE_CALL_MS, "rebuild");
  } catch {
    // Expected to fail before the first page.
  }
  try {
    const result = await bounded(bridge.createStartUpPageContainer(next), PAGE_CALL_MS, "create page");
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
      await bounded(bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: part.id, containerName: part.name, ...guarded(part.id, content[index] ?? "") })), TEXT_CALL_MS, "text " + part.name);
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
    ...withMenu(),
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
      await bounded(bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: part.id, containerName: part.name, ...guarded(part.id, content[index] ?? "") })), TEXT_CALL_MS, "text " + part.name);
    }
    return { ok: true };
  } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error) }; }
}

/**
 * The cockpit page: the whole display is four image tiles (2 x 2, drawn by
 * src/cockpit), plus one empty text container under them that owns the
 * input (a page needs one container capturing events).
 */
export const COCKPIT_TILES = tileSlots(21, "cockpit");

function cockpitPage(): CreateStartUpPageContainer {
  return new CreateStartUpPageContainer({
    ...withMenu(),
    containerTotalNum: 1 + COCKPIT_TILES.length,
    textObject: [new TextContainerProperty({ containerID: 20, containerName: "cockpit-input", xPosition: 0, yPosition: 0, width: 576, height: 288, paddingLength: 0, zOrderIndex: 1, isEventCapture: 1, content: " " })],
    imageObject: COCKPIT_TILES.map((image, index) => new ImageContainerProperty({ containerID: image.id, containerName: image.name, xPosition: image.x, yPosition: image.y, width: image.width, height: image.height, zOrderIndex: index + 2 })),
  });
}

export async function createCockpitPage(bridge: EvenAppBridge): Promise<RenderResult> {
  return installPage(bridge, cockpitPage());
}
