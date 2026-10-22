# shoot-day — backend for Shoot Day

Stores customers and their projects (storyboards, shot list, takes, ideas, script/teleprompter, day schedule,
packing list, files), serves a **web terminal** for editing on the computer, and sends voice commands to Whisper.
**The code is in the repo and is not copied:**
[`apps/shoot-day/examples/shoot-day-server.mjs`](../../../apps/shoot-day/examples/shoot-day-server.mjs)
(Node ≥ 18, no dependencies), together with `shoot-day-terminal.html` and `shoot-day-pdf.mjs` (PDF text, storyboard
suggestion) in the same folder. Optionally, an MCP server for agents: [`dreh_mcp.py`](../../../apps/shoot-day/examples/dreh_mcp.py).

| Local | Tailscale port (suggestion) | App field / build |
|---|---|---|
| `127.0.0.1:8896` | `8445` | "Server address" (Serveradresse) = `https://<your-machine>.<your-tailnet>.ts.net:8445` |

You reach the web terminal in the browser at the same address (inside the tailnet). Voice commands need the
[whisper](../whisper) service (`WHISPER_URL`). Otherwise voice is off.

## Environment variables (`~/.config/quietglass/shoot-day.env`)

| Variable | Default | Purpose |
|---|---|---|
| `PORT`, `HOST` | `8896`, `127.0.0.1` | Address. Anything other than loopback only with `TOKEN` |
| `DATA_FILE` | – (enter the full path) | Customers, projects, takes ... (one JSON file) |
| `SHOOT_FILES_DIR` | `shoot-day-files` next to `DATA_FILE` | Uploaded PDFs/images, one folder per project |
| `SHOOT_MAX_UPLOAD_MB` | `20` | Largest file |
| `WHISPER_URL` | – | Speech recognition. Empty = voice off |
| `PRESET_LANG` | `en` | `de` = German packing list and the customer "Ohne Zuordnung" (Unassigned) |
| `SHOOT_LLM_URL` | – | OpenAI-compatible language model (`…/v1`) for "Storyboard from PDF". Empty = enter by hand |
| `SHOOT_LLM_MODEL`, `SHOOT_LLM_TOKEN` | – | Model name and bearer token for it (optional) |
| `SHOOT_BABEL_URL` | – | babel-llm-proxy (`https://host:port` or `…/v1`): the card "Customer before the appointment" (Kunde vor dem Termin) shows Babel's memory about the customer (`POST /memory/search`, from the server). Empty = no Babel section |
| `SHOOT_BABEL_TOKEN` | – | Bearer token for the Babel proxy (optional) |
| `SHOOT_WD_URL` | – | Work Dashboard (base address, for example `https://work.example.org`; MCP at `…/mcp`). Empty = no sync |
| `SHOOT_WD_TOKEN` | – | Agent token from the Work Dashboard (`wd_…`). Without a token, no sync |
| `SHOOT_WD_DEBOUNCE_MS` | `10000` | Wait after the last change before syncing |
| `SHOOT_WD_STATUS_OPEN`, `SHOOT_WD_STATUS_DONE` | `open`, `done` | Status names of the tasks in the Work Dashboard (change only if it uses other names) |
| `SHOOT_GCAL_WEBHOOK`, `SHOOT_GCAL_SECRET` | – | Google Calendar bridge (section "Google Calendar"). Empty = off |
| `SHOOT_GCAL_CALENDAR`, `SHOOT_GCAL_DURATION_MIN`, `SHOOT_TZ` | default calendar, `60`, `Europe/Vienna` | Optional: calendar ID, appointment length in minutes, time zone of the dates |
| `SD_TAILSCALE_USERS`, `TOKEN` | – | Access (Tailscale login without a token, otherwise a token) |

The real addresses of your services belong only in the env file, never in the repo.

## Install

```bash
git clone https://github.com/samuelvoltarius/quietglass-g2 ~/quietglass-g2     # if not there yet
mkdir -p ~/.config/quietglass ~/.local/state/quietglass/shoot-day ~/.config/systemd/user
cp .env.example ~/.config/quietglass/shoot-day.env && chmod 600 ~/.config/quietglass/shoot-day.env
$EDITOR ~/.config/quietglass/shoot-day.env    # DATA_FILE with the full path, SD_TAILSCALE_USERS = your login
cp shoot-day.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now shoot-day
loginctl enable-linger "$USER"
systemctl --user is-active shoot-day
tailscale serve --bg --https=8445 http://127.0.0.1:8896      # never "serve reset"
tailscale serve status
```

## Work Dashboard

Everything that Shoot Day and Babel know about customers also appears in your own Work Dashboard, **in this
direction only** (Shoot Day → Dashboard). Code: [`shoot-day-wd.mjs`](../../../apps/shoot-day/examples/shoot-day-wd.mjs).

| Shoot Day / Babel | → Work Dashboard |
|---|---|
| Customer (name, email) | Customer (an existing customer with the same name is reused, case does not matter, so no duplicate) |
| Project | Project of this customer |
| Appointment (project date) | Task "Termin: <project>" ("Appointment: <project>") with a start/due date |
| Idea with `#todo` | One task each (title = idea text without the date, labels = tags; done = status done) |
| Other open ideas, the customer's phone/company/notes | Description of the task "Ideen & Notizen" ("Ideas & notes") |
| Storyboards, shot list, script, day schedule, packing list | Short summary in the task "Drehvorbereitung" ("Shoot preparation") |
| Babel talk (summary + tip cards) | One comment on "Termin: …" (without a date, on "Gespräche" ("Talks")) |

- **Takes** are not mirrored.
- **When:** 10 s after the last change to a project/customer, and on demand with `POST /api/wd/sync`
  (everything). Only what has changed is sent (content hash per entry). A second sync without
  changes sends nothing. The mapping (IDs on the other side) is stored in the data file on the customer/project (`wdId`, `wdTasks`).
- **Never delete:** A project or customer deleted in Shoot Day is **archived** over there. A deleted `#todo` idea
  leaves its task in place, with the note "(in Shoot Day gelöscht)" ("deleted in Shoot Day"). If a project is moved to
  another customer, the old Dashboard project is archived and created anew under the new customer.
  The customer "Ohne Zuordnung" (Unassigned) and its projects are not transferred.
- **Errors:** Saving always works. The sync is repeated with growing gaps (30 s, 2, 10, 30 min),
  then at the next change. `GET /api/wd/status` → `{enabled, lastSync, lastError, pending}`. In the project view,
  the web terminal shows "Work Dashboard: verbunden / aus / Fehler" ("connected / off / error"). The address and token
  never appear in the log.
- **Talks from Babel:** After each summary, the babel-llm-proxy stores the summary and the
  tip cards with `POST /api/projects/<id>/talks` on the customer's current project (at most 100 per project).
  The sync turns each talk into exactly one comment.

### Set-up (one time)

1. **In the Work Dashboard**, create an agent token named **"Shoot Day Sync"**. Copy the token (it starts with `wd_`)
   right away. It is shown only once.
2. **On the Spark**, enter it in `~/shoot-day/.env` (or in your env file, default `~/.config/quietglass/shoot-day.env`)
   and restart the service:

   ```bash
   $EDITOR ~/shoot-day/.env
   #   SHOOT_WD_URL=https://<address-of-your-work-dashboard>
   #   SHOOT_WD_TOKEN=wd_…
   systemctl --user restart shoot-day
   systemctl --user is-active shoot-day
   journalctl --user -u shoot-day -n 5 --no-pager      # "Work Dashboard sync: on"
   ```
3. **Sync everything once:**

   ```bash
   curl -s -X POST http://127.0.0.1:8896/api/wd/sync      # (with a token: -H "Authorization: Bearer …")
   curl -s http://127.0.0.1:8896/api/wd/status            # lastError: null
   ```

   Then check in the Work Dashboard: customers, projects and tasks are there. Every write access appears in the
   audit log there under "Shoot Day Sync". To switch it off: empty both lines and restart.

## Update to 0.5.0 (customers), with a backup

0.5.0 changes the data file to version 2 (customers → projects). The server first makes a backup itself,
`<DATA_FILE>.bak-v1-<time>`, and does not start if that fails. Still make a backup by hand beforehand:

```bash
D=$(grep '^DATA_FILE=' ~/.config/quietglass/shoot-day.env | cut -d= -f2)
cp -a "$D" "$D.vor-0.5.0-$(date +%Y%m%d-%H%M)"          # your own backup
cd ~/quietglass-g2 && git pull --ff-only                  # new code (server + shoot-day-pdf.mjs + terminal)
$EDITOR ~/.config/quietglass/shoot-day.env                # enter the new variables (see above, all optional)
systemctl --user restart shoot-day
systemctl --user is-active shoot-day
journalctl --user -u shoot-day -n 20 --no-pager           # "migrating data to version 2 … backup: …"
ls -l "$(dirname "$D")"                                   # *.bak-v1-* is there, data file has "version": 2
curl -s http://127.0.0.1:8896/api/customers | head -c 300 # (with a token: -H "Authorization: Bearer …")
```

Afterwards, in the web terminal, assign the projects under "Ohne Zuordnung" (Unassigned) to their customers (project
page → customer). To go back to 0.4: stop the service, put the `.bak-v1-*` file back as `DATA_FILE`, and check out the
old code. In future, back up `DATA_FILE` **and** `SHOOT_FILES_DIR` (the uploaded PDFs are there).

## Google Calendar

Every project with a date is automatically written to your Google Calendar as **one** appointment (title
"Customer – Project", place, phone/email, number of open ideas). Changing or deleting in Shoot Day changes or
deletes the appointment. Date formats: `2026-10-14 10:30`, `2026-10-14` (all day), `14.10.2026 10:30`. Without a
readable date, there is no appointment. The connection runs through a small Google Apps Script (it runs as you, no
cloud project needed).

1. Open <https://script.google.com> → **New project**.
2. Paste in the contents of [`google-calendar-bridge.gs`](google-calendar-bridge.gs) (replace the old code).
3. In `setup()`, enter your **own secret word**, select `setup` at the top and **Run** → allow access to the
   calendar. Afterwards, delete the secret word from the code again (it is now stored in the script properties).
4. **Deploy → New deployment → Type: Web app**, *Execute as: Me*, *Access: Anyone* → **Deploy** →
   copy the URL (it ends in `/exec`). The secret word protects the URL.
5. Enter in `~/shoot-day/.env` (or the service's env file):
   `SHOOT_GCAL_WEBHOOK=<the /exec URL>` and `SHOOT_GCAL_SECRET=<your secret word>`.
6. Restart the service: `systemctl --user restart shoot-day`.
7. Transfer existing projects once: `curl -X POST http://127.0.0.1:8896/api/gcal/sync` (with a token:
   `-H "Authorization: Bearer …"`). Calling it several times is harmless.

Check: `GET /api/gcal/status` → `{enabled, lastSync, lastError, pending}`. In the web terminal, the project page
shows a line "Google Kalender: verbunden / aus / Fehler" ("Google Calendar: connected / off / error"). If writing fails (Google not reachable), the
project is still saved and the service retries with growing pauses. After changes to the script:
Deploy → Manage deployments → new version of the same deployment (the URL stays).

## Glasses app 0.7.0 behavior (needs this server for one call)

Side menu: *Help*, *Delete last take*, *Send recording*, *Discard recording*; customer list on top; double tap
while speaking parks the recording (the menu sends or discards it); risky actions are armed (the first tap
announces, the second within 4 s runs it); the first start without an address is a demo. *Delete last take*
calls `POST /api/take/delete {scene, shot, n}` (optional `?project=<id>`, like the other take endpoints). It
removes exactly that take of the active project and answers `{ok:true, deleted:{…}}`, or 404 `unknown take`. An
older server answers 404 to it and the glasses report "server reports an error". In that case, update the service
(`git pull`, `systemctl --user restart shoot-day`).
