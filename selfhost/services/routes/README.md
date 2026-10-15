# routes — gespeicherte OpenGlance-Routen auf Handy und PC (nur Tailnet)

Ein kleiner Speicher für die Routen, die man in OpenGlance plant (Start, bis zu drei Stopps, Ziel, Verkehrsmittel).
Er liefert außerdem eine **Planungsseite für den PC** aus: dieselbe Planung wie auf der Handy-Seite, mit Karte und
Ladestationen. Was am PC gespeichert wird, steht auf der Brille in der Zielliste. Was am Handy gespeichert oder
gelöscht wird, sieht man auch am PC.

```
 PC-Browser ──► tailscale serve :8465 ──► routes_server.py (127.0.0.1:8468) ──► routes.json
 Brille/iPhone ─┘   (Seite + /routes)                 ▲ Seite = apps/openglance-nav/dist-pc (npm run build:pc)
```

| lokal | Tailscale-Port (Vorschlag) | Build-Variable (`config.json`) |
|---|---|---|
| `routes_server.py` `127.0.0.1:8468` | `8465` | `VITE_ROUTES_URL` (`services.routes`) |

## Schnittstelle

```
GET  /routes        {"routes":[…], "deleted":[{"id":"…","at":<ms>}]}
POST /routes        gleicher Aufbau als Text-Body (kein Preflight); wird zusammengeführt, Antwort = Ergebnis
GET  /health        Zähler, ohne Anmeldung
GET  /              Planungsseite (Ordner ROUTES_WEB)
```

Zusammenführen: je Route gewinnt die zuletzt geänderte Fassung (`updated`), eine Löschung schlägt jede ältere
Fassung (180 Tage gemerkt), behalten werden die 20 zuletzt geänderten Routen. Dieselben Regeln stehen in der App
(`mergeRoutes()` in `src/trip/saved.ts`), deshalb ist es egal, wer zusammenführt.

**Anmeldung** wie bei den anderen Diensten: `Tailscale-User-Login` nur von Loopback und nur für Logins aus
`ROUTES_TAILSCALE_USERS`, alternativ `Authorization: Bearer <ROUTES_TOKEN>`. Ohne beides ist alles gesperrt,
auch die Seite.

## Einrichten

```bash
cd apps/openglance-nav
VITE_ROUTER_URL=https://<server>:8455 VITE_CHARGERS_URL=https://<server>:8464 npm run build:pc
# dist-pc/ nach /opt/glass-routes/web kopieren, routes_server.py nach /opt/glass-routes/
ROUTES_TAILSCALE_USERS=du@example.com ROUTES_FILE=/opt/glass-routes/data/routes.json \
  ROUTES_WEB=/opt/glass-routes/web python3 routes_server.py
tailscale serve --bg --https=8465 http://127.0.0.1:8468
```

Danach `services.routes` in `selfhost/config.json` setzen und OpenGlance mit `build-private.mjs` neu bauen.
