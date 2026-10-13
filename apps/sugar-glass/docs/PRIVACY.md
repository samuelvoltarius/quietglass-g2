# Sugar Glass — privacy

## Kurzfassung (Deutsch)

Sugar Glass liest Glukosewerte, Pumpenstatus und Behandlungen **nur** von deinem
eigenen Nightscout bzw. der Sugar-Glass-Bridge davor, die du am Handy einträgst
(oder die ein privater Build mitbringt). Nur Lesen, nie Schreiben. Kein Konto,
kein Tracking, kein Mikrofon, kein Standort. Werte bleiben nur im Speicher der App.

**Nur zur Information, keine Therapieentscheidungen – maßgeblich sind Pumpe und
Sensor.** Sugar Glass ist kein Medizinprodukt und keine Alarmfunktion.

## Short version

The app reads only from the Nightscout (or Sugar Glass bridge) you run and
enter. Read only. Nothing else is contacted, nothing is collected. Not a medical
device, not an alarm: your pump and sensor are what count.

## Permissions

| Permission (`app.json`) | Why | Used for nothing else |
|---|---|---|
| `network` (`http://*`, `https://*` in the public build; one exact origin in a private build) | Read `entries/sgv.json` and `devicestatus.json` once a minute and `treatments.json` every five minutes while the app is open | No other host is contacted. Without an address nothing is sent. |

## What is stored on the phone

| Data | Key | Leaves the device |
|---|---|---|
| Server address, unit, target range, alert limits, swipe direction | `quietglass.sugarglass.v1` | No |
| Nightscout token (optional, only without the bridge) | same | Only to your server, as `?token=` (Nightscout's own way), never logged, never shown in full |
| Language choice | `quietglass.locale` | No |

Readings are held in memory only. The recommended setup is the bridge, which
keeps the token on your server; the app then needs none.
