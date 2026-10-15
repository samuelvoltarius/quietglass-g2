# star-bridge — N.I.N.A.-Brücke für Star Glass

N.I.N.A. läuft auf dem Aufnahme-Rechner (Windows), das Handy kann überall sein. Die Brücke läuft **auf dem
Rechner mit N.I.N.A.**, liest das Plugin **Advanced API** (`http://127.0.0.1:1888/v2/api`) und liefert dem Handy
einen kompakten Status plus ein kleines Vorschaubild. „Sequenz anhalten / fortsetzen“ ist **aus**, bis du
`STAR_ALLOW_CONTROL=1` setzt – und wird ohne Anmeldung (`STAR_TAILSCALE_USERS` oder `TOKEN`) trotzdem verweigert.
Wetterstation und Safety-Monitor aus N.I.N.A. gehen automatisch mit in den Status. Den Standort (für die
Wettervorhersage in der App) gibt die Brücke nur mit `STAR_SITE=1` weiter, auf 2 Nachkommastellen (~1 km) gerundet.
**Der Code liegt im Repo und wird nicht kopiert:**
[`apps/star-glass/examples/star-bridge.mjs`](../../../apps/star-glass/examples/star-bridge.mjs)
(Node ≥ 18, keine Abhängigkeiten). Zum Testen ohne Teleskop: `mock-nina.mjs` im selben Ordner.

**Zugriff nur über Tailscale:** die Brücke lauscht auf `127.0.0.1`, freigegeben wird sie mit `tailscale serve`
(nur im eigenen Tailnet). Tailscale setzt den Kopf `Tailscale-User-Login`; die Brücke vertraut ihm nur von Loopback.

| lokal | Tailscale-Port (Vorschlag) | App-Feld / Build |
|---|---|---|
| `127.0.0.1:8893` | `8460` | „Bridge-Adresse“ = `https://<rechner>.<tailnet>.ts.net:8460` (`VITE_STAR_URL`) |

## Windows (der übliche Fall: N.I.N.A.-Rechner)

Benutzer-Autostart ohne Aufgabenplanung: eine Neustart-Schleife, versteckt gestartet aus dem Autostart-Ordner.

```powershell
git clone https://github.com/samuelvoltarius/quietglass-g2 C:\path\to\quietglass-g2
mkdir $env:LOCALAPPDATA\quiet-hub -Force
copy star-bridge-loop.example.cmd $env:LOCALAPPDATA\quiet-hub\star-bridge-loop.cmd   # Pfad + Login anpassen
copy "Star Glass Bridge.example.vbs" "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\Star Glass Bridge.vbs"
wscript "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\Star Glass Bridge.vbs"
tailscale serve status                                          # erst lesen: welche Ports sind belegt?
tailscale serve --bg --https=8460 http://127.0.0.1:8893         # nie "serve reset"
tailscale serve status
```

Log: `%LOCALAPPDATA%\quiet-hub\star-bridge.log`. Selbsttest von einem anderen Gerät im Tailnet:
`curl https://<rechner>.<tailnet>.ts.net:8460/api/star` → JSON mit `"online": true`.
Direkt auf `127.0.0.1:8893` ohne Kopf kommt absichtlich `401`.

## Linux (Brücke auf einem anderen Rechner im selben Netz)

Geht auch: `STAR_NINA=http://<nina-pc>:1888` (das Plugin muss dann im LAN lauschen). Dienst wie die anderen:
`star-bridge.service` (Anleitung im Dateikopf).

## Umzug auf einen anderen Aufnahme-Rechner

Nur die Brücke dort installieren (oben), `tailscale serve` dort einrichten und einen neuen Privat-Build mit der
neuen Adresse bauen (`services.star` in `selfhost/config.json`, dann `node selfhost/build-private.mjs star-glass`).

## English

Bridge between N.I.N.A.'s Advanced API plugin and the phone; run it on the imaging PC. Code stays in
`apps/star-glass/examples/star-bridge.mjs`. Set your Tailscale login in `STAR_TAILSCALE_USERS`, optionally
`STAR_ALLOW_CONTROL=1`, start it at log-on (Windows: startup-folder `.vbs` + restart loop; Linux: the user unit)
and publish with `tailscale serve --bg --https=8460 http://127.0.0.1:8893`.
