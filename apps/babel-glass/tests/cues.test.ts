import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCueWatcher, CUE_INTERVAL_MS, CUE_KEEP, CUE_MARK, CUE_MAX_CHARS, CUE_POPUP_MS, CUE_ROWS, CUE_WIDTH,
  cueCardsOn, cueRows, cueSummaryBlock, cueTranscript, cueUrl, cuesHtml, fetchCue, keepCue, readCue, type CueCard,
} from "../src/companion/cues";
import { emptySlot, offerPopup, visiblePopup } from "../src/companion/popups";
import { popupRows, type ViewPopup } from "../src/glasses/view";
import { conversationInner } from "../src/ui/phone";
import { EMPTY_DATA, parseData } from "../src/storage/persist";
import { resetGestureDedupe } from "../src/input/gestures";

const card = (over: Partial<CueCard> = {}): CueCard => ({
  title: "Color Codes präzise anfordern", text: "Frage nach HEX/RGB und CMYK/Pantone.", kind: "tipp", at: Date.UTC(2026, 9, 14, 8, 2), ...over,
});

describe("cues: parsing, rows, widths", () => {
  it("reads {cue:{…}}, a bare card, and treats none / malformed as nothing", () => {
    expect(readCue({ cue: { title: "Hero-Produkte abfragen", text: "Welche Produkte stehen im Fokus?", kind: "tipp" } }, 5))
      .toEqual({ title: "Hero-Produkte abfragen", text: "Welche Produkte stehen im Fokus?", kind: "tipp", at: 5 });
    expect(readCue({ title: "Gemeint: Corporate Identity (CI)", text: "Nicht Copyright.", kind: "begriff" }, 1)?.kind).toBe("begriff");
    for (const bad of [null, "x", { none: true }, { cue: { title: "", text: "x" } }, { cue: { title: "x" } }, 5]) expect(readCue(bad, 1)).toBeNull();
    expect(readCue({ cue: { title: "a", text: "b", kind: "egal" } }, 1)?.kind).toBe("tipp");
    const long = readCue({ cue: { title: "T".repeat(80), text: "x ".repeat(200), kind: "fakt" } }, 1)!;
    expect([...long.title].length).toBeLessThanOrEqual(40);
    expect([...long.text].length).toBeLessThanOrEqual(140);
  });

  it("builds the proxy URL like the other context calls", () => {
    expect(cueUrl("https://proxy.example/v1/")).toBe("https://proxy.example/context/cue");
    expect(cueUrl("https://proxy.example/v1/chat/completions")).toBe("https://proxy.example/context/cue");
  });

  it("rows: marker + title, then the sentence; at most 3 rows of 46", () => {
    expect(cueRows(card())).toEqual(["* Color Codes präzise anfordern", "Frage nach HEX/RGB und CMYK/Pantone."]);
    expect(cueRows(card({ kind: "achtung", title: "Hinweisschild ersetzt keine Einwilligung" }))[0]).toBe("! Hinweisschild ersetzt keine Einwilligung");
    expect(Object.values(CUE_MARK)).toEqual(["*", "?", "#", "!"]);
    const rows = cueRows(card({ kind: "fakt", title: "T".repeat(40), text: "Wort ".repeat(28).trim() }));
    expect(rows.length).toBe(CUE_ROWS);
    for (const row of rows) expect([...row].length).toBeLessThanOrEqual(CUE_WIDTH);
    expect(rows.at(-1)!.endsWith("…")).toBe(true);
    // On the glasses: no kind label (plain), the rows as they are.
    const popup: ViewPopup = { term: "x", info: "y", kind: "cue", lines: cueRows(card()), plain: true };
    expect(popupRows(popup, "de")).toEqual(cueRows(card()));
  });

  it("transcript window: last 3 minutes, newest kept within 6000 chars", () => {
    const now = 10_000_000;
    const log = [
      { text: "zu alt", at: now - 4 * 60_000, speaker: "A" },
      { text: "Wir drehen am Donnerstag.", at: now - 60_000, speaker: "B" },
      { text: "Gut.", at: now - 1000 },
    ];
    expect(cueTranscript(log, now)).toBe("B: Wir drehen am Donnerstag.\nGut.");
    const many = Array.from({ length: 400 }, (_, i) => ({ text: "Zeile " + i + " " + "x".repeat(30), at: now - 1000 }));
    const text = cueTranscript(many, now);
    expect(text.length).toBeLessThanOrEqual(CUE_MAX_CHARS);
    expect(text.endsWith("Zeile 399 " + "x".repeat(30))).toBe(true);
  });

  it("keeps the last 50 cards; the summary block lists them with time", () => {
    let cards: CueCard[] = [];
    for (let i = 0; i < 60; i += 1) cards = keepCue(cards, card({ title: "K" + i }));
    expect(cards.length).toBe(CUE_KEEP);
    expect(cards[0]!.title).toBe("K10");
    expect(cueSummaryBlock([], "de")).toBe("");
    const block = cueSummaryBlock([card()], "de");
    expect(block.startsWith("\n\nTipp-Karten während des Gesprächs")).toBe(true);
    expect(block).toMatch(/- \d\d:\d\d Color Codes präzise anfordern: Frage nach HEX/);
  });

  it("setting Tipp-Karten: default on, only false switches off", () => {
    expect(cueCardsOn(EMPTY_DATA)).toBe(true);
    expect(cueCardsOn(parseData("{}"))).toBe(true);
    expect(cueCardsOn(parseData('{"cueCards":false}'))).toBe(false);
    expect(cueCardsOn(parseData('{"cueCards":true}'))).toBe(true);
  });

  it("phone: the Gespräch tab lists the cards with time, newest first, escaped", () => {
    const html = conversationInner({
      log: [], pending: null, summary: null, insights: [], canSummarize: false,
      cues: [card({ title: "Erst <b>", at: Date.UTC(2026, 9, 14, 8, 0) }), card({ title: "Dann", kind: "achtung" })],
    }, "de");
    expect(html).toContain("<h3>Tipp-Karten</h3>");
    expect(html.indexOf("! Dann")).toBeLessThan(html.indexOf("Erst"));
    expect(html).toContain("* Erst &lt;b&gt;");
    expect(html).toMatch(/<small>\d\d:\d\d<\/small>/);
    expect(cuesHtml([], "de")).toBe("");
    expect(conversationInner({ log: [], pending: null, summary: null, insights: [], canSummarize: false }, "de")).not.toContain("Tipp-Karten");
  });
});

describe("cues: popup priority", () => {
  it("word finder > own sentence > reply > cue: a cue never replaces them and waits only briefly", () => {
    const now = 1000;
    const cue: ViewPopup = { term: "", info: "", kind: "cue" };
    for (const kind of ["word", "say", "reply", "info"] as const) {
      let slot = offerPopup(emptySlot<ViewPopup>(), kind, { term: "", info: "", kind }, 12_000, now).slot;
      const offered = offerPopup(slot, "cue", cue, CUE_POPUP_MS, now + 10);
      expect(offered.shown).toBe(false);
      slot = offered.slot;
      expect(visiblePopup(slot, now + 20)?.kind).toBe(kind);
    }
    // A cue on screen gives way to everything else.
    const shown = offerPopup(emptySlot<ViewPopup>(), "cue", cue, CUE_POPUP_MS, now).slot;
    expect(visiblePopup(shown, now)?.kind).toBe("cue");
    expect(offerPopup(shown, "reply", { term: "", info: "", kind: "reply" }, 12_000, now + 1).shown).toBe(true);
    expect(visiblePopup(shown, now + CUE_POPUP_MS + 1)).toBeNull();
  });
});

describe("cues: watcher timing and throttle", () => {
  function setup(over: { enabled?: boolean; blocked?: boolean } = {}) {
    const state = { enabled: over.enabled ?? true, blocked: over.blocked ?? false, lines: 0, requests: 0, shown: [] as CueCard[] };
    let answer: (card: CueCard | null) => void = () => undefined;
    const watcher = createCueWatcher({
      enabled: () => state.enabled,
      blocked: () => state.blocked,
      lines: () => state.lines,
      request: () => { state.requests += 1; return new Promise((resolve) => { answer = resolve; }); },
      onCue: (c) => { state.shown.push(c); },
    });
    return { state, watcher, answer: (c: CueCard | null) => answer(c) };
  }
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("asks every 20 s, only with at least 2 new final lines since the last request", async () => {
    const { state, watcher, answer } = setup();
    watcher.start(0);
    state.lines = 5;
    watcher.tick(CUE_INTERVAL_MS - 1);
    expect(state.requests).toBe(0); // not yet 20 s
    watcher.tick(CUE_INTERVAL_MS);
    expect(state.requests).toBe(1);
    watcher.tick(CUE_INTERVAL_MS + 100);
    expect(state.requests).toBe(1); // one at a time
    answer(card());
    await flush();
    expect(state.shown.length).toBe(1);
    state.lines = 6; // only one new line
    watcher.tick(2 * CUE_INTERVAL_MS);
    expect(state.requests).toBe(1);
    state.lines = 7;
    watcher.tick(2 * CUE_INTERVAL_MS + 500);
    expect(state.requests).toBe(2);
    answer(null);
    await flush();
    expect(state.shown.length).toBe(1);
  });

  it("lines before the start do not count", () => {
    const { state, watcher } = setup();
    state.lines = 40;
    watcher.start(0);
    state.lines = 41;
    watcher.tick(CUE_INTERVAL_MS);
    expect(state.requests).toBe(0);
  });

  it("nothing while disabled (not client mode / setting off) or while a reply suggestion is up", () => {
    const off = setup({ enabled: false });
    off.watcher.start(0); off.state.lines = 9; off.watcher.tick(CUE_INTERVAL_MS);
    expect(off.state.requests).toBe(0);
    const blocked = setup({ blocked: true });
    blocked.watcher.start(0); blocked.state.lines = 9; blocked.watcher.tick(CUE_INTERVAL_MS);
    expect(blocked.state.requests).toBe(0);
    blocked.state.blocked = false;
    blocked.watcher.tick(CUE_INTERVAL_MS + 500); // goes as soon as the popup is gone
    expect(blocked.state.requests).toBe(1);
  });

  it("an answer after stop is dropped", async () => {
    const { state, watcher, answer } = setup();
    watcher.start(0); state.lines = 3; watcher.tick(CUE_INTERVAL_MS);
    watcher.stop();
    answer(card());
    await flush();
    expect(state.shown).toEqual([]);
    expect(watcher.busy).toBe(false);
  });
});

describe("cues: fetchCue", () => {
  it("posts transcript, recent titles, model and the customer header; never throws", async () => {
    const seen: { url: string; init: { headers: Record<string, string>; body: string } }[] = [];
    const fetchImpl = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
      seen.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ cue: { title: "Donnerstag ideal für Bäckereidreh", text: "Frische Ware am Vormittag.", kind: "fakt" } }) };
    }) as unknown as typeof fetch;
    const got = await fetchCue({ url: "https://p.example/v1", apiKey: "k", customer: "c_3", model: "m", fetchImpl, now: () => 7 },
      { transcript: "A: Wann?", recentTitles: ["Hero-Produkte abfragen"] });
    expect(got).toEqual({ title: "Donnerstag ideal für Bäckereidreh", text: "Frische Ware am Vormittag.", kind: "fakt", at: 7 });
    expect(seen[0]!.url).toBe("https://p.example/context/cue");
    expect(seen[0]!.init.headers["X-Babel-Customer"]).toBe("c_3");
    expect(seen[0]!.init.headers["Authorization"]).toBe("Bearer k");
    expect(JSON.parse(seen[0]!.init.body)).toEqual({ transcript: "A: Wann?", recent_titles: ["Hero-Produkte abfragen"], model: "m" });
    const failing = (async () => { throw new Error("down"); }) as unknown as typeof fetch;
    expect(await fetchCue({ url: "https://p.example/v1", fetchImpl: failing }, { transcript: "x", recentTitles: [] })).toBeNull();
    const notOk = (async () => ({ ok: false, status: 504, json: async () => ({ none: true }) })) as unknown as typeof fetch;
    expect(await fetchCue({ url: "https://p.example/v1", fetchImpl: notOk }, { transcript: "x", recentTitles: [] })).toBeNull();
    expect(await fetchCue({ url: "https://p.example/v1", fetchImpl: failing }, { transcript: " ", recentTitles: [] })).toBeNull();
  });

  it("gives up after the timeout", async () => {
    vi.useFakeTimers();
    try {
      const hang = (() => new Promise(() => undefined)) as unknown as typeof fetch;
      const pending = fetchCue({ url: "https://p.example/v1", fetchImpl: hang, timeoutMs: 1000 }, { transcript: "x", recentTitles: [] });
      await vi.advanceTimersByTimeAsync(1001);
      expect(await pending).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---- In the running app (demo recogniser + a stubbed proxy) ----
const harness = vi.hoisted(() => ({ bridge: null as unknown }));
vi.mock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
  waitForEvenAppBridge: async () => harness.bridge,
}));

function bridge(stored: Record<string, string>) {
  let handler: ((event: unknown) => void) | undefined;
  const storage = new Map(Object.entries(stored));
  const text = new Map<number, string>();
  const remember = (parts: { containerID?: number; content?: string }[] | undefined): void => {
    for (const part of parts ?? []) if (part.containerID !== undefined) text.set(part.containerID, part.content ?? "");
  };
  type Built = { textObject?: { containerID?: number; content?: string }[] };
  const b = {
    getLocalStorage: async (key: string) => storage.get(key) ?? "",
    setLocalStorage: async (key: string, value: string) => { storage.set(key, value); return true; },
    rebuildPageContainer: async (built: Built) => { remember(built.textObject); return true; },
    createStartUpPageContainer: async (built: Built) => { remember(built.textObject); return 0; },
    textContainerUpgrade: async (update: { containerID?: number; content?: string }) => { remember([update]); return true; },
    updateImageRawData: async () => "success",
    audioControl: async () => true,
    shutDownPageContainer: async () => true,
    onEvenHubEvent: (callback: (event: unknown) => void) => { handler = callback; return () => undefined; },
    onDeviceStatusChanged: () => () => undefined,
  };
  return {
    bridge: b, storage,
    body: () => text.get(2) ?? "",
    emit: (eventType: number) => (resetGestureDedupe(), handler?.({ sysEvent: { eventType, eventSource: 1 } })),
    menu: (itemID: number) => handler?.({ menuItemClickEvent: { itemID } }),
    ready: () => handler !== undefined,
  };
}

describe("cues in the app", () => {
  const SETTINGS_KEY = "quietglass.babelglass.v1";
  const SERVER = { llmUrl: "https://proxy.example/v1", llmModel: "m", insights: false, memory: false, replySuggestions: false, autoSummary: false };
  type Call = { url: string; headers: Record<string, string>; body: string };
  const LIST = { context: true, enabled: true, customers: [{ id: "c_3", name: "Beispiel Café", company: "", next: null }] };
  function stub(): Call[] {
    const calls: Call[] = [];
    vi.stubGlobal("fetch", (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
      calls.push({ url: String(url), headers: { ...(init?.headers ?? {}) }, body: init?.body ?? "" });
      if (String(url).endsWith("/context/customers")) return Promise.resolve({ ok: true, status: 200, json: async () => LIST });
      if (String(url).includes("/context/customer?full=1")) return Promise.resolve({ ok: true, status: 200, json: async () => ({ context: true, enabled: true, name: "Beispiel Café" }) });
      if (String(url).endsWith("/context/cue")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ cue: { title: "Konkrete Hero-Produkte abfragen", text: "Welche zwei, drei Produkte sollen im Fokus stehen?", kind: "tipp" } }) });
      }
      return Promise.resolve({ ok: false, status: 500, json: async () => ({}), text: async () => "" });
    });
    return calls;
  }
  beforeEach(() => {
    resetGestureDedupe();
    vi.useFakeTimers();
    vi.stubGlobal("document", { getElementById: () => null, querySelector: () => null });
    vi.stubGlobal("navigator", { language: "de-DE" });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  async function boot(stored: Record<string, unknown>) {
    const fake = bridge({ [SETTINGS_KEY]: JSON.stringify(stored) });
    harness.bridge = fake.bridge;
    vi.resetModules();
    await import("../src/main");
    await vi.waitFor(() => expect(fake.ready()).toBe(true));
    await vi.advanceTimersByTimeAsync(50);
    return fake;
  }

  it("Kundengespräch: a card about every 20 s with the customer header, shown 8 s on top of the captions", async () => {
    const calls = stub();
    const fake = await boot({ ...SERVER, talkMode: "translate" });
    fake.emit(0); // the customer row: client talk with Beispiel Café
    await vi.advanceTimersByTimeAsync(CUE_INTERVAL_MS - 1000);
    expect(calls.filter((c) => c.url.endsWith("/context/cue"))).toEqual([]);
    await vi.advanceTimersByTimeAsync(1600);
    const cueCalls = calls.filter((c) => c.url.endsWith("/context/cue"));
    expect(cueCalls.length).toBe(1);
    expect(cueCalls[0]!.headers["X-Babel-Customer"]).toBe("c_3");
    const sent = JSON.parse(cueCalls[0]!.body) as { transcript: string; recent_titles: string[] };
    expect(sent.transcript.split("\n").length).toBeGreaterThanOrEqual(2);
    expect(sent.recent_titles).toEqual([]);
    expect(fake.body().split("\n").slice(0, 2)).toEqual(["* Konkrete Hero-Produkte abfragen", "Welche zwei, drei Produkte sollen im Fokus"]);
    await vi.advanceTimersByTimeAsync(CUE_POPUP_MS + 500);
    expect(fake.body()).not.toContain("Hero-Produkte");
    // The next request names the card already shown.
    await vi.advanceTimersByTimeAsync(CUE_INTERVAL_MS);
    const next = calls.filter((c) => c.url.endsWith("/context/cue"));
    expect(next.length).toBe(2);
    expect((JSON.parse(next[1]!.body) as { recent_titles: string[] }).recent_titles).toEqual(["Konkrete Hero-Produkte abfragen"]);
  });

  it("never in Übersetzen mode, and not with the setting off", async () => {
    let calls = stub();
    let fake = await boot({ ...SERVER, talkMode: "client" });
    fake.emit(1); // cursor to "Ohne Kunde – Übersetzen"
    fake.emit(2); // the list goes on with the voice rows: one step down is the "No customer" row
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.body().split("\n")[1]).toMatch(/^> /);
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(3 * CUE_INTERVAL_MS);
    expect(calls.some((c) => c.url.endsWith("/context/cue"))).toBe(false);

    calls = stub();
    fake = await boot({ ...SERVER, talkMode: "translate", cueCards: false });
    fake.emit(0); // customer row: client talk, but the cards are off
    await vi.advanceTimersByTimeAsync(3 * CUE_INTERVAL_MS);
    expect(calls.some((c) => c.url.endsWith("/context/cue"))).toBe(false);
  });
});
