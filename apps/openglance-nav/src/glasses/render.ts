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
import type { NavView } from "./view";
import { renderPixelIcon, type PixelIcon } from "./pixel";
import { CARD_HEIGHT, CARD_WIDTH, renderTurnCardPng, type TurnCard } from "./turncard";
import { renderStreetPngs, STREET_HALF, STREET_HEIGHT } from "./street";
import { centre, HUD_BOXES, HUD_CHAR_PX, HUD_IMAGES, HUD_WIDTH, type SpeedBig } from "./hud";
import { diag } from "../diag/diag";
import { hudArrowPngs, hudSpeedPng, limitSignPng } from "./hud-images";
import type { ManeuverType } from "../routing/provider";
import { MAP_HEIGHT, MAP_TILES, PLATE, SPEED_PLATE, TILE_HEIGHT, TILE_WIDTH } from "../overview/camera";

/**
 * Renders the navigation onto the G2.
 *
 * Three pages exist on the 576 x 288 display, none with more than four image
 * containers (each at most 288 x 144) and exactly one that captures input:
 *
 *  - "turns", the driving view: a big arrow (144 x 144) and the distance with
 *    its approach bar (288 x 144) side by side, the road name as two image
 *    halves across the full width, a line of small text and the footer;
 *  - "overview", the map: four images covering the whole display, with one
 *    short line of text on the top left;
 *  - "text", for everything without a turn to show: three text containers;
 *  - "peaks", the compass band of the peaks nearby: two images across the
 *    upper half, three lines of text and the footer below.
 *
 * Changing from one page to another rebuilds the page, which on hardware takes
 * a moment and swallows input meanwhile: it happens when the user swipes or a
 * route starts or ends, never for an update. Updates go through
 * `textContainerUpgrade` and `updateImageRawData` and touch only what changed.
 */

export const SCREEN_WIDTH = 576;
export const SCREEN_HEIGHT = 288;

export type PageKind = "text" | "turns" | "overview" | "peaks" | "hud";

interface Box { readonly x: number; readonly y: number; readonly width: number; readonly height: number; }
interface ContainerSpec {
  readonly id: number;
  readonly name: string;
}

const HEADER: ContainerSpec = { id: 1, name: "header" };
const BODY: ContainerSpec = { id: 2, name: "body" };
const FOOTER: ContainerSpec = { id: 3, name: "footer" };
/** Speed and limit: a narrow column left of the arrow (turns), a line on a plate at the bottom left (map). */
const SPEED: ContainerSpec = { id: 8, name: "speed" };

const TEXT_BOX: Readonly<Record<"header" | "body" | "footer", Box>> = {
  header: { x: 0, y: 0, width: SCREEN_WIDTH, height: 32 },
  body: { x: 0, y: 36, width: SCREEN_WIDTH, height: 214 },
  footer: { x: 0, y: 252, width: SCREEN_WIDTH, height: 34 },
};

/**
 * Turn page: arrow and distance side by side at the top (together 448 px wide,
 * centred), the road name as two halves below, one line of small text, footer.
 */
const ARROW = { id: 4, name: "pixel-icon", x: 64, y: 4, width: 144, height: 144 } as const;
const DISTANCE = { id: 5, name: "turn-distance", x: 224, y: 4, width: CARD_WIDTH, height: CARD_HEIGHT } as const;
const STREET_LEFT = { id: 6, name: "street-left", x: 0, y: 152, width: STREET_HALF, height: STREET_HEIGHT } as const;
const STREET_RIGHT = { id: 7, name: "street-right", x: STREET_HALF, y: 152, width: STREET_HALF, height: STREET_HEIGHT } as const;
const TURN_BODY: Box = { x: 0, y: 212, width: SCREEN_WIDTH, height: 38 };
/** The free strip left of the arrow (the arrow starts at x = 64). */
const TURN_SPEED: Box = { x: 0, y: 4, width: ARROW.x, height: 144 };

/** Map page: image ids 4…7, the info text over the plate on the top left. */
const MAP_IMAGES = MAP_TILES.map((tile, index) => ({ id: 4 + index, name: tile.name, x: tile.x, y: tile.y, width: TILE_WIDTH, height: TILE_HEIGHT }));
const MAP_BODY: Box = { x: 0, y: 0, width: PLATE.width, height: PLATE.height };
const MAP_SPEED: Box = { x: 0, y: MAP_HEIGHT - SPEED_PLATE.height, width: SPEED_PLATE.width, height: SPEED_PLATE.height };

/** Peaks page: the compass band as two halves, text below. */
const BAND_IMAGES = [
  { id: 4, name: "band-left", x: 0, y: 0, width: 288, height: 144 },
  { id: 5, name: "band-right", x: 288, y: 0, width: 288, height: 144 },
] as const;
const PEAKS_BODY: Box = { x: 0, y: 148, width: SCREEN_WIDTH, height: 102 };

/**
 * HUD page (driving, layout "neu"): four images - the arrow as two halves on
 * the right, the limit sign and the large speed on the left - and four text
 * boxes: the input catcher behind everything (see CAPTURE), status top left,
 * distance and street as two lines under the arrow, and the alert line.
 *
 * Eight containers in all: on the real glasses (0.17.9, 15.10.) the page with
 * ten (six texts) was refused on every rebuild, as the nine-container HUD had
 * hung on 14.10.; the turn page with eight and the map with seven come up.
 * So "too fast" / "stop?" (once a box of its own) share the alert line: it
 * shows them when no alert is up - the speed picture turns inverted when too
 * fast anyway, and an armed stop already owns the alert line.
 */
const HUD_TEXT = {
  status: { id: 1, name: "hud-status" },
  alert: { id: 3, name: "hud-alert" },
  turn: { id: 9, name: "hud-turn" },
} as const;
/** Distance and street, two lines under the arrow; the distance starts where the arrow does. */
export const HUD_TURN_BOX = { x: HUD_BOXES.street.x, y: HUD_BOXES.distance.y, width: HUD_BOXES.street.width, height: 56 } as const;
const HUD_BOX_OF: Record<keyof typeof HUD_TEXT, { x: number; y: number; width: number; height: number }> = {
  status: HUD_BOXES.status,
  alert: HUD_BOXES.alert,
  turn: HUD_TURN_BOX,
};
/** Spaces that move the distance from the street's left edge to the arrow's. */
const TURN_INDENT = " ".repeat(Math.max(0, Math.round((HUD_BOXES.distance.x - HUD_BOXES.street.x) / HUD_CHAR_PX)));
// Names at most 12 characters: "hud-arrow-bottom" (16) was the one name at the docs' "max 16 chars"
// limit when the glasses refused the HUD page (0.17.9/0.17.10); every accepted page had names of 13 or fewer.
const HUD_ARROW_TOP = { id: 4, name: "hud-arr-top", ...HUD_IMAGES.arrowTop } as const;
const HUD_ARROW_BOTTOM = { id: 5, name: "hud-arr-bot", ...HUD_IMAGES.arrowBottom } as const;
const HUD_LIMIT = { id: 6, name: "hud-limit", ...HUD_IMAGES.limit } as const;
const HUD_SPEED = { id: 7, name: "hud-speed", ...HUD_IMAGES.speed } as const;

/** The HUD's text per box. */
function hudTexts(view: NavView): Array<[ContainerSpec, string]> {
  const hud = view.hud;
  const alert = hud ? (hud.alert.trim() ? hud.alert : hud.center.trim() ? centre(hud.center.trim(), HUD_WIDTH.alert) : "") : view.footer;
  const turn = hud ? [hud.distance ? TURN_INDENT + hud.distance : "", hud.street].join("\n") : "";
  // Most urgent first: an update walks this list, one Bluetooth write per changed box.
  return [
    [HUD_TEXT.turn, turn],
    [HUD_TEXT.alert, alert],
    [HUD_TEXT.status, hud?.status ?? view.header],
  ];
}

/** Images of the HUD page to send; a field left out is unchanged on the glasses. */
export interface HudImages {
  /** The arrow's manoeuvre; null blanks it. */
  readonly arrow?: ManeuverType | null;
  /** The limit on the sign; null blanks it. */
  readonly limit?: number | null;
  /** The large speed digits; null blanks them. */
  readonly speed?: SpeedBig | null;
}

/** Images of the turn page to send; a field left out is unchanged on the glasses. */
export interface TurnImages {
  readonly icon?: PixelIcon;
  /** The card to show; null blanks it. */
  readonly card?: TurnCard | null;
  /** The road name; "" blanks it. */
  readonly road?: string;
}

/** Images to send: for the turn page, or the four map tiles (null = unchanged). */
export interface PageImages {
  readonly turn?: TurnImages;
  readonly map?: readonly (Uint8Array | null)[];
  /** The two halves of the peaks band (null = unchanged). */
  readonly band?: readonly (Uint8Array | null)[];
  readonly hud?: HudImages;
}

export interface RenderResult {
  readonly ok: boolean;
  /** Present when page creation failed, for the caller to surface or log. */
  readonly reason?: string;
}

/** What the text containers of a page show: the road is an image on the turn page, so the text starts below it. */
export function bodyText(view: NavView, kind: PageKind): string {
  if (kind === "turns") return view.body.slice(1).join("\n");
  if (kind === "overview") return view.body[0] ?? "";
  return view.body.join("\n");
}

function textBox(spec: ContainerSpec, box: Box, content: string, z: number, capture: boolean): TextContainerProperty {
  return new TextContainerProperty({
    containerID: spec.id,
    containerName: spec.name,
    xPosition: box.x,
    yPosition: box.y,
    width: box.width,
    height: box.height,
    paddingLength: 4,
    zOrderIndex: z,
    isEventCapture: capture ? 1 : 0,
    content: content || " ",
  });
}

function imageBox(image: { id: number; name: string } & Box, z: number): ImageContainerProperty {
  return new ImageContainerProperty({
    containerID: image.id, containerName: image.name,
    xPosition: image.x, yPosition: image.y, width: image.width, height: image.height, zOrderIndex: z,
  });
}

/** The glasses' side menu (QIS v1.2, `menuObject`): ids are never 0, labels at most 32 bytes, at most 10 entries. */
export interface MenuSpec {
  /** Changes exactly when the glasses need another menu (one page rebuild). */
  readonly key: string;
  readonly items: readonly { readonly id: number; readonly label: string }[];
}

function menuProps(menu: MenuSpec | null): { menuObject?: MenuContainerProperty } {
  if (menu === null || menu.items.length === 0) return {};
  return { menuObject: new MenuContainerProperty({ menuItems: menu.items.map((item) => new MenuItemProperty({ itemName: item.label, itemID: item.id })) }) };
}

/**
 * The input catcher of the image pages: an empty full-screen text box behind
 * everything. Measured on hardware (0.17.6): when the capturing box holds more
 * text than fits, the firmware scrolls that text itself and the app never sees
 * the swipe - the driving view's small text line did exactly that. The Even
 * docs give this pattern for image-first apps ("a full-screen text container
 * with content ' ' and isEventCapture: 1 behind the image container"); a single
 * space can never overflow, so every swipe and tap reaches the app.
 */
export const CAPTURE: ContainerSpec = { id: 12, name: "capture" };
const CAPTURE_BOX: Box = { x: 0, y: 0, width: SCREEN_WIDTH, height: SCREEN_HEIGHT };

function captureBox(): TextContainerProperty {
  return textBox(CAPTURE, CAPTURE_BOX, " ", 1, true);
}

export function buildPage(view: NavView, kind: PageKind = "text", menu: MenuSpec | null = null): CreateStartUpPageContainer {
  // Images sit below the text (lower z), so the text may overlay them; the
  // input catcher (z 1) lies below everything.
  if (kind === "turns") {
    return new CreateStartUpPageContainer({
      ...menuProps(menu),
      containerTotalNum: 8,
      textObject: [
        captureBox(),
        textBox(BODY, TURN_BODY, bodyText(view, kind), 6, false),
        textBox(FOOTER, TEXT_BOX.footer, view.footer, 7, false),
        textBox(SPEED, TURN_SPEED, view.speed ?? "", 8, false),
      ],
      imageObject: [imageBox(ARROW, 2), imageBox(DISTANCE, 3), imageBox(STREET_LEFT, 4), imageBox(STREET_RIGHT, 5)],
    });
  }
  if (kind === "hud") {
    const texts = hudTexts(view);
    return new CreateStartUpPageContainer({
      ...menuProps(menu),
      containerTotalNum: texts.length + 5,
      textObject: [
        captureBox(),
        ...texts.map(([spec, content], index) => {
          const key = (Object.keys(HUD_TEXT) as (keyof typeof HUD_TEXT)[]).find((k) => HUD_TEXT[k].id === spec.id)!;
          return textBox(spec, HUD_BOX_OF[key], content, 6 + index, false);
        }),
      ],
      imageObject: [imageBox(HUD_ARROW_TOP, 2), imageBox(HUD_ARROW_BOTTOM, 3), imageBox(HUD_LIMIT, 4), imageBox(HUD_SPEED, 5)],
    });
  }
  if (kind === "peaks") {
    return new CreateStartUpPageContainer({
      ...menuProps(menu),
      containerTotalNum: 5,
      textObject: [captureBox(), textBox(BODY, PEAKS_BODY, bodyText(view, kind), 4, false), textBox(FOOTER, TEXT_BOX.footer, view.footer, 5, false)],
      imageObject: BAND_IMAGES.map((image, index) => imageBox(image, index + 2)),
    });
  }
  if (kind === "overview") {
    return new CreateStartUpPageContainer({
      ...menuProps(menu),
      containerTotalNum: 7,
      textObject: [captureBox(), textBox(BODY, MAP_BODY, bodyText(view, kind), 6, false), textBox(SPEED, MAP_SPEED, view.speed ?? "", 7, false)],
      imageObject: MAP_IMAGES.map((image, index) => imageBox(image, index + 2)),
    });
  }
  // The text page keeps its body as the input box: on the list and help the
  // firmware scrolling a long text is wanted, and a short one reports swipes.
  return new CreateStartUpPageContainer({
      ...menuProps(menu),
    containerTotalNum: 3,
    textObject: [
      textBox(HEADER, TEXT_BOX.header, view.header, 1, false),
      textBox(BODY, TEXT_BOX.body, bodyText(view, kind), 2, true),
      textBox(FOOTER, TEXT_BOX.footer, view.footer, 3, false),
    ],
    imageObject: [],
  });
}

/**
 * Ghost-text guard for `textContainerUpgrade`: the lens blanks exactly
 * `contentLength` characters, so it must always be at least the length the
 * container held before, or leftovers of the old text stay visible. Text is
 * additionally capped at the ~900-character firmware hard limit.
 */
const TEXT_HARD_CAP = 900;
const sentLength = new Map<number, number>();
/** What each text box of the current page holds; an unchanged box is not written again. */
const sentContent = new Map<number, string>();

function guarded(specId: number, content: string): { content: string; contentLength: number } {
  const text = (content || " ").slice(0, TEXT_HARD_CAP);
  const length = Math.max(sentLength.get(specId) ?? 0, text.length);
  sentLength.set(specId, text.length);
  return { content: text, contentLength: length };
}

/** `createStartUpPageContainer` works once per run; every later page is a rebuild. */
const started = new WeakSet<object>();

/**
 * Measured on hardware (0.17.5, 114 km route): after one text write answered
 * `false`, the glasses refused EVERY later rebuild, every 5 s, for good - the
 * display froze on "Route wird berechnet". After this many refusals in a row
 * the next page goes the way of the very first one again (rebuild + create).
 */
export const REBUILD_REFUSED_RECREATE = 3;
const refusedInRow = new WeakMap<object, number>();

/**
 * Every call into the glasses is bounded. Draws run one after another, so a
 * single answer that never comes (a Bluetooth write lost on the way) used to
 * freeze the display for good on whatever it showed last - "Route wird
 * berechnet…" while the route had long arrived. A call that times out counts
 * as failed: the caller marks the page broken and the next draw rebuilds it.
 */
export const PAGE_CALL_MS = 8_000;
export const TEXT_CALL_MS = 5_000;
export const IMAGE_CALL_MS = 10_000;

function bounded<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const begun = Date.now();
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: no answer from the glasses within ${ms} ms`)), ms); });
  return Promise.race([promise, timeout]).then(
    (value) => { diag("bridge", { what, ms: Date.now() - begun, ok: true, res: typeof value === "object" ? "obj" : String(value) }); return value; },
    (error: unknown) => { diag("bridge", { what, ms: Date.now() - begun, ok: false, res: error instanceof Error ? error.message : String(error) }); throw error; },
  ).finally(() => clearTimeout(timer));
}

/**
 * Puts a page on the glasses. The first page is created; every later one
 * replaces it with `rebuildPageContainer` (a second creation is refused as
 * "invalid" - which once left the map blank for good). If a rebuild is
 * refused, creating is tried as the last resort.
 */
async function installPage(bridge: EvenAppBridge, page: CreateStartUpPageContainer): Promise<RenderResult> {
  sentLength.clear();
  sentContent.clear();
  // One ignored rebuild before the first creation (measured on real glasses),
  // then create exactly once, afterwards only rebuild. A second creation can
  // leave the page without its input route ("tap does nothing, exit does nothing").
  if (!started.has(bridge)) {
    // Measured on real glasses: the very first page needs one rebuild call
    // before the creation (result ignored), or taps are never delivered.
    try { await bounded(bridge.rebuildPageContainer(new RebuildPageContainer({ ...page })), PAGE_CALL_MS, "rebuild"); } catch { /* expected before the first page */ }
    try {
      const result = await bounded(bridge.createStartUpPageContainer(page), PAGE_CALL_MS, "create page");
      if (result === StartUpPageCreateResult.success) { started.add(bridge); return { ok: true }; }
      return { ok: false, reason: describeCreateResult(result) };
    } catch (error) {
      return { ok: false, reason: errorMessage(error) };
    }
  }
  try {
    const ok = await bounded(bridge.rebuildPageContainer(new RebuildPageContainer({ ...page })), PAGE_CALL_MS, "rebuild");
    if (ok) { refusedInRow.set(bridge, 0); return { ok: true }; }
    const refused = (refusedInRow.get(bridge) ?? 0) + 1;
    refusedInRow.set(bridge, refused);
    if (refused >= REBUILD_REFUSED_RECREATE) {
      // Stuck: start over as on the first page (the next draw creates again).
      started.delete(bridge);
      refusedInRow.set(bridge, 0);
      diag("page.recover", { refused });
    }
    return { ok: false, reason: "rebuild refused" };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

/** The next page goes the way of the very first one again (rebuild + create), e.g. after the system's exit dialog. */
export function forgetPage(bridge: EvenAppBridge): void {
  started.delete(bridge);
  refusedInRow.set(bridge, 0);
}

/** Creates or replaces the page and sends all the images that go with it. */
export async function showPage(bridge: EvenAppBridge, view: NavView, kind: PageKind, images: PageImages = {}, menu: MenuSpec | null = null): Promise<RenderResult> {
  const page = buildPage(view, kind, menu);
  const installed = await installPage(bridge, page);
  if (!installed.ok) return installed;
  // The new page already shows its texts: remember them, so the next update writes only what changes.
  for (const text of page.textObject ?? []) {
    if (text.containerID === undefined) continue;
    const content = (text.content || " ").slice(0, TEXT_HARD_CAP);
    sentContent.set(text.containerID, content);
    sentLength.set(text.containerID, content.length);
  }
  return updateImages(bridge, images);
}

/** Fast path: text in place, and only the images that changed - each one crosses Bluetooth. */
export async function updatePage(bridge: EvenAppBridge, view: NavView, kind: PageKind, images: PageImages = {}): Promise<RenderResult> {
  const updated = await updateTexts(bridge, view, kind);
  return updated.ok ? updateImages(bridge, images) : updated;
}

async function updateTexts(bridge: EvenAppBridge, view: NavView, kind: PageKind): Promise<RenderResult> {
  const updates: Array<[ContainerSpec, string]> = kind === "hud"
    ? hudTexts(view)
    : kind === "text"
    ? [[HEADER, view.header], [BODY, bodyText(view, kind)], [FOOTER, view.footer]]
    : kind === "peaks"
      ? [[BODY, bodyText(view, kind)], [FOOTER, view.footer]]
    : kind === "turns"
      ? [[BODY, bodyText(view, kind)], [FOOTER, view.footer], [SPEED, view.speed ?? ""]]
      : [[BODY, bodyText(view, kind)], [SPEED, view.speed ?? ""]];
  try {
    for (const [spec, content] of updates) {
      // Each write is a Bluetooth round trip: a box that already shows this text is skipped.
      const text = (content || " ").slice(0, TEXT_HARD_CAP);
      if (sentContent.get(spec.id) === text) continue;
      sentContent.set(spec.id, text);
      await bounded(bridge.textContainerUpgrade(new TextContainerUpgrade({
        containerID: spec.id,
        containerName: spec.name,
        ...guarded(spec.id, content),
      })), TEXT_CALL_MS, "text " + spec.name);
    }
    return { ok: true };
  } catch (error) {
    // Unknown what the glasses show now: write every box again next time.
    sentContent.clear();
    sentLength.clear();
    return { ok: false, reason: errorMessage(error) };
  }
}

async function updateImages(bridge: EvenAppBridge, images: PageImages): Promise<RenderResult> {
  const hud = images.hud;
  if (hud) {
    if (hud.arrow !== undefined) {
      const halves = hudArrowPngs(hud.arrow ?? undefined);
      for (const [target, index] of [[HUD_ARROW_TOP, 0], [HUD_ARROW_BOTTOM, 1]] as const) {
        const sent = await sendImage(bridge, target, async () => (await halves)[index]);
        if (!sent.ok) return sent;
      }
    }
    if (hud.limit !== undefined) {
      const limit = hud.limit;
      const sent = await sendImage(bridge, HUD_LIMIT, () => limitSignPng(limit));
      if (!sent.ok) return sent;
    }
    if (hud.speed !== undefined) {
      const speed = hud.speed;
      const sent = await sendImage(bridge, HUD_SPEED, () => hudSpeedPng(speed));
      if (!sent.ok) return sent;
    }
  }
  const turn = images.turn;
  if (turn) {
    if (turn.icon) {
      const icon = turn.icon;
      const sent = await sendImage(bridge, ARROW, () => renderPixelIcon(icon));
      if (!sent.ok) return sent;
    }
    if (turn.card !== undefined) {
      const card = turn.card;
      const sent = await sendImage(bridge, DISTANCE, () => renderTurnCardPng(card));
      if (!sent.ok) return sent;
    }
    if (turn.road !== undefined) {
      const road = turn.road;
      let halves: Promise<[Uint8Array, Uint8Array]> | null = null;
      const both = (): Promise<[Uint8Array, Uint8Array]> => (halves ??= renderStreetPngs(road));
      for (const [target, index] of [[STREET_LEFT, 0], [STREET_RIGHT, 1]] as const) {
        const sent = await sendImage(bridge, target, async () => (await both())[index]);
        if (!sent.ok) return sent;
      }
    }
  }
  const band = images.band;
  if (band) {
    for (let i = 0; i < BAND_IMAGES.length; i++) {
      const png = band[i];
      if (!png) continue;
      const sent = await sendImage(bridge, BAND_IMAGES[i]!, async () => png);
      if (!sent.ok) return sent;
    }
  }
  const map = images.map;
  if (map) {
    for (let i = 0; i < MAP_IMAGES.length; i++) {
      const png = map[i];
      if (!png) continue;
      const target = MAP_IMAGES[i]!;
      const sent = await sendImage(bridge, target, async () => png);
      if (!sent.ok) return sent;
    }
  }
  return { ok: true };
}

async function sendImage(bridge: EvenAppBridge, target: { readonly id: number; readonly name: string }, render: () => Promise<Uint8Array>): Promise<RenderResult> {
  try {
    const imageData = await render();
    const result = await bounded(bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: target.id, containerName: target.name, imageData })), IMAGE_CALL_MS, "image " + target.name);
    return result === ImageRawDataUpdateResult.success ? { ok: true } : { ok: false, reason: `image:${String(result)}` };
  } catch (error) { return { ok: false, reason: errorMessage(error) }; }
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
