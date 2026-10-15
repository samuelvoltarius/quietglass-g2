# HUD-Latenz – Analyse und Umbau (OpenGlance 0.14.0)

Anlass: Rückmeldung nach einer Fahrt mit der Brille – „die Navigation fühlt sich verzögert an“.
Alle Zahlen stammen aus dem Code von 0.13.0 (`src/main.ts`, `src/glasses/*`) und aus Messungen
in den Tests (`tests/hud-main.test.ts`, PNG-Größen mit dem echten Encoder unter Node).
Auf der echten Brille ist noch **nichts gemessen** – die BLE-Zeiten pro Bild sind unbekannt,
nur dass jedes Bild-Byte über Bluetooth muss.

## 1. Was 0.13.0 tat

### GPS
| Punkt | Wert 0.13.0 | Quelle |
|---|---|---|
| API | `startAppLocationUpdates` (Even-Hub-SDK, Position kommt vom Handy) | `main.ts` |
| Genauigkeit | `AppLocationAccuracy.High` | ditto |
| `distanceFilter` | 5 m | ditto |
| `intervalMs` | **nicht gesetzt** (Plattform-Standard, unbekannt) | ditto |
| `maximumAge` / `enableHighAccuracy` | gibt es im SDK nicht (das sind Browser-Begriffe); Entsprechung ist `accuracy` | SDK 0.0.16 |
| erster Fix beim Start | `getAppLocation`, Zeitlimit 10 s; ein Fix bis 120 s alt wird wiederverwendet (`FRESH_FIX_MS`) | `main.ts` |

Zwischen zwei Fixes stand die Entfernung still: es gab keine Fortschreibung.

### Wie oft gezeichnet wurde
`draw()` wird ausgelöst von: jedem GPS-Fix, einem 2-s-Takt, jeder Auto-Abfrage (alle 5 s
beim Fahren), Zucker (1/min), Ladesäulen, Gesten. Die Aufrufe wurden in eine Promise-Kette
gehängt: **jeder Aufruf wartete auf alle vorherigen**. Dauerte ein Zeichnen (wegen Bild-Upload)
länger als der Abstand zwischen zwei Fixes, wuchs eine Warteschlange – die Brille arbeitete
alte Zeichenaufträge ab, während das Auto schon weiter war. Das ist die wahrscheinlichste
Hauptursache für „verzögert“.

### Was über Bluetooth ging (Abbiegeseite „turns“)
| Inhalt | Art | Größe (PNG) | wann gesendet |
|---|---|---|---|
| Pfeil 144 × 144 | Bild | 736 B | bei neuem Manöver |
| **Entfernungskarte 288 × 144** (große Ziffern + Balken) | **Bild** | **1 869 B** | wenn sich die gerundete Zahl oder ein Balkenschritt ändert – unter 200 m alle 10 m, darüber alle 50 m –, gedrosselt auf höchstens alle **2 s** (`CARD_MIN_INTERVAL_MS`) |
| Straßenname 2 × 288 × 56 | 2 Bilder (Canvas `toBlob`) | – | bei neuem Manöver |
| Text (Zeile, Fußzeile, Tempo) | 3 × `textContainerUpgrade` | – | bei **jedem** Zeichnen, auch unverändert |

Folge: Die Entfernung – die wichtigste Zahl – war ein Bild. Sie lief bis zu 2 s plus
Upload-Dauer hinter der Wirklichkeit her; bei 50 km/h sind das 30 m und mehr, genau dort,
wo es zählt (kurz vor der Abbiegung). Bei einem Manöverwechsel gingen 4 Bilder auf einmal
raus (Pfeil, Karte, 2 Straßenhälften), und in dieser Zeit stauten sich die Fixes (siehe oben).
Zusätzlich drei Text-Schreibvorgänge pro Zeichnen, auch wenn sich nichts geändert hatte.

### Valhalla `trace_attributes`
- **Einmal pro Route** (gecacht in `traceOf`), 1,2 s nach der Route, asynchron.
  Blockiert das Zeichnen **nicht**.
- Am öffentlichen Server nur der **Anfang** einer langen Route (URL ≤ 7 500 Zeichen):
  danach waren die Tempolimits unbekannt.
- Das Limit an der aktuellen Stelle wird pro Zeichnen per Projektion auf die Routenlinie
  gesucht (reine Rechnung, kein Netz).

### Seiten-Neubau
`rebuildPageContainer` nur bei Seitenwechsel (Start, Wischen, Ankunft, Fehler) – nie pro Fix.
Abseits der Route / Neuberechnung / bestätigter Stopp liefen über dieselbe Seite.

## 2. Was 0.14.0 ändert

| # | Änderung | Wirkung |
|---|---|---|
| 1 | **Zeichnen wird zusammengefasst** (`draw()` in `main.ts`): läuft ein Zeichnen, teilen sich alle weiteren Aufrufe **ein** folgendes, das den neuesten Stand liest. | Keine Warteschlange alter Bilder mehr; höchstens ein Zeichnen im Rückstand. Gilt für alle Seiten. |
| 2 | **HUD-Layout** (Auto, Standard): Pfeil 200 × 200 als 2 Bilder (606 B + 876 B), **nur bei neuem Manövertyp**; Tempolimit-Schild 96 × 96 (640 B) **nur bei neuem Limit**. Entfernung, Tempo, ETA, Akku, Hinweise sind **Text**. | Pro Fix und pro Sekunde: **0 Bilder**. Getestet: 8 Fixes und 2 s Fortschreibung → keine Bild-Uploads (`tests/hud-main.test.ts`). |
| 3 | **Unveränderte Textfelder werden nicht geschrieben** (`render.ts`, `sentContent`). | Typisch 1–2 statt 6 BLE-Schreibvorgänge pro Sekunde (Entfernung, ggf. Tempo). Dringendes zuerst: Entfernung, Mitte, Tempo, Hinweis, Straße, Status. |
| 4 | **Fortschreibung der Entfernung** (`reckonDistance`): zwischen zwei Fixes d = d₀ − v·Δt, höchstens 4 s weit, nie unter 0; ein **1-s-Takt** zeichnet (nur Text). | Die Zahl läuft flüssig, auch wenn das Handy seltener liefert. |
| 5 | **GPS-Intervall 1 s** ausdrücklich angefragt (`intervalMs: 1000`), Filter 5 m bleibt. | Kein unbekannter Plattform-Standard mehr. |
| 6 | **Tempolimits für die ganze Route**: am öffentlichen Server bis zu 4 Teilanfragen nacheinander (1,1 s Abstand), am eigenen Server wie bisher eine. Weiterhin **einmal pro Route**, nie pro Fix. | Bremshinweise und Limitschild auch nach den ersten Kilometern. |
| 7 | Abseits der Route, Neuberechnung, GPS-Suche und bestätigter Stopp erscheinen **auf der HUD-Seite** (Hinweiszeile bzw. Mitte). | Kein Seiten-Neubau (auf echter Brille ~3 s, Eingaben verloren) in diesen Fällen. |
| 8 | Nach dem Aufbau einer Seite merkt sich der Renderer deren Texte und Längen. | Behebt nebenbei Geisterzeichen, wenn das erste Update kürzer war als der Seiteninhalt. |

Das klassische Layout (Einstellung „HUD-Layout: klassisch“) bleibt unverändert, profitiert
aber von 1, 3, 5 und 6.

## 3. Offene Punkte (ehrlich)

- **Große Zahlen gehen nur als Bild.** Die Brille hat genau eine Schriftgröße. Im neuen
  Layout sind Entfernung und Tempo deshalb normale Schrift – groß sind Pfeil und Limitschild.
  Ein großes Tempo als Bild hieße ein Upload bei jeder km/h-Änderung, also wieder Latenz.
  Falls gewünscht: großes Tempo als Bild nur in 5-km/h-Stufen und höchstens alle 3 s –
  bewusst **nicht** eingebaut.
- BLE-Zeit pro Bild auf echter Hardware nicht gemessen. Ein Test auf der Brille sollte die
  Zeit von `updateImageRawData` loggen.
- Ortsschild (OSM `city_limit`) liefert `trace_attributes` nicht als Attribut. Der Hinweis
  stützt sich auf den Limitabfall (Ortsgebiet 50 ist in OSM als `maxspeed` hinterlegt).
- Kein Ton/keine Vibration: das SDK hat dafür keine API, und in diesem Repo wird keine benutzt.
