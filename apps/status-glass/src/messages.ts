import { tr, type Locale, type Messages } from "./i18n";

/**
 * Every string Status Glass shows. Keys starting with `g.` go to the glasses
 * and must fit LINE_WIDTH in src/glasses/view.ts (tests/i18n.test.ts builds
 * the real screens in both languages). `p.` is the phone page, `v.` the
 * address check on the phone.
 *
 * Not in here on purpose: anything a source sends (names, metric labels,
 * action labels, units), protocol values and console messages.
 */
export const messages: Messages = {
  de: {
    // Glasses — status screen
    "g.title": "Status Glass",
    "g.noSources": "Keine Quellen eingerichtet.",
    "g.addOnPhone": "Füge auf dem Handy eine hinzu.",
    "g.countOk": "{ok} von {total} ok",
    "g.allOk": "alles ok",
    "g.critical": "KRITISCH",
    "g.warning": "WARNUNG",
    "g.noData": "KEINE DATEN",
    "g.ack": "(gesehen)",
    "g.more": "+{count} weitere",
    "g.tapAck": "Tippen = gesehen",
    // Glasses — what the app itself says about a source
    "g.stale": "keine neuen Daten",
    "g.unreachable": "nicht erreichbar",
    "g.timedOut": "keine Antwort",
    "g.failed": "fehlgeschlagen",
    "g.http": "Fehler {code}",
    "g.unreadable": "Antwort nicht lesbar",
    "g.notJson": "Antwort nicht lesbar",
    "g.notObject": "Antwort nicht lesbar",
    "g.noMetrics": "Antwort ohne Messwerte",
    // Glasses — actions screen
    "g.actions": "Aktionen",
    "g.noActions": "Keine Quelle bietet Aktionen an.",
    "g.readOnly": "Quellen sind von sich aus nur zum Ansehen.",
    "g.confirm": "SICHER? ",
    "g.running": "Läuft…",
    "g.done": "Erledigt",
    "g.actionFailed": "Fehlgeschlagen",
    "g.holdBack": "Halten = zurück",
    "g.tapRun": "Tippen = ausführen",
    "g.tapConfirmFirst": "Tippen = erst bestätigen",
    "g.tapAgain": "Nochmal tippen = los",
    "g.swipeCancel": "Wischen = abbrechen",
    // Phone
    "p.addTitle": "Quelle hinzufügen",
    "p.name": "Name",
    "p.namePlaceholder": "NAS, Pi, Web",
    "p.url": "Adresse (URL)",
    "p.advanced": "Erweitert",
    "p.token": "Bearer-Token (optional)",
    "p.tokenPlaceholder": "wird als Authorization-Header gesendet",
    "p.add": "Quelle hinzufügen",
    "p.addHint": "Die Adresse muss Daten im Status-Glass-Format liefern. Wie das aussieht – samt Beispiel-Server zum Kopieren –, steht im README.",
    "p.sourcesTitle": "Quellen",
    "p.sourcesEmpty": "Noch nichts eingerichtet.",
    "p.tokenLine": "Token: {mask}",
    "p.tokenNone": "keiner",
    "p.tokenSet": "gesetzt ({count} Zeichen)",
    "p.plainHttp": "unverschlüsselt (http)",
    "p.remove": "Entfernen",
    "p.pollTitle": "Aktualisierung",
    "p.pollLabel": "Alle {value} s nachsehen",
    "p.pollHint": "Antwortet eine Quelle nicht, fragt die App seltener nach – bis höchstens alle fünf Minuten –, damit ein ausgefallenes Gerät nicht dauernd angefragt wird. Quellen, die funktionieren, bleiben beim normalen Takt.",
    "p.invert": "Wischrichtung umkehren",
    "p.controlsTitle": "Bedienung an der Brille",
    "p.tap": "Tippen",
    "p.tapDo": "Ausgewähltes Problem als gesehen markieren",
    "p.swipe": "Wischen",
    "p.swipeDo": "Durch die Problemliste blättern",
    "p.hold": "Halten",
    "p.holdDo": "Aktionen öffnen – oder alle Quellen neu abfragen, wenn keine angeboten werden",
    "p.double": "Doppeltippen",
    "p.doubleDo": "Status Glass beenden",
    "p.controlsHint": "Ist alles in Ordnung, zeigt die Brille nur eine Zeile. Ein als gesehen markiertes Problem rutscht ans Ende der Liste – es verschwindet nie und meldet sich wieder, wenn es sich erholt und erneut auftritt.",
    "p.securityTitle": "Sicherheit",
    "p.securityToken": "Tokens werden im <code>Authorization</code>-Header gesendet, nie in der Adresse, und liegen im privaten Speicher dieser App auf dem Handy. Sie landen in keinem Log und werden hier nie vollständig angezeigt.",
    "p.securityHttp": "Nimm wenn möglich <code>https://</code>. Einfaches <code>http://</code> ist erlaubt, weil Dienste im Heimnetz oft kein Zertifikat haben – aber alles, was darüber geht, auch dein Token, ist unverschlüsselt unterwegs.",
    "p.footer": "Status Glass spricht nur mit den Quellen, die du einträgst. Kein Hersteller-Server, kein Konto, keine Nutzungsdaten.",
    "p.saveFailed": "Speichern fehlgeschlagen: {error}",
    // Address check on the phone
    "v.urlRequired": "Bitte gib eine Adresse ein.",
    "v.urlScheme": "Die Adresse muss mit http:// oder https:// beginnen.",
    "v.urlCredentials": "Zugangsdaten gehören ins Token-Feld unter „Erweitert“, nicht in die Adresse.",
    "v.urlInvalid": "Das ist keine gültige Adresse.",
  },
  en: {
    "g.title": "Status Glass",
    "g.noSources": "No sources configured.",
    "g.addOnPhone": "Add one in the phone app.",
    "g.countOk": "{ok} of {total} ok",
    "g.allOk": "all ok",
    "g.critical": "CRITICAL",
    "g.warning": "WARNING",
    "g.noData": "NO DATA",
    "g.ack": "(ack)",
    "g.more": "+{count} more",
    "g.tapAck": "tap = acknowledge",
    "g.stale": "no data",
    "g.unreachable": "unreachable",
    "g.timedOut": "timed out",
    "g.failed": "failed",
    "g.http": "HTTP {code}",
    "g.unreadable": "Unreadable response",
    "g.notJson": "Response was not valid JSON.",
    "g.notObject": "Response was not a JSON object.",
    "g.noMetrics": "Response had no \"metrics\" array.",
    "g.actions": "Actions",
    "g.noActions": "No source offers any.",
    "g.readOnly": "Sources are read-only by default.",
    "g.confirm": "CONFIRM: ",
    "g.running": "Running…",
    "g.done": "Done",
    "g.actionFailed": "Failed",
    "g.holdBack": "hold = back",
    "g.tapRun": "tap = run",
    "g.tapConfirmFirst": "tap = confirm first",
    "g.tapAgain": "tap again = run",
    "g.swipeCancel": "swipe = cancel",
    "p.addTitle": "Add a source",
    "p.name": "Name",
    "p.namePlaceholder": "nas, pi, web",
    "p.url": "URL",
    "p.advanced": "Advanced",
    "p.token": "Bearer token (optional)",
    "p.tokenPlaceholder": "sent as an Authorization header",
    "p.add": "Add source",
    "p.addHint": "The URL must return the Status Glass JSON shape. See the README for the format and a reference server you can copy.",
    "p.sourcesTitle": "Sources",
    "p.sourcesEmpty": "Nothing configured yet.",
    "p.tokenLine": "token: {mask}",
    "p.tokenNone": "none",
    "p.tokenSet": "set ({count} chars)",
    "p.plainHttp": "unencrypted http",
    "p.remove": "Remove",
    "p.pollTitle": "Polling",
    "p.pollLabel": "Interval — {value} s",
    "p.pollHint": "A source that fails backs off automatically, up to five minutes, so a host that is down is not hammered. Healthy sources keep their normal interval.",
    "p.invert": "Invert swipe direction",
    "p.controlsTitle": "Controls on the glasses",
    "p.tap": "Tap",
    "p.tapDo": "Acknowledge the highlighted problem",
    "p.swipe": "Swipe",
    "p.swipeDo": "Move through the problem list",
    "p.hold": "Hold",
    "p.holdDo": "Open the actions, or refresh every source when none are offered",
    "p.double": "Double tap",
    "p.doubleDo": "Leave Status Glass",
    "p.controlsHint": "When everything is healthy the glasses show a single line. Acknowledging a problem moves it to the bottom of the list — it never hides it, and it comes back if the metric recovers and fails again.",
    "p.securityTitle": "Security",
    "p.securityToken": "Tokens are sent in an <code>Authorization</code> header, never in the URL, and are stored in this app's private storage on the phone. They are never written to logs and never shown in full here.",
    "p.securityHttp": "Prefer <code>https://</code>. Plain <code>http://</code> is permitted because homelab services routinely lack certificates, but anything sent over it — including your token — travels in the clear.",
    "p.footer": "Status Glass talks only to the sources you configure. There is no vendor service, no account and no telemetry.",
    "p.saveFailed": "Could not save: {error}",
    "v.urlRequired": "URL is required.",
    "v.urlScheme": "URL must start with http:// or https://.",
    "v.urlCredentials": "Put credentials in the token field, not in the URL.",
    "v.urlInvalid": "URL is not valid.",
  },
};

export function t(locale: Locale, key: string, vars: Record<string, string | number> = {}): string {
  return tr(messages, locale, key, vars);
}

/**
 * The fetcher reports failures as fixed English codes ("unreachable",
 * "HTTP 503", the parser's messages); they double as stable test values.
 * This turns the ones the app itself produces into the chosen language.
 * Anything else came from the source or the runtime and is shown as is.
 */
const ISSUES: Readonly<Record<string, string>> = {
  "unreachable": "g.unreachable",
  "timed out": "g.timedOut",
  "failed": "g.failed",
  "Unreadable response": "g.unreadable",
  "Response was not valid JSON.": "g.notJson",
  "Response was not a JSON object.": "g.notObject",
  "Response had no \"metrics\" array.": "g.noMetrics",
};

export function describeIssue(text: string, locale: Locale): string {
  const key = ISSUES[text];
  if (key) return t(locale, key);
  const http = /^HTTP (\d{3})$/.exec(text);
  if (http) return t(locale, "g.http", { code: http[1] ?? "" });
  return text;
}
