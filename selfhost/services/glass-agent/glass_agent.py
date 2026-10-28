#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Brillen-Agent: macht einen eigenen KI-Agenten (z. B. Hermes) zum "Even AI" der G2.

In der Even-App unter "Agent hinzufuegen" eintragen:
    URL        https://<dieser-rechner>/v1/chat/completions   (vollstaendig, die App haengt nichts an)
    Schluessel der Wert von GLASS_AGENT_TOKEN

Was die Even-App schickt (nicht offiziell dokumentiert, von der Community ermittelt
und hier selbst geprueft): ein OpenAI-Chat-Request mit "model":"openclaw", NUR dem
letzten Satz, ohne Verlauf, ohne Systemtext, ohne "stream". Die Brille zeigt nur
etwa 400-500 Zeichen. Dieser Dienst gleicht das aus:

  * Verlauf: das laufende Gespraech wird GLASS_AGENT_CONTEXT_TTL Sekunden (Standard
    300) gemerkt und mitgeschickt, damit Rueckfragen ("und morgen?") funktionieren.
    "Neues Gespraech" / "new conversation" beginnt von vorn. Nur im Speicher.
  * Systemtext: der Agent erfaehrt, dass die Antwort auf eine Brille geht (kurz,
    ohne Emojis und Formatierung) - plus GLASS_AGENT_SYSTEM_EXTRA.
  * Antwort: Markdown, Emojis und Tabellenzeichen raus, auf GLASS_AGENT_CHAR_BUDGET
    (Standard 350) Zeichen gekuerzt, moeglichst am Satzende.
  * Der Schluessel des Agenten (UPSTREAM_KEY) bleibt auf diesem Rechner; die Even-App
    kennt nur GLASS_AGENT_TOKEN.

Endpunkte
    POST /v1/chat/completions   (auch POST /)  OpenAI-Format rein und raus
    GET  /health                ohne Anmeldung, ohne Inhalte

Umgebung
    GLASS_AGENT_HOST / _PORT        Standard 127.0.0.1 / 8657 (davor `tailscale serve`)
    GLASS_AGENT_TOKEN               Pflicht: Bearer-Token, das die Even-App schickt
    GLASS_AGENT_UPSTREAM_URL        OpenAI-kompatibler Endpunkt des Agenten, vollstaendig
    GLASS_AGENT_UPSTREAM_KEY        dessen Bearer-Schluessel (optional)
    GLASS_AGENT_UPSTREAM_MODEL      Modellname nach oben (Standard: was die App schickt)
    GLASS_AGENT_UPSTREAM_PROVIDER   Anbieter nach oben, z. B. "openai-codex" - Hermes' API nimmt
                                    "provider"/"model" je Anfrage an, so bekommt nur die Brille
                                    ein schnelles Modell (Hermes' Standard bleibt unberuehrt)
    GLASS_AGENT_FALLBACKS           Ausweich-Kette, mit "," (oder ";") getrennt, der Reihe nach probiert, wenn der
                                    vorige Weg scheitert (Fehler, Zeitueberschreitung, Kontingent leer):
                                      "anthropic/claude-haiku-5-5"   gleicher Agent, anderer Anbieter/Modell
                                      "direct=http://host:8000/v1/chat/completions#qwen"
                                                                     direkt ein OpenAI-Endpunkt (ohne Agent,
                                                                     ohne Schluessel; z. B. eigenes vLLM)
                                    Ein Weg, der mit "Kontingent/Limit" scheitert, wird 15 min uebersprungen.
                                    Ausgewichen wird NUR bei echten Fehlern (HTTP-Fehler, Verbindung
                                    abgelehnt, Kontingent/429/Limit) - nicht, weil der Agent langsam ist.
                                    Direkte Wege bekommen einen Systemsatz: keine Werkzeuge, keine Live-Daten.
    GLASS_AGENT_BUDGET              Sekunden, die die Brille auf eine Antwort wartet (Standard 24; die
                                    Even-App gibt nach ~30 s auf). Ist der Agent bis dahin nicht fertig,
                                    arbeitet er im Hintergrund weiter, die Brille bekommt "Ich bin noch
                                    dran - frag gleich mit 'und?' nach.", und das Ergebnis kommt mit der
                                    naechsten Aeusserung (gemerkt in GLASS_AGENT_STATE, 10 min):
                                      "und?" / "Ergebnis?" / "fertig?" -> nur das Ergebnis (wartet notfalls
                                                                          nochmal bis zum Budget)
                                      eine andere Frage                -> "Vorhin: <Ergebnis kurz>" vorn,
                                                                          dann die Antwort auf die neue Frage
    GLASS_AGENT_TIMEOUT             Sekunden, nach denen ein haengender Weg als Fehler gilt (Standard 120;
                                    laeuft im Hintergrund, die Brille wartet nur GLASS_AGENT_BUDGET)
    GLASS_AGENT_STATE               Datei fuer den laufenden Verlauf, damit er einen Neustart uebersteht
                                    (Standard: conversation.json neben dem Skript, Rechte 600)
    GLASS_AGENT_LOG_CONTENT=1       Mitschnitt mit Inhalt (Frage, Verlauf, Weg, Antwort) in
                                    GLASS_AGENT_LOG_FILE (Standard conversations.log, Rechte 600).
                                    Aus = nur Laenge und Dauer.
    GLASS_AGENT_CHAR_BUDGET         Standard 350
    GLASS_AGENT_CONTEXT_TTL         Standard 300, 0 = kein Verlauf
    GLASS_AGENT_MAX_TURNS           gemerkte Frage/Antwort-Paare, Standard 8
    GLASS_AGENT_SYSTEM_EXTRA        zusaetzlicher Systemtext (optional)
    GLASS_AGENT_APPROVAL            Freigabe-Stufe: auto (Standard, wie bisher) | mixed | ask
                                      auto   Chat-Completions, Hermes fuehrt alles ohne Rueckfrage aus
                                             (soweit Hermes' eigenes approvals.mode das zulaesst)
                                      mixed  Runs-API; Hermes-Freigaben fuer erkennbar nur lesende
                                             Befehle/Werkzeuge gibt der Dienst selbst, alles andere
                                             fragt er auf der Brille ("Sag ja oder nein")
                                      ask    Runs-API; jede Hermes-Freigabe wird auf der Brille gefragt
                                    Zur Laufzeit per Sprache: "Freigabe auf auto" / "Freigabe gemischt" /
                                    "Freigabe immer fragen" (bleibt in GLASS_AGENT_STATE gespeichert).
                                    Hermes fragt nur, wenn dort approvals.mode nicht "off" ist.
    GLASS_AGENT_APPROVAL_TTL        Sekunden, die eine offene Rueckfrage gilt (Standard 90); danach und bei
                                    jeder anderen Aeusserung wird die Freigabe abgelehnt und der Run gestoppt

Datenschutz: ohne GLASS_AGENT_LOG_CONTENT werden Fragen und Antworten NICHT protokolliert, nur Laenge,
Dauer und der genutzte Weg. Der laufende Verlauf (hoechstens CONTEXT_TTL alt) liegt in GLASS_AGENT_STATE.
Nur Standardbibliothek, Python 3.9+.   Selbsttest: python3 glass_agent.py --selftest
"""

import hashlib
import hmac
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = os.environ.get("GLASS_AGENT_HOST", "127.0.0.1")
PORT = int(os.environ.get("GLASS_AGENT_PORT", "8657"))
TOKEN = os.environ.get("GLASS_AGENT_TOKEN", "")
UPSTREAM_URL = os.environ.get("GLASS_AGENT_UPSTREAM_URL", "")
UPSTREAM_KEY = os.environ.get("GLASS_AGENT_UPSTREAM_KEY", "")
UPSTREAM_MODEL = os.environ.get("GLASS_AGENT_UPSTREAM_MODEL", "")
UPSTREAM_PROVIDER = os.environ.get("GLASS_AGENT_UPSTREAM_PROVIDER", "")
TIMEOUT = float(os.environ.get("GLASS_AGENT_TIMEOUT", "120"))
# Agent-Wege (Hermes) laufen gestreamt: nur bei einem abgerissenen Stream bricht Hermes den Lauf ab. Nach so vielen
# Sekunden gibt der Dienst auf und schliesst die Verbindung - sonst rechnet Hermes weiter und belegt seine Plaetze.
AGENT_MAX_S = float(os.environ.get("GLASS_AGENT_AGENT_MAX", "45"))
BUDGET = float(os.environ.get("GLASS_AGENT_BUDGET", "24"))
HERE = os.path.dirname(os.path.abspath(__file__))
STATE_FILE = os.environ.get("GLASS_AGENT_STATE", os.path.join(HERE, "conversation.json"))
LOG_CONTENT = os.environ.get("GLASS_AGENT_LOG_CONTENT", "") == "1"
LOG_FILE = os.environ.get("GLASS_AGENT_LOG_FILE", os.path.join(HERE, "conversations.log"))
FALLBACKS = os.environ.get("GLASS_AGENT_FALLBACKS", "")
COOLDOWN_S = 15 * 60
CHAR_BUDGET = int(os.environ.get("GLASS_AGENT_CHAR_BUDGET", "350"))
CONTEXT_TTL = float(os.environ.get("GLASS_AGENT_CONTEXT_TTL", "300"))
MAX_TURNS = int(os.environ.get("GLASS_AGENT_MAX_TURNS", "8"))
SYSTEM_EXTRA = os.environ.get("GLASS_AGENT_SYSTEM_EXTRA", "").strip()
MAX_BODY = 64 * 1024
APPROVAL_MODES = ("auto", "mixed", "ask")
APPROVAL_DEFAULT = os.environ.get("GLASS_AGENT_APPROVAL", "auto").strip().lower()
if APPROVAL_DEFAULT not in APPROVAL_MODES:
    APPROVAL_DEFAULT = "auto"
APPROVAL_TTL = float(os.environ.get("GLASS_AGENT_APPROVAL_TTL", "90"))
# Routing nach Art der Frage (siehe classify): "jetzt" beantwortet der Dienst selbst, "wissen" geht direkt an
# ein schnelles Modell (ohne Agent), "nachschauen" an den Agenten, "tun" an den Agenten mit TASK_MODEL.
ROUTING = os.environ.get("GLASS_AGENT_ROUTING", "1") != "0"
FAST_URL = os.environ.get("GLASS_AGENT_FAST_URL", "")
FAST_KEY = os.environ.get("GLASS_AGENT_FAST_KEY", "")
FAST_MODEL = os.environ.get("GLASS_AGENT_FAST_MODEL", "")
TASK_MODEL = os.environ.get("GLASS_AGENT_TASK_MODEL", "")
TASK_APPROVAL = os.environ.get("GLASS_AGENT_TASK_APPROVAL", "mixed").strip().lower()
PROFILE_FILE = os.environ.get("GLASS_AGENT_PROFILE_FILE", "")
PROFILE_CHARS = 1500
TZ_NAME = os.environ.get("GLASS_AGENT_TZ", "Europe/Vienna")
# "server": Status-Server (reference-server.mjs, GET /status) direkt fragen statt den Agenten suchen zu lassen.
# Format: "Name,alias,alias|https://host:8451/status;Name2|url2"
STATUS_SOURCES = os.environ.get("GLASS_AGENT_STATUS_SOURCES", "")
STATUS_TIMEOUT = 4.0
# "wetter": Open-Meteo (ohne Schluessel) am Standort - Handy-Tracker aus Home Assistant, wenn frisch, sonst daheim.
WEATHER = os.environ.get("GLASS_AGENT_WEATHER", "1") != "0"
WEATHER_URL = "https://api.open-meteo.com/v1/forecast"
TRACKER_FRESH_S = 2 * 3600
# "arbeit": Shoot-Day ueber die Steuerzentrale (GET JSON: aktiv, projekte, dispo) fuer "Was steht an?".
ARBEIT_URL = os.environ.get("GLASS_AGENT_ARBEIT_URL", "")
# "reicht es bis X?": Ort suchen (Photon-kompatibel, GET /api/?q=) und Strecke berechnen (Valhalla) - beides
# eigene Dienste; ohne die zwei Adressen gibt es diese Frage nicht.
GEOCODER_URL = os.environ.get("GLASS_AGENT_GEOCODER", "")      # z.B. https://<host>/api/
ROUTER_URL = os.environ.get("GLASS_AGENT_ROUTER_URL", "")      # Valhalla-Basis, z.B. https://<host>:8455
# Erinnerungen: gemerkt in einer Datei, faellig -> Home-Assistant-Benachrichtigung (aufs Handy, die Even-App
# spiegelt sie auf die Brille).
# Ladestopps, wenn der Akku nicht reicht: Ladeplaner (POST plan mit start/ziel/soc_start/fahrzeug), oeffentlich.
PLANNER_URL = os.environ.get("GLASS_AGENT_PLANNER_URL", "")
PLANNER_VEHICLE = os.environ.get("GLASS_AGENT_PLANNER_VEHICLE", "")
PLANNER_TIMEOUT = 4.0
# Teleskop (Star-Glass-Bridge GET /api/star) und offene Aufgaben (Agentic OS GET /tasks?status=open).
STAR_URL = os.environ.get("GLASS_AGENT_STAR_URL", "")
TASKS_URL = os.environ.get("GLASS_AGENT_TASKS_URL", "")
# "netz": wer ist im Heimnetz (arp-scan ueber sudo, feste Argumente; Namen aus der Geraeteliste "lan").
LAN_SEEN_FILE = os.environ.get("GLASS_AGENT_LAN_SEEN", os.path.join(HERE, "lan_seen.json"))
REMINDER_FILE = os.environ.get("GLASS_AGENT_REMINDERS", os.path.join(HERE, "reminders.json"))
# Optional: Systemseite der Steuerzentrale (GET, JSON mit "dienste" und "zertifikate") - kommt bei "Laeuft alles?" dazu.
SYSTEM_URL = os.environ.get("GLASS_AGENT_SYSTEM_URL", "")
CERT_WARN_DAYS = 14
# "agenten": Health-Adressen der eigenen Agenten, gleiches Format: "Nova,hermes|http://…/health;Brutus|…"
AGENT_SOURCES = os.environ.get("GLASS_AGENT_AGENTS", "")
# "nachschauen" ohne klares Stichwort zuerst ans schnelle Modell; nur wenn es AGENT sagt, an den Agenten.
FAST_FIRST = os.environ.get("GLASS_AGENT_FAST_FIRST", "1") != "0"
FAST_FIRST_WAIT = 3.2
AGENT_MARK = "AGENT"
FAST_FIRST_NOTE = (" Wenn du fuer die Antwort aktuelle Daten, Werkzeuge, Alfreds Dateien, Nachrichten, Termine, "
                   "Entfernungen oder Geraete brauchst oder etwas getan werden soll, antworte NUR mit dem Wort AGENT. "
                   "Erfinde nie Zahlen (Kilometer, Preise, Zeiten) und schaetze sie nicht aus dem Gespraech.")
# "zuhause": feste Befehle direkt an Home Assistant (Geraeteliste als JSON, siehe README) statt den Agenten
# jedes Mal selbst suchen zu lassen.
HOME_FILE = os.environ.get("GLASS_AGENT_HOME_FILE", "")
HOME_TIMEOUT = 4.0
HOME_QUICK_S = 0.5         # so lange wartet die Antwort aufs Zuruecklesen; danach prueft ein Faden weiter
HOME_SETTLE_S = 8.0        # so lange prueft der Faden insgesamt
HOME_POLL_S = 0.25
# Zeitprotokoll: pro Anfrage eine JSON-Zeile mit allen Schritten und ihrer Dauer (Home Assistant, Zuruecklesen,
# Agent). Wortlaut von Frage/Antwort nur mit GLASS_AGENT_TRACE_TEXT=1. Auswerten: --trace-report
TRACE_FILE = os.environ.get("GLASS_AGENT_TRACE", "")
TRACE_TEXT = os.environ.get("GLASS_AGENT_TRACE_TEXT", "0") == "1"
_TRACE = threading.local()


def trace_start():
    _TRACE.steps, _TRACE.started = [], time.time()
    _TRACE.id = "%x" % int(_TRACE.started * 1000)
    return _TRACE.id


def trace_write(record):
    """Eine Zeile ans Protokoll haengen; Fehler beim Schreiben duerfen nie die Antwort stoeren."""
    if not TRACE_FILE:
        return
    try:
        with open(os.path.expanduser(TRACE_FILE), "a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
    except OSError:
        pass


def trace(what, **fields):
    """Schritt ins Protokoll der laufenden Anfrage (ohne laufende Anfrage: nichts)."""
    steps = getattr(_TRACE, "steps", None)
    if steps is not None:
        steps.append(dict(fields, what=what, at_ms=round((time.time() - _TRACE.started) * 1000)))
RESULT_TTL = 10 * 60       # so lange wird ein Hintergrund-Ergebnis fuer die naechste Aeusserung gemerkt
POLL_S = 0.5
BUSY_TEXT = "Das klärt Hermes, dauert bis zu einer Minute. Frag dann mit „und?“ nach."
DIRECT_NOTE = ("Du hast keine Werkzeuge und keine Live-Daten. Wenn die Frage aktuelle Daten oder Aktionen "
               "braucht, sag das in einem Satz ehrlich, statt so zu tun als würdest du prüfen.")
# Nachhaken nach einem Hintergrund-Ergebnis: nur die ganze Aeusserung ("und morgen?" ist eine neue Frage).
FOLLOW_RE = re.compile(r"^\s*(und|und jetzt|und nun|na|ergebnis|das ergebnis|fertig|schon fertig|bist du fertig|"
                       r"weiter|und weiter|was ist rausgekommen|was kam raus|and|result|done)\s*[?.!]*\s*$", re.I)
# Ungeduldiges Nachfragen ("ich warte immer noch auf deine Antwort", "hallo?") zaehlt wie "und?" -
# sonst geht es als neue Frage an den Agenten, der dann ziellos sucht, worauf gewartet wird.
WAIT_RE = re.compile(r"^\s*(hallo\s*\?+|bist du (noch )?da|noch da|und jetzt|und was ist|was ist (jetzt|nun)|"
                     r"wo bleibt (die|deine) antwort|(ich )?warte( immer)?( noch)?( auf (die|deine) antwort)?|"
                     r"ich warte (immer )?noch( auf (die|deine) antwort)?|antwort|hello|still there)\s*[?.!]*\s*$", re.I)
# Ohne offenen Vorgang: diese Nachfragen ehrlich beantworten statt sie dem Agenten zu geben.
# ("weiter", "na" und "und weiter" bleiben normale Aeusserungen.)
NOTHING_OPEN_RE = re.compile(r"^\s*(und|ergebnis|das ergebnis|fertig|schon fertig|bist du fertig|"
                             r"was ist rausgekommen|was kam raus|result|done)\s*[?.!]*\s*$", re.I)
NOTHING_OPEN_TEXT = "Gerade ist nichts offen – stell die Frage bitte nochmal."

SYSTEM_DE = (
    "Deine Antwort erscheint auf einer Datenbrille (Even Realities G2, 576x288 Pixel, "
    "nur Text). Antworte kurz: hoechstens 2-3 Saetze, unter %d Zeichen. Keine Emojis, "
    "kein Markdown, keine Listen, Tabellen oder Links. Die Fragen kommen per "
    "Spracherkennung und koennen Hoerfehler enthalten. Antworte auf Deutsch, ausser die "
    "Frage ist eindeutig in einer anderen Sprache gestellt."
)

RESET_RE = re.compile(r"^\s*(neues gespr[aä]ch|neu anfangen|vergiss (das|alles)|new conversation|start over)\b", re.I)
MODE_RE = re.compile(r"^\s*freigaben?\s+(?:auf\s+|ist\s+)?(auto(?:matisch)?|gemischt|mixed|(?:immer\s+)?fragen|ask)\b", re.I)
MODE_WORDS = {"auto": "auto", "automatisch": "auto", "gemischt": "mixed", "mixed": "mixed",
              "fragen": "ask", "immer fragen": "ask", "ask": "ask"}
MODE_SAY = {"auto": "Freigabe automatisch: Hermes fragt nicht nach.",
            "mixed": "Freigabe gemischt: Lesen geht automatisch, Ändern frage ich nach.",
            "ask": "Freigabe immer fragen: Jede Freigabe frage ich nach."}
# Antwort auf eine offene Rueckfrage: nur die ganze Aeusserung zaehlt ("ja, aber ..." ist eine neue Frage).
YES_RE = re.compile(r"^\s*(ja|jawohl|jo|ok|okay|mach|mach das|mach es|machs|bestätigt|bestaetigt|bestätige|"
                    r"freigeben|yes|yep|go)(\s+bitte)?\s*[.!]*\s*$", re.I)
NO_RE = re.compile(r"^\s*(nein|nee|stopp?|abbrechen|brich ab|abbruch|no|nope|nicht machen|lass es|cancel)"
                   r"(\s+(bitte|danke))?\s*[.!]*\s*$", re.I)

# Routing: feste Regeln, kein zusaetzlicher KI-Aufruf. Reihenfolge jetzt > tun > nachschauen > wissen;
# was keine Regel trifft, geht wie bisher an den Agenten ("nachschauen").
TIME_RE = re.compile(r"^\s*(wie sp[aä]t( ist es)?|wie ?viel uhr( ist es)?|welche uhrzeit( ist es)?|uhrzeit|"
                     r"what time is it)\s*(gerade|jetzt)?\s*[?.!]*\s*$", re.I)
DATE_RE = re.compile(r"^\s*(welcher tag ist (heute|es|gerade)|welches datum( ist (heute|es))?|"
                     r"der wievielte ist (heute|es)|welcher wochentag( ist (heute|es))?|"
                     r"was f[uü]r ein tag ist (heute|es)|datum|what day is it|what'?s the date)\s*(heute)?"
                     r"\s*[?.!]*\s*$", re.I)
TASK_RE = re.compile(r"^\s*(bitte\s+|kannst du\s+|k[oö]nntest du\s+|nova,?\s+|hermes,?\s+)?"
                     r"(schreib|schick|send|sende|starte?\b|stopp|stoppe|beende|erinner|erstell|leg\b|l[oö]sch|"
                     r"mach\b|bau\b|deploy|installier|[aä]nder|setz|plan|buch|ruf\b|trag\b|notier|merk dir|f[uü]g|"
                     r"[oö]ffne|schalt|aktivier|deaktivier|aktualisier|repar|richte|verschieb|kopier|"
                     r"benenn|archivier|remind|create|write|delete|start\b|stop\b)", re.I)
LOOKUP_RE = re.compile(r"(termin|kalender|heute|morgen|gestern|wochenende|woche|dashboard|aufgabe|todo|"
                       r"wetter|regen|temperatur|grad\b|server|dienst|status|l[aä]uft|nachricht|mail|telegram|"
                       r"whatsapp|wiki|notiz|news|neuigkeit|aktuell|preis|kurs|akku|reichweite|auto\b|byd|"
                       r"drucker|\btv\b|fernseh|beamer|licht|zuhause|spark|\bpi\b|pi5|ns1|\bvm\b|\bnas\b|"
                       r"projekt|\bstand\b|erinnerung|such|pr[uü]f|check|finde|wo ist|letzte|zuletzt|offen|"
                       r"sitzung|session|agent|hermes|claude|codex|quiet|glance|brille|xaventra|quietglass|"
                       r"weather|calendar|today|tomorrow|latest)", re.I)
KNOW_RE = re.compile(r"^\s*(wer bin ich|wer bist du|was ist|was sind|was hei(ß|ss)t|was bedeutet|wer war|"
                     r"wie funktioniert|warum|wieso|weshalb|erkl[aä]r|[uü]bersetz|wie sagt man|rechne|"
                     r"wie ?viel (ist|sind|ergibt)|was ergibt|wie gro(ß|ss)|wie weit|wie alt|wie hoch|wie lang|"
                     r"wie schreibt man|hauptstadt|definier|nenn mir|gib mir ein beispiel|"
                     r"who am i|who are you|what is|what are|why|how does|explain|translate)", re.I)
WEATHER_RE = re.compile(r"(wetter|regen|regnet|regnen|schirm|schnee|schneit|gewitter|sonnig|sonne scheint|"
                        r"wie warm|wie kalt|wieviel grad|wie viel grad|grad (hat es|ist es|drau)|drau(ß|ss)en|"
                        r"brauch ich (eine )?jacke|weather|rain)", re.I)
WMO = {0: "klar", 1: "meist klar", 2: "teils bewölkt", 3: "bewölkt", 45: "Nebel", 48: "Nebel", 51: "Niesel",
       53: "Niesel", 55: "Niesel", 56: "gefrierender Niesel", 57: "gefrierender Niesel", 61: "leichter Regen",
       63: "Regen", 65: "starker Regen", 66: "Eisregen", 67: "Eisregen", 71: "leichter Schnee", 73: "Schnee",
       75: "starker Schnee", 77: "Schneegriesel", 80: "Regenschauer", 81: "Regenschauer", 82: "heftige Schauer",
       85: "Schneeschauer", 86: "Schneeschauer", 95: "Gewitter", 96: "Gewitter mit Hagel", 99: "Gewitter mit Hagel"}
CAR_RE = re.compile(r"(\bauto\b|\bwagen\b|dolphin|\bbyd\b|\bsurf\b|reichweite|akku vom|ladestand|"
                    r"l[aä]dt (das|er|es)|abgesperrt|abgeschlossen|verriegelt|zugesperrt)", re.I)
CAR_ACT_RE = re.compile(r"\b(sperr\w*|entriegel\w*|[oö]ffne\w*|starte?\b|heiz\w*|klima\w*|vorheiz\w*|"
                        r"hup\w*|blink\w*|lade\b|laden\b|aufmachen|zumachen)|\bmach\w*\b.*\b(an|aus|auf|zu)\b", re.I)
ARBEIT_RE = re.compile(r"(was steht( heute| morgen)? an|was hab ich (heute|morgen)|was ist (heute|morgen) los|"
                       r"\bdreh\w*|dispo|shotliste|shot ?liste|shoot|projekt|termin\w*|kalender|"
                       r"wann muss ich|wo muss ich)", re.I)
STROM_RE = re.compile(r"(\bpv\b|photovoltaik|solar|sonnenstrom|wie ?viel strom|strom (heute|gemacht|erzeugt|produziert)|"
                      r"[uü]berschuss|einspeis|was hat die (anlage|pv))", re.I)
SHOPPING_RE = re.compile(r"einkaufsliste|einkaufszettel|shopping ?list", re.I)
SHOPPING_ADD_RE = re.compile(r"^\s*(bitte\s+)?(setz|schreib|pack|tu|f[uü]g|leg|notier)\w*\s+(?P<item>.+?)\s+"
                             r"(auf|zur|zu der|in die)\s+(die\s+|den\s+)?(einkaufsliste|einkaufszettel|liste)\b", re.I)
REACH_RE = re.compile(r"(wo (lade|laden|tanke)\w*|ladestopp\w*|reicht|schaff\w*|komm\w* ich|genug (akku|saft|strom|reichweite)|mit (dem|meinem) akku)\b.*?\b(bis nach|bis zum|bis zur|bis|nach|zum|zur|in die|ins)\s+"
                      r"(?P<ziel>[a-zäöüß][\wäöüß .-]{1,40}?)(?P<back>\s+und (wieder )?zur[uü]ck)?\s*[?.!]*\s*$", re.I)
REMIND_RE = re.compile(r"^\s*(bitte\s+)?erinner\w*\s+mich\s+(?P<when>.+?)\s+(an|daran,?\s+dass|dass|wegen|zu)\s+(?P<what>.+?)\s*[.!]*\s*$",
                       re.I)
SMALLTALK = ((re.compile(r"^\s*(danke( dir| sch[oö]n)?|vielen dank|merci|thanks?( you)?|super,? danke|ok,? danke|passt,? danke)\s*[.!]*\s*$", re.I), "Gern."),
             (re.compile(r"^\s*(hallo|hi|hey|servus|gr[uü](ß|ss) dich|guten (morgen|tag|abend))\s*[.!]*\s*$", re.I), "Servus, Alfred."),
             (re.compile(r"^\s*(tsch[uü]ss|ciao|bis sp[aä]ter|gute nacht|baba)\s*[.!]*\s*$", re.I), "Bis später."))
REMIND_LIST_RE = re.compile(r"(welche|meine|offene)\s+erinnerung", re.I)
LAN_RE = re.compile(r"(welche|wie ?viele|was f[uü]r)\s+ger[aä]te.*\b(wlan|w-lan|netz|netzwerk|lan|online|eingeloggt|verbunden)|"
                    r"wer ist (gerade )?(im|online|in meinem) (wlan|netz)|was ist (gerade )?im (wlan|netz)|"
                    r"neue ger[aä]te im (wlan|netz)", re.I)
SUGAR_RE = re.compile(r"(blutzucker|zucker|glukose|glucose|\bbz\b|cgm|sensorwert)", re.I)
SUGAR_FOLLOW_RE = re.compile(r"\b(er|der|wert|wie (ist|hoch|steht)|und jetzt|gerade|aktuell|trend)\b", re.I)
SUGAR_FOLLOW_S = 3 * 60
PRICE_RE = re.compile(r"(strompreis|spotpreis|b[oö]rsenpreis|was kostet (der )?strom|strom (ist )?(gerade |jetzt )?"
                      r"(billig|g[uü]nstig|teuer)|wann ist (der )?strom|wann.*(strom|laden).*(billig|g[uü]nstig)|"
                      r"g[uü]nstigste (stunde|zeit))", re.I)
INTERNET_RE = re.compile(r"(internet|speedtest|bandbreite|download|upload|latenz|ping)\b.*"
                         r"(schnell|langsam|geschwindigkeit|speed|wie|gut|ok|l[aä]uft)|"
                         r"(wie schnell|wie gut|l[aä]uft) (ist |das )?(das )?internet", re.I)
SUN_RE = re.compile(r"sonnen(aufgang|untergang)|wann (geht|ist) die sonne|wann wird es (hell|dunkel)|"
                    r"wie lange (ist es noch )?hell", re.I)
STAR_RE = re.compile(r"(teleskop|aufnahme|n\.?i\.?n\.?a\b|guiding|belichtung|astro|sternwarte|sequenz|montierung)",
                     re.I)
TASKS_RE = re.compile(r"(offene|welche|meine) aufgaben|aufgaben im brain|was steht im brain|brain.*aufgabe|"
                      r"tasks?\b.*(offen|brain)", re.I)
DIM_PCT_RE = re.compile(r"\b(\d{1,3})\s*(%|prozent)", re.I)
BRIGHTER_RE = re.compile(r"\b(heller|aufhellen)\b", re.I)
DARKER_RE = re.compile(r"\b(dunkler|dimm\w*|abdunkeln)\b", re.I)
WARMER_RE = re.compile(r"\b(w[aä]rmer|warmwei(ß|ss)|gem[uü]tlich)\b", re.I)
COLDER_RE = re.compile(r"\b(k[aä]lter|kaltwei(ß|ss)|tageslicht|neutral)\b", re.I)
HOME_OVERVIEW_RE = re.compile(r"(home ?assistant|ger[aä]te|zuhause|daheim|im haus|wohnung|smart ?home)", re.I)
OVERVIEW_ASK_RE = re.compile(r"(wie geht|wie sieht|l[aä]uft|laufen|status|alles ok|alles gut|alles in ordnung|"
                             r"[uü]berblick|was ist an|was l[aä]uft|was ist los|zustand)", re.I)
AGENT_STATE_RE = re.compile(r"(wie geht|l[aä]uft|laufen|online|offline|erreichbar|status|alles ok|alles gut|wach|"
                            r"antwortet|lebt|h[aä]ngt|tot\b|da\s*\?)", re.I)
SERVER_RE = re.compile(r"(server|rechner|maschine|l[aä]uft|laufen|online|offline|erreichbar|status|auslastung|"
                       r"speicher|platte|festplatte|temperatur|\bram\b|\bcpu\b|abgest[uü]rzt|down\b|\bup\b)", re.I)
# Was "zuhause" nie schalten darf, egal was in der Geraeteliste steht (Auto, Laden, NAS, Schloesser ...).
HOME_DENY_RE = re.compile(r"(^lock\.|^cover\.|^climate\.|^alarm|surfmate|byd|overdrive|wallbox|ev_charger|"
                          r"kindersicherung|child|nas_|reboot|shutdown|emergency)", re.I)
HOME_DOMAINS = ("light", "switch", "media_player", "remote")    # Skripte: eigene Art "script" (nur starten)
LIGHT_WORD_RE = re.compile(r"(licht|lichter|lampe|lampen|beleuchtung|light)", re.I)
PLURAL_LIGHT_RE = re.compile(r"\b(lichter|lampen|beleuchtung)\b", re.I)
FOLLOW_UP_RE = re.compile(r"^\s*(und|was ist mit|wie ist es mit|und wie)\b", re.I)
ALL_RE = re.compile(r"\b(alle|alles|s[aä]mtliche|all)\b", re.I)
STATE_Q_RE = re.compile(r"^\s*(ist|sind|l[aä]uft|laufen|brennt|brennen|is)\b", re.I)
MUTE_RE = re.compile(r"(stumm|ton aus|ton ab|\bmute\b)", re.I)
UNMUTE_RE = re.compile(r"(ton (wieder )?an|ton ein|stumm aus|unmute)", re.I)
UP_RE = re.compile(r"\blauter\b|louder", re.I)
DOWN_RE = re.compile(r"\bleiser\b|quieter", re.I)
OFF_RE = re.compile(r"\b(aus|ausschalten|ausmachen|abschalten|abdrehen|off)\b", re.I)
ON_RE = re.compile(r"\b(an|ein|einschalten|anschalten|anmachen|aufdrehen|on)\b", re.I)
# Apps am Android-TV/Beamer: Wort -> Paketname (remote.turn_on mit activity). Pro Geraet ergaenz- oder
# ueberschreibbar mit "apps": {"wort": "paket"} in der Geraeteliste.
DEFAULT_APPS = {"netflix": "com.netflix.ninja", "youtube": "com.google.android.youtube.tv",
                "spotify": "com.spotify.tv.android", "disney": "com.disney.disneyplus",
                "prime": "com.amazon.amazonvideo.livingroom", "amazon": "com.amazon.amazonvideo.livingroom",
                "plex": "com.plexapp.android", "twitch": "tv.twitch.android.app", "kodi": "org.xbmc.kodi"}
APP_VERB_RE = re.compile(r"\b(starte?|[oö]ffne|[oö]ffnen|mach\w*|spiel\w*|zeig\w*|wechsel\w*|leg\w*|"
                         r"schau\w*|open|start|launch|play)\b", re.I)
WAKE_RE = re.compile(r"^\s*(hey|hei|hallo|hi|ok|okay)[\s,]+(even|evan|ivan|iven|eben|ewen|evie)\b[\s,.!:]*", re.I)
PRONOUN_RE = re.compile(r"\b(das|es|ihn|den|die|dem|wieder)\b", re.I)
WHY_RE = re.compile(r"^\s*(wieso|warum|weshalb|was hast du verstanden|was hast du gemacht|was war das)\s*[?.!]*\s*$", re.I)
PRONOUN_TTL = 5 * 60
CONFIRM_TTL = 30
HOME_CONFIRM = {}
FILLER_WORDS = ("der die das den dem des ein eine einen bitte mal mach mache machen schalt schalte schalten "
                "im in am an auf aus zu und jetzt wieder doch mir uns noch auch gleich sofort schnell danke "
                "licht lichter lampe lampen alle alles ganze ganzen ok okay ja so dann kannst du könntest "
                "würdest bitteschön schmeiß schmeiss wirf dreh drehe hey hallo es ihn sie ganz komplett "
                "fernseher tv wohnzimmer").split()
WHY_TTL = 3 * 60
LAST_HOME = {}
ACTION_SAY = {"dim": "dimmen", "script": "starten", "on": "einschalten", "off": "ausschalten", "up": "lauter", "down": "leiser", "mute": "stumm",
              "unmute": "Ton an", "status": "Zustand abfragen", "app": "App starten", "denied": "abgelehnt"}
W_QUESTION_RE = re.compile(r"^\s*(was|wie|wann|wo|wer|welche\w*|warum|wieso|gibt es|what|how)\b", re.I)
WEEKDAYS = ("Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag")


def classify(question):
    """Art der Frage: "jetzt" (Uhrzeit/Datum), "tun", "nachschauen" oder "wissen"."""
    if TIME_RE.match(question) or DATE_RE.match(question):
        return "jetzt"
    if HOME and home_command(question):
        return "zuhause"
    if HOME and HOME.get("shopping") and SHOPPING_RE.search(question):
        return "einkauf"         # vor "tun": "Schreib Milch auf die Einkaufsliste" ist kein Agenten-Auftrag
    if HOME and HOME.get("notify") and (REMIND_RE.match(question) or REMIND_LIST_RE.search(question)):
        return "erinnern"        # vor "tun"
    if HOME and HOME.get("car") and (CAR_RE.search(question) or (ROUTER_URL and GEOCODER_URL and REACH_RE.search(question))):
        return "auto"            # vor "tun": Befehle ans Auto gehen nie an den Agenten, die Antwort lehnt sie ab
    if TASK_RE.match(question):
        return "tun"
    if agent_question(question):
        return "agenten"
    if WEATHER and HOME and WEATHER_RE.search(question):
        return "wetter"
    if ARBEIT_URL and ARBEIT_RE.search(question):
        return "arbeit"
    if HOME and HOME.get("spot") and PRICE_RE.search(question):
        return "strompreis"
    if HOME and HOME.get("internet") and INTERNET_RE.search(question):
        return "internet"
    if SUN_RE.search(question) and HOME:
        return "sonne"
    if STAR_URL and STAR_RE.search(question):
        return "teleskop"
    if TASKS_URL and TASKS_RE.search(question):
        return "aufgaben"
    if HOME and HOME.get("sugar") and (SUGAR_RE.search(question) or (
            LAST_HOME.get("sugar_t", 0) > time.time() - SUGAR_FOLLOW_S and SUGAR_FOLLOW_RE.search(question))):
        return "zucker"          # "Wir sind beim Blutzucker" - "Wie ist er gerade?"
    if HOME and HOME.get("lan") and LAN_RE.search(question):
        return "netz"
    if HOME and HOME_OVERVIEW_RE.search(question) and OVERVIEW_ASK_RE.search(question):
        return "haus"
    if HOME and HOME.get("pv") and STROM_RE.search(question):
        return "strom"
    if STATUS_HOSTS:
        named = status_targets(question)
        if (SERVER_RE.search(question) and (named or re.search(r"(server|rechner|alle|alles)", question, re.I))) or (
                named and re.search(r"(wie geht('?s| es)|was macht|alles ok|alles gut|in ordnung)", question, re.I)):
            return "server"
    if LOOKUP_RE.search(question):
        return "nachschauen"
    if KNOW_RE.match(question):
        return "wissen"
    return "nachschauen"


def parse_status_sources(raw):
    """"Pi5,pi|url;ns1,mail|url" -> [{"name", "aliases", "url"}]."""
    hosts = []
    for entry in [e.strip() for e in (raw or "").split(";") if e.strip()]:
        names, _, url = entry.partition("|")
        names = [n.strip() for n in names.split(",") if n.strip()]
        if names and url.strip():
            hosts.append({"name": names[0], "aliases": [_squash(n) for n in names], "url": url.strip()})
    return hosts


def _squash(text):
    """Klein, ohne Leerzeichen/Punkte, "eins" -> "1" (Spracherkennung: "NS eins", "n.s. 1", "Pi 5")."""
    text = re.sub(r"\beins\b", "1", text.lower())
    text = re.sub(r"\bf[uü]nf\b", "5", text)
    return re.sub(r"[\s.\-_]+", "", text)


STATUS_HOSTS = parse_status_sources(STATUS_SOURCES)
AGENT_HOSTS = parse_status_sources(AGENT_SOURCES)


def agent_question(question):
    """"Wie geht's den Agents?", "Läuft Brutus?" - nur wenn Agenten eingetragen sind."""
    if not AGENT_HOSTS:
        return False
    named = status_targets(question, AGENT_HOSTS)
    generic = re.search(r"\b(agent|agents|agenten|bots?)\b", question, re.I)
    return bool((named or generic) and AGENT_STATE_RE.search(question))


def answer_agents(question, hosts=None, opener=urllib.request.urlopen):
    """Health-Adressen der Agenten parallel abfragen: laeuft / nicht erreichbar, mit Antwortzeit."""
    hosts = AGENT_HOSTS if hosts is None else hosts
    targets = status_targets(question, hosts) or hosts
    results = {}

    def one(host):
        started = time.time()
        try:
            with opener(urllib.request.Request(host["url"]), timeout=STATUS_TIMEOUT) as response:
                ok = 200 <= getattr(response, "status", 200) < 300
        except (urllib.error.URLError, TimeoutError, OSError, ValueError):
            ok = False
        results[host["name"]] = (ok, time.time() - started)
    threads = [threading.Thread(target=one, args=(host,), daemon=True) for host in targets]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(STATUS_TIMEOUT + 1)
    trace("agents", ms={h["name"]: round(results.get(h["name"], (False, 0))[1] * 1000) for h in targets})
    down = [h["name"] for h in targets if not results.get(h["name"], (False, 0))[0]]
    slow = [h["name"] for h in targets if h["name"] not in down and results[h["name"]][1] > 1.5]
    if len(targets) == 1:
        text = "%s läuft." % targets[0]["name"] if not down else "%s antwortet nicht." % targets[0]["name"]
    elif not down:
        text = "Alle %d laufen: %s." % (len(targets), ", ".join(h["name"] for h in targets))
    else:
        text = "%d von %d laufen, keine Antwort von: %s." % (len(targets) - len(down), len(targets), ", ".join(down))
    return text + ((" Langsam: %s." % ", ".join(slow)) if slow else "")


def status_targets(question, hosts=None):
    """Die in der Frage genannten Rechner (leer = keiner genannt)."""
    hosts = STATUS_HOSTS if hosts is None else hosts
    squashed = _squash(question)
    tokens = re.findall(r"[a-z0-9]+", re.sub(r"\bf[uü]nf\b", "5", re.sub(r"\beins\b", "1", question.lower())))
    # auch zusammengesetzt aus bis zu drei Woertern: "NS eins" -> "ns1", "n.s. 1" -> "ns1"
    words = {"".join(tokens[i:i + n]) for n in (1, 2, 3) for i in range(len(tokens) - n + 1)}
    found = []
    for host in hosts:
        for alias in host["aliases"]:
            # kurze Namen ("pi") nur als ganzes Wort, laengere auch zusammengeschrieben
            if (alias in words) if len(alias) <= 3 else (alias in squashed):
                found.append(host)
                break
    return found


def fetch_status(host, opener=urllib.request.urlopen):
    request = urllib.request.Request(host["url"], headers={"Accept": "application/json"})
    try:
        with opener(request, timeout=STATUS_TIMEOUT) as response:
            return json.loads(response.read().decode("utf-8", "replace"))
    except (urllib.error.URLError, TimeoutError, OSError, ValueError):
        return None


def _number(value):
    return ("%d" % round(value)) if abs(value) >= 10 or value == int(value) else ("%.1f" % value).replace(".", ",")


def status_warnings(data):
    """Was auffaellt: Werte ueber warn (bzw. unter warn bei lowerIsWorse), ausgefallene Dienste, Zustand != ok."""
    found = []
    for metric in data.get("metrics") or []:
        label = metric.get("label") or metric.get("id") or "?"
        if metric.get("id") == "failed":
            if metric.get("value"):
                found.append("%s ausgefallen%s" % (
                    "1 Dienst" if metric["value"] == 1 else "%d Dienste" % metric["value"],
                    (" (" + metric["detail"] + ")") if metric.get("detail") else ""))
            continue
        if metric.get("state") and metric["state"] != "ok":
            found.append("%s: %s" % (label, metric.get("detail") or metric["state"]))
            continue
        value, warn = metric.get("value"), metric.get("warn")
        if not isinstance(value, (int, float)) or not isinstance(warn, (int, float)):
            continue
        if (value <= warn) if metric.get("lowerIsWorse") else (value >= warn):
            found.append("%s %s %s" % (label, _number(value), metric.get("unit") or ""))
    return [re.sub(r"\s+", " ", f).strip() for f in found]


def status_summary(host, data):
    if data is None:
        return "%s nicht erreichbar." % host["name"]
    metrics = {m.get("id"): m for m in data.get("metrics") or []}
    parts = []
    for key, label in (("cpu", "CPU"), ("memory", "RAM"), ("disk:/", "Platte"), ("temp", "")):
        metric = metrics.get(key)
        if metric and isinstance(metric.get("value"), (int, float)):
            unit = metric.get("unit") or ""
            parts.append(("%s %s%s" % (label, _number(metric["value"]), " " + unit if unit != "%" else " %")).strip())
    uptime = metrics.get("uptime", {}).get("value")
    if isinstance(uptime, (int, float)):
        parts.append("seit %d Tagen" % (uptime // 24) if uptime >= 48 else "seit %d Stunden" % uptime)
    warnings = status_warnings(data)
    return "%s läuft%s.%s" % (host["name"], (": " + ", ".join(parts)) if parts else "",
                             (" Achtung: " + "; ".join(warnings) + ".") if warnings else "")


def _distance_km(a, b):
    import math
    lat1, lon1, lat2, lon2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(h))


def where_am_i(home, opener=urllib.request.urlopen, now=time.time):
    """(lat, lon, Ortsangabe): Handy-Tracker, wenn frisch und nicht daheim; sonst die Home-Zone."""
    import datetime
    base = _entity(home, "zone.home", opener).get("attributes") or {}
    home_pos = (base.get("latitude"), base.get("longitude"))
    tracker = _entity(home, home.get("tracker") or "", opener) if home.get("tracker") else {}
    attrs = tracker.get("attributes") or {}
    try:
        age = now() - datetime.datetime.fromisoformat(tracker["last_updated"]).timestamp()
    except (KeyError, TypeError, ValueError):
        age = None
    if attrs.get("latitude") is not None and age is not None and age < TRACKER_FRESH_S and tracker.get("state") != "home":
        here = (attrs["latitude"], attrs["longitude"])
        if None not in home_pos:
            return here[0], here[1], "bei dir (%d km von daheim)" % round(_distance_km(here, home_pos))
        return here[0], here[1], "bei dir"
    if None in home_pos:
        return None
    return home_pos[0], home_pos[1], "daheim"


def environment_notes(home, opener=urllib.request.urlopen):
    """Was zum Wetter dazugehoert, nur wenn es auffaellt: Unwetter, UV, Luft, Pollen (Sensoren aus "env")."""
    env = (home or {}).get("env") or {}
    if not env:
        return []
    states = _all_states(home, opener)
    notes = []
    warn = _num(states, env.get("warnings", ""))
    if warn:
        notes.append("Achtung: %d Unwetterwarnung%s" % (warn, "en" if warn != 1 else ""))
    uv = (states.get(env.get("uv", "")) or {}).get("state")
    if uv and uv not in ("Niedrig", "niedrig", "low", "unknown", "unavailable"):
        notes.append("UV " + uv.lower())
    air = _num(states, env.get("air", ""))
    if air is not None and air > 50:
        notes.append("Luft mäßig (%d EAQI)" % round(air) if air <= 75 else "Luft schlecht (%d EAQI)" % round(air))
    pollen = [(name, _num(states, entity)) for name, entity in (env.get("pollen") or {}).items()]
    high = [name for name, value in pollen if value is not None and value >= 20]
    if high:
        notes.append("Pollen: " + ", ".join(high))
    return notes


def answer_sun(home=None, opener=urllib.request.urlopen, now=time.time):
    import datetime
    home = HOME if home is None else home
    attrs = _entity(home, "sun.sun", opener).get("attributes") or {}
    try:
        rise = datetime.datetime.fromisoformat(attrs["next_rising"]).astimezone(local_now(now).tzinfo)
        sets = datetime.datetime.fromisoformat(attrs["next_setting"]).astimezone(local_now(now).tzinfo)
    except (KeyError, TypeError, ValueError):
        return "Die Sonnenzeiten habe ich gerade nicht."
    today = local_now(now).date()
    say = lambda t: ("heute" if t.date() == today else "morgen") + t.strftime(" um %H:%M")
    first, second = sorted([("Sonnenaufgang", rise), ("Sonnenuntergang", sets)], key=lambda x: x[1])
    return "%s %s, %s %s." % (first[0], say(first[1]), second[0], say(second[1]))


def answer_weather(question, home=None, opener=urllib.request.urlopen, now=time.time):
    home = HOME if home is None else home
    place = where_am_i(home, opener, now) if home else None
    if not place:
        return "Ich weiß gerade nicht, wo du bist."
    lat, lon, where = place
    url = (WEATHER_URL + "?latitude=%.3f&longitude=%.3f&timezone=auto&forecast_days=2"
           "&current=temperature_2m,weather_code,precipitation"
           "&hourly=precipitation_probability,weather_code"
           "&daily=temperature_2m_min,temperature_2m_max,precipitation_probability_max,weather_code" % (lat, lon))
    started = time.time()
    try:
        with opener(urllib.request.Request(url, headers={"Accept": "application/json"}), timeout=STATUS_TIMEOUT) as response:
            data = json.loads(response.read().decode("utf-8", "replace"))
    except (urllib.error.URLError, TimeoutError, OSError, ValueError):
        trace("wetter", ms=round((time.time() - started) * 1000), error=True)
        return "Der Wetterdienst antwortet gerade nicht."
    trace("wetter", ms=round((time.time() - started) * 1000), where=where)
    current, daily, hourly = data.get("current") or {}, data.get("daily") or {}, data.get("hourly") or {}

    def day(i):
        try:
            return (daily["temperature_2m_min"][i], daily["temperature_2m_max"][i],
                    daily["precipitation_probability_max"][i], WMO.get(daily["weather_code"][i], "wechselhaft"))
        except (KeyError, IndexError, TypeError):
            return None
    if re.search(r"morgen|tomorrow", question, re.I):
        d = day(1)
        if not d:
            return "Für morgen habe ich keine Vorhersage."
        return "Morgen %s: %d bis %d °C, %s, Regen %d %%." % (where, round(d[0]), round(d[1]), d[3], d[2] or 0)
    parts = []
    if current.get("temperature_2m") is not None:
        parts.append("Jetzt %s %d °C, %s" % (where, round(current["temperature_2m"]),
                                             WMO.get(current.get("weather_code"), "wechselhaft")))
    # naechste 3 Stunden ab jetzt
    times = hourly.get("time") or []
    stamp = (current.get("time") or "")[:13]
    start = next((i for i, t in enumerate(times) if t[:13] >= stamp), 0) if stamp else 0
    chances = [p for p in (hourly.get("precipitation_probability") or [])[start:start + 3] if p is not None]
    if chances:
        parts.append("Regen in den nächsten 3 Stunden bis %d %%" % max(chances))
    d = day(0)
    if d:
        parts.append("heute bis %d °C" % round(d[1]))
    parts += environment_notes(home, opener)
    return (". ".join(part[:1].upper() + part[1:] for part in parts) + ".") if parts else "Keine Wetterdaten."


def _get_json(url, opener, timeout=STATUS_TIMEOUT):
    with opener(urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "glass-agent"}),
                timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8", "replace"))


def practical_range(car, states):
    """Realistische Reichweite: Ladestand x nutzbare kWh / Verbrauch (der hoehere der eingetragenen Verbrauchswerte,
    also eher vorsichtig). None, wenn Werte fehlen."""
    soc, kwh = _num(states, car.get("soc", "")), _num(states, car.get("usable_kwh", ""))
    uses = [u for u in (_num(states, e) for e in car.get("consumption") or []) if u and u > 0]
    if soc is None or not kwh or not uses:
        return None
    return soc / 100 * kwh / max(uses) * 100


def charging_stops(start, goal, soc, opener=urllib.request.urlopen):
    """Ladestopps vom Ladeplaner: [(name, km, kw, minuten, soc_vorher, soc_nachher, offen)] oder None."""
    if not (PLANNER_URL and PLANNER_VEHICLE):
        return None
    started = time.time()
    body = {"start": list(start), "ziel": list(goal), "soc_start": round(soc), "fahrzeug": PLANNER_VEHICLE}
    request = urllib.request.Request(PLANNER_URL, data=json.dumps(body).encode(), method="POST",
                                     headers={"Content-Type": "application/json", "Accept": "application/json"})
    try:
        with opener(request, timeout=PLANNER_TIMEOUT) as response:
            plan = json.loads(response.read().decode("utf-8", "replace"))
    except (urllib.error.URLError, TimeoutError, OSError, ValueError):
        trace("ladeplan", ms=round((time.time() - started) * 1000), error=True)
        return None
    trace("ladeplan", ms=round((time.time() - started) * 1000))
    stops = []
    for stop in plan.get("stopps") or []:
        pole = stop.get("saeule") or {}
        stops.append((pole.get("name") or "?", pole.get("km_auf_route"), pole.get("kw"), stop.get("ladedauer_min"),
                      stop.get("soc_vorher"), stop.get("soc_nachher"), stop.get("geoeffnet_bei_ankunft")))
    return stops


def answer_reach(question, home, states, opener=urllib.request.urlopen):
    """"Reicht der Akku bis Wien (und zurueck)?" - Strecke vom Auto zum Ziel gegen die Reichweite."""
    import urllib.parse
    match = REACH_RE.search(question)
    car = home["car"]
    where = (states.get(car.get("location", "")) or {}).get("attributes") or {}
    official = _num(states, car.get("range", ""))
    reach = practical_range(car, states) or official
    if not match or where.get("latitude") is None or reach is None:
        return None
    goal = re.sub(r"^(die|den|der|das)\s+", "", match.group("ziel").strip(), flags=re.I)
    started = time.time()
    try:
        base = (states.get("zone.home") or {}).get("attributes") or {}
        if goal.lower() in ("hause", "haus", "heim", "daheim", "zuhause") and base.get("latitude") is not None:
            lat, lon, place = base["latitude"], base["longitude"], "Nach Hause"
        else:
            found = _get_json(GEOCODER_URL + "?" + urllib.parse.urlencode(
                {"q": goal, "limit": 1, "lang": "de", "lat": where["latitude"], "lon": where["longitude"]}), opener)
            lon, lat = found["features"][0]["geometry"]["coordinates"][:2]
            place = found["features"][0]["properties"].get("name") or goal
        route = _get_json(ROUTER_URL.rstrip("/") + "/route?json=" + urllib.parse.quote(json.dumps(
            {"locations": [{"lat": where["latitude"], "lon": where["longitude"]}, {"lat": lat, "lon": lon}],
             "costing": "auto", "units": "kilometers", "directions_type": "none"})), opener)
        km = float(route["trip"]["summary"]["length"])
        hours = float(route["trip"]["summary"]["time"]) / 3600
    except (urllib.error.URLError, TimeoutError, OSError, ValueError, KeyError, IndexError, TypeError):
        trace("strecke", ms=round((time.time() - started) * 1000), error=True)
        return "Die Strecke nach %s konnte ich gerade nicht berechnen." % goal
    trace("strecke", ms=round((time.time() - started) * 1000))
    both = bool(match.group("back"))
    need = km * (2 if both else 1)
    trip = "%s: %d km%s, %s Fahrt" % (place, round(need), " hin und zurück" if both else "",
                                      _duration(hours * (2 if both else 1)))
    label = "realistisch %d km" % round(reach) if reach != official else "Reichweite %d km" % round(reach)
    if reach >= need * 1.15:
        verdict = "reicht (%s)" % label
    elif reach >= need:
        verdict = "knapp – %s, unterwegs lieber nachladen" % label
    else:
        verdict = "reicht nicht – %s, du musst etwa %d km nachladen" % (label, round(need - reach))
    text = "%s. %s." % (trip, verdict[:1].upper() + verdict[1:])
    asked_stops = re.search(r"wo (lade|laden|tanke)|ladestopp", question, re.I)
    if (reach < need * 1.15 or asked_stops) and not both:
        stops = charging_stops((where["latitude"], where["longitude"]), (lat, lon),
                               _num(states, car.get("soc", "")) or 0, opener)
        if stops:
            said = []
            for name, at_km, kw, minutes, before, after, open_then in stops[:2]:
                bit = "%s (km %d%s, %s%s)" % (name, round(at_km or 0), ", %d kW" % kw if kw else "",
                                               "%d min" % round(minutes) if minutes else "?",
                                               ", %d→%d %%" % (round(before), round(after)) if before is not None and after is not None else "")
                if open_then is False:
                    bit += " – dann geschlossen"
                said.append(bit)
            text += " Ladestopp%s: %s." % ("s" if len(said) > 1 else "", "; ".join(said))
        elif stops == []:
            text += " Laut Ladeplaner kommst du ohne Stopp an."
    return text


def answer_car(question, home=None, opener=urllib.request.urlopen, now=time.time):
    """Auto NUR LESEN aus Home Assistant: Akku, Reichweite, Laden, verriegelt, offen, Entfernung von daheim."""
    import datetime
    home = HOME if home is None else home
    car = (home or {}).get("car")
    if not car:
        return "Das Auto ist nicht eingetragen."
    if CAR_ACT_RE.search(question) and not (ROUTER_URL and GEOCODER_URL and REACH_RE.search(question)):
        return "Das Auto steuere ich nicht – ich kann nur sagen, wie es ihm geht."
    states = _all_states(home, opener)
    if not states:
        return "Home Assistant hat nicht reagiert."
    if ROUTER_URL and GEOCODER_URL and REACH_RE.search(question):
        reached = answer_reach(question, home, states, opener)
        if reached:
            return reached
    name = car.get("name") or "Auto"
    parts = []
    soc, reach = _num(states, car.get("soc", "")), _num(states, car.get("range", ""))
    if soc is not None:
        parts.append("%d %%" % round(soc))
    real = practical_range(car, states)
    if reach is not None and real is not None:
        parts.append("realistisch %d km (laut Auto %d)" % (round(real), round(reach)))
    elif reach is not None:
        parts.append("%d km" % round(reach))
    if (states.get(car.get("charging", "")) or {}).get("state") == "on":
        power = _num(states, car.get("power", ""))
        eta = (_num(states, car.get("eta_h", "")) or 0) * 60 + (_num(states, car.get("eta_min", "")) or 0)
        parts.append("lädt" + (" mit %s kW" % _number(power) if power else "") +
                     (", fertig in %s" % _duration(eta / 60) if eta > 0 else ""))
    elif re.search(r"wann.*voll|l[aä]dt|laden", question, re.I):
        parts.append("lädt gerade nicht")
    lock = (states.get(car.get("lock", "")) or {}).get("state")
    if lock in ("on", "off"):
        parts.append("verriegelt" if lock == "off" else "OFFEN (nicht verriegelt)")   # device_class lock: on = offen
    pattern = car.get("open_pattern")
    if pattern:
        names = {"door": "Tür", "window": "Fenster", "trunk": "Kofferraum", "hood": "Haube"}
        opened = [k for k, v in states.items() if re.match(pattern, k) and v.get("state") == "on"]
        if opened:
            parts.append("offen: " + ", ".join(sorted({names.get(re.search(r"(door|window|trunk|hood)", k).group(1), k)
                                                       for k in opened})))
        elif any(re.match(pattern, k) for k in states):
            parts.append("alles zu")
    where = states.get(car.get("location", "")) or {}
    base = (states.get("zone.home") or {}).get("attributes") or {}
    attrs = where.get("attributes") or {}
    if where.get("state") == "home":
        parts.append("daheim")
    elif attrs.get("latitude") is not None and base.get("latitude") is not None:
        km = _distance_km((attrs["latitude"], attrs["longitude"]), (base["latitude"], base["longitude"]))
        parts.append("daheim" if km < 0.3 else "%s km von daheim" % _number(km))
    text = "%s: %s." % (name, ", ".join(parts)) if parts else "%s: keine Daten." % name
    try:
        seen = datetime.datetime.fromisoformat((states.get(car.get("soc", "")) or {})["last_updated"])
        if now() - seen.timestamp() > 3600:
            text += " Stand %s." % seen.astimezone(local_now(now).tzinfo).strftime("%d.%m. %H:%M")
    except (KeyError, TypeError, ValueError):
        pass
    return text


def answer_arbeit(question, url=None, opener=urllib.request.urlopen):
    """Shoot-Day ueber die Zentrale: Dispo (falls geplant) und aktives Projekt."""
    url = ARBEIT_URL if url is None else url
    started = time.time()
    try:
        with opener(urllib.request.Request(url, headers={"Accept": "application/json"}), timeout=STATUS_TIMEOUT) as response:
            data = json.loads(response.read().decode("utf-8", "replace"))
    except (urllib.error.URLError, TimeoutError, OSError, ValueError):
        trace("arbeit", ms=round((time.time() - started) * 1000), error=True)
        return "Die Zentrale antwortet gerade nicht."
    trace("arbeit", ms=round((time.time() - started) * 1000))
    parts = []
    dispo = data.get("dispo")
    if isinstance(dispo, dict) and dispo:
        bits = [str(dispo[k]) for k in ("titel", "name", "datum", "tag", "zeit", "start", "treffpunkt", "ort")
                if dispo.get(k) not in (None, "")]
        parts.append("Dispo: " + (", ".join(bits) if bits else "vorhanden"))
    elif isinstance(dispo, list) and dispo:
        parts.append("Dispo: %d Einträge" % len(dispo))
    else:
        parts.append("Kein Dreh mit Dispo geplant")
    active = next((p for p in data.get("projekte") or [] if p.get("aktiv")), None)
    if active:
        parts.append("Aktives Projekt: %s (%s Szenen, %s Shots, %s Takes)" % (
            active.get("name"), active.get("szenen", "?"), active.get("shots", "?"), active.get("takes", "?")))
    elif data.get("aktiv"):
        parts.append("Aktives Projekt: %s" % data["aktiv"])
    holiday = next_holiday(opener=opener) if HOME else ""
    if holiday:
        parts.append(holiday)
    return ". ".join(parts) + "."


def answer_overview(home=None, opener=urllib.request.urlopen):
    """Ueberblick ueber alle eingetragenen Geraete mit einem Aufruf: was an ist, was nicht erreichbar ist, NAS."""
    home = HOME if home is None else home
    states = _all_states(home, opener)
    if not states:
        return "Home Assistant antwortet nicht."
    on, off, gone, extra = [], 0, [], []
    for device in home["devices"]:
        if device.get("kind") == "nas":
            text = nas_summary(device, states)
            extra.append(device["name"] + (" ok" if "Achtung" not in text and "läuft" in text else ": " + text))
            continue
        state = (states.get(_power_entity(device)) or {}).get("state")
        flag = _is_on(state)
        if flag is None:
            gone.append(device["name"])
        elif flag:
            on.append(device["name"])
        else:
            off += 1
    parts = ["Home Assistant läuft", ("An: " + ", ".join(on)) if on else "Alles aus"]
    if on and off:
        parts[-1] += ". Rest aus"
    if gone:
        parts.append("Nicht erreichbar: " + ", ".join(gone))
    return ". ".join(parts + extra) + "."


def answer_pv(home=None, opener=urllib.request.urlopen):
    """PV aus Home Assistant: jetzt, heute, Prognose morgen, Ueberschuss."""
    home = HOME if home is None else home
    pv = (home or {}).get("pv") or {}
    states = _all_states(home, opener)
    if not states:
        return "Home Assistant antwortet nicht."
    value = lambda key: _num(states, pv.get(key, ""))
    parts = []
    if value("now") is not None:
        parts.append("PV jetzt %d W" % round(value("now")))
    if value("today") is not None:
        parts.append("heute %s kWh" % _number(value("today")))
    if value("tomorrow") is not None:
        parts.append("morgen erwartet %s kWh" % _number(value("tomorrow")))
    if value("house") is not None:
        parts.append("Haus braucht %d W" % round(value("house")))
    text = ", ".join(parts)
    if value("surplus_today") is not None:
        text += ". Überschuss heute %s kWh" % _number(value("surplus_today"))
        if value("surplus_km") is not None:
            text += " (etwa %d km fürs Auto)" % round(value("surplus_km"))
    return (text[:1].upper() + text[1:] + ".") if text else "Keine PV-Daten."


def answer_shopping(question, home=None, opener=urllib.request.urlopen):
    """Einkaufsliste (HA todo): vorlesen oder einen Eintrag hinzufuegen. Nichts loeschen."""
    home = HOME if home is None else home
    entity = home["shopping"]
    add = SHOPPING_ADD_RE.match(question)
    try:
        if add:
            item = add.group("item").strip(" ,.")
            item = re.sub(r"^(noch\s+|auch\s+|bitte\s+)+", "", item, flags=re.I)
            _ha(home, "POST", "/api/services/todo/add_item", {"entity_id": entity, "item": item[:1].upper() + item[1:]},
                opener)
            return "%s steht auf der Einkaufsliste." % (item[:1].upper() + item[1:])
        data = _ha(home, "POST", "/api/services/todo/get_items?return_response",
                   {"entity_id": entity, "status": "needs_action"}, opener) or {}
    except (urllib.error.URLError, TimeoutError, OSError, ValueError):
        return "Home Assistant hat nicht reagiert."
    items = ((data.get("service_response") or {}).get(entity) or {}).get("items") or []
    names = [i.get("summary") for i in items if i.get("summary")]
    if not names:
        return "Die Einkaufsliste ist leer."
    return "Auf der Einkaufsliste (%d): %s." % (len(names), ", ".join(names))


def next_holiday(home=None, opener=urllib.request.urlopen, now=time.time, days=7):
    """Naechster Feiertag aus einem HA-Kalender, wenn er in den naechsten `days` Tagen liegt."""
    import datetime
    home = HOME if home is None else home
    if not home or not home.get("holidays"):
        return ""
    attrs = _entity(home, home["holidays"], opener).get("attributes") or {}
    try:
        start = datetime.datetime.strptime(attrs["start_time"][:10], "%Y-%m-%d").date()
    except (KeyError, TypeError, ValueError):
        return ""
    today = local_now(now).date()
    if not 0 <= (start - today).days <= days:
        return ""
    when = "heute" if start == today else "morgen" if (start - today).days == 1 else (
        WEEKDAYS[start.weekday()] + " " + start.strftime("%d.%m."))
    return "Feiertag %s: %s" % (when, attrs.get("message") or "?")


def direct_labels():
    """Nur LESENDE eigene Wege, die das schnelle Modell vorab waehlen darf (nie Schalten)."""
    labels = {"UHRZEIT": ("jetzt", "Uhrzeit oder Datum")}
    if HOME:
        labels["HAUS"] = ("haus", "Zustand von Licht, Fernseher, Beamer, Drucker, NAS, Home Assistant")
        if HOME.get("spot"):
            labels["STROMPREIS"] = ("strompreis", "Strompreis jetzt und billigste Stunde")
        if HOME.get("internet"):
            labels["INTERNET"] = ("internet", "Internetgeschwindigkeit")
        labels["SONNE"] = ("sonne", "Sonnenaufgang/-untergang")
        if HOME.get("sugar"):
            labels["ZUCKER"] = ("zucker", "Alfreds aktueller Blutzucker/Glukosewert")
        if HOME.get("lan"):
            labels["NETZ"] = ("netz", "welche Geraete gerade im WLAN/Heimnetz sind")
        if WEATHER:
            labels["WETTER"] = ("wetter", "Wetter, Regen, Temperatur draussen")
        if HOME.get("car"):
            labels["AUTO"] = ("auto", "Alfreds Auto: Akku, Reichweite, ob es fuer eine Strecke reicht, verriegelt, wo es steht")
        if HOME.get("pv"):
            labels["STROM"] = ("strom", "Photovoltaik, Stromerzeugung, Ueberschuss")
        if HOME.get("shopping"):
            labels["EINKAUF"] = ("einkauf", "Einkaufsliste vorlesen")
    if STATUS_HOSTS:
        labels["SERVER"] = ("server", "Zustand der Server und Rechner")
    if AGENT_HOSTS:
        labels["AGENTEN"] = ("agenten", "ob Alfreds KI-Agenten laufen")
    if STAR_URL:
        labels["TELESKOP"] = ("teleskop", "Alfreds Teleskop/N.I.N.A.-Aufnahme")
    if TASKS_URL:
        labels["AUFGABEN"] = ("aufgaben", "offene Aufgaben im Brain")
    if ARBEIT_URL:
        labels["ARBEIT"] = ("arbeit", "Drehs, Dispo, Projekte, was ansteht")
    return labels


def direct_text(kind, question, now=time.time):
    """Antwort eines lesenden eigenen Weges (fuer die Vorab-Wahl des schnellen Modells)."""
    if kind == "jetzt":
        return answer_now(question, now)
    if kind == "haus":
        return answer_overview()
    if kind == "netz":
        return answer_lan(question)
    if kind == "zucker":
        return answer_sugar(now=now)
    if kind == "strompreis":
        return answer_price()
    if kind == "internet":
        return answer_internet()
    if kind == "sonne":
        return answer_sun(now=now)
    if kind == "teleskop":
        return answer_star()
    if kind == "aufgaben":
        return answer_tasks()
    if kind == "wetter":
        return answer_weather(question)
    if kind == "auto":
        return answer_car(question)
    if kind == "strom":
        return answer_pv()
    if kind == "einkauf":
        return answer_shopping("Was steht auf der Einkaufsliste?")      # vorab nie schreiben
    if kind == "server":
        return answer_status(question)
    if kind == "agenten":
        return answer_agents(question)
    if kind == "arbeit":
        return answer_arbeit(question)
    return "Das kann ich gerade nicht nachschauen."


_REMINDER_LOCK = threading.Lock()


def _load_reminders(path=None):
    try:
        with open(path or REMINDER_FILE, encoding="utf-8") as handle:
            return [r for r in json.load(handle) if isinstance(r, dict)]
    except (OSError, ValueError):
        return []


def _save_reminders(items, path=None):
    path = path or REMINDER_FILE
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(items, handle, ensure_ascii=False)
    os.replace(tmp, path)


def parse_when(text, now=time.time):
    """"in 20 Minuten", "in einer halben Stunde", "um 18 Uhr", "um 7:30", "morgen um 8" -> Zeitstempel oder None."""
    import datetime
    text = text.lower().strip()
    words = {"einer": 1, "einem": 1, "eine": 1, "zwei": 2, "drei": 3, "vier": 4, "fünf": 5, "zehn": 10,
             "zwanzig": 20, "dreißig": 30, "dreissig": 30}
    if re.match(r"^in\s+einer\s+halben\s+stunde$", text):
        return now() + 1800
    rel = re.match(r"^in\s+(\d+|%s)\s*(minuten|minute|min|stunden|stunde|std|h|sekunden)$" % "|".join(words), text)
    if rel:
        amount = int(rel.group(1)) if rel.group(1).isdigit() else words[rel.group(1)]
        unit = rel.group(2)
        return now() + amount * (3600 if unit.startswith(("stunde", "std", "h")) else 1 if unit.startswith("sek") else 60)
    at = re.match(r"^(morgen\s+)?(um\s+)?(\d{1,2})([:.](\d{2}))?\s*(uhr)?$", text)
    if at and (at.group(2) or at.group(6) or at.group(1)):
        base = local_now(now)
        hour, minute = int(at.group(3)), int(at.group(5) or 0)
        if hour > 23 or minute > 59:
            return None
        due = base.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if at.group(1):
            due += datetime.timedelta(days=1)
        elif due.timestamp() <= now():
            due += datetime.timedelta(days=1)
        return due.timestamp()
    return None


def answer_reminder(question, home=None, now=time.time, path=None):
    home = HOME if home is None else home
    with _REMINDER_LOCK:
        items = _load_reminders(path)
        if REMIND_LIST_RE.search(question) and not REMIND_RE.match(question):
            if not items:
                return "Keine offenen Erinnerungen."
            return "Offen: " + "; ".join("%s %s" % (local_now(lambda r=r: r["due"]).strftime("%H:%M"), r["what"])
                                         for r in sorted(items, key=lambda r: r["due"])[:5]) + "."
        match = REMIND_RE.match(question)
        due = parse_when(match.group("when"), now) if match else None
        if not due:
            return "Wann soll ich dich erinnern? Zum Beispiel „in 20 Minuten“ oder „um 18 Uhr“."
        what = match.group("what").strip(" ,.")
        what = what[:1].upper() + what[1:]
        items.append({"due": due, "what": what, "notify": home["notify"]})
        _save_reminders(items, path)
    when = local_now(lambda: due)
    day = "" if when.date() == local_now(now).date() else "morgen "
    return "Erinnerung %sum %s: %s." % (day, when.strftime("%H:%M"), what)


def deliver_reminders(home=None, opener=urllib.request.urlopen, now=time.time, path=None):
    """Faellige Erinnerungen als Home-Assistant-Benachrichtigung schicken; gescheiterte bleiben eine Stunde liegen."""
    home = HOME if home is None else home
    if not home:
        return 0
    sent = 0
    with _REMINDER_LOCK:
        items = _load_reminders(path)
        keep = []
        for item in items:
            if item["due"] > now():
                keep.append(item)
                continue
            service = item.get("notify") or home.get("notify") or ""
            try:
                _ha(home, "POST", "/api/services/" + service.replace(".", "/", 1),
                    {"title": "Erinnerung", "message": item["what"]}, opener)
                sent += 1
            except (urllib.error.URLError, TimeoutError, OSError, ValueError):
                if now() - item["due"] < 3600:
                    keep.append(item)
        if len(keep) != len(items):
            _save_reminders(keep, path)
    return sent


def reminder_loop():
    while True:
        time.sleep(20)
        try:
            deliver_reminders()
        except Exception as error:  # noqa: BLE001 - der Faden darf nie sterben
            sys.stderr.write("[glass-agent] Erinnerung: %s\n" % type(error).__name__)


def lan_scan(iface, run=None):
    """[(ip, mac, hersteller)] per arp-scan (braucht root; feste Argumente, keine Eingabe aus der Frage)."""
    import subprocess
    if not re.match(r"^[a-z0-9]{2,15}$", iface or ""):
        return None
    run = run or (lambda argv: subprocess.run(argv, capture_output=True, text=True, timeout=8).stdout)
    started = time.time()
    try:
        out = run(["sudo", "-n", "arp-scan", "-I", iface, "--localnet", "--retry", "2", "-t", "300", "-x"])
    except Exception:  # noqa: BLE001 - kein Scan = ehrliche Antwort
        trace("netz", ms=round((time.time() - started) * 1000), error=True)
        return None
    trace("netz", ms=round((time.time() - started) * 1000))
    found = {}
    for line in (out or "").splitlines():
        parts = line.split("\t")
        if len(parts) >= 2 and re.match(r"^\d+\.\d+\.\d+\.\d+$", parts[0]):
            mac = parts[1].split()[0].lower()
            vendor = parts[-1].strip() if len(parts) >= 3 else ""
            found.setdefault(mac, (parts[0], mac, "" if vendor.startswith("(Unknown") else vendor))
    return list(found.values())


def answer_lan(question, home=None, run=None, now=time.time, path=None):
    home = HOME if home is None else home
    lan = home["lan"]
    devices = lan_scan(lan.get("iface", "wlan0"), run)
    if devices is None:
        return "Das Netz konnte ich gerade nicht abfragen."
    names = {k.lower(): v for k, v in (lan.get("names") or {}).items()}
    path = path or LAN_SEEN_FILE
    try:
        with open(path, encoding="utf-8") as handle:
            seen = json.load(handle)
    except (OSError, ValueError):
        seen = {}
    first_scan = not seen
    new = [d for d in devices if d[1] not in seen and d[1] not in names]
    for ip, mac, vendor in devices:
        seen[mac] = {"ip": ip, "vendor": vendor, "last": now(), "first": (seen.get(mac) or {}).get("first", now())}
    try:
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(seen, handle)
        os.replace(tmp, path)
    except OSError:
        pass
    known = sorted({names[d[1]] for d in devices if d[1] in names})
    vendors = {}
    for ip, mac, vendor in devices:
        if mac not in names:
            label = (vendor.split(",")[0].split(" ")[0] + "-Gerät") if vendor else "unbekannt"
            vendors[label] = vendors.get(label, 0) + 1
    rest = ["%s%s" % ("%d× " % n if n > 1 else "", label) for label, n in sorted(vendors.items(), key=lambda x: -x[1])]
    text = "%d Geräte im Netz: %s." % (len(devices), ", ".join(known + rest))
    if new and not first_scan:
        text += " Neu: %s." % ", ".join("%s (%s)" % (d[2] or "unbekannt", d[0]) for d in new[:4])
    return text


def answer_sugar(home=None, opener=urllib.request.urlopen, now=time.time):
    """Glukose aus Home Assistant (z.B. Nightscout-Sensor): Wert, Tendenz, Alter; hoch/niedrig deutlich sagen."""
    import datetime
    home = HOME if home is None else home
    cfg = home["sugar"]
    states = _all_states(home, opener)
    value = _num(states, cfg.get("value", ""))
    if value is None:
        return "Gerade kommt kein Glukosewert an."
    unit = ((states.get(cfg["value"]) or {}).get("attributes") or {}).get("unit_of_measurement") or "mg/dL"
    delta = _num(states, cfg.get("delta", ""))
    trend = (states.get(cfg.get("trend", "")) or {}).get("state")
    parts = ["Blutzucker %s %s" % (_number(value), unit)]
    if trend and trend not in ("unknown", "unavailable"):
        parts.append(trend + (" (%+d)" % delta if delta is not None else ""))
    elif delta is not None:
        parts.append("%+d" % delta)
    stamp = (states.get(cfg.get("time", "")) or {}).get("state") or (states.get(cfg["value"]) or {}).get("last_updated")
    try:
        age = (now() - datetime.datetime.fromisoformat(stamp).timestamp()) / 60
        parts.append("vor %d min" % round(age) if age < 60 else "Stand %s" % datetime.datetime.fromisoformat(
            stamp).astimezone(local_now(now).tzinfo).strftime("%H:%M"))
        stale = age > 15
    except (TypeError, ValueError):
        stale = False
    mg = value * 18 if unit.lower().startswith("mmol") else value
    text = ", ".join(parts) + "."
    if mg < cfg.get("low", 70):
        text = "Achtung, niedrig! " + text
    elif mg > cfg.get("high", 250):
        text = "Achtung, hoch! " + text
    if stale:
        text += " Der Wert ist älter als 15 Minuten."
    LAST_HOME["sugar_t"] = time.time()
    return text


def answer_price(home=None, opener=urllib.request.urlopen):
    home = HOME if home is None else home
    spot = home["spot"]
    states = _all_states(home, opener)
    now_ct, cheap, avg = (_num(states, spot.get(k, "")) for k in ("current", "cheapest", "average"))
    hour = (states.get(spot.get("cheapest_hour", "")) or {}).get("state")
    if now_ct is None:
        return "Den Strompreis habe ich gerade nicht."
    cent = lambda v: ("%.1f" % v).replace(".", ",")
    text = "Strom jetzt %s ct/kWh" % cent(now_ct)
    if cheap is not None and hour and hour not in ("unknown", "unavailable"):
        text += ", am billigsten um %s (%s ct)" % (hour, cent(cheap))
    if avg is not None:
        text += ", Schnitt %s ct" % _number(avg)
    return text + "."


def answer_internet(home=None, opener=urllib.request.urlopen):
    home = HOME if home is None else home
    net = home["internet"]
    states = _all_states(home, opener)
    down, up, ping = (_num(states, net.get(k, "")) for k in ("download", "upload", "latency"))
    if down is None:
        return "Keine Internet-Messung da."
    seen = (states.get(net.get("download", "")) or {}).get("last_updated") or ""
    when = ""
    try:
        import datetime
        when = " (Messung %s)" % datetime.datetime.fromisoformat(seen).astimezone(local_now().tzinfo).strftime("%d.%m. %H:%M")
    except ValueError:
        pass
    return "Internet: %d Mbit/s runter, %d hoch%s%s." % (round(down), round(up or 0),
                                                          ", %d ms" % round(ping) if ping is not None else "", when)


def answer_star(url=None, opener=urllib.request.urlopen):
    """N.I.N.A. ueber die Star-Glass-Bridge: Sequenz, Ziel, Belichtung, Guiding, Kamera, Sicherheit."""
    url = STAR_URL if url is None else url
    started = time.time()
    try:
        data = _get_json(url.rstrip("/") + "/api/star", opener)
    except (urllib.error.URLError, TimeoutError, OSError, ValueError):
        trace("teleskop", ms=round((time.time() - started) * 1000), error=True)
        return "Die Teleskop-Brücke antwortet nicht (Rechner oder N.I.N.A. aus?)."
    trace("teleskop", ms=round((time.time() - started) * 1000))
    if not data.get("online"):
        return "N.I.N.A. ist nicht erreichbar%s." % ((" (" + str(data.get("reason")) + ")") if data.get("reason") else "")
    parts = []
    seq = data.get("sequence") or {}
    if seq.get("target"):
        parts.append("Ziel " + str(seq["target"]))
    if seq.get("frames"):
        parts.append("Bild %s von %s" % (seq.get("frame") or "?", seq["frames"]))
    exp = data.get("exposure") or {}
    if exp.get("active"):
        parts.append("belichtet %ss%s" % (_number(exp.get("total") or 0),
                                          ", noch %ds" % round(exp["remaining"]) if exp.get("remaining") is not None else ""))
    guider = data.get("guider") or {}
    if guider.get("connected"):
        parts.append("Guiding %s" % (("RMS %s\"" % _number(guider["rms"])) if guider.get("guiding") and guider.get(
            "rms") is not None else ("läuft" if guider.get("guiding") else "aus")))
    cam = data.get("camera") or {}
    if cam.get("connected") and cam.get("temp") is not None:
        parts.append("Kamera %s °C" % _number(cam["temp"]))
    mount = data.get("mount") or {}
    if mount.get("connected") and mount.get("flipMinutes") is not None and mount["flipMinutes"] < 60:
        parts.append("Meridian-Flip in %d min" % round(mount["flipMinutes"]))
    if (data.get("safety") or {}).get("safe") is False:
        parts.insert(0, "ACHTUNG: unsicher")
    state = seq.get("state") or ("läuft" if exp.get("active") else "bereit")
    return "N.I.N.A. %s%s." % (state, (": " + ", ".join(parts)) if parts else "")


def answer_tasks(url=None, opener=urllib.request.urlopen):
    """Offene Aufgaben im Brain (Agentic OS); Test-/Probe-Aufgaben werden nicht vorgelesen."""
    url = TASKS_URL if url is None else url
    try:
        tasks = _get_json(url, opener).get("tasks") or []
    except (urllib.error.URLError, TimeoutError, OSError, ValueError, AttributeError):
        return "Das Brain antwortet gerade nicht."
    noise = re.compile(r"^(x|test.*|.*conformance.*|.*idemp.*|.*probe.*|.*nokey.*|.*-conf-.*)$", re.I)
    real = [t for t in tasks if not noise.match(str(t.get("title") or "").strip())]
    if not real:
        return "Keine echten offenen Aufgaben (%d Testaufgaben liegen noch herum)." % len(tasks) if tasks else \
            "Keine offenen Aufgaben."
    real.sort(key=lambda t: {"high": 0, "normal": 1, "low": 2}.get(t.get("priority"), 1))
    return "%d offen: %s." % (len(real), "; ".join("%s%s" % (t.get("title", "?")[:60], (" (" + t["assigned_to"] + ")")
                                                            if t.get("assigned_to") not in (None, "UNASSIGNED") else "")
                                                   for t in real[:4]))


def ha_system_notes(home=None, opener=urllib.request.urlopen, now=time.time):
    """Aus Home Assistant: Sicherung aelter als 2 Tage, Tailnet-Geraete offline (Sensoren aus "system")."""
    import datetime
    home = HOME if home is None else home
    cfg = (home or {}).get("system") or {}
    if not cfg:
        return []
    states = _all_states(home, opener)
    notes = []
    stamp = (states.get(cfg.get("backup", "")) or {}).get("state")
    try:
        if now() - datetime.datetime.fromisoformat(stamp).timestamp() > 2 * 86400:
            notes.append("letzte Home-Assistant-Sicherung älter als 2 Tage")
    except (TypeError, ValueError):
        if stamp:
            notes.append("Home-Assistant-Sicherung unbekannt")
    off = [(states.get(e) or {}).get("attributes", {}).get("friendly_name") or e for e in cfg.get("tailnet") or []
           if (states.get(e) or {}).get("state") == "off"]
    if off:
        notes.append("offline: " + ", ".join(off))
    return notes


def system_notes(data):
    """Systemseite der Zentrale: ausgefallene Dienste und bald ablaufende Zertifikate."""
    if not isinstance(data, dict):
        return []
    notes = ["%s aus" % d.get("name") for d in data.get("dienste") or [] if not d.get("ok") and not d.get("schlaeft")]
    for cert in data.get("zertifikate") or []:
        days = cert.get("tage")
        if not cert.get("ok") or (isinstance(days, (int, float)) and days < CERT_WARN_DAYS):
            notes.append("Zertifikat %s %s" % (cert.get("host"), cert.get("fehler") or "noch %d Tage" % (days or 0)))
    return notes


def answer_status(question, hosts=None, opener=urllib.request.urlopen, system_url=None):
    hosts = STATUS_HOSTS if hosts is None else hosts
    system_url = SYSTEM_URL if system_url is None else system_url
    named = status_targets(question, hosts)
    targets = named or hosts
    results = {}

    def one(host):
        results[host["name"]] = fetch_status(host, opener)
    jobs = list(targets) + ([{"name": "~system", "url": system_url}] if system_url and not named else [])
    threads = [threading.Thread(target=one, args=(host,), daemon=True) for host in jobs]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(STATUS_TIMEOUT + 1)
    if len(targets) == 1:
        return status_summary(targets[0], results.get(targets[0]["name"]))
    down = [h["name"] for h in targets if results.get(h["name"]) is None]
    notes = []
    for host in targets:
        data = results.get(host["name"])
        if data is not None:
            warnings = status_warnings(data)
            if warnings:
                notes.append("%s: %s" % (host["name"], "; ".join(warnings)))
    notes += system_notes(results.get("~system"))
    if not named:
        notes += ha_system_notes()
    up = len(targets) - len(down)
    head = ("Alle %d laufen." % up) if not down else ("%d von %d laufen, nicht erreichbar: %s."
                                                       % (up, len(targets), ", ".join(down)))
    return head + ((" " + ". ".join(notes) + ".") if notes else "")


def load_home(path=None):
    """Geraeteliste: {"ha_url", "token_file", "devices": [{"name", "words", "kind": tv|light|switch, ...}]}."""
    path = HOME_FILE if path is None else path
    if not path:
        return None
    try:
        with open(os.path.expanduser(path), encoding="utf-8") as handle:
            data = json.load(handle)
        with open(os.path.expanduser(data["token_file"]), encoding="utf-8") as handle:
            token = handle.read().strip()
    except (OSError, ValueError, KeyError, TypeError):
        sys.stderr.write("[glass-agent] Geraeteliste nicht lesbar - zuhause aus\n")
        return None
    devices = []
    for device in data.get("devices") or []:
        if device.get("kind") == "nas":           # nur lesen (Sensoren mit "prefix"), wird nie geschaltet
            if re.match(r"^sensor\.[a-z0-9_]+$", device.get("prefix") or ""):
                devices.append(dict(device, words=[w.lower() for w in device.get("words") or []]))
            continue
        if device.get("kind") == "script":            # nur eingetragene Skripte, nur starten
            if re.match(r"^script\.[a-z0-9_]+$", device.get("script") or "") and not HOME_DENY_RE.search(device["script"]):
                devices.append(dict(device, words=[w.lower() for w in device.get("words") or []]))
            continue
        ids = [device.get("player"), device.get("remote")] + list(device.get("entities") or [])
        ids = [i for i in ids if i]
        if not ids or any(HOME_DENY_RE.search(i) or i.split(".")[0] not in HOME_DOMAINS for i in ids):
            sys.stderr.write("[glass-agent] Geraet %r uebersprungen (gesperrt)\n" % device.get("name"))
            continue
        devices.append(dict(device, words=[w.lower() for w in device.get("words") or []]))
    car = data.get("car") if isinstance(data.get("car"), dict) else None
    return {"url": str(data.get("ha_url") or "").rstrip("/"), "token": token, "devices": devices,
            "tracker": data.get("tracker"), "car": car,
            "pv": data.get("pv") if isinstance(data.get("pv"), dict) else None,
            "shopping": data.get("shopping") if str(data.get("shopping") or "").startswith("todo.") else None,
            "holidays": data.get("holidays") if str(data.get("holidays") or "").startswith("calendar.") else None,
            "lan": data.get("lan") if isinstance(data.get("lan"), dict) else None,
            "system": data.get("system") if isinstance(data.get("system"), dict) else None,
            "env": data.get("env") if isinstance(data.get("env"), dict) else None,
            "internet": data.get("internet") if isinstance(data.get("internet"), dict) else None,
            "spot": data.get("spot") if isinstance(data.get("spot"), dict) else None,
            "sugar": data.get("sugar") if isinstance(data.get("sugar"), dict) else None,
            "notify": data.get("notify") if re.match(r"^notify\.[a-z0-9_]+$", str(data.get("notify") or "")) else None}


HOME = load_home()


def _mentions(question, word):
    # Laengere Woerter auch als Wortende: "3D-Drucker", "Radiodrucker" (Spracherkennung), "Kuechenlicht" nicht.
    before = "" if len(word) >= 5 else r"(?<![a-zäöüß])"
    return re.search(before + re.escape(word) + r"(?![a-zäöüß])", question.lower()) is not None


def home_command(question, home=None):
    """Aeusserung -> {"devices", "action", "steps"} oder None (kein Geraet oder keine Handlung)."""
    home = HOME if home is None else home
    if not home:
        return None
    named = [d for d in home["devices"] if any(_mentions(question, w) for w in d["words"])]
    if not named and PRONOUN_RE.search(question) and LAST_HOME.get("devices") and (
            time.time() - LAST_HOME.get("t", 0) < PRONOUN_TTL):   # "Mach ihn wieder an", "Schmeiß das an"
        named = [d for d in home["devices"] if d["name"] in LAST_HOME["devices"]]
    nas = [d for d in named if d.get("kind") == "nas"]
    if nas:                                       # nur Zustand; Schalten/Neustart gibt es fuer die NAS nicht
        action = "denied" if re.search(r"\b(aus|ausschalten|abschalten|einschalten|anschalten|neu ?starten?|"
                                       r"reboot|herunterfahren|runterfahren|shutdown)\b|start\w*\b.*\bneu\b",
                                       question, re.I) else "status"
        return {"devices": nas[:1], "action": action, "steps": 1}
    scripts = [d for d in named if d.get("kind") == "script"]
    if scripts and not STATE_Q_RE.match(question) and not OFF_RE.search(question):
        return {"devices": scripts[:1], "action": "script", "steps": 1}
    players = [d for d in named if d.get("kind") == "tv"]
    tvs = players or [d for d in home["devices"] if d.get("kind") == "tv"][:1]   # ohne Nennung: der erste
    app = next(((w, p) for d in tvs[:1] for w, p in _apps(d).items() if _mentions(question, w)), None)
    if app and not OFF_RE.search(question) and not STATE_Q_RE.match(question) and not W_QUESTION_RE.match(
            question) and (
            players or APP_VERB_RE.search(question) or ON_RE.search(question)):
        return {"devices": tvs[:1], "action": "app", "steps": 1, "app": app}
    switches = [d for d in named if d.get("kind") == "switch"]
    lights = [d for d in named if d.get("kind") == "light"]
    if players or switches:
        devices = players or switches            # "Fernseher im Wohnzimmer" meint den Fernseher, nicht das Licht
    elif lights or (LIGHT_WORD_RE.search(question) and (ALL_RE.search(question) or PLURAL_LIGHT_RE.search(question))):
        devices = lights or [d for d in home["devices"] if d.get("kind") == "light"]
        if not lights or (ALL_RE.search(question) and LIGHT_WORD_RE.search(question)):
            devices = [d for d in home["devices"] if d.get("kind") == "light"]
    else:
        return None
    light_only = [d for d in devices if d.get("kind") == "light"]
    pct = DIM_PCT_RE.search(question)
    if light_only and not STATE_Q_RE.match(question) and (pct or BRIGHTER_RE.search(question) or DARKER_RE.search(
            question) or WARMER_RE.search(question) or COLDER_RE.search(question)):
        level = max(1, min(100, int(pct.group(1)))) if pct else None
        return {"devices": light_only, "action": "dim", "steps": 1, "level": level,
                "step": 25 if BRIGHTER_RE.search(question) else -25 if DARKER_RE.search(question) and not pct else 0,
                "kelvin": 2700 if WARMER_RE.search(question) else 5000 if COLDER_RE.search(question) else None}
    if STATE_Q_RE.match(question):
        action = "status"
    elif MUTE_RE.search(question) and not UNMUTE_RE.search(question):
        action = "mute"
    elif UNMUTE_RE.search(question):
        action = "unmute"
    elif UP_RE.search(question):
        action = "up"
    elif DOWN_RE.search(question):
        action = "down"
    elif OFF_RE.search(question):
        action = "off"
    elif ON_RE.search(question):
        action = "on"
    elif FOLLOW_UP_RE.match(question) or len(re.findall(r"[\wäöüß-]+", question)) <= 3:
        action = "status"                         # "Und der Drucker?", "3D-Drucker, okay."
    else:
        return None
    if action in ("mute", "unmute", "up", "down"):
        devices = [d for d in devices if d.get("kind") == "tv"]
        if not devices:
            return None
    number = re.search(r"\b(\d{1,2})\b", question)
    steps = int(number.group(1)) if number else (6 if re.search(r"\bviel\b", question, re.I) else
                                                 1 if re.search(r"(bisschen|etwas|wenig|einen tick)", question, re.I)
                                                 else 3)
    return {"devices": devices, "action": action, "steps": max(1, min(10, steps)),
            "unclear": action in ("on", "off") and len(_leftover(question, home)) >= 2}


def _leftover(question, home):
    """Woerter, die weder Geraet noch Befehl noch Fuellwort sind ("WLAN", "Alfred" in "WLAN Fernseher Alfred aus")."""
    known = set(FILLER_WORDS)
    for device in home["devices"]:
        for word in device["words"]:
            known.update(word.split())
    left = []
    for token in re.findall(r"[a-zäöüß0-9-]+", question.lower()):
        if token in known or token.isdigit() or any(rx.fullmatch(token) for rx in (OFF_RE, ON_RE, UP_RE, DOWN_RE)):
            continue
        if any(token.endswith(word) for word in known if len(word) >= 5):      # "3d-drucker", "kuechenlicht"
            continue
        left.append(token)
    return left


def _apps(device):
    apps = dict(DEFAULT_APPS)
    apps.update({w.lower(): p for w, p in (device.get("apps") or {}).items()})
    return apps


def _ha(home, method, path, body=None, opener=urllib.request.urlopen):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(home["url"] + path, data=data, method=method,
                                     headers={"Authorization": "Bearer " + home["token"],
                                              "Content-Type": "application/json"})
    started = time.time()
    try:
        with opener(request, timeout=HOME_TIMEOUT) as response:
            result = json.loads(response.read().decode("utf-8", "replace") or "null")
    except Exception as error:
        trace("ha", call=method + " " + path, ms=round((time.time() - started) * 1000), error=type(error).__name__)
        raise
    trace("ha", call=method + " " + path, ms=round((time.time() - started) * 1000))
    return result


def _power_entity(device):
    """Woran man sieht, ob es an ist: beim Android-TV die Fernbedienung (der Player bleibt nach Standby "idle")."""
    if device.get("kind") == "tv":
        return device.get("remote") or device.get("player")
    return (device.get("entities") or [None])[0]


def _is_on(state):
    if state in ("unavailable", "unknown", None):
        return None
    return state not in ("off", "standby")


def _entity(home, entity, opener):
    try:
        return _ha(home, "GET", "/api/states/" + entity, opener=opener) or {}
    except (urllib.error.URLError, TimeoutError, OSError, ValueError):
        return {}


def _state(home, entity, opener):
    return _entity(home, entity, opener).get("state")


def _wait_for(check, sleep, seconds=None):
    """Zuruecklesen, bis check() wahr ist oder `seconds` um sind (statt immer fest zu warten). -> geklappt?"""
    for poll in range(max(1, int((HOME_QUICK_S if seconds is None else seconds) / HOME_POLL_S))):
        sleep(HOME_POLL_S)
        if check():
            trace("readback", polls=poll + 1, ok=True)
            return True
    trace("readback", polls=poll + 1, ok=False)
    return False


HOME_WARNINGS = []          # Nachpruefung im Hintergrund gescheitert -> kommt vor die naechste Antwort


def _check_later(check, sleep, warning):
    """Weiter nachpruefen, waehrend die Brille schon die Antwort hat; klappt es nicht, Warnung merken."""
    def run():
        if not _wait_for(check, sleep, HOME_SETTLE_S):
            HOME_WARNINGS.append((time.time(), warning))
    thread = threading.Thread(target=run, name="glass-agent-check", daemon=True)
    thread.start()
    return thread


def take_warnings(now=time.time):
    """Offene Warnungen (hoechstens 10 min alt) einmal abholen."""
    fresh = [text for t, text in HOME_WARNINGS if now() - t < 600]
    del HOME_WARNINGS[:]
    return " ".join(fresh)


def _all_states(home, opener):
    """Alle Zustaende auf einmal (ein Aufruf, ~0,05 s) -> {entity_id: state-dict}."""
    try:
        return {s["entity_id"]: s for s in _ha(home, "GET", "/api/states", opener=opener) or []}
    except (urllib.error.URLError, TimeoutError, OSError, ValueError, KeyError, TypeError):
        return {}


def _num(states, entity):
    try:
        return float(states[entity]["state"])
    except (KeyError, TypeError, ValueError):
        return None


def nas_summary(device, states):
    """Synology aus Home Assistant: Auslastung, Volumes, Platten, Temperatur und was auffaellt."""
    prefix = device["prefix"]
    mine = {k: v for k, v in states.items() if k.startswith(prefix) or k.startswith(
        "binary_sensor." + prefix.split(".", 1)[1]) or k.startswith("update." + prefix.split(".", 1)[1])}
    if not mine:
        return "%s: keine Daten von Home Assistant." % device["name"]
    if all(v.get("state") in ("unavailable", "unknown") for v in mine.values()):
        return "%s ist nicht erreichbar." % device["name"]
    p = prefix
    parts = []
    for key, label in (("cpu_auslastung_gesamt", "CPU"), ("speichernutzung_real", "RAM")):
        value = _num(states, p + key)
        if value is not None:
            parts.append("%s %s %%" % (label, _number(value)))
    volumes = sorted(k for k in mine if re.match(re.escape(p) + r"volume_\d+_volume_nutzung$", k))
    for key in volumes:
        parts.append("Volume %s %s %% belegt" % (re.search(r"volume_(\d+)_", key).group(1),
                                                 _number(_num(states, key) or 0)))
    temp = _num(states, p + "temperatur")
    if temp is not None:
        parts.append("%s °C" % _number(temp))
    drives = [k for k in mine if re.match(re.escape(p) + r"(m_2_)?drive_\d+_status$", k)]
    bad = [k for k in drives if states[k]["state"] != "normal"]
    bad += [k for k in mine if re.match(re.escape(p) + r"volume_\d+_status$", k) and states[k]["state"] != "normal"]
    bad += [k for k, v in mine.items() if k.startswith("binary_sensor.") and v.get("state") == "on"
            and re.search(r"(fehlerhafte|unterhalb|ausfall|fail)", k)]
    notes = []
    if drives:
        notes.append("%d Platten normal" % (len(drives) - len([k for k in bad if k in drives]))
                     if not bad else "Achtung: " + ", ".join(
                         re.sub(r"_", " ", k.split(".", 1)[1].replace(p.split(".", 1)[1], "")) for k in bad))
    if any(k.startswith("update.") and v.get("state") == "on" for k, v in mine.items()):
        notes.append("DSM-Update verfügbar")
    return "%s läuft: %s.%s" % (device["name"], ", ".join(parts), (" " + ". ".join(notes) + ".") if notes else "")


def _duration(hours):
    minutes = int(round(hours * 60))
    return ("%d h %d min" % (minutes // 60, minutes % 60)) if minutes >= 60 else "%d min" % minutes


def printer_summary(device, states):
    """Drucker (Moonraker in Home Assistant, Praefix z.B. "k1_max"): Steckdose, Zustand, Fortschritt, Restzeit."""
    p = device["printer"]
    plug = (states.get((device.get("entities") or [""])[0]) or {}).get("state")
    state = (states.get("sensor.%s_current_print_state" % p) or {}).get("state")
    if plug == "off":
        return "%s ist aus." % device["name"]
    if state in (None, "unavailable", "unknown"):
        return "%s hat Strom, meldet sich aber noch nicht (startet gerade?)." % device["name"]
    nozzle = _num(states, "sensor.%s_extruder_temperature" % p)
    bed = _num(states, "sensor.%s_bed_temperature" % p)
    temps = ", ".join(t for t in (nozzle is not None and "Düse %d °C" % nozzle,
                                  bed is not None and "Bett %d °C" % bed) if t)
    if state in ("printing", "paused"):
        progress = _num(states, "sensor.%s_progress" % p)
        left = _num(states, "sensor.%s_print_time_left" % p)
        name = (states.get("sensor.%s_filename" % p) or {}).get("state") or ""
        name = re.sub(r"\.(gcode|3mf)$", "", name.rsplit("/", 1)[-1])[:30]
        bits = ["%s %s" % (device["name"], "druckt" if state == "printing" else "pausiert")]
        if name and name not in ("unknown", "unavailable"):
            bits[0] += " " + name
        if progress is not None:
            bits.append("%d %%" % progress)
        if left is not None and left > 0:
            bits.append("noch %s" % _duration(left))
        return ", ".join(bits) + "." + ((" " + temps + ".") if temps else "")
    said = {"standby": "ist an, druckt nichts", "complete": "ist fertig", "cancelled": "Druck abgebrochen",
            "error": "meldet einen Fehler"}.get(state, "ist an (%s)" % state)
    return "%s %s.%s" % (device["name"], said, (" " + temps + ".") if temps else "")


def _say_state(device, state):
    on = _is_on(state)
    if on is None:
        return "%s ist nicht erreichbar%s." % (device["name"], " (Standby?)" if device.get("kind") == "tv" else "")
    return "%s ist %s." % (device["name"], "an" if on else "aus")


def answer_home(question, home=None, opener=urllib.request.urlopen, sleep=time.sleep):
    home = HOME if home is None else home
    command = home_command(question, home)
    if not command:
        return None
    action, steps, devices = command["action"], command["steps"], command["devices"]
    trace("command", action=action, devices=[d["name"] for d in devices], steps=steps,
          app=(command.get("app") or (None,))[0])
    if action == "script":
        try:
            _ha(home, "POST", "/api/services/script/turn_on", {"entity_id": devices[0]["script"]}, opener)
        except (urllib.error.URLError, TimeoutError, OSError, ValueError):
            return "Home Assistant hat nicht reagiert."
        return "%s gestartet." % devices[0]["name"]
    if action == "dim":
        body = {"entity_id": [e for d in devices for e in d["entities"]]}
        if command.get("level") is not None:
            body["brightness_pct"] = command["level"]
        elif command.get("step"):
            body["brightness_step_pct"] = command["step"]
        if command.get("kelvin"):
            body["color_temp_kelvin"] = command["kelvin"]
        try:
            _ha(home, "POST", "/api/services/light/turn_on", body, opener)
        except (urllib.error.URLError, TimeoutError, OSError, ValueError):
            return "Home Assistant hat nicht reagiert."
        what = ("auf %d %%" % command["level"]) if command.get("level") is not None else (
            "heller" if command.get("step", 0) > 0 else "dunkler" if command.get("step", 0) < 0 else "")
        tone = {2700: "warm", 5000: "kalt"}.get(command.get("kelvin"), "")
        return "%s %s." % (", ".join(d["name"] for d in devices), " und ".join(x for x in (what, tone) if x) or "geändert")
    if action == "denied":
        return "%s schalte ich nicht – ich kann nur sagen, wie es ihr geht." % devices[0]["name"]
    if action == "status" and any(d.get("kind") == "nas" or d.get("printer") for d in devices):
        everything = _all_states(home, opener)
        if not everything:
            return "Home Assistant hat nicht reagiert."
        return " ".join(nas_summary(d, everything) if d.get("kind") == "nas" else
                        printer_summary(d, everything) if d.get("printer") else
                        _say_state(d, (everything.get(_power_entity(d)) or {}).get("state")) for d in devices)
    if action == "status":
        states = [(d, _state(home, _power_entity(d), opener)) for d in devices]
        if len(states) <= 2:
            return " ".join(_say_state(d, state) for d, state in states)
        on = [d["name"] for d, state in states if _is_on(state)]
        gone = [d["name"] for d, state in states if _is_on(state) is None]
        text = ("An: %s. Alle anderen aus." % ", ".join(on)) if on else "Alle sind aus."
        return text + ((" Nicht erreichbar: %s." % ", ".join(gone)) if gone else "")
    if action == "app":
        device, (word, package) = devices[0], command["app"]
        if not device.get("remote"):
            return "%s kann keine Apps starten (keine Fernbedienung eingetragen)." % device["name"]
        try:                                      # schaltet bei Bedarf auch ein (Android-TV-Fernbedienung)
            _ha(home, "POST", "/api/services/remote/turn_on",
                {"entity_id": device["remote"], "activity": package}, opener)
        except (urllib.error.URLError, TimeoutError, OSError, ValueError):
            return "Home Assistant hat nicht reagiert."
        app_name = word[:1].upper() + word[1:]
        seen = {}

        def started():
            seen["activity"] = (_entity(home, device["remote"], opener).get("attributes") or {}).get(
                "current_activity")
            return seen["activity"] == package
        if _wait_for(started, sleep):
            return "%s läuft am %s." % (app_name, device["name"])
        _check_later(started, sleep, "Achtung: %s ist am %s nicht gestartet (installiert?)." % (app_name, device["name"]))
        return "%s wird am %s gestartet." % (app_name, device["name"])
    calls = []
    for device in devices:
        kind = device.get("kind")
        if kind == "tv":
            if action in ("on", "off") and device.get("remote"):   # Fernbedienung = echter Ein/Aus-Knopf
                calls.append(("remote", "turn_on" if action == "on" else "turn_off", {"entity_id": device["remote"]}))
            elif action in ("on", "off"):
                calls.append(("media_player", "turn_on" if action == "on" else "turn_off", {"entity_id": device["player"]}))
            elif action in ("mute", "unmute"):
                calls.append(("media_player", "volume_mute",
                              {"entity_id": device["player"], "is_volume_muted": action == "mute"}))
            elif device.get("remote"):
                calls.append(("remote", "send_command", {"entity_id": device["remote"], "num_repeats": steps,
                                                         "command": "VOLUME_UP" if action == "up" else "VOLUME_DOWN"}))
            else:
                calls.append(("media_player", "volume_up" if action == "up" else "volume_down",
                              {"entity_id": device["player"]}))
        else:
            if action == "off" and device.get("guard"):
                guard = _state(home, device["guard"], opener)
                if guard in ("printing", "paused"):
                    return "%s bleibt an – es läuft gerade ein Druck." % device["name"]
            calls.append((kind, "turn_on" if action == "on" else "turn_off", {"entity_id": device["entities"]}))
    failed = []
    for domain, service, body in calls:
        try:
            _ha(home, "POST", "/api/services/%s/%s" % (domain, service), body, opener)
        except (urllib.error.URLError, TimeoutError, OSError, ValueError):
            failed.append(body["entity_id"])
    if failed and len(failed) == len(calls):
        return "Home Assistant hat nicht reagiert."
    names = ", ".join(d["name"] for d in devices)
    if action in ("up", "down"):
        return "%s %d× %s." % (names, steps, "lauter" if action == "up" else "leiser")
    if action in ("mute", "unmute"):
        return "%s %s." % (names, "stumm" if action == "mute" else "Ton wieder an")
    want = action == "on"
    seen = {}

    def switched():                               # zuruecklesen: hat es wirklich geschaltet?
        seen.update({d["name"]: _is_on(_state(home, _power_entity(d), opener)) for d in devices})
        return all(seen[d["name"]] == want for d in devices)
    if not _wait_for(switched, sleep):
        wrong = lambda: ", ".join(d["name"] for d in devices if seen.get(d["name"]) != want)
        _check_later(switched, sleep, "Achtung: %s meldet noch %s." % (wrong(), "aus" if want else "an"))
        return "%s wird %s." % (names, "eingeschaltet" if want else "ausgeschaltet")
    said = []
    for device in devices:
        on = seen.get(device["name"])
        if on is None:
            said.append("%s: Befehl geschickt, Zustand unbekannt" % device["name"])
        elif on == want:
            said.append("%s ist %s" % (device["name"], "an" if want else "aus"))
        else:
            said.append("%s: Befehl geschickt, meldet noch %s" % (device["name"], "an" if on else "aus"))
    return ". ".join(said) + "."


def local_now(now=time.time):
    import datetime
    try:
        from zoneinfo import ZoneInfo
        return datetime.datetime.fromtimestamp(now(), ZoneInfo(TZ_NAME))
    except Exception:  # noqa: BLE001 - ohne Zeitzonendaten: Rechnerzeit
        return datetime.datetime.fromtimestamp(now())


def answer_now(question, now=time.time):
    stamp = local_now(now)
    if TIME_RE.match(question):
        return "Es ist %d:%02d Uhr." % (stamp.hour, stamp.minute)
    return "Heute ist %s, der %d.%d.%d." % (WEEKDAYS[stamp.weekday()], stamp.day, stamp.month, stamp.year)


def read_profile(path=None):
    """Kurzer Steckbrief (z. B. Hermes' USER.md) fuer den direkten Weg - der kennt sonst niemanden."""
    path = PROFILE_FILE if path is None else path
    if not path:
        return ""
    try:
        with open(os.path.expanduser(path), encoding="utf-8") as handle:
            text = handle.read()
    except OSError:
        return ""
    text = re.sub(r"\s*§\s*", " ", text)
    return re.sub(r"\s+", " ", text).strip()[:PROFILE_CHARS]

# --------------------------------------------------------------------------
# Antwort fuer die Brille aufbereiten
# --------------------------------------------------------------------------

_EMOJI_RE = re.compile(
    "[\U0001F000-\U0001FAFF\U00002600-\U000027BF\U0001F1E6-\U0001F1FF\U00002B00-\U00002BFF"
    "\U0000FE0F\U0000200D\U000020E3]+"
)
_BOX_RE = re.compile("[─-▟■-◿]+")


def clean_for_glasses(text, budget=CHAR_BUDGET):
    """Markdown/Emojis raus, Leerraum zusammen, auf `budget` Zeichen am Satzende kuerzen."""
    text = re.sub(r"(?s)<think>.*?</think>", "", text or "")
    t = str(text or "")
    t = re.sub(r"```.*?```", " ", t, flags=re.S)            # Codebloecke
    t = re.sub(r"`([^`]*)`", r"\1", t)
    t = re.sub(r"!\[[^\]]*\]\([^)]*\)", " ", t)             # Bilder
    t = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", t)          # Links -> Text
    t = re.sub(r"https?://\S+", " ", t)
    t = re.sub(r"(?m)^\s{0,3}#{1,6}\s*", "", t)             # Ueberschriften
    t = re.sub(r"(?m)^\s*[-*+•]\s+", "", t)                 # Aufzaehlungen
    t = re.sub(r"(?m)^\s*\d+[.)]\s+", "", t)
    t = re.sub(r"(?m)^\s*\|.*\|\s*$", " ", t)               # Tabellenzeilen
    t = re.sub(r"(\*\*|__|~~)(.+?)\1", r"\2", t)
    t = re.sub(r"(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])", r"\1", t)
    t = _EMOJI_RE.sub("", t)
    t = _BOX_RE.sub(" ", t)
    t = re.sub(r"\s+", " ", t).strip()
    if len(t) <= budget:
        return t
    cut = t[:budget]
    ends = [m.end() for m in re.finditer(r"[.!?…](\s|$)", cut)]
    if ends and ends[-1] >= budget * 0.5:
        return cut[:ends[-1]].strip()
    space = cut.rfind(" ")
    return (cut[:space] if space > budget * 0.6 else cut).rstrip(" ,;:-") + " …"


# --------------------------------------------------------------------------
# Gespraechsverlauf (nur im Speicher)
# --------------------------------------------------------------------------

class Conversation:
    """Merkt das laufende Gespraech, solange zwischen zwei Fragen weniger als `ttl` Sekunden liegen."""

    def __init__(self, ttl=CONTEXT_TTL, max_turns=MAX_TURNS, now=time.time, path=None, mode=None):
        self.ttl = ttl
        self.max_turns = max_turns
        self.now = now
        self.path = path
        self.turns = []          # [(frage, antwort)]
        self.last = 0.0
        self.mode = mode         # Freigabe-Stufe zur Laufzeit (None = GLASS_AGENT_APPROVAL)
        self.pending = None      # offener Hermes-Run: Rueckfrage oder Ergebnis fuer die naechste Frage
        self.lock = threading.Lock()
        self._load()

    def _load(self):
        if not self.path:
            return
        try:
            with open(self.path, encoding="utf-8") as handle:
                data = json.load(handle)
            self.turns = [(str(q), str(a)) for q, a in data.get("turns", [])][-self.max_turns:]
            self.last = float(data.get("last", 0))
            if data.get("mode") in APPROVAL_MODES and self.mode is None:
                self.mode = data["mode"]
            self.pending = data.get("pending") if isinstance(data.get("pending"), dict) else None
        except (OSError, ValueError, TypeError):
            self.turns, self.last = [], 0.0

    def _save(self):
        if not self.path:
            return
        try:
            tmp = self.path + ".tmp"
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump({"turns": self.turns, "last": self.last, "mode": self.mode,
                           "pending": self.pending}, handle, ensure_ascii=False)
            os.replace(tmp, self.path)
        except OSError:
            pass

    def history(self):
        with self.lock:
            if self.ttl <= 0 or self.now() - self.last > self.ttl:
                self.turns = []
            return list(self.turns)

    def add(self, question, answer):
        with self.lock:
            if self.ttl <= 0:
                return
            self.turns.append((question, answer))
            self.turns = self.turns[-self.max_turns:]
            self.last = self.now()
            self._save()

    def reset(self):
        with self.lock:
            self.turns = []
            self.last = 0.0
            self._save()

    def approval_mode(self):
        return self.mode if self.mode in APPROVAL_MODES else APPROVAL_DEFAULT

    def set_mode(self, mode):
        with self.lock:
            self.mode = mode
            self._save()

    def set_pending(self, pending):
        if pending and isinstance(pending.get("route"), dict):   # Agent-Schluessel nie in die Datei
            pending = dict(pending, route={k: v for k, v in pending["route"].items() if k != "key"})
        with self.lock:
            self.pending = pending
            self._save()


def last_user_text(body):
    """Der letzte Nutzer-Text aus einem OpenAI-Request (Inhalt als Text oder Teile-Liste)."""
    for message in reversed(body.get("messages") or []):
        if not isinstance(message, dict) or message.get("role") != "user":
            continue
        content = message.get("content")
        if isinstance(content, str):
            return content.strip()
        if isinstance(content, list):
            parts = [p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text"]
            return " ".join(parts).strip()
    return ""


def build_messages(question, turns, extra=SYSTEM_EXTRA, budget=CHAR_BUDGET):
    system = SYSTEM_DE % budget + ((" " + extra) if extra else "")
    messages = [{"role": "system", "content": system}]
    for q, a in turns:
        messages.append({"role": "user", "content": q})
        messages.append({"role": "assistant", "content": a})
    messages.append({"role": "user", "content": question})
    return messages


def completion(text, model):
    return {
        "id": "chatcmpl-glass-%d" % int(time.time() * 1000),
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model or "openclaw",
        "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
    }


# --------------------------------------------------------------------------
# Agent fragen
# --------------------------------------------------------------------------

def parse_routes(primary_url, primary_key, primary_provider, primary_model, fallbacks):
    """Die Wege der Reihe nach: der eigentliche Agent, dann die Ausweich-Eintraege."""
    routes = [{"name": (primary_provider + "/" if primary_provider else "") + (primary_model or "agent"),
               "url": primary_url, "key": primary_key, "provider": primary_provider, "model": primary_model}]
    for entry in [e.strip() for e in re.split(r"[;,]", fallbacks or "") if e.strip()]:
        if entry.startswith("direct="):
            url, _, model = entry[len("direct="):].partition("#")
            routes.append({"name": "direct:" + (model.strip() or "?"), "url": url.strip(), "key": "",
                           "provider": "", "model": model.strip(), "direct": True})
        else:
            provider, _, model = entry.partition("/")
            routes.append({"name": entry, "url": primary_url, "key": primary_key,
                           "provider": provider.strip(), "model": model.strip()})
    return routes


ROUTES = parse_routes(UPSTREAM_URL, UPSTREAM_KEY, UPSTREAM_PROVIDER, UPSTREAM_MODEL, FALLBACKS)


def fast_routes(routes=None):
    """"wissen": erst das schnelle Modell direkt, scheitert es, die normalen Wege."""
    routes = ROUTES if routes is None else routes
    if not FAST_URL:
        return routes
    return [{"name": "schnell:" + (FAST_MODEL or "?"), "url": FAST_URL, "key": FAST_KEY, "provider": "",
             "model": FAST_MODEL, "direct": True}] + list(routes)


def task_routes(routes=None):
    """"tun": der Agent mit dem staerkeren Modell, danach die normalen Wege."""
    routes = ROUTES if routes is None else routes
    if not TASK_MODEL or not routes or routes[0].get("direct"):
        return routes
    first = dict(routes[0], model=TASK_MODEL)
    first["name"] = (first["provider"] + "/" if first["provider"] else "") + TASK_MODEL
    return [first] + list(routes)
_resting = {}   # Weg-Name -> Zeitpunkt, bis zu dem er uebersprungen wird

# Ein Agent wie Hermes meldet ein leeres Kontingent oft als normale Antwort - daran erkennen.
_QUOTA_RE = re.compile(r"(usage limit|rate.?limit|quota|rejected this request|insufficient|exceeded|"
                       r"too many requests|credit balance|billing|kontingent|limit erreicht)", re.I)


class RouteFailed(Exception):
    def __init__(self, reason, rest=False, busy=False):
        super().__init__(reason)
        self.rest = rest
        self.busy = busy      # Hermes: "Too many concurrent runs" - beschaeftigt, kein leeres Kontingent


def _http_failed(error):
    """HTTP-Fehler -> RouteFailed. Hermes meldet volle Lauf-Plaetze ebenfalls mit 429; das ist kein Kontingent."""
    try:
        detail = error.read().decode("utf-8", "replace")[:500]
    except Exception:  # noqa: BLE001
        detail = ""
    if error.code == 429 and re.search(r"concurrent", detail, re.I):
        return RouteFailed("beschaeftigt", busy=True)
    return RouteFailed("HTTP %d" % error.code, rest=error.code in (402, 429))


def _read_stream(response, deadline):
    """OpenAI-SSE einsammeln -> {"choices": [{"message": {"content": ...}}]} bzw. {"error": ...}."""
    parts = []
    while True:
        if time.time() > deadline:
            raise RouteFailed("zu lange (abgebrochen)")
        line = response.readline()
        if not line:
            break
        line = line.decode("utf-8", "replace").strip()
        if not line.startswith("data:"):
            continue
        payload = line[5:].strip()
        if payload == "[DONE]":
            break
        try:
            event = json.loads(payload)
        except ValueError:
            continue
        if isinstance(event, dict) and event.get("error"):
            return {"error": event["error"]}
        for choice in (event.get("choices") or []) if isinstance(event, dict) else []:
            piece = (choice.get("delta") or {}).get("content") or (choice.get("message") or {}).get("content")
            if piece:
                parts.append(piece)
    return {"choices": [{"message": {"content": "".join(parts)}}]}


def ask_route(route, messages, model, opener=urllib.request.urlopen, timeout=None):
    if route.get("direct") and messages and messages[0].get("role") == "system":
        messages = [dict(messages[0], content=messages[0]["content"] + " " + DIRECT_NOTE)] + list(messages[1:])
    stream = not route.get("direct")
    body = {"model": route["model"] or model or "openclaw", "messages": messages, "stream": stream}
    if route["provider"]:
        body["provider"] = route["provider"]
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if route["key"]:
        headers["Authorization"] = "Bearer " + route["key"]
    request = urllib.request.Request(route["url"], data=json.dumps(body).encode(), headers=headers, method="POST")
    deadline = time.time() + min(timeout or TIMEOUT, AGENT_MAX_S if stream else TIMEOUT)
    try:
        with opener(request, timeout=min(timeout or TIMEOUT, AGENT_MAX_S) if stream else timeout or TIMEOUT) as response:
            headers = getattr(response, "headers", None)
            if headers is not None and "event-stream" in (headers.get("Content-Type") or ""):
                data = _read_stream(response, deadline)     # Verlassen des with schliesst -> Hermes bricht ab
            else:
                data = json.loads(response.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as error:
        raise _http_failed(error) from None
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as error:
        raise RouteFailed(type(error).__name__) from None
    if isinstance(data.get("error"), (dict, str)):
        raise RouteFailed("error", rest=bool(_QUOTA_RE.search(json.dumps(data["error"]))))
    choice = (data.get("choices") or [{}])[0]
    text = str((choice.get("message") or {}).get("content") or "")
    if not text.strip():
        raise RouteFailed("leer")
    if len(text) < 400 and _QUOTA_RE.search(text):
        raise RouteFailed("Kontingent", rest=True)
    return text


def ask_upstream(messages, model, opener=urllib.request.urlopen, routes=None, now=time.time):
    """Fragt die Wege der Reihe nach, bis einer antwortet. Wirft RouteFailed, wenn keiner kann."""
    routes = ROUTES if routes is None else routes
    last = None
    for route in routes:
        if _resting.get(route["name"], 0) > now():
            continue
        started = time.time()
        try:
            text = ask_route(route, messages, model, opener)
            trace("route", name=route["name"], ms=round((time.time() - started) * 1000))
            LAST_ROUTE["name"] = route["name"]
            if route is not routes[0]:
                sys.stderr.write("[glass-agent] Ausweichweg %s hat geantwortet\n" % route["name"])
            return text
        except RouteFailed as error:
            last = error
            trace("route", name=route["name"], ms=round((time.time() - started) * 1000), error=str(error)[:60])
            sys.stderr.write("[glass-agent] Weg %s gescheitert: %s%s\n"
                             % (route["name"], error, " (15 min Pause)" if error.rest else ""))
            if error.rest:
                _resting[route["name"]] = now() + COOLDOWN_S
            if error.busy:       # alle Agent-Wege gehen an dasselbe Hermes; ein Modell ohne Daten raet nur
                raise error
    raise last or RouteFailed("kein Weg frei")


# --------------------------------------------------------------------------
# Freigaben: Hermes-Runs-API (POST /v1/runs, GET /v1/runs/{id}, POST /v1/runs/{id}/approval|stop)
# --------------------------------------------------------------------------
#
# Hermes haelt einen Run im Status "waiting_for_approval" an, wenn sein Freigabe-Gate anspringt
# (gefaehrliche Shell-Befehle, execute_code, Plugin-Regeln fuer Werkzeuge) und approvals.mode nicht
# "off" ist. GET /v1/runs/{id} liefert dann unter "approval": command (geschwaerzt), description,
# pattern_key(s), request_id, choices, allow_session/allow_permanent, ggf. smart_denied.
# Beantwortet wird mit POST /v1/runs/{id}/approval {"choice": "once"|"deny", "request_id": ...}.

# Werkzeuge, die nur lesen (Plugin-Regel "plugin_rule:<werkzeug>:..."). Alles andere = nachfragen.
READ_ONLY_TOOLS = {"read_file", "search_files", "web_search", "web_extract", "session_search",
                   "vision_analyze", "browser_snapshot", "skills_list", "skill_view"}
# Shell-Befehle, die nur lesen - und nur ohne Umleitung, Befehlsersetzung, sudo usw.
READ_ONLY_CMDS = {"ls", "cat", "head", "tail", "grep", "egrep", "rg", "wc", "df", "du", "stat",
                  "file", "which", "pwd", "date", "uptime", "ps", "free", "uname", "whoami", "id",
                  "hostname", "nproc", "lsblk", "sort", "uniq", "cut", "tr", "nvidia-smi", "find", "tree"}
READ_ONLY_GIT = {"status", "log", "diff", "show", "branch", "remote", "rev-parse", "ls-files", "blame"}
_RISK_RE = re.compile(r"(delet|remov|l[oö]sch|overwrit|[uü]berschreib|writ|schreib|send|mail|kill|"
                      r"shutdown|reboot|format|chmod|chown|install|exfil|secret|credential|password|"
                      r"token|privileg|sudo|recursive|rekursiv)", re.I)
_SHELL_META_RE = re.compile(r"(>|<\(|\$\(|`|\bsudo\b|\btee\b|\bxargs\b|-delete\b|-exec|-ok\b|-fprint|"
                            r"--output|(^|\s)-o\b)")


def approval_tool(approval):
    """Werkzeugname einer Plugin-Freigabe, sonst "" (dann ist es ein Shell-/Code-Befehl)."""
    key = str(approval.get("pattern_key") or "")
    if key.startswith("plugin_rule:"):
        return key[len("plugin_rule:"):].split(":", 1)[0]
    match = re.match(r"^<([\w.-]+)>", str(approval.get("command") or ""))
    return match.group(1) if match else ""


def is_read_only(approval):
    """Konservativ: True nur, wenn die Freigabe sicher nur liest. Unbekannt = False (= nachfragen)."""
    if not isinstance(approval, dict) or approval.get("smart_denied"):
        return False
    description = str(approval.get("description") or "")
    if _RISK_RE.search(description):
        return False
    tool = approval_tool(approval)
    if tool:
        return tool in READ_ONLY_TOOLS
    keys = " ".join([str(approval.get("pattern_key") or "")] + [str(k) for k in approval.get("pattern_keys") or []])
    if re.search(r"(execute_code|python|script|plugin)", keys, re.I):
        return False   # Code-Ausfuehrung ist nie "nur lesen"
    command = str(approval.get("command") or "").strip()
    if not command or "\n" in command or _SHELL_META_RE.search(command):
        return False
    for part in re.split(r"\|\||&&|[|;&]", command):
        words = part.split()
        if not words:
            return False
        name = words[0].rsplit("/", 1)[-1]
        if name == "git":
            if len(words) < 2 or words[1] not in READ_ONLY_GIT:
                return False
        elif name not in READ_ONLY_CMDS:
            return False
    return True


def approval_question(approval, budget=CHAR_BUDGET):
    """Kurze Rueckfrage fuer die Brille, z. B. "Hermes will an Maria schreiben: ... Sag ja oder nein." """
    tool = approval_tool(approval)
    description = re.sub(r"\s+", " ", str(approval.get("description") or "")).strip()
    command = re.sub(r"\s+", " ", str(approval.get("command") or "")).strip()
    if tool:
        text = "Hermes will " + (description or "das Werkzeug %s nutzen" % tool)
    else:
        text = "Hermes will ausführen: " + (command[:160] or "einen Befehl")
        if description:
            text += " (%s)" % description[:100]
    tail = " Sag ja oder nein."
    room = budget - len(tail) - 1
    if len(text) > room:
        text = text[:room - 2].rstrip() + " …"
    return text.rstrip(". ") + "." + tail


class RunsUnsupported(Exception):
    pass


def runs_base(url):
    """http://h:8642/v1/chat/completions -> http://h:8642/v1/runs (sonst None)."""
    url = (url or "").rstrip("/")
    return url[:-len("/chat/completions")] + "/runs" if url.endswith("/chat/completions") else None


def _call(route, method, url, body=None, opener=urllib.request.urlopen, timeout=None):
    headers = {"Accept": "application/json"}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    if route.get("key"):
        headers["Authorization"] = "Bearer " + route["key"]
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    with opener(request, timeout=timeout or TIMEOUT) as response:
        raw = response.read().decode("utf-8", "replace")
    return json.loads(raw) if raw.strip() else {}


_runs_off = {}   # Runs-URL -> Zeitpunkt, bis zu dem Chat-Completions benutzt wird (404 gesehen)


def start_run(route, question, turns, opener=urllib.request.urlopen):
    """POST /v1/runs. Gibt die run_id zurueck; wirft RunsUnsupported (404/405) oder RouteFailed."""
    base = runs_base(route["url"])
    if not base:
        raise RunsUnsupported()
    history = []
    for q, a in turns:
        history += [{"role": "user", "content": q}, {"role": "assistant", "content": a}]
    body = {"input": question, "instructions": build_messages("", [])[0]["content"]}
    if history:
        body["conversation_history"] = history
    if route["provider"]:
        body["provider"] = route["provider"]
    if route["model"]:      # /v1/runs nimmt ein nacktes "model" immer an - "openclaw" also NICHT schicken
        body["model"] = route["model"]
    try:
        data = _call(route, "POST", base, body, opener, timeout=10)   # antwortet sofort mit 202
    except urllib.error.HTTPError as error:
        if error.code in (404, 405):
            raise RunsUnsupported() from None
        raise _http_failed(error) from None
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as error:
        raise RouteFailed(type(error).__name__) from None
    run_id = str(data.get("run_id") or "")
    if not re.match(r"^[\w-]{1,200}$", run_id):
        raise RouteFailed("keine run_id")
    return run_id


def _with_key(route):
    """Gemerkte Wege liegen ohne Schluessel in der Datei - hier aus der Umgebung wieder ergaenzen."""
    if route.get("key"):
        return route
    for known in ROUTES:
        if known["name"] == route.get("name") and known["url"] == route.get("url"):
            return dict(route, key=known["key"])
    return dict(route, key="")


def run_control(pending, action, choice=None, opener=urllib.request.urlopen):
    """Freigabe beantworten (action="approval") oder Run stoppen (action="stop"). Wirft nie."""
    route = _with_key(pending.get("route") or {})
    base = runs_base(route.get("url", ""))
    if not base or not pending.get("run_id"):
        return False
    body = {}
    if action == "approval":
        body = {"choice": choice}
        if pending.get("request_id"):
            body["request_id"] = pending["request_id"]
    try:
        _call(route, "POST", "%s/%s/%s" % (base, pending["run_id"], action), body, opener, timeout=5)
        return True
    except Exception:  # noqa: BLE001 - z. B. 409, wenn die Freigabe schon verfallen ist
        sys.stderr.write("[glass-agent] Run: %s %s nicht moeglich\n" % (action, choice or ""))
        return False


def cancel_pending(pending, opener=urllib.request.urlopen):
    """Offene Freigabe ablehnen und den Run anhalten (Schweigen ist keine Zustimmung)."""
    if pending.get("kind") == "approval":
        run_control(pending, "approval", "deny", opener)
    run_control(pending, "stop", None, opener)


def follow_run(pending, conversation, opener=urllib.request.urlopen, now=time.time, sleep=time.sleep, wait=None):
    """Run beobachten, bis er fertig ist, eine Rueckfrage braucht oder die Wartezeit um ist.

    `pending` = {"run_id", "route", "question", ...}. Ergebnis: ("final", text) | ("ask", text) |
    ("running", text). Bei "ask"/"running" ist der Run in conversation.pending gemerkt.
    Wirft RouteFailed, wenn der Run scheitert (dann darf der naechste Weg probiert werden)."""
    route = _with_key(pending["route"])
    url = "%s/%s" % (runs_base(route["url"]), pending["run_id"])
    deadline = now() + (BUDGET if wait is None else wait)
    handled = set(pending.get("handled") or [])
    while True:
        try:
            status = _call(route, "GET", url, None, opener, timeout=5)
        except urllib.error.HTTPError as error:
            if error.code == 404:
                conversation.set_pending(None)
                raise RouteFailed("Run unbekannt") from None
            status = {}
        except (urllib.error.URLError, TimeoutError, OSError, ValueError):
            status = {}    # kurz weg - der Run laeuft trotzdem weiter, also nicht auf den naechsten Weg
        state = status.get("status")
        if state == "completed":
            conversation.set_pending(None)
            text = str(status.get("output") or "")
            if not text.strip():
                raise RouteFailed("leer")
            if len(text) < 400 and _QUOTA_RE.search(text):
                raise RouteFailed("Kontingent", rest=True)
            return "final", text
        if state in ("failed", "cancelled"):
            conversation.set_pending(None)
            raise RouteFailed("Run " + state, rest=bool(_QUOTA_RE.search(str(status.get("error") or ""))))
        if state == "waiting_for_approval":
            approval = status.get("approval") if isinstance(status.get("approval"), dict) else {}
            request_id = str(approval.get("request_id") or "")
            if request_id not in handled:
                mode = conversation.approval_mode()
                if mode == "auto" or (mode == "mixed" and is_read_only(approval)):
                    handled.add(request_id)
                    run_control(dict(pending, request_id=request_id), "approval", "once", opener)
                    sys.stderr.write("[glass-agent] Freigabe automatisch erteilt (%s)\n" % mode)
                    continue
                conversation.set_pending(dict(pending, kind="approval", request_id=request_id,
                                              handled=sorted(handled), t=now()))
                return "ask", approval_question(approval)
        if now() >= deadline:
            conversation.set_pending(dict(pending, kind="running", handled=sorted(handled), t=now()))
            return "running", BUSY_TEXT
        sleep(POLL_S)


def ask_agent_runs(question, turns, model, conversation, opener=urllib.request.urlopen, routes=None,
                   now=time.time, sleep=time.sleep, budget=None):
    """Wie ask_upstream, aber Agent-Wege laufen ueber /v1/runs (mit Freigaben).

    Direkte Wege (eigenes vLLM, keine Werkzeuge -> keine Freigaben) und Agenten ohne Runs-API (404)
    gehen ueber Chat-Completions. Ergebnis wie follow_run: (art, text). Ein Run, der nur langsam ist,
    laeuft auf Hermes weiter (art "running") - ausgewichen wird nur bei echten Fehlern."""
    routes = ROUTES if routes is None else routes
    deadline = now() + (BUDGET if budget is None else budget)
    last = None
    for route in routes:
        if _resting.get(route["name"], 0) > now():
            continue
        try:
            base = runs_base(route["url"])
            if route.get("direct") or not base or _runs_off.get(base, 0) > now():
                text = ask_route(route, build_messages(question, turns), model, opener,
                                 timeout=max(3.0, deadline - now()))
                LAST_ROUTE["name"] = route["name"]
                return "final", text
            try:
                run_id = start_run(route, question, turns, opener)
            except RunsUnsupported:
                _runs_off[base] = now() + 10 * 60
                sys.stderr.write("[glass-agent] Agent kennt /v1/runs nicht - Chat-Completions ohne Freigaben\n")
                text = ask_route(route, build_messages(question, turns), model, opener,
                                 timeout=max(3.0, deadline - now()))
                LAST_ROUTE["name"] = route["name"]
                return "final", text
            LAST_ROUTE["name"] = route["name"]
            # Ab hier laeuft der Run: scheitert er, darf der naechste Weg ran; laeuft er nur lange,
            # NICHT (sonst wuerde dieselbe Aufgabe doppelt ausgefuehrt).
            return follow_run({"run_id": run_id, "route": route, "question": question}, conversation,
                              opener, now, sleep, wait=max(0.0, deadline - now()))
        except RouteFailed as error:
            last = error
            sys.stderr.write("[glass-agent] Weg %s gescheitert: %s%s\n"
                             % (route["name"], error, " (15 min Pause)" if error.rest else ""))
            if error.rest:
                _resting[route["name"]] = now() + COOLDOWN_S
            if error.busy:
                raise error
    raise last or RouteFailed("kein Weg frei")


CONVERSATION = Conversation(path=STATE_FILE)
LAST_ROUTE = {"name": "", "kind": ""}


def log_content(question, turns, route, text, seconds):
    """Mitschnitt mit Inhalt, nur wenn GLASS_AGENT_LOG_CONTENT=1. Datei nur fuer den Besitzer lesbar."""
    if not LOG_CONTENT:
        return
    try:
        fd = os.open(LOG_FILE, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        with os.fdopen(fd, "a", encoding="utf-8") as handle:
            handle.write(json.dumps({"t": time.strftime("%Y-%m-%d %H:%M:%S"), "frage": question,
                                     "verlauf": len(turns), "weg": route, "sekunden": round(seconds, 1),
                                     "antwort": text}, ensure_ascii=False) + "\n")
    except OSError:
        pass


def error_text(error):
    if isinstance(error, RouteFailed) and error.busy:
        return "Hermes ist noch mit einer früheren Frage beschäftigt. Frag gleich nochmal."
    if isinstance(error, RouteFailed):
        return "Kein KI-Dienst erreichbar. Gleich nochmal versuchen."
    if isinstance(error, urllib.error.HTTPError):
        return "Agent antwortet nicht (HTTP %d)." % error.code
    if isinstance(error, (urllib.error.URLError, TimeoutError, OSError)):
        return "Agent nicht erreichbar."
    return "Agent-Antwort unlesbar."


# --------------------------------------------------------------------------
# Hintergrund: langsame Agenten laufen weiter, das Ergebnis kommt mit der naechsten Aeusserung
# --------------------------------------------------------------------------

_JOBS = {}   # job-id -> {"event", "lock", "abandoned", "result"} - nur im Speicher (Neustart = verloren)


def ask_in_background(fn, conversation, question, wait, now=time.time):
    """`fn()` in einem Faden starten und bis `wait` Sekunden warten.

    Fertig -> ("ok", text) oder ("error", exc). Nicht fertig -> None; dann ist conversation.pending
    {"kind": "background"} und der Faden legt sein Ergebnis spaeter als {"kind": "result"} ab."""
    job_id = "%x%x" % (int(now() * 1000), threading.get_ident() & 0xFFFFFF) + os.urandom(4).hex()
    job = {"event": threading.Event(), "lock": threading.Lock(), "abandoned": False, "result": None}
    parent_steps, parent_id = getattr(_TRACE, "steps", None), getattr(_TRACE, "id", None)

    def work():
        trace_start()
        try:
            result = ("ok", fn())
        except Exception as error:  # noqa: BLE001 - wird zu kurzem Text
            result = ("error", error)
        with job["lock"]:
            job["result"] = result
            if not job["abandoned"] and parent_steps is not None:
                parent_steps.extend(_TRACE.steps)
            elif job["abandoned"]:            # die Brille hat schon "noch dran" bekommen: eigene Zeile
                trace_write({"t": time.strftime("%Y-%m-%d %H:%M:%S"), "id": parent_id, "type": "hintergrund",
                             "total_ms": round((time.time() - _TRACE.started) * 1000), "ok": result[0] == "ok",
                             "route": LAST_ROUTE.get("name") or "-", "steps": _TRACE.steps})
            if job["abandoned"]:
                ok = result[0] == "ok" and bool(clean_for_glasses(result[1]))
                text = clean_for_glasses(result[1]) if ok else "Das hat leider nicht geklappt. " + error_text(
                    result[1] if result[0] == "error" else RouteFailed("leer"))
                pending = conversation.pending
                if pending and pending.get("kind") == "background" and pending.get("job") == job_id:
                    conversation.set_pending({"kind": "result", "question": question, "text": text, "ok": ok,
                                              "t": now()})
                    sys.stderr.write("[glass-agent] Hintergrund-Ergebnis liegt bereit\n")
                _JOBS.pop(job_id, None)
            job["event"].set()

    threading.Thread(target=work, name="glass-agent-job", daemon=True).start()
    job["event"].wait(max(0.0, wait))
    with job["lock"]:
        if job["result"] is not None:
            return job["result"]
        job["abandoned"] = True
        _JOBS[job_id] = job
        conversation.set_pending({"kind": "background", "job": job_id, "question": question, "t": now()})
    sys.stderr.write("[glass-agent] Agent braucht laenger - laeuft im Hintergrund weiter\n")
    return None


def _earlier(text):
    return "Vorhin: " + clean_for_glasses(text, 150) + " "


def handle_pending(question, pending, conversation, opener, now, sleep, budget):
    """Offenen Vorgang zur neuen Aeusserung abarbeiten. Ergebnis (vorspann, antwort):
    antwort != None -> genau das zeigen; sonst die Aeusserung normal beantworten, `vorspann` davor."""
    kind = pending.get("kind")
    age = now() - float(pending.get("t") or 0)
    follow = bool(FOLLOW_RE.match(question) or WAIT_RE.match(question))
    if kind == "approval":
        if age > APPROVAL_TTL or not (YES_RE.match(question) or NO_RE.match(question)):
            cancel_pending(pending, opener)        # verfallen oder neue Frage: Schweigen ist kein Ja
            conversation.set_pending(None)
            return "", None
        if NO_RE.match(question):
            cancel_pending(pending, opener)
            conversation.set_pending(None)
            return "", "Abgebrochen. Hermes macht das nicht."
        handled = list(pending.get("handled") or []) + [pending.get("request_id") or ""]
        conversation.set_pending(None)
        if not run_control(pending, "approval", "once", opener):
            return "", "Die Freigabe ist schon verfallen."
        try:
            art, text = follow_run(dict(pending, handled=handled), conversation, opener, now, sleep, wait=budget)
        except RouteFailed:
            return "", "Das hat leider nicht geklappt."
        if art != "final":
            return "", text
        text = clean_for_glasses(text) or "Erledigt."
        conversation.add(pending.get("question") or "", text)
        return "", text
    if kind == "running":                          # Hermes-Run (Runs-API) laeuft noch
        if age > RESULT_TTL:
            conversation.set_pending(None)
            return "", None
        if NO_RE.match(question):
            cancel_pending(pending, opener)
            conversation.set_pending(None)
            return "", "Abgebrochen."
        try:
            art, text = follow_run(pending, conversation, opener, now, sleep, wait=budget if follow else 1.0)
        except RouteFailed:
            return "", ("Das hat leider nicht geklappt." if follow else None)
        if art == "ask":
            return "", text
        if art == "final":
            text = clean_for_glasses(text) or "Erledigt."
            conversation.add(pending.get("question") or "", text)
            return ("", text) if follow else (_earlier(text), None)
        return "", (BUSY_TEXT if follow else None)
    if kind == "background":                       # Chat-Anfrage laeuft in einem Faden weiter
        job = _JOBS.get(pending.get("job"))
        if job is None or age > RESULT_TTL:        # Neustart dazwischen oder zu alt
            conversation.set_pending(None)
            return "", None
        if follow:
            job["event"].wait(max(0.0, budget))
        pending = conversation.pending or {}
        kind = pending.get("kind")
        if kind != "result":
            return "", (BUSY_TEXT if follow else None)
        age = now() - float(pending.get("t") or 0)
    if kind == "result":
        conversation.set_pending(None)
        if age > RESULT_TTL:
            return "", None
        text = str(pending.get("text") or "")
        if pending.get("ok"):
            conversation.add(pending.get("question") or "", text)
        return ("", text) if follow else (_earlier(text), None)
    conversation.set_pending(None)
    return "", None


def answer(body, *args, **kwargs):
    """Wie _answer; eine im Hintergrund gescheiterte Nachpruefung (Geraet hat nicht geschaltet) kommt nach vorn."""
    text, model = _answer(body, *args, **kwargs)
    warning = take_warnings()
    return ((warning + " " + text) if warning else text), model


def _answer(body, ask=ask_upstream, conversation=CONVERSATION, opener=urllib.request.urlopen, routes=None,
           now=time.time, sleep=time.sleep, budget=None):
    """Kern: Request der Even-App -> Text fuer die Brille. Wirft nie; Fehler werden zu kurzem Text."""
    budget = BUDGET if budget is None else budget
    question = WAKE_RE.sub("", last_user_text(body)).strip()
    LAST_ROUTE.update(name="", kind="")      # sonst steht bei frueh beantworteten Aeusserungen die vorige Art im Log
    model = str(body.get("model") or "openclaw")
    if not question:
        return "Ich habe nichts verstanden.", model
    switch = MODE_RE.match(question)
    if switch:
        mode = MODE_WORDS.get(re.sub(r"\s+", " ", switch.group(1).lower()), "ask")
        conversation.set_mode(mode)
        return MODE_SAY[mode], model
    if RESET_RE.match(question):
        if conversation.pending and conversation.pending.get("kind") in ("approval", "running"):
            cancel_pending(conversation.pending, opener)
        conversation.set_pending(None)
        conversation.reset()
        rest = RESET_RE.sub("", question).strip(" ,.:;-")
        if not rest:
            return "Gut, neues Gespräch.", model
        question = rest
    prefix = ""
    if conversation.pending:
        try:
            prefix, reply = handle_pending(question, conversation.pending, conversation, opener, now, sleep, budget)
        except Exception:  # noqa: BLE001 - ein kaputter Merkzettel darf die Brille nicht blockieren
            conversation.set_pending(None)
            prefix, reply = "", None
        if reply is not None:
            return reply, model
    if not prefix and (WAIT_RE.match(question) or NOTHING_OPEN_RE.match(question)):
        return NOTHING_OPEN_TEXT, model
    confirmed = False
    if HOME_CONFIRM.get("q"):                     # Rueckfrage bei unklarem Schaltbefehl
        asked, HOME_CONFIRM_Q = HOME_CONFIRM.get("t", 0), HOME_CONFIRM.get("q")
        HOME_CONFIRM.clear()
        if now() - asked < CONFIRM_TTL and YES_RE.match(question):
            question, confirmed = HOME_CONFIRM_Q, True
        elif now() - asked < CONFIRM_TTL and NO_RE.match(question):
            LAST_ROUTE.update(name="selbst", kind="zuhause")
            return (prefix + "Jetzt: Gut, nichts geschaltet." if prefix else "Gut, nichts geschaltet."), model
    if WHY_RE.match(question) and LAST_HOME.get("q") and now() - LAST_HOME.get("t", 0) < WHY_TTL:
        LAST_ROUTE.update(name="selbst", kind="zuhause")
        said = "Verstanden hatte ich: „%s“ – %s %s." % (
            LAST_HOME["q"], ", ".join(LAST_HOME.get("devices") or ["?"]),
            ACTION_SAY.get(LAST_HOME.get("action"), LAST_HOME.get("action") or "?"))
        return (prefix + "Jetzt: " + said if prefix else said), model
    if not prefix:
        for pattern, reply in SMALLTALK:
            if pattern.match(question):
                LAST_ROUTE.update(name="selbst", kind="floskel")
                return reply, model
    kind = classify(question) if ROUTING else "nachschauen"
    LAST_ROUTE["kind"] = kind
    trace("classify", kind=kind, pending=bool(prefix))
    # Feste Wege laufen auch, wenn noch ein Hintergrund-Ergebnis da ist ("Vorhin: ... Jetzt: ...") -
    # sonst landete "Fernseher aus" nach einer langsamen Frage beim Agenten.
    joined = lambda text: (prefix + "Jetzt: " + text) if prefix else text
    if kind == "jetzt":
        LAST_ROUTE["name"] = "selbst"
        return joined(answer_now(question, now)), model
    if kind == "zuhause":
        LAST_ROUTE["name"] = "home-assistant"
        command = home_command(question)
        if command and command.get("unclear") and not confirmed:
            HOME_CONFIRM.update(q=question, t=now())
            text = "%s %s? Sag ja." % (", ".join(d["name"] for d in command["devices"]),
                                       ACTION_SAY.get(command["action"], command["action"]))
            return joined(text), model
        text = clean_for_glasses(answer_home(question) or "Das Gerät kenne ich nicht.")
        LAST_HOME.update(q=question, text=text, t=now(), devices=[d["name"] for d in (command or {}).get("devices", [])],
                         action=(command or {}).get("action"))
        conversation.add(question, text)
        return joined(text), model
    if kind == "server":
        LAST_ROUTE["name"] = "status"
        text = clean_for_glasses(answer_status(question))
        conversation.add(question, text)
        return joined(text), model
    if kind == "wetter":
        LAST_ROUTE["name"] = "open-meteo"
        text = clean_for_glasses(answer_weather(question))
        conversation.add(question, text)
        return joined(text), model
    if kind == "haus":
        LAST_ROUTE["name"] = "home-assistant"
        text = clean_for_glasses(answer_overview())
        conversation.add(question, text)
        return joined(text), model
    if kind in ("strompreis", "internet", "sonne", "teleskop", "aufgaben"):
        LAST_ROUTE["name"] = {"teleskop": "star-bridge", "aufgaben": "brain"}.get(kind, "home-assistant")
        text = clean_for_glasses(direct_text(kind, question, now))
        conversation.add(question, text)
        return joined(text), model
    if kind == "zucker":
        LAST_ROUTE["name"] = "home-assistant"
        text = clean_for_glasses(answer_sugar(now=now))
        conversation.add(question, text)
        return joined(text), model
    if kind == "netz":
        LAST_ROUTE["name"] = "arp-scan"
        text = clean_for_glasses(answer_lan(question))
        conversation.add(question, text)
        return joined(text), model
    if kind == "erinnern":
        LAST_ROUTE["name"] = "erinnerung"
        text = clean_for_glasses(answer_reminder(question, now=now))
        conversation.add(question, text)
        return joined(text), model
    if kind in ("strom", "einkauf"):
        LAST_ROUTE["name"] = "home-assistant"
        text = clean_for_glasses(answer_pv() if kind == "strom" else answer_shopping(question))
        conversation.add(question, text)
        return joined(text), model
    if kind in ("auto", "arbeit"):
        LAST_ROUTE["name"] = "home-assistant" if kind == "auto" else "zentrale"
        text = clean_for_glasses(answer_car(question) if kind == "auto" else answer_arbeit(question))
        conversation.add(question, text)
        return joined(text), model
    if kind == "agenten":
        LAST_ROUTE["name"] = "health"
        text = clean_for_glasses(answer_agents(question))
        conversation.add(question, text)
        return joined(text), model
    room = max(120, CHAR_BUDGET - len(prefix) - (7 if prefix else 0))
    turns = conversation.history()
    started = time.time()
    LAST_ROUTE["name"] = ""
    final = None
    mode = conversation.approval_mode()
    if kind == "tun" and TASK_MODEL:
        routes = task_routes(routes)
        task_mode = TASK_APPROVAL if TASK_APPROVAL in APPROVAL_MODES else "auto"
        if APPROVAL_MODES.index(task_mode) > APPROVAL_MODES.index(mode):
            mode = task_mode
    if kind == "nachschauen" and FAST_URL and FAST_FIRST:
        # Vorab das schnelle Modell (~1 s): kann es ohne Daten antworten, braucht es Hermes nicht. Passt die Frage zu
        # einer eigenen Datenquelle (anders formuliert, als die Regeln erkennen), nennt es nur deren Namen.
        early = {}
        profile = read_profile()
        labels = direct_labels()
        note = SYSTEM_EXTRA + ((" Was du ueber Alfred weisst: " + profile) if profile else "") + (
            (" Passt die Frage zu einer dieser Datenquellen, antworte NUR mit ihrem Namen: " +
             "; ".join("%s = %s" % (name, what) for name, (_, what) in labels.items()) + ".") if labels else ""
        ) + FAST_FIRST_NOTE

        def early_ask():
            try:
                early["text"] = ask(build_messages(question, turns, extra=note), model, routes=fast_routes(routes)[:1])
            except Exception:  # noqa: BLE001 - dann eben der Agent
                early["text"] = None
        worker = threading.Thread(target=early_ask, daemon=True)
        early_started = time.time()
        worker.start()
        worker.join(FAST_FIRST_WAIT)
        reply = early.get("text")
        label = re.sub(r"[^A-ZÄÖÜ]", "", (reply or "").strip().upper())
        if label in labels:
            direct_kind = labels[label][0]
            trace("vorab", ms=round((time.time() - early_started) * 1000), label=label)
            LAST_ROUTE.update(name="vorab:" + direct_kind, kind=direct_kind)
            text = clean_for_glasses(direct_text(direct_kind, question, now))
            conversation.add(question, text)
            return (prefix + "Jetzt: " + text if prefix else text), model
        needs_agent = not reply or AGENT_MARK in reply or not clean_for_glasses(reply)
        trace("vorab", ms=round((time.time() - early_started) * 1000), agent=needs_agent)
        if not needs_agent:
            final = reply
        else:
            budget = max(0.5, budget - (time.time() - early_started))
            LAST_ROUTE["name"] = ""
    if final is not None:
        pass
    elif kind == "wissen" and FAST_URL:
        fast = fast_routes(routes)
        profile = read_profile()
        extra = SYSTEM_EXTRA + ((" Was du ueber Alfred weisst: " + profile) if profile else "")
        result = ask_in_background(lambda: ask(build_messages(question, turns, extra=extra), model, routes=fast),
                                   conversation, question, budget, now)
        if result is None:
            text = BUSY_TEXT
        elif result[0] == "error":
            text = error_text(result[1])
        else:
            final = result[1]
    elif mode in ("mixed", "ask"):
        try:
            art, raw = ask_agent_runs(question, turns, model, conversation, opener, routes, now, sleep, budget)
        except Exception as error:  # noqa: BLE001
            art, raw = "error", error_text(error)
        if art == "final":
            final = raw
        else:
            text = raw
    else:
        chosen = {} if routes is None else {"routes": routes}
        result = ask_in_background(lambda: ask(build_messages(question, turns), model, **chosen),
                                   conversation, question, budget, now)
        if result is None:
            text = BUSY_TEXT
        elif result[0] == "error":
            text = error_text(result[1])
        else:
            final = result[1]
    if final is not None:
        text = clean_for_glasses(final, room)
        if not text:
            text = "Keine Antwort erhalten."
        else:
            conversation.add(question, text)
            log_content(question, turns, LAST_ROUTE["name"], text, time.time() - started)
    return (prefix + "Jetzt: " + text if prefix else text), model


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------

def _digest(value):
    return hashlib.sha256(value.encode("utf-8", "replace")).digest()


def authorised(header):
    return bool(TOKEN) and hmac.compare_digest(_digest(header or ""), _digest("Bearer " + TOKEN))


class Handler(BaseHTTPRequestHandler):
    server_version = "GlassAgent/1"
    last_request = None
    protocol_version = "HTTP/1.1"

    def _send(self, code, body):
        raw = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.path.split("?")[0] == "/health":
            pending = CONVERSATION.pending or {}
            self._send(200, {"ok": True, "upstream": bool(UPSTREAM_URL), "token": bool(TOKEN),
                             "approval": CONVERSATION.approval_mode(), "pending": pending.get("kind") or None})
            return
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path.split("?")[0] not in ("/", "/v1/chat/completions", "/chat/completions"):
            self._send(404, {"error": "not found"})
            return
        if not authorised(self.headers.get("Authorization")):
            self._send(401, {"error": {"message": "unauthorized", "type": "auth"}})
            return
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            self._send(413 if length > MAX_BODY else 400, {"error": {"message": "bad body"}})
            return
        try:
            body = json.loads(self.rfile.read(length).decode("utf-8", "replace"))
            if not isinstance(body, dict):
                raise ValueError
        except ValueError:
            self._send(400, {"error": {"message": "invalid json"}})
            return
        started = time.time()
        # Ohne Inhalte: wie die Even-App fragt (App-Version, Streaming, Felder) - fuer Aenderungen der App.
        sys.stderr.write("[glass-agent] Anfrage: ua=%s stream=%s accept=%s felder=%s\n"
                         % ((self.headers.get("User-Agent") or "-")[:60], body.get("stream"),
                            (self.headers.get("Accept") or "-")[:40], ",".join(sorted(body.keys()))[:120]))
        gap = started - Handler.last_request if Handler.last_request else None
        Handler.last_request = started
        trace_start()
        text, model = answer(body)
        record = {"t": time.strftime("%Y-%m-%d %H:%M:%S"), "id": _TRACE.id, "type": "anfrage",
                  "kind": LAST_ROUTE.get("kind") or "-", "route": LAST_ROUTE["name"] or "-",
                  "total_ms": round((time.time() - started) * 1000), "busy": text == BUSY_TEXT,
                  "gap_s": round(gap, 1) if gap is not None else None, "q_chars": len(last_user_text(body)),
                  "a_chars": len(text), "steps": _TRACE.steps}
        if TRACE_TEXT:
            record.update(q=last_user_text(body), a=text)
        sys.stderr.write("[glass-agent] App schickte %d Nachricht(en); frage %d Zeichen (Verlauf %d) -> antwort %d Zeichen"
                         " in %.1f s via %s (%s)\n"
                         % (len(body.get("messages") or []), len(last_user_text(body)), len(CONVERSATION.turns),
                            len(text), time.time() - started, LAST_ROUTE["name"] or "-", LAST_ROUTE.get("kind") or "-"))
        try:
            self._send(200, completion(text, model))
            record["sent"] = True
        except (BrokenPipeError, ConnectionResetError):
            record["sent"] = False
            sys.stderr.write("[glass-agent] Even-App hatte schon aufgegeben (Verbindung zu nach %.1f s)\n"
                             % (time.time() - started))
        _TRACE.steps = None
        trace_write(record)

    def log_message(self, *args):  # keine Pfade/Inhalte ins Log
        pass


# --------------------------------------------------------------------------
# Selbsttest
# --------------------------------------------------------------------------

def selftest():
    global APPROVAL_DEFAULT
    APPROVAL_DEFAULT = "auto"     # Selbsttest unabhaengig von GLASS_AGENT_APPROVAL
    ok = True

    def check(name, condition):
        nonlocal ok
        print(("OK   " if condition else "FEHL ") + name)
        ok = ok and condition

    md = "## Wetter\n**Morgen** wird es *sonnig* ☀️ 🌤\n- 18 Grad\n- kein Regen\n[Quelle](https://x.y)"
    out = clean_for_glasses(md)
    check("Markdown und Emojis raus", out == "Wetter Morgen wird es sonnig 18 Grad kein Regen Quelle")
    long = "Das ist ein Satz. " * 40
    cut = clean_for_glasses(long, 100)
    check("kuerzt am Satzende", len(cut) <= 100 and cut.endswith("."))
    cut2 = clean_for_glasses("wort " * 100, 50)
    check("kuerzt ohne Satzende mit …", len(cut2) <= 52 and cut2.endswith("…"))
    check("Text-Teile-Liste", last_user_text({"messages": [{"role": "user", "content": [{"type": "text", "text": "hi"}]}]}) == "hi")

    clock = [1000.0]
    conv = Conversation(ttl=300, max_turns=2, now=lambda: clock[0])
    seen = []

    def fake(messages, model):
        seen.append(messages)
        return "**Antwort** %d 😀" % len(seen)

    a1, _ = answer({"model": "openclaw", "messages": [{"role": "user", "content": "Wetter heute?"}]}, fake, conv)
    a2, _ = answer({"model": "openclaw", "messages": [{"role": "user", "content": "und morgen?"}]}, fake, conv)
    check("Antwort bereinigt", a1 == "Antwort 1")
    check("Rueckfrage bekommt Verlauf", [m["content"] for m in seen[1][1:]] == ["Wetter heute?", "Antwort 1", "und morgen?"])
    check("Systemtext vorn", seen[0][0]["role"] == "system" and "Datenbrille" in seen[0][0]["content"])
    clock[0] += 301
    answer({"messages": [{"role": "user", "content": "neu?"}]}, fake, conv)
    check("Verlauf verfaellt nach TTL", len(seen[2]) == 2)
    r, _ = answer({"messages": [{"role": "user", "content": "Neues Gespräch"}]}, fake, conv)
    check("Neues Gespraech setzt zurueck", r == "Gut, neues Gespräch." and conv.history() == [])
    answer({"messages": [{"role": "user", "content": "Neues Gespräch, wie wird das Wetter?"}]}, fake, conv)
    check("Reset mit Frage danach", seen[-1][-1]["content"] == "wie wird das Wetter?" and len(seen[-1]) == 2)
    for i in range(5):
        answer({"messages": [{"role": "user", "content": "f%d" % i}]}, fake, conv)
    check("max_turns begrenzt", len(conv.history()) == 2)

    import tempfile
    state = os.path.join(tempfile.mkdtemp(), "c.json")
    clock2 = [100.0]
    first = Conversation(ttl=300, now=lambda: clock2[0], path=state)
    first.add("Frage", "Antwort")
    second = Conversation(ttl=300, now=lambda: clock2[0], path=state)
    check("Verlauf uebersteht Neustart", second.history() == [("Frage", "Antwort")])
    check("Verlaufsdatei nur fuer Besitzer", os.name == "nt" or (os.stat(state).st_mode & 0o077) == 0)

    def boom(messages, model):
        raise urllib.error.URLError("weg")

    check("Fehler wird kurzer Text", answer({"messages": [{"role": "user", "content": "x"}]}, boom, Conversation())[0] == "Agent nicht erreichbar.")
    check("leere Frage", answer({"messages": []}, fake, Conversation())[0] == "Ich habe nichts verstanden.")
    class FakeResponse:
        def __init__(self, data):
            self.data = json.dumps(data).encode()

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return self.data

    calls = []

    def opener(request, timeout):
        body = json.loads(request.data)
        calls.append((request.full_url, body.get("provider"), body.get("model")))
        if body.get("provider") == "openai-codex":
            return FakeResponse({"choices": [{"message": {"content": "ChatGPT or Codex Subscription rejected this request"}}]})
        if body.get("provider") == "anthropic":
            raise urllib.error.HTTPError(request.full_url, 429, "busy", {}, None)
        return FakeResponse({"choices": [{"message": {"content": "Vom vLLM."}}]})

    routes = parse_routes("http://agent/v1/chat/completions", "k", "openai-codex", "gpt-6-luna",
                          "anthropic/claude-haiku-5-5; direct=http://spark:8000/v1/chat/completions#qwen")
    _resting.clear()
    t0 = [5000.0]
    got = ask_upstream([{"role": "user", "content": "x"}], "openclaw", opener, routes, now=lambda: t0[0])
    check("Ausweich-Kette landet beim vLLM",
          got == "Vom vLLM." and [c[1] or c[2] for c in calls] == ["openai-codex", "anthropic", "qwen"])
    calls.clear()
    ask_upstream([{"role": "user", "content": "x"}], "openclaw", opener, routes, now=lambda: t0[0])
    check("leere Kontingente werden uebersprungen", [c[2] for c in calls] == ["qwen"])
    t0[0] += COOLDOWN_S + 1
    calls.clear()
    ask_upstream([{"role": "user", "content": "x"}], "openclaw", opener, routes, now=lambda: t0[0])
    check("nach der Pause wieder der erste Weg", calls[0][1] == "openai-codex")
    check("direct ohne Schluessel und Anbieter",
          routes[2]["key"] == "" and routes[2]["provider"] == "" and routes[2]["model"] == "qwen")
    _resting.clear()

    def all_down(messages, model):
        raise RouteFailed("weg")

    check("alle Wege weg -> Hinweis", answer({"messages": [{"role": "user", "content": "x"}]}, all_down, Conversation())[0].startswith("Kein KI-Dienst"))

    # ---- Freigaben ueber die Runs-API (Hermes nachgebaut, kein Netz) ----
    class FakeHermes:
        def __init__(self, runs=True):
            self.runs, self.calls, self.runs_ok, self.n = {}, [], runs, 0

        def __call__(self, request, timeout):
            path = request.full_url.split("/v1", 1)[-1]
            body = json.loads(request.data) if request.data else {}
            self.calls.append((request.get_method(), path, body))
            if path == "/chat/completions":
                direct = DIRECT_NOTE in body["messages"][0]["content"]
                return FakeResponse({"choices": [{"message": {"content": "Chat " + ("direkt" if direct else "agent")}}]})
            if path == "/runs":
                if not self.runs_ok:
                    raise urllib.error.HTTPError(request.full_url, 404, "nf", {}, None)
                if body["input"] == "kaputt":
                    raise urllib.error.HTTPError(request.full_url, 500, "err", {}, None)
                self.n += 1
                rid = "run_%d" % self.n
                self.runs[rid] = {"input": body["input"], "body": body, "polls": 0, "approved": [],
                                  "denied": False, "stopped": False}
                return FakeResponse({"run_id": rid, "status": "started"})
            match = re.match(r"^/runs/(run_\d+)(?:/(approval|stop))?$", path)
            run = self.runs[match.group(1)]
            if match.group(2) == "approval":
                if body["choice"] == "deny":
                    run["denied"] = True
                else:
                    run["approved"].append(body.get("request_id"))
                return FakeResponse({"resolved": 1})
            if match.group(2) == "stop":
                run["stopped"] = True
                return FakeResponse({"status": "stopping"})
            run["polls"] += 1
            return FakeResponse(self.status(run))

        @staticmethod
        def status(run):
            text = run["input"]
            if run["denied"] or run["stopped"]:
                return {"status": "cancelled"}
            if text == "lies die notizen" and not run["approved"]:
                return {"status": "waiting_for_approval", "approval": {
                    "command": "cat ~/notizen.txt | head -5", "description": "Pfad ausserhalb des Arbeitsordners",
                    "pattern_key": "outside_workdir", "request_id": "r1"}}
            if text == "lies die notizen":
                return {"status": "completed", "output": "Inhalt gelesen."}
            if text == "schreib maria" and not run["approved"]:
                return {"status": "waiting_for_approval", "approval": {
                    "command": "<send_message> (plugin approval rule)",
                    "description": "an Maria schreiben: 'Komme 10 min später.'",
                    "pattern_key": "plugin_rule:send_message:ab12", "request_id": "r2"}}
            if text == "schreib maria":
                return {"status": "completed", "output": "Nachricht gesendet."}
            if text == "langsam":
                return {"status": "running"} if run["polls"] < 4 else {"status": "completed", "output": "Server laufen alle."}
            return {"status": "completed", "output": "Run: " + text}

    def say(text):
        return {"model": "openclaw", "messages": [{"role": "user", "content": text}]}

    clock3 = [10000.0]
    fnow = lambda: clock3[0]  # noqa: E731

    def fsleep(seconds):
        clock3[0] += seconds

    agent = parse_routes("http://agent/v1/chat/completions", "k", "", "", "direct=http://spark:8000/v1/chat/completions#qwen")
    hermes = FakeHermes()

    def run_answer(text, conv, routes=agent, opener=None, budget=2.0):
        return answer(say(text), conversation=conv, opener=opener or hermes, routes=routes, now=fnow,
                      sleep=fsleep, budget=budget)[0]

    state2 = os.path.join(tempfile.mkdtemp(), "c.json")
    conv = Conversation(path=state2, now=fnow)
    r = run_answer("Freigabe gemischt", conv)
    check("Sprachbefehl Freigabe gemischt", r == MODE_SAY["mixed"] and conv.approval_mode() == "mixed")
    check("Freigabe-Stufe uebersteht Neustart", Conversation(path=state2, now=fnow).approval_mode() == "mixed")
    check("Freigabe immer fragen", run_answer("Freigabe immer fragen.", Conversation(now=fnow)) == MODE_SAY["ask"])
    r = run_answer("lies die notizen", conv)
    check("mixed: lesender Befehl automatisch frei",
          r == "Inhalt gelesen." and hermes.runs["run_1"]["approved"] == ["r1"])
    check("Runs-Anfrage ohne 'openclaw' und mit Systemtext",
          "model" not in hermes.runs["run_1"]["body"] and "Datenbrille" in hermes.runs["run_1"]["body"]["instructions"])
    r = run_answer("schreib maria", conv)
    check("mixed: aendernde Aktion wird gefragt",
          r.startswith("Hermes will an Maria schreiben: 'Komme 10 min später.'") and r.endswith("Sag ja oder nein.")
          and conv.pending["kind"] == "approval" and "key" not in conv.pending["route"])
    check("offene Rueckfrage uebersteht Neustart", Conversation(path=state2, now=fnow).pending["run_id"] == "run_2")
    r = run_answer("Ja.", conv)
    check("ja -> freigegeben, Ergebnis da",
          r == "Nachricht gesendet." and hermes.runs["run_2"]["approved"] == ["r2"] and conv.pending is None
          and conv.history()[-1] == ("schreib maria", "Nachricht gesendet."))
    run_answer("schreib maria", conv)
    r = run_answer("nein", conv)
    check("nein -> abgelehnt und gestoppt",
          r.startswith("Abgebrochen") and hermes.runs["run_3"]["denied"] and hermes.runs["run_3"]["stopped"])
    run_answer("schreib maria", conv)
    r = run_answer("wie wird das wetter", conv)
    check("andere Frage -> Rueckfrage verfaellt, neue Frage beantwortet",
          hermes.runs["run_4"]["denied"] and r == "Run: wie wird das wetter")
    run_answer("schreib maria", conv)
    clock3[0] += APPROVAL_TTL + 1
    r = run_answer("ja", conv)
    check("nach 90 s gilt ja nicht mehr", hermes.runs["run_6"]["denied"] and r == "Run: ja")
    conv_ask = Conversation(now=fnow, mode="ask")
    r = run_answer("lies die notizen", conv_ask)
    check("ask: auch Lesen wird gefragt", r.startswith("Hermes will ausführen: cat") and r.endswith("Sag ja oder nein."))
    conv_ask.set_pending(None)
    r = run_answer("langsam", conv, budget=1.0)
    check("Run zu langsam -> 'noch dran', laeuft weiter", r == BUSY_TEXT and conv.pending["kind"] == "running")
    r = run_answer("und?", conv)
    check("'und?' liefert das Run-Ergebnis", r == "Server laufen alle." and conv.history()[-1][0] == "langsam")
    r = run_answer("kaputt", conv)
    check("Runs-Fehler -> direkter Weg mit Werkzeug-Hinweis", r == "Chat direkt")
    no_runs = FakeHermes(runs=False)
    _runs_off.clear()
    r1 = run_answer("was gibt es neues", conv, opener=no_runs)
    r2 = run_answer("was gibt es neues", conv, opener=no_runs)
    check("ohne Runs-API (404) -> Chat-Completions, gemerkt",
          r1 == r2 == "Chat agent" and [c[1] for c in no_runs.calls].count("/runs") == 1)
    _runs_off.clear()

    def ro(**kw):
        return is_read_only(dict({"description": ""}, **kw))
    check("Einstufung: lesen",
          ro(command="ls -la /srv && df -h") and ro(command="git status") and ro(command="cat a | grep -i x")
          and ro(command="<web_search> (plugin approval rule)", pattern_key="plugin_rule:web_search:1"))
    check("Einstufung: aendern/unklar = fragen",
          not ro(command="rm -rf /tmp/x") and not ro(command="cat a > b") and not ro(command="find . -delete")
          and not ro(command="git push") and not ro(command="ls $(rm x)") and not ro(command="sudo ls")
          and not ro(command="<send_message> x", pattern_key="plugin_rule:send_message:1")
          and not ro(command="<neues_tool> x", pattern_key="plugin_rule:neues_tool:1")
          and not ro(command="ls", smart_denied=True) and not ro(command="cat x", description="delete secrets")
          and not ro(command="python3 -c 'print(1)'", pattern_key="execute_code"))

    # ---- Hintergrund: Langsamkeit ist kein Grund zum Ausweichen ----
    gate = threading.Event()

    def slow(messages, model):
        gate.wait(5)
        return "**Spät**, aber da."

    def wait_for(conv_, kind):
        for _ in range(200):
            if (conv_.pending or {}).get("kind") == kind:
                return True
            time.sleep(0.01)
        return False

    conv_bg = Conversation()
    r = answer(say("Server prüfen"), slow, conv_bg, budget=0.2)[0]
    check("Budget um -> 'noch dran'", r == BUSY_TEXT and conv_bg.pending["kind"] == "background")
    gate.set()
    check("Ergebnis landet im Hintergrund", wait_for(conv_bg, "result"))
    r = answer(say("Und?"), slow, conv_bg, budget=0.2)[0]
    check("'und?' liefert Hintergrund-Ergebnis",
          r == "Spät, aber da." and conv_bg.history()[-1] == ("Server prüfen", "Spät, aber da.") and conv_bg.pending is None)
    gate.clear()
    answer(say("Server prüfen"), slow, conv_bg, budget=0.2)
    gate.set()
    wait_for(conv_bg, "result")
    r = answer(say("wie wird das wetter?"), fake, conv_bg, budget=1.0)[0]
    check("andere Frage -> Ergebnis kurz vorn, dann neue Antwort",
          r.startswith("Vorhin: Spät, aber da. Jetzt: Antwort") and conv_bg.history()[-2][0] == "Server prüfen")
    gate.clear()
    answer(say("Server prüfen"), slow, conv_bg, budget=0.2)
    gate.set()
    wait_for(conv_bg, "result")
    r = answer(say("wie spät ist es?"), fake, conv_bg, budget=1.0)[0]
    check("feste Wege laufen auch mit offenem Ergebnis",
          r.startswith("Vorhin: Spät, aber da. Jetzt: Es ist "))
    gate.clear()
    answer(say("Server prüfen"), slow, conv_bg, budget=0.2)
    threading.Timer(0.2, gate.set).start()
    r = answer(say("fertig?"), slow, conv_bg, budget=3.0)[0]
    check("'fertig?' wartet nochmal auf den laufenden Agenten", r == "Spät, aber da.")
    gate.clear()
    answer(say("Server prüfen"), slow, conv_bg, budget=0.2)
    threading.Timer(0.2, gate.set).start()
    r = answer(say("Ich warte immer noch auf deine Antwort."), slow, conv_bg, budget=3.0)[0]
    check("'ich warte noch' holt das Ergebnis wie 'und?'", r == "Spät, aber da.")
    asked = []
    r = answer(say("und?"), lambda m, model: asked.append(m) or "x", Conversation())[0]
    check("'und?' ohne offenen Vorgang -> ehrlicher Hinweis, Agent nicht gefragt", r == NOTHING_OPEN_TEXT and not asked)
    r = answer(say("Hallo?"), lambda m, model: asked.append(m) or "x", Conversation())[0]
    check("'Hallo?' ohne offenen Vorgang -> Hinweis", r == NOTHING_OPEN_TEXT and not asked)
    r = answer(say("weiter"), lambda m, model: asked.append(m) or "weiter gehts", Conversation(), budget=1.0)[0]
    check("'weiter' bleibt eine normale Aeusserung", r == "weiter gehts" and asked)

    # Routing nach Art der Frage
    kinds = {"Wie spät ist es?": "jetzt", "welcher Tag ist heute": "jetzt", "Wer bin ich?": "wissen",
             "Was ist die Hauptstadt von Australien?": "wissen", "Was steht heute an?": "nachschauen",
             "Wie wird das Wetter morgen?": "nachschauen", "Läuft der Server?": "nachschauen",
             "Schreib Maria, dass ich später komme": "tun", "Erinner mich um 8 an den Müll": "tun",
             "Kannst du den Drucker pausieren": "nachschauen", "Mach das Licht aus": "tun",
             "Erzähl mir einen Witz": "nachschauen"}
    wrong = {q: classify(q) for q, k in kinds.items() if classify(q) != k}
    check("Fragen werden richtig eingeordnet", not wrong)
    if wrong:
        print("     ", wrong)
    asked = []
    r = answer(say("Wie spät ist es?"), lambda m, model, **kw: asked.append(m) or "x", Conversation())[0]
    check("Uhrzeit beantwortet der Dienst selbst", re.match(r"^Es ist \d{1,2}:\d\d Uhr\.$", r) and not asked)
    saved = {k: globals()[k] for k in ("FAST_URL", "FAST_KEY", "FAST_MODEL", "TASK_MODEL", "TASK_APPROVAL", "PROFILE_FILE")}
    profile = os.path.join(tempfile.mkdtemp(), "USER.md")
    with open(profile, "w", encoding="utf-8") as handle:
        handle.write("Alfred baut Xaventra.\n§\nMag ehrliches Feedback.")
    globals().update(FAST_URL="http://schnell/v1/chat/completions", FAST_KEY="k", FAST_MODEL="flash",
                     TASK_MODEL="stark", TASK_APPROVAL="auto", PROFILE_FILE=profile)
    try:
        used = []

        def routed(messages, model, routes=None):
            used.append((routes or ROUTES)[0]["name"])
            used.append(messages[0]["content"])
            return "ok"
        answer(say("Wer bin ich?"), routed, Conversation(), budget=1.0)
        check("'wissen' geht zuerst an das schnelle Modell, mit Steckbrief",
              used[0] == "schnell:flash" and "Alfred baut Xaventra. Mag ehrliches Feedback." in used[1])
        used.clear()
        answer(say("Was steht heute an?"), routed, Conversation(), budget=1.0)
        check("'nachschauen' fragt erst vorab das schnelle Modell", used[0] == "schnell:flash")
        used.clear()
        answer(say("Schreib Maria eine Nachricht"), routed, Conversation(), budget=1.0)
        check("'tun' nimmt das staerkere Modell", used and used[0].endswith("stark"))
        used.clear()
        r = answer(say("Erzähl mir einen Witz"), routed, Conversation(), budget=1.0)[0]
        check("'nachschauen' ohne Stichwort: schnelles Modell vorab reicht", used[0] == "schnell:flash"
              and len(used) == 2 and r == "ok" and "AGENT" in used[1])
        used.clear()

        def needs_agent(messages, model, routes=None):
            used.append((routes or ROUTES)[0]["name"])
            return "AGENT" if used[-1] == "schnell:flash" else "Hermes weiss es."
        r = answer(say("Was denkst du über Salzburg"), needs_agent, Conversation(), budget=1.0)[0]
        check("schnelles Modell sagt AGENT -> weiter an den Agenten", used == ["schnell:flash", ROUTES[0]["name"]]
              and r == "Hermes weiss es.")
        check("ohne Steckbrief-Datei kein Fehler", read_profile("/gibt/es/nicht") == "")
        hosts = parse_status_sources("Pi5,pi,raspberry|http://pi/status;ns1,mail|http://ns1/status;"
                                     "Spark,gx10|http://spark/status")
        globals()["STATUS_HOSTS"] = hosts
        check("Server-Fragen erkannt", classify("Läuft der Server ns1?") == "server"
              and classify("Läuft NS eins?") == "server" and classify("Wie ist die Auslastung vom Pi?") == "server"
              and classify("Laufen alle Server?") == "server" and classify("Was läuft heute im Kino?") == "nachschauen"
              and classify("Starte den Server neu") == "tun" and classify("Wie geht es dem Pi?") == "server"
              and classify("Wie geht es dir?") != "server")
        check("Rechner aus der Frage", [h["name"] for h in status_targets("läuft n.s. 1 noch?", hosts)] == ["ns1"]
              and [h["name"] for h in status_targets("wie geht es dem Pi", hosts)] == ["Pi5"]
              and status_targets("Pinguine", hosts) == [])
        ns1 = {"name": "ns1", "metrics": [
            {"id": "cpu", "label": "CPU", "value": 2.4, "unit": "%", "warn": 85},
            {"id": "memory", "label": "RAM", "value": 36.7, "unit": "%", "warn": 85},
            {"id": "disk:/", "label": "/", "value": 56.3, "unit": "%", "warn": 90},
            {"id": "temp", "label": "Temp", "value": 46.5, "unit": "°C", "warn": 80},
            {"id": "freemem", "label": "Free", "value": 85.4, "unit": "GB", "warn": 2, "lowerIsWorse": True},
            {"id": "failed", "label": "Failed units", "value": 2, "warn": 1, "detail": "certbot, osm"},
            {"id": "tailscale", "label": "Tailscale", "state": "ok"},
            {"id": "uptime", "label": "Up", "value": 1788, "unit": "h"}]}

        class FakeStatus:
            def __init__(self, data):
                self.data = data

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self):
                return json.dumps(self.data).encode()

        def status_opener(request, timeout):
            if "spark" in request.full_url:
                raise urllib.error.URLError("weg")
            return FakeStatus(ns1 if "ns1" in request.full_url else {"name": "Pi5", "metrics": []})
        one = answer_status("Läuft ns1?", hosts, status_opener)
        check("ein Rechner: Werte und Warnungen",
              one == "ns1 läuft: CPU 2,4 %, RAM 37 %, Platte 56 %, 46 °C, seit 74 Tagen. "
                     "Achtung: 2 Dienste ausgefallen (certbot, osm).")
        every = answer_status("Laufen alle Server?", hosts, status_opener)
        check("alle Rechner: Kopf, Ausfall, Warnungen",
              every == "2 von 3 laufen, nicht erreichbar: Spark. ns1: 2 Dienste ausgefallen (certbot, osm).")
        check("Zentrale-Systemseite: ausgefallene Dienste, bald ablaufende Zertifikate",
              system_notes({"dienste": [{"name": "Brain", "ok": False}, {"name": "Cockpit", "ok": True},
                                        {"name": "Panoptes", "ok": False, "schlaeft": True}],
                            "zertifikate": [{"host": "a.at", "ok": True, "tage": 5},
                                            {"host": "b.at", "ok": True, "tage": 60}]})
              == ["Brain aus", "Zertifikat a.at noch 5 Tage"])
        globals()["STATUS_HOSTS"] = []
        check("ohne Status-Quellen keine Server-Art", classify("Läuft der Server ns1?") == "nachschauen")

        home_dir = tempfile.mkdtemp()
        with open(os.path.join(home_dir, "token"), "w", encoding="utf-8") as handle:
            handle.write("t")
        home_file = os.path.join(home_dir, "home.json")
        with open(home_file, "w", encoding="utf-8") as handle:
            json.dump({"ha_url": "http://ha:8123", "token_file": os.path.join(home_dir, "token"), "devices": [
                {"name": "Fernseher", "words": ["fernseher", "tv"], "kind": "tv",
                 "player": "media_player.tv", "remote": "remote.tv"},
                {"name": "Licht Wohnzimmer", "words": ["wohnzimmer"], "kind": "light", "entities": ["light.wz"]},
                {"name": "Licht Küche", "words": ["küche", "kueche"], "kind": "light", "entities": ["light.k"]},
                {"name": "Drucker", "words": ["drucker"], "kind": "switch", "entities": ["switch.drucker"],
                 "guard": "sensor.druck"},
                {"name": "Auto", "words": ["auto"], "kind": "switch", "entities": ["switch.surfmate_1_x"]},
                {"name": "Schloss", "words": ["tür"], "kind": "switch", "entities": ["lock.tuer"]}]}, handle)
        home = load_home(home_file)
        check("gesperrte Geraete fliegen raus", [d["name"] for d in home["devices"]]
              == ["Fernseher", "Licht Wohnzimmer", "Licht Küche", "Drucker"])
        cmd = lambda q: (lambda c: c and ([d["name"] for d in c["devices"]], c["action"], c["steps"]))(
            home_command(q, home))
        check("Befehle verstanden",
              cmd("Schalt den Fernseher ein") == (["Fernseher"], "on", 3)
              and cmd("Mach den Fernseher im Wohnzimmer aus") == (["Fernseher"], "off", 3)
              and cmd("Fernseher lauter") == (["Fernseher"], "up", 3)
              and cmd("TV viel leiser") == (["Fernseher"], "down", 6)
              and cmd("Fernseher 2 lauter") == (["Fernseher"], "up", 2)
              and cmd("Fernseher Ton aus") == (["Fernseher"], "mute", 3)
              and cmd("Licht im Wohnzimmer an") == (["Licht Wohnzimmer"], "on", 3)
              and cmd("Mach alle Lichter aus") == (["Licht Wohnzimmer", "Licht Küche"], "off", 3)
              and cmd("Ist der Fernseher an?") == (["Fernseher"], "status", 3)
              and cmd("Wohnzimmer lauter") is None and cmd("Wie wird das Wetter?") is None
              and cmd("Mach das Auto an") is None
              and cmd("Starte Netflix") == (["Fernseher"], "app", 1)
              and cmd("Mach YouTube am Fernseher an") == (["Fernseher"], "app", 1)
              and cmd("Fernseher Spotify") == (["Fernseher"], "app", 1)
              and cmd("Was gibt es Neues auf Netflix?") is None
              and cmd("Fernseher aus, Netflix nervt") == (["Fernseher"], "off", 3)
              and cmd("Sind die Lichter an?") == (["Licht Wohnzimmer", "Licht Küche"], "status", 3)
              and cmd("Und der Radiodrucker?") == (["Drucker"], "status", 3)
              and cmd("3D-Drucker, okay.") == (["Drucker"], "status", 3)
              and cmd("Wie lange braucht der Drucker noch für das Teil?") is None)
        states = {"remote.tv": "off", "light.wz": "off", "light.k": "on", "sensor.druck": "printing"}
        posted = []

        def ha_opener(request, timeout):
            path = request.full_url.split("8123", 1)[1]
            if request.get_method() == "POST":
                body = json.loads(request.data)
                posted.append((path, body))
                ids = body["entity_id"] if isinstance(body["entity_id"], list) else [body["entity_id"]]
                for entity in ids:
                    target = entity.replace("media_player.", "remote.")
                    if path.endswith("turn_on"):
                        states[target] = "on"
                        if body.get("activity") != "com.nicht.da":
                            states[target + ":app"] = body.get("activity")
                    if path.endswith("turn_off"):
                        states[target] = "off"
                return FakeStatus([])
            entity = path.rsplit("/", 1)[1]
            return FakeStatus({"state": states.get(entity, "unknown"),
                               "attributes": {"current_activity": states.get(entity + ":app")}})
        nosleep = lambda s: None
        r = answer_home("Schalt den Fernseher ein", home, ha_opener, nosleep)
        check("Fernseher an: Fernbedienung turn_on und zurueckgelesen",
              r == "Fernseher ist an." and posted[-1] == ("/api/services/remote/turn_on",
                                                          {"entity_id": "remote.tv"}))
        r = answer_home("Starte Netflix", home, ha_opener, nosleep)
        check("App starten = remote.turn_on mit activity, zurueckgelesen",
              r == "Netflix läuft am Fernseher." and posted[-1] == (
                  "/api/services/remote/turn_on", {"entity_id": "remote.tv", "activity": "com.netflix.ninja"}))
        home["devices"][0]["apps"] = {"orf": "com.nicht.da"}
        r = answer_home("Öffne ORF am Fernseher", home, ha_opener, nosleep)
        for _ in range(100):                      # Nachpruefung laeuft im Hintergrund weiter
            if HOME_WARNINGS:
                break
            time.sleep(0.01)
        check("eigene App; sofort 'wird gestartet', Warnung kommt vor die naechste Antwort",
              r == "Orf wird am Fernseher gestartet." and posted[-1][1]["activity"] == "com.nicht.da"
              and take_warnings() == "Achtung: Orf ist am Fernseher nicht gestartet (installiert?).")
        r = answer_home("Fernseher 2 lauter", home, ha_opener, nosleep)
        check("lauter = Tastendruck mit Wiederholung", r == "Fernseher 2× lauter." and posted[-1] == (
            "/api/services/remote/send_command", {"entity_id": "remote.tv", "num_repeats": 2, "command": "VOLUME_UP"}))
        r = answer_home("Alle Lichter aus", home, ha_opener, nosleep)
        check("alle Lichter aus", r == "Licht Wohnzimmer ist aus. Licht Küche ist aus.")
        r = answer_home("Drucker aus", home, ha_opener, nosleep)
        check("Drucker-Steckdose bleibt beim Drucken an", r.startswith("Drucker bleibt an") and
              not posted[-1][1].get("entity_id") == ["switch.drucker"])
        r = answer_home("Ist der Fernseher an?", home, ha_opener, nosleep)
        check("Zustand fragen", r == "Fernseher ist an.")
        trace_start()
        answer_home("Fernseher aus", home, ha_opener, nosleep)
        whats = [step["what"] for step in _TRACE.steps]
        check("Zeitprotokoll: Befehl, HA-Aufrufe mit Dauer, Zuruecklesen",
              whats[0] == "command" and "ha" in whats and whats[-1] == "readback"
              and all("ms" in step for step in _TRACE.steps if step["what"] == "ha"))
        trace_file = os.path.join(home_dir, "trace.jsonl")
        globals()["TRACE_FILE"] = trace_file
        trace_write({"type": "anfrage", "kind": "zuhause", "total_ms": 300, "steps": _TRACE.steps})
        _TRACE.steps = None
        report = trace_report(trace_file)
        check("Auswertung", "zuhause/off" in report and "POST /api/services/remote/turn_off" in report)

        def st(state, **attrs):
            return {"state": state, "attributes": attrs}
        world = {"sensor.nas_cpu_auslastung_gesamt": st("5"), "sensor.nas_speichernutzung_real": st("33"),
                 "sensor.nas_volume_1_volume_nutzung": st("68.3"), "sensor.nas_volume_1_status": st("normal"),
                 "sensor.nas_temperatur": st("52"), "sensor.nas_drive_1_status": st("normal"),
                 "sensor.nas_drive_2_status": st("normal"), "update.nas_dsm_update": st("off"),
                 "binary_sensor.nas_drive_1_max_fehlerhafte_sektoren_uberschritten": st("off"),
                 "switch.drucker": st("on"), "sensor.k1_current_print_state": st("printing"),
                 "sensor.k1_progress": st("63"), "sensor.k1_print_time_left": st("1.34"),
                 "sensor.k1_filename": st("halter_v2.gcode"), "sensor.k1_extruder_temperature": st("220.4"),
                 "sensor.k1_bed_temperature": st("60")}
        nas_dev = {"name": "NAS", "kind": "nas", "prefix": "sensor.nas_"}
        check("NAS: Werte und Platten", nas_summary(nas_dev, world) ==
              "NAS läuft: CPU 5 %, RAM 33 %, Volume 1 68 % belegt, 52 °C. 2 Platten normal.")
        world["sensor.nas_drive_2_status"] = st("crashed")
        check("NAS: kaputte Platte faellt auf", "Achtung: drive 2 status" in nas_summary(nas_dev, world))
        printer = {"name": "Drucker", "kind": "switch", "entities": ["switch.drucker"], "printer": "k1"}
        check("Drucker druckt: Fortschritt, Restzeit, Temperaturen", printer_summary(printer, world) ==
              "Drucker druckt halter_v2, 63 %, noch 1 h 20 min. Düse 220 °C, Bett 60 °C.")
        world["switch.drucker"] = st("off")
        check("Drucker aus", printer_summary(printer, world) == "Drucker ist aus.")
        home["devices"].append(dict(nas_dev, words=["nas", "meiner nass"]))
        check("NAS nur lesen", cmd("Wie geht's meiner Nass?") == (["NAS"], "status", 1)
              and cmd("Starte die NAS neu") == (["NAS"], "denied", 1) and cmd("NAS aus") == (["NAS"], "denied", 1))
        check("Floskeln sofort, ohne Modell", answer(say("Danke."), lambda *a, **k: "Modell", Conversation())[0] == "Gern."
              and answer(say("Servus"), lambda *a, **k: "Modell", Conversation())[0] == "Servus, Alfred."
              and answer(say("Danke für den Tipp mit Wien"), lambda *a, **k: "Modell", Conversation(), budget=1.0)[0]
              != "Gern.")
        scan_out = ("192.168.0.1\t02:00:00:00:00:01\t(Unknown: locally administered)\n"
                    "192.168.0.30\t02:00:00:00:00:02 (02:00:00:00:00:01)\tSynology Incorporated\n"
                    "192.168.0.45\t02:00:00:00:00:03\tApple, Inc.\n"
                    "192.168.0.46\t02:00:00:00:00:04\tApple, Inc.\n")
        lan_home = dict(home, lan={"iface": "wlan0", "names": {"02:00:00:00:00:01": "Router",
                                                                "02:00:00:00:00:02": "NAS"}})
        lan_file = os.path.join(home_dir, "lan_seen.json")
        argv_seen = []
        r1 = answer_lan("Welche Geräte sind im WLAN?", lan_home, lambda argv: argv_seen.append(argv) or scan_out,
                        path=lan_file)
        check("Netz: bekannte Namen, Hersteller gezaehlt, feste Argumente",
              r1 == "4 Geräte im Netz: NAS, Router, 2× Apple-Gerät." and argv_seen[0][:4] == ["sudo", "-n", "arp-scan", "-I"])
        r2 = answer_lan("Welche Geräte sind im WLAN?", lan_home,
                        lambda argv: scan_out + "192.168.0.99\taa:bb:cc:dd:ee:ff\t(Unknown)\n", path=lan_file)
        check("Netz: neues Geraet faellt auf", r2.endswith("Neu: unbekannt (192.168.0.99)."))
        check("Netz: Schnittstellenname wird geprueft", lan_scan("wlan0; rm -rf /", lambda a: "") is None)
        sugar_home = dict(home, sugar={"value": "sensor.g", "delta": "sensor.gd", "trend": "sensor.gt", "time": "sensor.gz"})
        stamp = time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime(time.time() - 240))
        sugar_world = [{"entity_id": "sensor.g", "state": "218", "attributes": {"unit_of_measurement": "mg/dL"}},
                       {"entity_id": "sensor.gd", "state": "-3"}, {"entity_id": "sensor.gt", "state": "gleichbleibend"},
                       {"entity_id": "sensor.gz", "state": stamp}]
        check("Blutzucker: Wert, Tendenz, Alter", answer_sugar(sugar_home, lambda r, timeout: FakeStatus(sugar_world))
              == "Blutzucker 218 mg/dL, gleichbleibend (-3), vor 4 min.")
        sugar_world[0]["state"] = "62"
        check("Blutzucker niedrig: Warnung vorn", answer_sugar(sugar_home, lambda r, timeout: FakeStatus(sugar_world))
              .startswith("Achtung, niedrig! Blutzucker 62 mg/dL"))
        globals()["HOME"], real_home_su = sugar_home, HOME
        LAST_HOME.pop("sugar_t", None)
        first = classify("Wir sind beim Blutzucker gerade.")
        LAST_HOME["sugar_t"] = time.time()
        check("Blutzucker-Fragen, auch 'wie ist er gerade' danach", first == "zucker"
              and classify("Ich möchte wissen, wie er gerade ist.") == "zucker")
        LAST_HOME.pop("sugar_t", None)
        check("ohne vorherige Zuckerfrage kein Zucker", classify("Ich möchte wissen, wie er gerade ist.") != "zucker")
        globals()["HOME"] = real_home_su
        ten = dict(home, spot={"current": "sensor.sc", "cheapest": "sensor.sch", "cheapest_hour": "sensor.sh",
                                "average": "sensor.sa"},
                   internet={"download": "sensor.d", "upload": "sensor.u", "latency": "sensor.l"},
                   env={"warnings": "sensor.w", "uv": "sensor.uv", "air": "sensor.air",
                        "pollen": {"Birke": "sensor.birke"}},
                   system={"backup": "sensor.bk", "tailnet": ["binary_sensor.panel"]})
        ten_world = [{"entity_id": "sensor.sc", "state": "23.62"}, {"entity_id": "sensor.sch", "state": "23.22"},
                     {"entity_id": "sensor.sh", "state": "02:00"}, {"entity_id": "sensor.sa", "state": "30.96"},
                     {"entity_id": "sensor.d", "state": "389.6", "last_updated": "2026-10-28T20:00:00+00:00"},
                     {"entity_id": "sensor.u", "state": "47.6"}, {"entity_id": "sensor.l", "state": "19"},
                     {"entity_id": "sensor.w", "state": "1"}, {"entity_id": "sensor.uv", "state": "Hoch"},
                     {"entity_id": "sensor.air", "state": "31"}, {"entity_id": "sensor.birke", "state": "35"},
                     {"entity_id": "sensor.bk", "state": "2026-10-20T02:30:13+00:00"},
                     {"entity_id": "binary_sensor.panel", "state": "off", "attributes": {"friendly_name": "Wandpanel"}}]
        ten_open = lambda r, timeout: FakeStatus(ten_world)
        check("Strompreis", answer_price(ten, ten_open) ==
              "Strom jetzt 23,6 ct/kWh, am billigsten um 02:00 (23,2 ct), Schnitt 31 ct.")
        check("Internet", answer_internet(ten, ten_open).startswith("Internet: 390 Mbit/s runter, 48 hoch, 19 ms"))
        check("Umwelt nur wenn auffaellig", environment_notes(ten, ten_open) ==
              ["Achtung: 1 Unwetterwarnung", "UV hoch", "Pollen: Birke"])
        check("Backup alt, Tailnet-Geraet offline", ha_system_notes(ten, ten_open, lambda: 1793224000.0) ==
              ["letzte Home-Assistant-Sicherung älter als 2 Tage", "offline: Wandpanel"])
        star = {"online": True, "sequence": {"state": "läuft", "target": "M31", "frame": 12, "frames": 40},
                "exposure": {"active": True, "total": 300, "remaining": 120.4},
                "guider": {"connected": True, "guiding": True, "rms": 0.62},
                "camera": {"connected": True, "temp": -10}, "mount": {"connected": True, "flipMinutes": 25},
                "safety": {"connected": True, "safe": True}}
        check("Teleskop", answer_star("http://pc:8460", lambda r, timeout: FakeStatus(star)) ==
              'N.I.N.A. läuft: Ziel M31, Bild 12 von 40, belichtet 300s, noch 120s, Guiding RMS 0,6", '
              "Kamera -10 °C, Meridian-Flip in 25 min.")
        check("Teleskop aus", answer_star("http://pc:8460", lambda r, timeout: (_ for _ in ()).throw(
            urllib.error.URLError("weg"))).startswith("Die Teleskop-Brücke antwortet nicht"))
        tasks = {"tasks": [{"title": "x"}, {"title": "Echo conformance task"},
                           {"title": "Rechnung an Bricks schicken", "assigned_to": "NOVA", "priority": "high"}]}
        check("Aufgaben ohne Testmuell", answer_tasks("http://os/tasks", lambda r, timeout: FakeStatus(tasks)) ==
              "1 offen: Rechnung an Bricks schicken (NOVA).")
        dim_cmd = home_command("Licht Küche 30 Prozent", home)
        warm_cmd = home_command("Mach das Licht im Wohnzimmer wärmer", home)
        check("Dimmen und Lichtfarbe", dim_cmd["action"] == "dim" and dim_cmd["level"] == 30
              and warm_cmd["action"] == "dim" and warm_cmd["kelvin"] == 2700
              and home_command("Licht Küche dunkler", home)["step"] == -25)
        dim_posts = []

        def dim_opener(request, timeout):
            dim_posts.append((request.full_url.split("8123", 1)[1], json.loads(request.data)))
            return FakeStatus([])
        r = answer_home("Licht Küche 30 Prozent", home, dim_opener, nosleep)
        check("Dimmen schickt brightness_pct", r == "Licht Küche auf 30 %." and dim_posts[-1] == (
            "/api/services/light/turn_on", {"entity_id": ["light.k"], "brightness_pct": 30}))
        party_home = dict(home, devices=home["devices"] + [{"name": "Drucker-Party", "kind": "script",
                                                            "script": "script.drucker_party",
                                                            "words": ["drucker party", "party"]}])
        r = answer_home("Starte die Drucker Party", party_home, dim_opener, nosleep)
        check("Skript starten", r == "Drucker-Party gestartet." and dim_posts[-1] == (
            "/api/services/script/turn_on", {"entity_id": "script.drucker_party"}))
        check("Weckwort faellt weg", WAKE_RE.sub("", "Hey Ivan, WLAN Fernseher aus.").strip() == "WLAN Fernseher aus."
              and WAKE_RE.sub("", "Hey, wie geht's?") == "Hey, wie geht's?")
        LAST_HOME.clear()
        check("'Schmeiß das an' ohne vorheriges Geraet: nichts", cmd("Schmeiß mir das an") is None)
        LAST_HOME.update(devices=["Fernseher"], t=time.time(), q="Fernseher aus", action="off")
        check("'Schmeiß das an' meint das zuletzt geschaltete Geraet",
              cmd("Schmeiß mir das an") == (["Fernseher"], "on", 3))
        check("unklarer Schaltbefehl wird markiert, klarer nicht",
              home_command("WLAN Fernseher Alfred aus.", home)["unclear"]
              and not home_command("Kannst du bitte den Fernseher im Wohnzimmer ausschalten", home)["unclear"])
        HOME_CONFIRM.update(q="WLAN Fernseher Alfred aus.", t=time.time())
        r = answer(say("Nein"), lambda *a, **k: "erfunden", Conversation())[0]
        check("Rueckfrage mit 'nein' beantwortet: nichts geschaltet", r == "Gut, nichts geschaltet." and not HOME_CONFIRM)
        real_home, real_answer_home = HOME, answer_home
        globals().update(HOME=home, answer_home=lambda q, *a, **k: "geschaltet: " + q)
        try:
            r1 = answer(say("WLAN Fernseher Alfred aus."), lambda *a, **k: "erfunden", Conversation())[0]
            r2 = answer(say("Ja"), lambda *a, **k: "erfunden", Conversation())[0]
        finally:
            globals().update(HOME=real_home, answer_home=real_answer_home)
        check("unklar -> Rueckfrage, 'ja' -> erst dann geschaltet",
              r1 == "Fernseher ausschalten? Sag ja." and r2 == "geschaltet: WLAN Fernseher Alfred aus.")
        LAST_HOME.update(devices=["Fernseher"], t=time.time(), q="Fernseher aus", action="off")
        r = answer(say("Wieso?"), lambda *a, **k: "erfunden", Conversation())[0]
        check("'Wieso?' nach einem Befehl: sagt, was verstanden wurde (kein Modell)",
              r == "Verstanden hatte ich: „Fernseher aus“ – Fernseher ausschalten.")
        LAST_HOME.clear()
        import io
        busy = _http_failed(urllib.error.HTTPError("http://h", 429, "x", {}, io.BytesIO(
            b'{"error": {"message": "Too many concurrent runs (max 1)"}}')))
        quota = _http_failed(urllib.error.HTTPError("http://h", 429, "x", {}, io.BytesIO(b"rate limit")))
        class Stream:
            headers = {"Content-Type": "text/event-stream"}

            def __init__(self, lines, delay=0.0):
                self.lines, self.delay, self.closed = list(lines), delay, False

            def __enter__(self):
                return self

            def __exit__(self, *args):
                self.closed = True
                return False

            def readline(self):
                time.sleep(self.delay)
                return (self.lines.pop(0) + "\n").encode() if self.lines else b""
        hermes = {"name": "hermes", "url": "http://h/v1/chat/completions", "key": "", "provider": "", "model": "m"}
        good = Stream(['data: {"choices":[{"delta":{"content":"Hal"}}]}', ": ping",
                       'data: {"choices":[{"delta":{"content":"lo."}}]}', "data: [DONE]"])
        sent = []
        check("Hermes gestreamt: Teile zusammengesetzt", ask_route(
            hermes, [{"role": "user", "content": "x"}], "m",
            lambda request, timeout: sent.append(json.loads(request.data)) or good) == "Hallo." and sent[0]["stream"])
        slow_stream = Stream(['data: {"choices":[{"delta":{"content":"."}}]}'] * 50, delay=0.02)
        globals()["AGENT_MAX_S"], saved_max = 0.1, AGENT_MAX_S
        try:
            ask_route(hermes, [{"role": "user", "content": "x"}], "m", lambda request, timeout: slow_stream)
            stopped = False
        except RouteFailed:
            stopped = True
        globals()["AGENT_MAX_S"] = saved_max
        check("zu langer Hermes-Lauf: Verbindung zu (Hermes bricht ab)", stopped and slow_stream.closed)
        check("Hermes-429 'concurrent' = beschaeftigt, keine 15-min-Pause", busy.busy and not busy.rest
              and quota.rest and not quota.busy and error_text(busy).startswith("Hermes ist noch"))

        class Health:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        def health_opener(request, timeout):
            if "brutus" in request.full_url:
                raise urllib.error.URLError("weg")
            return Health()
        agents = parse_status_sources("Nova,hermes|http://pi/health;Brutus|http://brutus/health")
        globals()["AGENT_HOSTS"] = agents
        check("Agenten-Fragen erkannt", classify("Wie geht's den ganzen Agents?") == "agenten"
              and classify("Läuft Brutus?") == "agenten" and classify("Was ist ein Agent?") != "agenten")
        check("Agenten: einer fehlt", answer_agents("Wie geht's den Agents?", agents, health_opener)
              == "1 von 2 laufen, keine Antwort von: Brutus.")
        check("Agenten: einer genannt", answer_agents("Läuft Nova?", agents, health_opener) == "Nova läuft.")
        globals()["AGENT_HOSTS"] = []

        meteo = {"current": {"time": "2026-10-28T21:30", "temperature_2m": 10.1, "weather_code": 61},
                 "hourly": {"time": ["2026-10-28T21:00", "2026-10-28T22:00", "2026-10-28T23:00", "2026-10-29T00:00"],
                            "precipitation_probability": [80, 60, 40, 10]},
                 "daily": {"temperature_2m_min": [6, 4.4], "temperature_2m_max": [12.4, 11.6],
                           "precipitation_probability_max": [90, 30], "weather_code": [63, 3]}}
        fresh = time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime())
        tracked = {"zone.home": {"state": "1", "attributes": {"latitude": 47.81, "longitude": 13.04}},
                   "device_tracker.handy": {"state": "not_home", "last_updated": fresh,
                                            "attributes": {"latitude": 48.21, "longitude": 16.37}}}
        asked_urls = []

        def weather_opener(request, timeout):
            asked_urls.append(request.full_url)
            if "open-meteo" in request.full_url:
                return FakeStatus(meteo)
            return FakeStatus(tracked.get(request.full_url.rsplit("/", 1)[1], {}))
        wx_home = dict(home, tracker="device_tracker.handy")
        r = answer_weather("Wie wird das Wetter?", wx_home, weather_opener)
        check("Wetter am frischen Handy-Standort", r == "Jetzt bei dir (252 km von daheim) 10 °C, leichter Regen. Regen in den nächsten 3 Stunden bis 80 %. "
                   "Heute bis 12 °C."
              and "latitude=48.210" in asked_urls[-1])
        tracked["device_tracker.handy"]["last_updated"] = "2026-10-23T08:53:00+00:00"
        r = answer_weather("Wie wird das Wetter morgen?", wx_home, weather_opener)
        check("alter Standort -> daheim; morgen", r == "Morgen daheim: 4 bis 12 °C, bewölkt, Regen 30 %.")
        globals()["HOME"], real_home_wx = home, HOME
        check("Wetterfragen erkannt", classify("Brauch ich einen Schirm?") == "wetter"
              and classify("Wie wird das Wetter morgen?") == "wetter" and classify("Wie kalt ist es draußen?") == "wetter")
        globals()["HOME"] = real_home_wx

        car_home = dict(home, car={"name": "Auto", "soc": "sensor.soc", "range": "sensor.range",
                                   "lock": "binary_sensor.lock", "charging": "binary_sensor.charging",
                                   "location": "device_tracker.car",
                                   "open_pattern": r"binary_sensor\.car_(door|window|trunk|hood)"})
        car_world = [{"entity_id": "sensor.soc", "state": "99.0", "last_updated": fresh},
                     {"entity_id": "sensor.range", "state": "308"},
                     {"entity_id": "binary_sensor.lock", "state": "off"},
                     {"entity_id": "binary_sensor.charging", "state": "off"},
                     {"entity_id": "binary_sensor.car_door_front_left", "state": "off"},
                     {"entity_id": "binary_sensor.car_window_front_left", "state": "off"},
                     {"entity_id": "zone.home", "state": "1", "attributes": {"latitude": 47.81, "longitude": 13.04}},
                     {"entity_id": "device_tracker.car", "state": "not_home",
                      "attributes": {"latitude": 47.81, "longitude": 13.041}}]
        car_posts = []

        def car_opener(request, timeout):
            if request.get_method() == "POST":
                car_posts.append(request.full_url)
            return FakeStatus(car_world)
        check("Auto lesen: Akku, Reichweite, verriegelt, zu, daheim",
              answer_car("Wie voll ist das Auto?", car_home, car_opener) ==
              "Auto: 99 %, 308 km, verriegelt, alles zu, daheim.")
        car_world[2]["state"], car_world[4]["state"] = "on", "on"
        check("offenes Auto faellt auf", "OFFEN (nicht verriegelt)" in answer_car("Ist das Auto zu?", car_home, car_opener)
              and "offen: Tür" in answer_car("Ist das Auto zu?", car_home, car_opener))
        check("Auto steuern: abgelehnt, nichts geschickt",
              answer_car("Sperr das Auto zu", car_home, car_opener).startswith("Das Auto steuere ich nicht")
              and answer_car("Mach das Auto auf", car_home, car_opener).startswith("Das Auto steuere ich nicht")
              and not car_posts)
        over_world = [{"entity_id": "remote.tv", "state": "on"}, {"entity_id": "light.wz", "state": "off"},
                      {"entity_id": "light.k", "state": "unavailable"}, {"entity_id": "switch.drucker", "state": "off"}]
        check("Haus-Ueberblick mit einem Aufruf", answer_overview(
            dict(home, devices=[d for d in home["devices"] if d.get("kind") != "nas"]),
            lambda r, timeout: FakeStatus(over_world)) ==
            "Home Assistant läuft. An: Fernseher. Rest aus. Nicht erreichbar: Licht Küche.")
        pv_home = dict(home, pv={"now": "sensor.pv_now", "today": "sensor.pv_today", "tomorrow": "sensor.pv_tomorrow",
                                 "surplus_today": "sensor.pv_surplus_today", "surplus_km": "sensor.pv_surplus_km"},
                       shopping="todo.liste", holidays="calendar.feiertage")
        pv_world = [{"entity_id": "sensor.pv_now", "state": "0"}, {"entity_id": "sensor.pv_today", "state": "5.07"},
                    {"entity_id": "sensor.pv_tomorrow", "state": "6.94"},
                    {"entity_id": "sensor.pv_surplus_today", "state": "1.94"},
                    {"entity_id": "sensor.pv_surplus_km", "state": "11.9"}]
        check("PV aus Home Assistant", answer_pv(pv_home, lambda r, timeout: FakeStatus(pv_world)) ==
              "PV jetzt 0 W, heute 5,1 kWh, morgen erwartet 6,9 kWh. Überschuss heute 1,9 kWh (etwa 12 km fürs Auto).")
        shop_calls = []

        def shop_opener(request, timeout):
            shop_calls.append((request.full_url.split("8123", 1)[1], json.loads(request.data)))
            return FakeStatus({"service_response": {"todo.liste": {"items": [{"summary": "Milch"}, {"summary": "Brot"}]}}})
        check("Einkaufsliste vorlesen", answer_shopping("Was steht auf der Einkaufsliste?", pv_home, shop_opener)
              == "Auf der Einkaufsliste (2): Milch, Brot." and shop_calls[-1][0].startswith("/api/services/todo/get_items"))
        check("Einkaufsliste: Eintrag dazu", answer_shopping("Schreib noch Hafermilch auf die Einkaufsliste", pv_home,
                                                            shop_opener) == "Hafermilch steht auf der Einkaufsliste."
              and shop_calls[-1] == ("/api/services/todo/add_item", {"entity_id": "todo.liste", "item": "Hafermilch"}))
        soon = time.strftime("%Y-%m-%d 00:00:00", time.localtime(time.time() + 3 * 86400))
        holiday = next_holiday(pv_home, lambda r, timeout: FakeStatus(
            {"state": "off", "attributes": {"message": "Allerheiligen", "start_time": soon}}))
        check("Feiertag in den naechsten Tagen", holiday.startswith("Feiertag ") and holiday.endswith(": Allerheiligen"))
        globals()["HOME"] = pv_home
        check("PV- und Einkaufsfragen erkannt", classify("Wie viel Strom hat die PV heute gemacht?") == "strom"
              and classify("Schreib Milch auf die Einkaufsliste") == "einkauf"
              and classify("Was steht auf der Einkaufsliste?") == "einkauf")
        real_direct = direct_text
        globals()["direct_text"] = lambda kind, q, now=time.time: "direkt:" + kind
        try:
            r = answer(say("Lohnt sich heute die Sonne fürs Dach?"), lambda m, model, routes=None: "STROM",
                       Conversation(), budget=1.0)[0]
        finally:
            globals()["direct_text"] = real_direct
        check("schnelles Modell waehlt eine eigene Datenquelle -> direkt, kein Hermes", r == "direkt:strom")
        car_world[2]["state"], car_world[4]["state"] = "off", "off"
        globals().update(GEOCODER_URL="http://geo/api/", ROUTER_URL="http://valhalla")

        def trip_opener(request, timeout):
            if request.full_url.startswith("http://geo/"):
                return FakeStatus({"features": [{"geometry": {"coordinates": [16.37, 48.21]},
                                                 "properties": {"name": "Wien"}}]})
            if request.full_url.startswith("http://valhalla/route"):
                return FakeStatus({"trip": {"summary": {"length": 298.4, "time": 3 * 3600 + 600}}})
            return FakeStatus(car_world)
        check("Reicht es bis Wien? (308 km Reichweite, 298 km Strecke = knapp)",
              answer_car("Hab ich genug Saft für eine Fahrt nach Wien?", car_home, trip_opener) ==
              "Wien: 298 km, 3 h 10 min Fahrt. Knapp – Reichweite 308 km, unterwegs lieber nachladen.")
        check("Hin und zurueck reicht nicht", answer_car("Reicht der Akku bis Wien und zurück?", car_home, trip_opener)
              .endswith("Reicht nicht – Reichweite 308 km, du musst etwa 289 km nachladen."))
        car_home["car"].update(usable_kwh="sensor.kwh", consumption=["sensor.avg", "sensor.last"])
        car_world.extend([{"entity_id": "sensor.kwh", "state": "42.5"}, {"entity_id": "sensor.avg", "state": "15.7"},
                          {"entity_id": "sensor.last", "state": "17.6"}])
        check("realistische Reichweite statt Herstellerwert", answer_car("Wie voll ist das Auto?", car_home, trip_opener)
              .startswith("Auto: 99 %, realistisch 239 km (laut Auto 308)")
              and answer_car("Komme ich bis nach Wien?", car_home, trip_opener).endswith(
                  "Reicht nicht – realistisch 239 km, du musst etwa 59 km nachladen."))
        globals().update(PLANNER_URL="http://planer/api/plan", PLANNER_VEHICLE="Testauto")
        plan_bodies = []

        def plan_opener(request, timeout):
            if request.full_url.startswith("http://planer/"):
                plan_bodies.append(json.loads(request.data))
                return FakeStatus({"stopps": [{"saeule": {"name": "Lidl Traun", "km_auf_route": 119.0, "kw": 50},
                                               "ladedauer_min": 24.9, "soc_vorher": 43.9, "soc_nachher": 80,
                                               "geoeffnet_bei_ankunft": False}]})
            return trip_opener(request, timeout)
        r = answer_car("Komme ich bis nach Wien?", car_home, plan_opener)
        check("reicht nicht -> Ladestopp vom Ladeplaner", r.endswith(
            "Ladestopp: Lidl Traun (km 119, 50 kW, 25 min, 44→80 %) – dann geschlossen.")
              and plan_bodies[-1] == {"start": [47.81, 13.041], "ziel": [48.21, 16.37], "soc_start": 99,
                                      "fahrzeug": "Testauto"})
        check("'Wo lade ich auf dem Weg nach Wien?' erkannt, nicht als Steuerbefehl abgelehnt",
              REACH_RE.search("Wo lade ich auf dem Weg nach Wien?").group("ziel") == "Wien"
              and "Lidl Traun" in answer_car("Wo lade ich auf dem Weg nach Wien?", car_home, plan_opener))
        globals().update(PLANNER_URL="", PLANNER_VEHICLE="")
        car_home["car"].update(power="sensor.power", eta_h="sensor.eta_h", eta_min="sensor.eta_min")
        car_world[3]["state"] = "on"
        car_world.extend([{"entity_id": "sensor.power", "state": "7.2"}, {"entity_id": "sensor.eta_h", "state": "1"},
                          {"entity_id": "sensor.eta_min", "state": "20"}])
        check("Laden mit Restzeit", "lädt mit 7,2 kW, fertig in 1 h 20 min" in
              answer_car("Wann ist das Auto voll?", car_home, car_opener))
        car_world[3]["state"] = "off"
        globals().update(GEOCODER_URL="", ROUTER_URL="")

        remind_file = os.path.join(home_dir, "reminders.json")
        clock = lambda: 1_800_000_000.0
        remind_home = dict(home, notify="notify.mobile_app_handy")
        r = answer_reminder("Erinner mich in 20 Minuten an die Wäsche", remind_home, clock, remind_file)
        check("Erinnerung angelegt", r.startswith("Erinnerung um ") and r.endswith(": Die Wäsche.")
              and abs(_load_reminders(remind_file)[0]["due"] - (clock() + 1200)) < 1)
        check("Zeitangaben", parse_when("in einer halben Stunde", clock) == clock() + 1800
              and parse_when("in zwei Stunden", clock) == clock() + 7200 and parse_when("irgendwann", clock) is None
              and parse_when("um 7:30", clock) > clock())
        notified = []

        def notify_opener(request, timeout):
            notified.append((request.full_url.split("8123", 1)[1], json.loads(request.data)))
            return FakeStatus([])
        check("noch nicht faellig: nichts geschickt",
              deliver_reminders(remind_home, notify_opener, clock, remind_file) == 0 and not notified)
        check("faellig: Benachrichtigung, dann weg",
              deliver_reminders(remind_home, notify_opener, lambda: clock() + 1300, remind_file) == 1
              and notified[-1] == ("/api/services/notify/mobile_app_handy", {"title": "Erinnerung", "message": "Die Wäsche"})
              and _load_reminders(remind_file) == [])
        globals()["HOME"] = remind_home
        check("Erinnerungen gehen nicht an den Agenten", classify("Erinner mich um 18 Uhr an den Müll") == "erinnern"
              and classify("Welche Erinnerungen habe ich?") == "erinnern")
        globals()["HOME"] = car_home
        check("Ueberblicksfragen erkannt", classify("Wie sieht's mit Home Assistant aus, wie geht's den Geräten?") == "haus"
              and classify("Ist zuhause alles in Ordnung?") == "haus" and classify("Wie warm ist es daheim?") == "wetter")
        check("Auto-Fragen und -Befehle gehen nie an den Agenten", classify("Mach das Auto an") == "auto"
              and classify("Wie viel Reichweite hab ich?") == "auto" and classify("Ist der Wagen abgesperrt?") == "auto")
        globals()["HOME"] = real_home_wx
        arbeit = {"status": "ok", "aktiv": "Vorgespraech", "dispo": None, "projekte": [
            {"name": "Vorgespraech", "aktiv": True, "szenen": 4, "shots": 19, "takes": 0}]}
        check("Shoot-Day: ohne Dispo das aktive Projekt",
              answer_arbeit("Was steht an?", "http://z/api/arbeit", lambda r, timeout: FakeStatus(arbeit)) ==
              "Kein Dreh mit Dispo geplant. Aktives Projekt: Vorgespraech (4 Szenen, 19 Shots, 0 Takes).")
        arbeit["dispo"] = {"titel": "Musikvideo", "datum": "30.10.", "zeit": "9:00", "ort": "Rockhouse"}
        check("Shoot-Day: Dispo vorn", answer_arbeit("Was steht an?", "http://z", lambda r, timeout: FakeStatus(
            arbeit)).startswith("Dispo: Musikvideo, 30.10., 9:00, Rockhouse."))
    finally:
        globals().update(saved)

    seen_routes = []

    def slow_opener(request, timeout):
        body = json.loads(request.data)
        seen_routes.append(body.get("model"))
        if body.get("model") == "hermes":
            time.sleep(0.4)          # langsam, aber kein Fehler
            return FakeResponse({"choices": [{"message": {"content": "Hermes hat geprueft."}}]})
        return FakeResponse({"choices": [{"message": {"content": "Ich pruefe gerade die Systeme."}}]})

    slow_routes = parse_routes("http://agent/v1/chat/completions", "k", "", "hermes",
                               "direct=http://spark:8000/v1/chat/completions#qwen")
    conv_slow = Conversation()
    r = answer(say("laufen die Server?"), lambda m, mo: ask_upstream(m, mo, slow_opener, slow_routes),
               conv_slow, budget=0.1)[0]
    wait_for(conv_slow, "result")
    check("langsamer Agent -> KEIN Ausweichen", r == BUSY_TEXT and seen_routes == ["hermes"]
          and conv_slow.pending["text"] == "Hermes hat geprueft.")
    state3 = os.path.join(tempfile.mkdtemp(), "c.json")
    keep = Conversation(path=state3)
    keep.set_pending({"kind": "result", "question": "q", "text": "Fertiges Ergebnis.", "ok": True, "t": time.time()})
    r = answer(say("und"), fake, Conversation(path=state3))[0]
    check("Ergebnis uebersteht Neustart", r == "Fertiges Ergebnis.")
    captured = []

    def cap_opener(request, timeout):
        captured.append(json.loads(request.data)["messages"][0]["content"])
        return FakeResponse({"choices": [{"message": {"content": "ok"}}]})

    ask_route(slow_routes[1], build_messages("x", []), "openclaw", cap_opener)
    ask_route(slow_routes[0], build_messages("x", []), "openclaw", cap_opener)
    check("direkter Weg: Hinweis 'keine Werkzeuge'", DIRECT_NOTE in captured[0] and DIRECT_NOTE not in captured[1])

    global TOKEN
    saved, TOKEN = TOKEN, "geheim"
    check("Token richtig", authorised("Bearer geheim") and not authorised("Bearer falsch") and not authorised(None))
    TOKEN = ""
    check("ohne Token alles gesperrt", not authorised("Bearer "))
    TOKEN = saved
    c = completion("hi", "openclaw")
    check("OpenAI-Form", c["choices"][0]["message"]["content"] == "hi" and c["object"] == "chat.completion")
    print("alles gruen" if ok else "FEHLER")
    return ok


def trace_report(path, last=None):
    """Zeitprotokoll zusammenfassen: pro Art/Handlung Anzahl, Median, 90 %, "noch dran", aufgegeben;
    dazu die Home-Assistant-Aufrufe und das Zuruecklesen."""
    rows = []
    with open(os.path.expanduser(path), encoding="utf-8") as handle:
        for line in handle:
            try:
                rows.append(json.loads(line))
            except ValueError:
                pass
    requests = [r for r in rows if r.get("type") == "anfrage"][-(last or 0):]

    def spread(values):
        values = sorted(values)
        if not values:
            return "-"
        return "%5d ms Median, %5d ms 90%%, max %5d" % (values[len(values) // 2],
                                                     values[min(len(values) - 1, int(len(values) * 0.9))], values[-1])
    groups, ha, polls = {}, {}, []
    for row in requests:
        action = next((s.get("action") for s in row.get("steps") or [] if s.get("what") == "command"), None)
        key = row.get("kind", "-") + ("/" + action if action else "")
        groups.setdefault(key, []).append(row)
        for step in row.get("steps") or []:
            if step.get("what") == "ha":
                call = re.sub(r"/api/states/.*", "/api/states/…", step["call"])
                ha.setdefault(call, []).append(step["ms"])
            if step.get("what") == "readback":
                polls.append(step["polls"])
    lines = ["%d Anfragen" % len(requests)]
    for key in sorted(groups):
        group = groups[key]
        lines.append("%-22s %3d×  %s  noch-dran %d  aufgegeben %d" % (
            key, len(group), spread([r["total_ms"] for r in group]), sum(1 for r in group if r.get("busy")),
            sum(1 for r in group if r.get("sent") is False)))
    if ha:
        lines.append("Home Assistant:")
        for call in sorted(ha):
            lines.append("  %-40s %3d×  %s" % (call, len(ha[call]), spread(ha[call])))
    if polls:
        lines.append("Zuruecklesen: %d×, im Mittel %.1f Runden à %d ms" % (len(polls), sum(polls) / len(polls),
                                                                          HOME_POLL_S * 1000))
    gaps = [r for r in requests if r.get("kind") in ("nachschauen", "tun") and not str(r.get("route", "")).startswith(
        ("schnell", "vorab")) and r.get("q")]
    if gaps:
        lines.append("An Hermes gegangen (Kandidaten fuer eigene Wege):")
        for row in gaps[-12:]:
            lines.append("  %s  %-11s %s" % (row.get("t", "")[5:16], row.get("kind"), row.get("q")[:70]))
    background = [r for r in rows if r.get("type") == "hintergrund"]
    if background:
        lines.append("Hintergrund (Agent): %d×  %s" % (len(background), spread([r["total_ms"] for r in background])))
    return "\n".join(lines)


def main():
    if "--selftest" in sys.argv:
        sys.exit(0 if selftest() else 1)
    if "--trace-report" in sys.argv:
        print(trace_report(TRACE_FILE or os.path.join(HERE, "trace.jsonl")))
        return
    if not TOKEN or not UPSTREAM_URL:
        sys.exit("GLASS_AGENT_TOKEN und GLASS_AGENT_UPSTREAM_URL muessen gesetzt sein.")
    if HOME and HOME.get("notify"):
        threading.Thread(target=reminder_loop, name="glass-agent-reminders", daemon=True).start()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print("Brillen-Agent auf http://%s:%d/v1/chat/completions (Verlauf %ds, %d Zeichen)"
          % (HOST, PORT, int(CONTEXT_TTL), CHAR_BUDGET), flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
