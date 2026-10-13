import {
  CreateStartUpPageContainer,
  ImageContainerProperty,
  ImageRawDataUpdate,
  ImageRawDataUpdateResult,
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
import { MAP_TILES, PLATE, TILE_HEIGHT, TILE_WIDTH } from "../overview/camera";

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
 *  - "text", for everything without a turn to show: three text containers.
 *
 * Changing from one page to another rebuilds the page, which on hardware takes
 * a moment and swallows input meanwhile: it happens when the user swipes or a
 * route starts or ends, never for an update. Updates go through
 * `textContainerUpgrade` and `updateImageRawData` and touch only what changed.
 */

export const SCREEN_WIDTH = 576;
export const SCREEN_HEIGHT = 288;

export type PageKind = "text" | "turns" | "overview";

interface Box { readonly x: number; readonly y: number; readonly width: number; readonly height: number; }
interface ContainerSpec {
  readonly id: number;
  readonly name: string;
}

const HEADER: ContainerSpec = { id: 1, name: "header" };
const BODY: ContainerSpec = { id: 2, name: "body" };
const FOOTER: ContainerSpec = { id: 3, name: "footer" };

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

/** Map page: image ids 4…7, the info text over the plate on the top left. */
const MAP_IMAGES = MAP_TILES.map((tile, index) => ({ id: 4 + index, name: tile.name, x: tile.x, y: tile.y, width: TILE_WIDTH, height: TILE_HEIGHT }));
const MAP_BODY: Box = { x: 0, y: 0, width: PLATE.width, height: PLATE.height };

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

export function buildPage(view: NavView, kind: PageKind = "text"): CreateStartUpPageContainer {
  // Images sit below the text (lower z), so the text may overlay them.
  if (kind === "turns") {
    return new CreateStartUpPageContainer({
      containerTotalNum: 6,
      // Exactly one container may capture input; the text line owns it.
      textObject: [
        textBox(BODY, TURN_BODY, bodyText(view, kind), 5, true),
        textBox(FOOTER, TEXT_BOX.footer, view.footer, 6, false),
      ],
      imageObject: [imageBox(ARROW, 1), imageBox(DISTANCE, 2), imageBox(STREET_LEFT, 3), imageBox(STREET_RIGHT, 4)],
    });
  }
  if (kind === "overview") {
    return new CreateStartUpPageContainer({
      containerTotalNum: 5,
      textObject: [textBox(BODY, MAP_BODY, bodyText(view, kind), 5, true)],
      imageObject: MAP_IMAGES.map((image, index) => imageBox(image, index + 1)),
    });
  }
  return new CreateStartUpPageContainer({
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

function guarded(specId: number, content: string): { content: string; contentLength: number } {
  const text = (content || " ").slice(0, TEXT_HARD_CAP);
  const length = Math.max(sentLength.get(specId) ?? 0, text.length);
  sentLength.set(specId, text.length);
  return { content: text, contentLength: length };
}

/** `createStartUpPageContainer` works once per run; every later page is a rebuild. */
const started = new WeakSet<object>();

/**
 * Puts a page on the glasses. The first page is created; every later one
 * replaces it with `rebuildPageContainer` (a second creation is refused as
 * "invalid" - which once left the map blank for good). If a rebuild is
 * refused, creating is tried as the last resort.
 */
async function installPage(bridge: EvenAppBridge, page: CreateStartUpPageContainer): Promise<RenderResult> {
  sentLength.clear();
  // Same order as Quiet Hub, which takes input on real glasses: create exactly
  // once, then only rebuild. A rebuild before the first creation, or a second
  // creation, can leave the page without its input route ("tap does nothing,
  // exit does nothing").
  if (!started.has(bridge)) {
    try {
      const result = await bridge.createStartUpPageContainer(page);
      if (result === StartUpPageCreateResult.success) { started.add(bridge); return { ok: true }; }
      return { ok: false, reason: describeCreateResult(result) };
    } catch (error) {
      return { ok: false, reason: errorMessage(error) };
    }
  }
  try {
    const ok = await bridge.rebuildPageContainer(new RebuildPageContainer({ ...page }));
    return ok ? { ok: true } : { ok: false, reason: "rebuild refused" };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

/** Creates or replaces the page and sends all the images that go with it. */
export async function showPage(bridge: EvenAppBridge, view: NavView, kind: PageKind, images: PageImages = {}): Promise<RenderResult> {
  const installed = await installPage(bridge, buildPage(view, kind));
  return installed.ok ? updateImages(bridge, images) : installed;
}

/** Fast path: text in place, and only the images that changed - each one crosses Bluetooth. */
export async function updatePage(bridge: EvenAppBridge, view: NavView, kind: PageKind, images: PageImages = {}): Promise<RenderResult> {
  const updated = await updateTexts(bridge, view, kind);
  return updated.ok ? updateImages(bridge, images) : updated;
}

async function updateTexts(bridge: EvenAppBridge, view: NavView, kind: PageKind): Promise<RenderResult> {
  const updates: Array<[ContainerSpec, string]> = kind === "text"
    ? [[HEADER, view.header], [BODY, bodyText(view, kind)], [FOOTER, view.footer]]
    : kind === "turns"
      ? [[BODY, bodyText(view, kind)], [FOOTER, view.footer]]
      : [[BODY, bodyText(view, kind)]];
  try {
    for (const [spec, content] of updates) {
      await bridge.textContainerUpgrade(new TextContainerUpgrade({
        containerID: spec.id,
        containerName: spec.name,
        ...guarded(spec.id, content),
      }));
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

async function updateImages(bridge: EvenAppBridge, images: PageImages): Promise<RenderResult> {
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
    const result = await bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: target.id, containerName: target.name, imageData }));
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
