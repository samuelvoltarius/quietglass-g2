#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
androidtv-bridge - a tiny reference bridge between TV Glance (Even G2) and an
Android TV / Google TV, for people without Home Assistant.

It talks to the TV with the `androidtvremote2` library (the protocol of the
Google TV remote app: pairing with the 6-digit code the TV shows, then key
events, app launches and the TV's state) and offers the glasses a small HTTP
API with CORS:

    GET  /health                   alive, no login, no data
    GET  /state                    {"name", "on", "app", "app_label", "volume", "muted", "apps", "connected"}
    POST /key    {"key": "..."}    DPAD_UP DPAD_DOWN DPAD_LEFT DPAD_RIGHT DPAD_CENTER BACK HOME
                                   MEDIA_PLAY_PAUSE VOLUME_UP VOLUME_DOWN VOLUME_MUTE
    POST /app    {"app": "..."}    a package name (com.netflix.ninja) or an app link
    POST /power  {"on": true}      on/off; POWER is only sent when the TV is not already there.
                                   Without "on" the power key toggles.

POST bodies are JSON; the glasses send them as text/plain (a CORS "simple
request" - no preflight behind tailscale serve). OPTIONS is answered with
204 and NO body (iOS/WebKit drops a 204 with a body).

Login, like the other Quietglass bridges:
  * `tailscale serve` connects from loopback and sets `Tailscale-User-Login`;
    the header is trusted ONLY from loopback and ONLY for logins listed in
    BRIDGE_TAILSCALE_USERS. The app then needs no token.
  * or `Authorization: Bearer <BRIDGE_TOKEN>` (LAN use, curl).
  Without either, every request except /health is refused.

Environment:
    TV_HOST                  IP address or host name of the TV (required to serve or pair)
    TV_CERT_DIR              where the client certificate lives (default ~/.config/tv-glance-bridge)
    TV_CLIENT_NAME           name the TV shows for this remote (default "TV Glance bridge")
    TV_LABEL                 name shown on the glasses (default: the TV's model)
    TV_APPS                  apps offered on the glasses, "Label=package;Label=package"
    BRIDGE_HOST / BRIDGE_PORT   default 127.0.0.1:8477 (put tailscale serve or a LAN bind in front)
    BRIDGE_TOKEN             bearer token (optional with tailscale serve)
    BRIDGE_TAILSCALE_USERS   comma-separated Tailscale logins allowed through tailscale serve
    BRIDGE_ORIGINS           comma-separated exact origins for CORS; empty = echo the caller's origin

Usage:
    pip install androidtvremote2
    TV_HOST=192.168.1.50 python3 androidtv-bridge.py --pair     # once: enter the code the TV shows
    TV_HOST=192.168.1.50 BRIDGE_TOKEN=... python3 androidtv-bridge.py
    python3 androidtv-bridge.py --selftest                     # fake TV, no network, no library needed

Tokens are never logged. Python 3.8+.
"""

import asyncio
import concurrent.futures
import hmac
import json
import os
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = "0.1.0"
LOOPBACK = ("127.0.0.1", "::1", "::ffff:127.0.0.1")
MAX_BODY = 2048

KEYS = (
    "DPAD_UP", "DPAD_DOWN", "DPAD_LEFT", "DPAD_RIGHT", "DPAD_CENTER", "BACK", "HOME",
    "MEDIA_PLAY_PAUSE", "VOLUME_UP", "VOLUME_DOWN", "VOLUME_MUTE",
)
# A package name, or an app link (scheme + something), no whitespace.
APP_RE = re.compile(r"^(?:[A-Za-z][\w]*(?:\.[\w]+)+|[a-z][a-z0-9+.-]*:[^\s]{1,280})$")


def _env(name, default=""):
    return os.environ.get(name, default).strip()


def parse_apps(text):
    """'YouTube=com.google.android.youtube.tv;Kodi=org.xbmc.kodi' -> [{"label", "id"}]."""
    out = []
    for raw in re.split(r"[;\n]", text or ""):
        item = raw.strip()
        if not item:
            continue
        label, _, ident = item.partition("=")
        label, ident = label.strip(), ident.strip()
        if not ident:
            label, ident = item, item
        if label and ident and all(a["id"] != ident for a in out):
            out.append({"label": label[:40], "id": ident[:300]})
    return out[:20]


def volume_percent(info):
    """androidtvremote2 volume_info {'level', 'max', 'muted'} -> 0..100 or None."""
    if not isinstance(info, dict):
        return None
    level, top = info.get("level"), info.get("max")
    if not isinstance(level, (int, float)) or not isinstance(top, (int, float)) or top <= 0:
        return None
    return max(0, min(100, int(round(level * 100.0 / top))))


class Config(object):
    def __init__(self, token="", users=(), apps=(), origins=(), label=""):
        self.token = token
        self.users = {u.strip().lower() for u in users if u.strip()}
        self.apps = list(apps)
        self.origins = [o.strip() for o in origins if o.strip()]
        self.label = label

    @classmethod
    def from_env(cls):
        return cls(
            token=_env("BRIDGE_TOKEN"),
            users=_env("BRIDGE_TAILSCALE_USERS").split(","),
            apps=parse_apps(_env("TV_APPS")),
            origins=_env("BRIDGE_ORIGINS").split(","),
            label=_env("TV_LABEL"),
        )

    @property
    def open_for_anyone(self):
        return not self.token and not self.users


# ---------------------------------------------------------------------------
# The TV
# ---------------------------------------------------------------------------

class RealTv(object):
    """androidtvremote2 on its own asyncio loop in a background thread."""

    def __init__(self, host, certfile, keyfile, client_name):
        from androidtvremote2 import AndroidTVRemote  # imported only when a real TV is used

        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(target=self.loop.run_forever, name="androidtvremote2", daemon=True)
        self.thread.start()
        # The library would take the running loop by default; this thread has none, so hand it ours.
        self.remote = AndroidTVRemote(client_name, certfile, keyfile, host, loop=self.loop)
        asyncio.run_coroutine_threadsafe(self._start(), self.loop).result(60)

    async def _start(self):
        await self.remote.async_generate_cert_if_missing()
        await self.remote.async_connect()
        # Reconnects by itself after the TV sleeps or the network drops.
        self.remote.keep_reconnecting()

    def _on_loop(self, fn, *args):
        done = concurrent.futures.Future()

        def run():
            try:
                done.set_result(fn(*args))
            except Exception as error:  # noqa: BLE001 - handed to the HTTP thread
                done.set_exception(error)

        self.loop.call_soon_threadsafe(run)
        return done.result(10)

    def state(self):
        def read():
            info = self.remote.device_info or {}
            return {
                "on": self.remote.is_on,
                "app": self.remote.current_app,
                "volume_info": self.remote.volume_info,
                "model": info.get("model") if isinstance(info, dict) else None,
            }
        return self._on_loop(read)

    def key(self, name):
        self._on_loop(self.remote.send_key_command, name)

    def launch(self, app):
        self._on_loop(self.remote.send_launch_app_command, app)


class FakeTv(object):
    """A pretend TV for the self-test: remembers what it was told, never touches the network."""

    def __init__(self):
        self.on = True
        self.app = "com.netflix.ninja"
        self.level, self.max, self.muted = 6, 30, False
        self.sent = []
        self.fail = False

    def state(self):
        if self.fail:
            raise RuntimeError("TV not connected")
        return {"on": self.on, "app": self.app, "volume_info": {"level": self.level, "max": self.max, "muted": self.muted}, "model": "Fake TV"}

    def key(self, name):
        if self.fail:
            raise RuntimeError("TV not connected")
        self.sent.append(("key", name))
        if name == "POWER":
            self.on = not self.on
        elif name == "VOLUME_UP":
            self.level = min(self.max, self.level + 1)
        elif name == "VOLUME_DOWN":
            self.level = max(0, self.level - 1)
        elif name == "VOLUME_MUTE":
            self.muted = not self.muted

    def launch(self, app):
        self.sent.append(("app", app))
        self.app = app


def state_json(tv, config):
    raw = tv.state()
    app = raw.get("app")
    label = next((a["label"] for a in config.apps if a["id"] == app), None)
    info = raw.get("volume_info")
    return {
        "name": config.label or raw.get("model") or "Android TV",
        "on": raw.get("on") if isinstance(raw.get("on"), bool) else None,
        "app": app,
        "app_label": label,
        "volume": volume_percent(info),
        "muted": info.get("muted") if isinstance(info, dict) and isinstance(info.get("muted"), bool) else None,
        "apps": config.apps,
        "connected": True,
    }


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = "tv-glance-bridge/" + VERSION
    protocol_version = "HTTP/1.1"

    # --- plumbing ---------------------------------------------------------
    @property
    def config(self):
        return self.server.config  # type: ignore[attr-defined]

    @property
    def tv(self):
        return self.server.tv  # type: ignore[attr-defined]

    def log_message(self, fmt, *args):  # never log headers (tokens)
        if self.server.quiet:  # type: ignore[attr-defined]
            return
        sys.stderr.write("%s %s %s\n" % (time.strftime("%H:%M:%S"), self.command, self.path.split("?")[0]))

    def cors(self):
        origin = self.headers.get("Origin", "")
        allowed = self.config.origins
        if origin and (not allowed or origin in allowed):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        elif not origin and not allowed:
            self.send_header("Access-Control-Allow-Origin", "*")

    def reply(self, status, payload=None):
        body = b"" if payload is None else json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.cors()
        self.send_header("Cache-Control", "no-store")
        if payload is not None:
            self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def authorised(self):
        config = self.config
        if config.open_for_anyone:
            return False
        if config.token:
            header = self.headers.get("Authorization", "")
            if header.startswith("Bearer ") and hmac.compare_digest(header[7:].strip().encode(), config.token.encode()):
                return True
        if config.users and self.client_address[0] in LOOPBACK:
            login = self.headers.get("Tailscale-User-Login", "").strip().lower()
            if login and login in config.users:
                return True
        return False

    def body(self):
        try:
            length = int(self.headers.get("Content-Length", "0") or 0)
        except ValueError:
            length = 0
        if length > MAX_BODY:
            raise ValueError("too_large")
        raw = self.rfile.read(length) if length > 0 else b""
        if not raw:
            return {}
        data = json.loads(raw.decode("utf-8"))
        if not isinstance(data, dict):
            raise ValueError("bad_body")
        return data

    # --- methods ----------------------------------------------------------
    def do_OPTIONS(self):
        # Preflight: 204 WITHOUT a body.
        self.send_response(204)
        self.cors()
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/health":
            return self.reply(200, {"ok": True, "version": VERSION})
        if path != "/state":
            return self.reply(404, {"error": "not_found"})
        if not self.authorised():
            return self.reply(401, {"error": "unauthorised"})
        try:
            return self.reply(200, state_json(self.tv, self.config))
        except Exception:  # noqa: BLE001
            return self.reply(502, {"error": "tv_unavailable"})

    def do_POST(self):
        path = self.path.split("?")[0]
        if path not in ("/key", "/app", "/power"):
            return self.reply(404, {"error": "not_found"})
        if not self.authorised():
            return self.reply(401, {"error": "unauthorised"})
        try:
            data = self.body()
        except ValueError as error:
            return self.reply(413 if str(error) == "too_large" else 400, {"error": str(error) if str(error) == "too_large" else "bad_body"})
        try:
            if path == "/key":
                key = str(data.get("key", "")).upper().replace("KEYCODE_", "")
                if key not in KEYS:
                    return self.reply(400, {"error": "unknown_key"})
                self.tv.key(key)
                return self.reply(200, {"ok": True, "sent": key})
            if path == "/app":
                app = str(data.get("app", "")).strip()
                known = next((a["id"] for a in self.config.apps if app in (a["id"], a["label"])), None)
                app = known or app
                if not APP_RE.match(app):
                    return self.reply(400, {"error": "bad_app"})
                self.tv.launch(app)
                return self.reply(200, {"ok": True, "sent": app})
            # /power
            wanted = data.get("on")
            if wanted is not None and not isinstance(wanted, bool):
                return self.reply(400, {"error": "bad_body"})
            if wanted is not None and self.tv.state().get("on") is wanted:
                return self.reply(200, {"ok": True, "sent": None, "unchanged": True})
            self.tv.key("POWER")
            return self.reply(200, {"ok": True, "sent": "POWER"})
        except Exception:  # noqa: BLE001
            return self.reply(502, {"error": "tv_unavailable"})


def make_server(tv, config, host="127.0.0.1", port=8477, quiet=False):
    server = ThreadingHTTPServer((host, port), Handler)
    server.daemon_threads = True
    server.tv = tv  # type: ignore[attr-defined]
    server.config = config  # type: ignore[attr-defined]
    server.quiet = quiet  # type: ignore[attr-defined]
    return server


# ---------------------------------------------------------------------------
# Pairing and serving
# ---------------------------------------------------------------------------

def cert_paths():
    folder = os.path.expanduser(_env("TV_CERT_DIR", "~/.config/tv-glance-bridge"))
    os.makedirs(folder, exist_ok=True)
    return os.path.join(folder, "cert.pem"), os.path.join(folder, "key.pem")


def pair():
    host = _env("TV_HOST")
    if not host:
        sys.exit("TV_HOST is not set")
    from androidtvremote2 import AndroidTVRemote, InvalidAuth

    certfile, keyfile = cert_paths()

    async def run():
        remote = AndroidTVRemote(_env("TV_CLIENT_NAME", "TV Glance bridge"), certfile, keyfile, host)
        if await remote.async_generate_cert_if_missing():
            print("Created a client certificate in", os.path.dirname(certfile))
        name, mac = await remote.async_get_name_and_mac()
        print("TV:", name, mac)
        for _ in range(3):
            await remote.async_start_pairing()
            code = input("Enter the 6-character code shown on the TV: ").strip()
            try:
                await remote.async_finish_pairing(code)
                print("Paired. Start the bridge without --pair now.")
                return
            except InvalidAuth:
                print("Wrong code, a new one is shown on the TV.")
        sys.exit("Pairing failed")

    asyncio.run(run())


def serve():
    host = _env("TV_HOST")
    if not host:
        sys.exit("TV_HOST is not set")
    config = Config.from_env()
    if config.open_for_anyone:
        sys.exit("Set BRIDGE_TOKEN and/or BRIDGE_TAILSCALE_USERS - the bridge never runs without a login")
    certfile, keyfile = cert_paths()
    if not (os.path.exists(certfile) and os.path.exists(keyfile)):
        sys.exit("Not paired yet: run with --pair first")
    tv = RealTv(host, certfile, keyfile, _env("TV_CLIENT_NAME", "TV Glance bridge"))
    bind = _env("BRIDGE_HOST", "127.0.0.1")
    port = int(_env("BRIDGE_PORT", "8477"))
    server = make_server(tv, config, bind, port)
    print("tv-glance bridge %s on %s:%d (login: %s)" % (VERSION, bind, port, "+".join(
        [w for w, on in (("token", bool(config.token)), ("tailscale", bool(config.users))) if on])))
    server.serve_forever()


# ---------------------------------------------------------------------------
# Self-test: a fake TV, a real HTTP server on a free loopback port, no library
# ---------------------------------------------------------------------------

def selftest():
    import urllib.error
    import urllib.request

    failures = []

    def check(name, condition):
        if not condition:
            failures.append(name)
        print(("ok    " if condition else "FAIL  ") + name)

    def call(server, method, path, body=None, headers=None):
        url = "http://127.0.0.1:%d%s" % (server.server_address[1], path)
        data = None if body is None else (body if isinstance(body, bytes) else json.dumps(body).encode("utf-8"))
        request = urllib.request.Request(url, data=data, method=method, headers=headers or {})
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                raw = response.read()
                return response.status, dict(response.headers), raw
        except urllib.error.HTTPError as error:
            return error.code, dict(error.headers), error.read()

    def start(tv, config):
        server = make_server(tv, config, "127.0.0.1", 0, quiet=True)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        return server

    # Pure helpers.
    check("parse_apps reads Label=id lists", parse_apps("YouTube=com.google.android.youtube.tv; Kodi=org.xbmc.kodi;Kodi=org.xbmc.kodi") == [
        {"label": "YouTube", "id": "com.google.android.youtube.tv"}, {"label": "Kodi", "id": "org.xbmc.kodi"}])
    check("volume_percent scales level/max", volume_percent({"level": 6, "max": 30}) == 20 and volume_percent({"level": 1, "max": 0}) is None)

    tv = FakeTv()
    config = Config(token="s3cret-token", users=["you@example.com"], apps=parse_apps("Netflix=com.netflix.ninja;Kodi=org.xbmc.kodi"))
    server = start(tv, config)
    auth = {"Authorization": "Bearer s3cret-token"}
    plain = dict(auth, **{"Content-Type": "text/plain"})
    try:
        status, _, raw = call(server, "GET", "/health")
        check("health answers without login", status == 200 and json.loads(raw)["ok"] is True)

        status, _, _ = call(server, "GET", "/state")
        check("state without login is 401", status == 401)
        status, _, _ = call(server, "GET", "/state", headers={"Authorization": "Bearer wrong"})
        check("a wrong token is 401", status == 401)

        status, headers, raw = call(server, "GET", "/state", headers=dict(auth, Origin="http://127.0.0.1:5251"))
        state = json.loads(raw)
        check("state with token", status == 200 and state["on"] is True and state["app"] == "com.netflix.ninja")
        check("state carries label, volume, muted and apps", state["app_label"] == "Netflix" and state["volume"] == 20 and state["muted"] is False and len(state["apps"]) == 2)
        check("state echoes the caller's origin", headers.get("Access-Control-Allow-Origin") == "http://127.0.0.1:5251")

        status, headers, raw = call(server, "OPTIONS", "/key", headers={"Origin": "http://127.0.0.1:5251", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization, content-type"})
        check("preflight is 204 without a body", status == 204 and raw == b"")
        check("preflight allows Authorization and Content-Type", "Authorization" in headers.get("Access-Control-Allow-Headers", "") and "Content-Type" in headers.get("Access-Control-Allow-Headers", ""))
        check("preflight names the origin", headers.get("Access-Control-Allow-Origin") == "http://127.0.0.1:5251")

        status, _, raw = call(server, "POST", "/key", {"key": "DPAD_UP"}, plain)
        check("key DPAD_UP is sent", status == 200 and tv.sent[-1] == ("key", "DPAD_UP"))
        status, _, _ = call(server, "POST", "/key", {"key": "KEYCODE_HOME"}, plain)
        check("KEYCODE_ prefix is accepted", status == 200 and tv.sent[-1] == ("key", "HOME"))
        status, _, _ = call(server, "POST", "/key", {"key": "VOLUME_UP"}, plain)
        status2, _, raw = call(server, "GET", "/state", headers=auth)
        check("volume up changes the state", status == 200 and json.loads(raw)["volume"] == 23)
        status, _, _ = call(server, "POST", "/key", {"key": "POWER"}, plain)
        check("POWER is not a /key (use /power)", status == 400)
        status, _, _ = call(server, "POST", "/key", {"key": "SETTINGS; rm -rf"}, plain)
        check("unknown keys are refused", status == 400)

        status, _, _ = call(server, "POST", "/app", {"app": "Kodi"}, plain)
        check("an app by its label launches its id", status == 200 and tv.sent[-1] == ("app", "org.xbmc.kodi"))
        status, _, _ = call(server, "POST", "/app", {"app": "com.google.android.youtube.tv"}, plain)
        check("an app by package name", status == 200 and tv.sent[-1] == ("app", "com.google.android.youtube.tv"))
        status, _, _ = call(server, "POST", "/app", {"app": "not a package"}, plain)
        check("a malformed app is refused", status == 400)

        status, _, raw = call(server, "POST", "/power", {"on": True}, plain)
        check("power on while on sends nothing", status == 200 and json.loads(raw).get("unchanged") is True)
        status, _, raw = call(server, "POST", "/power", {"on": False}, plain)
        check("power off sends POWER once", status == 200 and tv.sent[-1] == ("key", "POWER") and tv.on is False)
        status, _, raw = call(server, "POST", "/power", {"on": False}, plain)
        check("power off while off sends nothing", status == 200 and json.loads(raw).get("unchanged") is True)
        status, _, _ = call(server, "POST", "/power", {"on": "yes"}, plain)
        check("power with a non-boolean is refused", status == 400)

        status, _, _ = call(server, "POST", "/key", b"x" * (MAX_BODY + 1), plain)
        check("an oversized body is 413", status == 413)
        status, _, _ = call(server, "POST", "/key", b"[1,2]", plain)
        check("a non-object body is 400", status == 400)
        status, _, _ = call(server, "POST", "/nope", {}, plain)
        check("unknown paths are 404", status == 404)

        status, _, _ = call(server, "GET", "/state", headers={"Tailscale-User-Login": "you@example.com"})
        check("tailscale login from loopback is accepted", status == 200)
        status, _, _ = call(server, "GET", "/state", headers={"Tailscale-User-Login": "someone@else.com"})
        check("an unknown tailscale login is refused", status == 401)

        tv.fail = True
        status, _, _ = call(server, "GET", "/state", headers=auth)
        check("a TV that is gone is 502", status == 502)
        tv.fail = False
    finally:
        server.shutdown()
        server.server_close()

    # Without token and tailscale users nothing but /health answers.
    closed = start(FakeTv(), Config())
    try:
        status, _, _ = call(closed, "GET", "/state", headers={"Authorization": "Bearer "})
        check("without any login configured, everything is refused", status == 401)
    finally:
        closed.shutdown()
        closed.server_close()

    # Exact origins: another origin gets no CORS header.
    strict = start(FakeTv(), Config(token="t", origins=["http://127.0.0.1:5251"]))
    try:
        _, headers, _ = call(strict, "GET", "/state", headers={"Authorization": "Bearer t", "Origin": "http://evil.example"})
        check("BRIDGE_ORIGINS refuses other origins", "Access-Control-Allow-Origin" not in headers)
    finally:
        strict.shutdown()
        strict.server_close()

    try:
        import androidtvremote2  # noqa: F401
        print("info  androidtvremote2 is installed (not used by the self-test)")
    except ImportError:
        print("info  androidtvremote2 is not installed - fine for the self-test; pip install androidtvremote2 to use a real TV")

    if failures:
        print("selftest FAILED: %d" % len(failures))
        return 1
    print("selftest ok")
    return 0


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        sys.exit(selftest())
    if "--pair" in sys.argv:
        pair()
    else:
        serve()
