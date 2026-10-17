/**
 * Waiting rule for the exit dialog after "No" (same constants and function as the shared exit.ts of the other apps).
 *
 * Hardware finding (Klipper 0.5.8): the first double tap after "No" is itself the back signal that starts the
 * asynchronous first-page restore (rebuild + create). A `shutDownPageContainer(1)` issued while the page is still
 * being created is lost. So the exit request waits for the restore (bounded) and a short settle delay first.
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
