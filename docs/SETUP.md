# Einrichtung – Schritt für Schritt

Diese Anleitung sagt dir pro App, **was du wo eintragen musst**, damit sie
läuft. Die Feldnamen stehen genau so da, wie du sie am Handy in der App siehst
(deutsche Oberfläche).

## So kommt eine App auf die Brille

1. **Even-App** am Handy öffnen.
2. **Me → Apps** öffnen.
3. Die App in der **Store**-Liste suchen und installieren. Apps, die noch nicht
   im Store sind, kommen über **Private Builds** (dort trägst du den Link oder
   die `.ehpk`-Datei der App ein).
4. App öffnen. Am Handy erscheint die **Handy-Seite** der App (dort trägst du
   alles ein), auf der Brille erscheint die Anzeige.

Die Sprache folgt dem Handy. Oben auf der Handy-Seite kannst du sie umstellen.

## Wichtig bei eigenen Servern: Adressen müssen `https://` oder `wss://` sein

Die App wird am Handy über **HTTPS** geladen. Deshalb blockiert die Even-App
alles, was nur `http://` oder `ws://` ist („Mixed Content“). Ein eigener Server
im Heimnetz oder auf deinem Rechner braucht darum eine verschlüsselte Adresse.
Der einfachste Weg ist **Tailscale**:

1. Tailscale auf Handy **und** Server-Rechner installieren und am selben
   Konto anmelden.
2. Auf dem Server-Rechner eine Adresse für die App freischalten:

   ```bash
   tailscale serve --bg --https=8445 8899
   ```

   Das heißt: „Nimm den Server, der intern auf Port 8899 läuft, und biete ihn
   unter `https://<dein-rechner>.<dein-tailnet>.ts.net:8445` an.“ Die Adresse
   ist nur in deinem Tailscale-Netz erreichbar.
3. Jede App bekommt ihre **eigene** `--https=`-Nummer (z. B. 8445, 8446 …).
   Schau vorher mit `tailscale serve status`, was schon belegt ist.
4. Läuft der Server nicht auf dem Rechner selbst, sondern auf einer anderen
   Adresse, gib sie vollständig an, z. B.
   `tailscale serve --bg --https=8446 http://127.0.0.1:8765`.
5. Für WebSocket-Server (Sprach-/Agent-Server) gilt dasselbe: Die Adresse
   beginnt in der App dann mit `wss://` statt `https://`.

> **Nie `tailscale serve reset` ausführen.** Das löscht **alle** freigegebenen
> Adressen auf dem Rechner, auch die, die andere Dienste nutzen. Mit
> `tailscale serve status` siehst du den aktuellen Stand, mit
> `tailscale serve --https=<Nummer> off` entfernst du gezielt nur eine Adresse.

Wo im Text unten `<dein-rechner>.<dein-tailnet>.ts.net` steht, setzt du den
Namen deines Servers im Tailscale-Netz ein.

## Übersicht

| App | Einrichtung nötig? |
|---|---|
| [FlowList](#flowlist) | nein |
| [PostureLens](#posturelens) | nein |
| [DecibelGuard](#decibelguard) | nein |
| [Cadence](#cadence) | nein |
| [ShiftClock](#shiftclock) | nein |
| [RainLens](#rainlens) | nein (Standort erlauben) |
| [OpenGlance](#openglance) | nein (Standort erlauben) |
| [NextStop](#nextstop) | nein (ÖBB-Echtzeit: optional, eigenes Zusatzprogramm) |
| [FieldLog](#fieldlog) | nein (Sprechen: optional, eigener Sprachserver) |
| [Babel Glass](#babel-glass) | **ja**: Sprachserver (und optional Übersetzer) |
| [Agent Glass](#agent-glass) | **ja**: Server deines KI-Agenten |
| [Shoot Day](#shoot-day) | **ja**: eigener Server |
| [Klipper Glance](#klipper-glance) | **ja**: Bridge für den Drucker |
| [Xaventra HUD](#xaventra-hud) | **ja**: dein Xaventra-Rechner (Even-G2-Dienst) |
| [Status Glass](#status-glass) | **ja**: eine Statusquelle |
| [Lumen Glass](#lumen-glass) | **ja**: dein LUMEN |
| [PodCaption](#podcaption) | nein (Datei oder Text); Feed-Bridge optional – *noch nicht im Store* |
| [Market Glance](#market-glance) | **ja**: lokale Bridge – *noch nicht im Store* |
| [Endurance HUD](#endurance-hud) | **ja**: lokale Bridge – *noch nicht im Store* |

---

## Ohne Einrichtung

### FlowList

**Was du brauchst:** nichts.

**Am Handy eintragen:** nur, wenn du eine eigene Checkliste willst.

| Feld in der App | Was rein | Beispiel |
|---|---|---|
| Ein Schritt pro Zeile, mit „- “ davor … | Name der Liste mit `#`, Schritte mit `-` | `# Einkaufen` + `- Milch` |
| Button **Checkliste hinzufügen** | tippen | – |

Die Beispiel-Listen „Haus verlassen“ und „Reise packen“ sind schon da.
(`(!)` hinter einem Schritt = wichtig, wird zweimal bestätigt.)

**So prüfst du, dass es läuft:** App öffnen, auf der Brille einmal tippen – der
erste Schritt wird abgehakt.

### PostureLens

**Was du brauchst:** nichts.

**Am Handy eintragen:** nichts. Gerade hinsetzen, **einmal auf den Bügel
tippen** – damit ist deine gerade Haltung gespeichert.

**So prüfst du, dass es läuft:** Auf der Handy-Seite steht unter „Deine gerade
Haltung“ ein gespeicherter Wert.

### DecibelGuard

**Was du brauchst:** nichts. Die App fragt einmal nach dem Mikrofon der Brille.

**Am Handy eintragen:** nichts. Optional unter „Genauer messen (optional)“ den
Wert „Abgleich“ einstellen, wenn du ein echtes Messgerät hast.

**So prüfst du, dass es läuft:** Auf der Brille einmal tippen – es steht
**● MIKRO AN** und ein Pegel erscheint. Nochmal tippen stoppt.

### Cadence

**Was du brauchst:** nichts.

**Am Handy eintragen:** optional.

| Feld in der App | Was rein | Beispiel |
|---|---|---|
| Geschwindigkeit | Schläge pro Minute (Schieber) | 90 |
| Taktart | Schläge pro Takt | 4/4 |
| Neuer Eintrag | was du übst, dann **Hinzufügen** | Tonleitern |

**So prüfst du, dass es läuft:** Auf der Brille tippen – der Takt läuft.

### ShiftClock

**Was du brauchst:** nichts.

**Am Handy eintragen:** optional ein weiteres Projekt.

| Feld in der App | Was rein | Beispiel |
|---|---|---|
| Neues Projekt | Kunde, Auftrag oder Tätigkeit, dann **Hinzufügen** | Kunde Huber |

Das Projekt „Arbeit“ gibt es schon.

**So prüfst du, dass es läuft:** Auf der Brille tippen – die Zeit läuft.
Nochmal tippen stoppt.

### RainLens

**Was du brauchst:** Internet am Handy. Kein Konto, kein Schlüssel.

**Am Handy eintragen:** Standort in der Even-App erlauben – oder einen Ort
eintippen.

| Feld in der App | Was rein | Beispiel |
|---|---|---|
| Standort des Handys verwenden | Haken setzen (Standard) | – |
| Oder einen Ort eingeben | Ortsname, dann **Ort suchen** und den Treffer antippen | Hallein |
| Breitengrad / Längengrad (unter **Erweitert**) | nur wenn die Suche deinen Ort nicht kennt | 47.68 / 13.10 |

**So prüfst du, dass es läuft:** Auf der Handy-Seite steht „Gerade: …“ mit
deinem Ort, auf der Brille das Wetter.

### OpenGlance

**Was du brauchst:** Internet und GPS (Standort erlauben). Kein Konto.

**Am Handy eintragen:**

| Feld in der App | Was rein | Beispiel |
|---|---|---|
| Adresse oder Ort suchen | Ziel, dann **Suchen** und bei einem Treffer **Hierhin** | Mirabellplatz Salzburg |
| Wie bist du unterwegs? | Zu Fuß / Fahrrad / Auto | Zu Fuß |

Die Felder „Routenserver (Valhalla)“ und „Server für die Ortssuche (Photon)“
unter **Erweitert** bleiben leer – dann werden die freien öffentlichen Server
benutzt.

**So prüfst du, dass es läuft:** Auf der Brille tippen – der Pfeil mit der
Entfernung zur nächsten Abbiegung erscheint. (Im Haus gibt es kein GPS.)

### NextStop

**Was du brauchst:** Internet und Standort-Freigabe. Kein Konto.

**Am Handy eintragen:** nichts. „Woher kommen die Abfahrten?“ steht auf
**Überall – Fahrplan** und funktioniert sofort.

**Optional: ÖBB-Echtzeit (Verspätungen in Österreich)**

| Feld in der App | Was rein | Beispiel |
|---|---|---|
| Woher kommen die Abfahrten? | **ÖBB – Echtzeit in Österreich** | – |
| Adresse des ÖBB-Zusatzprogramms (unter **Erweitert**) | https-Adresse des Zusatzprogramms **mit** `/oebb` am Ende | `https://<dein-rechner>.<dein-tailnet>.ts.net:8450/oebb` |

**Server starten** (im Ordner `apps/nextstop`):

```bash
node examples/oebb-cors-proxy.mjs          # läuft auf 127.0.0.1:8079
tailscale serve --bg --https=8450 8079     # macht es per https erreichbar
```

**So prüfst du, dass es läuft:** Auf der Brille steht neben den Abfahrten `●`
(Echtzeit). Steht dort „ÖBB nicht erreichbar“, stimmt die Adresse nicht oder
das Zusatzprogramm läuft nicht.

### FieldLog

**Was du brauchst:** nichts. Notizen wählst du mit Tippen/Wischen, Fotos macht
das Handy.

**Am Handy eintragen:** optional einen Namen für den Rundgang.

| Feld in der App | Was rein | Beispiel |
|---|---|---|
| Name (optional) | Name des Rundgangs, dann **Rundgang starten** | Wohnungsübergabe Top 3 |
| Bereich (optional) | Raum oder Ort | Küche |

**Optional: Notizen sprechen.** Dazu brauchst du einen Whisper-Sprachserver –
derselbe wie bei [Babel Glass](#babel-glass) (Anleitung dort). Dann unter
**Erweitert: Notizen sprechen (optional)**:

| Feld in der App | Was rein | Beispiel |
|---|---|---|
| Server (WebSocket) | `wss://`-Adresse des Sprachservers | `wss://<dein-rechner>.<dein-tailnet>.ts.net:8447` |
| Token (optional) | nur wenn der Server einen hat | – |
| Sprache der Aufnahme | Sprache, in der du sprichst | Deutsch |

Dann **Speichern**.

**So prüfst du, dass es läuft:** Unter dem Feld steht „Gerade aktiv: Sprechen
über deinen Server.“ (statt „Schnellnotizen“).

---

## Mit eigenem Server

### Babel Glass

Untertitel und Übersetzung auf der Brille. Ohne Server zeigt die App feste
Demo-Sätze und `MOCK` – das ist nur zum Ausprobieren.

**Was du brauchst:**

- einen **Sprachserver** (Whisper) – Pflicht für echte Untertitel,
- optional einen **Übersetzer** (LibreTranslate-kompatibel oder ein
  OpenAI-kompatibles Sprachmodell wie vLLM/Ollama).

**Server starten – Sprachserver** (im Ordner `apps/babel-glass`):

```bash
pip install faster-whisper websockets
MODEL=large-v3 DEVICE=cuda COMPUTE=float16 python examples/whisper-server.py
# nur CPU (langsam): MODEL=small COMPUTE=int8 python examples/whisper-server.py
```

Er läuft auf Port 9000 (`PORT=…` ändert das; `TOKEN=geheim` schützt ihn).
Dann per https/wss erreichbar machen:

```bash
tailscale serve --bg --https=8447 http://127.0.0.1:9000
```

**Server starten – Übersetzer** (nur wenn du keinen LLM-Server hast):

```bash
pip install transformers torch sentencepiece
python examples/translate-server.py        # Port 5000, Pfad /translate
tailscale serve --bg --https=8448 5000
```

**Am Handy eintragen:**

| Feld in der App | Was rein | Beispiel |
|---|---|---|
| Gesprochene Sprache | Sprache, die gesprochen wird. Für Belarussisch/Russisch **fest wählen**, nicht „Automatisch erkennen“ | Russisch |
| Server (WebSocket) (unter **Erweitert: Server**) | `wss://`-Adresse des Sprachservers | `wss://<dein-rechner>.<dein-tailnet>.ts.net:8447` |
| Token (optional) | nur wenn du `TOKEN=` gesetzt hast | – |
| Übersetzen in | Zielsprache | Deutsch |
| Übersetzungsdienst | *LibreTranslate-kompatibel* **oder** *OpenAI-kompatibles LLM* | – |
| Endpoint (bei LibreTranslate) | volle Adresse inkl. `/translate` | `https://<dein-rechner>.<dein-tailnet>.ts.net:8448/translate` |
| API-Schlüssel (optional) | nur wenn der Übersetzer einen verlangt | – |
| Basis-URL des Servers (bei LLM) | Adresse bis `/v1` | `https://<dein-rechner>.<dein-tailnet>.ts.net:8451/v1` |
| Modell (bei LLM) | Name des Modells am Server | `qwen` |
| Bearer-Token (optional) (bei LLM) | nur wenn nötig | – |
| Modus | Gespräch / Vortrag / Reise / Nur Untertitel | Gespräch |

Dann **Speichern**.

Der Übersetzungs-Server muss Zugriffe aus der App erlauben („CORS“). Der
mitgelieferte `translate-server.py` tut das selbst; bei Ollama startest du mit
`OLLAMA_ORIGINS="*"`, bei LM Studio schaltest du CORS ein.

**So prüfst du, dass es läuft:** Auf der Handy-Seite verschwindet der gelbe
Kasten „Demo-Modus“. Auf der Brille einmal tippen: **● MIKRO** erscheint, und
beim Sprechen kommen Untertitel – nicht `MOCK`.

### Agent Glass

Zeigt, was dein KI-Agent gerade tut, und lässt dich Freigaben erteilen.

**Was du brauchst:** einen der drei Agenten-Server – **Claude/Codex** (über
Even Terminal), **Hermes** (hermes-evenhub-bridge) oder **OpenClaw**.

**Server starten:**

| Dienst | Befehl / Voraussetzung |
|---|---|
| Claude / Codex · Even Terminal | `even-terminal start --tailscale --allow-cors` (das Gerät bleibt in deinem Tailscale-Netz) |
| Hermes · EvenHub Bridge | Die Bridge läuft schon in deinem Hermes-Setup; mach sie per `wss://` erreichbar (`tailscale serve`, siehe oben). Der Token heißt `EVENHUB_BRIDGE_TOKEN`. |
| OpenClaw · Gateway | im Gateway `gateway.http.endpoints.chatCompletions.enabled=true` setzen; Adresse meist Port 18789 |

**Am Handy eintragen:**

| Feld in der App | Was rein | Beispiel |
|---|---|---|
| Dienst | *Claude / Codex · Even Terminal*, *Hermes · EvenHub Bridge* oder *OpenClaw · Gateway* | Hermes · EvenHub Bridge |
| Serveradresse | Even Terminal: die **komplette Kopplungs-URL**, die Even Terminal beim Start ausgibt (Adresse und Token werden automatisch getrennt). Hermes: `wss://`-Adresse. OpenClaw: `https://`-Adresse | `wss://<dein-rechner>.<dein-tailnet>.ts.net:8446` |
| Token (Bearer / Bridge) | bei Hermes der `EVENHUB_BRIDGE_TOKEN`, bei OpenClaw das Gateway-Token; bei Even Terminal leer lassen, wenn du die Kopplungs-URL benutzt hast | – |

Dann **Speichern und verbinden**. Optional unter „Vorlesen“: **Vorlesen
einschalten**, Vorlese-Sprache, Stimme, Tempo.

**So prüfst du, dass es läuft:** Unter „Aktueller Status“ steht
„… Sitzungen · aktiv: …“ statt „Keine Sitzungen geladen“ oder „Fehler: …“.
Auf der Brille erscheint die aktive Sitzung.

### Shoot Day

Take-Protokoll, Teleprompter, Tagesplan und Packliste für den Drehtag.

**Was du brauchst:** den Shoot-Day-Server (Node.js).

**Server starten** (im Ordner `apps/shoot-day`):

```bash
PORT=8899 HOST=127.0.0.1 PRESET_LANG=de node examples/shoot-day-server.mjs
```

| Variable | Bedeutung |
|---|---|
| `PORT` | Port (Standard 8899) |
| `HOST` | `127.0.0.1` = nur dieser Rechner. Alles andere **verlangt** `TOKEN` |
| `TOKEN` | Passwort für App und Web-Terminal (optional bei `127.0.0.1`) |
| `DATA_FILE` | wo die Projekte gespeichert werden |
| `WHISPER_URL` | Spracherkennung (OpenAI-kompatibel, `…/v1/audio/transcriptions`); ohne sie gibt es keine Sprachbefehle |
| `PRESET_LANG` | `de` = deutsche Packlisten-Vorlage |

Dann per https erreichbar machen:

```bash
tailscale serve --bg --https=8445 8899
```

**Am Handy eintragen:**

| Feld in der App | Was rein | Beispiel |
|---|---|---|
| Server-Adresse | die https-Adresse | `https://<dein-rechner>.<dein-tailnet>.ts.net:8445` |
| Token (optional) | nur wenn du `TOKEN=` gesetzt hast | – |

Dann **Speichern und verbinden**. Shotlist, Sprechtext, Tagesplan und Packliste
pflegst du im **Web-Terminal**: dieselbe Adresse im Browser öffnen.

**So prüfst du, dass es läuft:** Unter „Verbindung“ steht „Verbunden – Projekt:
…“. Die Adresse im Handy-Browser zeigt das Web-Terminal.

### Klipper Glance

Druckstatus deines Klipper-/Moonraker-Druckers.

**Was du brauchst:** einen Rechner im Drucker-Netz, der die Bridge laufen
lässt.

**Server starten** (im Ordner `apps/klipper-glance`):

```bash
node examples/klipper-bridge.mjs                                   # sucht den Drucker selbst
KL_MOONRAKER=http://<drucker-adresse>:7125 node examples/klipper-bridge.mjs
```

| Variable | Bedeutung |
|---|---|
| `PORT` | Port (Standard 8898) |
| `HOST` | Bind-Adresse (Standard `127.0.0.1`) |
| `TOKEN` | Passwort für die Bridge (nötig, wenn du Steuern erlauben willst) |
| `KL_MOONRAKER` | feste Moonraker-Adresse; ohne sie wird gesucht |
| `KL_ALLOW_CONTROL=1` | erlaubt Pause/Weiter/Abbrechen – **nur zusammen mit `TOKEN`** |

Ohne Drucker zum Üben: `node examples/mock-moonraker.mjs` startet einen
Schein-Drucker.

Per https erreichbar machen:

```bash
tailscale serve --bg --https=8452 8898
```

**Am Handy eintragen:**

| Feld in der App | Was rein | Beispiel |
|---|---|---|
| Bridge-Adresse | die https-Adresse | `https://<dein-rechner>.<dein-tailnet>.ts.net:8452` |
| Token (optional) | dein `TOKEN`, falls gesetzt | – |

Dann **Speichern und verbinden**.

**So prüfst du, dass es läuft:** Unter „Drucker“ steht Zustand, Prozent und
Dateiname; darunter, ob Steuern erlaubt ist. „Bridge erreichbar, Drucker
offline“ heißt: Die Bridge läuft, der Drucker ist aus.

### Xaventra HUD

Zeigt auf der Brille, woran dein eigener Xaventra-Agent arbeitet, und beantwortet
seine Rückfragen: **Tippen = Ja**, **Doppeltippen = Nein**, **Wischen = nächste
Frage**. Aktionen, die nach außen wirken (drucken, schalten, senden), brauchen
einen **zweiten Tap**. **Halten = sprechen**: die Aufnahme geht an deinen
Xaventra-Rechner, der sie mit seiner eigenen Spracherkennung versteht.

**Was du brauchst:** eine Xaventra-Installation mit eingeschaltetem
Even-G2-Dienst (`channels.evenG2.enabled`, Token `NOVA_EVEN_G2_TOKEN`, Standard-Port
`18790`, hört nur auf `127.0.0.1`). Für Sprache muss dein Xaventra den Sprach-Endpunkt
`POST /hud/voice` haben. Die Einrichtung auf der Xaventra-Seite steht in dessen
`docs/EVEN_G2.md`.

Per https im Tailnet erreichbar machen:

```bash
tailscale serve --bg --https=8790 http://127.0.0.1:18790
```

(Nimm einen Port, der bei dir frei ist. **Niemals** `tailscale serve reset` –
das löscht alle deine anderen Freigaben.)

**Am Handy eintragen:**

| Feld in der App | Was rein | Beispiel |
|---|---|---|
| Adresse des Xaventra-Endpunkts | die https-Adresse | `https://<dein-rechner>.<dein-tailnet>.ts.net:8790` |
| Token (NOVA_EVEN_G2_TOKEN) | der Token deines Xaventra-Dienstes | – |

Dann **Speichern und verbinden**.

**So prüfst du, dass es läuft:** Unter „Verbindung“ steht „Verbunden.“, auf der
Brille steht oben „Xaventra · Uhrzeit“ (bei Problemen „(offline)“). „Token
abgelehnt (401)“ heißt: Der Token stimmt nicht mit `NOVA_EVEN_G2_TOKEN` überein.

### Status Glass

Zeigt, ob NAS, Server oder Home Assistant in Ordnung sind.

**Was du brauchst:** eine **Quelle** – das ist eine Adresse, die ein kleines
JSON liefert (Format: `docs/PROTOCOL.md` in der App). Zwei fertige Beispiele
liegen bei.

**Server starten** (im Ordner `apps/status-glass`):

```bash
node examples/reference-server.mjs                  # Beispiel, http://127.0.0.1:8099/status
```

Für Home Assistant:

```bash
HA_URL=http://homeassistant.local:8123 HA_TOKEN=<langlebiges-Token> TOKEN=<dein-geheimes-Token> node examples/home-assistant-adapter.mjs
```

(Läuft auf Port 8100. Ohne `TOKEN` ist der Adapter nur lesend. Oben in der
Datei stellst du ein, was angezeigt und was geschaltet werden darf.)

Per https erreichbar machen, z. B. für das Beispiel:

```bash
tailscale serve --bg --https=8449 8099
```

**Am Handy eintragen** (Bereich „Quelle hinzufügen“):

| Feld in der App | Was rein | Beispiel |
|---|---|---|
| Name | frei wählbar | NAS |
| Adresse (URL) | https-Adresse **inklusive `/status`** | `https://<dein-rechner>.<dein-tailnet>.ts.net:8449/status` |
| Bearer-Token (optional) (unter **Erweitert**) | dein `TOKEN`, falls gesetzt | – |

Dann **Quelle hinzufügen**.

**So prüfst du, dass es läuft:** Unter „Quellen“ erscheint die Quelle; auf der
Brille steht „… of … ok“ oder die Problemliste. Eine Quelle, die nicht
antwortet, gilt als Problem (nie als „ok“).

### Lumen Glass

Zeigt die Motte aus deinem selbst gehosteten LUMEN.

**Was du brauchst:** ein laufendes LUMEN (Standard `127.0.0.1:8077`) und
Zugriffserlaubnis („CORS“) in LUMEN – drei Zeilen, siehe
`apps/lumen-glass/examples/PATCH.md`. Alternativ der mitgelieferte Proxy:

```bash
node examples/lumen-cors-proxy.mjs          # Port 8078, leitet an LUMEN weiter
```

Per https erreichbar machen:

```bash
tailscale serve --bg --https=8454 8077       # oder 8078, wenn du den Proxy nutzt
```

**Am Handy eintragen:**

| Feld in der App | Was rein | Beispiel |
|---|---|---|
| Adresse | https-Adresse deines LUMEN (bzw. des Proxys) | `https://<dein-rechner>.<dein-tailnet>.ts.net:8454` |
| Sitzungs-Cookie (unter **Erweitert**) | nur nötig, wenn LUMEN im geschlossenen Modus läuft | – |

Dann **Speichern**.

**So prüfst du, dass es läuft:** Statt „Nicht verbunden“ erscheint „Deine
Motte“. Zeigt die Brille „LUMEN unreachable“, fehlt CORS.

---

## Noch nicht im Even-Hub-Store

Diese drei Apps liegen fertig im Repository, sind aber noch nicht im Store.
Installieren geht über **Private Builds**.

> **Wichtig:** Bei PodCaption (Feed-Bridge), Market Glance und Endurance HUD
> ist in der App fest hinterlegt, dass sie nur mit einer Bridge auf
> `127.0.0.1` / `localhost` sprechen dürfen. Eine Bridge auf einem *anderen*
> Rechner erreicht die App deshalb nicht – das klappt derzeit nur im Simulator
> oder auf dem Rechner selbst. Für ein echtes Handy müsste man in der
> `app.json` der App die erlaubte Adresse ändern und die App neu bauen.

### PodCaption

**Was du brauchst:** nichts – eine Untertitel-Datei (VTT, SRT, JSON oder Text)
genügt.

**Am Handy eintragen:**

| Feld in der App | Was rein | Beispiel |
|---|---|---|
| Datei vom Handy wählen (VTT, SRT, JSON oder Text) | Datei auswählen | `folge12.vtt` |
| Name der Folge (optional) | frei | Folge 12 |
| Oder Text einfügen | Transkript kopieren und einfügen, dann **Text übernehmen** | – |

**Optional (Erweitert):** Untertitel aus einem RSS-Feed.

| Feld in der App | Was rein | Beispiel |
|---|---|---|
| Bridge-Adresse | Adresse der Bridge (Standard schon eingetragen), dann **Feed laden** | `http://127.0.0.1:8789` |

**Server starten:**

```bash
PODCAST_FEED_URL=https://example.org/podcast.xml node examples/podcast-bridge.mjs
```

**So prüfst du, dass es läuft:** „Untertitel geladen“ erscheint statt
„Beispiel – noch keine Datei geöffnet“. Auf der Brille tippen = abspielen.

### Market Glance

Nur-Lesen-Anzeige deiner Polymarket-/Kalshi-Positionen (keine Orders). Keine
Finanzberatung.

**Was du brauchst:** die Bridge. Ohne Einstellungen läuft sie im Demo-Modus.

**Server starten:**

```bash
POLYMARKET_WALLET=0x… node examples/market-bridge.mjs
# optional Kalshi: KALSHI_KEY_ID=… KALSHI_PRIVATE_KEY_PATH=/pfad/zum/key.pem
```

Zugangsdaten bleiben in der Bridge und kommen nie auf die Brille. Hinweis zur
Adresse: siehe Kasten oben.

**Am Handy eintragen:**

| Feld in der App | Was rein | Beispiel |
|---|---|---|
| Lokale Markt-Bridge | Adresse der Bridge (Standard schon eingetragen), dann **Speichern** | `http://127.0.0.1:8793/positions` |

**So prüfst du, dass es läuft:** Statt `DEMO` steht `LIVE`; die Positionen
erscheinen in der Liste.

### Endurance HUD

Live-Werte (Tempo/Pace, Leistung, Puls, Kadenz) von Garmin, Radcomputer oder
einer JSON-Quelle.

**Was du brauchst:** die Bridge und etwas, das Werte an sie schickt.

**Server starten:**

```bash
node examples/telemetry-bridge.mjs          # Port 8792; ENDURANCE_TOKEN=… schützt den Eingang
```

Testwerte senden:

```bash
curl -X POST http://127.0.0.1:8792/live -H "Content-Type: application/json" \
  -d '{"sport":"bike","speedKph":32.1,"powerWatts":245,"heartRate":151,"cadence":92,"distanceKm":18.4,"elapsedSeconds":2200,"source":"garmin"}'
```

**Am Handy eintragen:**

| Feld in der App | Was rein | Beispiel |
|---|---|---|
| Sportart | Automatisch (Bridge) / Rad / Laufen | Automatisch (Bridge) |
| Telemetrie-Bridge | Adresse der Bridge (Standard schon eingetragen), dann **Speichern** | `http://127.0.0.1:8792/live` |

**So prüfst du, dass es läuft:** Statt `DEMO` steht `LIVE-TRAINING`. Kommen
länger als 10 Sekunden keine Werte, zeigt die Brille `STALE`.
