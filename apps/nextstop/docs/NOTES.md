# Notizen zur Datenherkunft

## Warum zwei Backends

Gemessen an derselben Haltestelle (Salzburg Mirabellplatz) zur selben Minute:

| | ÖBB | Transitous |
|---|---|---|
| Abfahrten mit Echtzeit | 8 von 10 | 0 von 8 |
| Halte im Fahrtverlauf | 25 | 27 |
| Echtzeit je Halt | ja | nein |

Die Ursache steht in der Transitous-Konfiguration selbst
(`feeds/at.json`): von fünfzehn österreichischen Quellen hat genau eine
GTFS-RT hinterlegt, nämlich die Steiermark. Salzburg, Wien, Tirol und der
Rest laufen als reine Fahrpläne.

Das ist keine Schwäche Österreichs — die Daten existieren. Sie kommen nur über
einen anderen Weg.

## Der andere Weg

Die ÖBB betreibt einen HAFAS-Dienst, den ihre eigenen Apps nutzen:

    POST https://fahrplan.oebb.at/bin/mgate.exe

Keine Signatur, kein Schlüssel, kein Konto. Die Zugangsdaten stammen aus dem
ÖBB-Profil von `hafas-client`:

    auth:   { type: "AID", aid: "OWDL4fE4ixNiPBBm" }
    client: { type: "IPH", id: "OEBB", v: "6030600", name: "oebbPROD-ADHOC" }
    ver:    "1.45"

Verwendete Methoden:

| Methode | wofür |
|---|---|
| `LocGeoPos` | Haltestellen im Umkreis, inklusive `dist` in Metern |
| `LocMatch` | Namenssuche — löst einen Steig auf seine Dach-Haltestelle auf |
| `StationBoard` | Abfahrten mit `dTimeS` (Plan) und `dTimeR` (Ist) |
| `JourneyDetails` | Fahrtverlauf mit Koordinaten, Zeiten und Polyline |

**Das ist keine veröffentlichte Open-Data-Schnittstelle.** Sie kann sich ohne
Ankündigung ändern. Deshalb wird jedes Feld als optional gelesen: fällt
`dTimeR` weg, zeigt die App Fahrplanzeiten und sagt das auch — sie stürzt
nicht ab und erfindet nichts.

## Zeitformat

HAFAS schreibt Zeiten als `HHMMSS`, optional mit vorangestelltem Tagesversatz.
`01000500` ist also 00:05 **am Folgetag**. Wird der Versatz ignoriert, landet
ein Nachtbus sechzehn Stunden in der Vergangenheit und sortiert sich an den
Anfang der Tafel.

## Transitous

    GET /api/v1/map/stops?min=lat,lon&max=lat,lon
    GET /api/v1/stoptimes?stopId=…&n=…
    GET /api/v1/trip?tripId=…

Ein erkennbarer User-Agent ist Pflicht — ohne kommt 403. Der Dienst wird
ehrenamtlich betrieben; das Aktualisierungsintervall ist deshalb nach unten
auf zehn Sekunden begrenzt.
