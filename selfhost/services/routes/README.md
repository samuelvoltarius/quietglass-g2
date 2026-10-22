# routes — saved OpenGlance routes on phone and PC (tailnet only)

A small store for the routes you plan in OpenGlance (start, up to three stops, destination, mode of transport).
It also serves a **planning page for the PC**: the same planning as on the phone page, with a map and
charging stations. What is saved on the PC appears in the destination list on the glasses. What is saved or
deleted on the phone is also seen on the PC.

```
 PC browser ──► tailscale serve :8465 ──► routes_server.py (127.0.0.1:8468) ──► routes.json
 Glasses/iPhone ─┘   (page + /routes)                 ▲ page = apps/openglance-nav/dist-pc (npm run build:pc)
```

| Local | Tailscale port (suggestion) | Build variable (`config.json`) |
|---|---|---|
| `routes_server.py` `127.0.0.1:8468` | `8465` | `VITE_ROUTES_URL` (`services.routes`) |

## Interface

```
GET  /routes        {"routes":[…], "deleted":[{"id":"…","at":<ms>}]}
POST /routes        same structure as a text body (no preflight); it is merged, the answer = the result
GET  /health        counters, without sign-in
GET  /              planning page (folder ROUTES_WEB)
```

Merging: for each route, the most recently changed version wins (`updated`), a deletion beats any older
version (remembered for 180 days), and the 20 most recently changed routes are kept. The same rules are in the app
(`mergeRoutes()` in `src/trip/saved.ts`), so it does not matter who merges.

**Sign-in** works as with the other services: `Tailscale-User-Login` only from loopback and only for logins in
`ROUTES_TAILSCALE_USERS`, alternatively `Authorization: Bearer <ROUTES_TOKEN>`. With neither, everything is blocked,
including the page.

## Set-up

```bash
cd apps/openglance-nav
VITE_ROUTER_URL=https://<your-machine>.<your-tailnet>.ts.net:8455 VITE_CHARGERS_URL=https://<your-machine>.<your-tailnet>.ts.net:8464 npm run build:pc
# copy dist-pc/ to /opt/glass-routes/web, and routes_server.py to /opt/glass-routes/
ROUTES_TAILSCALE_USERS=you@example.com ROUTES_FILE=/opt/glass-routes/data/routes.json \
  ROUTES_WEB=/opt/glass-routes/web python3 routes_server.py
tailscale serve --bg --https=8465 http://127.0.0.1:8468
```

Then set `services.routes` in `selfhost/config.json` and rebuild OpenGlance with `build-private.mjs`.
