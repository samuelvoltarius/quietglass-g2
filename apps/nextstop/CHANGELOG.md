# Changelog

## [0.3.1] — 2026-10-13

### Changed

- The guide is now readable at a glance while walking and riding: the three stages of a
  journey have a page of their own with pictures (text cannot be made larger on the glasses).
  - **Walking** (with a walking route): a big arrow (144 x 144 image) on the left, the distance
    to the next turn in about 70 px high pixel digits (50 m steps from 200 m, 10 m below,
    "1,2 km", "jetzt" at the end), a thick approach bar underneath that fills as the turn comes
    closer and is full within 50 m, the street name in bold across the full width, and one small
    line of text: `Dann: O-Bus 2 Richtung Walserfeld · in 4 min`. The layout and the arrow shapes
    come from OpenGlance Nav 0.5.1 (same licence).
  - **Waiting at the stop**: the countdown ("2 min") in big digits, the line and direction as text,
    and next to it a bus-stop picture; in the last minute a bus drives in from the left (six
    frames, one per 500 ms beat).
  - **Riding**: "noch 2 Halte" as big pixel digits across the top, below it as text
    `Aussteigen: Mirabellplatz · an 02:06`. At the stop before the one to get off at, a pulsing
    "Aussteigen" warning (the digit flashes every 500 ms).
- Pictures are sent only when they change (rounded distance, bar step, minute, animation frame),
  and the 500 ms beat runs only while an animated page is on screen. A change of stage rebuilds the
  page with the other containers (at most 4 images, exactly one event capture); updates inside a
  stage are text and image updates only. `createStartUpPageContainer` is called once per run; every
  later page is a `rebuildPageContainer`.
- Walking without a route yet, a missed vehicle and the arrival stay plain text as before.
- A private build can carry the ÖBB proxy address (`VITE_OEBB_URL=https://… npm run build`, like
  `VITE_STT_URL`): ÖBB live data is then on by default and the field "Address of the ÖBB add-on" on the
  phone starts with it (leave it empty to return to it). Without the variable (public build) nothing
  changes: Transitous by default. Saved choices always win.
- Development: the demo takes `speed=N` (clock N times faster, up to 120) to drive through a whole
  journey on the desk simulator.

## [0.3.0] — 2026-10-13

### Added

- Route planning. On the phone, a new "Destinations" section: search for a place,
  address or stop (Transitous geocoder), save it as a favourite with a name of
  your own ("Home", "Work" …), reorder or remove favourites, or set a one-off
  "go now" destination. Stored with the SDK store and mirrored in localStorage.
- Glasses: new pages "Where to?" (destinations), connections (3–4 options from your
  position, one line each: `in 4 min · Bus 3 → O-Bus 7 · arr 14:52 · 1×`, details of the
  selected one below) and a step-by-step guide (walk to the stop, which vehicle at what time,
  "get off: …, n stops left", changes with stand and time, "arrived"). The guide works
  from GPS where there is a fix and from the clock otherwise, can be stepped by hand,
  notices a missed vehicle, refreshes the times of the next vehicles every minute and asks
  once before it is ended by double tap.
- Native contextual menu (tap and hold) per page to move between departures, destinations,
  connections and guide. The departures page and its gestures are unchanged; a double tap there
  still opens the system exit dialog.
- Voice input for the destination: hold the touchpad on the destinations page, speak, release
  (8 s at most). The recording goes as a WAV (16 kHz mono PCM) in a multipart form without custom
  headers to an OpenAI-compatible Whisper endpoint (`/v1/audio/transcriptions`); the glasses
  show "Heard: …" and up to three place hits (swipe, tap = connections, double-tap = drop, menu =
  save as favourite). The server address is a phone setting ("Advanced"); the public build has
  none, a private build can set a default with `VITE_STT_URL`. New permission `g2-microphone`.
- Guidance on every stage including the walks: turn arrow, distance to the turn, street and
  distance left, from a Valhalla pedestrian route (public FOSSGIS server, or `VITE_ROUTER_URL`),
  re-planned from the current position when the walker is more than 80 m off the route. Stages
  change by themselves ("Wait for Bus 3" at the stop, a warning one stop before getting off,
  change walk, "arrived"); every header shows the expected arrival of the whole journey.
- `?demo=1` (development): offline sample destinations, an invented connection built from a
  recorded Transitous answer, and `scene=`/`t=` to open a page directly in the simulator.

### Changed

- Network permission: `app.json` now lists exactly `https://api.transitous.org` and
  `https://valhalla1.openstreetmap.de` (walking directions). The
  wildcards `http://*` and `https://*` were blocked on the real glasses. A server of your own
  (MOTIS, ÖBB add-on, Whisper, Valhalla) needs its exact origin in a private `app.private.json`
  (git-ignored).
- Privacy text: favourites are now stored (on the phone only), see `docs/PRIVACY.md`.

### Geändert

- Route planen: Ziele am Handy anlegen (Ortssuche, Favoriten, „Ziel jetzt“), auf der Brille
  Verbindungen ansehen und Schritt für Schritt begleitet werden. Netzwerk-Freigabe nur noch
  für `https://api.transitous.org`.

## [0.2.2] — 2026-10-13

### Fixed

- Start language: the Even app's WebView reports English even on a German phone.
  An explicit language choice is now kept in the SDK store; without one, a German-speaking
  Even account country (AT/DE/CH/LI/LU) starts the app in German.

## [0.2.1] — 2026-10-12

### Changed

- Even lifecycle alignment (system exit handling and shared runtime updates).

Alle nennenswerten Änderungen an NextStop.

## [0.2.0] — 2026-10-07

### Changed

- German and English UI. The language follows the phone and can be switched
  at the top of the phone page; the glasses redraw at once. The German text
  is unchanged.
- Store readiness: system exit dialog, privacy policy.
  - A double tap on the root screen now opens the system exit dialog
    (`shutDownPageContainer(1)`). Cancel and the app carries on unchanged;
    timers, streams and sensors stop only after you confirm. A failed call
    is caught and leaves the app running.
  - Location updates stop only after you confirm.
  - `docs/PRIVACY.md` covers every permission in `app.json`, with a German
    summary, and is linked from the README.
  - Store art in `store/` (icon, 24 px monochrome icon, background,
    tagline), generated by `tools/store-art.mjs`.
  - `min_app_version` raised from 2.0.0 to 2.2.10, the floor of SDK 0.0.16
    that `evenhub pack` already stamped.

### Geändert

- Transitous ist jetzt die Voreinstellung: es ist ohne Zusatzprogramm aus der
  Even-App erreichbar (CORS geprüft). ÖBB-Echtzeit bleibt als Option für
  Österreich, die Proxy-Adresse liegt unter „Erweitert“.
- `app.json` fragt nach dem Standort und erlaubt das Netzwerk; ohne die
  Standort-Berechtigung kam die App nie über „Warte auf GPS“ hinaus.
  `supported_languages` nennt jetzt Deutsch, die Sprache der App.
- Fehler und Wartezustände auf der Brille sagen in einfachen Worten, was zu
  tun ist, statt „Backend“, „Proxy“ oder rohe Browser-Fehler zu zeigen.
- Handy-App: ein Satz oben sagt, was als Nächstes zu tun ist; Quellenhinweis
  auf transitous.org/sources, wie die Transitous-Nutzungsregeln verlangen.

## [0.1.0] — 2026-09-25

Erste Fassung.

### Enthalten

- Abfahrtstafel für die Haltestelle, an der man gerade steht, per GPS gefunden.
- Fahrtverfolgung: der nächste Halt unterwegs, aus GPS und Uhr abgeleitet.
- Zwei Datenquellen, beide ohne Schlüssel: ÖBB (Österreich, mit Echtzeit) und
  Transitous/MOTIS (viele Länder, selbst hostbar).
- Herkunft jeder Zeit sichtbar — gemessen, gemeldet oder nur geplant.
- CORS-Proxy für die ÖBB, weil deren Schnittstelle keine Header schickt.

### Beim Bauen gefunden

Festgehalten, weil es beim nächsten Mal wieder Zeit kosten würde.

- **Die ÖBB-Gleisfelder heißen `dPltfS` und `dPltfR`**, nicht `dPlatf…` —
  obwohl direkt daneben ein `dPlatfCh` steht. Der Tippfehler liefert still
  ein leeres Feld statt eines Fehlers.
- **GPS findet am Mirabellplatz sechs Haltestellen**, 35 m auseinander, jede
  mit einem Bruchteil der Abfahrten. Die Dach-Haltestelle mit allen Steigen
  existiert, aber nichts im Datensatz verweist auf sie — sie wird über den
  Namen aufgelöst, der sich dabei ändern kann (Hanuschplatz →
  Ferdinand-Hanusch-Platz).
- **Die Brillen-Schrift ist proportional, nicht monospace.** Spalten per
  Leerzeichen richten nichts aus; es entsteht eine krumme Treppe.
- **`▸` zeichnet die Brille gar nicht.** Der Auswahlpfeil verschwand
  wortlos — jetzt ASCII.
- **Ein Schnitt auf feste Länge zerhackt Klammern**: „Salzburg Makartplatz
  (Aicherpass". Der Steig wird jetzt zuerst entfernt, dann gekürzt.
- **Transitous antwortet 403 ohne erkennbaren User-Agent.** Kein
  User-Agent und ein bloßes „node" werden abgewiesen.
- **Entfernung allein sagt nicht, ob ein Halt vor oder hinter einem liegt.**
  Eine frühere Fassung sprang bei 120 m weiter und meldete den übernächsten
  Halt, während der aktuelle noch durch die Scheibe zu sehen war. Das
  entscheidet jetzt der Fahrplan.
