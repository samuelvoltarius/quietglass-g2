# Brillen-Agent (glass-agent)

Macht einen eigenen KI-Agenten — z. B. [Hermes](https://github.com/NousResearch/hermes-agent) mit seinem
OpenAI-kompatiblen API-Server — zum „Even AI“ der Even Realities G2.

Die Even-App kann unter **Einstellungen → Agent hinzufügen** (Name, URL, Schlüssel) einen eigenen
Agenten eintragen. Sie schickt dann jede Frage als OpenAI-Chat-Request: `"model":"openclaw"`, nur der
letzte Satz, kein Verlauf, kein Systemtext, kein Streaming; die Brille zeigt etwa 400–500 Zeichen.
Dieser kleine Dienst sitzt dazwischen und

- merkt sich das laufende Gespräch ein paar Minuten (Rückfragen wie „und morgen?“ funktionieren;
  „Neues Gespräch“ beginnt von vorn),
- sagt dem Agenten, dass die Antwort auf eine Brille geht (kurz, ohne Emojis/Formatierung),
- räumt die Antwort auf und kürzt sie am Satzende (Standard 350 Zeichen),
- hält den Schlüssel des Agenten vom Handy fern (die Even-App kennt nur `GLASS_AGENT_TOKEN`),
- protokolliert keine Inhalte, nur Länge und Dauer,
- weicht automatisch aus, wenn ein Modell scheitert oder sein Kontingent leer ist
  (`GLASS_AGENT_FALLBACKS`, z. B. erst ein Abo-Modell, dann ein anderes, zuletzt das eigene vLLM);
  ein Weg mit leerem Kontingent wird 15 Minuten übersprungen. Ausgewichen wird **nur bei echten
  Fehlern** (HTTP-Fehler, Verbindung abgelehnt, Kontingent/429) — nicht, weil der Agent langsam ist,
- lässt einen langsamen Agenten im Hintergrund weiterarbeiten (siehe unten),
- kann Hermes-Aktionen vorher auf der Brille bestätigen lassen (Freigabe-Stufen, siehe unten).

Nur Python-Standardbibliothek. Selbsttest: `python3 glass_agent.py --selftest`.

## Einrichten

```bash
mkdir -p ~/glass-agent && cp glass_agent.py ~/glass-agent/
cat > ~/glass-agent/.env <<'EOF'
GLASS_AGENT_TOKEN=<langes Zufalls-Token>
GLASS_AGENT_UPSTREAM_URL=http://<agent-host>:8642/v1/chat/completions
GLASS_AGENT_UPSTREAM_KEY=<API_SERVER_KEY des Agenten>
EOF
chmod 600 ~/glass-agent/.env
cp glass-agent.service ~/.config/systemd/user/ && systemctl --user enable --now glass-agent
tailscale serve --bg --https=8657 http://127.0.0.1:8657
```

In der Even-App: **URL** `https://<rechner>.<tailnet>.ts.net:8657/v1/chat/completions` (vollständig —
die App hängt nichts an), **Schlüssel** = `GLASS_AGENT_TOKEN`. Das Handy muss im Tailnet sein.

Weitere Einstellungen (Zeichenbudget, Verlaufsdauer, Zusatz-Systemtext, Modellname) stehen oben in
`glass_agent.py`.

## Langsame Antworten

Die Even-App wartet nur ~30 s. Der Dienst wartet `GLASS_AGENT_BUDGET` Sekunden (Standard 24) auf den
Agenten. Braucht er länger (z. B. weil er Werkzeuge benutzt), arbeitet er im Hintergrund weiter, und die
Brille zeigt „Ich bin noch dran – frag gleich mit „und?“ nach.“ Das Ergebnis wird gemerkt
(`GLASS_AGENT_STATE`, 10 Minuten) und mit der nächsten Äußerung geliefert:

| Nächste Äußerung | Brille zeigt |
|---|---|
| „und?“, „Ergebnis?“, „fertig?“, „weiter“ | nur das Ergebnis (ist es noch nicht da, wird nochmal bis zum Budget gewartet) |
| eine andere Frage | „Vorhin: ‹Ergebnis kurz› Jetzt: ‹Antwort auf die neue Frage›“ |

Die erledigte Frage/Antwort kommt in den Verlauf. Es gibt nur einen offenen Vorgang: geht auch die neue
Frage in den Hintergrund, verfällt das ältere, noch nicht fertige Ergebnis. Ein hängender Weg gilt erst
nach `GLASS_AGENT_TIMEOUT` (Standard 120 s) als Fehler. Direkte Wege (z. B. eigenes vLLM) bekommen den
Hinweis, dass sie keine Werkzeuge und Live-Daten haben, und sollen das ehrlich sagen.

## Freigabe-Stufen (`GLASS_AGENT_APPROVAL`)

| Stufe | Weg zu Hermes | Verhalten |
|---|---|---|
| `auto` (Standard) | `/v1/chat/completions` | wie bisher, keine Rückfrage auf der Brille |
| `mixed` | `/v1/runs` | Freigaben für erkennbar **nur lesende** Aktionen gibt der Dienst selbst, alles andere fragt er |
| `ask` | `/v1/runs` | jede Hermes-Freigabe wird auf der Brille gefragt |

Umschalten per Sprache (bleibt gespeichert): „Freigabe auf auto“, „Freigabe gemischt“,
„Freigabe immer fragen“.

Ablauf bei `mixed`/`ask`: Der Dienst startet einen Run (`POST /v1/runs`) und fragt den Status ab
(`GET /v1/runs/{id}`). Hält Hermes an (`waiting_for_approval`), zeigt die Brille z. B.
„Hermes will an Maria schreiben: 'Komme 10 min später.' Sag ja oder nein.“ Die offene Rückfrage gilt
`GLASS_AGENT_APPROVAL_TTL` Sekunden (Standard 90) und übersteht einen Neustart.

- „ja“, „ok“, „mach“, „bestätigt“, „yes“ → `POST /v1/runs/{id}/approval {"choice":"once"}`, dann wird auf
  das Ergebnis gewartet (sonst „noch dran“ wie oben).
- „nein“, „stopp“, „abbrechen“, „no“ → `choice: "deny"` und `POST /v1/runs/{id}/stop`.
- jede andere Äußerung ist eine neue Frage; die offene Freigabe wird abgelehnt und der Run gestoppt
  (Schweigen ist keine Zustimmung). Das gilt auch nach Ablauf der 90 s.

Kennt der Agent `/v1/runs` nicht (404), läuft die Anfrage über Chat-Completions ohne Rückfrage.
Direkte Ausweichwege (vLLM) haben keine Werkzeuge und damit keine Freigaben.

**Wichtig:** Hermes hält nur an, wenn bei Hermes `approvals.mode` nicht `off` ist (`manual` oder
`smart`). Hermes fragt nicht vor jedem Werkzeug, sondern bei gefährlichen Shell-Befehlen,
`execute_code` und bei Werkzeugen, für die ein Plugin eine Freigaberegel setzt (z. B. Nachrichten
senden). Mehr als Hermes fragt, kann auch `ask` nicht fragen.

**Einstufung bei `mixed`** (konservativ, Unbekanntes wird gefragt), aus den Feldern des
Freigabe-Ereignisses (`command`, `description`, `pattern_key`, `smart_denied`):

- immer fragen: `smart_denied`; Beschreibung mit Risiko-Wörtern (löschen, schreiben, senden, kill,
  install, sudo, secret, token …); Code-Ausführung (`execute_code`/Skripte); unbekannte Werkzeuge.
- automatisch frei (`once`): Plugin-Werkzeuge aus einer festen Leseliste (`read_file`, `search_files`,
  `web_search`, `web_extract`, `session_search`, `vision_analyze`, `browser_snapshot`, `skills_list`,
  `skill_view`); Shell-Befehle, deren sämtliche Teile (getrennt an `|`, `&&`, `;`) mit einem reinen
  Lesebefehl beginnen (`ls`, `cat`, `grep`, `df`, `ps`, `find`, `git status/log/diff/show` …) und die
  keine Umleitung `>`, keine Befehlsersetzung, kein `sudo`/`tee`/`xargs`, kein `-delete`/`-exec`/`-o`
  enthalten.

Werkzeug-Einschränkung je Anfrage: Hermes' API kennt kein Feld dafür (die Werkzeuge kommen aus der
Hermes-Konfiguration für die Plattform `api_server`); deshalb gibt es hier keine Einstellung dafür.
