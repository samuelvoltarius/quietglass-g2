# Brillen-Melder (glass-notify)

Even-Hub-Apps auf der G2 laufen nur, solange sie offen sind — **Handy-Benachrichtigungen kommen aber
immer auf die Brille**. Der Brillen-Melder beobachtet die eigenen Dienste und schickt bei Ereignissen
eine **kurze Telegram-Nachricht** (wird zur Handy-Benachrichtigung → Brille).

Läuft als systemd-**User**-Dienst auf dem Raspberry Pi. Nur Python-Standardbibliothek (3.9+).
Selbsttest: `python3 glass_notify.py --selftest`.

> **Kein medizinischer Alarm.** Die Zucker-Meldungen sind nur ein Zusatzhinweis — sie können
> verspätet kommen oder ganz ausfallen (Netz, Telegram, Pi, Uploader, Ruhemodus des Handys).
> **Lass die Alarme deiner Pumpe/CGM-App unbedingt an.** Maßgeblich sind Pumpe und Sensor.

## Was gesendet wird

Klartext, höchstens 200 Zeichen, ohne Linkvorschau, vorne ein Kennzeichen.

| Wächter | Ereignis | Beispiel |
|---|---|---|
| Drucker (`NOTIFY_KLIPPER_URL`, Klipper-Bridge `GET /api/printer`) | Druck fertig / abgebrochen / Fehler / pausiert | `🖨 Druck fertig: Halter_v2 (3 h 12 min)` · `🖨 Druck abgebrochen: Halter_v2 nach 45 min` · `🖨 Druckfehler: … – <Klipper-Meldung>` · `🖨 Druck pausiert: Halter_v2 (40 %)` |
| Auto (`NOTIFY_BYD_URL`, BYD-Bridge `GET /state`) | Laden zu Ende (Modus *charging* → *parked*) | `🚗 Laden fertig: 96 %, 305 km` (ab Ladeziel oder ≥ 95 %), sonst `🚗 Laden beendet: 62 %, 190 km`; abstecken und losfahren bleibt still |
| | Warnung `unlocked` der Bridge (geparkt, > 10 min offen) | `🚗 Auto seit 12 min nicht abgesperrt` |
| Zucker (`NOTIFY_SUGAR_URL`, sugar-bridge `/api/v1/entries/sgv.json`) | niedrig: < 70, oder < 80 und `SingleDown`/`DoubleDown` | `🩸 Zucker 68 ↓ – niedrig` · `🩸 Zucker 78 ⇊ – fällt schnell` |
| | sehr niedrig < 55 (sofort, auch mitten in einer Tief-Phase) | `🩸 Zucker 53 ⇊ – sehr niedrig!` |
| | hoch > 250 | `🩸 Zucker 265 ↑ – hoch` |
| | wieder gut (Hysterese: ab 80 bzw. unter 230) | `🩸 Zucker 92 ↗ – wieder im Bereich` |
| | > 20 min kein Wert, obwohl vorher welche kamen | `🩸 Seit 21 min keine Zuckerwerte` |
| Server (`NOTIFY_STATUS_URLS`, Status-Glass-Server `GET /status`) | > 5 min nicht erreichbar / wieder da | `🖥 Spark nicht erreichbar seit 5 min` · `🖥 Spark wieder erreichbar (12 min weg)` |
| | neues Gerät im Heimnetz (`network.devices[].new`) | `🌐 Neues Gerät im Netz: Galaxy-S24 (10.0.0.23)`; ab 4 Geräten eine Sammelnachricht |

Wiederholungen: niedrig höchstens alle 20 min, solange es niedrig bleibt (unter 55 sofort, einmal je
Unterschreitung); hoch höchstens alle 60 min. Jede Meldung hat einen Schlüssel — dieselbe Meldung geht
nie zweimal raus, auch nicht nach einem Neustart (Zustand in `~/.local/state/glass-notify/state.json`,
Rechte 600, atomar geschrieben). Kann Telegram nicht erreicht werden, wird bis zu 1 h nachgesendet.

**Ruhezeit** (`NOTIFY_QUIET=23:00-07:00`): dann gehen nur Zucker-Meldungen und „Server nicht
erreichbar“ raus. Drucker-/Auto-Meldungen und „wieder erreichbar“ werden verworfen; neue Geräte im
Netz werden nach der Ruhezeit gemeldet (die Status-Seite führt sie 24 h als neu).

Ist eine Quelle nur kurz weg, ändert sich nichts (veraltete BYD-Daten, Drucker „offline“ und fehlende
Antworten werden ignoriert; der letzte Zustand bleibt).

## Senden über Telegram

Benutzt den Telegram-Bot des Hermes-Agenten. Bei **jedem** Senden werden aus `NOTIFY_HERMES_ENV`
(Standard `~/.hermes/.env`) gelesen: `TELEGRAM_BOT_TOKEN` und `TELEGRAM_HOME_CHANNEL` (fehlt der Kanal:
erste Nummer aus `TELEGRAM_ALLOWED_USERS`; `NOTIFY_CHAT_ID` überschreibt).

- Der Token wird nie ausgegeben, protokolliert oder gespeichert (auch nicht in Fehlermeldungen).
- Der Dienst ruft **nur `sendMessage`** auf, nie `getUpdates` o. Ä. — der Bot wird von Hermes abgefragt,
  ein zweiter Leser würde ihm Nachrichten wegnehmen.
- Im Journal stehen nur Art und Erfolg („gesendet: sugar“), keine Werte.

## Umgebung

| Variable | Standard | Bedeutung |
|---|---|---|
| `NOTIFY_KLIPPER_URL` | – (aus) | Klipper-Bridge; nur Host → `/api/printer` wird angehängt |
| `NOTIFY_BYD_URL` | – (aus) | BYD-Bridge; nur Host → `/state` |
| `NOTIFY_SUGAR_URL` | – (aus) | sugar-bridge; ohne `sgv.json` → `/api/v1/entries/sgv.json?count=3` |
| `NOTIFY_STATUS_URLS` | – (aus) | `Name\|URL,Name\|URL` (in Anführungszeichen); nur Host → `/status` |
| `NOTIFY_KLIPPER_TOKEN`, `NOTIFY_BYD_TOKEN`, `NOTIFY_SUGAR_TOKEN`, `NOTIFY_STATUS_TOKEN` | leer | optionaler Bearer je Wächter (im Tailnet per `tailscale serve` meist unnötig) |
| `NOTIFY_HERMES_ENV` | `~/.hermes/.env` | Datei mit Bot-Token und Ziel-Chat |
| `NOTIFY_CHAT_ID` | leer | anderer Ziel-Chat |
| `NOTIFY_QUIET` | leer | Ruhezeit `HH:MM-HH:MM`, auch über Mitternacht |
| `NOTIFY_INTERVAL` / `NOTIFY_TIMEOUT` | 60 / 10 | Sekunden zwischen Runden / je Anfrage |
| `NOTIFY_STATE` | `~/.local/state/glass-notify/state.json` | Zustand |
| `NOTIFY_BYD_TARGET` | 80 | Ladeziel in %, ab dem „Laden fertig“ gemeldet wird |
| `NOTIFY_SUGAR_LOW` / `_URGENT` / `_HIGH` | 70 / 55 / 250 | Grenzen in mg/dL |
| `NOTIFY_SUGAR_STALE_MIN` | 20 | Minuten ohne Wert bis zur Meldung |
| `NOTIFY_DOWN_MIN` | 5 | Minuten nicht erreichbar bis zur Meldung |

Vorlage: [`.env.example`](.env.example) (nur Platzhalter-Adressen `*.example.ts.net`).

## Einrichten (Raspberry Pi, User-Dienst)

```bash
mkdir -p ~/glass-notify ~/.config/systemd/user
cp glass_notify.py ~/glass-notify/
cp .env.example ~/glass-notify/.env && chmod 600 ~/glass-notify/.env   # Adressen eintragen
python3 ~/glass-notify/glass_notify.py --selftest                        # muss "alles gruen" sagen
set -a; . ~/glass-notify/.env; set +a
python3 ~/glass-notify/glass_notify.py --dry-run --once                  # nur anzeigen, nichts senden
python3 ~/glass-notify/glass_notify.py --test-message                    # "✅ Brillen-Melder aktiv" aufs Handy
cp glass-notify.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now glass-notify
loginctl enable-linger "$USER"                                           # läuft auch ohne Anmeldung
journalctl --user -u glass-notify -n 20                                  # zurücklesen
```

Der Pi muss im Tailnet sein und die Dienste über ihre `tailscale serve`-Adressen erreichen; der
Tailscale-Login des Pi muss in deren Zugriffsliste stehen (z. B. `SUGAR_TAILSCALE_USERS`).

Aufrufe: `--dry-run` (Nachrichten ausgeben statt senden, Zustand nicht speichern), `--once` (eine
Runde), `--test-message`, `--selftest` (alle Übergänge mit Fake-Daten, ohne Netz; prüft auch Länge,
Ruhezeit, Doppelte, Nachsenden und dass der Token nie in der Ausgabe steht).
