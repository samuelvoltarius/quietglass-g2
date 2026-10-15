# Quietglass Interaction Standard (QIS v1)

> **Stand 15.10.2026 – auf echter Brille gemessen:** Das Seitenmenü (`menuObject`, Klicks als `menuItemClickEvent`) wird zwar angezeigt, seine Klicks kommen in der App aber **nie** an, und solange eine Seite ein Menü trägt, öffnet **Halten** das Menü statt die App zu erreichen. Alle Apps tragen deshalb vorerst **kein** Seitenmenü (`SIDE_MENU = false`); Hilfe, Stopp, Löschen usw. laufen wieder über Gesten bzw. Listenzeilen. Die v1.2-Regeln zum Seitenmenü gelten erst wieder, wenn Menü-Klicks nachweislich ankommen.


One way to operate every Quietglass app, so nothing has to be relearned between apps
and no single slip of the finger can do something that cannot be undone.

Status: v1, 2026-10-14. Applies to every app under `apps/`. New apps follow it from day one;
existing apps are brought in line app by app (see "Rollout" below).

---

## 1. The four gestures

| Gesture | Meaning | Never |
|---|---|---|
| **Tap** (1×) | The main action of the current screen: open, confirm, start, reload. | — |
| **Swipe** (up/down) | Move the selection or page. Only moves, never changes data. | delete, answer "no", deny, stop |
| **Double tap** (2×) | Back one level. On the root screen: leave the app. | stop, cancel a running job, answer |
| **Hold** | Speak (voice input), or a harmless secondary action (help, details). | stop navigation, delete, send |

Scroll direction follows the global setting: every app with a list honours `invertScroll`
(phone tab "Brille"), default off.

## 2. Risky actions: arm, then confirm

Anything that stops, deletes, sends, resets, or answers on the wearer's behalf is **armed** first:

1. Tap on the action → the footer changes to `Nochmal tippen = <Aktion> · Wischen/2× = abbrechen`.
2. A second **single tap within 4 s** carries it out.
3. Swipe, double tap, or 4 s without input cancels and restores the previous footer.

Examples: stop navigation, stop a shift timer, reset a noise dose, delete a log entry,
stop a running agent, allow/deny an agent request, run a status action.

Approvals (agent requests, Xaventra yes/no) are **never** mapped to swipe directions.
The choice is a list (`Erlauben` / `Ablehnen`), swipe moves, tap arms, tap confirms.

## 3. Screen layout

```
APPNAME · state                       <- header, upper case app name, short state
...content...
Tippen = X · Wischen = Y · Halten = Z · 2× = zurück   <- footer
```

- **Header:** `APPNAME · state`, e.g. `KLIPPER · druckt 42 %`, `BABEL · hört zu`.
- **Footer:** only the gestures that do something on this screen, in the fixed order
  Tippen → Wischen → Halten → 2×. The last part is always `2× = zurück` (subpage) or
  `2× = Ende` (root). Use the shared `footer()` helper, never hand-built strings.
- Footer and header must fit one row (`ROW_WIDTH`) in German and English; tests check this.

## 4. Help page

Every app has a help page reachable from the root list (`Hilfe`, last entry).
It lists the four gestures for that app in the same order as the footer, plus one line
on what the app needs (bridge, phone, nothing).

QIS v1.1: Hilfe, Übersicht und Einstellungen liegen im Seitenmenü (Halten → Menü der Brille), nicht auf Wischgesten.

## 5. Phone (WebView) tabs

Fixed order: `[content tabs] · Brille · Verbindung · Mehr`.

- **Brille:** everything that changes what the glasses show (scroll direction, layout, start screen).
- **Verbindung:** server URL, token, test button, demo mode.
- **Mehr:** about, version, privacy, logs.

## 6. Errors: three lines

```
<What failed, in plain words>
<What it means for the wearer>
Tippen = nochmal · 2× = zurück
```

No stack traces, no HTTP codes on the glasses (the phone shows details under "Mehr").

## 7. First start

Without configuration every app starts in **demo mode** with realistic sample data and a
one-line hint `Demo · Verbindung am Handy einrichten`. Nothing requires setup to look around.

## 8. Wording (glossary)

| Use | Don't use |
|---|---|
| `Tippen`, `Wischen`, `Halten`, `2×` | `Tap`, `Wisch`, `2x`, `Doppeltipp` |
| `zurück`, `Ende` | `back`, `Exit`, `beenden` in footers |
| `abbrechen` | `cancel`, `stopp` for cancel |
| English: `Tap`, `Swipe`, `Hold`, `2×`, `back`, `exit` | |

## Rollout

Order of work:

1. **Safety** (single gesture can do something irreversible): openglance hold-stop,
   shift-clock tap-stop, decibel tap-reset, quiet-hub 2× stops agent, status-glass 2× in
   actions, posture/field-log swipe-delete, xaventra/agent-glass swipe yes/no.
2. **Footers** through the shared helper, `2× = zurück|Ende` everywhere.
3. **Tabs** in the fixed order, `invertScroll` in every list app.
4. **Help page** in every app.

Each app records its QIS conformance in its CHANGELOG entry.

## QIS v1.2 (2026-10-14) — rulings after the audit

1. **Side menu for help and settings.** Every app registers a glasses side menu (long press → menu,
   `menuObject` on create/rebuild, clicks via `menuItemClickEvent`; reference: babel-glass, quiet-hub).
   It holds at least `Hilfe`, and where present `Übersicht` and app settings. Help is no longer a
   list row, a swipe target or the only meaning of Hold.
2. **2× at the root with a running job** (captions, measuring, navigation, recording) opens the system
   exit dialog *without* stopping first; the job only ends if the exit is confirmed. 2× on a
   recording/dictation screen goes back and keeps what was recorded until the user discards it
   explicitly (armed).
3. **Destructive menu items** (delete voice print, discard, reset) are armed like any other risky
   action: first click arms (`Nochmal = löschen`), a second click within 4 s executes.
4. **Voice answers** to approvals/questions are shown first and need a confirming tap; speech alone
   never answers on the wearer's behalf.
5. **Swipe never saves or changes data.** Selecting a value (tempo, sport, severity, view) happens in
   a list: swipe moves, tap sets. Documented exception: cadence tempo (the app's core control).
6. **Verbindung tab only for apps that talk to a server.** Apps without a server keep
   `[content] · Brille · Mehr`.
7. **First start = demo.** Without configuration every app shows demo data and the hint line
   `Demo · Verbindung am Handy einrichten` (apps without a server: no hint needed).
8. **Errors without technical codes** on the glasses (no HTTP status, no exception text); details go
   to the phone's Mehr tab.
9. **Phone texts use the same glossary** (no "Doppeltippen", use "2×").
