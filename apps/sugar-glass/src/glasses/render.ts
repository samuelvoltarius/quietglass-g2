import {
  CreateStartUpPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  RebuildPageContainer,
  StartUpPageCreateResult,
  type EvenAppBridge,
} from "@evenrealities/even_hub_sdk";
import type { Frames, Layout, PageView } from "./views";
import { ImageLink, imageContainer, type ImageSlot } from "./images";
import { CURVE_HEIGHT, CURVE_WIDTH, ICON_HEIGHT, ICON_WIDTH, VALUE_HEIGHT, VALUE_WIDTH } from "./charts";

/**
 * Puts a page view onto the G2 (576 x 288).
 *
 *  - glucose: header beside the drop sign (top right); the big value with
 *    trend arrow (288 x 144) at the left and the 3-hour curve (288 x 144) at
 *    the right; two text rows below; footer.
 *  - plain:   header, full-width body (7 rows), footer (pump, setup, errors).
 *
 * At most three image containers. The first page on a bridge is one ignored
 * `rebuildPageContainer` and then exactly one `createStartUpPageContainer`;
 * every later layout change is a rebuild; anything else is
 * `textContainerUpgrade` / `updateImageRawData`, and only when it changed.
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

const HEADER: TextSpec = { id: 1, name: "header", x: 0, y: 0, width: SCREEN_WIDTH - ICON_WIDTH, height: 32 };
const FOOTER: TextSpec = { id: 3, name: "footer", x: 0, y: 252, width: SCREEN_WIDTH, height: 34 };
const BODY: Readonly<Record<Layout, TextSpec>> = {
  plain: { id: 2, name: "body", x: 0, y: 36, width: SCREEN_WIDTH, height: 214 },
  glucose: { id: 2, name: "body", x: 0, y: 36 + VALUE_HEIGHT + 2, width: SCREEN_WIDTH, height: 252 - (36 + VALUE_HEIGHT + 2) },
};

export const ICON: ImageSlot = { id: 4, name: "drop", x: SCREEN_WIDTH - ICON_WIDTH, y: 1, width: ICON_WIDTH, height: ICON_HEIGHT, z: 4 };
export const VALUE: ImageSlot = { id: 5, name: "value", x: 0, y: 34, width: VALUE_WIDTH, height: VALUE_HEIGHT, z: 5 };
export const CURVE: ImageSlot = { id: 6, name: "curve", x: VALUE_WIDTH, y: 34, width: CURVE_WIDTH, height: CURVE_HEIGHT, z: 6 };

export function slotsFor(layout: Layout): ImageSlot[] {
  return layout === "glucose" ? [ICON, VALUE, CURVE] : [ICON];
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

export function buildPage(view: PageView): CreateStartUpPageContainer {
  const texts = [
    text(HEADER, view.header, 1, false),
    // Exactly one container captures input; the body owns it.
    text(BODY[view.layout], view.body.join(NL), 2, true),
    text(FOOTER, view.footer, 3, false),
  ];
  const images = slotsFor(view.layout).map(imageContainer);
  return new CreateStartUpPageContainer({ containerTotalNum: texts.length + images.length, textObject: texts, imageObject: images });
}

const started = new WeakSet<EvenAppBridge>();
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
export async function installPage(bridge: EvenAppBridge, view: PageView, frames: Frames): Promise<RenderResult> {
  const page = buildPage(view);
  sentLength.clear();
  link.reset();
  try {
    if (!started.has(bridge)) {
      try {
        await bridge.rebuildPageContainer(new RebuildPageContainer({ ...page }));
      } catch {
        // Expected before the first creation; it registers the input route on real glasses.
      }
      const result = await bridge.createStartUpPageContainer(page);
      if (result !== StartUpPageCreateResult.success) return { ok: false, reason: describeCreateResult(result) };
      started.add(bridge);
      renderStats.creates += 1;
    } else {
      const ok = await bridge.rebuildPageContainer(new RebuildPageContainer({ ...page }));
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
      await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: spec.id, containerName: spec.name, ...guarded(spec.id, content) }));
    }
    return await pushImages(bridge, view.layout, frames);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

async function pushImages(bridge: EvenAppBridge, layout: Layout, frames: Frames): Promise<RenderResult> {
  // Sequential: BLE takes one picture at a time.
  const sign = await link.push(bridge, ICON, frames.icon);
  if (!sign.ok) return { ok: false, reason: sign.reason ?? "sign failed" };
  if (layout === "glucose") {
    for (const [slot, frame] of [[VALUE, frames.value], [CURVE, frames.curve]] as const) {
      if (!frame) continue;
      const r = await link.push(bridge, slot, frame);
      if (!r.ok) return { ok: false, reason: r.reason ?? slot.name + " failed" };
    }
  }
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
