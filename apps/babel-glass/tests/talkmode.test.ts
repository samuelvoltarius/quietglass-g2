import { resetGestureDedupe } from "../src/input/gestures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReplyWatcher, REPLY_DEBOUNCE_MS } from "../src/companion/replies";
import { CLIENT_REPLY_TIMING, effectiveTalkMode, modeData, replyTimingFor } from "../src/companion/talkmode";
import { EMPTY_DATA, parseData, translationEnabled } from "../src/storage/persist";
import { buildView, GLASS_COLS } from "../src/glasses/view";
import { createBuffer } from "../src/captions/buffer";
import { ROW_WIDTH } from "../src/glasses/footer";
import { t } from "../src/messages";
import type { TranscriptEntry } from "../src/companion/transcript";

// 0.6.3: Kundengespräch / Übersetzen. Boots the real app against a fake bridge, like tests/main.test.ts.
const harness = vi.hoisted(() => ({ bridge: null as unknown }));
vi.mock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
  waitForEvenAppBridge: async () => harness.bridge,
}));

const SETTINGS_KEY = "quietglass.babelglass.v1";

function fakeBridge(stored: Record<string, unknown>) {
  let handler: ((event: unknown) => void) | undefined;
  const storage = new Map<string, string>([[SETTINGS_KEY, JSON.stringify(stored)]]);
  const mic = { open: false };
  const text = new Map<number, string>();
  const menus: string[][] = [];
  type Built = { textObject?: { containerID?: number; content?: string }[]; menuObject?: { menuItems?: { itemName?: string }[] } };
  const menuOf = (built: Built): void => { menus.push((built.menuObject?.menuItems ?? []).map((item) => item.itemName ?? "")); };
  const remember = (parts: { containerID?: number; content?: string }[] | undefined): void => {
    for (const part of parts ?? []) if (part.containerID !== undefined) text.set(part.containerID, part.content ?? "");
  };
  const bridge = {
    getLocalStorage: async (key: string) => storage.get(key) ?? "",
    setLocalStorage: async (key: string, value: string) => { storage.set(key, value); return true; },
    rebuildPageContainer: async (built: Built) => { remember(built.textObject); menuOf(built); return true; },
    createStartUpPageContainer: async (built: Built) => { remember(built.textObject); menuOf(built); return 0; },
    textContainerUpgrade: async (update: { containerID?: number; content?: string }) => { remember([update]); return true; },
    updateImageRawData: async () => "success",
    audioControl: async (isOpen: boolean) => { mic.open = isOpen; return true; },
    shutDownPageContainer: async () => true,
    onEvenHubEvent: (callback: (event: unknown) => void) => { handler = callback; return () => undefined; },
    onDeviceStatusChanged: () => () => undefined,
  };
  return {
    bridge, mic, storage, menus,
    menu: (itemID: number) => handler?.({ menuItemClickEvent: { itemID } }),
    header: () => text.get(1) ?? "",
    body: () => text.get(2) ?? "",
    footer: () => text.get(3) ?? "",
    stored: () => JSON.parse(storage.get(SETTINGS_KEY) ?? "{}") as Record<string, unknown>,
    emit: (eventType: number) => (resetGestureDedupe(), handler?.({ sysEvent: { eventType, eventSource: 1 } })),
    ready: () => handler !== undefined,
  };
}

/** A recogniser socket that opens at once and records what it is sent. */
const sockets: OpenSocket[] = [];
class OpenSocket {
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: unknown = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) {
    sockets.push(this);
    setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 1);
  }
  send(data: unknown): void { if (typeof data === "string") this.sent.push(data); }
  close(): void { this.readyState = 3; this.onclose?.(); }
  say(line: string, language: string): void { this.onmessage?.({ data: JSON.stringify({ text: line, final: true, language }) }); }
}

const CUSTOMER = { enabled: true, full: true, name: "Beispiel Café", project: "Imagefilm", ideas: ["Idee 1"], storyboards: [], slogans: [] };

/** Servers: speech + an OpenAI-compatible proxy that translates; reply ideas, popups and memory off to isolate translation calls. */
const SERVERS = {
  sttUrl: "wss://speech.example:8449", llmUrl: "https://proxy.example/v1", llmModel: "m", translateProvider: "openai",
  targetLanguage: "de", sourceLanguage: "auto", replySuggestions: false, insights: false, memory: false,
};

describe("0.6.3 talk mode on the glasses", () => {
  let chatCalls = 0;
  const stubFetch = (withCustomer: boolean): void => {
    chatCalls = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).endsWith("/context/customers")) {
        return withCustomer
          ? { ok: true, status: 200, json: async () => ({ customers: [{ id: "c_1", name: "Beispiel Café", company: "", next: null }] }) }
          : { ok: false, status: 502, json: async () => ({}) };
      }
      if (String(url).includes("/context/customer?full=1")) {
        return withCustomer ? { ok: true, status: 200, json: async () => CUSTOMER } : { ok: false, status: 404, json: async () => ({}) };
      }
      if (String(url).includes("/chat/completions")) chatCalls += 1;
      return { ok: false, status: 500, json: async () => ({}), text: async () => "" };
    });
  };

  beforeEach(() => {
    resetGestureDedupe();
    sockets.length = 0;
    vi.useFakeTimers();
    vi.stubGlobal("document", { getElementById: () => null, querySelector: () => null });
    vi.stubGlobal("navigator", { language: "en-US" });
    vi.stubGlobal("WebSocket", OpenSocket);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  async function boot(fake: ReturnType<typeof fakeBridge>) {
    harness.bridge = fake.bridge;
    vi.resetModules();
    await import("../src/main");
    await vi.waitFor(() => expect(fake.ready()).toBe(true));
    await vi.advanceTimersByTimeAsync(50);
    return fake;
  }

  it("0.7.0: a tap on a customer row switches to client talk, persists it, starts with language de, never translates", async () => {
    stubFetch(true);
    const fake = await boot(fakeBridge({ ...SERVERS, talkMode: "translate" }));
    expect(fake.header()).toBe("BABEL · pick customer");
    expect(fake.body().split("\n")[0]).toBe("> Beispiel Café");
    fake.emit(0); // tap: Kundengespräch with this customer + start
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.mic.open).toBe(true);
    expect(fake.stored()["talkMode"]).toBe("client");
    expect(fake.stored()["sourceLanguage"]).toBe("auto"); // the stored setting is untouched
    const start = JSON.parse(sockets[0]!.sent[0]!) as { type: string; language: string };
    expect(start).toMatchObject({ type: "start", language: "de" });
    sockets[0]!.say("Привет, как дела?", "ru");
    sockets[0]!.say("Wie lange dauert der Dreh?", "de");
    await vi.advanceTimersByTimeAsync(2000);
    expect(chatCalls).toBe(0);
    expect(fake.body()).toContain("Wie lange dauert der Dreh?");
  });

  it("0.7.0: the last row starts the translate mode, which still translates", async () => {
    stubFetch(true);
    const fake = await boot(fakeBridge({ ...SERVERS, talkMode: "client" }));
    fake.emit(2);
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.body().split("\n")[1]).toBe("> No customer – translate");
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.stored()["talkMode"]).toBe("translate");
    expect((JSON.parse(sockets[0]!.sent[0]!) as { language: string }).language).toBe("auto");
    sockets[0]!.say("Привет, как дела?", "ru");
    await vi.advanceTimersByTimeAsync(2000);
    expect(chatCalls).toBeGreaterThan(0);
  });

  it("0.7.0: the side menu toggles the mode and names the mode in force; a pick is kept on the next start", async () => {
    stubFetch(false);
    const fake = await boot(fakeBridge({ ...SERVERS, talkMode: "translate" }));
    expect(fake.menus.every((menu) => menu.length === 0)).toBe(true); // no side menu on the pages
    fake.menu(3); // the click handler is kept for the day the menu comes back
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.stored()["talkMode"]).toBe("client");
    expect(fake.mic.open).toBe(false); // switching the mode never starts the microphone
    const again = await boot(fakeBridge({ ...SERVERS, talkMode: "client" }));
    expect(again.menus.every((menu) => menu.length === 0)).toBe(true);
  });

  it("0.7.0: switching the mode while listening restarts the recogniser with the new language", async () => {
    stubFetch(false);
    const fake = await boot(fakeBridge({ ...SERVERS, talkMode: "translate" }));
    fake.emit(2);
    fake.emit(0); // "No customer – translate"
    await vi.advanceTimersByTimeAsync(50);
    expect((JSON.parse(sockets[0]!.sent[0]!) as { language: string }).language).toBe("auto");
    // QIS v1.2 #3: while captions run, the first click only arms the restart.
    fake.menu(3);
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.stored()["talkMode"]).toBe("translate");
    expect(fake.footer()).toMatch(/^Tap again = restart captions/);
    fake.menu(3);
    await vi.advanceTimersByTimeAsync(3000);
    expect(fake.mic.open).toBe(true);
    expect((JSON.parse(sockets.at(-1)!.sent[0]!) as { language: string }).language).toBe("de");
  });
});

describe("0.6.3 talk mode units", () => {
  it("effective mode: pick wins, else customer → client, else translate", () => {
    expect(effectiveTalkMode(EMPTY_DATA, false)).toBe("translate");
    expect(effectiveTalkMode(EMPTY_DATA, true)).toBe("client");
    expect(effectiveTalkMode({ ...EMPTY_DATA, talkMode: "translate" }, true)).toBe("translate");
    expect(effectiveTalkMode({ ...EMPTY_DATA, talkMode: "client" }, false)).toBe("client");
  });

  it("client mode: source de, translation off, even with a translator configured", () => {
    const data = { ...EMPTY_DATA, translateUrl: "https://lt.example", sourceLanguage: "auto" };
    expect(translationEnabled(modeData(data, false))).toBe(true);
    const client = modeData({ ...data, talkMode: "client" }, false);
    expect(client.sourceLanguage).toBe("de");
    expect(translationEnabled(client)).toBe(false);
    expect(modeData(data, false).sourceLanguage).toBe("auto");
  });

  it("persists the mode; unknown values are dropped", () => {
    expect(parseData(JSON.stringify({ talkMode: "client" })).talkMode).toBe("client");
    expect(parseData(JSON.stringify({ talkMode: "translate" })).talkMode).toBe("translate");
    expect(parseData(JSON.stringify({ talkMode: "x" })).talkMode).toBeUndefined();
    expect(parseData("").talkMode).toBeUndefined();
  });

  it("reply timing: faster only in client mode", () => {
    expect(replyTimingFor("translate")).toBeUndefined();
    expect(CLIENT_REPLY_TIMING).toEqual({ debounceMs: 600, minGapMs: 8_000, requestGapMs: 2_500 });
  });

  it("the reply watcher follows the per-mode timing", async () => {
    vi.useFakeTimers();
    try {
      let mode: "client" | "translate" = "client";
      let asked = 0;
      const watcher = createReplyWatcher({
        enabled: () => true,
        owner: () => "other",
        userSpeaking: () => false,
        suggest: async () => { asked += 1; return { text: "Gern." }; },
        onSuggestion: () => undefined,
        timing: () => replyTimingFor(mode),
      });
      const line = (text: string): TranscriptEntry => ({ text, at: Date.now() });
      watcher.onFinal([line("Wann passt es Ihnen?")]);
      await vi.advanceTimersByTimeAsync(650);
      expect(asked).toBe(1); // 600 ms debounce
      watcher.reset();
      mode = "translate";
      watcher.onFinal([line("Und morgen?")]);
      await vi.advanceTimersByTimeAsync(650);
      expect(asked).toBe(1); // translate keeps 1200 ms
      await vi.advanceTimersByTimeAsync(REPLY_DEBOUNCE_MS);
      expect(asked).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("idle header and Kunde footer fit the 46-character rows in both languages", () => {
    for (const locale of ["de", "en"] as const) {
      for (const key of ["g.mode.client", "g.mode.translate"]) {
        const view = buildView(createBuffer(), {
          mode: "conversation", listening: false, status: "idle", translating: false, offset: 0, mock: true, locale,
          talkModeLabel: t(locale, key), notice: { kind: "noServer" },
        });
        expect(view.header.length).toBeLessThanOrEqual(GLASS_COLS);
        expect(view.header).toContain(t(locale, key));
        expect(view.footer.length).toBeLessThanOrEqual(ROW_WIDTH);
      }
      for (const [row, tap] of [["g.mode.startClient", "g.a.startClient"], ["g.mode.toTranslate", "g.a.toTranslate"]] as const) {
        expect(t(locale, row).length).toBeLessThanOrEqual(ROW_WIDTH);
        for (const rows of [[t(locale, row)], Array.from({ length: 20 }, () => "x")]) {
          const view = buildView(createBuffer(), {
            mode: "conversation", listening: false, status: "idle", translating: false, offset: 0, mock: false, locale,
            help: { rows, page: 0, title: t(locale, "g.s.cust"), tapLabel: t(locale, tap) },
          });
          expect(view.footer.length).toBeLessThanOrEqual(ROW_WIDTH);
          expect(view.footer).toContain(t(locale, tap));
          expect(view.header.length).toBeLessThanOrEqual(GLASS_COLS);
        }
      }
    }
  });
});
