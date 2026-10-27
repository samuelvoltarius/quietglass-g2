import { resetGestureDedupe } from "../src/input/gestures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/tv/errors";
import { fetchRelayDevices } from "../src/tv/relay";
import {
  buildHaRelay, defaultSettings, effectiveHaToken, effectiveHaUrl, EMPTY_SETTINGS, importRelayDevices, isConfigured, parseRelayDevices, parseSettings,
  RELAY_PLACEHOLDER_TOKEN,
} from "../src/storage/persist";
import { relayInner } from "../src/ui/phone";
import { fakeRoot } from "./fake-dom";
import { fakeHaWs } from "./fake-ha";

// VITE_HA_RELAY (private build): the app talks to the owner's relay, sends a placeholder token and takes its device
// list from <relay>/config. Without it everything is as in 0.2.0 (the other test files cover that).
const RELAY = "https://relay.example:8483";
const CONFIG = {
  devices: [
    { entityId: "media_player.living_room_tv", remoteId: "remote.living_room_tv", name: "Living Room" },
    { entityId: "media_player.projector", remoteId: "", name: "Projector" },
  ],
};

describe("relay settings", () => {
  it("is empty in a normal (public) build", () => {
    expect(buildHaRelay(undefined)).toBe("");
    expect(effectiveHaToken(EMPTY_SETTINGS)).toBe("");
    expect(defaultSettings()).toEqual(EMPTY_SETTINGS);
  });

  it("accepts a web address, drops anything else", () => {
    expect(buildHaRelay(RELAY + "/")).toBe(RELAY);
    expect(buildHaRelay("ftp://x")).toBe("");
  });

  it("needs no token: relay address, placeholder token, Home Assistant preselected", () => {
    const fresh = parseSettings("", "", RELAY);
    expect(fresh.backend).toBe("ha");
    expect(isConfigured(fresh, "", RELAY)).toBe(true);
    expect(isConfigured(fresh, "", "")).toBe(false);
    expect(effectiveHaUrl({ ...fresh, haUrl: "http://192.168.1.5:8123" }, "", RELAY)).toBe(RELAY);
    expect(effectiveHaToken(fresh, RELAY)).toBe(RELAY_PLACEHOLDER_TOKEN);
    expect(JSON.stringify(fresh)).not.toContain("Token");
    // an old "bridge" choice cannot linger in a relay build
    expect(parseSettings(JSON.stringify({ backend: "bridge", bridgeUrl: "http://x.example" }), "", RELAY).backend).toBe("ha");
  });

  it("imports the relay's devices only while the saved list is empty (active = first)", () => {
    const found = parseRelayDevices(CONFIG);
    expect(found.map((d) => d.entityId)).toEqual(["media_player.living_room_tv", "media_player.projector"]);
    const first = importRelayDevices(parseSettings("", "", RELAY), found);
    expect(first.devices).toEqual(found);
    expect(first.activeDevice).toBe(0);
    const kept = { ...first, devices: [found[1]!], activeDevice: 0 };
    expect(importRelayDevices(kept, found)).toBe(kept);
    const same = parseSettings("", "", RELAY);
    expect(importRelayDevices(same, [])).toBe(same);
  });

  it("ignores junk in /config", () => {
    expect(parseRelayDevices(null)).toEqual([]);
    expect(parseRelayDevices({ devices: "x" })).toEqual([]);
    expect(parseRelayDevices({ devices: [{ entityId: "light.kitchen" }, { entityId: "media_player.ok", remoteId: "switch.x" }] }).map((d) => [d.entityId, d.remoteId])).toEqual([["media_player.ok", ""]]);
  });
});

describe("fetching /config", () => {
  it("asks <relay>/config with a plain GET (no custom headers) and parses the devices", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(CONFIG), { status: 200 }));
    const devices = await fetchRelayDevices(RELAY + "/", { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(devices).toHaveLength(2);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(RELAY + "/config");
    expect(init.method).toBe("GET");
    expect(init.headers).toBeUndefined();
  });

  it("an unreachable relay is an ApiError", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    await expect(fetchRelayDevices(RELAY, { fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toMatchObject({ code: "unreachable" });
    await expect(fetchRelayDevices(RELAY, { fetchImpl: (async () => new Response("", { status: 403 })) as unknown as typeof fetch })).rejects.toBeInstanceOf(ApiError);
  });
});

describe("relay card on the phone", () => {
  const settings = parseSettings("", "", RELAY);
  it("says it is automatic and shows the status in both languages", () => {
    expect(relayInner(settings, { kind: "loading" }, "checking", "en")).toContain("Connected automatically via your relay");
    expect(relayInner(settings, { kind: "loading" }, "checking", "de")).toContain("Automatisch verbunden über dein Relay");
    expect(relayInner(settings, { kind: "demo" }, "unreachable", "en")).toContain("Relay not reachable");
    expect(relayInner(settings, { kind: "demo" }, "unreachable", "de")).toContain("Relay nicht erreichbar");
    expect(relayInner(settings, { kind: "demo" }, "empty", "en")).toContain("The relay lists no devices.");
    const withDevices = { ...settings, devices: parseRelayDevices(CONFIG) };
    expect(relayInner(withDevices, { kind: "ok" }, "ok", "en")).toContain("Connected via the relay · 2 device(s)");
    expect(relayInner(withDevices, { kind: "error", reason: "timeout" }, "ok", "en")).toContain("TV not reachable: timeout");
  });

  it("has no token field", () => {
    expect(relayInner(settings, { kind: "ok" }, "ok", "en")).not.toMatch(/<input/i);
  });
});

// ---- the whole app in a relay build ----------------------------------------------------------

const harness = vi.hoisted(() => ({ bridge: null as unknown }));
vi.mock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
  waitForEvenAppBridge: async () => harness.bridge,
}));

const SETTINGS = "quietglass.tvglance.v1";

function glasses(stored: Record<string, string> = {}) {
  const storage = new Map(Object.entries(stored));
  const bridge = {
    getLocalStorage: vi.fn(async (key: string) => storage.get(key) ?? ""),
    setLocalStorage: vi.fn(async (key: string, value: string) => { storage.set(key, value); return true; }),
    getUserInfo: vi.fn(async () => ({ country: "AT" })),
    updateImageRawData: vi.fn(async () => "success"),
    rebuildPageContainer: vi.fn(async () => true),
    createStartUpPageContainer: vi.fn(async () => 0),
    textContainerUpgrade: vi.fn(async () => true),
    shutDownPageContainer: vi.fn(async () => true),
    onEvenHubEvent: () => () => undefined,
    onDeviceStatusChanged: () => () => undefined,
  };
  return { bridge, storage, saved: () => JSON.parse(storage.get(SETTINGS) ?? "{}") as Record<string, unknown> };
}

async function boot(fake: ReturnType<typeof glasses>) {
  const root = fakeRoot();
  vi.stubGlobal("document", { getElementById: () => root, activeElement: null });
  vi.stubGlobal("navigator", { language: "en-US" });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
  harness.bridge = fake.bridge;
  vi.resetModules();
  await import("../src/main");
  await vi.waitFor(() => expect(fake.bridge.getLocalStorage).toHaveBeenCalled());
  return root;
}

describe("a relay build of the app", () => {
  let ws: ReturnType<typeof fakeHaWs>;
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    resetGestureDedupe();
    vi.stubEnv("VITE_HA_RELAY", RELAY);   // (the glasses fake reports country AT: the phone page is German)
    // The fake "Home Assistant" accepts exactly the placeholder: the relay would ignore the token anyway.
    ws = fakeHaWs({ token: RELAY_PLACEHOLDER_TOKEN });
    fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify(CONFIG), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", ws.WebSocket);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("first start, no token typed: fetches /config, stores the devices, connects through the relay with the placeholder", async () => {
    const fake = glasses();
    const root = await boot(fake);
    await vi.waitFor(() => expect((fake.saved()["devices"] as unknown[] | undefined)?.length).toBe(2));
    const saved = fake.saved();
    expect(saved["activeDevice"]).toBe(0);
    expect((saved["devices"] as { entityId: string; name: string }[])[0]).toMatchObject({ entityId: "media_player.living_room_tv", name: "Living Room" });
    expect(saved["haToken"]).toBeUndefined();
    expect(saved["haUrl"]).toBe("");
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([RELAY + "/config"]);
    await vi.waitFor(() => expect(ws.urls).toEqual(["wss://relay.example:8483/api/websocket"]));
    await vi.waitFor(() => expect(ws.sent[0]).toEqual({ type: "auth", access_token: RELAY_PLACEHOLDER_TOKEN }));
    await vi.waitFor(() => expect(root.innerHTML).toContain("Automatisch verbunden über dein Relay"));
    expect(root.innerHTML).not.toContain('id="ha-token"');
    expect(root.innerHTML).not.toContain('id="backend"');
    expect(root.innerHTML).not.toContain("In drei Schritten");
  });

  it("saved devices: /config is not fetched and the saved list stays", async () => {
    const stored = { backend: "ha", devices: [{ entityId: "media_player.projector", remoteId: "", name: "Mine" }], activeDevice: 0 };
    const fake = glasses({ [SETTINGS]: JSON.stringify(stored) });
    await boot(fake);
    await vi.waitFor(() => expect(ws.urls).toHaveLength(1));
    expect(fetchMock).not.toHaveBeenCalled();
    expect((fake.saved()["devices"] as unknown[] | undefined) ?? stored.devices).toHaveLength(1);
    expect(ws.sent[0]).toEqual({ type: "auth", access_token: RELAY_PLACEHOLDER_TOKEN });
  });

  it("unreachable relay: a clear status on the phone, nothing stored, no connection attempt", async () => {
    fetchMock.mockImplementation(async () => { throw new TypeError("Failed to fetch"); });
    const fake = glasses();
    const root = await boot(fake);
    await vi.waitFor(() => expect(root.innerHTML).toContain("Relay nicht erreichbar"));
    expect(fake.storage.has(SETTINGS)).toBe(false);
    expect(ws.urls).toEqual([]);
  });
});
