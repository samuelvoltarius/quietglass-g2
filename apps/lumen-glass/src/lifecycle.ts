/**
 * System events of the Even Hub app lifecycle (SDK `OsEventTypeList` 4-7).
 *
 * The app can be left without a double tap: the system menu, another app in
 * the foreground, a crash. Microphone, sensors and polling must stop then, and
 * the page has to be built again when the app comes back to the foreground.
 * Same handling as Quiet Hub: 4 = draw again, 5 = save and pause, 6/7 = stop.
 */

export const FOREGROUND_ENTER = 4;
export const FOREGROUND_EXIT = 5;
export const ABNORMAL_EXIT = 6;
export const SYSTEM_EXIT = 7;

export type Lifecycle = "foregroundEnter" | "foregroundExit" | "abnormalExit" | "systemExit";

/** The lifecycle step an event announces, or null for gestures, audio and everything else. */
export function lifecycleFromEvent(event: unknown): Lifecycle | null {
  if (!event || typeof event !== "object") return null;
  const sys = (event as { sysEvent?: unknown }).sysEvent;
  if (!sys || typeof sys !== "object") return null;
  const raw = (sys as Record<string, unknown>).eventType ?? (sys as Record<string, unknown>).event_type;
  const code = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  switch (code) {
    case FOREGROUND_ENTER: return "foregroundEnter";
    case FOREGROUND_EXIT: return "foregroundExit";
    case ABNORMAL_EXIT: return "abnormalExit";
    case SYSTEM_EXIT: return "systemExit";
    default: return null;
  }
}

/** True for the two steps after which the app does not come back by itself. */
export function isFinalExit(step: Lifecycle | null): boolean {
  return step === "abnormalExit" || step === "systemExit";
}
