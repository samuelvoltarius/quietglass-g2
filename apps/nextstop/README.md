# NextStop

**Quietglass** · Abfahrten und der nächste Halt — ohne das Handy aus der Tasche zu nehmen.

Am Bahnsteig: was fährt hier weg, und ist es pünktlich.
Im Bus: welcher Halt kommt als Nächstes, und wann bin ich da.

---

![Die Abfahrtstafel](docs/screenshot.png)

*Echte Daten, Salzburg Mirabellplatz: Bus 175 mit elf Minuten Verspätung, O-Bus 3 pünktlich.*

## Warum es diese App gibt

Es existieren schon zehn ÖPNV-Apps für die G2. **Neun davon können genau eine
Stadt** — Washington, Karlsruhe, Helsinki, Tokio, Paris, New York. Wer verreist,
steht ohne da.

NextStop kann überall etwas anzeigen, weil es zwei Quellen hat statt einer.

## Die zwei Datenquellen

| | Gebiet | Echtzeit | Schlüssel |
|---|---|---|---|
| **ÖBB** | Österreich | ja, bis zum Stadtbus | keiner |
| **Transitous** | viele Länder | je nach Region | keiner |

Warum beides? Weil keine der beiden allein reicht.

**Transitous** ist gemeinnützig, anbieterneutral und — der eigentliche Grund —
mit MOTIS **selbst hostbar**. Nur führt es für Österreich reine Fahrpläne: von
fünfzehn österreichischen Feeds hat genau einer Echtzeit konfiguriert.
Gemessen am Mirabellplatz: **0 von 8 Abfahrten** mit Verspätungsangabe.

**Die ÖBB** liefert sie sehr wohl, bis hinunter zum Salzburger O-Bus. Gemessen
an derselben Haltestelle zur selben Minute: **8 von 10**.

Umschalten in der Handy-App. Wer MOTIS selbst betreibt, trägt dort die eigene
Adresse ein — dann verlässt keine Anfrage das Haus.

## Was du siehst

```
Salzburg Mirabellplatz · 99 m

> Bus 175  Rif Ortsmitte · jetzt +11 H
  Bus 170  Salzburg Hbf · jetzt +2 B
  Bus 22   Josefiau · jetzt +2 C
  O-Bus 1  Kleßheim · jetzt +2 E
  Bus 120  Palting via Mitterhof · 3 min +4 G
  O-Bus 3  Salzburg Nord · 2 min ● A

tippen = verfolgen · ● live  ~ Fahrplan
```

Die letzte Spalte ist der Punkt, an dem die meisten Abfahrtstafeln schummeln:

| | Bedeutung |
|---|---|
| `+11` | der Betreiber meldet elf Minuten Verspätung |
| `-2` | fährt früher — kommt vor und wird nicht verschwiegen |
| `●` | der Betreiber meldet: pünktlich |
| `~` | **nur Fahrplan.** Niemand hat das bestätigt. |
| `X` | fällt aus |

Die Tilde ist die wichtigste. Eine Tafel, die eine geplante Zeit genauso
druckt wie eine gemessene, wird genauso geglaubt — und ist genauso oft falsch.

### Unterwegs

```
Bus 175 → Rif Ortsmitte

> Salzburg Makartplatz · jetzt
  Salzburg Rathaus · 1 min
  Salzburg Mozartsteg · 2 min
  Salzburg Justizgebäude · 3 min
  Salzburg Akademiestraße · 4 min

noch 20 Halte · Ziel 27 min

GPS · 326 m · tippen = zurück
```

Die Fußzeile sagt, **woher** der nächste Halt kommt. Mit GPS ist er gemessen;
ohne GPS — Tunnel, U-Bahn, Handy in der Tasche — wird er aus Fahrplan und Uhr
geschätzt, und nach einem längeren Stau kann diese Schätzung mehrere Halte zu
optimistisch sein. Das steht dann auch da.

## Bedienung

| Geste | Wirkung |
|---|---|
| **Wischen** | Abfahrt auswählen |
| **Tippen** | Fahrt verfolgen — und zurück |
| **Halten** | nächste Haltestelle in der Nähe |
| **Doppeltippen** | NextStop verlassen |

## Einrichten

Bei Transitous: nichts. Bei der ÖBB braucht es einen kleinen Proxy.

```bash
node examples/oebb-cors-proxy.mjs     # 127.0.0.1:8079
```

Die ÖBB-Schnittstelle schickt keine CORS-Header, deshalb wirft der Browser die
Antwort weg, bevor die App sie sieht. Das Symptom führt in die Irre: die Brille
zeigt **„ÖBB nicht erreichbar"**, während dieselbe Anfrage im Terminal
einwandfrei durchgeht. Der Server hat geantwortet — der Browser hat es
verworfen.

```bash
npm install
npm run dev        # Handy-UI + App auf http://127.0.0.1:5201
npm run build      # Typecheck + Produktions-Bundle
npm test           # 70 Tests
npm run sim        # Simulator auf den Dev-Server gerichtet
```

### Ohne Brille testen

Der Simulator hat kein GPS, die App käme also nie über „Warte auf GPS" hinaus.
Dafür gibt es einen Startparameter:

```
http://127.0.0.1:5201/?at=47.8060,13.0430
```

Ein echter GPS-Fix überschreibt ihn sofort, und die Handy-App schreibt
ausdrücklich dazu, dass die Position gesetzt und nicht gemessen ist.

## Datenschutz

Wo jemand hinfährt, ist ungefähr so persönlich wie Daten nur werden können.
NextStop speichert deshalb **nichts davon** — keine Fahrten, keine
Lieblingshaltestellen, keine Historie. Gespeichert werden ausschließlich die
gewählte Quelle und deren Adresse.

Die Position wird an den gewählten Dienst geschickt, um die nächste Haltestelle
zu finden — anders geht es nicht. Wer MOTIS selbst betreibt, kann auch das im
eigenen Netz halten.

## Bekannte Grenzen

| Grenze | Detail |
|---|---|
| ÖBB braucht den Proxy | CORS. Einmal starten, siehe oben. |
| ÖBB ist keine Open-Data-API | Es ist der Endpunkt der ÖBB-eigenen App. Kein Schlüssel nötig, aber niemand garantiert, dass er so bleibt. Jedes Feld wird als optional gelesen: ändert sich etwas, fällt die App auf Fahrplanzeiten zurück statt abzustürzen. |
| Transitous-Abdeckung schwankt | Ganze Regionen können fehlen. Die App sagt das, statt eine leere Liste zu zeigen. |
| Keine Umstiege | Diese App beantwortet „was fährt jetzt" und „wo muss ich raus", nicht „wie komme ich hin". Eine Verbindungsauskunft ist ein Bildschirm fürs Handy. |
| Nicht auf Hardware geprüft | Gebaut und geprüft gegen SDK 0.0.16 und den Simulator — aber gegen **echte, laufende Dienste**, nicht gegen Attrappen. |

## Nächste Schritte

- Umstiegswarnung, wenn der Anschluss laut Echtzeit nicht mehr zu schaffen ist.
- Steiermark-Echtzeit über Transitous nutzen, wo die ÖBB nichts weiß.
- Alarm kurz vor dem eigenen Ausstieg, statt selbst mitzählen zu müssen.

## Lizenz

MIT — siehe [LICENSE](LICENSE).
