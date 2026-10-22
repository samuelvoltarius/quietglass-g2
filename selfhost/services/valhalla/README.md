# valhalla — your own routing for OpenGlance Nav and NextStop

Valhalla calculates routes for **car, bicycle and walking**. It **cannot** do timetables: public transport comes
from Transitous/MOTIS, for which you do not have to host anything. Without your own server, the apps use the public
FOSSGIS server. Your own is faster, unlimited, and does not pass on your positions.

| Local | Tailscale port (suggestion) | Build variable |
|---|---|---|
| `127.0.0.1:8112` | `8455` | `VITE_ROUTER_URL=https://<your-machine>.<your-tailnet>.ts.net:8455` |

The apps ask with **GET** `…/route?json={…}`. That is a "simple" request without a CORS preflight. Valhalla
sends `Access-Control-Allow-Origin: *`, and nothing more is needed. (Valhalla answers an `OPTIONS` with 405, which
does not matter for GET.)

## Install

Requirements: Docker with `docker compose`, enough disk space (a country: 5–10 GB, Europe: ~70 GB) and RAM.

```bash
cd selfhost/services/valhalla
cp .env.example .env && $EDITOR .env      # choose the region (TILE_URLS) and RAM
docker compose up -d
docker compose logs -f                    # on the first start: load the map + build tiles (minutes to hours)
```

It is ready as soon as the server is listening in the log and this answers:

```bash
curl -s http://127.0.0.1:8112/status
curl -s 'http://127.0.0.1:8112/route?json={"locations":[{"lat":47.8,"lon":13.04},{"lat":47.81,"lon":13.06}],"costing":"auto"}' | head -c 300
```

Then publish it (never `serve reset`):

```bash
tailscale serve --bg --https=8455 http://127.0.0.1:8112
tailscale serve status
```

## Maintenance

- Update the map: in the folder `custom_files/`, delete the `*.osm.pbf` and `valhalla_tiles*` (or temporarily set
  `force_rebuild=True` in `docker-compose.yml`), then `docker compose up -d --force-recreate`.
- Change the region: adjust `TILE_URLS` and rebuild. The tiles are then created anew.
- Elevation data (more accurate consumption on mountains) is off. For a small region, `build_elevation=True` in the
  compose file can help.
- Reference setup: Valhalla 3.5.1 (docker-valhalla by nilsnolde), Europe extract (~35 GB of tiles, 48 GB RAM cap).
