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
import type { AgentView } from "./view";
import { bounded, IMAGE_CALL_MS, PAGE_CALL_MS, TEXT_CALL_MS } from "./images";
import { tileSlots, type TileSend, type TileSlot } from "../screen/sender";
export { PAGE_CALL_MS, TEXT_CALL_MS, IMAGE_CALL_MS } from "./images";

/**
 * Renders the agent session onto the G2. Two kinds of page on the 576 x 288 display:
 *
 *  - a text page (answers, decisions, session list, help, errors): three
 *    stacked text containers (header, body, footer);
 *  - the status cockpit (QUS v1): the whole display is four 288 x 144 image
 *    tiles (drawn by src/cockpit), plus one empty text container that owns
 *    the input.
 *
 * After the page exists, text goes through `textContainerUpgrade` (changes
 * text without rebuilding the page - on real hardware a rebuild falls back to
 * a full page creation and costs seconds, discarding input meanwhile) and the
 * cockpit through the tile sender, which sends only the tiles that changed.
 */

const NL = String.fromCharCode(10);
export const SCREEN_WIDTH = 576;
export const SCREEN_HEIGHT = 288;

export type Layout = "text" | "cockpit";

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

/** The cockpit's four image containers; the input container sits under them. */
export const COCKPIT_TILES = tileSlots(21, "agent");
const COCKPIT_INPUT_ID = 20;

export interface RenderResult {
  readonly ok: boolean;
  /** Present when page creation failed, for the caller to surface or log. */
  readonly reason?: string;
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

export function buildPage(view: AgentView, menu: MenuSpec | null = null, layout: Layout = "text"): CreateStartUpPageContainer {
  const menuObject = buildMenu(menu);
  const withMenu = menuObject === undefined ? {} : { menuObject };
  if (layout === "cockpit") {
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
  return new CreateStartUpPageContainer({
    ...withMenu,
    containerTotalNum: 3,
    textObject: [
      text(CONTAINER.header, view.header, 1, false),
      // Exactly one container may capture input; the body owns it.
      text(CONTAINER.body, view.body.join("\n"), 2, true),
      text(CONTAINER.footer, view.footer, 3, false),
    ],
  });
}

function text(spec: ContainerSpec, content: string, zOrderIndex: number, captureEvents: boolean): TextContainerProperty {
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
 * Puts a page on the glasses. The very first time on a bridge, one
 * `rebuildPageContainer` goes out first (result ignored, failure swallowed: on
 * real glasses it is what registers the input route) and then
 * `createStartUpPageContainer` runs exactly once. Every later page - also
 * another layout - replaces it with `rebuildPageContainer`; a second creation
 * would be refused as "invalid".
 */
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

async function installPage(bridge: EvenAppBridge, view: AgentView, menu: MenuSpec | null = null, layout: Layout = "text"): Promise<RenderResult> {
  // A rebuild without the menu would clear it, so every page carries it again.
  const page = buildPage(view, menu, layout);
  sentLength.clear();
  try {
    if (!started.has(bridge)) {
      try {
        await bounded(bridge.rebuildPageContainer(new RebuildPageContainer({ ...page })), PAGE_CALL_MS, "rebuild");
      } catch {
        // Expected on current firmware; the creation below is the real path.
      }
      const result = await bounded(bridge.createStartUpPageContainer(page), PAGE_CALL_MS, "create page");
      if (result !== StartUpPageCreateResult.success) return { ok: false, reason: describeCreateResult(result) };
      started.add(bridge);
    } else {
      const ok = await bounded(bridge.rebuildPageContainer(new RebuildPageContainer({ ...page })), PAGE_CALL_MS, "rebuild");
      // A refused rebuild leaves the old page in place.
      if (!ok) return { ok: false, reason: "rebuild refused" };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

export const createPage = installPage;
export const rebuildPage = installPage;

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

/** Counters for tests and diagnostics. */
export const renderStats = { upgrades: 0 };

/** Only the containers whose text changed are written. */
export async function updatePage(
  bridge: EvenAppBridge,
  view: AgentView,
  previous: AgentView | null = null,
): Promise<RenderResult> {
  const updates: Array<[ContainerSpec, string, string | undefined]> = [
    [CONTAINER.header, view.header, previous?.header],
    [CONTAINER.body, view.body.join(NL), previous?.body.join(NL)],
    [CONTAINER.footer, view.footer, previous?.footer],
  ];

  try {
    for (const [spec, content, before] of updates) {
      if (before !== undefined && before === content) continue;
      renderStats.upgrades += 1;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
