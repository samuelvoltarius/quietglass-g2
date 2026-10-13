# NextStop

**Quietglass** · Abfahrten und der nächste Halt — ohne das Handy aus der Tasche zu nehmen.

> **Kurz gesagt:** NextStop zeigt auf der Brille, was an der Haltestelle neben dir abfährt – und während der Fahrt, welcher Halt als Nächstes kommt. Kein Konto, kein Schlüssel, kein eigener Server.
>
> **So startest du:**
> 1. NextStop in der Even-App installieren und öffnen.
> 2. Den Standort erlauben, wenn die Even-App fragt. Die Brille zeigt dann die Abfahrten der nächsten Haltestelle.
> 3. **Wischen** wählt eine Abfahrt, **Tippen** fährt mit (nächster Halt), **Halten** springt zur nächsten Haltestelle, **Doppeltippen** beendet.
>
> **Optional:** ÖBB-Echtzeit in Österreich (Verspätungen bis zum Stadtbus). Dafür läuft ein kleines Zusatzprogramm auf einem Computer im selben WLAN – siehe [ÖBB-Echtzeit](#öbb-echtzeit-optional). Ohne es funktioniert alles mit Fahrplanzeiten.
>
> **Sprache:** Deutsch und Englisch. Die App folgt der Sprache des Handys; umstellen lässt sie sich oben auf der Handy-Seite.

> **In English:** NextStop shows on the glasses what leaves from the stop next to you – and, while you ride, which stop comes next. No account, no key, no server of your own.
>
> 1. Install and open NextStop in the Even app.
> 2. Allow location when the Even app asks. The glasses then show the departures of the nearest stop.
> 3. **Swipe** picks a departure, **tap** rides along (next stop), **hold** jumps to the next stop nearby, **double-tap** exits.
>
> `●` = live, `~` = timetable only, `+3` = three minutes late. Optional: ÖBB live times in Austria need a small add-on on a computer on the same Wi-Fi (see [ÖBB-Echtzeit](#öbb-echtzeit-optional)); without it everything works with timetable times.
>
> **Languages:** German and English. The app follows the phone's language and can be switched at the top of the phone page.

Am Bahnsteig: was fährt hier weg, und ist es pünktlich.
Im Bus: welcher Halt kommt als Nächstes, und wann bin ich da.
Unterwegs zu einem Ziel: **Route planen** und Schritt für Schritt begleiten lassen (seit 0.3.0).

> **Neu in 0.3.0 – Route planen:** Am Handy unter „Ziele“ Orte suchen und als Favoriten speichern („Heim“, „Arbeit“ …). Auf der Brille tippen und halten für das Menü ▸ **Route planen**: Ziel wählen, 3–4 Verbindungen ab deinem Standort ansehen (`in 4 min · Bus 3 → O-Bus 7 · an 14:52 · 1×`), mit **Tippen** startet die Begleitung: „Geh zu Haltestelle …“, „Bus 3 Richtung … um 14:32“, „Aussteigen: Mirabellplatz – noch 2 Halte“, „Umsteigen: O-Bus 7, Steig B“, „Ziel erreicht“. **Doppeltippen** geht einen Schritt zurück (in der Begleitung erst nach Rückfrage). Verbindungen, Orte und Favoriten kommen von Transitous; die Favoriten bleiben auf dem Handy.
>
> **New in 0.3.0 – route planning:** Under "Destinations" on the phone, search for places and save favourites ("Home", "Work" …). On the glasses, tap and hold for the menu, then **Plan a route**: pick a destination, see 3–4 connections from where you are (`in 4 min · Bus 3 → O-Bus 7 · arr 14:52 · 1×`), **tap** to start guidance: walk to the stop, which bus at what time, "Get off: …, 2 stops left", "Change to …", "You have arrived". **Double-tap** goes back (in the guide it asks once more). Connections and place search come from Transitous; favourites stay on the phone.

---

![Die Abfahrtstafel](docs/screenshot.png)

*Echte Daten, Salzburg Mirabellplatz: Bus 175 mit elf Minuten Verspätung, O-Bus 3 pünktlich.*

## Warum es diese App gibt

Es existieren schon zehn ÖPNV-Apps für die G2. **Neun davon können genau eine
Stadt** — Washington, Karlsruhe, Helsinki, Tokio, Paris, New York. Wer verreist,
steht ohne da.

NextStop kann überall etwas anzeigen, weil es zwei Quellen hat statt einer.

## Die zwei Datenquellen

| | Gebiet | Echtzeit | Schlüssel | direkt aus der App |
|---|---|---|---|---|
| **Transitous** (Standard, „Überall“) | viele Länder | je nach Region | keiner | ja |
| **ÖBB** (optional) | Österreich | ja, bis zum Stadtbus | keiner | nein, nur mit Zusatzprogramm |

Warum beides? Weil keine der beiden allein reicht.

**Transitous** ist gemeinnützig, anbieterneutral und — der eigentliche Grund —
mit MOTIS **selbst hostbar**. Nur führt es für Österreich reine Fahrpläne: von
fünfzehn österreichischen Feeds hat genau einer Echtzeit konfiguriert.
Gemessen am Mirabellplatz: **0 von 8 Abfahrten** mit Verspätungsangabe.

**Die ÖBB** liefert sie sehr wohl, bis hinunter zum Salzburger O-Bus. Gemessen
an derselben Haltestelle zur selben Minute: **8 von 10**.

Umschalten in der Handy-App. Transitous ist voreingestellt, weil es als
einzige der beiden Quellen ohne Hilfe aus der Even-App erreichbar ist. Wer
MOTIS selbst betreibt, trägt unter „Erweitert“ die eigene Adresse ein — dann
verlässt keine Anfrage das Haus.

**Geprüft am 6. Oktober 2026** (curl mit Browser-`Origin`):

- `api.transitous.org` antwortet auf `/api/v1/map/stops` und
  `/api/v1/stoptimes` mit `Access-Control-Allow-Origin: *` und
  `Access-Control-Allow-Headers: *`; auch die Vorab-Anfrage (`OPTIONS`) wird
  so beantwortet. Ohne `User-Agent` kommt 403 — im Browser schickt die
  WebView ihren eigenen mit. Laut [Nutzungsregeln](https://transitous.org/api/)
  ist die API für quelloffene, nicht-kommerzielle und sparsame Clients frei,
  mit sichtbarem Link auf [transitous.org/sources](https://transitous.org/sources/)
  (steht unten in der Handy-App).
- `fahrplan.oebb.at/bin/mgate.exe` beantwortet dieselbe Anfrage mit `200`,
  aber **ohne** jeden `Access-Control-*`-Header, auch nicht auf `OPTIONS`.
  Aus einer WebView heraus geht es deshalb nur über den Proxy.

## Was du siehst

```
Salzburg Mirabellplatz · 99 m

> jetzt +11  Bus 175  Rif Ortsmitte · H
  jetzt +2  Bus 170  Salzburg Hbf · B
  jetzt +2  Bus 22  Josefiau · C
  jetzt +2  O-Bus 1  Kleßheim · E
  2 min ●  O-Bus 3  Salzburg Nord · A
  3 min +4  Bus 120  Palting via Mitterhof · G

tippen = verfolgen · ● live  ~ Fahrplan
```

Jede Zeile liest sich in der Reihenfolge, in der man fragt: **wie lange** –
**welche Linie** – **wohin** – Steig. Die Wartezeit steht vorne, weil sie das
ist, wofür man hinschaut, und am linken Rand springt sie nicht hin und her.
Das Ziel wird gekürzt, wie es Anzeigetafeln tun („Hbf“, „Bf“, „Str.“, der
Steig in Klammern fällt weg) und gibt als einziges Feld nach, wenn die Zeile
zu lang wird – mit „…“ markiert. Ein Ortsname wird nie weggelassen.

**Warum keine Grafik:** Größere Schrift gibt es auf der Brille nicht, und eine
Bild-Zeile pro Abfahrt würde jede Minute für jede Zeile eine Bluetooth-Übertragung
kosten (Bilder sind auf dem G2 deutlich langsamer als Text). Linien-„Badges“
als Bild würden nur die Liniennummer schöner machen, die Wartezeit aber nicht
lesbarer. Text mit fester Reihenfolge und klaren Abständen ist hier schneller
erfasst – und bleibt nach jedem Neuladen sofort aktuell.

Das Zeichen gleich nach der Zeit ist der Punkt, an dem die meisten Abfahrtstafeln schummeln:

| | Bedeutung |
|---|---|
| `+11` | der Betreiber meldet elf Minuten Verspätung |
| `-2` | fährt früher — kommt vor und wird nicht verschwiegen |
| `●` | der Betreiber meldet: pünktlich |
| `~` | **nur Fahrplan.** Niemand hat das bestätigt. |
| `X` | fällt aus (in der Zeile steht dann „fällt aus“ statt der Zeit) |

Die Tilde ist die wichtigste. Eine Tafel, die eine geplante Zeit genauso
druckt wie eine gemessene, wird genauso geglaubt — und ist genauso oft falsch.

### Route planen

```
Wohin? · 14:29                   → Heim · 14:29
> Jetzt: Getreidegasse 10        > in 4 min · O-Bus 2 → O-Bus 10 · an 14:46 · 1×
  Heim                             in 17 min · O-Bus 10 · an 14:56
  Arbeit                           in 17 min · O-Bus 2 → O-Bus 10 · an 15:00 · 1×
  Hauptbahnhof
                                 Ab Salzburg Vogelweiderstraße
                                 Gehen 15 min · Dauer 35 min
```

**Ziel sprechen (optional):** Auf der Zielliste Touchpad **halten** und das Ziel sagen,
beim Loslassen (oder nach spätestens 8 s) geht die Aufnahme als WAV an einen
Whisper-Server (OpenAI-kompatibel, `/v1/audio/transcriptions`, Formular-Upload ohne eigene
Header, damit kein CORS-Preflight nötig ist). Die Brille zeigt „Verstanden: …“ und bis zu drei
Treffer der Ortssuche; Wischen wählt, Tippen sucht Verbindungen, Doppeltippen verwirft, im
Menü „Als Favorit merken“. Die Adresse des Servers steht am Handy unter „Erweitert“; die
öffentliche App hat keine Vorgabe (dann sagt die Brille, dass ein eigener Server nötig ist), ein
privater Build kann sie mit `VITE_STT_URL` vorgeben. Aufnahmen werden nur gesendet, solange du
hältst, und nicht gespeichert.

**Fußwege mit Abbiegehinweisen:** Die Begleitung führt jede Etappe: Auf Fußwegen steht oben die
nächste Abbiegung (`←  60 m  links abbiegen`, Straße, Rest der Strecke), aktualisiert per GPS.
Die Abbiegungen kommen von Valhalla (`costing: pedestrian`, öffentlicher OSM-Server von FOSSGIS,
oder `VITE_ROUTER_URL` in einem privaten Build): MOTIS' eigene Fußschritte sagen nur „geradeaus“
und nennen kaum Straßen. Entfernt sich der Gehende mehr als 80 m von der Route, wird sie vom
aktuellen Standort neu berechnet („Neu berechnet“ in der Fußzeile). Die Etappen wechseln von
selbst (Fußweg → „Warte auf Bus 3“ → Fahrt mit „Danach aussteigen“ einen Halt vorher →
Umstiegsweg → … → „Ziel erreicht“); der Kopf zeigt Etappe, Uhrzeit und die erwartete Ankunft.
Ein verpasstes Fahrzeug erkennt die App am Standort und bietet per Tippen eine neue Verbindung an.
**Große Bilder statt kleinem Text (seit 0.3.1):** Die Brille kann Text nicht vergrößern, deshalb
haben die drei Etappen eigene Bildseiten. *Zu Fuß*: großer Pfeil links, die Entfernung bis zur
Abbiegung in rund 70 px hohen Pixelziffern (50-m-Schritte ab 200 m, darunter 10 m), ein dicker
Annäherungsbalken (voll ab 50 m vor der Abbiegung), die Straße fett über die ganze Breite und
darunter klein `Dann: O-Bus 2 Richtung Walserfeld · in 4 min`. *Warten*: der Countdown („2 min“)
groß, Linie und Richtung als Text, daneben eine Haltestelle, in die in der letzten Minute ein Bus
einfährt. *Fahrt*: „noch 2 Halte“ als große Ziffern, darunter `Aussteigen: Mirabellplatz · an 02:06`;
einen Halt vorher blinkt „Aussteigen“. Bilder werden nur bei Änderung gesendet; der 500-ms-Takt
läuft nur, solange eine animierte Seite offen ist. Pfeilformen und Aufbau stammen aus OpenGlance Nav.

Die Ziele liegen auf dem Handy (SDK-Speicher, mit localStorage als Spiegel). Orte
sucht die App über die Ortssuche von Transitous (`/api/v1/geocode`), Verbindungen über
`/api/v1/plan`; beides auf derselben Adresse wie die Abfahrten, die Brille braucht
also nur **eine** Netzwerk-Freigabe. Geplant wird immer über MOTIS, auch wenn die
Abfahrtstafel auf ÖBB steht. Während der Begleitung werden die Zeiten der nächsten
beiden Fahrzeuge einmal pro Minute über `/api/v1/trip` aufgefrischt, damit
gemeldete Verspätungen ankommen.

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
| **Tippen und halten** | Menü der Seite: Route planen, Abfahrten, … (das Menü zeichnet die Brille) |

Auf den Route-Seiten: **Wischen** wählt das Ziel bzw. die Verbindung, **Tippen** öffnet
die Verbindungen bzw. startet die Begleitung, **Doppeltippen** geht zurück. In der
Begleitung bedeutet Tippen „nächster Schritt“ und Wischen blättert vor und zurück;
das Beenden fragt einmal nach. Auf der ersten Seite beendet Doppeltippen NextStop wie bisher.

## Einrichten

Bei Transitous: nichts — das ist die Voreinstellung.

### ÖBB-Echtzeit (optional)

Für Verspätungen in Österreich braucht es einen kleinen Proxy, der auf einem
Computer im selben Netz läuft. In der Handy-App dann „ÖBB – Echtzeit in
Österreich“ wählen und unter „Erweitert“ die Adresse des Proxys eintragen
(z. B. `http://192.168.1.20:8079/oebb`, mit `HOST=0.0.0.0` gestartet).

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
npm test           # 109 Tests
npm run sim        # Simulator auf den Dev-Server gerichtet
```

### Ohne Brille testen

Der Simulator hat kein GPS, die App käme also nie über „Warte auf deinen Standort" hinaus.
Dafür gibt es einen Startparameter:

```
http://127.0.0.1:5201/?at=47.8060,13.0430
```

Ein echter GPS-Fix überschreibt ihn sofort, und die Handy-App schreibt
ausdrücklich dazu, dass die Position gesetzt und nicht gemessen ist.

## Datenschutz

Wo jemand hinfährt, ist ungefähr so persönlich wie Daten nur werden können.
NextStop speichert deshalb **keine Fahrten und keine Historie**. Gespeichert werden
die gewählte Quelle und deren Adresse und — nur wenn du sie selbst anlegst — deine
Favoriten (Name und Koordinaten) und das „Ziel jetzt“. Sie bleiben auf dem Handy;
an den Fahrplandienst gehen nur Suchtext und Koordinaten, wenn du suchst oder planst.

Die Position wird an den gewählten Dienst geschickt, um die nächste Haltestelle
zu finden — anders geht es nicht. Wer MOTIS selbst betreibt, kann auch das im
eigenen Netz halten.

## Bekannte Grenzen

| Grenze | Detail |
|---|---|
| ÖBB braucht den Proxy | CORS. Einmal starten, siehe oben. Ohne Proxy bleibt Transitous mit Fahrplanzeiten. |
| Nur Deutsch | Brille und Handy-App sprechen derzeit nur Deutsch. |
| ÖBB ist keine Open-Data-API | Es ist der Endpunkt der ÖBB-eigenen App. Kein Schlüssel nötig, aber niemand garantiert, dass er so bleibt. Jedes Feld wird als optional gelesen: ändert sich etwas, fällt die App auf Fahrplanzeiten zurück statt abzustürzen. |
| Transitous-Abdeckung schwankt | Ganze Regionen können fehlen. Die App sagt das, statt eine leere Liste zu zeigen. |
| Route nur über MOTIS | Verbindungen kommen von Transitous (oder deinem MOTIS). Die ÖBB-Quelle kennt nur Abfahrtstafel und Fahrt. In Österreich sind die Zeiten meist Fahrplan (`~`), nicht live. |
| Eigener Server auf der Brille | Die öffentliche `app.json` erlaubt nur `https://api.transitous.org`. Wer einen eigenen MOTIS- oder ÖBB-Server nutzt, packt mit einer eigenen `app.private.json`, die genau diese Adresse zusätzlich in der Whitelist hat (Platzhalter `*` blockiert die echte Brille). |
| Spracheingabe braucht einen Server | Whisper läuft nicht in der App. Ohne eigenen Server (Handy, „Erweitert“, oder `VITE_STT_URL` im privaten Build) bleibt es bei der Suche am Handy. |
| Pfeil als Textzeichen | `←`, `→`, `↖`, `↗` werden im Simulator gezeichnet; auf der echten Brille nicht geprüft. |
| Begleitung ohne GPS | Dann entscheidet die Uhr; die Fußzeile zeigt „Uhr“ statt „GPS“, und Tippen schaltet von Hand weiter. |
| Nicht auf Hardware geprüft | Gebaut und geprüft gegen SDK 0.0.16 und den Simulator — aber gegen **echte, laufende Dienste**, nicht gegen Attrappen. |

## Nächste Schritte

- Umstiegswarnung, wenn der Anschluss laut Echtzeit nicht mehr zu schaffen ist (die Begleitung frischt die Zeiten schon auf, warnt aber noch nicht).
- Steiermark-Echtzeit über Transitous nutzen, wo die ÖBB nichts weiß.
- Alarm kurz vor dem eigenen Ausstieg, statt selbst mitzählen zu müssen.

## Datenschutz

Welche Daten wohin gehen, was gespeichert wird und wie du es löschst: [docs/PRIVACY.md](docs/PRIVACY.md).

## Lizenz

MIT — siehe [LICENSE](LICENSE).
