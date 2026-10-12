/**
 * Translates raw Even Hub events into named gestures.
 *
 * Shared Quietglass convention — each app carries its own copy so it stays
 * independently releasable, but the mapping is identical across apps so the
 * controls feel the same on every one of them.
 */

/** Event codes as emitted by the glasses (see SDK `OsEventTypeList`). */
export const EVENT_CLICK = 0;
export const EVENT_SCROLL_TOP = 1;
export const EVENT_SCROLL_BOTTOM = 2;
export const EVENT_DOUBLE_CLICK = 3;
export const EVENT_LONG_PRESS = 9;
export const EVENT_LONG_PRESS_RELEASE = 10;

/** `EventSourceType` in the SDK. */
export const SOURCE_NULL = 0;
export const SOURCE_GLASSES_RIGHT = 1;
export const SOURCE_RING = 2;
export const SOURCE_GLASSES_LEFT = 3;

export type Gesture =
  | "click"
  | "doubleClick"
  | "scrollUp"
  | "scrollDown"
  | "longPress"
  | "longPressRelease";

export type InputSource = "glassesLeft" | "glassesRight" | "ring" | "unknown";

export interface GestureEvent {
  readonly gesture: Gesture;
  readonly source: InputSource;
}

export interface GestureOptions {
  /**
   * Real G2 hardware reports swipes inverted relative to the simulator: a
   * physical downward swipe arrives as SCROLL_TOP. Kept configurable because
   * Quietglass has not yet measured this on its own device, and because a
   * firmware fix would otherwise break the mapping.
   */
  readonly invertScroll?: boolean;
}

export function sourceFromCode(code: number | undefined): InputSource {
  switch (code) {
    case SOURCE_GLASSES_RIGHT: return "glassesRight";
    case SOURCE_GLASSES_LEFT: return "glassesLeft";
    case SOURCE_RING: return "ring";
    default: return "unknown";
  }
}

/**
 * Null when the event carries no gesture this app understands.
 *
 * Note the caller, not this function, resolves a missing code — see
 * `gestureFromEvent` for why an absent `eventType` means CLICK.
 */
export function gestureFromCode(code: number | undefined, options: GestureOptions = {}): Gesture | null {
  const invert = options.invertScroll ?? false;
  switch (code) {
    case EVENT_CLICK: return "click";
    case EVENT_DOUBLE_CLICK: return "doubleClick";
    case EVENT_LONG_PRESS: return "longPress";
    case EVENT_LONG_PRESS_RELEASE: return "longPressRelease";
    case EVENT_SCROLL_TOP: return invert ? "scrollDown" : "scrollUp";
    case EVENT_SCROLL_BOTTOM: return invert ? "scrollUp" : "scrollDown";
    default: return null;
  }
}

/**
 * Reads a gesture out of an `EvenHubEvent`. The SDK exposes several event
 * shapes (text, list, menu, sys); the fields are read defensively because the
 * payload differs per container kind and across SDK versions.
 */
export function gestureFromEvent(event: unknown, options: GestureOptions = {}): GestureEvent | null {
  if (!event || typeof event !== "object") return null;
  const record = event as Record<string, unknown>;

  const payloads = ["textEvent", "listEvent", "sysEvent"]
    .map((key) => pickRecord(record, key))
    .filter((value): value is Record<string, unknown> => value !== null);
  if (payloads.length === 0) return null;

  // The glasses may deliver one physical gesture on several payloads at once
  // (e.g. an empty textEvent next to a sysEvent that says DOUBLE_CLICK). An
  // explicit event code always beats an absent one, otherwise the double tap
  // would be read as a tap and "back" would never fire.
  const payload = payloads.find((item) => readNumberField(item, "eventType", "event_type", "type") !== undefined) ?? payloads[0]!;

  // proto3 omits any field that holds its default value, and CLICK_EVENT is 0.
  // A container event therefore arrives with NO eventType at all when the user
  // tapped — verified in the simulator, where a tap produces exactly
  // `{"sysEvent":{"eventSource":1}}`. Treating the absence as "unknown" makes
  // the app ignore every tap, so an absent code resolves to CLICK here.
  const code = readNumberField(payload, "eventType", "event_type", "type") ?? EVENT_CLICK;
  const gesture = gestureFromCode(code, options);
  if (gesture === null) return null;

  const sourceCode = readNumberField(payload, "eventSource", "event_source", "source");
  const source = sourceFromCode(sourceCode);
  if (!passesDebounce(gesture, source, Date.now())) return null;
  return { gesture, source };
}

/**
 * Per-gesture debounce windows in milliseconds, applied inside
 * `gestureFromEvent` itself so every app inherits them.
 *
 * Real G2 firmware emits duplicate events 50-100 ms apart for a single tap,
 * and one physical swipe arrives as 5-10 SCROLL events. Without a window the
 * app double-fires taps and scrolls several rows per swipe. The simulator has
 * no duplicates, so the windows only ever affect hardware. The window is
 * tracked per (gesture, source) pair so a deliberate ring double-tap right
 * after a glasses double-tap is never swallowed.
 */
const GESTURE_DEDUPE_MS: Readonly<Record<string, number>> = {
  click: 250,
  scroll: 300,
  doubleClick: 500,
  longPress: 600,
  longPressRelease: 250,
};

// Hosted on globalThis: tests that vi.resetModules() and re-import the app
// get a fresh module copy, and a per-module Map would silently keep stale
// timestamps; a shared map keeps the reset seams working across copies.
const lastGestureAt: Map<string, number> = ((globalThis as { __g2GestureClock?: Map<string, number> }).__g2GestureClock ??= new Map<string, number>());

/** Test seam: forget the debounce history (tests run many gestures per tick). */
export function resetGestureDedupe(): void {
  lastGestureAt.clear();
}

function passesDebounce(gesture: Gesture, source: InputSource, now: number): boolean {
  const key = (gesture === "scrollUp" || gesture === "scrollDown" ? "scroll" : gesture) + ":" + source;
  const windowMs = GESTURE_DEDUPE_MS[gesture === "scrollUp" || gesture === "scrollDown" ? "scroll" : gesture] ?? 0;
  const previous = lastGestureAt.get(key);
  if (previous !== undefined && now - previous < windowMs) return false;
  lastGestureAt.set(key, now);
  return true;
}

function pickRecord(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = record[key];
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function readNumberField(record: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number") return value;
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return undefined;
}

/**
 * Item chosen in the native contextual menu. Menu clicks come in a
 * `menuItemClickEvent` of their own and never through the capture container.
 * Zero is reserved for "no item" (itemID is never 0 in our menus).
 */
export function menuItemIdFromEvent(event: unknown): number | null {
  if (!event || typeof event !== "object") return null;
  const payload = pickRecord(event as Record<string, unknown>, "menuItemClickEvent");
  if (payload === null) return null;
  const id = readNumberField(payload, "itemID", "itemId", "Item_ID", "item_id");
  return id !== undefined && id > 0 ? id : null;
}

/**
 * Selected row of a list container. proto3 omits row 0, so a missing
 * `currentSelectItemIndex` is 0, never "unknown".
 */
export function listIndexFromEvent(event: unknown): number {
  if (!event || typeof event !== "object") return 0;
  const payload = pickRecord(event as Record<string, unknown>, "listEvent");
  if (payload === null) return 0;
  return readNumberField(payload, "currentSelectItemIndex", "current_select_item_index") ?? 0;
}
