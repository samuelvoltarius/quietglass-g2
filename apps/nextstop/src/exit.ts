/**
 * Root-page exit through the system dialog.
 *
 * Even Hub review requires a double tap on the root page to call
 * `shutDownPageContainer(1)`: the glasses show the system exit dialog and the
 * user decides. The call resolves `true` only when the user confirmed. On
 * cancel it resolves `false` and the app has to carry on exactly as before, so
 * nothing is torn down before the answer arrives. A rejected call means the
 * dialog never appeared, which also leaves the app running.
 */
export const EXIT_MODE_DIALOG = 1;

export interface ExitBridge {
  shutDownPageContainer(exitMode?: number): Promise<boolean>;
}

export interface ExitHooks {
  /** The user confirmed: stop timers, sensors and streams. */
  onConfirmed(): void | Promise<void>;
  /** The user stayed (cancelled, or the call failed): restore anything paused before asking. */
  onStayed?(): void | Promise<void>;
}

/**
 * Returns the function a root-page double tap calls. A second double tap while
 * the dialog is still open joins the pending request instead of asking twice.
 * Never rejects.
 */
export function createExitRequest(bridge: ExitBridge, hooks: ExitHooks, tag = "app"): () => Promise<boolean> {
  let pending: Promise<boolean> | null = null;

  const ask = async (): Promise<boolean> => {
    let confirmed = false;
    try {
      confirmed = (await bridge.shutDownPageContainer(EXIT_MODE_DIALOG)) === true;
    } catch (error: unknown) {
      console.warn(`[${tag}] exit dialog failed:`, error);
    }
    try {
      if (confirmed) await hooks.onConfirmed();
      else await hooks.onStayed?.();
    } catch (error: unknown) {
      console.warn(`[${tag}] exit handling failed:`, error);
    }
    return confirmed;
  };

  return () => {
    if (!pending) pending = ask().finally(() => { pending = null; });
    return pending;
  };
}
