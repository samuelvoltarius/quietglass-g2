# NextStop

**Quietglass** · Departures and the next stop — without taking your phone out of your pocket.

> **Auf Deutsch, kurz:** NextStop zeigt auf der Even G2, was an der Haltestelle neben dir abfährt – und während der Fahrt, welcher Halt als Nächstes kommt. Dazu gibt es Routenplanung mit Begleitung Schritt für Schritt, auch per Spracheingabe. Kein Konto, kein Schlüssel, kein eigener Server; Verspätungen in Österreich optional über einen kleinen ÖBB-Zusatz. Wischen wählt, Tippen öffnet, 2× geht zurück.

> **In short:** NextStop shows on the glasses what leaves from the stop next to you – and, while you ride, which stop comes next. No account, no key, no server of your own.
>
> 1. Install and open NextStop in the Even app.
> 2. Allow location when the Even app asks. The glasses then show the departures of the nearest stop.
> 3. The start page has three big entries: **Departures**, **Say a destination** and **Goals and route** (swipe picks, tap opens). On the departure board (drawn as a picture: line and minutes big, track, delay, stop) **swipe** picks a departure, **tap** rides along (next stop), **2×** goes back; on the start page **2×** exits (system dialog).
>
> `●` = live, `~` = timetable only, `+3` = three minutes late. Optional: ÖBB live times in Austria need a small add-on on a computer on the same Wi-Fi (see [ÖBB live times](#öbb-live-times-optional)); without it everything works with timetable times.
>
> **Languages:** German and English. The app follows the phone's language and can be switched at the top of the phone page.

At the platform: what leaves from here, and is it on time.
On the bus: which stop comes next, and when do I arrive.
On the way to a destination: **plan a route** and have the app guide you step by step (since 0.3.0).

> **New in 0.3.0 – route planning:** Under "Destinations" on the phone, search for places and save favourites ("Home", "Work" …). On the glasses, tap **Say a destination**, say it and tap again (2× during the recording opens the destination list with your favourites): pick a destination, see 3–4 connections from where you are (`in 4 min · Bus 3 → O-Bus 7 · arr 14:52 · 1×`), **tap** to start guidance: walk to the stop, which bus at what time, "Get off: …, 2 stops left", "Change to …", "You have arrived". **Double-tap** goes back a step (in the guide it asks once more). Connections and place search come from Transitous; favourites stay on the phone.

---

![The departure board](docs/screenshot.png)

*Real data, Salzburg Mirabellplatz: bus 175 eleven minutes late, O-Bus 3 on time.*

## Why this app exists

There are already ten public transport apps for the G2. **Nine of them know exactly one
city** — Washington, Karlsruhe, Helsinki, Tokyo, Paris, New York. If you travel,
you are left with nothing.

NextStop can show something anywhere because it has two sources instead of one.

## The two data sources

| | Area | Live times | Key | directly from the app |
|---|---|---|---|---|
| **Transitous** (default, "Anywhere") | many countries | depending on region | none | yes |
| **ÖBB** (optional) | Austria | yes, down to the city bus | none | no, only with an add-on |

Why both? Because neither is enough on its own.

**Transitous** is non-profit, provider-neutral and — the real reason —
**self-hostable** with MOTIS. But for Austria it carries timetables only: of
fifteen Austrian feeds, exactly one has live data configured.
Measured at Mirabellplatz: **0 of 8 departures** with delay information.

**ÖBB** does provide it, right down to the Salzburg O-Bus. Measured
at the same stop in the same minute: **8 of 10**.

Switch in the phone app. Transitous is the default because it is the
only one of the two sources that can be reached without help from the Even app. If you
run MOTIS yourself, enter your own address under "Advanced" — then no request
leaves your home.

**Checked on 6 October 2026** (curl with a browser `Origin`):

- `api.transitous.org` answers `/api/v1/map/stops` and
  `/api/v1/stoptimes` with `Access-Control-Allow-Origin: *` and
  `Access-Control-Allow-Headers: *`; the preflight request (`OPTIONS`) is answered
  the same way. Without a `User-Agent` it returns 403 — in the browser the
  WebView sends its own. According to the [usage rules](https://transitous.org/api/),
  the API is free for open-source, non-commercial and frugal clients,
  with a visible link to [transitous.org/sources](https://transitous.org/sources/)
  (at the bottom of the phone app).
- `fahrplan.oebb.at/bin/mgate.exe` answers the same request with `200`,
  but **without** any `Access-Control-*` header, not even on `OPTIONS`.
  From a WebView it therefore only works through the proxy.

## What you see

```
Salzburg Mirabellplatz · 99 m

> jetzt +11  Bus 175  Rif Ortsmitte · H
  jetzt +2  Bus 170  Salzburg Hbf · B
  jetzt +2  Bus 22  Josefiau · C
  jetzt +2  O-Bus 1  Kleßheim · E
  2 min ●  O-Bus 3  Salzburg Nord · A
  3 min +4  Bus 120  Palting via Mitterhof · G

tippen = verfolgen · ● live  ~ Fahrplan
```

Each row reads in the order in which you ask: **how long** –
**which line** – **where to** – track. The waiting time comes first, because it is
what you look at the board for, and at the left edge it does not jump around.
The destination is shortened the way display boards do it ("Hbf", "Bf", "Str.", the
track in brackets is dropped) and is the only field that gives way when the row
gets too long – marked with "…". A place name is never left out.

**Why no graphic:** There is no larger type on the glasses, and one
image row per departure would cost a Bluetooth transfer for every row every minute
(images are much slower than text on the G2). Line "badges"
as images would only make the line number prettier, but not the waiting time
more readable. Text with a fixed order and clear spacing is grasped faster
here — and is up to date immediately after every reload.

The character right after the time is where most departure boards cheat:

| | Meaning |
|---|---|
| `+11` | the operator reports eleven minutes of delay |
| `-2` | leaves early — it happens and is not hidden |
| `●` | the operator reports: on time |
| `~` | **timetable only.** Nobody has confirmed it. |
| `X` | cancelled (the row then says "fällt aus" (cancelled) instead of the time) |

The tilde is the most important. A board that prints a planned time the same way as a
measured one is believed just the same — and is just as often wrong.

### Plan a route

```
Wohin? · 14:29                   → Heim · 14:29
> Jetzt: Getreidegasse 10        > in 4 min · O-Bus 2 → O-Bus 10 · an 14:46 · 1×
  Heim                             in 17 min · O-Bus 10 · an 14:56
  Arbeit                           in 17 min · O-Bus 2 → O-Bus 10 · an 15:00 · 1×
  Hauptbahnhof
                                 Ab Salzburg Vogelweiderstraße
                                 Gehen 15 min · Dauer 35 min
```

**Speak a destination (optional):** On the start page, tap **Say a destination** and say the destination.
On the next tap (or after 15 s at the latest), the recording goes as a WAV to a
Whisper server (OpenAI-compatible, `/v1/audio/transcriptions`, form upload without custom
headers, so that no CORS preflight is needed). The glasses show "Heard: …" and up to three
hits from the place search; swipe picks, tap searches connections, 2× goes back. "Save as favourite" exists
only with the glasses' side menu (currently off); you create favourites on the phone. The address of the server is on the phone under "Advanced"; the
public app has no default (the glasses then say that a server of your own is needed), a
private build can preset it with `VITE_STT_URL`. Audio is recorded only between the
two taps, nothing is stored. Hold reaches the app only through the optional R1 ring
(there additionally: hold = speak, release = done); from the temple, hold opens the system menu.

**Walking routes with turn instructions:** The guide leads you through every leg: on walking legs, the
next turn is shown at the top (`←  60 m  links abbiegen`, street, rest of the route), updated by GPS.
The turns come from Valhalla (`costing: pedestrian`, public OSM server from FOSSGIS,
or `VITE_ROUTER_URL` in a private build): MOTIS' own walking steps only say "straight on"
and hardly name streets. If the walker moves more than 80 m away from the route, it is
recalculated from the current location ("Neu berechnet" (recalculated) in the footer). The legs change
by themselves (walk → "Warte auf Bus 3" (waiting for bus 3) → ride with "Danach aussteigen" (get off after that) one stop earlier →
transfer walk → … → "Ziel erreicht" (destination reached)); the header shows the leg, the time and the expected arrival.
A missed vehicle is detected by the app from your location, and a tap offers a new connection.
**Map and images instead of small text:** The glasses cannot enlarge text, so the
legs have their own image pages. *On foot* (since 0.9.0) is a cockpit image (QUS v1): on the left a small
**map** (streets dimmed from OpenStreetMap/Overpass, the rest of the route as a bright line, stop
as a ring, destination as a square, you as an arrowhead, the map rotates with the route), on the right the one large
instruction (`LINKS · 80 M`, `HALTESTELLE · 320 M`, `ZIEL · 120 M`), the street, and the cells WEG (distance),
ABFAHRT (departure; at the destination ANKUNFT, arrival), PUFFER (buffer; framed under 2 min), LINIE (line), STEIG (track); hint line at the bottom
(`1/5 · GPS · Tippen = weiter · 2× = Ende`). The streets are loaded once per walking leg (at most
8 s; without an answer the map is drawn without streets), and the map is re-sent only on noticeable movement
(8 m, 10°, at most every 4 s). Network allowances for this: `overpass-api.de` and
`overpass.private.coffee`. *Waiting*: the countdown ("2 min")
large, line and direction as text, next to it a stop into which a bus
drives in the last minute. *Ride*: "2 stops left" as large digits, below it `Aussteigen: Mirabellplatz · an 02:06`;
one stop before, "Aussteigen" (get off) blinks. Images are only sent on change; the 500 ms tick
runs only while an animated page is open. Map drawing and the Overpass query come from OpenGlance Nav.

The destinations are stored on the phone (SDK storage, with localStorage as a mirror). The app
searches places through the Transitous place search (`/api/v1/geocode`) and connections through
`/api/v1/plan`; both on the same address as the departures, so the glasses need
only **one** network allowance. Planning always goes through MOTIS, even if the
departure board is set to ÖBB. During guidance, the times of the next
two vehicles are refreshed once a minute through `/api/v1/trip`, so that
reported delays arrive.

### On the way

```
Bus 175 → Rif Ortsmitte

> Salzburg Makartplatz · jetzt
  Salzburg Rathaus · 1 min
  Salzburg Mozartsteg · 2 min
  Salzburg Justizgebäude · 3 min
  Salzburg Akademiestraße · 4 min

noch 20 Halte · Ziel 27 min

GPS · 326 m · tippen = zurück
```

The footer says **where** the next stop comes from. With GPS it is measured;
without GPS — tunnel, subway, phone in your pocket — it is estimated from the timetable and the clock,
and after a longer traffic jam this estimate can be several stops too
optimistic. The footer says so, too.

## Controls

| Gesture | Effect |
|---|---|
| **Swipe** | pick an entry or departure; only moves, never changes anything |
| **Tap** | open; follow a ride; to cancel a running ride: tap, then tap again; during recording: done |
| **Ring: hold** | only with the R1 ring, additionally: say a destination; in the guide: arm ending |
| **2×** | back; on the departure board: leave NextStop (system dialog) |

On the route pages: **swipe** picks the destination or the connection, **tap** opens
the connections or starts the guide, **double-tap** goes back. In the
guide, tap means "next step" and swipe pages back and forth.
Everything that ends a running ride or guide is **armed** (QIS v1):
first tap, or in the guide swipe up on the first step, then `Nochmal tippen = Fahrt abbrechen` (tap again = cancel ride) within
4 s; swipe, 2× or 4 s without input cancel. 2× never ends a running ride or
guide (in the guide it opens the system dialog for leaving, which you can
decline). You can reverse the swipe direction on the phone under "Settings".

## Setup

For Transitous: nothing — that is the default.

### Own map server (optional)

The streets of the walking map come from the public Overpass servers
(overpass-api.de, overpass.private.coffee). If they are overloaded (error 406,
timeout), the map shows only the route. If you run your own
Overpass server, enter it on the phone under **Settings →
Advanced → "Own map server (Overpass)"** (https address,
the app adds `/api/interpreter`). Your server is asked first; if it is
unreachable, the app falls back to the public ones. Empty = public
servers. Applies immediately, without a restart.

### ÖBB live times (optional)

For delays in Austria you need a small proxy that runs on a
computer in the same network. In the phone app, then choose "ÖBB – live times in
Austria" and enter the proxy's address under "Advanced"
(e.g. `http://192.168.1.20:8079/oebb`, started with `HOST=0.0.0.0`).

```bash
node examples/oebb-cors-proxy.mjs     # 127.0.0.1:8079
```

The ÖBB interface sends no CORS headers, so the browser throws away the
reply before the app sees it. The symptom is misleading: the glasses
show **"ÖBB nicht erreichbar" ("ÖBB not reachable")**, while the same request in the terminal goes through
without problems. The server did answer — the browser discarded it.

```bash
npm install
npm run dev        # phone UI + app on http://127.0.0.1:5201
npm run build      # typecheck + production bundle
npm test           # 109 tests
npm run sim        # simulator pointed at the dev server
```

### Testing without glasses

The simulator has no GPS, so the app would never get past "Warte auf deinen Standort" (waiting for your location).
There is a start parameter for that:

```
http://127.0.0.1:5201/?at=47.8060,13.0430
```

A real GPS fix overrides it immediately, and the phone app
explicitly says that the position is set and not measured.

## Privacy

Where someone is going is about as personal as data can get.
NextStop therefore stores **no trips and no history**. What is stored is
the chosen source and its address and — only if you create them yourself — your
favourites (name and coordinates) and the "Go now" destination. They stay on the phone;
only the search text and coordinates go to the timetable service when you search or plan.

The position is sent to the chosen service in order to find the nearest stop
— there is no other way. If you run MOTIS yourself, you can keep that
in your own network, too.

## Known limits

| Limit | Detail |
|---|---|
| ÖBB needs the proxy | CORS. Start it once, see above. Without the proxy, Transitous stays with timetable times. |
| German and English only | The glasses and the phone app currently speak German and English. |
| ÖBB is not an open data API | It is the endpoint of the ÖBB's own app. No key needed, but nobody guarantees that it stays this way. Every field is read as optional: if something changes, the app falls back to timetable times instead of crashing. |
| Transitous coverage varies | Whole regions can be missing. The app says so instead of showing an empty list. |
| Routes only via MOTIS | Connections come from Transitous (or your MOTIS). The ÖBB source only knows the departure board and the ride. In Austria the times are mostly timetable (`~`), not live. |
| Own server on the glasses | The public `app.json` allows only `https://api.transitous.org`. If you use your own MOTIS or ÖBB server, pack with your own `app.private.json` that additionally has exactly this address in the whitelist (the wildcard `*` blocks the real glasses). |
| Voice input needs a server | Whisper does not run in the app. Without a server of your own (phone, "Advanced", or `VITE_STT_URL` in the private build), you stay with searching on the phone. |
| Arrow as a text character | `←`, `→`, `↖`, `↗` are drawn in the simulator; not checked on the real glasses. |
| Guide without GPS | Then the clock decides; the footer shows "Uhr" (clock) instead of "GPS", and a tap advances by hand. |
| Not tested on hardware | Built and checked against SDK 0.0.16 and the simulator — but against **real, running services**, not against mocks. |

## Next steps

- Transfer warning when the connection can no longer be made according to live data (the guide already refreshes the times, but does not warn yet).
- Use Styria live data via Transitous where the ÖBB knows nothing.
- An alarm shortly before your own stop, instead of having to count along yourself.

## Privacy

Which data goes where, what is stored and how to delete it: [docs/PRIVACY.md](docs/PRIVACY.md).

## License

MIT — see [LICENSE](LICENSE).
