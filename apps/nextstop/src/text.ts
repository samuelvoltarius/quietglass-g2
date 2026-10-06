import type { BackendId } from "./storage/persist";
import type { Locale } from "./i18n";
import { t } from "./messages";

/**
 * The sentences NextStop says when something is missing or went wrong.
 *
 * Kept in one place (the wording itself lives in src/messages.ts) so the tests
 * can hold them to two rules: each one fits the glasses (rows of at most 46
 * characters, seven rows) and none of them makes a beginner look up a word.
 * "Proxy", "CORS", "Backend" and the like belong in the advanced part of the
 * phone app ("Erweitert" / "Advanced"), not on the glasses.
 */

export interface Explanation { readonly error: string; readonly hint: string; }

/** The fixed sentences, in one language. */
export function glassesText(locale: Locale) {
  return {
    searching: t(locale, "g.searching"),
    waitingForLocation: t(locale, "g.waitingForLocation"),
    waitingHint: t(locale, "g.waitingHint"),
    loadingRide: t(locale, "g.loadingRide"),
    noStops: t(locale, "g.noStops"),
    noRide: t(locale, "g.noRide"),
    noRideHint: t(locale, "g.noRideHint"),
  } as const;
}

/** Why no stop was found, and the one thing worth trying. */
export function noStopsHint(backend: BackendId, locale: Locale): string {
  return t(locale, backend === "oebb" ? "g.noStopsHintOebb" : "g.noStopsHintMotis");
}

/** Turns a thrown failure into something a passenger can act on. */
export function explainFailure(message: string, backend: BackendId, locale: Locale): Explanation {
  const say = (error: string, hint: string, vars: Record<string, string> = {}): Explanation =>
    ({ error: t(locale, error, vars), hint: t(locale, hint) });
  if (backend === "oebb" && /fetch|network|failed|load/i.test(message)) {
    return say("g.oebbUnreachable", "g.oebbUnreachableHint");
  }
  if (/timed out|abort/i.test(message)) return say("g.timeout", "g.checkInternet");
  if (/403/.test(message)) return say("g.refused", "g.refusedHint");
  const http = /HTTP (\d{3})/.exec(message);
  if (http) return say("g.serviceDown", "g.serviceDownHint", { code: http[1] ?? "?" });
  if (/fetch|network|failed|load/i.test(message)) return say("g.offline", "g.checkInternet");
  return say("g.failed", "g.failedHint");
}

/** The one sentence at the top of the phone app: what to do next. */
export function nextStep(hasPosition: boolean, stopCount: number, locale: Locale): string {
  if (!hasPosition) return t(locale, "p.nextNoPosition");
  if (stopCount === 0) return t(locale, "p.nextNoStops");
  return t(locale, "p.nextReady");
}
