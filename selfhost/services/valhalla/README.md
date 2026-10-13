# valhalla — eigenes Routing für OpenGlance Nav und NextStop

Valhalla rechnet Routen für **Auto, Fahrrad und zu Fuß** (kann **keine** Fahrpläne – Öffis kommen von
Transitous/MOTIS, wofür du nichts hosten musst). Ohne eigenen Server nutzen die Apps den öffentlichen
FOSSGIS-Server; ein eigener ist schneller, unbegrenzt und gibt deine Positionen nicht weiter.

| lokal | Tailscale-Port (Vorschlag) | Build-Variable |
|---|---|---|
| `127.0.0.1:8112` | `8455` | `VITE_ROUTER_URL=https://<server>.<tailnet>.ts.net:8455` |

Die Apps fragen per **GET** `…/route?json={…}` – das ist ein „einfacher“ Request ohne CORS-Preflight; Valhalla
sendet `Access-Control-Allow-Origin: *`, mehr ist nicht nötig. (Ein `OPTIONS` beantwortet Valhalla mit 405 – bei
GET ist das egal.)

## Installieren

Voraussetzung: Docker mit `docker compose`, ausreichend Platte (Land: 5–10 GB, Europa: ~70 GB) und RAM.

```bash
cd selfhost/services/valhalla
cp .env.example .env && $EDITOR .env      # Region (TILE_URLS) und RAM wählen
docker compose up -d
docker compose logs -f                    # beim ersten Start: Karte laden + Kacheln bauen (Minuten bis Stunden)
```

Fertig, sobald im Log der Server lauscht und das hier Antwort gibt:

```bash
curl -s http://127.0.0.1:8112/status
curl -s 'http://127.0.0.1:8112/route?json={"locations":[{"lat":47.8,"lon":13.04},{"lat":47.81,"lon":13.06}],"costing":"auto"}' | head -c 300
```

Dann freigeben (nie `serve reset`):

```bash
tailscale serve --bg --https=8455 http://127.0.0.1:8112
tailscale serve status
```

## Pflege

- Karte aktualisieren: im Ordner `custom_files/` die `*.osm.pbf` und `valhalla_tiles*` löschen (oder in `docker-compose.yml`
  `force_rebuild=True` kurzzeitig setzen), dann `docker compose up -d --force-recreate`.
- Region ändern: `TILE_URLS` anpassen und neu bauen – die Kacheln werden dann neu erzeugt.
- Höhendaten (genauerer Verbrauch am Berg) sind aus; für eine kleine Region kann `build_elevation=True` in der
  Compose-Datei helfen.

## English

Self-hosted Valhalla (docker-valhalla by nilsnolde) for car/bike/foot routing; no timetables (public transport
comes from Transitous). Copy `.env.example` to `.env`, pick a Geofabrik region and RAM cap, `docker compose up -d`,
wait for the first tile build, check `curl http://127.0.0.1:8112/status`, publish with
`tailscale serve --bg --https=8455 http://127.0.0.1:8112` and build the apps with
`VITE_ROUTER_URL=https://<server>.<tailnet>.ts.net:8455`. The apps use GET `?json=` (no CORS preflight).
Reference setup: Valhalla 3.5.1, Europe extract (~35 GB tiles, 48 GB RAM cap).
