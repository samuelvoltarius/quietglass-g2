#!/usr/bin/env python3
"""MCP server for Shoot Day: lets an AI agent read and update your shoot.

Gives any MCP client (Claude Desktop, Claude Code, Hermes, ...) the shoot
behind the glasses app: status, schedule, shot list, takes and packing list,
plus two write tools (tick an item, log a take).

Deliberately WITHOUT third-party packages: a self-written stdio server cannot
break on SDK versions. It speaks JSON-RPC 2.0, one message per line, over
stdin/stdout (the MCP stdio transport).

Start (from your MCP client's config):

    python3 dreh_mcp.py

Environment:
    SHOOTDAY_URL     base URL of shoot-day-server.mjs (default http://127.0.0.1:8899)
    SHOOTDAY_TOKEN   bearer token, if the server was started with TOKEN=...
    SHOOTDAY_LANG    language of the answers: en (default) or de
    SHOOTDAY_TIMEOUT seconds per request (default 8)
"""
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime

BACKEND = (os.environ.get("SHOOTDAY_URL") or os.environ.get("DREH_BACKEND") or "http://127.0.0.1:8899").rstrip("/")
TOKEN = os.environ.get("SHOOTDAY_TOKEN", "")
LANG = "de" if os.environ.get("SHOOTDAY_LANG", "en").lower().startswith("de") else "en"
TIMEOUT = float(os.environ.get("SHOOTDAY_TIMEOUT", "8"))
PROTOCOL = "2024-11-05"

WORDS = {
    "en": {
        "project": "Project", "day": "Shoot day", "call": "call", "location": "Location",
        "shots": "Shots", "takes_so_far": "takes so far", "packing": "Packing list",
        "of": "of", "packed": "packed", "open": "open", "now": "NOW", "next": "NEXT",
        "in_min": "in {min} min", "nothing_more": "Nothing more is planned.", "full_schedule": "Full schedule:",
        "note": "Note", "no_shots": "No shots in this project.", "shotlist": "Shot list {project} ({count} shots):",
        "no_takes": "No takes logged yet.", "last_takes": "Last {count} takes (newest first):",
        "total_takes": "Total: {total} takes, {ok} OK and {ng} NG.",
        "nothing_selected": "Nothing is selected for this shoot yet.", "all_packed": "Nothing open — everything is packed.",
        "still_missing": "Still missing:", "packing_count": "Packing list: {packed} of {need} packed",
        "name_needed": "Please give the name of the item.", "no_match": "No item matches “{name}”.",
        "ambiguous": "Ambiguous, please be more specific: ", "now_state": "{name} is now {state} ({packed} of {need}).",
        "scene_shot_needed": "Please give scene and shot.", "logged": "Logged: {scene}·{shot} T{n} {status} {note}",
        "unreachable": "Shoot Day server not reachable ({url}): {error}", "failed": "Error in {tool}: {error}",
        "unknown_tool": "Unknown tool: {tool}", "unknown_method": "Unknown method: {method}",
    },
    "de": {
        "project": "Projekt", "day": "Drehtag", "call": "Call", "location": "Ort",
        "shots": "Shots", "takes_so_far": "Takes bisher", "packing": "Packliste",
        "of": "von", "packed": "eingepackt", "open": "offen", "now": "JETZT", "next": "GLEICH",
        "in_min": "in {min} min", "nothing_more": "Danach ist nichts mehr geplant.", "full_schedule": "Ganzer Zeitplan:",
        "note": "Notiz", "no_shots": "Keine Shots in diesem Projekt.", "shotlist": "Shotlist {project} ({count} Shots):",
        "no_takes": "Noch keine Takes protokolliert.", "last_takes": "Letzte {count} Takes (neueste zuerst):",
        "total_takes": "Gesamt: {total} Takes, davon {ok} OK und {ng} NG.",
        "nothing_selected": "Für diesen Dreh ist noch nichts ausgewählt.", "all_packed": "Nichts offen — alles eingepackt.",
        "still_missing": "Es fehlt noch:", "packing_count": "Packliste: {packed} von {need} eingepackt",
        "name_needed": "Bitte den Namen der Position angeben.", "no_match": "Keine Position gefunden, die zu „{name}“ passt.",
        "ambiguous": "Mehrdeutig, bitte genauer: ", "now_state": "{name} ist jetzt {state} ({packed} von {need}).",
        "scene_shot_needed": "Bitte Szene und Shot angeben.", "logged": "Eingetragen: {scene}·{shot} T{n} {status} {note}",
        "unreachable": "Shoot-Day-Server nicht erreichbar ({url}): {error}", "failed": "Fehler in {tool}: {error}",
        "unknown_tool": "Unbekanntes Werkzeug: {tool}", "unknown_method": "Unbekannte Methode: {method}",
    },
}


def w(key, **values):
    return WORDS[LANG][key].format(**values)


# ---------- server ----------
def api(path, payload=None):
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {"Accept": "application/json"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    if TOKEN:
        headers["Authorization"] = "Bearer " + TOKEN
    request = urllib.request.Request(f"{BACKEND}{path}", data=data, headers=headers)
    with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
        return json.loads(response.read().decode("utf-8"))


def hhmm_to_min(text):
    text = (text or "").strip().replace(".", ":")
    hours, sep, minutes = text.partition(":")
    if sep and hours.strip().isdigit() and minutes[:2].isdigit():
        h, m = int(hours), int(minutes[:2])
        if h < 24 and m < 60:
            return h * 60 + m
    return None


# ---------- tools ----------
def t_status(_args):
    d = api("/api/dispo")
    sl = api("/api/shotlist")
    eq = api("/api/equipment")
    tk = api("/api/takes")
    return (
        f"{w('project')}: {sl.get('project') or '-'}\n"
        f"{w('day')}: {d.get('date') or '-'}, {w('call')} {d.get('call') or '-'}\n"
        f"{w('location')}: {d.get('location') or '-'}\n"
        f"{w('shots')}: {len(sl.get('shots') or [])} · {w('takes_so_far')}: {len(tk.get('takes') or [])}\n"
        f"{w('packing')}: {eq.get('packed', 0)} {w('of')} {eq.get('need', 0)} {w('packed')}"
    )


def t_dispo(_args):
    d = api("/api/dispo")
    schedule = d.get("schedule") or []
    rows = [r for r in schedule if hhmm_to_min(r.get("time")) is not None]
    now = datetime.now()
    minutes = now.hour * 60 + now.minute
    current = upcoming = None
    for row in rows:
        if hhmm_to_min(row["time"]) <= minutes:
            current = row
        elif upcoming is None:
            upcoming = row
    out = [f"{w('day')} {d.get('date') or '-'} · {d.get('location') or '-'}"]
    if current:
        out.append(f"{w('now')} ({current['time']}): {current.get('what', '')}")
    if upcoming:
        wait = w("in_min", min=hhmm_to_min(upcoming["time"]) - minutes)
        out.append(f"{w('next')} ({upcoming['time']}, {wait}): {upcoming.get('what', '')}")
    elif rows:
        out.append(w("nothing_more"))
    out += ["", w("full_schedule")]
    out += [f"  {r.get('time', '')}  {r.get('what', '')}" for r in schedule]
    if d.get("notes"):
        out += ["", f"{w('note')}: {d['notes']}"]
    return "\n".join(out)


def t_shotlist(_args):
    sl = api("/api/shotlist")
    shots = sl.get("shots") or []
    if not shots:
        return w("no_shots")
    lines = [w("shotlist", project=sl.get("project") or "", count=len(shots))]
    lines += [
        f"  {s.get('scene', '')}·{s.get('shot', '')}  {s.get('size', '') or '-':<6} {s.get('desc', '')}"
        for s in shots
    ]
    return "\n".join(lines)


def t_takes(args):
    try:
        count = max(1, min(100, int(args.get("anzahl") or 15)))
    except (TypeError, ValueError):
        count = 15
    takes = api("/api/takes").get("takes") or []
    if not takes:
        return w("no_takes")
    lines = [w("last_takes", count=min(count, len(takes)))]
    for t in takes[:count]:
        ts = datetime.fromtimestamp(t["ts"] / 1000).strftime("%H:%M") if t.get("ts") else ""
        lines.append(f"  {t.get('scene')}·{t.get('shot')} T{t.get('n')} {t.get('status')} {t.get('note', '')} {ts}")
    ok = sum(1 for t in takes if t.get("status") == "OK")
    lines.append(w("total_takes", total=len(takes), ok=ok, ng=len(takes) - ok))
    return "\n".join(lines)


def t_packliste(args):
    eq = api("/api/equipment")
    items = [i for i in (eq.get("items") or []) if i.get("need")]
    if not items:
        return w("nothing_selected")
    still_open = [i for i in items if not i.get("packed")]
    if args.get("nur_offene"):
        if not still_open:
            return w("all_packed")
        return w("still_missing") + "\n" + "\n".join(f"  {i['name']}" for i in still_open)
    lines = [w("packing_count", packed=len(items) - len(still_open), need=len(items))]
    lines += [f"  [{'x' if i.get('packed') else ' '}] {i['name']}" for i in items]
    return "\n".join(lines)


def t_pack_setzen(args):
    name = str(args.get("name") or "").strip()
    if not name:
        return w("name_needed")
    eq = api("/api/equipment")
    items = [i for i in (eq.get("items") or []) if i.get("need")]
    low = name.lower()
    hits = [i for i in items if low in i["name"].lower()]
    if not hits:
        hits = [i for i in items if any(part in i["name"].lower() for part in low.split() if len(part) > 2)]
    if not hits:
        return w("no_match", name=name)
    if len(hits) > 1:
        return w("ambiguous") + ", ".join(i["name"] for i in hits[:6])
    packed = args.get("eingepackt", True) is not False
    r = api("/api/equipment", {"toggle": {"name": hits[0]["name"], "packed": packed}})
    state = w("packed") if r.get("packed") else w("open")
    return w("now_state", name=r.get("name"), state=state, packed=r.get("packedCount"), need=r.get("need"))


def t_take_eintragen(args):
    scene = str(args.get("szene") or "").strip()
    shot = str(args.get("shot") or "").strip()
    status = "NG" if str(args.get("status", "OK")).upper() == "NG" else "OK"
    if not scene or not shot:
        return w("scene_shot_needed")
    r = api("/api/take", {"scene": scene, "shot": shot, "status": status, "note": str(args.get("notiz") or "")})
    return w("logged", scene=r.get("scene"), shot=r.get("shot"), n=r.get("n"), status=r.get("status"), note=r.get("note", "")).strip()


# Tool and argument names stay German for compatibility with existing setups.
TOOLS = [
    ("dreh_status", "Overview of the active shoot: project, day, number of shots and takes, packing progress.",
     {"type": "object", "properties": {}}, t_status),
    ("dreh_dispo", "The shoot day's schedule, including what is on now and what comes next.",
     {"type": "object", "properties": {}}, t_dispo),
    ("dreh_shotlist", "All scenes and shots of the active shoot.",
     {"type": "object", "properties": {}}, t_shotlist),
    ("dreh_takes", "The most recently logged takes with status and note.",
     {"type": "object", "properties": {"anzahl": {"type": "integer", "description": "how many (default 15, max 100)"}}}, t_takes),
    ("dreh_packliste", "The packing list of the shoot; optionally only what is still open.",
     {"type": "object", "properties": {"nur_offene": {"type": "boolean", "description": "only show what is still missing"}}}, t_packliste),
    ("dreh_pack_setzen", "Mark one packing-list item as packed or open.",
     {"type": "object",
      "properties": {"name": {"type": "string", "description": "name or part of it, e.g. 'gimbal'"},
                     "eingepackt": {"type": "boolean", "description": "true = packed (default), false = open"}},
      "required": ["name"]}, t_pack_setzen),
    ("dreh_take_eintragen", "Log a take.",
     {"type": "object",
      "properties": {"szene": {"type": "string", "description": "scene"}, "shot": {"type": "string"},
                     "status": {"type": "string", "description": "OK or NG"},
                     "notiz": {"type": "string", "description": "note"}},
      "required": ["szene", "shot"]}, t_take_eintragen),
]
BY_NAME = {name: fn for name, _d, _s, fn in TOOLS}


# ---------- JSON-RPC ----------
def reply(msg_id, result=None, error=None):
    out = {"jsonrpc": "2.0", "id": msg_id}
    if error is not None:
        out["error"] = error
    else:
        out["result"] = result
    sys.stdout.write(json.dumps(out, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def handle(msg):
    if not isinstance(msg, dict):
        return None
    method = msg.get("method")
    msg_id = msg.get("id")
    if method == "initialize":
        return reply(msg_id, {
            "protocolVersion": PROTOCOL,
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "shoot-day", "version": "0.1.0"},
        })
    if method in ("notifications/initialized", "initialized"):
        return None  # a notification, no answer
    if method == "ping":
        return reply(msg_id, {})
    if method == "tools/list":
        return reply(msg_id, {"tools": [
            {"name": n, "description": d, "inputSchema": s} for n, d, s, _f in TOOLS
        ]})
    if method == "tools/call":
        params = msg.get("params") or {}
        name = params.get("name")
        args = params.get("arguments") or {}
        fn = BY_NAME.get(name)
        if not fn:
            return reply(msg_id, error={"code": -32601, "message": w("unknown_tool", tool=name)})
        is_error = False
        try:
            text = fn(args if isinstance(args, dict) else {})
        except urllib.error.URLError as e:
            # The token is never part of the message: only the base URL is shown.
            text, is_error = w("unreachable", url=BACKEND, error=getattr(e, "reason", e)), True
        except Exception as e:  # noqa: BLE001 - show the agent the real cause
            text, is_error = w("failed", tool=name, error=e), True
        return reply(msg_id, {"content": [{"type": "text", "text": text}], "isError": is_error})
    if msg_id is not None:
        return reply(msg_id, error={"code": -32601, "message": w("unknown_method", method=method)})
    return None


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        try:
            handle(msg)
        except Exception as e:  # noqa: BLE001
            if isinstance(msg, dict) and msg.get("id") is not None:
                reply(msg["id"], error={"code": -32603, "message": str(e)})


if __name__ == "__main__":
    main()
