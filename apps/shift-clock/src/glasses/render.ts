import {
  CreateStartUpPageContainer,
  MenuContainerProperty,
  MenuItemProperty,
  ImageContainerProperty,
  ImageRawDataUpdate,
  ImageRawDataUpdateResult,
  TextContainerProperty,
  TextContainerUpgrade,
  RebuildPageContainer,
  StartUpPageCreateResult,
  type EvenAppBridge,
} from "@evenrealities/even_hub_sdk";
import type { ClockView } from "./view";
import { tileSlots, type TileSend, type TileSlot } from "../screen/sender";

/**
 * Renders ShiftClock onto the G2. Two kinds of page on the 576 x 288 display:
 *
 *  - the text page (start): header, body, footer, in the three text
 *    containers every Quietglass app uses;
 *  - the cockpit page (QUS v1): the whole display is four 288 x 144 image
 *    tiles (drawn by src/cockpit), plus one empty text container that owns
 *    the input.
 *
 * `createStartUpPageContainer` runs exactly once (preceded by one rebuild that
 * registers input on real glasses). Every later page - also the other kind -
 * is a `rebuildPageContainer`; everything else goes through
 * `textContainerUpgrade` and `updateImageRawData`, and only when something
 * changed: on real hardware a rebuild costs seconds and discards input.
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

/** The cockpit's four image containers; the input container sits under them. */
export const COCKPIT_TILES = tileSlots(21, "shift");
const COCKPIT_INPUT_ID = 20;

export interface RenderResult {
  readonly ok: boolean;
  /** Present when page creation failed, for the caller to surface or log. */
  readonly reason?: string;
}

/** One item of the glasses' side menu (id > 0, label at most 32 bytes). QIS v1.2; off while the app's SIDE_MENU is false. */
export interface MenuItemSpec { readonly id: number; readonly label: string }
export interface MenuSpec {
  /** Changes exactly when the glasses need a different menu (=> one rebuild). */
  readonly key: string;
  readonly items: readonly MenuItemSpec[];
}

/** The side menu as the SDK wants it (`menuObject` of the page), as in Babel Glass. */
export function buildMenu(menu: MenuSpec | null): MenuContainerProperty | undefined {
  if (menu === null || menu.items.length === 0) return undefined;
  return new MenuContainerProperty({
    menuItems: menu.items.map((item) => new MenuItemProperty({ itemName: item.label, itemID: item.id })),
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

export function buildTextPage(view: ClockView, menu: MenuSpec | null = null): CreateStartUpPageContainer {
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

export function buildCockpitPage(menu: MenuSpec | null = null): CreateStartUpPageContainer {
  const menuObject = buildMenu(menu);
  return new CreateStartUpPageContainer({
    ...(menuObject === undefined ? {} : { menuObject }),
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

/** Bridges that already have their one start-up page. */
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

/**
 * Every call into the glasses is bounded. Draws run one after another, so one
 * answer that never comes (a Bluetooth write lost on the way) used to freeze
 * the display for good on its last page. A call that times out counts as
 * failed: the caller marks the page broken and the next draw rebuilds it.
 */
export const PAGE_CALL_MS = 8_000;
export const TEXT_CALL_MS = 5_000;
export const IMAGE_CALL_MS = 10_000;

export function bounded<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: no answer from the glasses within ${ms} ms`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Puts a page on the glasses: created once per bridge, every later call
 * (after a failure, a reconnect, a return to the foreground or the switch
 * between text page and cockpit) rebuilds it. A second
 * `createStartUpPageContainer` leaves the glasses deaf to input (measured on
 * real glasses with OpenGlance 0.5.1). The caller resets the tile sender
 * afterwards: a new page starts with blank image containers.
 */
async function installPage(bridge: EvenAppBridge, page: CreateStartUpPageContainer): Promise<RenderResult> {
  sentLength.clear();
  if (started.has(bridge)) {
    try {
      const ok = await bounded(bridge.rebuildPageContainer(new RebuildPageContainer({ ...page })), PAGE_CALL_MS, "rebuild");
      return ok ? { ok: true } : { ok: false, reason: "rebuild refused" };
    } catch (error) {
      return { ok: false, reason: errorMessage(error) };
    }
  }
  try {
    // The first page needs one rebuild call before the creation (it registers
    // input on real glasses); its result is ignored.
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

export const createPage = (bridge: EvenAppBridge, view: ClockView, menu: MenuSpec | null = null): Promise<RenderResult> =>
  installPage(bridge, buildTextPage(view, menu));
export const createCockpitPage = (bridge: EvenAppBridge, menu: MenuSpec | null = null): Promise<RenderResult> =>
  installPage(bridge, buildCockpitPage(menu));

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

/** Fast path: change the text of the three containers in place, only those that changed. */
export async function updatePage(bridge: EvenAppBridge, view: ClockView, previous: ClockView | null = null): Promise<RenderResult> {
  const updates: Array<[ContainerSpec, string, string | undefined]> = [
    [CONTAINER.header, view.header, previous?.header],
    [CONTAINER.body, view.body.join("\n"), previous?.body.join("\n")],
    [CONTAINER.footer, view.footer, previous?.footer],
  ];

  try {
    for (const [spec, content, before] of updates) {
      if (before !== undefined && before === content) continue;
      await bounded(bridge.textContainerUpgrade(new TextContainerUpgrade({
        containerID: spec.id,
        containerName: spec.name,
        ...guarded(spec.id, content),
      })), TEXT_CALL_MS, "text " + spec.name);
    }
    return { ok: true };
  } catch (error) {
    // Unknown what the glasses show now: forget what was sent.
    sentLength.clear();
    return { ok: false, reason: errorMessage(error) };
  }
}

/** One image tile to the glasses; resolves true on success. */
export async function sendTile(bridge: EvenAppBridge, slot: TileSlot, imageData: Uint8Array): Promise<boolean> {
  const result = await bounded(bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: slot.id, containerName: slot.name, imageData })), IMAGE_CALL_MS, "image " + slot.name);
  return result === ImageRawDataUpdateResult.success;
}

/**
 * The tile sender's write function. It writes only while `allowed()` says so:
 * not while the system exit dialog may be on screen (a page call could cover
 * it) and not after the cockpit page has been left (its containers are gone).
 * A refused tile counts as failed and is tried again with the next frame.
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
