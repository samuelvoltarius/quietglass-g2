import {
  CreateStartUpPageContainer,
  ImageContainerProperty,
  ImageRawDataUpdate,
  ImageRawDataUpdateResult,
  MenuContainerProperty,
  MenuItemProperty,
  TextContainerProperty,
  TextContainerUpgrade,
  RebuildPageContainer,
  StartUpPageCreateResult,
  type EvenAppBridge,
} from "@evenrealities/even_hub_sdk";
import type { Layout, PageView } from "./views";
import { bounded, PAGE_CALL_MS, TEXT_CALL_MS, IMAGE_CALL_MS } from "./images";
import { tileSlots, type TileSend, type TileSlot } from "../screen/sender";
export { PAGE_CALL_MS, TEXT_CALL_MS, IMAGE_CALL_MS } from "./images";

/**
 * Puts a page view onto the G2 (576 x 288).
 *
 *  - cockpit (QUS v1): drive, charge and status are one image, four 288 x 144
 *    tiles drawn by src/cockpit and sent by the tile sender (only changed
 *    tiles), plus one empty text container that owns the input;
 *  - plain:  header, full-width body (7 rows), footer: control list, warnings, help, waiting.
 *
 * The first page on a bridge is one ignored `rebuildPageContainer` and then
 * exactly one `createStartUpPageContainer`; every later layout change is a
 * rebuild; anything else is `textContainerUpgrade` / tile writes, and only
 * when it changed.
 */

const NL = String.fromCharCode(10);
export const SCREEN_WIDTH = 576;
export const SCREEN_HEIGHT = 288;

interface TextSpec {
  readonly id: number;
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const HEADER: TextSpec = { id: 1, name: "header", x: 0, y: 0, width: SCREEN_WIDTH, height: 32 };
const FOOTER: TextSpec = { id: 3, name: "footer", x: 0, y: 252, width: SCREEN_WIDTH, height: 34 };
const BODY: TextSpec = { id: 2, name: "body", x: 0, y: 36, width: SCREEN_WIDTH, height: 216 };

/** The cockpit's four image containers; the input container sits under them. */
export const COCKPIT_TILES = tileSlots(21, "byd");
const COCKPIT_INPUT_ID = 20;

export function bodySpec(): TextSpec {
  return BODY;
}

export interface RenderResult {
  readonly ok: boolean;
  readonly reason?: string;
}

function text(spec: TextSpec, content: string, z: number, capture: boolean): TextContainerProperty {
  return new TextContainerProperty({
    containerID: spec.id,
    containerName: spec.name,
    xPosition: spec.x,
    yPosition: spec.y,
    width: spec.width,
    height: spec.height,
    paddingLength: 4,
    zOrderIndex: z,
    isEventCapture: capture ? 1 : 0,
    content: content || " ",
  });
}

/** QIS v1.2: one item of the glasses' side menu (id > 0, label at most 32 bytes). */
export interface MenuItemSpec { readonly id: number; readonly label: string }
export interface MenuSpec { readonly items: readonly MenuItemSpec[] }

/** The side menu as the SDK wants it (`menuObject` of the page), as in Quiet Hub. */
export function buildMenu(menu: MenuSpec | null): MenuContainerProperty | undefined {
  if (menu === null || menu.items.length === 0) return undefined;
  return new MenuContainerProperty({
    menuItems: menu.items.map((item) => new MenuItemProperty({ itemName: item.label, itemID: item.id })),
  });
}

export function buildPage(view: PageView, menu: MenuSpec | null = null): CreateStartUpPageContainer {
  const menuObject = buildMenu(menu);
  const withMenu = menuObject === undefined ? {} : { menuObject };
  if (view.layout === "cockpit") {
    return new CreateStartUpPageContainer({
      ...withMenu,
      containerTotalNum: 1 + COCKPIT_TILES.length,
      textObject: [new TextContainerProperty({
        containerID: COCKPIT_INPUT_ID, containerName: "cockpit-input", xPosition: 0, yPosition: 0, width: SCREEN_WIDTH, height: SCREEN_HEIGHT,
        paddingLength: 0, zOrderIndex: 1, isEventCapture: 1, content: " ",
      })],
      imageObject: COCKPIT_TILES.map((tile, index) => new ImageContainerProperty({
        containerID: tile.id, containerName: tile.name, xPosition: tile.x, yPosition: tile.y, width: tile.width, height: tile.height, zOrderIndex: index + 2,
      })),
    });
  }
  const texts = [
    text(HEADER, view.header, 1, false),
    // Exactly one container captures input; the body owns it.
    text(BODY, view.body.join(NL), 2, true),
    text(FOOTER, view.footer, 3, false),
  ];
  return new CreateStartUpPageContainer({ ...withMenu, containerTotalNum: texts.length, textObject: texts });
}

const started = new WeakSet<EvenAppBridge>();

/**
 * The next page goes the way of the very first one again (rebuild + create).
 * Needed after the system's exit dialog was cancelled: on the real glasses the
 * dialog takes the page away, and a plain rebuild no longer reaches it (store
 * review 16.10.2026: "after No, double-tap can no longer open the exit window").
 */
export function forgetPage(bridge: EvenAppBridge): void {
  started.delete(bridge);
}
const sentLength = new Map<number, number>();
const TEXT_HARD_CAP = 900;

/** The lens blanks `contentLength` characters: never less than before, or old text stays visible. */
function guarded(id: number, content: string): { content: string; contentLength: number } {
  const value = (content || " ").slice(0, TEXT_HARD_CAP);
  const length = Math.max(sentLength.get(id) ?? 0, value.length);
  sentLength.set(id, value.length);
  return { content: value, contentLength: length };
}

/** Counters for tests and diagnostics. */
export const renderStats = { creates: 0, rebuilds: 0, upgrades: 0 };

/** First page on this bridge: one ignored rebuild, then exactly one create. Afterwards: rebuild. */
export async function installPage(bridge: EvenAppBridge, view: PageView, menu: MenuSpec | null = null): Promise<RenderResult> {
  // A rebuild without the menu would clear it, so every page carries it again.
  const page = buildPage(view, menu);
  sentLength.clear();
  try {
    if (!started.has(bridge)) {
      try {
        await bounded(bridge.rebuildPageContainer(new RebuildPageContainer({ ...page })), PAGE_CALL_MS, "rebuild");
      } catch {
        // Expected before the first creation; it registers the input route on real glasses.
      }
      const result = await bounded(bridge.createStartUpPageContainer(page), PAGE_CALL_MS, "create page");
      if (result !== StartUpPageCreateResult.success) return { ok: false, reason: describeCreateResult(result) };
      started.add(bridge);
      renderStats.creates += 1;
    } else {
      const ok = await bounded(bridge.rebuildPageContainer(new RebuildPageContainer({ ...page })), PAGE_CALL_MS, "rebuild");
      if (!ok) return { ok: false, reason: "rebuild refused" };
      renderStats.rebuilds += 1;
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Only the texts that changed are written (the cockpit has none: its tiles are the tile sender's business). */
export async function updatePage(bridge: EvenAppBridge, view: PageView, previous: PageView | null): Promise<RenderResult> {
  if (view.layout === "cockpit") return { ok: true };
  const updates: Array<[TextSpec, string, string | undefined]> = [
    [HEADER, view.header, previous?.header],
    [BODY, view.body.join(NL), previous?.body.join(NL)],
    [FOOTER, view.footer, previous?.footer],
  ];
  try {
    for (const [spec, content, before] of updates) {
      if (before !== undefined && before === content) continue;
      renderStats.upgrades += 1;
      await bounded(bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: spec.id, containerName: spec.name, ...guarded(spec.id, content) })), TEXT_CALL_MS, "text " + spec.name);
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** One cockpit tile to the glasses; resolves true on success. */
export async function sendTile(bridge: EvenAppBridge, slot: TileSlot, imageData: Uint8Array): Promise<boolean> {
  const result = await bounded(bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: slot.id, containerName: slot.name, imageData })), IMAGE_CALL_MS, "image " + slot.name);
  return result === ImageRawDataUpdateResult.success;
}

/**
 * The tile sender's write function. It writes only while `allowed()` says so: not while the system exit dialog
 * may be on screen (a page call could cover it) and not after the cockpit page has been left (its containers
 * are gone). A refused tile counts as failed and is tried again with the next frame.
 */
export function guardedTileSend(bridge: EvenAppBridge, allowed: () => boolean): TileSend {
  return (slot, png) => (allowed() ? sendTile(bridge, slot, png) : Promise.resolve(false));
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

export type { Layout };
