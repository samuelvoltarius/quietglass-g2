# chargers — Ladestationen für OpenGlance aus amtlichen Verzeichnissen (nur Lesen, nur Tailnet)

Ohne diesen Dienst fragt OpenGlance die **öffentlichen Overpass-Server** (OpenStreetMap). Die sind kostenlos, aber
oft ausgelastet (406/429/504, Timeouts) – dann gibt es keine Ladestationen. Mit dem Dienst kommen sie von deinem
eigenen Rechner, aus einer Tabelle, die einmal täglich aus den **amtlichen Verzeichnissen** gefüllt wird:

| Land | Quelle | Preise |
|---|---|---|
| Österreich | E-Control Ladestellenverzeichnis (API-Schlüssel bei E-Control beantragen) | Ad-hoc-Preis je Ladepunkt |
| Deutschland | Ladesäulenregister der Bundesnetzagentur (CSV, monatlich) | keine (das Register enthält keine) |

```
 Brille ◄─ iPhone ◄─ tailscale serve :8464 ◄─ glance_server.py (127.0.0.1:8467) ◄─ SQLite (Tabelle station)
                                                                                    ▲
                                                       täglicher Sammler (E-Control / BNetzA) schreibt
```

| lokal | Tailscale-Port (Vorschlag) | Build-Variable (`config.json`) |
|---|---|---|
| `glance_server.py` `127.0.0.1:8467` | `8464` | `VITE_CHARGERS_URL` (`services.chargers`) |

**Straßennamen** brauchen keinen eigenen Dienst: Der private Build holt sie mit `VITE_STREETS_URL` vom eigenen
Valhalla ([`../valhalla`](../valhalla), `trace_attributes` mit der Routenform, ein GET ohne Preflight). Das macht
`build-private.mjs` automatisch, sobald `services.valhalla` gesetzt ist. Die Straßen *rund um* die Route kommen
weiter von Overpass, wenn es antwortet.

## Schnittstelle (falls du einen eigenen Server dafür schreibst)

```
GET /chargers?lat=47.8095&lon=13.0550&radius=15000     # Umkreis in Metern, max. 50 km
GET /chargers?boxes=s,w,n,e;s,w,n,e;…                  # Kästen entlang der Route, max. 40, je ≤ 1°
GET /health                                            # Zähler, ohne Anmeldung
```

Antwort = Format einer Overpass-Abfrage `out center tags`, damit die App ihren Parser behält:

```json
{"elements":[{"type":"node","id":"AT*ABC*E1","lat":47.80,"lon":13.05,
  "tags":{"amenity":"charging_station","name":"Ladepark","operator":"Betreiber",
          "charging_station:output":"300 kW","capacity":"4","socket:type2_combo":"4",
          "x:price_eur_kwh":"0.59"}}]}
```

* Mehrere Ladepunkte am selben Ort vom selben Betreiber = **ein** Element (Leistung = stärkster Punkt, Preis = Preis
  des stärksten Punkts). Preise unter 0,10 € oder über 3 € je kWh werden weggelassen (fast immer Meldefehler).
* **Anmeldung:** `tailscale serve` verbindet von Loopback und setzt `Tailscale-User-Login`; vertraut wird dem Kopf
  nur von Loopback und nur für Logins aus `GLANCE_TAILSCALE_USERS`. Alternativ `Authorization: Bearer <GLANCE_TOKEN>`.
  Ohne beides: alles 401.
* **CORS:** Die App fragt mit einfachem GET ohne eigene Kopfzeilen (kein Preflight). `Access-Control-Allow-Origin`
  kommt bei jeder Antwort, auch bei 401. `OPTIONS` antwortet 204 **ohne Body**.

## Referenz-Implementierung

[`glance.py`](glance.py) (Abfrage, Zusammenfassen, Format) und [`glance_server.py`](glance_server.py) (HTTP, Anmeldung,
CORS) – Python 3.10+, nur Standardbibliothek. Sie lesen eine SQLite-Datei (`TARIF_DB`) mit dieser Tabelle:

```sql
CREATE TABLE station (
  evse_id TEXT PRIMARY KEY, land TEXT, lat REAL NOT NULL, lon REAL NOT NULL,
  name TEXT, betreiber TEXT, kw REAL, ladepunkte INTEGER,
  stecker TEXT,          -- z. B. "CCS_2;TYPE_2_AC" oder "DC Fahrzeugkupplung Typ Combo 2 (CCS)"
  status TEXT,           -- leer, "ACTIVE" oder "In Betrieb" = anzeigen; alles andere nicht
  quelle TEXT, stand TEXT);
CREATE INDEX idx_station_geo ON station(lat, lon);
```

Preise sind optional: gibt es zusätzlich die Tabellen `tarif`/`regel` (Ad-hoc-Tarif, `quelle_typ='amtlich'`,
`station_id` = EVSE-ID), werden sie dazugelesen; sonst kommen die Stationen ohne Preis. Füllen musst du die Tabelle
selbst (z. B. täglich aus der E-Control-API `GET /charge/1.0/search?latitude=…&longitude=…&radius=<km>`, Kopfzeile
`Apikey`; **höchstens 100 Stationen je Abfrage** – in Städten Zellen vierteln, bis eine Abfrage < 100 liefert, sonst
fehlen Stationen still).

```bash
sudo install -d /opt/ev-glance && sudo cp glance.py glance_server.py /opt/ev-glance/
# systemd (Vorlage):
cat <<'EOF' | sudo tee /etc/systemd/system/ev-glance.service
[Unit]
Description=Ladestationen fuer OpenGlance (nur lesen)
After=network-online.target

[Service]
WorkingDirectory=/opt/ev-glance
Environment=TARIF_DB=/opt/ev-glance/stations.db
Environment=GLANCE_HOST=127.0.0.1
Environment=GLANCE_PORT=8467
Environment=GLANCE_TAILSCALE_USERS=you@example.com
ExecStart=/usr/bin/python3 -u /opt/ev-glance/glance_server.py
Restart=always
MemoryMax=256M
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/opt/ev-glance

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload && sudo systemctl enable --now ev-glance
sudo tailscale serve --bg --https=8464 http://127.0.0.1:8467    # nie "serve reset"
tailscale serve status                                         # zurücklesen
```

Prüfen (vom Handy/PC im Tailnet, angemeldet): `https://<server>.<tailnet>.ts.net:8464/chargers?lat=47.8095&lon=13.055&radius=15000`
→ 200 mit `elements`. Direkt auf dem Server ohne Kopf: `curl http://127.0.0.1:8467/chargers?lat=47.8&lon=13&radius=1000` → 401.

---

<a name="english"></a>
## English (short)

Charging stations for OpenGlance from official registers (Austria: E-Control incl. ad-hoc prices; Germany:
Bundesnetzagentur), served read-only from your own machine instead of the often overloaded public Overpass servers.
`GET /chargers?lat&lon&radius` or `?boxes=s,w,n,e;…`, answered in Overpass element format plus `x:price_eur_kwh`.
Auth via `Tailscale-User-Login` from loopback (`GLANCE_TAILSCALE_USERS`) or `GLANCE_TOKEN`; simple GETs, no
preflight; 204 without body for OPTIONS. Put the address in `config.json` as `services.chargers`; street names come
from your own Valhalla automatically (`VITE_STREETS_URL`).
