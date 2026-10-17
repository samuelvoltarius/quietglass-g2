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
import type { Bitmap } from "./gfx";
import type { Frames, Layout, PageView } from "./views";
import { ImageLink, imageContainer, bounded, PAGE_CALL_MS, TEXT_CALL_MS, type ImageSlot } from "./images";
export { PAGE_CALL_MS, TEXT_CALL_MS, IMAGE_CALL_MS } from "./images";
import { BIG_HEIGHT, CHARGE_BAR_HEIGHT, CHARGE_TOP_HEIGHT, HALF, ICON_HEIGHT, ICON_WIDTH, STATUS_HEIGHT } from "./pics";

/**
 * Puts a page view onto the G2 (576 x 288).
 *
 *  - drive:  speed (288 x 144) left, battery + power bar (288 x 144) right, two rows below
 *  - charge: charge % and kW (288 x 100 each), the battery bar (288 x 36) centred, two rows
 *  - status: tyres and lock (288 x 104 each), three rows below
 *  - plain:  full-width body (7 rows): control list, warnings, waiting
 *
 * Every layout: header beside the car sign (top right, 64 x 30), footer, body
 * on the full width. At most four image containers. The first page on a bridge
 * is one ignored `rebuildPageContainer` and then exactly one
 * `createStartUpPageContainer`; every later layout change is a rebuild;
 * anything else is `textContainerUpgrade` / `updateImageRawData`, and only
 * when it changed.
 */

const NL = String.fromCharCode(10);
export const SCREEN_WIDTH = 576;
export const SCREEN_HEIGHT = 288;
const TOP = 34;

interface TextSpec {
  readonly id: number;
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const HEADER: TextSpec = { id: 1, name: "header", x: 0, y: 0, width: SCREEN_WIDTH - ICON_WIDTH, height: 32 };
const FOOTER: TextSpec = { id: 3, name: "footer", x: 0, y: 252, width: SCREEN_WIDTH, height: 34 };
const bodyAt = (y: number): TextSpec => ({ id: 2, name: "body", x: 0, y, width: SCREEN_WIDTH, height: 252 - y });
const BODY: Readonly<Record<Layout, TextSpec>> = {
  plain: bodyAt(36),
  drive: bodyAt(TOP + BIG_HEIGHT + 2),
  charge: bodyAt(TOP + CHARGE_TOP_HEIGHT + 4 + CHARGE_BAR_HEIGHT + 2),
  status: bodyAt(TOP + STATUS_HEIGHT + 2),
};

export const ICON: ImageSlot = { id: 4, name: "car", x: SCREEN_WIDTH - ICON_WIDTH, y: 1, width: ICON_WIDTH, height: ICON_HEIGHT, z: 4 };

type SlotKey = "a" | "b" | "c";
const SLOTS: Readonly<Record<Layout, ReadonlyArray<readonly [SlotKey, ImageSlot]>>> = {
  plain: [],
  drive: [
    ["a", { id: 5, name: "speed", x: 0, y: TOP, width: HALF, height: BIG_HEIGHT, z: 5 }],
    ["b", { id: 6, name: "energy", x: HALF, y: TOP, width: HALF, height: BIG_HEIGHT, z: 6 }],
  ],
  charge: [
    ["a", { id: 5, name: "soc", x: 0, y: TOP, width: HALF, height: CHARGE_TOP_HEIGHT, z: 5 }],
    ["b", { id: 6, name: "kw", x: HALF, y: TOP, width: HALF, height: CHARGE_TOP_HEIGHT, z: 6 }],
    ["c", { id: 7, name: "bar", x: (SCREEN_WIDTH - HALF) / 2, y: TOP + CHARGE_TOP_HEIGHT + 4, width: HALF, height: CHARGE_BAR_HEIGHT, z: 7 }],
  ],
  status: [
    ["a", { id: 5, name: "tyres", x: 0, y: TOP, width: HALF, height: STATUS_HEIGHT, z: 5 }],
    ["b", { id: 6, name: "lock", x: HALF, y: TOP, width: HALF, height: STATUS_HEIGHT, z: 6 }],
  ],
};

export function slotsFor(layout: Layout): ImageSlot[] {
  return [ICON, ...SLOTS[layout].map(([, slot]) => slot)];
}

export function bodySpec(layout: Layout): TextSpec {
  return BODY[layout];
}

export interface RenderResult {
  readonly ok: boolean;
  readonly reason?: string;
}

const link = new ImageLink();

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
  const texts = [
    text(HEADER, view.header, 1, false),
    // Exactly one container captures input; the body owns it.
    text(BODY[view.layout], view.body.join(NL), 2, true),
    text(FOOTER, view.footer, 3, false),
  ];
  const images = slotsFor(view.layout).map(imageContainer);
  return new CreateStartUpPageContainer({ ...(menuObject === undefined ? {} : { menuObject }), containerTotalNum: texts.length + images.length, textObject: texts, imageObject: images });
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
export const renderStats = { creates: 0, rebuilds: 0, upgrades: 0, images: () => link.sentCount };

/** First page on this bridge: one ignored rebuild, then exactly one create. Afterwards: rebuild. */
export async function installPage(bridge: EvenAppBridge, view: PageView, frames: Frames, menu: MenuSpec | null = null): Promise<RenderResult> {
  // A rebuild without the menu would clear it, so every page carries it again.
  const page = buildPage(view, menu);
  sentLength.clear();
  link.reset();
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
    return await pushImages(bridge, view.layout, frames);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Only the texts that changed are written; pictures only when they changed. */
export async function updatePage(bridge: EvenAppBridge, view: PageView, frames: Frames, previous: PageView | null): Promise<RenderResult> {
  const updates: Array<[TextSpec, string, string | undefined]> = [
    [HEADER, view.header, previous?.header],
    [BODY[view.layout], view.body.join(NL), previous?.body.join(NL)],
    [FOOTER, view.footer, previous?.footer],
  ];
  try {
    for (const [spec, content, before] of updates) {
      if (before !== undefined && before === content) continue;
      renderStats.upgrades += 1;
      await bounded(bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: spec.id, containerName: spec.name, ...guarded(spec.id, content) })), TEXT_CALL_MS, "text " + spec.name);
    }
    return await pushImages(bridge, view.layout, frames);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

async function pushImages(bridge: EvenAppBridge, layout: Layout, frames: Frames): Promise<RenderResult> {
  // Sequential: BLE takes one picture at a time. The big pictures first, the sign last.
  for (const [key, slot] of SLOTS[layout]) {
    const frame: Bitmap | undefined = frames[key];
    if (!frame) continue;
    const r = await link.push(bridge, slot, frame);
    if (!r.ok) return { ok: false, reason: r.reason ?? slot.name + " failed" };
  }
  const sign = await link.push(bridge, ICON, frames.icon);
  if (!sign.ok) return { ok: false, reason: sign.reason ?? "sign failed" };
  return { ok: true };
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
