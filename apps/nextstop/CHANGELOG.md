# Changelog

Alle nennenswerten Änderungen an NextStop.

## [Unveröffentlicht]

### Geändert

- Transitous ist jetzt die Voreinstellung: es ist ohne Zusatzprogramm aus der
  Even-App erreichbar (CORS geprüft). ÖBB-Echtzeit bleibt als Option für
  Österreich, die Proxy-Adresse liegt unter „Erweitert“.
- `app.json` fragt nach dem Standort und erlaubt das Netzwerk; ohne die
  Standort-Berechtigung kam die App nie über „Warte auf GPS“ hinaus.
  `supported_languages` nennt jetzt Deutsch, die Sprache der App.
- Fehler und Wartezustände auf der Brille sagen in einfachen Worten, was zu
  tun ist, statt „Backend“, „Proxy“ oder rohe Browser-Fehler zu zeigen.
- Handy-App: ein Satz oben sagt, was als Nächstes zu tun ist; Quellenhinweis
  auf transitous.org/sources, wie die Transitous-Nutzungsregeln verlangen.

## [0.1.0] — 2026-09-25

Erste Fassung.

### Enthalten

- Abfahrtstafel für die Haltestelle, an der man gerade steht, per GPS gefunden.
- Fahrtverfolgung: der nächste Halt unterwegs, aus GPS und Uhr abgeleitet.
- Zwei Datenquellen, beide ohne Schlüssel: ÖBB (Österreich, mit Echtzeit) und
  Transitous/MOTIS (viele Länder, selbst hostbar).
- Herkunft jeder Zeit sichtbar — gemessen, gemeldet oder nur geplant.
- CORS-Proxy für die ÖBB, weil deren Schnittstelle keine Header schickt.

### Beim Bauen gefunden

Festgehalten, weil es beim nächsten Mal wieder Zeit kosten würde.

- **Die ÖBB-Gleisfelder heißen `dPltfS` und `dPltfR`**, nicht `dPlatf…` —
  obwohl direkt daneben ein `dPlatfCh` steht. Der Tippfehler liefert still
  ein leeres Feld statt eines Fehlers.
- **GPS findet am Mirabellplatz sechs Haltestellen**, 35 m auseinander, jede
  mit einem Bruchteil der Abfahrten. Die Dach-Haltestelle mit allen Steigen
  existiert, aber nichts im Datensatz verweist auf sie — sie wird über den
  Namen aufgelöst, der sich dabei ändern kann (Hanuschplatz →
  Ferdinand-Hanusch-Platz).
- **Die Brillen-Schrift ist proportional, nicht monospace.** Spalten per
  Leerzeichen richten nichts aus; es entsteht eine krumme Treppe.
- **`▸` zeichnet die Brille gar nicht.** Der Auswahlpfeil verschwand
  wortlos — jetzt ASCII.
- **Ein Schnitt auf feste Länge zerhackt Klammern**: „Salzburg Makartplatz
  (Aicherpass". Der Steig wird jetzt zuerst entfernt, dann gekürzt.
- **Transitous antwortet 403 ohne erkennbaren User-Agent.** Kein
  User-Agent und ein bloßes „node" werden abgewiesen.
- **Entfernung allein sagt nicht, ob ein Halt vor oder hinter einem liegt.**
  Eine frühere Fassung sprang bei 120 m weiter und meldete den übernächsten
  Halt, während der aktuelle noch durch die Scheibe zu sehen war. Das
  entscheidet jetzt der Fahrplan.
