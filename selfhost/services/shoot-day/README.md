# shoot-day — Backend für Shoot Day

Speichert Kunden und ihre Projekte (Storyboards, Shotlist, Takes, Ideen, Skript/Teleprompter, Tagesplan,
Packliste, Dateien), liefert ein **Web-Terminal** zum Bearbeiten am Rechner und schickt Sprachbefehle an Whisper.
**Der Code liegt im Repo und wird nicht kopiert:**
[`apps/shoot-day/examples/shoot-day-server.mjs`](../../../apps/shoot-day/examples/shoot-day-server.mjs)
(Node ≥ 18, keine Abhängigkeiten) samt `shoot-day-terminal.html` und `shoot-day-pdf.mjs` (PDF-Text, Storyboard-Vorschlag)
im selben Ordner. Optional ein MCP-Server für Agenten: [`dreh_mcp.py`](../../../apps/shoot-day/examples/dreh_mcp.py).

| lokal | Tailscale-Port (Vorschlag) | App-Feld / Build |
|---|---|---|
| `127.0.0.1:8896` | `8445` | „Serveradresse“ = `https://<server>.<tailnet>.ts.net:8445` |

Das Web-Terminal erreichst du im Browser unter derselben Adresse (im Tailnet). Sprachbefehle brauchen den
[whisper](../whisper)-Dienst (`WHISPER_URL`), sonst ist Sprache aus.

## Umgebungsvariablen (`~/.config/quietglass/shoot-day.env`)

| Variable | Standard | Wofür |
|---|---|---|
| `PORT`, `HOST` | `8896`, `127.0.0.1` | Adresse; anderes als Loopback nur mit `TOKEN` |
| `DATA_FILE` | – (vollen Pfad eintragen) | Kunden, Projekte, Takes … (eine JSON-Datei) |
| `SHOOT_FILES_DIR` | `shoot-day-files` neben `DATA_FILE` | hochgeladene PDFs/Bilder, ein Ordner pro Projekt |
| `SHOOT_MAX_UPLOAD_MB` | `20` | größte Datei |
| `WHISPER_URL` | – | Spracherkennung; leer = Sprache aus |
| `PRESET_LANG` | `en` | `de` = deutsche Packliste und Kunde „Ohne Zuordnung“ |
| `SHOOT_LLM_URL` | – | OpenAI-kompatibles Sprachmodell (`…/v1`) für „Storyboard aus PDF“; leer = Eingabe von Hand |
| `SHOOT_LLM_MODEL`, `SHOOT_LLM_TOKEN` | – | Modellname bzw. Bearer-Token dafür (optional) |
| `SHOOT_BABEL_URL` | – | babel-llm-proxy (`https://host:port` oder `…/v1`): die Karte „Kunde vor dem Termin“ zeigt Babels Gedächtnis zum Kunden (`POST /memory/search`, vom Server aus). Leer = kein Babel-Abschnitt |
| `SHOOT_BABEL_TOKEN` | – | Bearer-Token für den Babel-Proxy (optional) |
| `SHOOT_WD_URL` | – | Work Dashboard (Basisadresse, z. B. `https://work.example.org`; MCP unter `…/mcp`). Leer = kein Abgleich |
| `SHOOT_WD_TOKEN` | – | Agent-Token aus dem Work Dashboard (`wd_…`). Ohne Token kein Abgleich |
| `SHOOT_WD_DEBOUNCE_MS` | `10000` | Wartezeit nach der letzten Änderung, bevor abgeglichen wird |
| `SHOOT_WD_STATUS_OPEN`, `SHOOT_WD_STATUS_DONE` | `open`, `done` | Statusnamen der Aufgaben im Work Dashboard (nur ändern, wenn es andere Namen nutzt) |
| `SHOOT_GCAL_WEBHOOK`, `SHOOT_GCAL_SECRET` | – | Google-Kalender-Brücke (Abschnitt „Google Kalender“); leer = aus |
| `SHOOT_GCAL_CALENDAR`, `SHOOT_GCAL_DURATION_MIN`, `SHOOT_TZ` | Standardkalender, `60`, `Europe/Vienna` | optional: Kalender-ID, Termindauer in Minuten, Zeitzone der Datumsangaben |
| `SD_TAILSCALE_USERS`, `TOKEN` | – | Zugang (Tailscale-Login ohne Token, sonst Token) |

Die echten Adressen deiner Dienste gehören nur in die env-Datei, nie ins Repo.

## Installieren

```bash
git clone https://github.com/samuelvoltarius/quietglass-g2 ~/quietglass-g2     # falls noch nicht da
mkdir -p ~/.config/quietglass ~/.local/state/quietglass/shoot-day ~/.config/systemd/user
cp .env.example ~/.config/quietglass/shoot-day.env && chmod 600 ~/.config/quietglass/shoot-day.env
$EDITOR ~/.config/quietglass/shoot-day.env    # DATA_FILE mit vollem Pfad, SD_TAILSCALE_USERS = dein Login
cp shoot-day.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now shoot-day
loginctl enable-linger "$USER"
systemctl --user is-active shoot-day
tailscale serve --bg --https=8445 http://127.0.0.1:8896      # nie "serve reset"
tailscale serve status
```

## Work Dashboard

Alles, was Shoot Day und Babel über Kunden wissen, erscheint zusätzlich im eigenen Work Dashboard — **nur in
diese Richtung** (Shoot Day → Dashboard). Code: [`shoot-day-wd.mjs`](../../../apps/shoot-day/examples/shoot-day-wd.mjs).

| Shoot Day / Babel | → Work Dashboard |
|---|---|
| Kunde (Name, E-Mail) | Kunde (gleichnamiger vorhandener Kunde wird übernommen, Groß/Klein egal — keine Dublette) |
| Projekt | Projekt dieses Kunden |
| Termin (Projektdatum) | Aufgabe „Termin: <Projekt>“ mit Start-/Fälligkeitsdatum |
| Idee mit `#todo` | je eine Aufgabe (Titel = Ideentext ohne Datum, Labels = Tags; erledigt = Status done) |
| andere offene Ideen, Telefon/Firma/Notizen des Kunden | Beschreibung der Aufgabe „Ideen & Notizen“ |
| Storyboards, Shotlist, Skript, Tagesplan, Packliste | kurze Zusammenfassung in der Aufgabe „Drehvorbereitung“ |
| Babel-Gespräch (Zusammenfassung + Tipp-Karten) | ein Kommentar an „Termin: …“ (ohne Datum an „Gespräche“) |

- **Wann:** 10 s nach der letzten Änderung an einem Projekt/Kunden, und auf Knopfdruck mit `POST /api/wd/sync`
  (alles). Gesendet wird nur, was sich geändert hat (Inhalts-Hash je Eintrag); ein zweiter Abgleich ohne
  Änderung schickt nichts. Die Zuordnung (IDs drüben) steht in der Datendatei bei Kunde/Projekt (`wdId`, `wdTasks`).
- **Nie löschen:** Ein in Shoot Day gelöschtes Projekt bzw. ein gelöschter Kunde wird drüben **archiviert**; eine
  gelöschte `#todo`-Idee lässt ihre Aufgabe stehen, mit dem Vermerk „(in Shoot Day gelöscht)“. Wird ein Projekt zu
  einem anderen Kunden verschoben, wird das alte Dashboard-Projekt archiviert und beim neuen Kunden neu angelegt.
  Kunde „Ohne Zuordnung“ und seine Projekte werden nicht übertragen.
- **Fehler:** Speichern klappt immer; der Abgleich wird mit wachsendem Abstand wiederholt (30 s, 2, 10, 30 min),
  danach bei der nächsten Änderung. `GET /api/wd/status` → `{enabled, lastSync, lastError, pending}`; das
  Web-Terminal zeigt in der Projektansicht „Work Dashboard: verbunden / aus / Fehler“. Adresse und Token stehen
  nie im Log.
- **Gespräche aus Babel:** Der babel-llm-proxy legt nach jeder Zusammenfassung die Zusammenfassung und die
  Tipp-Karten mit `POST /api/projects/<id>/talks` beim aktuellen Projekt des Kunden ab (höchstens 100 je Projekt);
  der Abgleich macht aus jedem Gespräch genau einen Kommentar.

### Einrichten (einmalig)

1. **Im Work Dashboard** ein Agent-Token anlegen, Name **„Shoot Day Sync“**. Das Token (beginnt mit `wd_`) gleich
   kopieren — es wird nur einmal angezeigt.
2. **Am Spark** in `~/shoot-day/.env` (bzw. in deiner env-Datei, Standard `~/.config/quietglass/shoot-day.env`)
   eintragen und den Dienst neu starten:

   ```bash
   $EDITOR ~/shoot-day/.env
   #   SHOOT_WD_URL=https://<adresse-deines-work-dashboards>
   #   SHOOT_WD_TOKEN=wd_…
   systemctl --user restart shoot-day
   systemctl --user is-active shoot-day
   journalctl --user -u shoot-day -n 5 --no-pager      # "Work Dashboard sync: on"
   ```
3. **Einmal alles abgleichen:**

   ```bash
   curl -s -X POST http://127.0.0.1:8896/api/wd/sync      # (mit Token: -H "Authorization: Bearer …")
   curl -s http://127.0.0.1:8896/api/wd/status            # lastError: null
   ```

   Danach im Work Dashboard nachsehen: Kunden, Projekte und Aufgaben sind da; jeder Schreibzugriff steht dort im
   Audit-Log unter „Shoot Day Sync“. Ausschalten: beide Zeilen leeren und neu starten.

## Update auf 0.5.0 (Kunden) — mit Sicherung

0.5.0 stellt die Datendatei auf Version 2 um (Kunden → Projekte). Der Server legt vorher selbst eine Sicherung
`<DATA_FILE>.bak-v1-<Zeit>` an und startet nicht, wenn das nicht klappt. Trotzdem vorher von Hand sichern:

```bash
D=$(grep '^DATA_FILE=' ~/.config/quietglass/shoot-day.env | cut -d= -f2)
cp -a "$D" "$D.vor-0.5.0-$(date +%Y%m%d-%H%M)"          # eigene Sicherung
cd ~/quietglass-g2 && git pull --ff-only                  # neuer Code (Server + shoot-day-pdf.mjs + Terminal)
$EDITOR ~/.config/quietglass/shoot-day.env                # neue Variablen eintragen (s. o., alle optional)
systemctl --user restart shoot-day
systemctl --user is-active shoot-day
journalctl --user -u shoot-day -n 20 --no-pager           # "migrating data to version 2 … backup: …"
ls -l "$(dirname "$D")"                                   # *.bak-v1-* da, Datendatei mit "version": 2
curl -s http://127.0.0.1:8896/api/customers | head -c 300 # (mit Token: -H "Authorization: Bearer …")
```

Danach im Web-Terminal die Projekte unter „Ohne Zuordnung“ ihren Kunden zuordnen (Projektseite → Kunde). Zurück
auf 0.4: Dienst stoppen, die `.bak-v1-*`-Datei wieder als `DATA_FILE` einsetzen, alten Code auschecken. Sichere
künftig `DATA_FILE` **und** `SHOOT_FILES_DIR` (dort liegen die hochgeladenen PDFs).

## Google Kalender

Jedes Projekt mit Datum wird automatisch als **ein** Termin in deinen Google-Kalender geschrieben (Titel
„Kunde – Projekt“, Ort, Telefon/E-Mail, Anzahl offener Ideen). Ändern oder Löschen im Shoot Day ändert bzw. löscht
den Termin. Datumsformate: `2026-10-14 10:30`, `2026-10-14` (ganztägig), `14.10.2026 10:30`. Ohne lesbares Datum
gibt es keinen Termin. Die Verbindung läuft über ein kleines Google-Apps-Script (läuft als du, kein Cloud-Projekt nötig).

1. <https://script.google.com> öffnen → **Neues Projekt**.
2. Den Inhalt von [`google-calendar-bridge.gs`](google-calendar-bridge.gs) einfügen (alten Code ersetzen).
3. In `setup()` ein **eigenes Geheimwort** eintragen, oben `setup` auswählen und **Ausführen** → Zugriff auf den
   Kalender erlauben. Danach das Geheimwort wieder aus dem Code löschen (es steht jetzt in den Skripteigenschaften).
4. **Bereitstellen → Neue Bereitstellung → Typ: Web-App**, *Ausführen als: Ich*, *Zugriff: Jeder* → **Bereitstellen** →
   die URL (endet auf `/exec`) kopieren. Das Geheimwort schützt die URL.
5. In `~/shoot-day/.env` (bzw. der env-Datei des Dienstes) eintragen:
   `SHOOT_GCAL_WEBHOOK=<die /exec-URL>` und `SHOOT_GCAL_SECRET=<dein Geheimwort>`.
6. Dienst neu starten: `systemctl --user restart shoot-day`.
7. Bestehende Projekte einmal übertragen: `curl -X POST http://127.0.0.1:8896/api/gcal/sync` (mit Token:
   `-H "Authorization: Bearer …"`). Mehrfaches Aufrufen ist harmlos.

Kontrolle: `GET /api/gcal/status` → `{enabled, lastSync, lastError, pending}`; im Web-Terminal steht auf der Projektseite
eine Zeile „Google Kalender: verbunden / aus / Fehler“. Schlägt das Schreiben fehl (Google nicht erreichbar), wird das
Projekt trotzdem gespeichert und der Dienst versucht es mit wachsenden Pausen erneut. Nach Änderungen am Script:
Bereitstellen → Bereitstellungen verwalten → neue Version derselben Bereitstellung (die URL bleibt).

## English

Backend for the Shoot Day app (customers, projects, storyboards, takes, ideas, schedule, packing list, files, web
terminal, voice via Whisper). Code stays in `apps/shoot-day/examples/` (`shoot-day-server.mjs`,
`shoot-day-pdf.mjs`, `shoot-day-terminal.html`). Env file with a full `DATA_FILE` path and your Tailscale login in
`SD_TAILSCALE_USERS`; optional `SHOOT_LLM_URL` (storyboard from PDF), `SHOOT_BABEL_URL` (Babel memory on the
customer card), `SHOOT_FILES_DIR`, `SHOOT_MAX_UPLOAD_MB`, and `SHOOT_WD_URL` + `SHOOT_WD_TOKEN` for the one-way
Work Dashboard mirror (customers, projects, dates, #todo ideas, notes, shoot prep, Babel talks as comments; via its
MCP endpoint, debounced 10 s, only changes, never deletes; `POST /api/wd/sync`, `GET /api/wd/status`; takes are not mirrored). Install the user unit; publish `127.0.0.1:8896` with
`tailscale serve --bg --https=8445 http://127.0.0.1:8896`. **Updating to 0.5.0** migrates the data file to
customers; it writes `DATA_FILE.bak-v1-<time>` first (and refuses to start without it) — still copy the file
yourself before `git pull` and `systemctl --user restart shoot-day`, then check the journal for the migration line.

**Glasses app 0.7.0 behaviour (needs this server for one call).** Side menu: *Help*, *Delete last take*, *Send recording*,
*Discard recording*; customer list on top; 2× while speaking parks the recording (menu sends or discards it); risky
actions are armed (first tap announces, second within 4 s runs); first start without an address is a demo. *Delete last
take* calls `POST /api/take/delete {scene, shot, n}` (optional `?project=<id>`, like the other take endpoints): it removes
exactly that take of the active project, answers `{ok:true, deleted:{…}}`, or 404 `unknown take`. An older server answers
404 to it and the glasses report "server reports an error" — update the service (`git pull`, `systemctl --user restart shoot-day`).
Google Calendar: each project with a date is written as one event through an Apps Script web app
(`google-calendar-bridge.gs`, runs as you). Set `SHOOT_GCAL_WEBHOOK` (its /exec URL) and `SHOOT_GCAL_SECRET`, restart,
then `POST /api/gcal/sync` once. Status: `GET /api/gcal/status`.
