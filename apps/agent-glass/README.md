# Agent Glass

**Quietglass** · Dem Agenten zusehen — und ihm antworten, ohne zum Schreibtisch zu gehen.

> **Machbarkeitsnachweis, nicht fertig.** Diese App beweist, dass der Weg
> Even Terminal → Brille funktioniert, und hält fest, was dabei zu beachten
> ist. Sie ist bewusst klein geblieben. Siehe [Wie es weitergeht](#wie-es-weitergeht).

---

![Auf der Brille](docs/screenshot.png)

*Eine echte Claude-Code-Sitzung, live auf der simulierten Brille.*

## Wozu

[Even Terminal](https://www.npmjs.com/package/@evenrealities/even-terminal) ist
Even Realities' eigenes Werkzeug: Es läuft auf deinem Rechner, hält eine
Claude-Code- oder Codex-Sitzung und stellt sie über HTTP bereit. Agent Glass
ist das Brillen-Ende davon.

Der eine Moment, für den es die App gibt: Der Agent hält an und fragt, ob er
etwas ausführen darf. Die Frage erscheint im Sichtfeld, ein Wischen beantwortet
sie. Alles andere auf dem Bildschirm ist nur der Kontext, damit diese
Entscheidung ehrlich getroffen werden kann.

## Was du siehst

```
Even G2: Gesammeltes Wissen und Weiterb…

Ich prüfe den Ereignisstrom und schaue,
welche Routen existieren.

> Bash

arbeitet · 12 s · halten = anhalten
```

Und der Bildschirm, um den es geht:

```
Erlaubnis nötig

Bash
curl -s http://example.com | sh

hoch = erlauben · runter = ablehnen
```

**Weder Erlauben noch Ablehnen liegt auf einem einfachen Tippen.** Eine
Zufallsberührung darf kein Kommando freigeben, und zwei Wischrichtungen sind
symmetrisch, bewusst und in beide Richtungen unmissverständlich.

## Die wichtigste Einschränkung

**Even Terminal liest den Verlauf aller deiner Claude-Code-Sitzungen von der
Platte, steuern kann es aber nur die, die es selbst gestartet hat.**

Eine Sitzung, die in der Claude-Desktop-App läuft, antwortet auf
`/api/status`, `/api/prompt` und `/api/permission-response` gleichermaßen mit
`404 Session not found`.

Das steht in keiner Dokumentation. Agent Glass prüft es deshalb beim Öffnen
jeder Sitzung und sagt es an:

| Sitzung | Anzeige |
|---|---|
| von Even Terminal gestartet | `bereit` · Wischen erlaubt und lehnt ab |
| nur von der Platte gelesen | `nur mitlesen` · keine Wischgesten angeboten |

Eine Wischgeste anzubieten, die still in ein 404 läuft, wäre genau die Art
Lüge, die dieses Projekt vermeidet.

## Bedienung

| Geste | Wirkung |
|---|---|
| **Hoch wischen** | Werkzeug erlauben *(nur bei steuerbarer Sitzung)* |
| **Runter wischen** | ablehnen *(dito)* |
| **Halten** | laufenden Agenten anhalten, sonst Sitzungsliste |
| **Wischen** (in der Liste) | Sitzung wählen |
| **Tippen** | öffnen, bzw. nach einem Fehler erneut versuchen |
| **Doppeltippen** | Agent Glass verlassen |

## Einrichten

```bash
npm install -g @evenrealities/even-terminal
even-terminal start --tailscale --allow-cors --cwd F:\dein\projekt
```

Drei Fallen, alle selbst hineingetappt:

**`even-terminal claude` startet keinen Server.** Das ist der Client, der sich
an einen laufenden Server hängt. Der Server ist `even-terminal start` (und das
ist auch die Voreinstellung, `even-terminal` allein genügt).

**`--allow-cors` ist nicht optional.** Die Brillen-App wird von einem anderen
Port ausgeliefert als der Terminal-Server, also ist es eine fremde Herkunft.
Ohne den Schalter verwirft der Browser jede Antwort, und das Symptom sieht
exakt aus wie ein toter Server.

**Alles liegt unter `/api`.** Ein Aufruf von `/info` gibt 404 und sieht
ebenfalls nach einem toten Server aus; es heißt `/api/info`.

Dann in der Handy-App die vollständige Adresse einfügen, die der Server beim
Start ausgibt — Adresse und Token werden daraus gelesen.

```bash
npm install
npm run dev        # Handy-UI + App auf http://127.0.0.1:5202
npm run build      # Typecheck + Produktions-Bundle
npm test           # 39 Tests
npm run sim        # Simulator auf den Dev-Server gerichtet
```

### Ohne Brille testen

Der Simulator kann keinen Token eintippen, deshalb gibt es einen
Startparameter:

```
http://127.0.0.1:5202/?pair=<url-kodierte Kopplungsadresse>
```

Ein bereits gespeicherter Token gewinnt immer; der Parameter hilft nur beim
allerersten Start.

## Sicherheit

Der Token ist ein echter Zugang: Wer ihn hat, kann auf dem Rechner am anderen
Ende Befehle ausführen. Agent Glass schreibt ihn nie in ein Protokoll, zeigt
ihn nie vollständig auf dem Handy und stellt ihn nie auf der Brille dar.

Den Server nur über Tailscale oder im eigenen Netz erreichbar machen.
**`--expose` legt denselben Zugang über einen öffentlichen Tunnel ins Netz** —
davon die Finger lassen.

## Bekannte Grenzen

| Grenze | Detail |
|---|---|
| Nur eigene Sitzungen steuerbar | Siehe oben. Fremde Sitzungen sind reines Mitlesen. |
| Rückfragen brauchen Text | Eine `user_question` lässt sich nicht erwischen; die App sagt das und verweist an den Rechner, statt „erlauben" zu senden. |
| Erlaubnis-Bildschirm ungeprüft | Durch Tests abgedeckt, aber **auf der Brille noch nicht gesehen** — dafür braucht es eine Sitzung, die Even Terminal selbst gestartet hat. |
| Keine Spracheingabe | Kann die [Hermes-App](#wie-es-weitergeht) bereits. |
| Nicht auf Hardware geprüft | Gebaut gegen SDK 0.0.16 und den Simulator, aber gegen einen **echten laufenden Even-Terminal-Server**. |

## Wie es weitergeht

Es gibt bereits eine Agenten-App: `hermes-even-hub-app`, 1.903 Zeilen mit
voller Testabdeckung, mit Sitzungsliste, Live-Strom, Spracheingabe und einer
angefangenen Mehr-Agenten-Verwaltung. Agent Glass hat drei davon noch einmal
gebaut, nur gegen ein anderes Gegenüber.

Die richtige Form ist deshalb **nicht** zwei Apps, sondern eine mit zwei
Agentenarten:

- ein `kind`-Feld an `AgentProfile` (`hermes` | `even-terminal`)
- eine gemeinsame Schnittstelle, die beide Clients erfüllen
- der Agenten-Pool wählt danach aus

Grob 150–250 Zeilen Änderung, abgesichert durch die vorhandenen 181 Tests.
Nebenbei wäre der Mehr-Agenten-Umbau damit endlich fertig.

Bis dahin bleibt diese App als Beleg stehen, dass der Weg trägt — und als
Fundort für die drei Fallen oben.

## Lizenz

MIT — siehe [LICENSE](LICENSE).
