import { resetGestureDedupe } from "../src/input/gestures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeRoot, type FakeRoot } from "./fake-dom";
import { FakeSocket } from "./fake-socket";

// Boots the real app against a fake bridge and a fake Xaventra endpoint, so the
// lifecycle (feed, answers, voice, exit) can be checked without glasses.
const harness = vi.hoisted(() => ({ bridge: null as unknown }));
vi.mock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
  waitForEvenAppBridge: async () => harness.bridge,
}));

const CLICK = 0, UP = 1, DOWN = 2, DOUBLE = 3, HOLD = 9, RELEASE = 10;
const SETTINGS = "quietglass.xaventrahud.v1";
const TOKEN = "tok-very-secret-1234567890";

function fakeBridge(stored: Record<string, string> = {}) {
  let handler: ((event: unknown) => void) | undefined;
  let deviceHandler: ((status: unknown) => void) | undefined;
  const storage = new Map(Object.entries(stored));
  const screen = new Map<number, string>();
  const exit = { calls: [] as unknown[], answer: true as boolean | "reject" };
  const mic: boolean[] = [];
  /** The side menu of every created page ("id:label"). */
  const menus: string[][] = [];
  type Built = { textObject?: Array<{ containerID?: number; content?: string }>; menuObject?: { menuItems?: Array<{ itemName?: string; itemID?: number }> } };
  const menuOf = (page: Built): void => { menus.push((page.menuObject?.menuItems ?? []).map((item) => item.itemID + ":" + item.itemName)); };
  const bridge = {
    getLocalStorage: vi.fn(async (key: string) => storage.get(key) ?? ""),
    setLocalStorage: vi.fn(async (key: string, value: string) => { storage.set(key, value); return true; }),
    rebuildPageContainer: vi.fn(async (page?: Built) => { if (page) menuOf(page); return true; }),
    createStartUpPageContainer: vi.fn(async (page: Built) => {
      menuOf(page);
      for (const text of page.textObject ?? []) screen.set(text.containerID ?? 0, text.content ?? "");
      return 0;
    }),
    updateImageRawData: vi.fn(async () => "success"),
    textContainerUpgrade: vi.fn(async (update: { containerID?: number; content?: string }) => {
      screen.set(update.containerID ?? 0, update.content ?? "");
      return true;
    }),
    // Plain function, not vi.fn: a spy would attach handlers and hide unhandled rejections.
    shutDownPageContainer: (mode?: number): Promise<boolean> => {
      exit.calls.push(mode);
      return exit.answer === "reject" ? Promise.reject(new Error("ble gone")) : Promise.resolve(exit.answer);
    },
    audioControl: vi.fn(async (on: boolean, _source?: unknown): Promise<boolean> => { mic.push(on); return true; }),
    onEvenHubEvent: (callback: (event: unknown) => void) => { handler = callback; return () => undefined; },
    onDeviceStatusChanged: (callback: (status: unknown) => void) => { deviceHandler = callback; return () => undefined; },
  };
  return {
    bridge, storage, exit, mic, menus,
    /** An item picked in the glasses' side menu. */
    menu: (itemID: number) => handler?.({ menuItemClickEvent: { itemID } }),
    reconnect: () => deviceHandler?.({ connectType: "connected" }),
    header: () => screen.get(1) ?? "",
    body: () => screen.get(2) ?? "",
    footer: () => screen.get(3) ?? "",
    emit: (eventType: number) => (resetGestureDedupe(), handler?.({ sysEvent: { eventType, eventSource: 1 } })),
    audio: (bytes: number) => handler?.({ audioEvent: { audioPcm: new Uint8Array(bytes) } }),
    ready: () => handler !== undefined,
  };
}

type Fake = ReturnType<typeof fakeBridge>;

interface Card { id: string; titel: string; text: string; wirkung: string; antworten: string[] }

/** A small in-memory Xaventra endpoint behind the fetch mock. */
function fakeServer() {
  const state = {
    version: "v1",
    status: "Prüft Drucker",
    cards: [] as Card[],
    down: false,
    authOk: true,
    voice: { transcript: "ja", action: "answered_ja", cardId: "c1", reply: "" } as Record<string, unknown>,
    voiceStatus: 200,
    /** `POST /hud/ask` (live text): 404 = the server does not have it. */
    askStatus: 404,
    asked: [] as unknown[],
    answerStatus: 200,
    voiceCards: [] as string[],
    calls: [] as Array<{ key: string; init: RequestInit }>,
    wake: new Set<() => void>(),
  };
  const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const feed = () => ({ version: state.version, status: state.status, cards: state.cards, at: "now" });
  const fetchMock = vi.fn(async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    const key = (init.method ?? "GET") + " " + url.pathname + (url.pathname === "/hud/voice" && url.search ? "?bound" : "");
    const cardParam = url.searchParams.get("cardId");
    if (cardParam) state.voiceCards.push(cardParam);
    state.calls.push({ key, init });
    if (state.down) throw new TypeError("Failed to fetch");
    const auth = (init.headers as Record<string, string> | undefined)?.["Authorization"];
    if (!state.authOk || auth !== "Bearer " + TOKEN) return json({ error: "Unauthorized" }, 401);
    switch (key) {
      case "GET /hud": {
        if (url.searchParams.get("since") !== state.version) return json(feed());
        // Long poll: hold until the state changes or the client gives up.
        return new Promise<Response>((resolve, reject) => {
          const wake = (): void => resolve(json(feed()));
          state.wake.add(wake);
          init.signal?.addEventListener("abort", () => { state.wake.delete(wake); reject(new DOMException("aborted", "AbortError")); });
        });
      }
      case "POST /hud/answer": {
        const body = JSON.parse(String(init.body)) as { cardId: string };
        if (state.answerStatus !== 200) return json({ error: "no" }, state.answerStatus);
        state.cards = state.cards.filter((card) => card.id !== body.cardId);
        state.version = "v" + (state.cards.length + 100);
        return json({ ok: true, message: "Angenommen." });
      }
      case "POST /hud/ask":
        if (state.askStatus === 404) return json({ error: "Not found" }, 404);
        state.asked.push(JSON.parse(String(init.body)));
        return json(state.voice, state.askStatus);
      case "POST /hud/voice":
      case "POST /hud/voice?bound": return json(state.voice, state.voiceStatus);
      default: return json({ error: "not found" }, 404);
    }
  });
  const change = (cards: Card[], version: string): void => {
    state.cards = cards; state.version = version;
    for (const wake of [...state.wake]) { state.wake.delete(wake); wake(); }
  };
  return { state, fetchMock, change };
}

const inner: Card = { id: "c1", titel: "Neues Modell testen?", text: "Modell Z war schneller.", wirkung: "intern", antworten: ["ja", "nein"] };
const outer: Card = { id: "c2", titel: "Drucker starten?", text: "Testdruck bereit.", wirkung: "physisch", antworten: ["ja", "nein"] };

async function boot(fake: Fake, language = "de-AT"): Promise<FakeRoot> {
  const root = fakeRoot();
  vi.stubGlobal("document", { getElementById: () => root });
  vi.stubGlobal("navigator", { language });
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } });
  harness.bridge = fake.bridge;
  vi.resetModules();
  await import("../src/main");
  await vi.waitFor(() => expect(fake.ready()).toBe(true));
  await vi.waitFor(() => expect(root.renders).toBeGreaterThan(0));
  return root;
}

const configured = (extra: Record<string, unknown> = {}): Record<string, string> =>
  ({ [SETTINGS]: JSON.stringify({ serverUrl: "https://xaventra.example", token: TOKEN, ...extra }) });

/** Holds, speaks `bytes` of audio and releases. */
async function speak(fake: Fake, bytes = 32_000): Promise<void> {
  fake.emit(HOLD);
  await vi.waitFor(() => expect(fake.mic).toContain(true));
  await vi.waitFor(() => expect(fake.body()).toContain("Sprich jetzt"));
  fake.audio(bytes);
  fake.emit(RELEASE);
}

describe("Xaventra HUD lifecycle", () => {
  let server: ReturnType<typeof fakeServer>;
  beforeEach(() => {
  resetGestureDedupe();
    server = fakeServer();
    vi.stubGlobal("fetch", server.fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); FakeSocket.last = null; FakeSocket.all = []; });

  it("first run without an address: says what to do and fetches nothing", async () => {
    const fake = fakeBridge();
    const root = await boot(fake);
    await vi.waitFor(() => expect(fake.body()).toContain("Adresse und Token am Handy eintragen."));
    expect(root.innerHTML).toContain("Erster Start");
    expect(server.fetchMock).not.toHaveBeenCalled();
  });

  it("shows status and card, and sends the token only as a header", async () => {
    server.change([inner], "v2");
    const fake = fakeBridge(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.body()).toContain("Neues Modell testen?"));
    expect(fake.body()).toContain("> Prüft Drucker");
    expect(fake.header()).toContain("Frage 1/1");
    for (const call of server.state.calls) expect(call.key).not.toContain(TOKEN);
    expect(server.state.calls[0]?.init.headers).toMatchObject({ Authorization: "Bearer " + TOKEN });
  });

  it("tap arms, the second tap answers yes; the card disappears", async () => {
    server.change([inner], "v2");
    const fake = fakeBridge(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.body()).toContain("Neues Modell testen?"));
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.footer()).toContain("Nochmal tippen = Ja senden"));
    expect(server.state.calls.some((c) => c.key === "POST /hud/answer")).toBe(false);
    fake.emit(CLICK);
    await vi.waitFor(() => expect(server.state.calls.some((c) => c.key === "POST /hud/answer")).toBe(true));
    const sent = JSON.parse(String(server.state.calls.find((c) => c.key === "POST /hud/answer")?.init.body));
    expect(sent).toEqual({ cardId: "c1", answer: "ja" });
    await vi.waitFor(() => expect(fake.body()).toContain("Keine offenen Fragen."));
  });

  it("regression: a double tap on a card leaves (asks the system) and never answers no", async () => {
    server.change([inner], "v2");
    const fake = fakeBridge(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.body()).toContain("Neues Modell testen?"));
    fake.emit(DOUBLE);
    await vi.waitFor(() => expect(fake.exit.calls).toEqual([1]));
    expect(server.state.calls.some((c) => c.key === "POST /hud/answer")).toBe(false);
  });

  it("a swipe never answers: it only moves the cursor", async () => {
    server.change([inner], "v2");
    const fake = fakeBridge(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.body()).toContain("Neues Modell testen?"));
    fake.emit(DOWN);
    await vi.waitFor(() => expect(fake.body()).toContain("● Nein"));
    fake.emit(DOWN); // one card: Ja, Nein, then the Hilfe row (side menu off), then Ja again
    await vi.waitFor(() => expect(fake.body()).toContain("● Hilfe"));
    fake.emit(DOWN);
    await vi.waitFor(() => expect(fake.body()).toContain("● Ja"));
    fake.emit(UP);
    await vi.waitFor(() => expect(fake.body()).toContain("● Hilfe"));
    fake.emit(UP);
    await vi.waitFor(() => expect(fake.body()).toContain("● Nein"));
    fake.emit(UP);
    await vi.waitFor(() => expect(fake.body()).toContain("● Ja"));
    await new Promise((done) => setTimeout(done, 30));
    expect(server.state.calls.some((c) => c.key === "POST /hud/answer")).toBe(false);
  });

  it("an armed answer is cancelled by a swipe or a double tap, and a double tap then does not exit", async () => {
    server.change([inner], "v2");
    const fake = fakeBridge(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.body()).toContain("Neues Modell testen?"));
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.footer()).toContain("Nochmal tippen = Ja senden"));
    fake.emit(DOUBLE);
    await vi.waitFor(() => expect(fake.footer()).toContain("Tippen = wählen"));
    expect(fake.exit.calls).toEqual([]);
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.footer()).toContain("Nochmal tippen = Ja senden"));
    fake.emit(DOWN);
    await vi.waitFor(() => expect(fake.footer()).toContain("Tippen = wählen"));
    await new Promise((done) => setTimeout(done, 30));
    expect(server.state.calls.some((c) => c.key === "POST /hud/answer")).toBe(false);
  });

  it("pages carry no side menu while its clicks do not arrive on the real glasses (step log 15.10.)", async () => {
    server.change([inner], "v2");
    const fake = fakeBridge(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.body()).toContain("Neues Modell testen?"));
    expect(fake.menus.length).toBeGreaterThan(0);
    expect(fake.menus.every((menu) => menu.length === 0)).toBe(true);
  });

  it("Hilfe is the last row of the list: a swipe goes there, a tap opens a page with the gestures, a tap closes it", async () => {
    server.change([inner], "v2");
    const fake = fakeBridge(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.body()).toContain("Neues Modell testen?"));
    fake.emit(DOWN);
    fake.emit(DOWN);
    await vi.waitFor(() => expect(fake.body()).toContain("● Hilfe"));
    await vi.waitFor(() => expect(fake.footer()).toContain("Tippen = Hilfe"));
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.header()).toBe("XAVENTRA · Hilfe"));
    await vi.waitFor(() => expect(fake.body()).toContain("Tippen = Antwort wählen"));
    await vi.waitFor(() => expect(fake.footer()).toBe("Tippen = schließen · 2× = zurück"));
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.body()).toContain("Neues Modell testen?"));
    expect(server.state.calls.some((c) => c.key === "POST /hud/answer")).toBe(false);
  });

  it("swipe to Nein, tap, tap answers no", async () => {
    server.change([inner], "v2");
    const fake = fakeBridge(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.body()).toContain("Neues Modell testen?"));
    fake.emit(DOWN);
    await vi.waitFor(() => expect(fake.body()).toContain("● Nein"));
    expect(server.state.calls.some((c) => c.key === "POST /hud/answer")).toBe(false);
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.footer()).toContain("Nochmal tippen = Nein senden"));
    expect(server.state.calls.some((c) => c.key === "POST /hud/answer")).toBe(false);
    fake.emit(CLICK);
    await vi.waitFor(() => expect(server.state.calls.some((c) => c.key === "POST /hud/answer")).toBe(true));
    expect(JSON.parse(String(server.state.calls.find((c) => c.key === "POST /hud/answer")?.init.body))).toEqual({ cardId: "c1", answer: "nein" });
  });

  it("a card with outward effect needs a second tap before yes is sent", async () => {
    server.change([outer], "v2");
    const fake = fakeBridge(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.header()).toContain("physisch"));
    fake.emit(CLICK);
    await vi.waitFor(() => expect(fake.footer()).toContain("Nochmal tippen = Ja senden"));
    expect(server.state.calls.some((c) => c.key === "POST /hud/answer")).toBe(false);
    fake.emit(CLICK);
    await vi.waitFor(() => expect(server.state.calls.some((c) => c.key === "POST /hud/answer")).toBe(true));
  });

  it("swiping moves between cards", async () => {
    server.change([inner, outer], "v2");
    const fake = fakeBridge(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.header()).toContain("Frage 1/2"));
    fake.emit(DOWN); // Nein of card 1
    fake.emit(DOWN); // card 2
    await vi.waitFor(() => expect(fake.header()).toContain("Frage 2/2"));
    fake.emit(UP);
    fake.emit(UP);
    await vi.waitFor(() => expect(fake.header()).toContain("Frage 1/2"));
  });

  it("a wrong token is reported, not retried in a tight loop", async () => {
    server.state.authOk = false;
    const fake = fakeBridge(configured());
    const root = await boot(fake);
    await vi.waitFor(() => expect(fake.body()).toContain("Token abgelehnt"));
    expect(fake.header()).toBe("XAVENTRA · offline");
    // QIS v1.2 #8: no HTTP code on the glasses; the phone shows it.
    expect(fake.body() + fake.footer()).not.toMatch(/\b401\b/);
    await vi.waitFor(() => expect(root.innerHTML).toContain("Fehler: Token abgelehnt (HTTP 401)"));
    expect(root.innerHTML).not.toContain(TOKEN);
    const polls = server.state.calls.filter((c) => c.key === "GET /hud").length;
    await new Promise((done) => setTimeout(done, 50));
    expect(server.state.calls.filter((c) => c.key === "GET /hud").length).toBe(polls);
  });

  it("an unreachable endpoint shows offline and says so", async () => {
    server.state.down = true;
    const fake = fakeBridge(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.body()).toContain("Xaventra nicht erreichbar"));
    expect(fake.header()).toBe("XAVENTRA · offline");
  });

  describe("voice", () => {
    it("QIS v1.2 #4: a spoken yes (WAV path) is only selected and armed; the confirming tap sends it", async () => {
      server.change([inner], "v2");
      const fake = fakeBridge(configured());
      await boot(fake);
      await vi.waitFor(() => expect(fake.body()).toContain("Neues Modell testen?"));
      await speak(fake);
      await vi.waitFor(() => expect(server.state.calls.some((c) => c.key.startsWith("POST /hud/voice"))).toBe(true));
      const call = server.state.calls.find((c) => c.key.startsWith("POST /hud/voice"));
      expect(call?.init.headers).toMatchObject({ "Content-Type": "audio/wav", Authorization: "Bearer " + TOKEN });
      const blob = call?.init.body as Blob;
      expect(blob.size).toBe(44 + 32_000);
      expect(new TextDecoder().decode(new Uint8Array(await blob.arrayBuffer()).slice(0, 4))).toBe("RIFF");
      expect(fake.mic.at(-1)).toBe(false);
      // Nothing answered yet: Ja is selected and armed, the footer asks for the tap.
      await vi.waitFor(() => expect(fake.footer()).toBe("Nochmal tippen = Ja senden · Wischen/2× = abbrechen"));
      expect(fake.body()).toContain("● Ja");
      expect(fake.body()).toContain("Gehört: Ja.");
      expect(server.state.calls.some((c) => c.key === "POST /hud/answer")).toBe(false);
      fake.emit(CLICK);
      await vi.waitFor(() => expect(server.state.calls.some((c) => c.key === "POST /hud/answer")).toBe(true));
      expect(JSON.parse(String(server.state.calls.find((c) => c.key === "POST /hud/answer")?.init.body))).toEqual({ cardId: "c1", answer: "ja" });
      await vi.waitFor(() => expect(fake.body()).toContain("Keine offenen Fragen."));
    });

    it("QIS v1.2 #4: a spoken no selects Nein and arms it; a swipe cancels and nothing is sent", async () => {
      server.change([inner], "v2");
      server.state.voice = { transcript: "nein", action: "answered_nein", cardId: "c1", reply: "" };
      const fake = fakeBridge(configured());
      await boot(fake);
      await vi.waitFor(() => expect(fake.body()).toContain("Neues Modell testen?"));
      await speak(fake);
      await vi.waitFor(() => expect(fake.footer()).toBe("Nochmal tippen = Nein senden · Wischen/2× = abbrechen"));
      expect(fake.body()).toContain("● Nein");
      fake.emit(DOWN);
      await vi.waitFor(() => expect(fake.footer()).toContain("Tippen = Hilfe"));
      await new Promise((done) => setTimeout(done, 30));
      expect(server.state.calls.some((c) => c.key === "POST /hud/answer")).toBe(false);
    });

    it("QIS v1.2 #4: an armed spoken answer runs out after 4 s without sending", async () => {
      server.change([inner], "v2");
      const fake = fakeBridge(configured());
      await boot(fake);
      await vi.waitFor(() => expect(fake.body()).toContain("Neues Modell testen?"));
      await speak(fake);
      await vi.waitFor(() => expect(fake.footer()).toContain("Nochmal tippen = Ja senden"));
      await vi.waitFor(() => expect(fake.footer()).toContain("Tippen = wählen"), { timeout: 5_000 });
      expect(server.state.calls.some((c) => c.key === "POST /hud/answer")).toBe(false);
    }, 8_000);

    it("shows ● MIC while listening", async () => {
      server.change([inner], "v2");
      const fake = fakeBridge(configured());
      await boot(fake);
      fake.emit(HOLD);
      await vi.waitFor(() => expect(fake.header()).toContain("● MIC"));
      await vi.waitFor(() => expect(fake.footer()).toBe("Loslassen = fertig · 2× = abbrechen"));
    });

    it("a spoken yes for an outward card only arms the confirming tap; the tap sends it", async () => {
      server.change([outer], "v2");
      server.state.voice = { transcript: "ja", action: "needs_confirm", cardId: "c2", reply: "" };
      const fake = fakeBridge(configured());
      await boot(fake);
      await vi.waitFor(() => expect(fake.header()).toContain("physisch"));
      await speak(fake);
      await vi.waitFor(() => expect(fake.footer()).toContain("Nochmal tippen = Ja senden"));
      expect(server.state.calls.some((c) => c.key === "POST /hud/answer")).toBe(false);
      fake.emit(CLICK);
      await vi.waitFor(() => expect(server.state.calls.some((c) => c.key === "POST /hud/answer")).toBe(true));
      expect(JSON.parse(String(server.state.calls.find((c) => c.key === "POST /hud/answer")?.init.body))).toEqual({ cardId: "c2", answer: "ja" });
    });

    it("an agent reply is shown with the transcript, and a tap only closes it", async () => {
      server.change([inner], "v2");
      server.state.voice = { transcript: "Wie ist der Stand?", action: "message", cardId: "", reply: "Alles ruhig." };
      const fake = fakeBridge(configured());
      await boot(fake);
      await vi.waitFor(() => expect(fake.body()).toContain("Neues Modell testen?"));
      await speak(fake);
      await vi.waitFor(() => expect(fake.body()).toContain("Du: Wie ist der Stand?"));
      expect(fake.body()).toContain("Xaventra: Alles ruhig.");
      expect(fake.footer()).toBe("Tippen = schließen · 2× = zurück");
      fake.emit(CLICK);
      await vi.waitFor(() => expect(fake.body()).toContain("Neues Modell testen?"));
      expect(server.state.calls.some((c) => c.key === "POST /hud/answer")).toBe(false);
    });

    it("an unclear sentence answers nothing", async () => {
      server.change([inner], "v2");
      server.state.voice = { transcript: "vielleicht morgen", action: "none", cardId: "", reply: "" };
      const fake = fakeBridge(configured());
      await boot(fake);
      await vi.waitFor(() => expect(fake.body()).toContain("Neues Modell testen?"));
      await speak(fake);
      await vi.waitFor(() => expect(fake.body()).toContain("Nicht eindeutig"));
      expect(server.state.calls.some((c) => c.key === "POST /hud/answer")).toBe(false);
      expect(fake.body()).toContain("Neues Modell testen?");
    });

    it("double tap while listening cancels: nothing is sent and the microphone closes", async () => {
      server.change([inner], "v2");
      const fake = fakeBridge(configured());
      await boot(fake);
      await vi.waitFor(() => expect(fake.body()).toContain("Neues Modell testen?"));
      fake.emit(HOLD);
      await vi.waitFor(() => expect(fake.body()).toContain("Sprich jetzt"));
      fake.audio(32_000);
      fake.emit(DOUBLE);
      await vi.waitFor(() => expect(fake.body()).toContain("Abgebrochen."));
      expect(fake.mic.at(-1)).toBe(false);
      expect(server.state.calls.some((c) => c.key.startsWith("POST /hud/voice"))).toBe(false);
      expect(server.state.calls.some((c) => c.key === "POST /hud/answer")).toBe(false);
    });

    it("a slip of the finger (almost no audio) is not sent", async () => {
      server.change([inner], "v2");
      const fake = fakeBridge(configured());
      await boot(fake);
      await speak(fake, 100);
      await vi.waitFor(() => expect(fake.body()).toContain("Nichts gehört."));
      expect(server.state.calls.some((c) => c.key.startsWith("POST /hud/voice"))).toBe(false);
    });

    it("stops listening by itself when the audio limit is reached", async () => {
      server.change([inner], "v2");
      const fake = fakeBridge(configured());
      await boot(fake);
      fake.emit(HOLD);
      await vi.waitFor(() => expect(fake.body()).toContain("Sprich jetzt"));
      fake.audio(16_000 * 2 * 121 - 10);
      fake.audio(64);
      await vi.waitFor(() => expect(server.state.calls.some((c) => c.key.startsWith("POST /hud/voice"))).toBe(true));
      expect(fake.mic.at(-1)).toBe(false);
    });

    it("a server problem is shown briefly and the card stays", async () => {
      server.change([inner], "v2");
      server.state.voiceStatus = 503;
      server.state.voice = { error: "stt" };
      const fake = fakeBridge(configured());
      await boot(fake);
      await vi.waitFor(() => expect(fake.body()).toContain("Neues Modell testen?"));
      await speak(fake);
      await vi.waitFor(() => expect(fake.body()).toContain("Sprache: Dienst nicht bereit"));
      expect(fake.body()).toContain("Neues Modell testen?");
    });

    describe("live speech-to-text", () => {
      const live = (): void => {
        vi.stubEnv("VITE_LIVE_STT_URL", "wss://stt.example:8449");
        vi.stubGlobal("WebSocket", FakeSocket);
      };
      const holdAndTalk = async (fake: Fake): Promise<FakeSocket> => {
        const before = FakeSocket.all.length;
        fake.emit(HOLD);
        await vi.waitFor(() => expect(FakeSocket.all.length).toBe(before + 1));
        const socket = FakeSocket.last!;
        await vi.waitFor(() => expect(fake.body()).toContain("Sprich jetzt"));
        socket.open();
        fake.audio(32_000);
        socket.say("Wie ist");
        await vi.waitFor(() => expect(fake.body()).toContain("Wie ist"));
        expect(fake.footer()).toBe("Loslassen = fertig · 2× = abbrechen");
        return socket;
      };

      it("shows the words while speaking; on release the text is shown first and only the tap sends it to /hud/ask", async () => {
        live();
        server.change([inner], "v2");
        server.state.askStatus = 200;
        server.state.voice = { transcript: "Wie ist der Stand?", action: "message", cardId: "", reply: "Alles ruhig." };
        const fake = fakeBridge(configured());
        await boot(fake);
        await vi.waitFor(() => expect(fake.body()).toContain("Neues Modell testen?"));
        const socket = await holdAndTalk(fake);
        expect(socket.binary().length).toBe(1);
        fake.emit(RELEASE);
        await vi.waitFor(() => expect(socket.json().at(-1)).toEqual({ type: "stop" }));
        socket.say("Wie ist der Stand?", true);
        await vi.waitFor(() => expect(fake.footer()).toBe("Tippen = senden · 2× = verwerfen"));
        expect(fake.header()).toBe("XAVENTRA · senden?");
        expect(fake.body()).toContain("Du: Wie ist der Stand?");
        expect(fake.mic.at(-1)).toBe(false);
        await new Promise((done) => setTimeout(done, 30));
        expect(server.state.calls.some((c) => c.key === "POST /hud/ask" || c.key.startsWith("POST /hud/voice"))).toBe(false);
        fake.emit(DOWN); // a swipe does nothing here
        fake.emit(HOLD); // a hold does not start a new recording over waiting text
        await new Promise((done) => setTimeout(done, 30));
        expect(fake.footer()).toBe("Tippen = senden · 2× = verwerfen");
        fake.emit(CLICK);
        await vi.waitFor(() => expect(fake.body()).toContain("Alles ruhig."));
        expect(server.state.asked).toEqual([{ text: "Wie ist der Stand?", cardId: "c1" }]);
        expect(server.state.calls.some((c) => c.key.startsWith("POST /hud/voice"))).toBe(false);
      });

      it("recognised text: 2× discards it, nothing is sent", async () => {
        live();
        server.change([inner], "v2");
        server.state.askStatus = 200;
        const fake = fakeBridge(configured());
        await boot(fake);
        await vi.waitFor(() => expect(fake.body()).toContain("Neues Modell testen?"));
        const socket = await holdAndTalk(fake);
        fake.emit(RELEASE);
        await vi.waitFor(() => expect(socket.json().at(-1)).toEqual({ type: "stop" }));
        socket.say("Druck abbrechen", true);
        await vi.waitFor(() => expect(fake.footer()).toBe("Tippen = senden · 2× = verwerfen"));
        fake.emit(DOUBLE);
        await vi.waitFor(() => expect(fake.body()).toContain("Verworfen."));
        expect(fake.body()).toContain("Neues Modell testen?");
        expect(fake.exit.calls).toEqual([]);
        await new Promise((done) => setTimeout(done, 30));
        expect(server.state.calls.some((c) => c.key === "POST /hud/ask" || c.key.startsWith("POST /hud/voice") || c.key === "POST /hud/answer")).toBe(false);
      });

      it("QIS v1.2 #4: a live-recognised bare yes selects and arms Ja; nothing goes to /hud/ask, the tap answers", async () => {
        live();
        server.change([inner], "v2");
        server.state.askStatus = 200;
        const fake = fakeBridge(configured());
        await boot(fake);
        await vi.waitFor(() => expect(fake.body()).toContain("Neues Modell testen?"));
        const socket = await holdAndTalk(fake);
        fake.emit(RELEASE);
        await vi.waitFor(() => expect(socket.json().at(-1)).toEqual({ type: "stop" }));
        socket.say("Ja.", true);
        await vi.waitFor(() => expect(fake.footer()).toBe("Nochmal tippen = Ja senden · Wischen/2× = abbrechen"));
        expect(server.state.calls.some((c) => c.key === "POST /hud/ask" || c.key === "POST /hud/answer")).toBe(false);
        fake.emit(CLICK);
        await vi.waitFor(() => expect(server.state.calls.some((c) => c.key === "POST /hud/answer")).toBe(true));
        expect(server.state.asked).toEqual([]);
      });

      it("a server without /hud/ask gets the WAV instead, and is not asked again", async () => {
        live();
        server.change([inner], "v2");
        server.state.voice = { transcript: "Wie ist der Stand?", action: "message", cardId: "", reply: "Alles ruhig." };
        const fake = fakeBridge(configured());
        await boot(fake);
        await vi.waitFor(() => expect(fake.body()).toContain("Neues Modell testen?"));
        let socket = await holdAndTalk(fake);
        fake.emit(RELEASE);
        await vi.waitFor(() => expect(socket.json().at(-1)).toEqual({ type: "stop" }));
        socket.say("Wie ist der Stand?", true);
        await vi.waitFor(() => expect(fake.footer()).toBe("Tippen = senden · 2× = verwerfen"));
        fake.emit(CLICK);
        await vi.waitFor(() => expect(fake.body()).toContain("Alles ruhig."));
        expect(server.state.calls.filter((c) => c.key === "POST /hud/ask").length).toBe(1);
        expect(server.state.calls.filter((c) => c.key.startsWith("POST /hud/voice")).length).toBe(1);
        fake.emit(CLICK); // close the reply
        await vi.waitFor(() => expect(fake.body()).not.toContain("Alles ruhig."));
        socket = await holdAndTalk(fake);
        fake.emit(RELEASE);
        await vi.waitFor(() => expect(socket.json().at(-1)).toEqual({ type: "stop" }));
        socket.say("Und jetzt?", true);
        await vi.waitFor(() => expect(fake.footer()).toBe("Tippen = senden · 2× = verwerfen"));
        fake.emit(CLICK);
        await vi.waitFor(() => expect(server.state.calls.filter((c) => c.key.startsWith("POST /hud/voice")).length).toBe(2));
        expect(server.state.calls.filter((c) => c.key === "POST /hud/ask").length).toBe(1);
      });

      it("a recogniser that never answers falls back to the WAV upload", async () => {
        live();
        server.change([inner], "v2");
        server.state.askStatus = 200;
        const fake = fakeBridge(configured());
        await boot(fake);
        await vi.waitFor(() => expect(fake.body()).toContain("Neues Modell testen?"));
        await speak(fake); // the socket is never opened
        await vi.waitFor(() => expect(server.state.calls.some((c) => c.key.startsWith("POST /hud/voice"))).toBe(true));
        expect(server.state.asked).toEqual([]);
        expect(FakeSocket.last?.closed).toBe(true);
      });

      it("double tap while speaking closes the recogniser too", async () => {
        live();
        server.change([inner], "v2");
        const fake = fakeBridge(configured());
        await boot(fake);
        await vi.waitFor(() => expect(fake.body()).toContain("Neues Modell testen?"));
        const socket = await holdAndTalk(fake);
        fake.emit(DOUBLE);
        await vi.waitFor(() => expect(socket.closed).toBe(true));
        expect(server.state.calls.some((c) => c.key.startsWith("POST /hud/voice") || c.key === "POST /hud/ask")).toBe(false);
      });
    });

    it("without a configured address, holding does not open the microphone", async () => {
      const fake = fakeBridge();
      await boot(fake);
      fake.emit(HOLD);
      await new Promise((done) => setTimeout(done, 20));
      expect(fake.mic).toEqual([]);
    });
  });

  describe("leaving", () => {
    it("double tap with no open question asks the system to exit (mode 1)", async () => {
      server.change([], "v2");
      const fake = fakeBridge(configured());
      await boot(fake);
      await vi.waitFor(() => expect(fake.body()).toContain("Keine offenen Fragen."));
      fake.emit(DOUBLE);
      await vi.waitFor(() => expect(fake.exit.calls).toEqual([1]));
    });

    it("keeps running when the exit is cancelled", async () => {
      server.change([], "v2");
      const fake = fakeBridge(configured());
      fake.exit.answer = false;
      await boot(fake);
      await vi.waitFor(() => expect(fake.body()).toContain("Keine offenen Fragen."));
      fake.emit(DOUBLE);
      await vi.waitFor(() => expect(fake.exit.calls).toEqual([1]));
      // Still alive: a new card arrives and can be answered.
      server.change([inner], "v3");
      await vi.waitFor(() => expect(fake.body()).toContain("Neues Modell testen?"));
      fake.emit(CLICK);
      await vi.waitFor(() => expect(fake.footer()).toContain("Nochmal tippen"));
      fake.emit(CLICK);
      await vi.waitFor(() => expect(server.state.calls.some((c) => c.key === "POST /hud/answer")).toBe(true));
    });

    it("a failing exit call does not crash the app", async () => {
      server.change([], "v2");
      const fake = fakeBridge(configured());
      fake.exit.answer = "reject";
      await boot(fake);
      await vi.waitFor(() => expect(fake.body()).toContain("Keine offenen Fragen."));
      fake.emit(DOUBLE);
      await vi.waitFor(() => expect(fake.exit.calls).toEqual([1]));
    });

    it("after the system confirms the exit, the feed is no longer polled", async () => {
      server.change([], "v2");
      const fake = fakeBridge(configured());
      await boot(fake);
      await vi.waitFor(() => expect(fake.body()).toContain("Keine offenen Fragen."));
      fake.emit(DOUBLE);
      await vi.waitFor(() => expect(fake.exit.calls).toEqual([1]));
      await new Promise((done) => setTimeout(done, 10));
      const before = server.state.calls.length;
      server.change([inner], "v3");
      await new Promise((done) => setTimeout(done, 30));
      expect(server.state.calls.length).toBe(before);
    });
  });

  describe("answers that fail", () => {
    it("a card already answered elsewhere (409) is dropped and the reason shown", async () => {
      server.change([inner], "v2");
      server.state.answerStatus = 409;
      const fake = fakeBridge(configured());
      await boot(fake);
      await vi.waitFor(() => expect(fake.body()).toContain("Neues Modell testen?"));
      fake.emit(CLICK);
      await vi.waitFor(() => expect(fake.footer()).toContain("Nochmal tippen"));
      fake.emit(CLICK);
      await vi.waitFor(() => expect(fake.body()).toContain("Schon beantwortet"));
      expect(fake.body()).toContain("Keine offenen Fragen.");
    });
  });

  it("demo mode needs no server and sends nothing", async () => {
    vi.stubGlobal("location", { search: "?demo=1" });
    const fake = fakeBridge();
    const root = await boot(fake);
    await vi.waitFor(() => expect(fake.body()).toContain("Drucker starten?"));
    expect(root.innerHTML).toContain("Demo-Modus");
    expect(server.fetchMock).not.toHaveBeenCalled();
  });

  it("regression: the double tap works while the first page is still being created", async () => {
    const fake = fakeBridge(configured());
    fake.bridge.createStartUpPageContainer.mockImplementation(() => new Promise(() => undefined));
    const root = fakeRoot();
    vi.stubGlobal("document", { getElementById: () => root });
    vi.stubGlobal("navigator", { language: "de-AT" });
    harness.bridge = fake.bridge;
    vi.resetModules();
    await import("../src/main");
    await vi.waitFor(() => expect(fake.ready()).toBe(true));
    fake.emit(DOUBLE);
    await vi.waitFor(() => expect(fake.exit.calls).toEqual([1]));
  });

  it("a reconnect rebuilds the page and never creates it twice", async () => {
    server.change([inner], "v2");
    const fake = fakeBridge(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.body()).toContain("Neues Modell testen?"));
    const rebuilds = fake.bridge.rebuildPageContainer.mock.calls.length;
    fake.reconnect();
    await vi.waitFor(() => expect(fake.bridge.rebuildPageContainer.mock.calls.length).toBe(rebuilds + 1));
    expect(fake.bridge.createStartUpPageContainer).toHaveBeenCalledTimes(1);
  });

  it("leaving through the system stops the poll and the microphone; coming back rebuilds and polls", async () => {
    server.change([inner], "v2");
    const fake = fakeBridge(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.body()).toContain("Neues Modell testen?"));
    fake.emit(HOLD);
    await vi.waitFor(() => expect(fake.mic).toContain(true));
    fake.emit(5);
    await vi.waitFor(() => expect(fake.mic.at(-1)).toBe(false));
    const polls = server.state.calls.filter((c) => c.key === "GET /hud").length;
    server.change([inner, outer], "v3");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(server.state.calls.filter((c) => c.key === "GET /hud").length).toBe(polls);
    const rebuilds = fake.bridge.rebuildPageContainer.mock.calls.length;
    fake.emit(4);
    await vi.waitFor(() => expect(fake.header()).toContain("Frage 1/2"));
    expect(fake.bridge.rebuildPageContainer.mock.calls.length).toBeGreaterThan(rebuilds);
    expect(fake.bridge.createStartUpPageContainer).toHaveBeenCalledTimes(1);
  });

  it("a system exit stops everything", async () => {
    server.change([inner], "v2");
    const fake = fakeBridge(configured());
    await boot(fake);
    await vi.waitFor(() => expect(fake.body()).toContain("Neues Modell testen?"));
    fake.emit(7);
    const polls = server.state.calls.length;
    server.change([inner, outer], "v3");
    fake.emit(CLICK);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(server.state.calls.length).toBe(polls);
  });
});
