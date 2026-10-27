/**
 * System lifecycle events from the Even app (SDK `OsEventTypeList` 4-7).
 *
 * They arrive on the same `sysEvent` channel as gestures. Shared Quietglass
 * convention (same file in every app, Quiet Hub was first):
 * - "foreground" (4): the app is visible again; rebuild the page, restart
 *   sensors and polling.
 * - "background" (5): the app left the glasses through the system; save the
 *   state and stop microphone, sensors, GPS and polling.
 * - "exit" (6 abnormal, 7 system): the app is going away; save and stop
 *   everything.
 */
export type Lifecycle = "foreground" | "background" | "exit";

export const EVENT_FOREGROUND_ENTER = 4;
export const EVENT_FOREGROUND_EXIT = 5;
export const EVENT_ABNORMAL_EXIT = 6;
export const EVENT_SYSTEM_EXIT = 7;

export function lifecycleFromEvent(event: unknown): Lifecycle | null {
  if (!event || typeof event !== "object") return null;
  const sys = (event as Record<string, unknown>)["sysEvent"];
  if (!sys || typeof sys !== "object") return null;
  const record = sys as Record<string, unknown>;
  const raw = record["eventType"] ?? record["event_type"];
  const code = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  switch (code) {
    case EVENT_FOREGROUND_ENTER: return "foreground";
    case EVENT_FOREGROUND_EXIT: return "background";
    case EVENT_ABNORMAL_EXIT:
    case EVENT_SYSTEM_EXIT: return "exit";
    default: return null;
  }
}
