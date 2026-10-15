import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import geocodeAnswer from "./fixtures/geocode-salzburg.json";
import { resetGestureDedupe } from "../src/input/gestures";
import { PLACES_KEY, serializePlaces } from "../src/route/places";
import { buildWav } from "../src/audio/wav";
import { MAX_VOICE_MS, MIN_VOICE_BYTES, pcmBytes, sttBase, sttEndpoint, transcribe } from "../src/voice/stt";
import { voiceView } from "../src/route/view";
import { menuFor } from "../src/route/menu";

const harness = vi.hoisted(() => ({ bridge: null as unknown }));
vi.mock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
  waitForEvenAppBridge: async () => harness.bridge,
}));

const nodeProcess = (globalThis as unknown as {
  process: { on(e: string, l: (r: unknown) => void): void; off(e: string, l: (r: unknown) => void): void };
}).process;

describe("the recording as a WAV file", () => {
  it("is a 16-bit mono PCM file at 16 kHz with the samples untouched", () => {
    const wav = buildWav([new Uint8Array([1, 2, 3, 4]), new Uint8Array([5, 6])]);
    const view = new DataView(wav.buffer);
    const text = (at: number, n: number): string => String.fromCharCode(...wav.subarray(at, at + n));
    expect(wav.length).toBe(44 + 6);
    expect(text(0, 4)).toBe("RIFF");
    expect(text(8, 4)).toBe("WAVE");
    expect(text(12, 4)).toBe("fmt ");
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint32(28, true)).toBe(32000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(text(36, 4)).toBe("data");
    expect(view.getUint32(40, true)).toBe(6);
    expect([...wav.subarray(44)]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("reads audio blocks in every shape the host may deliver", () => {
    expect([...pcmBytes(new Uint8Array([1, 2]))!]).toEqual([1, 2]);
    expect([...pcmBytes([3, 4])!]).toEqual([3, 4]);
    expect([...pcmBytes(btoa("AB"))!]).toEqual([65, 66]);
    expect(pcmBytes(5)).toBeNull();
    expect(pcmBytes("%%%")).toBeNull();
  });
});

describe("the speech server address", () => {
  it("is the phone setting, else the build default, else none", () => {
    expect(sttBase("https://a.test:8457/", "https://b.test")).toBe("https://a.test:8457");
    expect(sttBase("", "https://b.test/")).toBe("https://b.test");
    expect(sttBase("  ", "")).toBe("");
  });

  it("points at the OpenAI-compatible transcription endpoint", () => {
    expect(sttEndpoint("https://a.test:8457")).toBe("https://a.test:8457/v1/audio/transcriptions");
    expect(sttEndpoint("https://a.test/v1/audio/transcriptions")).toBe("https://a.test/v1/audio/transcriptions");
  });
});

describe("uploading the recording", () => {
  it("posts form data with a file and the language, and sets no header of its own", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ text: "  Hauptbahnhof   Salzburg " }), { status: 200 });
    }) as unknown as typeof fetch;
    const text = await transcribe(buildWav([new Uint8Array(64)]), "https://stt.test:8457", "de", fetchImpl);
    expect(text).toBe("Hauptbahnhof Salzburg");
    expect(calls[0]!.url).toBe("https://stt.test:8457/v1/audio/transcriptions");
    expect(calls[0]!.init.method).toBe("POST");
    // No Content-Type or Authorization: a form post is a simple request, so no CORS preflight.
    expect(calls[0]!.init.headers).toBeUndefined();
    const form = calls[0]!.init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("language")).toBe("de");
    const file = form.get("file") as File;
    expect(file.name).toBe("voice.wav");
    expect(file.type).toBe("audio/wav");
    expect(file.size).toBe(44 + 64);
  });

  it("returns nothing for an answer without text, and fails on a refusal", async () => {
    const ok = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    expect(await transcribe(new Uint8Array(50), "https://x.test", "en", ok)).toBe("");
    const no = (async () => new Response("busy", { status: 503 })) as unknown as typeof fetch;
    await expect(transcribe(new Uint8Array(50), "https://x.test", "en", no)).rejects.toThrow("HTTP 503");
  });
});

describe("the voice page", () => {
  const NOW = new Date(2026, 9, 13, 14, 29);

  it("shows the recording, the work, the hits and the errors", () => {
    expect(voiceView({ phase: "recording" }, NOW, "de")).toEqual({
      header: "NEXTSTOP · Spracheingabe · 14:29",
      body: ["● Aufnahme …", "loslassen = fertig", "", "Sag das Ziel, z. B. „Hauptbahnhof“."],
      footer: "Halten = sprechen · 2× = zurück",
    });
    expect(voiceView({ phase: "working" }, NOW, "de").body).toEqual(["Verstehe …"]);
    const results = voiceView({
      phase: "results", heard: "Hauptbahnhof Salzburg", selected: 1, saved: false,
      results: [
        { name: "Salzburg Hauptbahnhof", detail: "5020 Salzburg, AT", kind: "stop", lat: 1, lon: 1 },
        { name: "B+R Salzburg Hauptbahnhof", detail: "5020 Salzburg, AT", kind: "place", lat: 1, lon: 1 },
      ],
    }, NOW, "de");
    expect(results.body).toEqual([
      "Verstanden: Hauptbahnhof Salzburg",
      "  Salzburg Hauptbahnhof", "  5020 Salzburg, AT",
      "> B+R Salzburg Hauptbahnhof", "  5020 Salzburg, AT",
    ]);
    expect(voiceView({ phase: "error", error: "Zu kurz", hint: "Halte den Touchpad." }, NOW, "de").body).toEqual(["Zu kurz", "", "Halte den Touchpad."]);
  });

  it("has a menu to keep the hit as a favourite", () => {
    expect(menuFor("voice", "de").items.map((item) => item.label)).toEqual(["Als Favorit merken", "Ziele", "Hilfe"]);
    expect(MIN_VOICE_BYTES).toBe(12800);
    expect(MAX_VOICE_MS).toBe(30_000);
  });
});

// ---- the whole flow against a fake bridge -------------------------------------

interface Fake { bridge: unknown; state: { header: string; body: string; footer: string; mic: boolean[]; saved: Map<string, string> }; send: (event: unknown) => void; gesture: (code: number) => void; menu: (id: number) => void; ready: () => boolean }

function fakeBridge(stored: Record<string, string> = {}, micGranted = true): Fake {
  let onEvent: ((event: unknown) => void) | undefined;
  const state = { header: "", body: "", footer: "", mic: [] as boolean[], saved: new Map<string, string>() };
  const record = (id: number | undefined, content: string | undefined): void => {
    if (id === 1) state.header = content ?? "";
    if (id === 2) state.body = content ?? "";
    if (id === 3) state.footer = content ?? "";
  };
  const bridge = {
    getLocalStorage: async (key: string) => stored[key] ?? "",
    setLocalStorage: async (key: string, value: string) => { state.saved.set(key, value); return true; },
    rebuildPageContainer: async (page: { textObject?: { containerID?: number; content?: string }[] }) => {
      for (const t of page.textObject ?? []) record(t.containerID, t.content);
      return true;
    },
    createStartUpPageContainer: async (page: { textObject?: { containerID?: number; content?: string }[] }) => {
      for (const t of page.textObject ?? []) record(t.containerID, t.content);
      return 0;
    },
    textContainerUpgrade: async (u: { containerID?: number; content?: string }) => { record(u.containerID, u.content); return true; },
    startAppLocationUpdates: async () => true,
    stopAppLocationUpdates: async () => true,
    getAppLocation: async () => ({ latitude: 47.8095, longitude: 13.055 }),
    audioControl: async (on: boolean) => { state.mic.push(on); return on ? micGranted : true; },
    shutDownPageContainer: async () => true,
    onAppLocationChanged: () => () => undefined,
    onEvenHubEvent: (cb: (e: unknown) => void) => { onEvent = cb; return () => undefined; },
    onDeviceStatusChanged: () => () => undefined,
  };
  return {
    bridge, state,
    ready: () => onEvent !== undefined,
    send: (event) => onEvent?.(event),
    gesture: (eventType) => { resetGestureDedupe(); onEvent?.({ sysEvent: { eventType, eventSource: 1 } }); },
    menu: (itemID) => onEvent?.({ menuItemClickEvent: { itemID } }),
  };
}

const LONG_PRESS = 9;
const LONG_PRESS_RELEASE = 10;
const CLICK = 0;
const DOUBLE = 3;
const HOME = { favorites: [{ id: "h", name: "Heim", lat: 47.796, lon: 13.016 }], now: null };

describe("saying a destination", () => {
  let unhandled: unknown[];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };

  beforeEach(() => {
    unhandled = [];
    nodeProcess.on("unhandledRejection", onUnhandled);
    vi.stubGlobal("document", { getElementById: () => null });
    vi.stubGlobal("navigator", { language: "de-AT" });
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    nodeProcess.off("unhandledRejection", onUnhandled);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    expect(unhandled).toEqual([]);
  });

  async function boot(fake: Fake, search: string, fetchImpl: (url: string, init?: RequestInit) => Promise<Response>): Promise<void> {
    vi.stubGlobal("location", { search });
    vi.stubGlobal("fetch", vi.fn(fetchImpl));
    harness.bridge = fake.bridge;
    vi.resetModules();
    await import("../src/main");
    await vi.waitFor(() => expect(fake.ready()).toBe(true));
  }

  it("demo: hold, release, a heard text and up to three hits, then connections", async () => {
    const fake = fakeBridge();
    await boot(fake, "?demo=1&lang=de", () => Promise.reject(new Error("no network in the demo")));
    fake.menu(1);
    await vi.waitFor(() => expect(fake.state.header).toMatch(/^NEXTSTOP · Wohin\?/));

    fake.gesture(LONG_PRESS);
    await vi.waitFor(() => expect(fake.state.body).toContain("● Aufnahme …"));
    expect(fake.state.header).toMatch(/^NEXTSTOP · Spracheingabe/);
    fake.gesture(LONG_PRESS_RELEASE);
    await vi.waitFor(() => expect(fake.state.body).toContain("Verstanden: Hauptbahnhof Salzburg"));
    expect(fake.state.body).toContain("> Salzburg Hauptbahnhof");
    expect(fake.state.body.split("\n").filter((line) => line.startsWith("  ") || line.startsWith("> "))).toHaveLength(6);
    expect(fake.state.mic).toEqual([]);

    fake.gesture(CLICK);
    // The connections: the first one big (pictures), where to board and the next two as rows.
    await vi.waitFor(() => expect(fake.state.footer).toMatch(/^1\/4 · Tippen = los/));
    await vi.waitFor(() => expect(fake.state.body).toMatch(/^Ab .+ zu Fuß\nin \d+ min · /));
  });

  it("demo: the menu keeps a hit as a favourite, double tap drops the page", async () => {
    const fake = fakeBridge();
    await boot(fake, "?demo=1&lang=de&scene=voice", () => Promise.reject(new Error("no network")));
    await vi.waitFor(() => expect(fake.state.body).toContain("Verstanden:"));
    fake.menu(9); // QIS v1.2: the first click arms
    await vi.waitFor(() => expect(fake.state.footer).toBe("Nochmal tippen = merken · Wischen/2× = abbrechen"));
    fake.menu(9); // the second click within 4 s keeps it
    await vi.waitFor(() => expect(fake.state.footer).toBe("gemerkt · Tippen = los · 2× = zurück"));
    expect(fake.state.saved.size).toBe(0); // the demo never writes
    fake.gesture(DOUBLE);
    await vi.waitFor(() => expect(fake.state.header).toMatch(/^NEXTSTOP · Wohin\?/));
    expect(fake.state.body).toContain("Salzburg Hauptbahnhof");
  });

  it("says a Whisper server is needed when none is set", async () => {
    // A private build may carry a default; this is the public build.
    vi.stubEnv("VITE_STT_URL", "");
    const fake = fakeBridge({ [PLACES_KEY]: serializePlaces(HOME) });
    await boot(fake, "", () => Promise.resolve(new Response("[]", { status: 200 })));
    fake.menu(1);
    await vi.waitFor(() => expect(fake.state.header).toMatch(/^NEXTSTOP · Wohin\?/));
    fake.gesture(LONG_PRESS);
    await vi.waitFor(() => expect(fake.state.body).toContain("Spracheingabe braucht einen eigenen Whisper-Server"));
    expect(fake.state.body).toContain("Erweitert");
    expect(fake.state.mic).toEqual([]);
    fake.gesture(CLICK);
    await vi.waitFor(() => expect(fake.state.header).toMatch(/^NEXTSTOP · Wohin\?/));
  });

  it("records from the glasses, uploads the file, looks the words up and shows the hit", async () => {
    const settings = JSON.stringify({ backend: "motis", motisUrl: "https://api.transitous.org", oebbUrl: "http://127.0.0.1:8079/oebb", sttUrl: "https://stt.test:8457", refreshSeconds: 30 });
    const fake = fakeBridge({ "quietglass.nextstop.v1": settings, [PLACES_KEY]: serializePlaces(HOME) });
    const seen: { url: string; init?: RequestInit | undefined }[] = [];
    await boot(fake, "", async (url, init) => {
      seen.push({ url, init });
      if (url.includes("/v1/audio/transcriptions")) return new Response(JSON.stringify({ text: "Hauptbahnhof Salzburg" }), { status: 200 });
      if (url.includes("/api/v1/geocode")) return new Response(JSON.stringify(geocodeAnswer), { status: 200 });
      return new Response("[]", { status: 200 });
    });
    fake.menu(1);
    await vi.waitFor(() => expect(fake.state.header).toMatch(/^NEXTSTOP · Wohin\?/));

    fake.gesture(LONG_PRESS);
    await vi.waitFor(() => expect(fake.state.mic).toEqual([true]));
    await vi.waitFor(() => expect(fake.state.body).toContain("● Aufnahme …"));
    fake.send({ audioEvent: { audioPcm: new Uint8Array(16000) } });
    fake.send({ audioEvent: { audioPcm: Array.from(new Uint8Array(16000)) } });
    fake.gesture(LONG_PRESS_RELEASE);
    await vi.waitFor(() => expect(fake.state.body).toContain("Verstanden: Hauptbahnhof Salzburg"));
    expect(fake.state.mic).toEqual([true, false]);

    const upload = seen.find((call) => call.url.includes("/v1/audio/transcriptions"))!;
    expect(upload.url).toBe("https://stt.test:8457/v1/audio/transcriptions");
    expect(upload.init?.headers).toBeUndefined();
    expect(((upload.init?.body as FormData).get("file") as File).size).toBe(44 + 32000);
    expect((upload.init?.body as FormData).get("language")).toBe("de");
    const geocode = new URL(seen.find((call) => call.url.includes("/api/v1/geocode"))!.url);
    expect(geocode.searchParams.get("text")).toBe("Hauptbahnhof Salzburg");
    expect(geocode.searchParams.get("place")).toBe("47.8095,13.055");
    expect(fake.state.body).toContain("> Salzburg Hauptbahnhof");

    fake.menu(9);
    await vi.waitFor(() => expect(fake.state.footer).toBe("Nochmal tippen = merken · Wischen/2× = abbrechen"));
    expect(fake.state.saved.get(PLACES_KEY) ?? "").not.toContain("Salzburg Hauptbahnhof"); // armed only
    fake.gesture(0); // a single tap confirms as well
    await vi.waitFor(() => expect(fake.state.saved.get(PLACES_KEY) ?? "").toContain("Salzburg Hauptbahnhof"));
    await vi.waitFor(() => expect(fake.state.footer).toBe("gemerkt · Tippen = los · 2× = zurück"));
  });

  it("refuses a mis-press and reports a missing microphone", async () => {
    const settings = JSON.stringify({ sttUrl: "https://stt.test:8457" });
    const short = fakeBridge({ "quietglass.nextstop.v1": settings });
    await boot(short, "", async () => new Response("[]", { status: 200 }));
    short.menu(1);
    await vi.waitFor(() => expect(short.state.header).toMatch(/^NEXTSTOP · Wohin\?/));
    short.gesture(LONG_PRESS);
    await vi.waitFor(() => expect(short.state.mic).toEqual([true]));
    short.send({ audioEvent: { audioPcm: new Uint8Array(100) } });
    short.gesture(LONG_PRESS_RELEASE);
    await vi.waitFor(() => expect(short.state.body).toContain("Zu kurz"));
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes("transcriptions"))).toBe(false);

    const deaf = fakeBridge({ "quietglass.nextstop.v1": settings }, false);
    await boot(deaf, "", async () => new Response("[]", { status: 200 }));
    deaf.menu(1);
    await vi.waitFor(() => expect(deaf.state.header).toMatch(/^NEXTSTOP · Wohin\?/));
    deaf.gesture(LONG_PRESS);
    await vi.waitFor(() => expect(deaf.state.body).toContain("Mikrofon nicht verfügbar"));
  });

  it("says when nothing was understood, when no place matches, and when the server fails", async () => {
    const settings = JSON.stringify({ sttUrl: "https://stt.test:8457" });
    const run = async (reply: (url: string) => Response, expected: string): Promise<void> => {
      const fake = fakeBridge({ "quietglass.nextstop.v1": settings });
      await boot(fake, "", async (url) => reply(url));
      fake.menu(1);
      await vi.waitFor(() => expect(fake.state.header).toMatch(/^NEXTSTOP · Wohin\?/));
      fake.gesture(LONG_PRESS);
      await vi.waitFor(() => expect(fake.state.mic).toEqual([true]));
      fake.send({ audioEvent: { audioPcm: new Uint8Array(32000) } });
      fake.gesture(LONG_PRESS_RELEASE);
      await vi.waitFor(() => expect(fake.state.body).toContain(expected));
    };
    await run((url) => url.includes("transcriptions") ? new Response(JSON.stringify({ text: "" }), { status: 200 }) : new Response("[]", { status: 200 }), "Nichts verstanden");
    await run((url) => url.includes("transcriptions") ? new Response(JSON.stringify({ text: "Xyzzy" }), { status: 200 }) : new Response("[]", { status: 200 }), "Kein Ort gefunden zu: Xyzzy");
    await run((url) => url.includes("transcriptions") ? new Response("down", { status: 502 }) : new Response("[]", { status: 200 }), "Fahrplandienst gestört (502)");
  });
});
