# babel-llm-proxy — Übersetzung für Babel Glass

Babel Glass übersetzt über ein **OpenAI-kompatibles LLM** (`/v1/chat/completions`). Dieser kleine Proxy
(nur Python-Standardbibliothek, kein `pip install`) sitzt davor und erledigt, was die Brillen-App braucht:

- CORS (Preflight 204 ohne Body),
- Streaming durchreichen: fragt die App mit `"stream": true` (ab Babel Glass 0.3.2), gehen die
  Server-Sent-Events Zeile für Zeile ungepuffert weiter (Text erscheint auf der Brille, während er entsteht);
  ohne `stream` kommt wie bisher eine ganze JSON-Antwort,
- schaltet das „Denken“ von Qwen-Modellen aus (`enable_thinking: false`) – sonst dauert die Übersetzung Sekunden,
- optional Anmeldung (Token oder Tailscale-Login),
- **ab Babel Glass 0.4.0: Babels eigenes Gedächtnis** (siehe unten).

| lokal | Tailscale-Port (Vorschlag) | App-Feld |
|---|---|---|
| `127.0.0.1:8121` | `8448` | „Übersetzer“ = `https://<server>.<tailnet>.ts.net:8448/v1` |

Das **Modell** trägst du in der App (bzw. `VITE_BABEL_MODEL` im privaten Build) so ein, wie dein LLM-Server es
nennt (z. B. `qwen`, siehe `curl http://127.0.0.1:8000/v1/models`).

## Voraussetzung: ein LLM-Server

vLLM (`vllm serve <modell> --port 8000`), Ollama (`UPSTREAM=http://127.0.0.1:11434`) oder llama.cpp-Server.
Gut geeignet sind mehrsprachige Modelle (Qwen-Familie); für Weißrussisch/Russisch → Deutsch ein größeres Modell
wählen. (Ollama ignoriert `chat_template_kwargs` – ungeprüft, ob das dort Nebenwirkungen hat.)

## Eigenes Gedächtnis (ab Babel Glass 0.4.0)

Babel merkt sich nach jeder Zusammenfassung Datum, Titel, Zusammenfassung und Abmachungen, dazu Notizen vom
Handy – in **einer JSON-Datei neben dem Proxy** (`babel-memory.json`, per `BABEL_MEMORY_FILE` änderbar, im Repo
gitignored). Geschrieben wird atomar (Temp-Datei + `os.replace`), Rechte 600, höchstens `BABEL_MEMORY_CAP` (500)
Einträge, die ältesten fallen raus. Es wird **nichts anderes** gelesen oder geschrieben.

| Methode | Pfad | Zweck |
|---|---|---|
| `POST` | `/memory` | Eintrag anhängen `{type:"session"|"note", title, summary, agreements[], date?}` |
| `GET` | `/memory?limit=N` | neueste zuerst |
| `DELETE` | `/memory/<id>` | einen Eintrag löschen |
| `DELETE` | `/memory` | alles löschen |
| `POST` | `/memory/search` | `{query, limit}` → Stichwortsuche (BM25, leichte Wortformen) |

Auch unter `/v1/memory…` erreichbar. Gleiche Anmeldung wie `/v1/chat/completions` (leeres `TOKEN` = offen im
Tailnet). Jede Antwort trägt `"memory": true`, damit die App einen alten Proxy erkennt.

Selbsttest (startet einen Proxy auf einem freien Port, ohne LLM):

```bash
python3 babel_llm_proxy.py --selftest      # endet mit "alles gruen"
```

## Kundenkontext aus Shoot Day (optional)

Läuft auf demselben Rechner ein **Shoot Day**-Server, kann der Proxy dessen Material zum aktuellen Kunden in
Babels Antwortvorschläge, Wortfinder und Zusammenfassung geben – nie in die normale Übersetzung. Gelesen wird per
`GET /api/customers`, `/api/customers/<id>/brief`, `/api/projects/<id>`. Schreibzugriffe nur: die Gesprächsnotiz und die
Gesprächs-Rückmeldung unten (hängen nur etwas an das aktuelle Projekt des Kunden an). Kein Zugriff auf andere Dienste.

| Variable | Bedeutung |
|---|---|
| `BABEL_SHOOT_URL` | z. B. `http://127.0.0.1:8899` – leer = aus (Standard) |
| `BABEL_SHOOT_TOKEN` | Bearer-Token des Shoot-Day-Servers (dessen `TOKEN`), optional |
| `BABEL_SHOOT_TIMEOUT` | Sekunden für alle Abrufe zusammen (Standard `2`) |
| `BABEL_SHOOT_FEEDBACK` | Gesprächs-Rückmeldung nach Shoot Day schreiben: Standard an (wenn `BABEL_SHOOT_URL` gesetzt), `0` = aus |
| `BABEL_SHOOT_TALKS` | Gesprächsnotiz (Zusammenfassung + Tipp-Karten) nach Shoot Day schreiben: Standard an (wenn `BABEL_SHOOT_URL` gesetzt), `0` = aus |
| `BABEL_SHOOT_FEEDBACK_MODEL` | Modell für die Auswertung, optional (sonst das der Zusammenfassung bzw. das erste von `/v1/models`) |

- **Welcher Kunde:** standardmäßig der Kunde des aktiven Shoot-Day-Projekts (`activeCustomer`). „Ohne Zuordnung“
  wird übersprungen (dann kein Kontext). Übersteuern pro Anfrage: Body-Feld `"customer"` oder Header
  `X-Babel-Customer` (ID oder Name, auch Namensteil; `-` = kein Kontext). `"shoot_context": false` schaltet ihn für
  eine Anfrage ab. Beide Felder werden vor dem LLM entfernt.
- **Inhalt** (deutsch, höchstens 2 500 Zeichen): Kunde/Firma, aktives bzw. nächstes Projekt (Name, Datum, Ort),
  Kundennotiz, offene Ideen mit #Tags, Storyboard-Titel mit je einer Zeile pro Szene, Einblendungen/Slogans,
  die ersten ~600 Zeichen des Skripts (Prompter). Wird an den System-Prompt gehängt:
  „Gesprächskontext (Kunde): … Nutze ihn für passende Antwortvorschläge und Begriffe; erfinde nichts dazu.“
- **Robust:** 60 s Zwischenspeicher (Fehler 15 s), Zeitlimit 2 s; ist Shoot Day langsam oder weg, fehlt nur der
  Kontext – Babel läuft normal weiter.
- **Anzeige:** `GET /context/customer` (auch `/v1/context/customer`, gleiche Anmeldung, optional `?customer=`)
  → `{"context": true, "enabled", "name", "project", "chars", "ideas", "storyboards"}` – ohne den Text selbst.
- **Andere Idee im Gespräch (live):** Bei Antwortvorschlägen steht zusätzlich die Anweisung: lehnt der Kunde eine
  vorbereitete Idee ab, zweifelt, ändert sie oder bringt einen neuen Wunsch, kommt genau eine klärende Rückfrage
  (Ziel, Stimmung, wo/wann, wer vor der Kamera) und – nur wenn passend – eine vorbereitete Idee dazu; nichts erfinden.

### Gesprächsnotiz nach Shoot Day (`BABEL_SHOOT_TALKS`)

Nach jeder Zusammenfassung schickt der Proxy (im Hintergrund, die Antwort an die Brille wartet nicht darauf)
`POST /api/projects/<pid>/talks {at, summary, cues}` an das aktuelle Projekt des Kunden (Kunde und Projekt wie bei
der Rückmeldung unten). `summary` = der Text der Zusammenfassung (`lang`, sonst `kurz`, plus „Abmachungen“), `cues`
= die Tipp-Karten, die die App unter „Tipp-Karten während des Gesprächs“ an die Anfrage hängt
(`[{title, text, kind}]`). Dieselbe Zusammenfassung wird innerhalb von 30 min nur einmal abgelegt; scheitert es,
läuft Babel normal weiter. Shoot Day macht daraus im Work Dashboard einen Kommentar. Sonst wird nichts geschrieben.

### Gesprächs-Rückmeldung nach Shoot Day (`BABEL_SHOOT_FEEDBACK`)

`POST /context/feedback` (auch `/v1/context/feedback`, gleiche Anmeldung wie alle Proxy-Endpunkte)
mit `{"transcript": "…", "customer": "<ID oder Name, optional>"}` (es zählen die letzten 12 000 Zeichen):

1. Der Kunde wird wie beim Kontext bestimmt (aktiver Kunde bzw. `customer`); „Ohne Zuordnung“/kein Kunde/kein
   Projekt → es wird **nichts** geschrieben (`reason` in der Antwort).
2. Dasselbe LLM (ohne Denken, Temperatur 0.1, nur JSON) zieht heraus: neue/bevorzugte Ideen, abgelehnte
   vorbereitete Ideen (mit Titel + Grund), Änderungen/Wünsche, offene Fragen – je ein kurzer deutscher Satz mit Tags.
   Kaputtes JSON → nichts geschrieben.
3. `GET /api/projects/<pid>`, dann `POST /api/projects/<pid>/ideas` mit der **vollständigen** Liste: alle
   vorhandenen Ideen unverändert (IDs, erledigt-Status) + die neuen, z. B. `"14.10.: Barista erklärt …"` mit Tags
   `gespraech` + `neu` | `abgelehnt` | `wunsch` | `frage`. Ähnliche Texte (ohne Groß/Klein, Datum, Satzzeichen) werden
   übersprungen. Es wird nie etwas gelöscht oder geändert; sonst wird nichts geschrieben (auch nicht ins Brain).

Antwort: `{"added": ["14.10.: …"], "skipped": n, "customer", "project"}`; derselbe Text innerhalb von 30 min →
`{"duplicate": true}`. Fehler → 502, ausgeschaltet → 503.

**Automatisch:** Nach jeder Zusammenfassung („Du fasst ein mitgeschriebenes Gespräch …“) mit aktivem
Kundenkontext läuft genau diese Auswertung im Hintergrund auf demselben Gesprächstext – erst nachdem die
Zusammenfassung an Babel zurückgegeben ist. Pro Gesprächstext höchstens einmal in 30 min; ein Fehler dabei wird
nur geloggt und stört die Zusammenfassung nie.

**Tipp-Karten (Kundengespräch, nur lesend):** `POST /context/cue {"transcript": "<letzte ~3 min, max 6000 Zeichen>",
"customer"?, "recent_titles": [...]}` fragt das LLM (ohne Denken, Temperatur 0.3, max. 120 Tokens) mit dem
Kundenkontext nach höchstens einer kurzen Karte für den Träger. Antwort `{"cue": {"title" (≤ 40), "text" (≤ 140),
"kind": "tipp"|"begriff"|"fakt"|"achtung"}}` oder `{"none": true}` (auch bei kaputtem JSON oder einer Wiederholung
aus `recent_titles`). Zeitgrenze 6 s (`BABEL_CUE_TIMEOUT`) → 504 `{"none": true, "error": "timeout"}`; LLM-Fehler →
502. Hängt Babel die Karten an die Zusammenfassung an („Tipp-Karten während des Gesprächs …“), schneidet der Proxy
sie vor der Shoot-Day-Rückmeldung ab.

Tests (falscher Shoot-Day-Server + falsches LLM, nur 127.0.0.1): `python3 -m pytest test_shoot_context.py
test_shoot_feedback.py test_cue.py` (oder `python3 -m unittest test_shoot_context test_shoot_feedback test_cue`).

## Installieren

```bash
mkdir -p ~/.config/quietglass ~/.config/systemd/user
cp .env.example ~/.config/quietglass/babel-llm-proxy.env && chmod 600 ~/.config/quietglass/babel-llm-proxy.env
$EDITOR ~/.config/quietglass/babel-llm-proxy.env        # UPSTREAM, optional TOKEN / TAILSCALE_USERS
cp babel-llm-proxy.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now babel-llm-proxy
loginctl enable-linger "$USER"
systemctl --user is-active babel-llm-proxy
curl -s http://127.0.0.1:8121/v1/models | head -c 200   # zeigt die Modelle des LLM-Servers
```

Unit-Pfade gehen davon aus, dass das Repo unter `~/quietglass-g2` liegt – sonst `ExecStart` anpassen.

## Per Tailscale freigeben (nie `serve reset`)

```bash
tailscale serve --bg --https=8448 http://127.0.0.1:8121
tailscale serve status
```

## Aktualisieren (bestehende Installation)

```bash
cd ~/quietglass-g2 && git pull
python3 selfhost/services/babel-llm-proxy/babel_llm_proxy.py --selftest
systemctl --user restart babel-llm-proxy && systemctl --user is-active babel-llm-proxy
curl -s http://127.0.0.1:8121/memory?limit=1     # mit TOKEN: -H "Authorization: Bearer …"  → {"memory": true, …}
```

## English

A tiny stdlib-only Python proxy in front of any OpenAI-compatible LLM server (vLLM, Ollama, llama.cpp): adds
CORS (204 preflight, no body), passes `"stream": true` through as unbuffered server-sent events (plain JSON
otherwise), disables Qwen "thinking", and optionally checks a Bearer
token or a Tailscale login. Set `UPSTREAM` in the env file, install the user unit, publish `127.0.0.1:8121`
with `tailscale serve --bg --https=8448 http://127.0.0.1:8121`, and enter `https://<server>.<tailnet>.ts.net:8448/v1`
plus your model name in Babel Glass. Since Babel Glass 0.4.0 it also keeps the app's own small memory
(`/memory`: append, list, delete one/all, BM25 keyword search) in a JSON file next to it (`BABEL_MEMORY_FILE`,
mode 600, atomic writes, at most 500 entries), behind the same auth. `python3 babel_llm_proxy.py --selftest`.
Optional: `BABEL_SHOOT_URL` (+ `BABEL_SHOOT_TOKEN`) points it at a local Shoot Day server; the reply-suggestion,
word-finder and summary calls then get a short read-only customer context (active customer by default, override
via body `customer` / header `X-Babel-Customer`; max 2,500 chars, cached 60 s, 2 s timeout, omitted on failure).
`GET /context/customer` reports which customer is used. `POST /context/feedback {transcript, customer?}` (and,
automatically, every summary call) has the LLM extract new/preferred ideas, rejected ideas, wishes and open
questions and APPENDS them to the customer's current Shoot Day project ideas (existing ideas untouched, deduped,
once per transcript per 30 min; `BABEL_SHOOT_FEEDBACK=0` disables). `POST /context/cue {transcript, customer?,
recent_titles?}` returns at most one short live tip card `{cue: {title, text, kind}}` or `{none: true}` (read-only,
6 s cap). After every summary call the summary text and the app's tip cards are also posted once to
`POST /api/projects/<id>/talks` of the customer's current Shoot Day project (`BABEL_SHOOT_TALKS=0` disables).
Tests: `python3 -m pytest test_shoot_context.py test_shoot_feedback.py test_cue.py test_shoot_talks.py`.
