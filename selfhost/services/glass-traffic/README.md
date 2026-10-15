# glass-traffic — Stau, Sperren und Baustellen entlang der Route (nur Tailnet)

Ein kleiner Dienst für OpenGlance: die App schickt die **Routenlinie** (nicht die Position), der Dienst fragt die
Verkehrsquellen und antwortet mit den Meldungen **auf der Route**, mit Abstand entlang der Route und einer Summe der
Verzögerung. Die Schlüssel bleiben auf dem Server.

```
 Brille/iPhone ──► tailscale serve :8474 ──► glass_traffic.py (127.0.0.1:8475) ──► TomTom (bbox + wenige Routenpunkte)
   (Routenlinie)                                                               └─► ASFINAG DATEX II (ganzer Strom, alle 2 min)
```

| lokal | Tailscale-Port (Vorschlag) | Build-Variable (`config.json`) |
|---|---|---|
| `glass_traffic.py` `127.0.0.1:8475` | `8474` | `VITE_TRAFFIC_URL` (`services.traffic`) |

Vorschlag Host: **ns1**, neben `glass-routes` (gleiches Muster: systemd-User-Dienst + `tailscale serve`).

## Schnittstelle

```
POST /traffic/route   Body (text/plain, kein Preflight):
                      {"shape": "<polyline, 6 Nachkommastellen>" | [[lat,lon],...], "buffer_m": 60, "precision": 6}
GET  /health          Zähler, welche Quellen eingerichtet sind; ohne Anmeldung, ohne Geheimnisse
```

Antwort:

```json
{"incidents": [{"id": "tt:…", "type": "jam", "delayMin": 9, "lengthKm": 1.5, "from": "…", "to": "…", "text": "Stau",
                "point": [47.8, 13.05], "geometry": [[47.8, 13.05], …], "source": "asfinag+tomtom",
                "alongM": 3750, "offM": 2}],
 "delayMin": 9, "routeM": 15000, "sources": {"tomtom": "ok", "asfinag": "off"}, "at": 1760000000000, "cached": false}
```

- `type`: `jam | closure | roadwork | accident | other`. `alongM` = Meter ab Anfang der geschickten Linie bis zum
  Beginn der Meldung (in Fahrtrichtung), `offM` = Abstand zur Linie.
- **Auf der Route** heißt: die Meldung läuft wirklich *entlang* der Route und in Fahrtrichtung – siehe
  [Zuordnung](#zuordnung-meldung--route). Querstraßen, Parallelstraßen und die Gegenfahrbahn fallen weg.
- **Zusammenführen**: gleiche Art an fast derselben Stelle (≤ 600 m) aus TomTom und ASFINAG wird eine Meldung
  (`source: "asfinag+tomtom"`, die größere Verzögerung gilt); ein Flow-Stau innerhalb von 2 km einer gemeldeten
  Stau-/Sperr-/Unfallmeldung zählt nicht doppelt.
- **Cache**: dieselbe (ausgedünnte) Linie 2 min; TomTom je Rechteck/Punkt 2 min; der ASFINAG-Strom höchstens alle
  2 min (auch ein Fehler wird 2 min gemerkt – kein Sturm auf die Quelle).
- `sources.*`: `off` (nicht eingerichtet), `ok`, `error` (Quelle nicht erreichbar; die App zeigt dann einfach weniger).

### Zuordnung Meldung → Route

Früher reichte ein einziger Meldungspunkt innerhalb von `buffer_m` – dadurch kamen in der Stadt Sperren auf
**Seitenstraßen** durch, die die Route nur kreuzen oder daneben liegen. Jetzt wird die Geometrie der Meldung geprüft
(Werte als Konstanten oben in `glass_traffic.py`):

| Fall | Regel |
|---|---|
| **Linie** (TomTom LineString, Flow-Segment) | in Proben alle ~10 m zerlegt. Eine Probe zählt, wenn sie im **Korridor** liegt *und* ihre Richtung zur Route passt (cos(Winkel) ≥ 0,7; bei Meldungen für **beide Richtungen** auch entgegen). Die zählenden Proben müssen zusammen ≥ **max(60 % der Meldungslänge, 80 m)** lang sein. |
| **kurze Linie** (< 80 m) | muss zu ≥ 80 % eng (≤ 25 m) und in Fahrtrichtung an der Route liegen. |
| **Querung** | wandert die Meldung innerhalb des Korridors seitlich um mehr als 30 m (schräg über die Route), fällt sie weg – auch wenn ein Punkt direkt auf der Route liegt. |
| **nur Start/Ende** (ASFINAG linear, TPEG from/to, 2 Punkte > 200 m auseinander) | beide Enden im Korridor, Ende in Fahrtrichtung *nach* dem Start, Strecke entlang der Route ≥ max(60 % der Luftlinie, 80 m) und ≤ 3 × Luftlinie + 500 m. |
| **Punkt** (keine Linie) | höchstens **25 m** neben der Route. |
| **schon drin** | reicht eine Meldung über den Anfang (oder das Ende) der geschickten Linie hinaus, zählt nur der Teil auf der Linie, mindestens 80 m; `alongM` ist dann 0. Bei Start/Ende-Meldungen muss das fehlende Ende auf der Verlängerung des ersten/letzten Routensegments liegen. |

**Korridor** je Routensegment: **25 m** in der Stadt / auf Landstraßen, **60 m** auf Autobahnen (die
Richtungsfahrbahnen liegen bis ~45 m auseinander) – nie mehr als das `buffer_m` des Clients (Obergrenze). Entschieden
wird in dieser Reihenfolge:

1. Straßenkategorie der Meldung: TomTom-`roadNumbers` (A…/S… = Autobahn/Schnellstraße, andere Nummern = keine),
   TomTom-Flow `frc` (FRC0/FRC1 = Autobahn), ASFINAG (betreibt nur Autobahnen/Schnellstraßen) = immer Autobahn.
2. Ohne Kategorie die Form der Route: ein Segment ist autobahnartig, wenn ±1 km um es herum keine scharfe Kurve liegt
   (> 35° Richtungswechsel innerhalb 60 m – Abbiegen an Kreuzungen, Kreisverkehr). Die App schickt keine Straßenklassen
   und keine Geschwindigkeiten mit.

Grenze der Schätzung: eine schnurgerade Stadtstraße über mehr als 2 km ohne Abbiegen gilt als autobahnartig; eine
Parallelstraße mit gleicher Richtung im Abstand 25–60 m, die ≥ 80 m mitläuft, käme dort durch – Querstraßen und
kurze Stücke nicht.

`alongM` = Meter entlang der Route bis zum **Beginn der Überlappung**, `offM` = kleinster Abstand dort. Die
Antwortform ist unverändert; interne Hinweise (`_autobahn`, `_beide`) gehen nie hinaus.

### Dubletten und Rampen am Knoten

Nach der Zuordnung (und vor dem Ausliefern) laufen zwei Filter:

- **Rampen/Querautobahn** (`_ohne_rampen`): Die App schickt nur Geometrie, die Straße der Route ist unbekannt – sie
  wird aus den Nachbarn abgeleitet. Meldungen tragen intern Straßennummern (`_strassen`: TomTom-`roadNumbers`, nur
  wenn es keine gibt die Nummern aus dem Von/Nach-Text wie „(A8)“). Je Nummer zählt die Überlappung aller *anderen*
  Meldungen mit Nummer innerhalb **1,5 km** entlang der Route (Abstand der Überlappungen); die Nummer mit der längsten Überlappung ist die
  Hauptstraße. Trägt eine Meldung diese Nummer nicht **und** liegt weniger als **200 m** auf der Route, fällt sie weg
  (Rampe oder andere Autobahn am Knoten). Bleibt drin: ≥ 200 m Überlappung (Route wechselt die Autobahn), keine Nummer,
  oder keine Nachbarmeldung mit Nummer. Grenze: eine einzelne Rampensperre ganz ohne Nachbarn lässt sich aus
  Geometrie allein nicht erkennen.
- **Dubletten** (`zusammenfuehren`): gleiche Art innerhalb **300 m** entlang der Route und ähnlicher Von/Nach-Text
  (klein, ohne Satzzeichen, Wortmengen-Jaccard ≥ 0,6) gelten als eine Meldung – auch aus derselben Quelle (zwei
  TomTom-Einträge, Incidents + Flow). Behalten wird die mit `delayMin`, Verzögerung = Maximum. Zwei Quellen
  (z. B. ASFINAG + TomTom) verschmelzen weiter ohne Textvergleich innerhalb 600 m.

**Anmeldung** wie bei den anderen Diensten: `Tailscale-User-Login` nur von Loopback und nur für Logins aus
`TRAFFIC_TAILSCALE_USERS`, alternativ `Authorization: Bearer <TRAFFIC_TOKEN>`. Ohne beides ist alles außer
`/health` gesperrt. CORS: Antwort mit der Origin der Anfrage; OPTIONS → 204.

**Log**: nur Methode, Pfad, Code, Anmeldeform und Dauer – keine Koordinaten, keine Schlüssel (URLs mit `key=` werden
nie ausgegeben, Fehler nur als Typname).

## Quellen

### (a) TomTom (optional, `TOMTOM_KEY`)

- **Traffic Incidents API v5** (`/traffic/services/5/incidentDetails`): je Rechteck um die Route (höchstens
  `TOMTOM_MAX_BOXES`, je < 10 000 km², wie TomTom verlangt), Kategorien Unfall, Stau, Spur gesperrt, Straße gesperrt,
  Baustelle, Pannenfahrzeug, nur aktuelle Meldungen. Verzögerung (`delay`, s) und Länge werden übernommen.
- **Flow Segment Data v4**: an `TOMTOM_FLOW_SAMPLES` Punkten gleichmäßig entlang der Route (Standard 6, 0 = aus);
  deutlich langsamer als frei (≤ 60 % der freien Geschwindigkeit, ≥ 1 min länger, Vertrauen ≥ 0,5) wird ein Stau,
  `roadClosure` eine Sperre.
- Kosten: TomTom zählt Anfragen (Free-Tier, Stand der Doku: 2 500 pro Tag – **bitte bei TomTom prüfen**).
  Pro Routen-Anfrage höchstens `TOMTOM_MAX_BOXES + TOMTOM_FLOW_SAMPLES` Aufrufe, meist weniger dank Cache. Die App
  fragt beim Fahren alle 2 min, vor dem Start je Weg einmal, bei einer Umfahrungsprüfung je Weg einmal.
- TomTom bekommt Rechtecke um die Route und einzelne Punkte **auf** der Route, nie die Position der Brille als solche.

### (b) ASFINAG DATEX II (optional, `ASFINAG_DATEX_URL`)

Recherche (14.10.2026): ASFINAG liefert Verkehrsdaten für alle österreichischen Autobahnen und Schnellstraßen als
**DATEX II**-Ströme (Ereignisse/Verkehrsmeldungen, Baustellen, Netzmanagement, Reisezeiten …). Sie sind **nicht frei
herunterladbar**: Zugang gibt es nach **Registrierung und Vertrag im ASFINAG Content-Portal**
<https://contentportal.asfinag.at/> (früher `services2.asfinag.at/web/trafficdata/`); die Profile sind im
DATEX-II-Verzeichnis beschrieben (repo.datex2.eu, Knoten „ASFINAG – Austria“, z. B. „D2 ASFINAG profile Traffic
Messages / Network Management (uses Ext. LinearByCoordinates)“). Auf data.gv.at und im nationalen Zugangspunkt
mobilitydata.gv.at war kein frei nutzbarer ASFINAG-Meldungsstrom zu finden. Ob der Zugang für Privatpersonen
kostenlos ist, war öffentlich nicht zu klären – das sagt das Portal bei der Registrierung.

**Was du tun musst:**

1. Im Content-Portal registrieren, den Strom mit **Verkehrsmeldungen / ungeplanten Ereignissen**
   (SituationPublication, möglichst mit Koordinaten bzw. LinearByCoordinates) beantragen und den Vertrag abschließen.
2. Die dort genannte **Abruf-URL** (Pull) als `ASFINAG_DATEX_URL` eintragen, Benutzer und Passwort (HTTP-Basic) als
   `ASFINAG_USER` / `ASFINAG_PASSWORD`. Bietet das Portal eine andere Anmeldung an (z. B. Zertifikat), bitte melden –
   der Dienst kann bisher nur Basic oder offen.
3. Neustarten und `GET /health` prüfen (`"asfinag": true`), dann eine Route über eine Autobahn schicken und in
   `sources.asfinag` auf `ok` achten.

Gelesen wird DATEX II **v2 und v3** (`situationRecord`, Namensräume egal): Art aus `xsi:type`
(`AbnormalTraffic` → Stau, `Accident` → Unfall, `MaintenanceWorks`/`ConstructionWorks`/`Roadworks` → Baustelle,
`RoadOrCarriagewayOrLaneManagement` mit `roadClosed`/`carriagewayClosures` → Sperre), Verzögerung
`delayTimeValue`, Länge `queueLength`/`lengthAffected`, Text aus `generalPublicComment` (Deutsch bevorzugt),
Koordinaten aus `from`/`to` (TPEG, richtig geordnet), `linearCoordinatesStartPoint`/`EndPoint`, sonst
`pointCoordinates`, sonst `locationForDisplay`. `suspended` und abgelaufene (`overallEndTime`) fallen weg. Komprimierte
Antworten (gzip) werden entpackt. Die Testdaten in `fixtures/` sind **erfunden** und nur im Format eines solchen
Stroms – mit dem echten Strom ist der Parser noch **nicht** geprüft.

## Einrichten (ns1)

```bash
mkdir -p ~/glass-traffic
cp glass_traffic.py ~/glass-traffic/
install -m 600 glass-traffic.env.example ~/glass-traffic/.env    # ausfüllen: Logins, ggf. TOMTOM_KEY, ASFINAG_*
cp glass-traffic.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now glass-traffic
tailscale serve --bg --https=8474 http://127.0.0.1:8475           # nie "serve reset"
curl -s https://<ns1>.<tailnet>.ts.net:8474/health
```

Dann `services.traffic` in `selfhost/config.json` setzen (`https://<ns1>.<tailnet>.ts.net:8474`) und OpenGlance mit
`node selfhost/build-private.mjs` neu bauen; das trägt `VITE_TRAFFIC_URL` und die Origin in die Whitelist der
`app.private.json` ein. Ohne TomTom-Schlüssel und ohne ASFINAG antwortet der Dienst mit leeren Listen
(`sources: off`) – die App zeigt dann einfach keinen Verkehr.

## Tests

```bash
python3 -m unittest test_glass_traffic      # oder: python3 -m pytest test_glass_traffic.py
```

Nur Standardbibliothek, kein Netz außer 127.0.0.1; TomTom- und ASFINAG-Antworten kommen aus `fixtures/`
(erfunden, keine echten Schlüssel oder Daten). Geprüft: Lesen beider Quellen, Gegenfahrbahn, Abstand entlang der
Route, Zuordnung (Querstraße, Parallelstraße 40 m in der Stadt, Meldung entlang der Route, Gegenrichtung auf der
Autobahn, Sperre beider Richtungen, Punkt 20 m/60 m, Richtungsfahrbahn 45 m daneben, schräge Querung, Start/Ende-Linien,
„schon im Stau“, Nachbau der Form eines Live-Falls mit kurzen Quersperren am Routenanfang), Zusammenführen, Flow, Rechtecke unter der TomTom-Flächengrenze, Cache (auch: ASFINAG nur einmal je 2 min),
Quellen aus, Quellenfehler, Anmeldung/CORS/HTTP, `/health` ohne Geheimnisse.
