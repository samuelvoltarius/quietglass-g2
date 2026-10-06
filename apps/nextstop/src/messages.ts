import { tr, type Locale, type Messages } from "./i18n";

/**
 * Every string NextStop shows. Keys starting with `g.` go to the glasses and
 * must fit 7 body rows of at most 46 characters (LINE_WIDTH / BODY_ROWS in
 * src/glasses/view.ts; tests/i18n.test.ts checks both languages). Keys
 * starting with `p.` are the phone page and may carry HTML.
 *
 * The German text is the reviewed original and is kept verbatim. Not
 * translated on purpose: stop names, lines and destinations (they come from
 * the operator), the app name, the units "m"/"km"/"min", and technical
 * identifiers such as MOTIS, CORS or the proxy command.
 */
export const messages: Messages = {
  de: {
    // Glasses: waiting and loading
    "g.searching": "Haltestelle suchen …",
    "g.waitingForLocation": "Warte auf deinen Standort …",
    "g.waitingHint": "Erlaube den Standort in der Even-App. Draußen klappt es am schnellsten.",
    "g.loadingRide": "Fahrt laden …",
    // Glasses: nothing found
    "g.noStops": "Keine Haltestelle in der Nähe",
    "g.noStopsHintOebb": "ÖBB kennt hier keine Haltestelle. Am Handy „Überall“ wählen.",
    "g.noStopsHintMotis": "Hier sind keine Fahrplandaten hinterlegt. In Österreich: am Handy ÖBB wählen.",
    "g.noRide": "Fahrtverlauf nicht verfügbar",
    "g.noRideHint": "Für diese Fahrt gibt es keine Liste der Halte.",
    // Glasses: failures
    "g.oebbUnreachable": "ÖBB nicht erreichbar",
    "g.oebbUnreachableHint": "ÖBB-Echtzeit braucht ein Zusatzprogramm. Ohne: am Handy „Überall“ wählen.",
    "g.timeout": "Fahrplandienst antwortet nicht",
    "g.checkInternet": "Prüfe das Internet am Handy und tippe nochmal.",
    "g.refused": "Anfrage abgelehnt",
    "g.refusedHint": "Der Fahrplandienst nimmt gerade keine Anfragen an. Später nochmal versuchen.",
    "g.serviceDown": "Fahrplandienst gestört ({code})",
    "g.serviceDownHint": "Bitte gleich nochmal versuchen.",
    "g.offline": "Keine Verbindung",
    "g.failed": "Abfrage fehlgeschlagen",
    "g.failedHint": "Unerwartete Antwort vom Fahrplandienst. Tippe, um es nochmal zu versuchen.",
    // Glasses: times
    "g.cancelled": "fällt aus",
    "g.now": "jetzt",
    "g.arriving": "gleich",
    "g.minutes": "{minutes} min",
    "g.hoursCompact": "{hours}h{minutes}",
    "g.hoursMinutes": "{hours}h {minutes}m",
    // Glasses: departure board
    "g.emptyBoard1": "Keine Abfahrten in der nächsten Stunde.",
    "g.emptyBoard2": "Betriebsschluss, oder diese Haltestelle",
    "g.emptyBoard3": "wird gerade nicht bedient.",
    "g.footerEmptyBoard": "halten = andere Haltestelle",
    "g.footerBoardLive": "tippen = verfolgen · ● live  ~ Fahrplan",
    "g.footerBoardPlanned": "tippen = verfolgen · nur Fahrplan",
    // Glasses: ride
    "g.terminus": "Endstation {stop}.",
    "g.rideOver": "Die Fahrt ist zu Ende.",
    "g.footerRideOver": "tippen = zurück zur Haltestelle",
    "g.lastStop": "letzter Halt",
    "g.stopsLeftOne": "noch {count} Halt · Ziel {eta}",
    "g.stopsLeftMany": "noch {count} Halte · Ziel {eta}",
    "g.footerGps": "GPS · tippen = zurück",
    "g.footerGpsDistance": "GPS · {metres} m · tippen = zurück",
    "g.footerClock": "nach Fahrplan geschätzt · tippen = zurück",
    // Glasses: other footers
    "g.footerRetry": "tippen = nochmal versuchen",
    "g.footerExit": "doppeltippen = beenden",

    // Phone: next step
    "p.nextNoPosition": "Erlaube den Standort in der Even-App – dann zeigt die Brille die Abfahrten in deiner Nähe.",
    "p.nextNoStops": "Suche Haltestellen in deiner Nähe … Findet die Brille keine, wähle unten die andere Quelle.",
    "p.nextReady": "Fertig. Auf der Brille: wischen = Abfahrt wählen, tippen = mitfahren.",
    // Phone: status
    "p.noPosition": "Noch kein Standort – erlaube den Standort in der Even-App.",
    "p.seeded": "Teststandort aus der Adresse (?at=), nicht gemessen.",
    "p.positionFound": "Standort gefunden.",
    "p.positionFoundAccuracy": "Standort gefunden (± {metres} m).",
    "p.noStopsYet": "Noch keine Haltestelle gefunden.",
    "p.nearestStop": "Nächste Haltestelle: {stop} ({count} in der Nähe).",
    // Phone: source
    "p.sourceLabel": "Woher kommen die Abfahrten?",
    "p.sourceMotis": "Überall – Fahrplan (funktioniert sofort)",
    "p.sourceOebb": "ÖBB – Echtzeit in Österreich (Zusatzprogramm nötig)",
    "p.sourceHintOebb": "Zeigt Verspätungen in ganz Österreich, bis zum Stadtbus. Braucht ein kleines Zusatzprogramm auf einem Computer im selben WLAN – siehe „Erweitert“ unten.",
    "p.sourceHintMotis": "Funktioniert sofort, in vielen Ländern. Meist reine Fahrplanzeiten (~); Verspätungen nur dort, wo der Verkehrsbetrieb sie meldet.",
    "p.status": "Status",
    "p.refreshNow": "Haltestellen neu suchen",
    // Phone: controls
    "p.controls": "Bedienung auf der Brille",
    "p.swipe": "Wischen",
    "p.swipeDoes": "Abfahrt auswählen",
    "p.tap": "Tippen",
    "p.tapDoes": "mitfahren und den nächsten Halt sehen, nochmal tippen = zurück",
    "p.hold": "Halten",
    "p.holdDoes": "nächste Haltestelle in der Nähe",
    "p.doubleTap": "Doppeltippen",
    "p.doubleTapDoes": "NextStop beenden",
    "p.legend": "<strong>●</strong> = Echtzeit, <strong>~</strong> = nur Fahrplan, <strong>+3</strong> = 3 Minuten später",
    // Phone: advanced
    "p.advanced": "Erweitert",
    "p.oebbUrl": "Adresse des ÖBB-Zusatzprogramms",
    "p.oebbUrlHint": "Die ÖBB-Schnittstelle schickt keine CORS-Header, deshalb verwirft die App ihre Antworten. Ein kleiner Proxy auf einem Computer im selben Netz reicht sie durch: <code>node examples/oebb-cors-proxy.mjs</code> (README, Abschnitt „ÖBB-Echtzeit“).",
    "p.motisUrl": "Fahrplan-Server (MOTIS)",
    "p.motisUrlHint": "Voreingestellt ist die öffentliche Transitous-Instanz. Nur ändern, wenn du MOTIS selbst betreibst — dann verlässt keine Anfrage das Haus.",
    "p.refreshEvery": "Abfahrten neu laden alle {value} s",
    "p.refreshHint": "Gilt nur für die Abfahrtstafel. Während der Fahrt bleibt die Haltestellenfolge stehen — sie ändert sich nicht.",
    "p.credits": "Fahrplandaten: {link} (u. a. OpenStreetMap) · Echtzeit Österreich: ÖBB",
    "p.creditsLink": "Transitous und seine Quellen",
    // Phone: address check
    "p.urlMissing": "Adresse fehlt.",
    "p.urlScheme": "Adresse muss mit http:// oder https:// beginnen.",
    "p.urlInvalid": "Das ist keine gültige Adresse.",
    "p.invalid": "Ungültig",
  },
  en: {
    // Glasses: waiting and loading
    "g.searching": "Finding stops …",
    "g.waitingForLocation": "Waiting for your location …",
    "g.waitingHint": "Allow location in the Even app. It is quickest outdoors.",
    "g.loadingRide": "Loading ride …",
    // Glasses: nothing found
    "g.noStops": "No stops nearby",
    "g.noStopsHintOebb": "ÖBB has no stop here. On the phone, choose \"Anywhere\".",
    "g.noStopsHintMotis": "No timetable data for this area. In Austria: choose ÖBB on the phone.",
    "g.noRide": "Ride details not available",
    "g.noRideHint": "There is no list of stops for this ride.",
    // Glasses: failures
    "g.oebbUnreachable": "ÖBB not reachable",
    "g.oebbUnreachableHint": "ÖBB live times need an add-on. Without it: choose \"Anywhere\" on the phone.",
    "g.timeout": "Timetable service not responding",
    "g.checkInternet": "Check the phone's internet and tap again.",
    "g.refused": "Request refused",
    "g.refusedHint": "The timetable service is not taking requests right now. Try again later.",
    "g.serviceDown": "Timetable service down ({code})",
    "g.serviceDownHint": "Please try again in a moment.",
    "g.offline": "No connection",
    "g.failed": "Request failed",
    "g.failedHint": "Unexpected reply from the timetable service. Tap to try again.",
    // Glasses: times
    "g.cancelled": "cancelled",
    "g.now": "now",
    "g.arriving": "arriving",
    "g.minutes": "{minutes} min",
    "g.hoursCompact": "{hours}h{minutes}",
    "g.hoursMinutes": "{hours}h {minutes}m",
    // Glasses: departure board
    "g.emptyBoard1": "No departures in the next hour.",
    "g.emptyBoard2": "Service has ended, or this stop",
    "g.emptyBoard3": "is not being served right now.",
    "g.footerEmptyBoard": "hold = other stop",
    "g.footerBoardLive": "tap = follow · ● live  ~ timetable",
    "g.footerBoardPlanned": "tap = follow · timetable only",
    // Glasses: ride
    "g.terminus": "End of the line: {stop}.",
    "g.rideOver": "This ride has ended.",
    "g.footerRideOver": "tap = back to the stop",
    "g.lastStop": "last stop",
    "g.stopsLeftOne": "{count} stop left · terminus {eta}",
    "g.stopsLeftMany": "{count} stops left · terminus {eta}",
    "g.footerGps": "GPS · tap = back",
    "g.footerGpsDistance": "GPS · {metres} m · tap = back",
    "g.footerClock": "estimated from timetable · tap = back",
    // Glasses: other footers
    "g.footerRetry": "tap = try again",
    "g.footerExit": "double-tap = exit",

    // Phone: next step
    "p.nextNoPosition": "Allow location in the Even app – then the glasses show the departures near you.",
    "p.nextNoStops": "Looking for stops near you … If the glasses find none, pick the other source below.",
    "p.nextReady": "Ready. On the glasses: swipe = pick a departure, tap = ride along.",
    // Phone: status
    "p.noPosition": "No location yet – allow location in the Even app.",
    "p.seeded": "Test location from the address (?at=), not measured.",
    "p.positionFound": "Location found.",
    "p.positionFoundAccuracy": "Location found (± {metres} m).",
    "p.noStopsYet": "No stop found yet.",
    "p.nearestStop": "Nearest stop: {stop} ({count} nearby).",
    // Phone: source
    "p.sourceLabel": "Where do the departures come from?",
    "p.sourceMotis": "Anywhere – timetable (works right away)",
    "p.sourceOebb": "ÖBB – live times in Austria (add-on needed)",
    "p.sourceHintOebb": "Shows delays all over Austria, down to the city bus. Needs a small add-on on a computer on the same Wi-Fi – see \"Advanced\" below.",
    "p.sourceHintMotis": "Works right away, in many countries. Mostly timetable times (~); delays only where the operator reports them.",
    "p.status": "Status",
    "p.refreshNow": "Search for stops again",
    // Phone: controls
    "p.controls": "Controls on the glasses",
    "p.swipe": "Swipe",
    "p.swipeDoes": "pick a departure",
    "p.tap": "Tap",
    "p.tapDoes": "ride along and see the next stop, tap again = back",
    "p.hold": "Hold",
    "p.holdDoes": "next stop nearby",
    "p.doubleTap": "Double-tap",
    "p.doubleTapDoes": "exit NextStop",
    "p.legend": "<strong>●</strong> = live, <strong>~</strong> = timetable only, <strong>+3</strong> = 3 minutes late",
    // Phone: advanced
    "p.advanced": "Advanced",
    "p.oebbUrl": "Address of the ÖBB add-on",
    "p.oebbUrlHint": "The ÖBB interface sends no CORS headers, so the app discards its replies. A small proxy on a computer on the same network passes them through: <code>node examples/oebb-cors-proxy.mjs</code> (README, section \"ÖBB-Echtzeit\").",
    "p.motisUrl": "Timetable server (MOTIS)",
    "p.motisUrlHint": "Set to the public Transitous instance. Only change it if you run MOTIS yourself — then no request leaves your home.",
    "p.refreshEvery": "Reload departures every {value} s",
    "p.refreshHint": "Only applies to the departure board. During a ride the list of stops stays as it is — it does not change.",
    "p.credits": "Timetable data: {link} (incl. OpenStreetMap) · Live times Austria: ÖBB",
    "p.creditsLink": "Transitous and its sources",
    // Phone: address check
    "p.urlMissing": "Address missing.",
    "p.urlScheme": "The address must start with http:// or https://.",
    "p.urlInvalid": "That is not a valid address.",
    "p.invalid": "Invalid",
  },
};

export function t(locale: Locale, key: string, vars: Record<string, string | number> = {}): string {
  return tr(messages, locale, key, vars);
}
