/** A failure as a message key the user can act on; raw parser and network wording stays in the console. */
export interface Failure { readonly key: "errEmpty" | "errUnreadable" | "errNoTranscript" | "errTimeout" | "errServer" | "errOffline" | "errPasteEmpty" | "errUnknown"; readonly status?: string; }

export function failureFor(cause: unknown): Failure {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (/transcript is empty/.test(message)) return { key: "errEmpty" };
  if (/^unreadable transcript/.test(message)) return { key: "errUnreadable" };
  if (/no podcast:transcript/.test(message)) return { key: "errNoTranscript" };
  if (/timed out|abort/i.test(message)) return { key: "errTimeout" };
  const http = /HTTP (\d{3})/.exec(message); if (http) return { key: "errServer", status: http[1] ?? "" };
  if (/fetch|network|load failed/i.test(message)) return { key: "errOffline" };
  return { key: "errUnknown" };
}
