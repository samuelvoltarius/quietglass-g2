#!/usr/bin/env python3
"""ha-relay: a Home Assistant WebSocket relay for the owner's private TV Glance build (tailnet only).

The glasses app talks to this service as if it were Home Assistant (`/api/websocket`) but sends no real
token: access is decided by the Tailscale login (`Tailscale-User-Login`, set by `tailscale serve`, trusted only
from loopback and only for RELAY_TAILSCALE_USERS). The relay logs in to Home Assistant itself with a
long-lived token read from a file, and lets only a small part of the API through:

  client message types   subscribe_entities, unsubscribe_events, get_states, call_service, ping, supported_features
  call_service           only domains media_player and remote, only for the entities in RELAY_ENTITIES
                         (empty = every media_player.* / remote.*), always with explicit entity ids
  get_states / events    only media_player.* and remote.* entities

Environment
  HA_URL                 Home Assistant base address, e.g. http://192.0.2.10:8123 (required)
  HA_TOKEN_FILE          file with the long-lived access token (default ~/.ha_token; read per session, never logged)
  RELAY_HOST / RELAY_PORT  bind address (default 127.0.0.1) and port (default 8484)
  RELAY_TAILSCALE_USERS  comma list of Tailscale logins that may connect (empty = everything is refused)
  RELAY_ENTITIES         comma list of entity ids call_service may target (empty = all media_player/remote)
  RELAY_DEVICES          for GET /config: "media_player.x|remote.x|Name;media_player.y||Other name"

Dependencies: Python 3.9+, aiohttp (3.x). Nothing else.
"""
import asyncio
import json
import logging
import os
import sys
from dataclasses import dataclass, field

from aiohttp import ClientError, ClientSession, WSMsgType, web

LOG = logging.getLogger("ha-relay")

LOOPBACK = {"127.0.0.1", "::1", "::ffff:127.0.0.1"}
ALLOWED_DOMAINS = ("media_player", "remote")
ALLOWED_TYPES = {"subscribe_entities", "unsubscribe_events", "get_states", "call_service", "ping", "supported_features"}
# call_service must name entities, never areas/devices/labels (those would widen the target).
WIDE_TARGETS = ("area_id", "device_id", "floor_id", "label_id")
MAX_MSG = 1 << 20          # 1 MiB per WebSocket message
STEP_TIMEOUT = 10          # seconds for each step of the handshakes
CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "600",
}

CFG = web.AppKey("cfg", object)
SESSION = web.AppKey("session", ClientSession)


# ------------------------------------------------------------------ configuration

def _csv(value):
    return [part.strip() for part in (value or "").split(",") if part.strip()]


def parse_devices(text):
    """'media_player.x|remote.x|Name;media_player.y||Other' -> [{"entityId","remoteId","name"}]."""
    devices = []
    for item in (text or "").split(";"):
        parts = [p.strip() for p in item.split("|")]
        if not parts or not parts[0].startswith("media_player."):
            continue
        remote = parts[1] if len(parts) > 1 and parts[1].startswith("remote.") else ""
        name = parts[2] if len(parts) > 2 and parts[2] else parts[0]
        if all(d["entityId"] != parts[0] for d in devices):
            devices.append({"entityId": parts[0], "remoteId": remote, "name": name})
    return devices


@dataclass
class Config:
    ha_url: str = ""
    token_file: str = "~/.ha_token"
    host: str = "127.0.0.1"
    port: int = 8484
    users: set = field(default_factory=set)
    entities: set = field(default_factory=set)
    devices: list = field(default_factory=list)

    @classmethod
    def from_env(cls, env=None):
        env = os.environ if env is None else env
        return cls(
            ha_url=(env.get("HA_URL") or "").strip().rstrip("/"),
            token_file=env.get("HA_TOKEN_FILE") or "~/.ha_token",
            host=env.get("RELAY_HOST") or "127.0.0.1",
            port=int(env.get("RELAY_PORT") or 8484),
            users={u.lower() for u in _csv(env.get("RELAY_TAILSCALE_USERS"))},
            entities=set(_csv(env.get("RELAY_ENTITIES"))),
            devices=parse_devices(env.get("RELAY_DEVICES")),
        )

    @property
    def upstream_ws(self):
        base = self.ha_url
        for old, new in (("https://", "wss://"), ("http://", "ws://")):
            if base.lower().startswith(old):
                base = new + base[len(old):]
                break
        if base.endswith("/api/websocket"):
            return base
        if base.endswith("/api"):
            base = base[:-4]
        return base + "/api/websocket"

    def read_token(self):
        with open(os.path.expanduser(self.token_file), "r", encoding="utf-8") as handle:
            return handle.read().strip()


# ------------------------------------------------------------------ access

def login_of(request, cfg):
    """The Tailscale login if it may come in, else None. Trusted only from loopback (i.e. from `tailscale serve`)."""
    peer = (request.transport.get_extra_info("peername") or ("",))[0] if request.transport else ""
    if peer not in LOOPBACK:
        return None
    login = (request.headers.get("Tailscale-User-Login") or "").strip().lower()
    return login if login and login in cfg.users else None


def forbidden():
    return web.json_response({"error": "forbidden"}, status=403, headers=CORS)


# ------------------------------------------------------------------ message rules (pure, tested)

def domain_of(entity_id):
    return entity_id.split(".", 1)[0] if isinstance(entity_id, str) and "." in entity_id else ""


def _not_allowed(message, text, code="not_allowed"):
    reply = {"type": "result", "success": False, "error": {"code": code, "message": text}}
    if isinstance(message.get("id"), int) and not isinstance(message.get("id"), bool):
        reply["id"] = message["id"]
    return reply


def _entity_ids(value):
    if value is None:
        return []
    if isinstance(value, str):
        return [part.strip() for part in value.split(",") if part.strip()]
    if isinstance(value, list) and all(isinstance(x, str) for x in value):
        return value
    return None


def screen_client_message(message, cfg):
    """-> (forward_message | None, reply | None). Exactly one of the two is set. Nothing is rewritten except
    that subscribe_entities is cut down to the allowed domains."""
    if not isinstance(message, dict):
        return None, _not_allowed({}, "Message must be a JSON object.", "invalid_format")
    kind = message.get("type")
    mid = message.get("id")
    if not isinstance(mid, int) or isinstance(mid, bool):
        return None, _not_allowed({}, "Message needs an integer id.", "invalid_format")
    if kind not in ALLOWED_TYPES:
        return None, _not_allowed(message, "Message type not allowed through the relay: %s" % str(kind)[:40])

    if kind == "call_service":
        domain = message.get("domain")
        if domain not in ALLOWED_DOMAINS:
            return None, _not_allowed(message, "Only the domains media_player and remote are allowed.")
        target = message.get("target") or {}
        data = message.get("service_data") or {}
        if not isinstance(target, dict) or not isinstance(data, dict):
            return None, _not_allowed(message, "target and service_data must be objects.", "invalid_format")
        if any(key in target or key in data for key in WIDE_TARGETS):
            return None, _not_allowed(message, "Only explicit entity ids are allowed as target.")
        ids = []
        for source in (target.get("entity_id"), data.get("entity_id")):
            found = _entity_ids(source)
            if found is None:
                return None, _not_allowed(message, "entity_id must be a string or a list of strings.", "invalid_format")
            ids.extend(found)
        if not ids:
            return None, _not_allowed(message, "An entity_id is required.")
        for entity_id in ids:
            if domain_of(entity_id) != domain:
                return None, _not_allowed(message, "Entity %s does not belong to domain %s." % (entity_id[:60], domain))
            if cfg.entities and entity_id not in cfg.entities:
                return None, _not_allowed(message, "Entity %s is not allowed through this relay." % entity_id[:60])
        return message, None

    if kind == "subscribe_entities":
        if "entity_ids" in message:
            ids = _entity_ids(message.get("entity_ids"))
            if ids is None:
                return None, _not_allowed(message, "entity_ids must be a list of strings.", "invalid_format")
            kept = [i for i in ids if domain_of(i) in ALLOWED_DOMAINS]
            # An empty list would mean "everything" to Home Assistant: never send that.
            if not kept:
                return None, _not_allowed(message, "No media_player or remote entity requested.")
            if kept != ids:
                message = dict(message, entity_ids=kept)
    return message, None


def keep_entity(entity_id):
    return domain_of(entity_id) in ALLOWED_DOMAINS


class Session:
    """What the relay must remember about one client to filter the answers."""

    def __init__(self):
        self.get_states = set()      # ids of get_states requests waiting for their result
        self.subscriptions = set()   # ids of subscribe_entities

    def note_forwarded(self, message):
        if message.get("type") == "get_states":
            self.get_states.add(message["id"])
        elif message.get("type") == "subscribe_entities":
            self.subscriptions.add(message["id"])
        elif message.get("type") == "unsubscribe_events":
            self.subscriptions.discard(message.get("subscription"))

    def filter_upstream(self, message):
        """The message to pass on to the client, or None to drop it."""
        if not isinstance(message, dict):
            return None
        mid = message.get("id")
        if message.get("type") == "result" and mid in self.get_states:
            self.get_states.discard(mid)
            result = message.get("result")
            if message.get("success") is True and isinstance(result, list):
                return dict(message, result=[e for e in result if isinstance(e, dict) and keep_entity(e.get("entity_id"))])
            return message
        if message.get("type") == "event" and mid in self.subscriptions:
            event = message.get("event")
            if not isinstance(event, dict):
                return message
            cut = dict(event)
            for key in ("a", "c"):
                if isinstance(event.get(key), dict):
                    cut[key] = {k: v for k, v in event[key].items() if keep_entity(k)}
            if isinstance(event.get("r"), list):
                cut["r"] = [k for k in event["r"] if keep_entity(k)]
            had = any(event.get(k) for k in ("a", "c", "r"))
            has = any(cut.get(k) for k in ("a", "c", "r"))
            if had and not has:
                return None
            return dict(message, event=cut)
        return message


# ------------------------------------------------------------------ HTTP / WebSocket

async def health(request):
    return web.json_response({"ok": True}, headers=CORS)


async def options(request):
    return web.Response(status=204, headers=CORS)


async def config_handler(request):
    cfg = request.app[CFG]
    if login_of(request, cfg) is None:
        return forbidden()
    return web.json_response({"devices": cfg.devices}, headers={**CORS, "Cache-Control": "no-store"})


class UpstreamError(Exception):
    pass


async def open_upstream(request):
    """Logs in to Home Assistant with the real token -> (websocket, ha_version)."""
    cfg = request.app[CFG]
    try:
        token = cfg.read_token()
    except OSError:
        raise UpstreamError("token file not readable")
    if not token or not cfg.ha_url:
        raise UpstreamError("relay not configured")
    try:
        up = await asyncio.wait_for(request.app[SESSION].ws_connect(cfg.upstream_ws, heartbeat=30, max_msg_size=MAX_MSG), STEP_TIMEOUT)
        first = await asyncio.wait_for(up.receive_json(), STEP_TIMEOUT)
        if first.get("type") != "auth_required":
            raise UpstreamError("unexpected greeting")
        await up.send_json({"type": "auth", "access_token": token})
        answer = await asyncio.wait_for(up.receive_json(), STEP_TIMEOUT)
    except (ClientError, asyncio.TimeoutError, ValueError, TypeError, OSError):
        raise UpstreamError("home assistant not reachable")
    if answer.get("type") != "auth_ok":
        await up.close()
        raise UpstreamError("home assistant refused the relay's token")
    return up, answer.get("ha_version")


async def pump_client(ws, up, session, cfg):
    async for msg in ws:
        if msg.type != WSMsgType.TEXT:
            return
        try:
            message = json.loads(msg.data)
        except ValueError:
            message = None
        forward, reply = screen_client_message(message, cfg)
        if reply is not None:
            await ws.send_json(reply)
            continue
        session.note_forwarded(forward)
        await up.send_str(json.dumps(forward))


async def pump_upstream(ws, up, session):
    async for msg in up:
        if msg.type != WSMsgType.TEXT:
            return
        try:
            message = json.loads(msg.data)
        except ValueError:
            continue
        out = session.filter_upstream(message)
        if out is not None:
            await ws.send_str(json.dumps(out))


async def websocket_handler(request):
    cfg = request.app[CFG]
    login = login_of(request, cfg)
    if login is None:
        return forbidden()
    ws = web.WebSocketResponse(heartbeat=30, max_msg_size=MAX_MSG)
    await ws.prepare(request)
    up = None
    try:
        await ws.send_json({"type": "auth_required"})
        try:
            first = await asyncio.wait_for(ws.receive(), STEP_TIMEOUT)
            hello = json.loads(first.data) if first.type == WSMsgType.TEXT else None
        except (asyncio.TimeoutError, ValueError):
            hello = None
        # Any token (also empty) is fine: the Tailscale login was checked above. Only the message type matters.
        if not isinstance(hello, dict) or hello.get("type") != "auth":
            await ws.send_json({"type": "auth_invalid", "message": "Expected an auth message."})
            return ws
        try:
            up, version = await open_upstream(request)
        except UpstreamError as error:
            LOG.warning("login=%s upstream failed: %s", login, error)
            await ws.send_json({"type": "auth_invalid", "message": str(error)})
            return ws
        await ws.send_json({"type": "auth_ok", "ha_version": version or "relay"})
        LOG.info("login=%s connected", login)
        session = Session()
        tasks = [asyncio.ensure_future(pump_client(ws, up, session, cfg)), asyncio.ensure_future(pump_upstream(ws, up, session))]
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
    except (ConnectionResetError, RuntimeError):
        pass
    finally:
        if up is not None:
            await up.close()
        await ws.close()
        LOG.info("login=%s disconnected", login)
    return ws


async def _session_ctx(app):
    app[SESSION] = ClientSession()
    yield
    await app[SESSION].close()


def make_app(cfg):
    app = web.Application()
    app[CFG] = cfg
    app.cleanup_ctx.append(_session_ctx)
    app.router.add_get("/health", health)
    app.router.add_get("/config", config_handler)
    app.router.add_route("OPTIONS", "/config", options)
    app.router.add_get("/api/websocket", websocket_handler)
    return app


def main():
    logging.basicConfig(level=logging.INFO, stream=sys.stdout, format="%(asctime)s %(name)s %(message)s")
    cfg = Config.from_env()
    if not cfg.ha_url:
        sys.exit("HA_URL is not set")
    if not cfg.users:
        LOG.warning("RELAY_TAILSCALE_USERS is empty - every request is refused")
    LOG.info("listening on %s:%d, upstream %s, %d device(s), %s", cfg.host, cfg.port, cfg.upstream_ws, len(cfg.devices),
             ("entities limited to %d" % len(cfg.entities)) if cfg.entities else "all media_player/remote entities")
    web.run_app(make_app(cfg), host=cfg.host, port=cfg.port, print=None)


if __name__ == "__main__":
    main()
