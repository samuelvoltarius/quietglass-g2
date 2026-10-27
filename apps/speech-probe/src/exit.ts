/**
 * Root-page exit through the system dialog.
 *
 * Even Hub review requires a double tap on the root page to call
 * `shutDownPageContainer(1)`: the glasses show the system exit dialog and the
 * user decides.
 *
 * Verified on hardware (step log): the call resolves `true` about 58 ms after
 * the double tap, i.e. when the dialog is SHOWN. It means "host call
 * succeeded", NOT "the user confirmed". So the result is never used to tear
 * the app down; if the user answers "Yes" the system ends the app itself (the
 * WebView is destroyed and/or a sysEvent ABNORMAL_EXIT (6) / SYSTEM_EXIT (7)
 * arrives, which the app's lifecycle handling shuts down on). If the user
 * answers "No", the app simply has to be alive and answer the next double tap.
 *
 * After the call returns, the request only remembers that the dialog was asked
 * (no redraw: the dialog may still be on screen and a page call could cover
 * it). The app calls `back()` from its event entry point on the next signal
 * that it is back (any gesture/input event, or FOREGROUND_ENTER); that restores
 * the page the way of the first page and resumes whatever was paused before
 * asking. A new double tap while the flag is still set restores first, then
 * asks again.
 *
 * Hardware finding (step log, Even G2, Klipper 0.5.11/0.5.12): right after `shutDownPageContainer(1)` the glasses
 * send sysEvent 4 (FOREGROUND_ENTER) when the dialog COMES UP and sysEvent 5 (FOREGROUND_EXIT) when it is GONE after
 * "No" (the app never left); "Yes" sends 5, then ~0.5 s later 7 (SYSTEM_EXIT). So `onLifecycle` reads the 4/5 that
 * follow an exit call as the dialog's own show/close, not as the app entering/leaving: the 4 draws nothing, the 5
 * restores the page (`onBack`) while timers, polls and streams simply keep running.
 *
 * Hardware finding (Klipper 0.5.8): that first double tap after "No" is itself the back signal. The restore
 * (rebuild + create) is asynchronous; a `shutDownPageContainer(1)` issued while the page is still being created is
 * lost and the user sees nothing. So `onBack` returns the restore promise, the request keeps it, and the next ask
 * waits for it (bounded) plus a short settle delay before it calls the host.
 */
export const EXIT_MODE_DIALOG = 1;
/** The longest a restore is waited for before the dialog is asked anyway. */
export const EXIT_RESTORE_MAX_MS = 10_000;
/** Pause after a finished restore, so the host has taken the new page before the dialog call. */
export const EXIT_SETTLE_MS = 300;

/**
 * If a first-page restore is in flight (or was just started by this very event): waits for it (at most
 * EXIT_RESTORE_MAX_MS), then EXIT_SETTLE_MS more. Without a restore it returns at once. Never rejects.
 */
export async function settleRestore(restore: Promise<unknown> | null): Promise<void> {
  if (!restore) return;
  let limit: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    restore.then(() => undefined, () => undefined),
    new Promise<void>((done) => { limit = setTimeout(done, EXIT_RESTORE_MAX_MS); }),
  ]);
  clearTimeout(limit);
  await new Promise<void>((done) => setTimeout(done, EXIT_SETTLE_MS));
}

export interface ExitBridge {
  shutDownPageContainer(exitMode?: number): Promise<boolean>;
}

export interface ExitHooks {
  /**
   * The app is back after the dialog (the user stayed, or the dialog is gone):
   * restore the page and resume anything paused before asking.
   */
  onBack?(): void | Promise<void>;
}

export interface ExitRequest {
  /** Opens the system exit dialog. Resolves once the host call returned; never rejects, never tears the app down. */
  (): Promise<void>;
  /** Call on every input event and on FOREGROUND_ENTER: runs `onBack` once if the dialog was asked since. */
  back(): void;
  /** True between the exit call and the next `back()`. */
  asked(): boolean;
  /**
   * Call FIRST in the app's event handler with the raw event. Reads the 4/5 that follow an exit call as the dialog's
   * own lifecycle: 4 -> "dialogShown" (draw nothing, return), 5 -> "dialogClosed" (the page has been restored via
   * `onBack`; return, do not pause anything). Any other event resets the tracking (the app handles it normally);
   * sensor streams (audio, IMU = 8) say nothing about the dialog and leave it untouched. Returns null otherwise.
   */
  onLifecycle(event: unknown): "dialogShown" | "dialogClosed" | null;
}

export function createExitRequest(bridge: ExitBridge, hooks: ExitHooks = {}, tag = "app"): ExitRequest {
  let pending: Promise<void> | null = null;
  let exitDialogAsked = false;
  /** The exit call is out and the dialog's FOREGROUND_ENTER (4) has not come yet. */
  let dialogPending = false;
  /** The dialog is on screen (4 seen); its FOREGROUND_EXIT (5) means "No" and it is gone. */
  let dialogShown = false;
  /** The restore started by the last back(), while it is still running. */
  let restoring: Promise<void> | null = null;

  const back = (): void => {
    if (!exitDialogAsked) return;
    exitDialogAsked = false;
    let result: void | Promise<void>;
    try {
      result = hooks.onBack?.();
    } catch (error: unknown) {
      console.warn(`[${tag}] exit restore failed:`, error);
      return;
    }
    if (!result) return;
    const run = Promise.resolve(result).catch((error: unknown) => console.warn(`[${tag}] exit restore failed:`, error));
    restoring = run;
    void run.then(() => { if (restoring === run) restoring = null; });
  };

  const ask = async (): Promise<void> => {
    // A second double tap with no restore yet: put the page back first, then ask again.
    back();
    // The restore is asynchronous and the dialog call would be lost while the page is still being created.
    if (restoring) await settleRestore(restoring);
    dialogPending = true;
    dialogShown = false;
    try {
      await bridge.shutDownPageContainer(EXIT_MODE_DIALOG);
    } catch (error: unknown) {
      console.warn(`[${tag}] exit dialog failed:`, error);
    }
    // Whatever it resolved (true/false) or if it rejected: the app keeps running.
    exitDialogAsked = true;
  };

  const onLifecycle = (event: unknown): "dialogShown" | "dialogClosed" | null => {
    const type = sysEventType(event);
    if (type === 4 && dialogPending) {
      dialogPending = false;
      dialogShown = true;
      exitDialogAsked = true;
      return "dialogShown";
    }
    if (type === 5 && dialogShown) {
      dialogShown = false;
      exitDialogAsked = true;
      back();
      return "dialogClosed";
    }
    if (isBackSignal(event) || type === 5 || type === 6 || type === 7) {
      dialogPending = false;
      dialogShown = false;
    }
    return null;
  };

  const request = (): Promise<void> => {
    if (!pending) pending = ask().finally(() => { pending = null; });
    return pending;
  };
  return Object.assign(request, { back, asked: () => exitDialogAsked, onLifecycle });
}

/** The sysEvent eventType of an event (4 FOREGROUND_ENTER, 5 FOREGROUND_EXIT, 6 ABNORMAL_EXIT, 7 SYSTEM_EXIT), or null. */
export function sysEventType(event: unknown): number | null {
  if (!event || typeof event !== "object") return null;
  const sys = (event as Record<string, unknown>)["sysEvent"];
  if (!sys || typeof sys !== "object") return null;
  const record = sys as Record<string, unknown>;
  const raw = record["eventType"] ?? record["event_type"];
  const code = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  return Number.isFinite(code) ? code : null;
}

/** The system ends the app: the user confirmed the exit dialog (7), or it went away abnormally (6). */
export function isSystemExitEvent(event: unknown): boolean {
  const type = sysEventType(event);
  return type === 6 || type === 7;
}

/**
 * True for every event that means "the app is back" after the exit dialog: gestures, list/text/sys events and
 * FOREGROUND_ENTER. Not the lifecycle events that leave (5, 6, 7) and not the sensor streams (microphone PCM,
 * IMU reports = 8), which keep flowing while the dialog is open and say nothing about the user.
 */
export function isBackSignal(event: unknown): boolean {
  if (event && typeof event === "object" && (event as Record<string, unknown>)["audioEvent"] !== undefined) return false;
  const type = sysEventType(event);
  return type !== 5 && type !== 6 && type !== 7 && type !== 8;
}
