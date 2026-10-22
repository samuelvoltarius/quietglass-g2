# chargers — charging stations for OpenGlance from official registers (read-only, tailnet only)

Without this service, OpenGlance asks the **public Overpass servers** (OpenStreetMap). They are free, but often
overloaded (406/429/504, timeouts), and then there are no charging stations. With this service, the stations come
from your own machine, from a table that is filled once a day from the **official registers**:

| Country | Source | Prices |
|---|---|---|
| Austria | E-Control charging point register (request an API key from E-Control) | Ad-hoc price per charging point |
| Germany | Charging station register of the Bundesnetzagentur (CSV, monthly) | None (the register has none) |

```
 Glasses ◄─ iPhone ◄─ tailscale serve :8464 ◄─ glance_server.py (127.0.0.1:8467) ◄─ SQLite (table station)
                                                                                    ▲
                                                       daily collector (E-Control / BNetzA) writes
```

| Local | Tailscale port (suggestion) | Build variable (`config.json`) |
|---|---|---|
| `glance_server.py` `127.0.0.1:8467` | `8464` | `VITE_CHARGERS_URL` (`services.chargers`) |

**Street names** need no service of their own. The private build gets them with `VITE_STREETS_URL` from your own
Valhalla ([`../valhalla`](../valhalla), `trace_attributes` with the route shape, a GET without preflight).
`build-private.mjs` does this automatically as soon as `services.valhalla` is set. The streets *around* the route
still come from Overpass, when it answers.

## Interface (in case you write your own server for it)

```
GET /chargers?lat=47.8095&lon=13.0550&radius=15000     # radius in meters, max. 50 km
GET /chargers?boxes=s,w,n,e;s,w,n,e;…                  # boxes along the route, max. 40, each ≤ 1°
GET /health                                            # counters, without sign-in
```

The answer uses the format of an Overpass query `out center tags`, so the app keeps its parser:

```json
{"elements":[{"type":"node","id":"AT*ABC*E1","lat":47.80,"lon":13.05,
  "tags":{"amenity":"charging_station","name":"Ladepark","operator":"Betreiber",
          "charging_station:output":"300 kW","capacity":"4","socket:type2_combo":"4",
          "x:price_eur_kwh":"0.59"}}]}
```

* Several charging points at the same place from the same operator = **one** element (power = the strongest point,
  price = the price of the strongest point). Prices below €0.10 or above €3 per kWh are left out (almost always a
  reporting error).
* **Sign-in:** `tailscale serve` connects from loopback and sets `Tailscale-User-Login`. The header is trusted only
  from loopback and only for logins in `GLANCE_TAILSCALE_USERS`. Alternatively, use `Authorization: Bearer <GLANCE_TOKEN>`.
  With neither: everything gets 401.
* **CORS:** the app asks with a simple GET and no custom headers (no preflight). `Access-Control-Allow-Origin`
  is sent with every answer, also with 401. `OPTIONS` answers 204 **with no body**.

## Reference implementation

[`glance.py`](glance.py) (query, merge, format) and [`glance_server.py`](glance_server.py) (HTTP, sign-in,
CORS). Python 3.10+, standard library only. They read a SQLite file (`TARIF_DB`) with this table:

```sql
CREATE TABLE station (
  evse_id TEXT PRIMARY KEY, land TEXT, lat REAL NOT NULL, lon REAL NOT NULL,
  name TEXT, betreiber TEXT, kw REAL, ladepunkte INTEGER,
  stecker TEXT,          -- e.g. "CCS_2;TYPE_2_AC" or "DC Fahrzeugkupplung Typ Combo 2 (CCS)"
  status TEXT,           -- empty, "ACTIVE" or "In Betrieb" = show; everything else is not shown
  quelle TEXT, stand TEXT);
CREATE INDEX idx_station_geo ON station(lat, lon);
```

Prices are optional. If the tables `tarif`/`regel` also exist (ad-hoc tariff, `quelle_typ='amtlich'`,
`station_id` = EVSE ID), they are read in as well. Otherwise the stations come without a price. You have to fill the
table yourself (for example daily from the E-Control API `GET /charge/1.0/search?latitude=…&longitude=…&radius=<km>`,
header `Apikey`; **at most 100 stations per query**. In cities, split cells into quarters until a query returns
< 100, otherwise stations are silently missing).

```bash
sudo install -d /opt/ev-glance && sudo cp glance.py glance_server.py /opt/ev-glance/
# systemd (template):
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
sudo tailscale serve --bg --https=8464 http://127.0.0.1:8467    # never "serve reset"
tailscale serve status                                         # read it back
```

Check (from the phone/PC in the tailnet, signed in): `https://<your-machine>.<your-tailnet>.ts.net:8464/chargers?lat=47.8095&lon=13.055&radius=15000`
→ 200 with `elements`. Directly on the server without the header: `curl http://127.0.0.1:8467/chargers?lat=47.8&lon=13&radius=1000` → 401.
