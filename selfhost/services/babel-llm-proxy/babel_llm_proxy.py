#!/usr/bin/env python3
"""CORS + token + no-thinking proxy in front of an OpenAI-compatible LLM for Babel Glass.

Streaming (`"stream": true`) is passed through as server-sent events, line by line,
without buffering; everything else is answered as one JSON body.

Since Babel Glass 0.4.0 it also keeps the app's OWN small memory (past conversations
and notes) in a JSON file next to it -- nothing else is read or written:
  POST   /memory            {type, title, summary, agreements, date?}  -> append
  GET    /memory?limit=N                                               -> newest first
  DELETE /memory/<id>                                                  -> one entry
  DELETE /memory                                                       -> everything
  POST   /memory/search     {query, limit}                             -> BM25-ish keyword hits
Same auth as the chat endpoint. Stdlib only.

Optional Shoot Day customer context (BABEL_SHOOT_URL, read-only GETs): the reply-suggestion, word-finder
and summary calls get a short block about the current customer appended to their system prompt;
GET /context/customers lists the customers (id, name, company, next project) for the glasses' start screen;
GET /context/customer shows which customer that is (counts only); ?full=1 adds date, place, idea texts,
storyboard/scene titles and slogans for the glasses' Kunde page (never the prompt block).
Feedback (the only WRITE to Shoot Day; BABEL_SHOOT_FEEDBACK, default on with BABEL_SHOOT_URL):
POST /context/feedback {transcript, customer?} lets the LLM pull new/preferred ideas, rejected prepared ideas,
wishes and open questions out of a conversation and APPENDS them as ideas to the customer's current project;
after every summary call this also runs by itself in the background.
Talk record (BABEL_SHOOT_TALKS, default on with BABEL_SHOOT_URL): after every summary call the summary text and the
tip cards of that conversation are posted once to POST /api/projects/<id>/talks of the same customer's current
project (Shoot Day mirrors them to the Work Dashboard as a comment).
Tip cards (Kundengespräch, read-only): POST /context/cue {transcript, customer?, recent_titles?} asks the LLM for at
most ONE short live card {title, text, kind} or {"none": true}; 6 s cap.   Self test: python3 babel_llm_proxy.py --selftest
"""
import difflib, hashlib, json, math, os, re, secrets, sys, threading, time, urllib.error, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit
UP = os.environ.get("UPSTREAM", "http://127.0.0.1:8000"); TOKEN = os.environ.get("TOKEN", "")
PORT = int(os.environ.get("PORT", "8121"))
# Tailscale login auth: `tailscale serve` connects from loopback and sets Tailscale-User-Login.
TS_USERS = [u.strip().lower() for u in os.environ.get("TAILSCALE_USERS", "").split(",") if u.strip()]
MEMORY_FILE = os.environ.get("BABEL_MEMORY_FILE") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "babel-memory.json")
MEMORY_CAP = int(os.environ.get("BABEL_MEMORY_CAP") or "500")
MEMORY_BODY_MAX = 64 * 1024

# ---------------------------------------------------------------- memory store

_memory_lock = threading.Lock()


def _clip(value, limit):
    return value.strip()[:limit] if isinstance(value, str) else ""


def memory_load(path):
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return [e for e in data if isinstance(e, dict) and isinstance(e.get("id"), str)] if isinstance(data, list) else []
    except (OSError, ValueError):
        return []


def memory_save(path, entries):
    """Atomic: write a private temp file next to it, then os.replace."""
    folder = os.path.dirname(os.path.abspath(path))
    os.makedirs(folder, exist_ok=True)
    tmp = path + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(entries, f, ensure_ascii=False)
            f.flush(); os.fsync(f.fileno())
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except BaseException:
        try: os.unlink(tmp)
        except OSError: pass
        raise


def memory_clean(d, now=None):
    """A stored entry from a request body; None when it holds nothing."""
    if not isinstance(d, dict): return None
    title = _clip(d.get("title"), 200); summary = _clip(d.get("summary"), 8000)
    raw = d.get("agreements") if isinstance(d.get("agreements"), list) else []
    agreements = [a for a in (_clip(x, 500) for x in raw[:50]) if a]
    if not title and not summary and not agreements: return None
    when = now if now is not None else time.time()
    date = _clip(d.get("date"), 40) or time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(when))
    return {"id": secrets.token_hex(8), "date": date, "type": "note" if d.get("type") == "note" else "session",
            "title": title or summary[:60], "summary": summary, "agreements": agreements, "created": when}


def memory_add(path, d, cap=None):
    entry = memory_clean(d)
    if entry is None: return None
    with _memory_lock:
        entries = memory_load(path); entries.append(entry)
        entries = entries[-(cap or MEMORY_CAP):]
        memory_save(path, entries)
    return entry


def memory_list(path, limit=100):
    entries = memory_load(path)
    return list(reversed(entries))[:max(1, limit)]


def memory_delete(path, entry_id):
    with _memory_lock:
        entries = memory_load(path)
        kept = [e for e in entries if e.get("id") != entry_id]
        if len(kept) == len(entries): return 0
        memory_save(path, kept)
    return 1


def memory_clear(path):
    with _memory_lock:
        n = len(memory_load(path))
        memory_save(path, [])
    return n


STOP = set("""der die das den dem des ein eine einen einem einer und oder aber ich du er sie es wir ihr mit von
zu im in am an auf aus bei für ist sind war hat haben wird werden nicht noch auch nur so wie was wer wo
dann denn doch ja nein mal schon sehr hier da the a an and or of to in on at for is are was it this that
with be as by not you we he she they""".split())


def _stem(word):
    """Very light German/English suffix cut, so "Ziegeln" finds "Ziegel" and "Pumpen" finds "Pumpe"."""
    for suffix in ("ern", "en", "er", "es", "e", "n", "s"):
        if len(word) > 4 + len(suffix) - 1 and word.endswith(suffix): return word[:-len(suffix)]
    return word


def tokens(text):
    return [_stem(w) for w in re.findall(r"\w+", (text or "").lower()) if len(w) >= 2 and w not in STOP and not w.isdigit()]


def memory_search(entries, query, limit=3):
    """BM25 over title (counted twice), summary and agreements; only hits with a score > 0."""
    q = set(tokens(query))
    if not q or not entries: return []
    docs = [tokens(e.get("title", "")) * 2 + tokens(e.get("summary", "")) + tokens(" ".join(e.get("agreements") or [])) for e in entries]
    n = len(docs); avg = (sum(len(d) for d in docs) / n) or 1.0
    df = {t: sum(1 for d in docs if t in d) for t in q}
    k1, b = 1.2, 0.75
    scored = []
    for entry, doc in zip(entries, docs):
        score = 0.0
        for t in q:
            tf = doc.count(t)
            if not tf: continue
            idf = math.log(1 + (n - df[t] + 0.5) / (df[t] + 0.5))
            score += idf * tf * (k1 + 1) / (tf + k1 * (1 - b + b * len(doc) / avg))
        if score > 0: scored.append((score, entry))
    scored.sort(key=lambda s: (-s[0], -(s[1].get("created") or 0)))
    return [dict(e, score=round(s, 3)) for s, e in scored[:max(1, limit)]]


def _public(e):
    return {k: e.get(k) for k in ("id", "date", "type", "title", "summary", "agreements", "score") if k in e}

# ---------------------------------------------------------------- Shoot Day customer context
# Reads by GET; the only writes are the feedback filing (appends ideas to one project) and the talk record (appends one talk).
SHOOT_URL = os.environ.get("BABEL_SHOOT_URL", "").strip().rstrip("/")
SHOOT_TOKEN = os.environ.get("BABEL_SHOOT_TOKEN", "").strip()
SHOOT_TIMEOUT = float(os.environ.get("BABEL_SHOOT_TIMEOUT") or "2")
SHOOT_TTL = 60.0
SHOOT_FAIL_TTL = 15.0
SHOOT_MAX_CHARS = 2500
UNASSIGNED_NAMES = ("ohne zuordnung", "unassigned")
# Only these companion calls get the context (never the plain translation): matched on the system prompt.
SHOOT_KINDS = (
    ("reply", ("Du hilfst jemandem live in einem Gespräch", "You help someone live during a conversation")),
    ("word", ("Der Sprecher sucht ein Wort", "The speaker is searching for a word")),
    ("summary", ("Du fasst ein mitgeschriebenes Gespräch", "Summarise a transcribed conversation")),
)
SHOOT_INSTRUCTION = "Nutze ihn für passende Antwortvorschläge und Begriffe; erfinde nichts dazu."
# Extra for the live reply suggestions: notice when the customer wants something else than the prepared ideas.
SHOOT_REPLY_INSTRUCTION = ("Wenn der Kunde in der Mitschrift eine vorbereitete Idee ablehnt, anzweifelt oder ändert oder eine "
                           "andere Idee bzw. einen neuen Wunsch nennt: Nimm unter die Vorschläge genau eine kurze Rückfrage auf, "
                           "die die neue Idee klärt (Ziel, Stimmung, wo/wann, wer vor der Kamera), und – nur wenn eine vorbereitete "
                           "Idee wirklich zum neuen Wunsch passt – einen Vorschlag, der diese Idee nennt. Keine erfundenen Fakten.")
_shoot_cache = {}
_shoot_lock = threading.Lock()


def _shoot_get(path, deadline):
    left = deadline - time.monotonic()
    if left <= 0.02: raise TimeoutError("shoot day deadline")
    headers = {"Accept": "application/json"}
    if SHOOT_TOKEN: headers["Authorization"] = "Bearer " + SHOOT_TOKEN
    req = urllib.request.Request(SHOOT_URL + path, None, headers, method="GET")
    with urllib.request.urlopen(req, timeout=left) as r:
        return json.loads(r.read(2 * 1024 * 1024) or b"{}")


def _is_unassigned(c):
    return (not isinstance(c, dict) or not c.get("id") or c.get("unassigned") is True or c.get("id") == "unassigned"
            or str(c.get("name") or "").strip().lower() in UNASSIGNED_NAMES)


def shoot_pick(listing, wanted=""):
    """The customer dict to use: `wanted` (id or name) or Shoot Day's active customer; None = no context."""
    customers = [c for c in (listing.get("customers") or []) if not _is_unassigned(c)]
    wanted = (wanted or "").strip()
    if wanted:
        w = wanted.lower()
        if w in ("-", "none", "aus", "off"): return None
        for test in (lambda c: c.get("id") == wanted,
                     lambda c: str(c.get("name") or "").strip().lower() == w,
                     lambda c: w in str(c.get("name") or "").lower() or w in str(c.get("company") or "").lower()):
            hit = next((c for c in customers if test(c)), None)
            if hit: return hit
        return None
    active = listing.get("activeCustomer") or ""
    return next((c for c in customers if c.get("id") == active), None) if active else None


def _one_line(text, limit):
    text = re.sub(r"\s+", " ", str(text or "")).strip()
    return text if len(text) <= limit else text[:limit - 1].rstrip() + "…"


def _project_pick(projects, active_id, today=None):
    """Active project of this customer, else the next one from today on, else the newest."""
    projects = [p for p in projects if isinstance(p, dict) and p.get("id")]
    if not projects: return None
    hit = next((p for p in projects if p.get("id") == active_id), None)
    if hit: return hit
    today = today or time.strftime("%Y-%m-%d")
    upcoming = sorted((p for p in projects if str(p.get("date") or "") >= today), key=lambda p: str(p.get("date")))
    return upcoming[0] if upcoming else projects[0]


def shoot_block(brief, project, limit=SHOOT_MAX_CHARS):
    """The compact German context text (at most `limit` characters, cut at a line end)."""
    out = []
    name = _one_line(brief.get("name"), 120)
    company = _one_line(brief.get("company"), 120)
    out.append("Kunde: " + name + (" (" + company + ")" if company and company.lower() != name.lower() else ""))
    if project:
        bits = [_one_line(project.get("name"), 120), _one_line(project.get("date"), 40), _one_line(project.get("place"), 120)]
        out.append("Projekt: " + " · ".join(b for b in bits if b))
    others = [p for p in (brief.get("projects") or []) if isinstance(p, dict) and (not project or p.get("id") != project.get("id"))][:3]
    if others:
        out.append("Weitere Projekte: " + "; ".join(
            _one_line(p.get("name"), 60) + (" (" + _one_line(p.get("date"), 20) + ")" if p.get("date") else "") for p in others))
    if brief.get("notes"):
        out.append("Notizen: " + _one_line(brief.get("notes"), 300))
    ideas = [i for i in (brief.get("ideas") or []) if isinstance(i, dict) and str(i.get("text") or "").strip()]
    if ideas:
        out.append("Offene Ideen:")
        for i in ideas[:12]:
            tags = " ".join("#" + _one_line(t, 30).lstrip("#") for t in (i.get("tags") or []) if isinstance(t, str) and t.strip())
            out.append("- " + _one_line(i.get("text"), 160) + (" " + tags if tags else ""))
    overlays = []
    boards = [b for b in ((project or {}).get("storyboards") or []) if isinstance(b, dict)]
    if boards:
        out.append("Storyboards:")
        for b in boards[:4]:
            out.append("[" + (_one_line(b.get("title"), 80) or "Storyboard") + "]")
            for s in [s for s in (b.get("scenes") or []) if isinstance(s, dict)][:10]:
                body = _one_line(s.get("content"), 90)
                line = " " + str(s.get("n") or "-") + ". " + _one_line(s.get("title"), 50) + (": " + body if body else "")
                ov = _one_line(s.get("overlay"), 80)
                if ov:
                    line += " (Einblendung: " + ov + ")"
                    if ov not in overlays: overlays.append(ov)
                out.append(line)
    if overlays:
        out.append("Einblendungen/Slogans: " + " | ".join(overlays[:10]))
    script = _one_line((project or {}).get("prompter"), 600)
    if script:
        out.append("Skript (Anfang): " + script)
    text = ""
    for line in out:
        if len(text) + len(line) + 1 > limit: break
        text += line + "\n"
    return text.strip()[:limit]


def shoot_full(brief, project):
    """The readable lists for the glasses' "Kunde" page (GET /context/customer?full=1); short, capped, text only."""
    project = project or {}
    ideas = [_one_line(i.get("text"), 160) for i in (brief.get("ideas") or []) if isinstance(i, dict) and str(i.get("text") or "").strip()][:20]
    boards, slogans = [], []
    for b in [b for b in (project.get("storyboards") or []) if isinstance(b, dict)][:6]:
        scenes = [s for s in (b.get("scenes") or []) if isinstance(s, dict)][:20]
        boards.append({"title": _one_line(b.get("title"), 80) or "Storyboard",
                       "scenes": [_one_line(s.get("title"), 60) or ("Szene " + str(s.get("n") or "")).strip() for s in scenes]})
        for s in scenes:
            ov = _one_line(s.get("overlay"), 80)
            if ov and ov not in slogans: slogans.append(ov)
    return {"date": _one_line(project.get("date"), 40), "place": _one_line(project.get("place"), 120),
            "ideas": ideas, "storyboards": boards, "slogans": slogans[:10]}


def shoot_context(wanted=""):
    """{'name', 'text', 'ideas', 'storyboards', 'project'} or None. Cached 60 s; never raises."""
    if not SHOOT_URL: return None
    key = (SHOOT_URL, (wanted or "").strip().lower())
    with _shoot_lock:
        hit = _shoot_cache.get(key)
        if hit and hit[0] > time.monotonic(): return hit[1]
    value = None
    try:
        deadline = time.monotonic() + SHOOT_TIMEOUT
        listing = _shoot_get("/api/customers", deadline)
        customer = shoot_pick(listing, wanted)
        if customer:
            brief = _shoot_get("/api/customers/" + urllib.request.quote(str(customer["id"]), safe="") + "/brief", deadline)
            pick = _project_pick(brief.get("projects") or [], listing.get("active") or "")
            project = None
            if pick:
                try: project = _shoot_get("/api/projects/" + urllib.request.quote(str(pick["id"]), safe=""), deadline)
                except Exception: project = dict(pick)  # name/date from the brief is still worth having
                if isinstance(project, dict) and isinstance(project.get("project"), dict): project = project["project"]
                if not isinstance(project, dict): project = dict(pick)
            text = shoot_block(brief, project)
            value = {"name": _one_line(brief.get("name") or customer.get("name"), 120), "text": text,
                     "ideas": len([i for i in (brief.get("ideas") or []) if isinstance(i, dict)]),
                     "storyboards": len((project or {}).get("storyboards") or []),
                     "project": _one_line((project or {}).get("name"), 120),
                     "full": shoot_full(brief, project)}
        ttl = SHOOT_TTL
    except Exception as e:
        sys.stderr.write("shoot day context: %s\n" % str(e)[:200])
        ttl = SHOOT_FAIL_TTL
    with _shoot_lock:
        _shoot_cache[key] = (time.monotonic() + ttl, value)
    return value


def _shoot_when(text):
    """'2026-10-14 10:00' / '14.10.2026, 10.00' -> ('2026-10-14', '10:00' or ''), or None."""
    s = str(text or "").strip()
    m = re.match(r"^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T,]+(\d{1,2})[:.](\d{2}))?", s)
    if m: y, mo, d, h, mi = m.group(1), m.group(2), m.group(3), m.group(4), m.group(5)
    else:
        m = re.match(r"^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[ T,]+(\d{1,2})[:.](\d{2}))?", s)
        if not m: return None
        d, mo, y, h, mi = m.group(1), m.group(2), m.group(3), m.group(4), m.group(5)
    if not (1 <= int(mo) <= 12 and 1 <= int(d) <= 31) or (h is not None and (int(h) > 23 or int(mi) > 59)): return None
    return ("%s-%02d-%02d" % (y, int(mo), int(d)), "%02d:%s" % (int(h), mi) if h is not None else "")


def shoot_customer_list(listing, projects, today=None):
    """[{id, name, company, next: {date, name} | None}] -- today's customers first (by time), then by name."""
    today = today or time.strftime("%Y-%m-%d")
    nxt = {}
    for p in (projects if isinstance(projects, list) else []):
        if not isinstance(p, dict) or not p.get("customerId"): continue
        when = _shoot_when(p.get("date"))
        if not when or when[0] < today: continue
        key = str(p.get("customerId"))
        if key not in nxt or when < nxt[key][0]: nxt[key] = (when, p)
    out = []
    for c in (listing.get("customers") or []):
        if _is_unassigned(c): continue
        hit = nxt.get(str(c.get("id")))
        out.append({"id": str(c.get("id")), "name": _one_line(c.get("name") or c.get("company"), 120),
                    "company": _one_line(c.get("company"), 120),
                    "next": {"date": (hit[0][0] + (" " + hit[0][1] if hit[0][1] else "")), "name": _one_line(hit[1].get("name"), 120)} if hit else None})
    def order(e):
        n = e["next"]
        if n and n["date"][:10] == today: return (0, n["date"], e["name"].lower())
        return (1, "", e["name"].lower())
    return sorted([e for e in out if e["name"]], key=order)


def shoot_customers():
    """The customer list for the glasses' start screen (GET /context/customers); cached 60 s; None on failure."""
    if not SHOOT_URL: return []
    key = (SHOOT_URL, "#customers")
    with _shoot_lock:
        hit = _shoot_cache.get(key)
        if hit and hit[0] > time.monotonic(): return hit[1]
    try:
        deadline = time.monotonic() + SHOOT_TIMEOUT
        listing = _shoot_get("/api/customers", deadline)
        try: projects = _shoot_get("/api/projects", deadline)
        except Exception: projects = {}  # names without dates are still a list
        value = shoot_customer_list(listing, projects.get("projects") if isinstance(projects, dict) else projects)
        ttl = SHOOT_TTL
    except Exception as e:
        sys.stderr.write("shoot day customers: %s\n" % str(e)[:200])
        value, ttl = None, SHOOT_FAIL_TTL
    with _shoot_lock:
        _shoot_cache[key] = (time.monotonic() + ttl, value)
    return value


def shoot_kind(messages):
    """'reply' / 'word' / 'summary' for the companion calls that get the context, else None."""
    for m in messages if isinstance(messages, list) else []:
        if isinstance(m, dict) and m.get("role") == "system" and isinstance(m.get("content"), str):
            for kind, marks in SHOOT_KINDS:
                if any(mark in m["content"] for mark in marks): return kind
    return None


def shoot_inject(d, wanted=""):
    """Adds the customer context to the system prompt of a reply/word/summary call. Returns the kind or None.
    Body field `shoot_context`: true = inject into any call, false = never (removed before the LLM sees it)."""
    force = d.pop("shoot_context", None)
    if force is False or not SHOOT_URL: return None
    messages = d.get("messages")
    if not isinstance(messages, list): return None
    kind = shoot_kind(messages) or ("forced" if force is True else None)
    if not kind: return None
    ctx = shoot_context(wanted)
    if not ctx or not ctx.get("text"): return None
    block = "\n\nGesprächskontext (Kunde):\n" + ctx["text"] + "\n" + SHOOT_INSTRUCTION
    if kind == "reply": block += "\n" + SHOOT_REPLY_INSTRUCTION
    system = next((m for m in messages if isinstance(m, dict) and m.get("role") == "system" and isinstance(m.get("content"), str)), None)
    if system: system["content"] += block
    else: messages.insert(0, {"role": "system", "content": block.strip()})
    return kind

# ---------------------------------------------------------------- Shoot Day feedback (append-only write)
# Only ever: GET the resolved customer's current project, then POST its FULL idea list = all existing ideas
# unchanged + new ones. Nothing is deleted or modified; no other Shoot Day data, never the Brain.
SHOOT_FEEDBACK = (os.environ.get("BABEL_SHOOT_FEEDBACK") or "1").strip() != "0"
FEEDBACK_MAX_CHARS = 12000
FEEDBACK_REPEAT_S = 1800.0
FEEDBACK_KINDS = ("neu", "abgelehnt", "wunsch", "frage")
FEEDBACK_SYSTEM = (
    "Du liest die Mitschrift eines Kundengesprächs über einen Videodreh (Spracherkennung, kann Hörfehler enthalten). "
    "Unten stehen die vorbereiteten Ideen. Ziehe NUR heraus, was im Gespräch wirklich gesagt wurde:\n"
    "- neu: Ideen, die der Kunde statt oder zusätzlich zu den vorbereiteten bevorzugt oder neu einbringt\n"
    "- abgelehnt: vorbereitete Ideen, die der Kunde ablehnt oder anzweifelt (Titel der Idee + kurzer Grund)\n"
    "- wunsch: Änderungen und Wünsche (z. B. Stimmung, Ort, Zeit, Personen, Länge)\n"
    "- frage: offene Fragen, die noch geklärt werden müssen\n"
    "Jeder Eintrag: kurzer deutscher Satz (höchstens 160 Zeichen) und 0-3 kurze Schlagwörter. Nichts erfinden; "
    "fehlt etwas, bleibt die Liste leer. Antworte NUR mit JSON, ohne Erklärung, genau so:\n"
    '{"neu":[{"text":"...","tags":["..."]}],"abgelehnt":[],"wunsch":[],"frage":[]}')
_feedback_seen = {}
_feedback_lock = threading.Lock()
_feedback_seen_lock = threading.Lock()


def _shoot_post(path, body, deadline):
    left = deadline - time.monotonic()
    if left <= 0.02: raise TimeoutError("shoot day deadline")
    headers = {"Accept": "application/json", "Content-Type": "application/json"}
    if SHOOT_TOKEN: headers["Authorization"] = "Bearer " + SHOOT_TOKEN
    req = urllib.request.Request(SHOOT_URL + path, json.dumps(body).encode(), headers, method="POST")
    with urllib.request.urlopen(req, timeout=left) as r:
        return json.loads(r.read(4 * 1024 * 1024) or b"{}")


def feedback_parse(content):
    """[(kind, text, tags)] from the LLM answer; anything malformed = []."""
    if not isinstance(content, str): return []
    text = re.sub(r"<think>.*?</think>", "", content, flags=re.S).strip()
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start: return []
    try: data = json.loads(text[start:end + 1])
    except ValueError: return []
    if not isinstance(data, dict): return []
    out = []
    for kind in FEEDBACK_KINDS:
        items = data.get(kind)
        for item in (items if isinstance(items, list) else [])[:10]:
            if isinstance(item, str): item = {"text": item}
            if not isinstance(item, dict): continue
            body = _one_line(item.get("text"), 200)
            if not body: continue
            raw_tags = item.get("tags") if isinstance(item.get("tags"), list) else []
            tags = [t for t in (re.sub(r"[^\w-]", "", _one_line(x, 30).lstrip("#").lower()) for x in raw_tags[:3] if isinstance(x, str)) if t]
            out.append((kind, body, tags))
    return out


def _norm(text):
    text = re.sub(r"^\s*\d{1,2}\.\d{1,2}\.(\d{2,4})?\s*:\s*", "", str(text or ""))  # our own "14.10.: " prefix
    return " ".join(re.findall(r"\w+", text.lower()))


def _similar(a, b):
    a, b = _norm(a), _norm(b)
    if not a or not b: return False
    if a == b or (min(len(a), len(b)) >= 12 and (a in b or b in a)): return True
    return difflib.SequenceMatcher(None, a, b).ratio() >= 0.85


def _llm_extract(transcript, context_text, model=""):
    system = FEEDBACK_SYSTEM + ("\n\nVorbereitet (Kunde):\n" + context_text if context_text else "")
    body = {"model": FEEDBACK_MODEL or model or _llm_model(), "temperature": 0.1, "max_tokens": 900, "stream": False,
            "chat_template_kwargs": {"enable_thinking": False},
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": transcript}]}
    req = urllib.request.Request(UP + "/v1/chat/completions", json.dumps(body).encode(), {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=180) as r:
        answer = json.loads(r.read() or b"{}")
    return ((answer.get("choices") or [{}])[0].get("message") or {}).get("content") or ""


FEEDBACK_MODEL = os.environ.get("BABEL_SHOOT_FEEDBACK_MODEL", "").strip()
_model_cache = []


def _llm_model():
    """Model id of the upstream (first of /v1/models), cached; '' lets the server pick when it can."""
    if not _model_cache:
        try:
            with urllib.request.urlopen(UP + "/v1/models", timeout=10) as r:
                _model_cache.append(((json.loads(r.read()).get("data") or [{}])[0]).get("id") or "")
        except Exception:
            return ""
    return _model_cache[0]


def feedback_key(transcript, wanted=""):
    return hashlib.sha256(((wanted or "").strip().lower() + "\0" + transcript).encode("utf-8", "replace")).hexdigest()


def feedback_file(transcript, wanted="", now=None, extractor=None, model=""):
    """Extract and append. Returns {'added': [...], 'skipped': n, ...}; raises only on Shoot Day / LLM errors."""
    result = {"added": [], "skipped": 0}
    if not SHOOT_URL or not SHOOT_FEEDBACK: return dict(result, reason="off")
    transcript = (transcript or "").strip()[-FEEDBACK_MAX_CHARS:]
    if not transcript: return dict(result, reason="empty")
    deadline = time.monotonic() + max(SHOOT_TIMEOUT, 5.0)
    listing = _shoot_get("/api/customers", deadline)
    customer = shoot_pick(listing, wanted)
    if not customer: return dict(result, reason="no customer")
    brief = _shoot_get("/api/customers/" + urllib.request.quote(str(customer["id"]), safe="") + "/brief", deadline)
    pick = _project_pick(brief.get("projects") or [], listing.get("active") or "")
    if not pick: return dict(result, reason="no project")
    pid = urllib.request.quote(str(pick["id"]), safe="")
    project = _shoot_get("/api/projects/" + pid, deadline)
    if isinstance(project, dict) and isinstance(project.get("project"), dict): project = project["project"]
    if not isinstance(project, dict) or project.get("id") != pick["id"]: return dict(result, reason="no project")
    if project.get("customerId") not in (None, customer["id"]): return dict(result, reason="no customer")
    items = feedback_parse((extractor or _llm_extract)(transcript, shoot_block(brief, project), model))
    result.update(customer=_one_line(brief.get("name") or customer.get("name"), 120), project=_one_line(project.get("name"), 120))
    if not items: return result
    when = time.localtime(now if now is not None else time.time())
    prefix = time.strftime("%d.%m.: ", when)
    with _feedback_lock:  # the GET-merge-POST must not interleave with another filing from this proxy
        deadline = time.monotonic() + max(SHOOT_TIMEOUT, 5.0)
        project = _shoot_get("/api/projects/" + pid, deadline)
        if isinstance(project, dict) and isinstance(project.get("project"), dict): project = project["project"]
        existing = [i for i in (project.get("ideas") or []) if isinstance(i, dict)] if isinstance(project, dict) else []
        if not isinstance(project, dict) or project.get("id") != pick["id"]: return dict(result, reason="no project")
        known = [str(i.get("text") or "") for i in existing]
        new = []
        for kind, text, tags in items:
            label = text if kind != "abgelehnt" or text.lower().startswith("abgelehnt") else "Abgelehnt: " + text
            # a rejection names a prepared idea, so it is only a duplicate of an earlier rejection
            pool = [k for k in known if _norm(k).startswith("abgelehnt")] if kind == "abgelehnt" else known
            if any(_similar(label, k) for k in pool) or len(existing) + len(new) >= 500:
                result["skipped"] += 1; continue
            known.append(label)
            new.append({"text": prefix + label, "tags": ["gespraech", kind] + [t for t in tags if t not in ("gespraech", kind)][:3]})
        if new:
            answer = _shoot_post("/api/projects/" + pid + "/ideas", {"ideas": existing + new}, deadline)
            stored = answer.get("ideas") if isinstance(answer, dict) else None
            if not isinstance(stored, list) or len(stored) < len(existing) + len(new):
                raise RuntimeError("shoot day did not keep all ideas")
            with _shoot_lock: _shoot_cache.clear()
        result["added"] = [n["text"] for n in new]
    return result


def feedback_once(transcript, wanted="", now=None, model=""):
    """feedback_file, but at most once per transcript hash within 30 min (a failure frees the hash again)."""
    key = feedback_key((transcript or "").strip()[-FEEDBACK_MAX_CHARS:], wanted)
    t = time.monotonic() if now is None else now
    with _feedback_seen_lock:
        for k in [k for k, v in _feedback_seen.items() if t - v > FEEDBACK_REPEAT_S]: del _feedback_seen[k]
        if key in _feedback_seen: return {"added": [], "skipped": 0, "duplicate": True}
        _feedback_seen[key] = t
    try:
        return feedback_file(transcript, wanted, model=model)
    except Exception:
        with _feedback_seen_lock: _feedback_seen.pop(key, None)
        raise


def summary_transcript(messages):
    """The conversation text of a summary call: everything but the system prompt. The glasses' own tip cards
    (appended after CUE_SUMMARY_MARKS) are advice, not something the customer said: they never reach the filing."""
    text = "\n".join(m["content"] for m in messages if isinstance(m, dict) and m.get("role") != "system"
                     and isinstance(m.get("content"), str))
    for mark in CUE_SUMMARY_MARKS:
        at = text.find(mark)
        if at >= 0: text = text[:at]
    return text.strip()


def feedback_background(transcript, wanted="", model=""):
    def run():
        try:
            r = feedback_once(transcript, wanted, model=model)
            if r.get("added"): sys.stderr.write("shoot day feedback: %d idea(s) added\n" % len(r["added"]))
        except Exception as e:
            sys.stderr.write("shoot day feedback: %s\n" % str(e)[:200])
    t = threading.Thread(target=run, daemon=True, name="shoot-feedback"); t.start()
    return t

# ---------------------------------------------------------------- talk record (summary + tip cards → Shoot Day)
# One append per summary: POST /api/projects/<id>/talks {at, summary, cues}. Nothing else is written.
SHOOT_TALKS = (os.environ.get("BABEL_SHOOT_TALKS") or "1").strip() != "0"
TALK_SUMMARY_MAX = 8000
_talk_seen = {}
_talk_seen_lock = threading.Lock()


def shoot_target(wanted, deadline):
    """(customer, project_id) for `wanted` or Shoot Day's active customer, like the feedback filing; None = nowhere."""
    listing = _shoot_get("/api/customers", deadline)
    customer = shoot_pick(listing, wanted)
    if not customer: return None
    brief = _shoot_get("/api/customers/" + urllib.request.quote(str(customer["id"]), safe="") + "/brief", deadline)
    pick = _project_pick(brief.get("projects") or [], listing.get("active") or "")
    if not pick or not pick.get("id"): return None
    return customer, str(pick["id"])


def summary_cards(messages):
    """The app's tip cards from a summary call (the block after CUE_SUMMARY_MARKS): [{title, text, kind}].
    Each line looks like "- 10:02 Color Codes präzise anfordern: Frage nach HEX/RGB"."""
    text = "\n".join(m["content"] for m in (messages or []) if isinstance(m, dict) and m.get("role") != "system"
                     and isinstance(m.get("content"), str))
    block = ""
    for mark in CUE_SUMMARY_MARKS:
        at = text.find(mark)
        if at >= 0:
            block = text[at + len(mark):]
            break
    cards = []
    for line in block.split("\n")[1:]:
        line = line.strip()
        if not line.startswith("- "):
            if cards and line == "": continue
            if line: break
            continue
        body = re.sub(r"^\d{1,2}:\d{2}\s+", "", line[2:].strip())
        title, sep, rest = body.partition(": ")
        if not sep: title, rest = "", body
        title, rest = _one_line(title, 80), _one_line(rest, 300)
        if title or rest: cards.append({"title": title, "text": rest, "kind": "tipp"})
        if len(cards) >= 30: break
    return cards


def summary_text(content):
    """Readable text from the summary answer ({kurz, lang, abmachungen} JSON, or plain text)."""
    if not isinstance(content, str): return ""
    raw = re.sub(r"<think>.*?</think>", "", content, flags=re.S).strip()
    start, end = raw.find("{"), raw.rfind("}")
    data = None
    if start >= 0 and end > start:
        try: data = json.loads(raw[start:end + 1])
        except ValueError: data = None
    if not isinstance(data, dict): return raw[:TALK_SUMMARY_MAX]
    main = str(data.get("lang") or data.get("kurz") or data.get("summary") or "").strip()
    deals = str(data.get("abmachungen") or "").strip()
    out = main + ("\n\nAbmachungen:\n" + deals if deals else "")
    return out.strip()[:TALK_SUMMARY_MAX]


def talk_post(summary, cards, wanted="", at_ms=None):
    """Appends one talk to the customer's current project. Returns {'posted': bool, ...}; raises on Shoot Day errors."""
    if not SHOOT_URL or not SHOOT_TALKS: return {"posted": False, "reason": "off"}
    summary = (summary or "").strip()[:TALK_SUMMARY_MAX]
    if not summary and not cards: return {"posted": False, "reason": "empty"}
    deadline = time.monotonic() + max(SHOOT_TIMEOUT, 5.0)
    target = shoot_target(wanted, deadline)
    if not target: return {"posted": False, "reason": "no customer"}
    _customer, pid = target
    body = {"at": int(at_ms if at_ms is not None else time.time() * 1000), "summary": summary, "cues": cards[:30]}
    answer = _shoot_post("/api/projects/" + urllib.request.quote(pid, safe="") + "/talks", body, deadline)
    if not isinstance(answer, dict) or answer.get("ok") is not True: raise RuntimeError("shoot day did not store the talk")
    return {"posted": True, "project": pid}


def talk_once(summary, cards, wanted="", now=None):
    """talk_post at most once per (customer, summary) within 30 min; a failure frees it again."""
    key = feedback_key(json.dumps([summary, cards], ensure_ascii=False), wanted)
    t = time.monotonic() if now is None else now
    with _talk_seen_lock:
        for k in [k for k, v in _talk_seen.items() if t - v > FEEDBACK_REPEAT_S]: del _talk_seen[k]
        if key in _talk_seen: return {"posted": False, "duplicate": True}
        _talk_seen[key] = t
    try:
        return talk_post(summary, cards, wanted)
    except Exception:
        with _talk_seen_lock: _talk_seen.pop(key, None)
        raise


def talk_background(content, cards, wanted=""):
    def run():
        try:
            r = talk_once(summary_text(content), cards, wanted)
            if r.get("posted"): sys.stderr.write("shoot day talk: posted\n")
        except Exception as e:
            sys.stderr.write("shoot day talk: %s\n" % str(e)[:200])
    t = threading.Thread(target=run, daemon=True, name="shoot-talk"); t.start()
    return t

# ---------------------------------------------------------------- live tip cards (Kundengespräch)
# Read-only: one short LLM call over the last minutes of the conversation, with the customer block when there is one.
CUE_TIMEOUT = float(os.environ.get("BABEL_CUE_TIMEOUT") or "6")
CUE_TRANSCRIPT_MAX = 6000
CUE_TITLE_MAX = 40
CUE_TEXT_MAX = 140
CUE_KINDS = ("tipp", "begriff", "fakt", "achtung")
# The app appends its cards to the summary call under one of these headings (summary_transcript cuts there).
CUE_SUMMARY_MARKS = ("\n\nTipp-Karten während des Gesprächs", "\n\nTip cards during the conversation")
CUE_SYSTEM = (
    "Du unterstützt live den Träger einer Datenbrille: den Inhaber einer Video- und Fotoagentur im Gespräch mit "
    "einem Kunden. Unten steht der letzte Teil der Mitschrift (Spracherkennung, kann Hörfehler enthalten). "
    "Gib HÖCHSTENS EINE kurze Karte, und nur wenn sie dem Träger JETZT wirklich hilft:\n"
    "- tipp: konkreter Rat, was er jetzt fragen oder klären sollte (z. B. \"Color Codes präzise anfordern\")\n"
    "- begriff: Klärung eines gerade gesagten Begriffs oder Hörfehlers (z. B. \"Gemeint: Corporate Identity (CI)\")\n"
    "- fakt: kurze Rechnung oder Tatsache (z. B. \"Bis Ende Nov: ~6,5 Wochen\")\n"
    "- achtung: rechtlicher oder praktischer Hinweis, vorsichtig formuliert (\"meist\", \"in der Regel\")\n"
    "Deutsch. Titel höchstens 40 Zeichen, Text ein Satz mit höchstens 140 Zeichen. Erfinde nichts über den Kunden; "
    "allgemeines Wissen ist erlaubt. Wiederhole nichts, was schon gezeigt wurde. Ist nichts wirklich hilfreich, "
    "antworte {\"none\":true}. Antworte NUR mit JSON, ohne Erklärung, genau so:\n"
    '{"title":"...","text":"...","kind":"tipp|begriff|fakt|achtung"}')


def _recent_titles(value):
    return [_one_line(t, 80) for t in (value if isinstance(value, list) else [])[:50] if isinstance(t, str) and t.strip()]


def cue_parse(content, recent=()):
    """{'title', 'text', 'kind'} from the LLM answer, or None (none, malformed, empty or a repeat)."""
    if not isinstance(content, str): return None
    text = re.sub(r"<think>.*?</think>", "", content, flags=re.S).strip()
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start: return None
    try: data = json.loads(text[start:end + 1])
    except ValueError: return None
    if not isinstance(data, dict) or data.get("none") is True: return None
    title = _one_line(data.get("title"), CUE_TITLE_MAX)
    body = _one_line(data.get("text"), CUE_TEXT_MAX)
    if not title or not body: return None
    kind = str(data.get("kind") or "").strip().lower()
    if kind not in CUE_KINDS: kind = "tipp"
    if any(_similar(title, r) for r in recent): return None
    return {"title": title, "text": body, "kind": kind}


def _llm_cue(system, transcript, model, timeout):
    body = {"model": model or _llm_model(), "temperature": 0.3, "max_tokens": 120, "stream": False,
            "chat_template_kwargs": {"enable_thinking": False},
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": transcript}]}
    req = urllib.request.Request(UP + "/v1/chat/completions", json.dumps(body).encode(), {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        answer = json.loads(r.read() or b"{}")
    return ((answer.get("choices") or [{}])[0].get("message") or {}).get("content") or ""


def _is_timeout(e):
    return isinstance(e, TimeoutError) or isinstance(getattr(e, "reason", None), TimeoutError) or "timed out" in str(e)


def cue_request(transcript, wanted="", recent=(), model="", llm=None, timeout=None):
    """One card dict or None. Raises TimeoutError past the cap; other LLM errors as they come."""
    deadline = time.monotonic() + (CUE_TIMEOUT if timeout is None else timeout)
    transcript = (transcript or "").strip()[-CUE_TRANSCRIPT_MAX:]
    if not transcript: return None
    recent = _recent_titles(list(recent) if isinstance(recent, (list, tuple)) else [])
    system = CUE_SYSTEM
    ctx = None
    try: ctx = shoot_context(wanted) if SHOOT_URL else None
    except Exception as e: sys.stderr.write("shoot day cue context: %s\n" % str(e)[:200])
    if ctx and ctx.get("text"):
        system += "\n\nGesprächskontext (Kunde):\n" + ctx["text"] + "\n" + SHOOT_INSTRUCTION
    if recent:
        system += "\n\nSchon gezeigt (nicht wiederholen): " + " | ".join(recent[:20])
    left = deadline - time.monotonic()
    if left <= 0.05: raise TimeoutError("cue deadline")
    try:
        content = (llm or _llm_cue)(system, transcript, model, left)
    except Exception as e:
        if _is_timeout(e): raise TimeoutError("cue timeout") from e
        raise
    if time.monotonic() > deadline + 0.5: raise TimeoutError("cue deadline")
    return cue_parse(content, recent)

# ---------------------------------------------------------------- HTTP


class H(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Babel-Customer")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Max-Age", "600")
    def _send(self, code, body, ct="application/json"):
        self.send_response(code); self._cors()
        if code != 204:  # a 204 must not carry a body (iOS drops the answer otherwise)
            self.send_header("Content-Type", ct); self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if code != 204: self.wfile.write(body)
    def _json(self, code, value):
        self._send(code, json.dumps(value, ensure_ascii=False).encode())
    def _auth(self):
        if not TOKEN: return True
        peer = str(self.client_address[0]).replace("::ffff:", "")
        if peer in ("127.0.0.1", "::1") and (self.headers.get("Tailscale-User-Login") or "").strip().lower() in TS_USERS: return True
        return self.headers.get("Authorization") == "Bearer " + TOKEN
    def _memory_path(self):
        """'' for /memory, '<rest>' for /memory/<rest>, None when it is no memory route (/v1/memory too)."""
        path = urlsplit(self.path).path.rstrip("/")
        for prefix in ("/memory", "/v1/memory"):
            if path == prefix: return ""
            if path.startswith(prefix + "/"): return unquote(path[len(prefix) + 1:])
        return None
    def _body(self, limit=None):
        n = int(self.headers.get("Content-Length", 0) or 0)
        if limit is not None and n > limit: raise ValueError("too large")
        return json.loads(self.rfile.read(n) or b"{}")
    def do_OPTIONS(self): self._send(204, b"")
    def do_GET(self):
        if not self._auth(): return self._send(401, b'{"error":"unauthorized"}')
        mem = self._memory_path()
        if mem == "":
            try: limit = int((parse_qs(urlsplit(self.path).query).get("limit") or ["100"])[0])
            except ValueError: limit = 100
            limit = min(max(limit, 1), MEMORY_CAP)
            return self._json(200, {"memory": True, "entries": [_public(e) for e in memory_list(MEMORY_FILE, limit)]})
        route = urlsplit(self.path).path.rstrip("/")
        if route in ("/context/customers", "/v1/context/customers"):
            # Read-only list for the glasses' start screen (Babel 0.7.0): names and the next project only.
            found = shoot_customers() if SHOOT_URL else []
            if found is None: return self._json(502, {"context": True, "enabled": True, "error": "shoot day unreachable", "customers": []})
            return self._json(200, {"context": True, "enabled": bool(SHOOT_URL), "customers": found})
        if route in ("/context/customer", "/v1/context/customer"):
            wanted = (parse_qs(urlsplit(self.path).query).get("customer") or [""])[0] or self.headers.get("X-Babel-Customer") or ""
            ctx = (shoot_context(wanted) if SHOOT_URL else None) or {}
            out = {"context": True, "enabled": bool(SHOOT_URL), "name": ctx.get("name", ""),
                   "project": ctx.get("project", ""), "chars": len(ctx.get("text", "")),
                   "ideas": ctx.get("ideas", 0), "storyboards": ctx.get("storyboards", 0)}
            if (parse_qs(urlsplit(self.path).query).get("full") or [""])[0] in ("1", "true", "yes"):
                # Read-only lists for the "Kunde" page on the glasses (0.6.2); still no prompt text.
                # With full=1, `ideas`/`storyboards` are the lists themselves (counts = their lengths).
                full = ctx.get("full") or {}
                out["full"] = True
                for k, empty in (("date", ""), ("place", ""), ("ideas", []), ("storyboards", []), ("slogans", [])):
                    out[k] = full.get(k, empty)
            return self._json(200, out)
        if self.path.rstrip("/") not in ("/v1/models",): return self._send(404, b"{}")
        self._send(200, urllib.request.urlopen(UP + "/v1/models", timeout=10).read())
    def do_DELETE(self):
        if not self._auth(): return self._send(401, b'{"error":"unauthorized"}')
        mem = self._memory_path()
        if mem is None or mem == "search": return self._send(404, b"{}")
        if mem == "": return self._json(200, {"memory": True, "deleted": memory_clear(MEMORY_FILE)})
        if memory_delete(MEMORY_FILE, mem): return self._json(200, {"memory": True, "deleted": 1})
        return self._json(404, {"memory": True, "error": "not found"})
    def _memory_post(self, mem):
        try:
            d = self._body(MEMORY_BODY_MAX)
        except ValueError:
            return self._json(400, {"memory": True, "error": "invalid json"})
        if mem == "search":
            query = d.get("query") if isinstance(d, dict) and isinstance(d.get("query"), str) else ""
            try: limit = min(max(int(d.get("limit", 3)), 1), 20)
            except (TypeError, ValueError): limit = 3
            hits = memory_search(memory_load(MEMORY_FILE), query[:2000], limit)
            return self._json(200, {"memory": True, "entries": [_public(e) for e in hits]})
        if mem != "": return self._send(404, b"{}")
        entry = memory_add(MEMORY_FILE, d)
        if entry is None: return self._json(400, {"memory": True, "error": "empty"})
        return self._json(200, {"memory": True, "entry": _public(entry)})
    def do_POST(self):
        if not self._auth(): return self._send(401, b'{"error":"unauthorized"}')
        mem = self._memory_path()
        if mem is not None: return self._memory_post(mem)
        if urlsplit(self.path).path.rstrip("/") in ("/context/feedback", "/v1/context/feedback"): return self._feedback_post()
        if urlsplit(self.path).path.rstrip("/") in ("/context/cue", "/v1/context/cue"): return self._cue_post()
        if not self.path.rstrip("/").endswith("/chat/completions"): return self._send(404, b"{}")
        try:
            d = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        except ValueError:
            return self._send(400, b'{"error":"invalid json"}')
        if not isinstance(d, dict): return self._send(400, b'{"error":"invalid json"}')
        wanted = d.pop("customer", None)
        wanted = wanted if isinstance(wanted, str) else (self.headers.get("X-Babel-Customer") or "")
        kind = None
        try: kind = shoot_inject(d, wanted)
        except Exception as e: sys.stderr.write("shoot day inject: %s\n" % str(e)[:200])  # never break Babel
        transcript, model, cards = "", "", None
        if kind == "summary" and SHOOT_FEEDBACK:  # file the conversation's feedback once the summary is answered
            try:
                transcript = summary_transcript(d.get("messages") or [])
                model = d.get("model") if isinstance(d.get("model"), str) else ""
            except Exception as e:
                sys.stderr.write("shoot day feedback: %s\n" % str(e)[:200])
        if kind == "summary" and SHOOT_TALKS:  # and record the talk (summary + tip cards) on the project
            try: cards = summary_cards(d.get("messages") or [])
            except Exception as e: sys.stderr.write("shoot day talk: %s\n" % str(e)[:200])
        content = ""
        try:
            content = self._chat(d)
        finally:
            if transcript:
                try: feedback_background(transcript, wanted, model)
                except Exception as e: sys.stderr.write("shoot day feedback: %s\n" % str(e)[:200])
            if cards is not None and content:
                try: talk_background(content, cards, wanted)
                except Exception as e: sys.stderr.write("shoot day talk: %s\n" % str(e)[:200])
    def _feedback_post(self):
        try:
            d = self._body(MEMORY_BODY_MAX)
        except ValueError:
            return self._json(400, {"error": "invalid json"})
        if not isinstance(d, dict) or not isinstance(d.get("transcript"), str) or not d["transcript"].strip():
            return self._json(400, {"error": "transcript missing"})
        if not SHOOT_URL or not SHOOT_FEEDBACK: return self._json(503, {"error": "shoot day feedback off"})
        wanted = d.get("customer") if isinstance(d.get("customer"), str) else (self.headers.get("X-Babel-Customer") or "")
        model = d.get("model") if isinstance(d.get("model"), str) else ""
        try:
            result = feedback_once(d["transcript"], wanted, model=model)
        except Exception as e:
            sys.stderr.write("shoot day feedback: %s\n" % str(e)[:200])
            return self._json(502, {"error": "feedback failed", "added": [], "skipped": 0})
        return self._json(200, result)
    def _cue_post(self):
        """Live tip card: 200 {cue: {title, text, kind}} or 200 {none: true}; 504/502 with none on timeout/LLM failure."""
        try:
            d = self._body(MEMORY_BODY_MAX)
        except ValueError:
            return self._json(400, {"error": "invalid json"})
        if not isinstance(d, dict) or not isinstance(d.get("transcript"), str) or not d["transcript"].strip():
            return self._json(400, {"error": "transcript missing"})
        wanted = d.get("customer") if isinstance(d.get("customer"), str) else (self.headers.get("X-Babel-Customer") or "")
        model = d.get("model") if isinstance(d.get("model"), str) else ""
        try:
            card = cue_request(d["transcript"], wanted, d.get("recent_titles") if isinstance(d.get("recent_titles"), list) else [], model=model)
        except TimeoutError:
            return self._json(504, {"none": True, "error": "timeout"})
        except Exception as e:
            sys.stderr.write("cue: %s\n" % str(e)[:200])
            return self._json(502, {"none": True, "error": "llm failed"})
        return self._json(200, {"cue": card} if card else {"none": True})
    def _chat(self, d):
        """Forwards the call; returns the answer's text content ("" on errors) for the talk record."""
        stream = d.get("stream") is True
        d["stream"] = stream; d.setdefault("max_tokens", 300)
        d.setdefault("chat_template_kwargs", {})["enable_thinking"] = False
        req = urllib.request.Request(UP + "/v1/chat/completions", json.dumps(d).encode(), {"Content-Type": "application/json"})
        try:
            # timeout = longest wait for the next bytes (prompt processing of a long transcript included)
            r = urllib.request.urlopen(req, timeout=180)
        except urllib.error.HTTPError as e:
            self._send(e.code, e.read() or b"{}"); return ""
        except Exception as e:
            self._send(502, json.dumps({"error": str(e)}).encode()); return ""
        if not stream:
            try:
                raw = r.read()
                self._send(200, raw)
            except Exception as e:
                self._send(502, json.dumps({"error": str(e)}).encode()); return ""
            finally: r.close()
            try: return ((json.loads(raw or b"{}").get("choices") or [{}])[0].get("message") or {}).get("content") or ""
            except Exception: return 
        # SSE pass-through: no Content-Length, end = connection close (HTTP/1.0); each line is
        # written and flushed as it arrives so nothing waits in a buffer.
        self.send_response(200); self._cors()
        self.send_header("Content-Type", r.headers.get("Content-Type") or "text/event-stream")
        self.send_header("Cache-Control", "no-cache, no-transform")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("Connection", "close")
        self.end_headers(); self.close_connection = True
        pieces = []
        try:
            while True:
                line = r.readline()
                if not line: break
                if line.startswith(b"data:") and len(pieces) < 20000:
                    try:
                        delta = (json.loads(line[5:].strip()).get("choices") or [{}])[0].get("delta") or {}
                        if isinstance(delta.get("content"), str): pieces.append(delta["content"])
                    except Exception:
                        pass  # [DONE] and anything else that is not a JSON chunk
                self.wfile.write(line); self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pieces.clear()  # the glasses went away; closing upstream below stops the generation
        except Exception as e:
            pieces.clear()  # an answer cut off midway is no summary to record
            try: self.wfile.write(("data: " + json.dumps({"error": {"message": str(e)[:200]}}) + "\n\n").encode()); self.wfile.flush()
            except Exception: pass
        finally:
            r.close()
        return "".join(pieces)
    def log_message(self, *a): pass

# ---------------------------------------------------------------- self test


def selftest():
    import tempfile
    global TOKEN, MEMORY_FILE, TS_USERS
    ok = True

    def check(name, condition):
        nonlocal ok
        print(("OK   " if condition else "FEHL ") + name)
        ok = ok and bool(condition)

    folder = tempfile.mkdtemp()
    path = os.path.join(folder, "m.json")
    check("leere Datei = leere Liste", memory_list(path) == [])
    a = memory_add(path, {"type": "session", "title": "Wärmepumpe Huber", "summary": "Angebot für eine Wärmepumpe besprochen.",
                          "agreements": ["Abnahme Dienstag 10 Uhr", "", 5]})
    check("Eintrag angelegt", a and len(a["id"]) == 16 and a["agreements"] == ["Abnahme Dienstag 10 Uhr"] and a["type"] == "session")
    check("leerer Eintrag abgelehnt", memory_add(path, {"title": " ", "summary": ""}) is None)
    n = memory_add(path, {"type": "note", "summary": "Kunde Huber mag keine Anrufe vor 9."})
    check("Notiz bekommt Titel aus Text", n["type"] == "note" and n["title"].startswith("Kunde Huber"))
    check("Datei nur fuer Besitzer", os.name == "nt" or (os.stat(path).st_mode & 0o077) == 0)
    check("keine Temp-Datei uebrig", not os.path.exists(path + ".tmp"))
    check("neueste zuerst", [e["id"] for e in memory_list(path)] == [n["id"], a["id"]])
    memory_add(path, {"title": "Fahrrad", "summary": "Reparatur der Bremse, Kette neu."})
    hits = memory_search(memory_load(path), "Was war mit der Wärmepumpe und Dienstag?", 3)
    check("Suche findet passenden Eintrag zuerst", hits and hits[0]["id"] == a["id"] and hits[0]["score"] > 0)
    check("Suche ohne Treffer leer", memory_search(memory_load(path), "Quantenphysik Raumfahrt", 3) == [])
    check("einfache Wortformen", tokens("Ziegeln Ziegel Pumpen Pumpe") == ["ziegel", "ziegel", "pump", "pump"])
    check("nur Stoppwoerter = leer", memory_search(memory_load(path), "der die das und", 3) == [])
    for i in range(7):
        memory_add(path, {"title": "t%d" % i, "summary": "s"}, cap=5)
    check("Obergrenze haelt die neuesten", len(memory_load(path)) == 5 and memory_list(path)[0]["title"] == "t6")
    card = cue_parse('{"title":"Color Codes präzise anfordern","text":"Frage nach HEX/RGB und CMYK/Pantone.","kind":"tipp"}')
    check("Tipp-Karte gelesen", card == {"title": "Color Codes präzise anfordern", "text": "Frage nach HEX/RGB und CMYK/Pantone.", "kind": "tipp"})
    check("Tipp-Karte none / kaputt = None", cue_parse('{"none":true}') is None and cue_parse("kein json") is None)
    check("Tipp-Karte Wiederholung = None", cue_parse('{"title":"Color Codes präzise anfordern","text":"x","kind":"tipp"}', ["Color Codes präzise anfordern"]) is None)
    with open(path, "w") as f: f.write("{kaputt")
    check("kaputte Datei = leer, kein Absturz", memory_load(path) == [])

    # Over HTTP, with the same auth as the chat endpoint.
    saved = (TOKEN, MEMORY_FILE, TS_USERS)
    TOKEN, MEMORY_FILE, TS_USERS = "geheim", os.path.join(folder, "http.json"), []
    server = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = "http://127.0.0.1:%d" % server.server_address[1]

    def req(method, path, body=None, token="geheim"):
        headers = {"Content-Type": "application/json"} if body is not None else {}
        if token: headers["Authorization"] = "Bearer " + token
        r = urllib.request.Request(base + path, json.dumps(body).encode() if body is not None else None, headers, method=method)
        try:
            with urllib.request.urlopen(r, timeout=5) as resp:
                raw = resp.read(); return resp.status, (json.loads(raw) if raw else None), resp.headers
        except urllib.error.HTTPError as e:
            raw = e.read(); return e.code, (json.loads(raw) if raw else None), e.headers

    try:
        code, body, headers = req("OPTIONS", "/memory", token=None)
        check("Preflight 204 ohne Body, DELETE erlaubt", code == 204 and body is None and "DELETE" in headers.get("Access-Control-Allow-Methods", ""))
        check("ohne Token 401", req("GET", "/memory", token=None)[0] == 401)
        check("falsches Token 401", req("POST", "/memory", {"title": "x"}, token="falsch")[0] == 401)
        code, body, _ = req("POST", "/memory", {"type": "session", "title": "Angebot Dach", "summary": "Dachsanierung, Ziegel rot.", "agreements": ["Angebot bis Freitag"]})
        check("POST /memory legt an", code == 200 and body["memory"] is True and body["entry"]["title"] == "Angebot Dach")
        first = body["entry"]["id"]
        code, body, _ = req("POST", "/v1/memory", {"type": "note", "title": "Notiz", "summary": "Rückruf Montag"})
        check("auch unter /v1/memory", code == 200)
        code, body, _ = req("GET", "/memory?limit=1")
        check("GET ?limit=1", code == 200 and len(body["entries"]) == 1 and body["entries"][0]["title"] == "Notiz")
        code, body, _ = req("POST", "/memory/search", {"query": "Wie war das mit den Ziegeln fürs Dach?", "limit": 3})
        check("Suche ueber HTTP", code == 200 and body["entries"] and body["entries"][0]["id"] == first)
        check("leerer Eintrag 400", req("POST", "/memory", {"title": ""})[0] == 400)
        check("unbekannte ID 404", req("DELETE", "/memory/gibtsnicht")[0] == 404)
        code, body, _ = req("DELETE", "/memory/" + first)
        check("DELETE /memory/<id>", code == 200 and body["deleted"] == 1 and len(req("GET", "/memory")[1]["entries"]) == 1)
        code, body, _ = req("DELETE", "/memory")
        check("DELETE /memory loescht alles", code == 200 and req("GET", "/memory")[1]["entries"] == [])
        check("Datei nur fuer Besitzer (HTTP)", os.name == "nt" or (os.stat(MEMORY_FILE).st_mode & 0o077) == 0)
        check("andere Pfade 404", req("GET", "/irgendwas")[0] == 404)
        check("Tipp-Karte ohne Mitschrift 400", req("POST", "/context/cue", {"transcript": " "})[0] == 400)
        check("Tipp-Karte ohne Token 401", req("POST", "/context/cue", {"transcript": "x"}, token=None)[0] == 401)
        TOKEN = ""
        check("ohne TOKEN offen wie bisher", req("GET", "/memory", token=None)[0] == 200)
    finally:
        server.shutdown(); server.server_close()
        TOKEN, MEMORY_FILE, TS_USERS = saved
    print("alles gruen" if ok else "FEHLER")
    return ok


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        sys.exit(0 if selftest() else 1)
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
