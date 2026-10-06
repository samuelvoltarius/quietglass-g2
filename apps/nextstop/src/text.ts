import type { BackendId } from "./storage/persist";

/**
 * The sentences NextStop says when something is missing or went wrong.
 *
 * Kept in one place so the tests can hold them to two rules: each one fits the
 * glasses (rows of at most 46 characters, seven rows) and none of them makes
 * a beginner look up a word. "Proxy", "CORS", "Backend" and the like belong in
 * the "Erweitert" part of the phone app, not on the glasses.
 */

export interface Explanation { readonly error: string; readonly hint: string; }

export const TEXT = {
  searching: "Haltestelle suchen …",
  waitingForLocation: "Warte auf deinen Standort …",
  waitingHint: "Erlaube den Standort in der Even-App. Draußen klappt es am schnellsten.",
  loadingRide: "Fahrt laden …",
  noStops: "Keine Haltestelle in der Nähe",
  noRide: "Fahrtverlauf nicht verfügbar",
  noRideHint: "Für diese Fahrt gibt es keine Liste der Halte.",
} as const;

/** Why no stop was found, and the one thing worth trying. */
export function noStopsHint(backend: BackendId): string {
  return backend === "oebb"
    ? "ÖBB kennt hier keine Haltestelle. Am Handy „Überall“ wählen."
    : "Hier sind keine Fahrplandaten hinterlegt. In Österreich: am Handy ÖBB wählen.";
}

/** Turns a thrown failure into something a passenger can act on. */
export function explainFailure(message: string, backend: BackendId): Explanation {
  if (backend === "oebb" && /fetch|network|failed|load/i.test(message)) {
    return { error: "ÖBB nicht erreichbar", hint: "ÖBB-Echtzeit braucht ein Zusatzprogramm. Ohne: am Handy „Überall“ wählen." };
  }
  if (/timed out|abort/i.test(message)) return { error: "Fahrplandienst antwortet nicht", hint: "Prüfe das Internet am Handy und tippe nochmal." };
  if (/403/.test(message)) return { error: "Anfrage abgelehnt", hint: "Der Fahrplandienst nimmt gerade keine Anfragen an. Später nochmal versuchen." };
  const http = /HTTP (\d{3})/.exec(message);
  if (http) return { error: `Fahrplandienst gestört (${http[1] ?? "?"})`, hint: "Bitte gleich nochmal versuchen." };
  if (/fetch|network|failed|load/i.test(message)) return { error: "Keine Verbindung", hint: "Prüfe das Internet am Handy und tippe nochmal." };
  return { error: "Abfrage fehlgeschlagen", hint: "Unerwartete Antwort vom Fahrplandienst. Tippe, um es nochmal zu versuchen." };
}

/** The one sentence at the top of the phone app: what to do next. */
export function nextStep(hasPosition: boolean, stopCount: number): string {
  if (!hasPosition) return "Erlaube den Standort in der Even-App – dann zeigt die Brille die Abfahrten in deiner Nähe.";
  if (stopCount === 0) return "Suche Haltestellen in deiner Nähe … Findet die Brille keine, wähle unten die andere Quelle.";
  return "Fertig. Auf der Brille: wischen = Abfahrt wählen, tippen = mitfahren.";
}
