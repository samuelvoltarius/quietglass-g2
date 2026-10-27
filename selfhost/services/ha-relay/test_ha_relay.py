"""ha_relay: handshake, relay, message rules, access, filtering, /config.

    python3 -m unittest test_ha_relay      (or: python3 -m pytest test_ha_relay.py)
No network beyond 127.0.0.1: the "Home Assistant" is a fake aiohttp server in this file, the token is a made-up
string in a temp file.
"""
import json
import os
import sys
import tempfile
import unittest

from aiohttp import WSMsgType, web
from aiohttp.test_utils import TestClient, TestServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ha_relay as relay  # noqa: E402

REAL_TOKEN = "fake-real-token-for-tests"
USER = "me@example.com"
H = {"Tailscale-User-Login": USER}

STATES = [
    {"entity_id": "media_player.tv", "state": "playing", "attributes": {"friendly_name": "TV"}},
    {"entity_id": "remote.tv", "state": "on", "attributes": {}},
    {"entity_id": "light.kitchen", "state": "on", "attributes": {}},
    {"entity_id": "lock.front_door", "state": "locked", "attributes": {}},
]


class FakeHa:
    """A tiny Home Assistant WebSocket API: auth, get_states, subscribe_entities, call_service, ping."""

    def __init__(self):
        self.received = []
        self.auth_tokens = []
        self.app = web.Application()
        self.app.router.add_get("/api/websocket", self.handler)

    async def handler(self, request):
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        await ws.send_json({"type": "auth_required", "ha_version": "2026.10.0"})
        auth = await ws.receive_json()
        self.auth_tokens.append(auth.get("access_token"))
        if auth.get("access_token") != REAL_TOKEN:
            await ws.send_json({"type": "auth_invalid", "message": "Invalid access token"})
            await ws.close()
            return ws
        await ws.send_json({"type": "auth_ok", "ha_version": "2026.10.0"})
        async for msg in ws:
            if msg.type != WSMsgType.TEXT:
                break
            message = json.loads(msg.data)
            self.received.append(message)
            mid, kind = message["id"], message["type"]
            if kind == "get_states":
                await ws.send_json({"id": mid, "type": "result", "success": True, "result": STATES})
            elif kind == "subscribe_entities":
                await ws.send_json({"id": mid, "type": "result", "success": True, "result": None})
                added = {s["entity_id"]: {"s": s["state"], "a": s["attributes"]} for s in STATES}
                await ws.send_json({"id": mid, "type": "event", "event": {"a": added}})
                await ws.send_json({"id": mid, "type": "event", "event": {"c": {"light.kitchen": {"+": {"s": "off"}}}}})
                await ws.send_json({"id": mid, "type": "event", "event": {"c": {"media_player.tv": {"+": {"s": "paused"}}}, "r": ["lock.front_door"]}})
            elif kind == "ping":
                await ws.send_json({"id": mid, "type": "pong"})
            else:
                await ws.send_json({"id": mid, "type": "result", "success": True, "result": {"context": {}}})
        return ws


class Base(unittest.IsolatedAsyncioTestCase):
    cfg_extra = {}

    async def asyncSetUp(self):
        self.ha = FakeHa()
        self.ha_server = TestServer(self.ha.app)
        await self.ha_server.start_server()
        handle, self.token_path = tempfile.mkstemp()
        os.write(handle, (REAL_TOKEN + "\n").encode())
        os.close(handle)
        self.cfg = relay.Config(
            ha_url="http://127.0.0.1:%d" % self.ha_server.port, token_file=self.token_path, users={USER},
            devices=relay.parse_devices("media_player.tv|remote.tv|Living Room;media_player.projector||Projector"),
            **self.cfg_extra,
        )
        self.client = TestClient(TestServer(relay.make_app(self.cfg)))
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()
        await self.ha_server.close()
        os.unlink(self.token_path)

    async def connect(self, token="anything", headers=H):
        ws = await self.client.ws_connect("/api/websocket", headers=headers)
        self.assertEqual(await ws.receive_json(), {"type": "auth_required"})
        await ws.send_json({"type": "auth", "access_token": token})
        return ws

    async def login(self, **kw):
        ws = await self.connect(**kw)
        answer = await ws.receive_json()
        self.assertEqual(answer["type"], "auth_ok")
        return ws


class Handshake(Base):
    async def test_any_token_is_accepted_and_ha_version_comes_from_upstream(self):
        for token in ("anything", "", "x" * 50):
            ws = await self.connect(token=token)
            self.assertEqual(await ws.receive_json(), {"type": "auth_ok", "ha_version": "2026.10.0"})
            await ws.close()
        # Upstream always got the real token, never the client's.
        self.assertEqual(self.ha.auth_tokens, [REAL_TOKEN] * 3)

    async def test_first_message_must_be_auth(self):
        ws = await self.client.ws_connect("/api/websocket", headers=H)
        await ws.receive_json()
        await ws.send_json({"id": 1, "type": "get_states"})
        self.assertEqual((await ws.receive_json())["type"], "auth_invalid")
        self.assertEqual(self.ha.received, [])

    async def test_upstream_refusing_the_token_is_reported_as_auth_invalid(self):
        with open(self.token_path, "w") as handle:
            handle.write("wrong")
        ws = await self.connect()
        answer = await ws.receive_json()
        self.assertEqual(answer["type"], "auth_invalid")
        self.assertNotIn("wrong", json.dumps(answer))

    async def test_missing_token_file(self):
        os.unlink(self.token_path)
        ws = await self.connect()
        self.assertEqual((await ws.receive_json())["type"], "auth_invalid")
        open(self.token_path, "w").close()   # so tearDown can remove it


class Relaying(Base):
    async def test_ping_and_supported_features_go_through(self):
        ws = await self.login()
        await ws.send_json({"id": 1, "type": "ping"})
        self.assertEqual(await ws.receive_json(), {"id": 1, "type": "pong"})
        await ws.send_json({"id": 2, "type": "supported_features", "features": {"coalesce_messages": 1}})
        self.assertEqual((await ws.receive_json())["success"], True)
        self.assertEqual([m["type"] for m in self.ha.received], ["ping", "supported_features"])

    async def test_call_service_for_media_player_and_remote_is_forwarded_unchanged(self):
        ws = await self.login()
        play = {"id": 3, "type": "call_service", "domain": "media_player", "service": "media_play_pause", "service_data": {}, "target": {"entity_id": "media_player.tv"}}
        key = {"id": 4, "type": "call_service", "domain": "remote", "service": "send_command", "service_data": {"command": "DPAD_UP"}, "target": {"entity_id": "remote.tv"}}
        for message in (play, key):
            await ws.send_json(message)
            answer = await ws.receive_json()
            self.assertEqual((answer["id"], answer["success"]), (message["id"], True))
        self.assertEqual(self.ha.received, [play, key])

    async def test_subscribe_entities_events_are_filtered_to_media_player_and_remote(self):
        ws = await self.login()
        await ws.send_json({"id": 5, "type": "subscribe_entities", "entity_ids": ["media_player.tv", "remote.tv"]})
        self.assertEqual((await ws.receive_json())["type"], "result")
        added = await ws.receive_json()
        self.assertEqual(sorted(added["event"]["a"]), ["media_player.tv", "remote.tv"])
        # the light-only change is dropped; the mixed one keeps the player and loses the lock removal
        mixed = await ws.receive_json()
        self.assertEqual(mixed["event"], {"c": {"media_player.tv": {"+": {"s": "paused"}}}, "r": []})

    async def test_subscribe_without_entity_ids_is_allowed_but_filtered(self):
        ws = await self.login()
        await ws.send_json({"id": 6, "type": "subscribe_entities"})
        await ws.receive_json()
        added = await ws.receive_json()
        self.assertEqual(sorted(added["event"]["a"]), ["media_player.tv", "remote.tv"])

    async def test_subscribe_entities_is_cut_down_and_never_empty(self):
        ws = await self.login()
        await ws.send_json({"id": 7, "type": "subscribe_entities", "entity_ids": ["media_player.tv", "light.kitchen"]})
        await ws.receive_json()
        self.assertEqual(self.ha.received[-1]["entity_ids"], ["media_player.tv"])
        ws = await self.login()
        await ws.send_json({"id": 8, "type": "subscribe_entities", "entity_ids": ["light.kitchen"]})
        answer = await ws.receive_json()
        self.assertFalse(answer["success"])
        self.assertEqual(answer["error"]["code"], "not_allowed")
        await ws.send_json({"id": 9, "type": "subscribe_entities", "entity_ids": []})
        self.assertFalse((await ws.receive_json())["success"])
        self.assertTrue(all(m["id"] == 7 for m in self.ha.received))

    async def test_get_states_only_media_players_and_remotes(self):
        ws = await self.login()
        await ws.send_json({"id": 10, "type": "get_states"})
        answer = await ws.receive_json()
        self.assertEqual([e["entity_id"] for e in answer["result"]], ["media_player.tv", "remote.tv"])
        self.assertNotIn("lock", json.dumps(answer))


class Rules(Base):
    async def refused(self, ws, message, code="not_allowed"):
        await ws.send_json(message)
        answer = await ws.receive_json()
        self.assertEqual(answer["type"], "result")
        self.assertIs(answer["success"], False)
        self.assertEqual(answer["error"]["code"], code)
        self.assertEqual(answer["id"], message["id"])
        self.assertTrue(answer["error"]["message"])

    async def test_disallowed_message_types(self):
        ws = await self.login()
        for index, kind in enumerate(("auth", "subscribe_events", "config/auth/list", "get_config", "render_template", "get_services", "fire_event", "execute_script")):
            await self.refused(ws, {"id": 100 + index, "type": kind})
        self.assertEqual(self.ha.received, [])

    async def test_disallowed_domains(self):
        ws = await self.login()
        for domain, service, entity in (("light", "turn_on", "light.kitchen"), ("lock", "unlock", "lock.front_door"), ("homeassistant", "restart", "media_player.tv"), ("script", "turn_on", "script.x")):
            await self.refused(ws, {"id": 1, "type": "call_service", "domain": domain, "service": service, "target": {"entity_id": entity}})
        self.assertEqual(self.ha.received, [])

    async def test_entity_must_belong_to_the_domain_and_be_explicit(self):
        ws = await self.login()
        base = {"id": 2, "type": "call_service", "domain": "media_player", "service": "turn_off"}
        await self.refused(ws, dict(base, target={"entity_id": "light.kitchen"}))
        await self.refused(ws, dict(base, target={"entity_id": ["media_player.tv", "light.kitchen"]}))
        await self.refused(ws, dict(base))                                             # no target at all
        await self.refused(ws, dict(base, target={"area_id": "living_room"}))
        await self.refused(ws, dict(base, target={"entity_id": "media_player.tv", "device_id": "abc"}))
        await self.refused(ws, dict(base, service_data={"area_id": "x"}, target={"entity_id": "media_player.tv"}))
        await self.refused(ws, dict(base, service_data={"entity_id": "light.kitchen"}, target={"entity_id": "media_player.tv"}))
        await self.refused(ws, dict(base, target={"entity_id": 5}), code="invalid_format")
        self.assertEqual(self.ha.received, [])

    async def test_ids_must_be_integers_and_messages_objects(self):
        ws = await self.login()
        await ws.send_json({"type": "get_states"})
        self.assertEqual((await ws.receive_json())["error"]["code"], "invalid_format")
        await ws.send_json({"id": "1", "type": "get_states"})
        self.assertEqual((await ws.receive_json())["error"]["code"], "invalid_format")
        await ws.send_str("[1, 2]")
        self.assertEqual((await ws.receive_json())["error"]["code"], "invalid_format")
        await ws.send_str("not json")
        self.assertEqual((await ws.receive_json())["error"]["code"], "invalid_format")
        self.assertEqual(self.ha.received, [])

    async def test_still_works_after_a_refusal(self):
        ws = await self.login()
        await self.refused(ws, {"id": 1, "type": "get_config"})
        await ws.send_json({"id": 2, "type": "ping"})
        self.assertEqual((await ws.receive_json())["type"], "pong")


class OnlyListedEntities(Base):
    cfg_extra = {"entities": {"media_player.tv", "remote.tv"}}

    async def test_call_service_limited_to_relay_entities(self):
        ws = await self.login()
        ok = {"id": 1, "type": "call_service", "domain": "media_player", "service": "volume_up", "target": {"entity_id": "media_player.tv"}}
        await ws.send_json(ok)
        self.assertTrue((await ws.receive_json())["success"])
        other = dict(ok, id=2, target={"entity_id": "media_player.bedroom"})
        await ws.send_json(other)
        answer = await ws.receive_json()
        self.assertEqual((answer["success"], answer["error"]["code"], answer["id"]), (False, "not_allowed", 2))
        mixed = dict(ok, id=3, target={"entity_id": ["media_player.tv", "media_player.bedroom"]})
        await ws.send_json(mixed)
        self.assertFalse((await ws.receive_json())["success"])
        self.assertEqual(self.ha.received, [ok])


class Access(Base):
    async def test_websocket_refused_without_or_with_wrong_login(self):
        for headers in ({}, {"Tailscale-User-Login": "other@example.com"}, {"Tailscale-User-Login": ""}):
            response = await self.client.get("/api/websocket", headers=headers)
            self.assertEqual(response.status, 403)
        self.assertEqual(self.ha.auth_tokens, [])

    async def test_login_is_case_insensitive(self):
        ws = await self.login(headers={"Tailscale-User-Login": USER.upper()})
        await ws.close()

    async def test_config_requires_login(self):
        self.assertEqual((await self.client.get("/config")).status, 403)
        self.assertEqual((await self.client.get("/config", headers={"Tailscale-User-Login": "x@example.com"})).status, 403)

    async def test_nobody_is_let_in_when_no_users_are_set(self):
        self.cfg.users.clear()
        self.assertEqual((await self.client.get("/config", headers=H)).status, 403)

    async def test_login_header_only_counts_from_loopback(self):
        class FakeTransport:
            def __init__(self, peer):
                self.peer = peer

            def get_extra_info(self, name):
                return (self.peer, 1234)

        class FakeRequest:
            headers = H

            def __init__(self, peer):
                self.transport = FakeTransport(peer)

        self.assertEqual(relay.login_of(FakeRequest("127.0.0.1"), self.cfg), USER)
        self.assertEqual(relay.login_of(FakeRequest("::1"), self.cfg), USER)
        self.assertIsNone(relay.login_of(FakeRequest("100.64.0.7"), self.cfg))
        self.assertIsNone(relay.login_of(FakeRequest("192.0.2.5"), self.cfg))

    async def test_websocket_ignores_the_origin(self):
        ws = await self.client.ws_connect("/api/websocket", headers=dict(H, Origin="http://127.0.0.1:34567"))
        self.assertEqual((await ws.receive_json())["type"], "auth_required")
        await ws.close()


class ConfigAndHealth(Base):
    async def test_config_lists_the_devices_with_cors(self):
        response = await self.client.get("/config", headers=H)
        self.assertEqual(response.status, 200)
        self.assertEqual(response.headers["Access-Control-Allow-Origin"], "*")
        self.assertEqual(await response.json(), {"devices": [
            {"entityId": "media_player.tv", "remoteId": "remote.tv", "name": "Living Room"},
            {"entityId": "media_player.projector", "remoteId": "", "name": "Projector"},
        ]})

    async def test_forbidden_answers_carry_cors_too(self):
        response = await self.client.get("/config")
        self.assertEqual(response.headers["Access-Control-Allow-Origin"], "*")

    async def test_health_needs_no_login_and_shows_nothing(self):
        response = await self.client.get("/health")
        self.assertEqual(response.status, 200)
        self.assertEqual(await response.json(), {"ok": True})

    async def test_preflight(self):
        response = await self.client.options("/config")
        self.assertEqual(response.status, 204)

    def test_parse_devices(self):
        parsed = relay.parse_devices("media_player.a|remote.a|A;media_player.b;light.x|remote.x|X;media_player.a|remote.z|dup;media_player.c|switch.c|")
        self.assertEqual(parsed, [
            {"entityId": "media_player.a", "remoteId": "remote.a", "name": "A"},
            {"entityId": "media_player.b", "remoteId": "", "name": "media_player.b"},
            {"entityId": "media_player.c", "remoteId": "", "name": "media_player.c"},
        ])
        self.assertEqual(relay.parse_devices(""), [])


class ConfigFromEnv(unittest.TestCase):
    def test_from_env(self):
        cfg = relay.Config.from_env({
            "HA_URL": "http://192.0.2.10:8123/", "RELAY_PORT": "9999", "RELAY_TAILSCALE_USERS": " A@example.com , b@example.com ",
            "RELAY_ENTITIES": "media_player.a, remote.a", "RELAY_DEVICES": "media_player.a|remote.a|A",
        })
        self.assertEqual((cfg.port, cfg.host, cfg.token_file), (9999, "127.0.0.1", "~/.ha_token"))
        self.assertEqual(cfg.users, {"a@example.com", "b@example.com"})
        self.assertEqual(cfg.entities, {"media_player.a", "remote.a"})
        self.assertEqual(cfg.upstream_ws, "ws://192.0.2.10:8123/api/websocket")
        self.assertEqual(relay.Config(ha_url="https://ha.example.com").upstream_ws, "wss://ha.example.com/api/websocket")
        self.assertEqual(relay.Config.from_env({}).port, 8484)


if __name__ == "__main__":
    unittest.main()
