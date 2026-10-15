# Shoot Day — privacy

## Kurzfassung (Deutsch)

Shoot Day spricht nur mit dem Server, den du selbst einträgst und betreibst.
Kunden (Name, Firma, Telefon, E-Mail, Notizen), Projekte, Storyboards, Ideen,
Takes, Text, Tagesplan, Packliste und hochgeladene Dateien liegen auf diesem
Server, nicht bei uns. Nur wenn du es dort einrichtest, schickt der Server den
Text einer PDF an dein eigenes Sprachmodell (`SHOOT_LLM_URL`) und Name/Firma
eines Kunden an deinen eigenen Babel-Dienst (`SHOOT_BABEL_URL`), und mit `SHOOT_WD_URL` + `SHOOT_WD_TOKEN`
Kunden, Projekte, Termine, Ideen, eine Zusammenfassung der Drehvorbereitung und Gesprächsnotizen an dein eigenes
Work Dashboard (nur in diese Richtung, dort wird nie etwas gelöscht). Den Handy-Standort fragt die App nur in der Ansicht „Licht“ ab; er wird nur am Handy für die Sonnenrechnung verwendet (zuletzt bekannter Ort auf ~1 km gerundet gespeichert) und nirgends hingeschickt. Das Mikrofon läuft nur, solange du hältst bzw. nach „Sprechen“, höchstens
2 Minuten, mit der Anzeige **● MIC**; die Aufnahme geht nur an deinen Server (und in
privaten Builds live an deine eigene Spracherkennung) und wird von der App nicht gespeichert. Kein Konto, kein Tracking.

## Short version

The app talks only to the server you enter. Audio is recorded only while you
speak, goes only to that server, and is not stored by the app.

## Permissions

| Permission (`app.json`) | Why | Used for nothing else |
|---|---|---|
| `network` (`http://*`, `https://*`) | Load shot list, script, schedule and packing list from **your** Shoot Day server, log takes and ticks there, send recordings for transcription | No other host is contacted. The wildcard exists only because the address is yours to choose. Without an address nothing is sent. |
| `g2-microphone` | Optional voice commands on the packing list and the take log | Only while you hold the temple pad (or after choosing *Speak*), at most 2 min, always shown as **● MIC**. Never on launch, never in the background. |
| `location` | Optional: sun, golden and blue hour where you are, in the *Light* view | Asked only when you open *Light* (or tap *Update location* on the phone). The position is used on the phone for the sun math and **never sent anywhere**. |

## The microphone

- Opens only on your gesture: hold on the packing list or the take card, or
  *Speak* in the take actions. Release (or tap) ends it.
- Closes automatically after 2 minutes, when you leave the module, and when
  you leave the app.
- While open, the glasses show **● MIC**; this cannot be switched off.
- The recording is held in memory, sent once to your server's `/api/stt`, and
  dropped. A cancelled recording (2×) is never sent.

## What is stored on the phone

| Data | Key | Leaves the device |
|---|---|---|
| Server address, swipe direction | `quietglass.shootday.v1` | No |
| Token (optional) | same | Only to your server, as an `Authorization` header — never in a URL, never logged, never shown in full |
| Takes not yet delivered | `quietglass.shootday.outbox.v1` | To your server, once it answers; then removed |
| Last known place, rounded to about 1 km (Light view) | `quietglass.shootday.place.v1` | No |
| Language choice | `quietglass.locale` (browser storage) | No |

## What is stored on your server

Whatever you enter in the web terminal — customers with their contact
details and notes, projects, storyboards, ideas — plus the takes, ticks,
done scenes and customers created on the glasses, in one JSON file
(`DATA_FILE`); uploaded PDFs and pictures in `SHOOT_FILES_DIR`. The example
server keeps no logs of requests and no audio. If you set `WHISPER_URL`,
recordings are forwarded to that recogniser; if you set `SHOOT_LLM_URL`, the
text of a PDF you turn into a storyboard goes to that language model; if you
set `SHOOT_BABEL_URL`, the customer's name and company are sent there as a
search when you open the card before an appointment; if you set `SHOOT_WD_URL`
and `SHOOT_WD_TOKEN`, customers (name, e-mail), projects, appointment dates,
ideas, phone/notes, a short summary of storyboards/shot list/script and the
conversation records Babel files are mirrored one-way to that self-hosted Work
Dashboard — which services, and what they keep, is your choice. Customer data concerns other people: keep the
server private (loopback + `tailscale serve`, or a `TOKEN`) and back it up.

## Transport

The app runs over HTTPS inside the Even app, so the server must be reachable
over HTTPS as well (for example with `tailscale serve`). The example server
binds to `127.0.0.1` by default and refuses to listen on other addresses
without a `TOKEN`.

## What is not collected

- No analytics, telemetry or crash reporting.
- No account, login or device identifier.
- No advertising or third-party SDKs.
- No location, no camera.

## Removing your data

Clear the server address on the phone and uninstall the app to remove
everything stored on the phone. Delete a customer or project in the web
terminal (its files go with it), or delete `DATA_FILE`, its `.bak-v1-*`
backups and `SHOOT_FILES_DIR` on your server to remove everything.

## Third-party code

One runtime dependency: `@evenrealities/even_hub_sdk`, the official SDK.
Build-time tools ship no code into the bundle. The example server and the MCP
script use only the Node.js and Python standard libraries.
