import { ApiError } from "../api/client";
import type { Locale } from "../i18n";
import { messages, t } from "../messages";

/** Short problem text for the glasses; never contains a URL or a token. */
export function errorText(locale: Locale, error: unknown): string {
  const problem = error instanceof ApiError ? error : new ApiError("unreachable");
  if (problem.code === "http") {
    const key = "g.err.s" + problem.status;
    return key in messages.en ? t(locale, key) : t(locale, "g.err.http", { status: problem.status });
  }
  return t(locale, "g.err." + problem.code);
}
