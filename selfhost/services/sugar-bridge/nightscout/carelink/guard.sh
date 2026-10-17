#!/bin/sh
# Waechter vor der CareLink-Bruecke.
#  run   (Standard): startet die Bruecke NUR mit echten Zugangsdaten UND vorhandenem Login-Token.
#                    Sonst: Hinweis ins Log und schlafen (kein Login-Versuch, keine Neustart-Schleife).
#  login           : einmaliger, manueller Login (Alfred, interaktiv). Nur hier wird das Passwort benutzt.
#  doctor          : Vorabpruefung der Bruecke.
set -u
LOGIN_FILE="${CARELINK_LOGINDATA:-/data/logindata.json}"

placeholder() {
  case "${1:-}" in ""|BITTE_EINTRAGEN|your-carelink-*) return 0 ;; *) return 1 ;; esac
}
pause() {
  echo "$(date -Iseconds) [waechter] PAUSIERT: $1"
  echo "$(date -Iseconds) [waechter] Es wird NICHT bei CareLink angemeldet. Anleitung: selfhost/services/sugar-bridge/README.md"
  # Schlafen statt beenden: kein Neustart-Karussell. Nach dem Eintragen: docker compose up -d carelink
  exec sleep infinity
}

cmd="${1:-run}"
case "$cmd" in
  run)
    if placeholder "${CARELINK_USERNAME:-}" || placeholder "${CARELINK_PASSWORD:-}"; then
      pause "CARELINK_USERNAME/CARELINK_PASSWORD in /opt/nightscout/carelink.env sind noch Platzhalter."
    fi
    if [ ! -s "$LOGIN_FILE" ]; then
      pause "Noch kein Login-Token ($LOGIN_FILE). Einmalig: cd /opt/nightscout && docker compose run --rm -it carelink login"
    fi
    echo "$(date -Iseconds) [waechter] Zugangsdaten + Token vorhanden - Bruecke startet (Abruf alle ${CARELINK_INTERVAL:-300} s)."
    exec node dist/main.js
    ;;
  login)
    if placeholder "${CARELINK_USERNAME:-}" || placeholder "${CARELINK_PASSWORD:-}"; then
      echo "Erst CARELINK_USERNAME und CARELINK_PASSWORD in /opt/nightscout/carelink.env eintragen." >&2
      exit 2
    fi
    if [ -s "$LOGIN_FILE" ]; then
      echo "Login-Token existiert schon ($LOGIN_FILE). Fuer einen neuen Login erst loeschen: rm /opt/nightscout/carelink-data/logindata.json"
      exit 0
    fi
    exec node dist/login.js
    ;;
  doctor)
    exec node dist/doctor.js
    ;;
  *)
    exec "$@"
    ;;
esac
