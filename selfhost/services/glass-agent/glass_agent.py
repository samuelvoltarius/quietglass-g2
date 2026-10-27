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
RESULT_TTL = 10 * 60       # so lange wird ein Hintergrund-Ergebnis fuer die naechste Aeusserung gemerkt
POLL_S = 0.5
BUSY_TEXT = "Ich bin noch dran – frag gleich mit „und?“ nach."
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
SERVER_RE = re.compile(r"(server|rechner|maschine|l[aä]uft|laufen|online|offline|erreichbar|status|auslastung|"
                       r"speicher|platte|festplatte|temperatur|\bram\b|\bcpu\b|abgest[uü]rzt|down\b|\bup\b)", re.I)
WEEKDAYS = ("Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag")


def classify(question):
    """Art der Frage: "jetzt" (Uhrzeit/Datum), "tun", "nachschauen" oder "wissen"."""
    if TIME_RE.match(question) or DATE_RE.match(question):
        return "jetzt"
    if TASK_RE.match(question):
        return "tun"
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


def answer_status(question, hosts=None, opener=urllib.request.urlopen):
    hosts = STATUS_HOSTS if hosts is None else hosts
    targets = status_targets(question, hosts) or hosts
    results = {}

    def one(host):
        results[host["name"]] = fetch_status(host, opener)
    threads = [threading.Thread(target=one, args=(host,), daemon=True) for host in targets]
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
    up = len(targets) - len(down)
    head = ("Alle %d laufen." % up) if not down else ("%d von %d laufen, nicht erreichbar: %s."
                                                       % (up, len(targets), ", ".join(down)))
    return head + ((" " + ". ".join(notes) + ".") if notes else "")


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
    def __init__(self, reason, rest=False):
        super().__init__(reason)
        self.rest = rest


def ask_route(route, messages, model, opener=urllib.request.urlopen, timeout=None):
    if route.get("direct") and messages and messages[0].get("role") == "system":
        messages = [dict(messages[0], content=messages[0]["content"] + " " + DIRECT_NOTE)] + list(messages[1:])
    body = {"model": route["model"] or model or "openclaw", "messages": messages, "stream": False}
    if route["provider"]:
        body["provider"] = route["provider"]
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if route["key"]:
        headers["Authorization"] = "Bearer " + route["key"]
    request = urllib.request.Request(route["url"], data=json.dumps(body).encode(), headers=headers, method="POST")
    try:
        with opener(request, timeout=timeout or TIMEOUT) as response:
            data = json.loads(response.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as error:
        raise RouteFailed("HTTP %d" % error.code, rest=error.code in (402, 429)) from None
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
        try:
            text = ask_route(route, messages, model, opener)
            LAST_ROUTE["name"] = route["name"]
            if route is not routes[0]:
                sys.stderr.write("[glass-agent] Ausweichweg %s hat geantwortet\n" % route["name"])
            return text
        except RouteFailed as error:
            last = error
            sys.stderr.write("[glass-agent] Weg %s gescheitert: %s%s\n"
                             % (route["name"], error, " (15 min Pause)" if error.rest else ""))
            if error.rest:
                _resting[route["name"]] = now() + COOLDOWN_S
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
        raise RouteFailed("HTTP %d" % error.code, rest=error.code in (402, 429)) from None
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

    def work():
        try:
            result = ("ok", fn())
        except Exception as error:  # noqa: BLE001 - wird zu kurzem Text
            result = ("error", error)
        with job["lock"]:
            job["result"] = result
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


def answer(body, ask=ask_upstream, conversation=CONVERSATION, opener=urllib.request.urlopen, routes=None,
           now=time.time, sleep=time.sleep, budget=None):
    """Kern: Request der Even-App -> Text fuer die Brille. Wirft nie; Fehler werden zu kurzem Text."""
    budget = BUDGET if budget is None else budget
    question = last_user_text(body)
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
    kind = classify(question) if ROUTING else "nachschauen"
    LAST_ROUTE["kind"] = kind
    if kind == "jetzt" and not prefix:
        LAST_ROUTE["name"] = "selbst"
        return answer_now(question, now), model
    if kind == "server" and not prefix:
        LAST_ROUTE["name"] = "status"
        text = clean_for_glasses(answer_status(question))
        conversation.add(question, text)
        return text, model
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
    if kind == "wissen" and FAST_URL:
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
        text, model = answer(body)
        sys.stderr.write("[glass-agent] App schickte %d Nachricht(en); frage %d Zeichen (Verlauf %d) -> antwort %d Zeichen"
                         " in %.1f s via %s (%s)\n"
                         % (len(body.get("messages") or []), len(last_user_text(body)), len(CONVERSATION.turns),
                            len(text), time.time() - started, LAST_ROUTE["name"] or "-", LAST_ROUTE.get("kind") or "-"))
        try:
            self._send(200, completion(text, model))
        except (BrokenPipeError, ConnectionResetError):
            sys.stderr.write("[glass-agent] Even-App hatte schon aufgegeben (Verbindung zu nach %.1f s)\n"
                             % (time.time() - started))

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
    r1 = run_answer("hallo", conv, opener=no_runs)
    r2 = run_answer("hallo", conv, opener=no_runs)
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
    r = answer(say("wie spät ist es?"), fake, conv_bg, budget=1.0)[0]
    check("andere Frage -> Ergebnis kurz vorn, dann neue Antwort",
          r.startswith("Vorhin: Spät, aber da. Jetzt: Antwort") and conv_bg.history()[-2][0] == "Server prüfen")
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
        check("'nachschauen' geht wie bisher an den Agenten", used[0] == ROUTES[0]["name"])
        used.clear()
        answer(say("Schreib Maria eine Nachricht"), routed, Conversation(), budget=1.0)
        check("'tun' nimmt das staerkere Modell", used and used[0].endswith("stark"))
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
        globals()["STATUS_HOSTS"] = []
        check("ohne Status-Quellen keine Server-Art", classify("Läuft der Server ns1?") == "nachschauen")
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


def main():
    if "--selftest" in sys.argv:
        sys.exit(0 if selftest() else 1)
    if not TOKEN or not UPSTREAM_URL:
        sys.exit("GLASS_AGENT_TOKEN und GLASS_AGENT_UPSTREAM_URL muessen gesetzt sein.")
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print("Brillen-Agent auf http://%s:%d/v1/chat/completions (Verlauf %ds, %d Zeichen)"
          % (HOST, PORT, int(CONTEXT_TTL), CHAR_BUDGET), flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
