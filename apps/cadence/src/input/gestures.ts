/**
 * Translates raw Even Hub events into named gestures.
 *
 * Shared Aigner Labs convention — each app carries its own copy so it stays
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
   * Aigner Labs has not yet measured this on its own device, and because a
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

  const payload =
    pickRecord(record, "textEvent") ??
    pickRecord(record, "listEvent") ??
    pickRecord(record, "sysEvent") ??
    null;
  if (!payload) return null;

  // proto3 omits any field that holds its default value, and CLICK_EVENT is 0.
  // A container event therefore arrives with NO eventType at all when the user
  // tapped — verified in the simulator, where a tap produces exactly
  // `{"sysEvent":{"eventSource":1}}`. Treating the absence as "unknown" makes
  // the app ignore every tap, so an absent code resolves to CLICK here.
  const code = readNumberField(payload, "eventType", "event_type", "type") ?? EVENT_CLICK;
  const gesture = gestureFromCode(code, options);
  if (gesture === null) return null;

  const sourceCode = readNumberField(payload, "eventSource", "event_source", "source");
  return { gesture, source: sourceFromCode(sourceCode) };
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
