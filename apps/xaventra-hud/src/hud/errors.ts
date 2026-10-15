import { ApiError } from "../api/client";
import type { Locale } from "../i18n";
import { messages, t } from "../messages";

/**
 * Technical detail for the phone's connection line (QIS v1.2 #8: HTTP status
 * codes never reach the glasses; the phone may show them). "" when there is none.
 */
export function errorDetail(error: unknown): string {
  return error instanceof ApiError && error.status > 0 ? `HTTP ${error.status}` : "";
}

/** Short problem text for the glasses; never contains a URL, a token or an HTTP status code. */
export function errorText(locale: Locale, error: unknown): string {
  const problem = error instanceof ApiError ? error : new ApiError("unreachable");
  if (problem.code === "http") {
    const key = "g.err.s" + problem.status;
    return key in messages.en ? t(locale, key) : t(locale, "g.err.http");
  }
  return t(locale, "g.err." + problem.code);
}
