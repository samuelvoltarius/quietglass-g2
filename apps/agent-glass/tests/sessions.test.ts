import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMPTY_PREFS, ageLabel, cleanName, hiddenCount, parsePrefs, prefKey, prepareSessions, sessionRows,
  withHidden, withName, withoutHidden,
} from "../src/sessions/model";
import { manageMode, removeSession, renameSession } from "../src/sessions/manage";
import { MAX_ENTRIES, applyTranscript, fromHistory, type Transcript } from "../src/sessions/transcript";
import { BODY_ROWS, LINE_WIDTH, answerPages, buildView, pageWindow, sessionList, wrap } from "../src/glasses/view";
import { routeGesture, type GestureContext } from "../src/input/route";
import { EMPTY_STATE, parseEvent, type AgentState, type Session } from "../src/terminal/types";
import { OpenClawBackend } from "../src/providers/openclaw";
import { parseSettings } from "../src/storage/persist";
import { resetGestureDedupe } from "../src/input/gestures";
import { transcriptHtml, sessionListHtml } from "../src/ui/phone";

const NOW = new Date("2026-10-13T12:00:00Z");
const ago = (seconds: number): Date => new Date(NOW.getTime() - seconds * 1000);
const session = (id: string, title: string, seconds: number, status = "idle"): Session =>
  ({ id, title, cwd: "Hermes gateway", provider: "hermes", status, timestamp: ago(seconds) });

describe("session list model", () => {
  const list = [session("a", "Old one", 86400 * 3), session("b", "Newest", 30), session("c", "Middle", 7200)];

  it("sorts the newest first and keeps the backend order for equal times", () => {
    expect(prepareSessions(list, EMPTY_PREFS, "hermes").map((item) => item.id)).toEqual(["b", "c", "a"]);
    const same = [session("x", "X", 10), session("y", "Y", 10)];
    expect(prepareSessions(same, EMPTY_PREFS, "hermes").map((item) => item.id)).toEqual(["x", "y"]);
  });

  it("applies names and hides sessions per provider only", () => {
    let prefs = withName(EMPTY_PREFS, prefKey("hermes", "a"), "  Release   notes ");
    prefs = withHidden(prefs, prefKey("hermes", "c"));
    prefs = withHidden(prefs, prefKey("even-terminal", "b"));
    const shown = prepareSessions(list, prefs, "hermes");
    expect(shown.map((item) => item.title)).toEqual(["Newest", "Release notes"]);
    expect(hiddenCount(prefs, "hermes")).toBe(1);
    expect(prepareSessions(list, withoutHidden(prefs, "hermes"), "hermes")).toHaveLength(3);
    // The other provider's hidden session is not touched.
    expect(withoutHidden(prefs, "hermes").hidden).toEqual(["even-terminal:b"]);
  });

  it("an empty name goes back to the agent's own title", () => {
    const named = withName(EMPTY_PREFS, "hermes:a", "Mine");
    expect(withName(named, "hermes:a", "   ").names).toEqual({});
    expect(cleanName("x".repeat(200))).toHaveLength(80);
  });

  it("says how old a session is in a few characters", () => {
    expect(ageLabel(ago(30), NOW, "de")).toBe("jetzt");
    expect(ageLabel(ago(300), NOW, "en")).toBe("5 min");
    expect(ageLabel(ago(3 * 3600), NOW, "de")).toBe("3 h");
    expect(ageLabel(ago(3 * 86400), NOW, "de")).toBe("3 T");
    expect(ageLabel(ago(3 * 86400), NOW, "en")).toBe("3 d");
    expect(ageLabel(new Date(0), NOW, "en")).toBe("");
    expect(ageLabel(new Date(Number.NaN), NOW, "en")).toBe("");
  });

  it("puts \"+ new\" first only when the backend can start a session", () => {
    expect(sessionRows(list, true).map((row) => row.kind)).toEqual(["new", "session", "session", "session", "help"]);
    expect(sessionRows(list, false).map((row) => row.kind)).toEqual(["session", "session", "session", "help"]);
  });

  it("reads stored prefs defensively", () => {
    expect(parsePrefs(null)).toEqual(EMPTY_PREFS);
    expect(parsePrefs({ names: { "hermes:a": "A", bad: 3, empty: "  " }, hidden: ["hermes:b", "hermes:b", 4, ""] }))
      .toEqual({ names: { "hermes:a": "A" }, hidden: ["hermes:b"] });
    expect(parseSettings(JSON.stringify({ provider: "hermes", baseUrl: "ws://h:1", sessionPrefs: { hidden: ["hermes:z"] } })).sessionPrefs)
      .toEqual({ names: {}, hidden: ["hermes:z"] });
    expect(parseSettings("").sessionPrefs).toEqual(EMPTY_PREFS);
  });
});

describe("rename and remove: capability with honest fallback", () => {
  it("without a backend call, names stay on the phone and remove only hides", async () => {
    const backend = {};
    expect(manageMode(backend)).toEqual({ rename: "local", remove: "local" });
    const renamed = await renameSession(backend, EMPTY_PREFS, "hermes", "a", "Mine");
    expect(renamed).toEqual({ where: "local", prefs: { names: { "hermes:a": "Mine" }, hidden: [] } });
    const removed = await removeSession(backend, renamed.prefs, "hermes", "a");
    expect(removed.where).toBe("local");
    expect(removed.prefs.hidden).toEqual(["hermes:a"]);
  });

  it("a backend that can do it does it on the agent's side and drops the local name", async () => {
    const calls: string[] = [];
    const backend = {
      renameSession: async (id: string, title: string) => { calls.push(`rename ${id} ${title}`); },
      deleteSession: async (id: string) => { calls.push(`delete ${id}`); },
    };
    expect(manageMode(backend)).toEqual({ rename: "remote", remove: "remote" });
    const start = withName(EMPTY_PREFS, "hermes:a", "Old local");
    const renamed = await renameSession(backend, start, "hermes", "a", " New ");
    expect(renamed).toEqual({ where: "remote", prefs: { names: {}, hidden: [] } });
    const removed = await removeSession(backend, EMPTY_PREFS, "hermes", "a");
    expect(removed).toEqual({ where: "remote", prefs: EMPTY_PREFS });
    expect(calls).toEqual(["rename a New", "delete a"]);
  });

  it("a failing backend call leaves the prefs untouched (the caller shows the error)", async () => {
    const backend = { renameSession: async () => { throw new Error("nope"); } };
    await expect(renameSession(backend, EMPTY_PREFS, "hermes", "a", "x")).rejects.toThrow("nope");
  });
});

describe("transcript for the phone", () => {
  const ev = (raw: Record<string, unknown>) => parseEvent(raw);

  it("starts from the history and grows live, newest last", () => {
    let t: Transcript = fromHistory([
      { role: "user", text: "Fix it" }, { role: "assistant", text: "Done." }, { role: "system", text: "x" }, { role: "assistant", text: " " },
    ]);
    expect(t).toEqual([{ role: "user", text: "Fix it" }, { role: "assistant", text: "Done." }]);
    t = applyTranscript(t, ev({ type: "user_prompt", text: "And the tests?" }));
    t = applyTranscript(t, ev({ type: "text_delta", text: "Running " }));
    t = applyTranscript(t, ev({ type: "text_delta", text: "them now." }));
    expect(t.at(-1)).toEqual({ role: "assistant", text: "Running them now.", open: true });
    t = applyTranscript(t, ev({ type: "tool_start", tool: "Bash" }));
    t = applyTranscript(t, ev({ type: "text_delta", text: "All green." }));
    t = applyTranscript(t, ev({ type: "result" }));
    expect(t.slice(2)).toEqual([
      { role: "user", text: "And the tests?" },
      { role: "assistant", text: "Running them now." },
      { role: "tool", text: "Bash" },
      { role: "assistant", text: "All green." },
    ]);
  });

  it("a complete message replaces its own streamed parts instead of repeating them", () => {
    let t: Transcript = applyTranscript([], ev({ type: "user_prompt", text: "Q" }));
    t = applyTranscript(t, ev({ type: "text_delta", text: "Part one." }));
    t = applyTranscript(t, ev({ type: "tool_start", tool: "web" }));
    t = applyTranscript(t, ev({ type: "text_delta", text: "Part two." }));
    t = applyTranscript(t, ev({ type: "text", text: "Part one. Part two." }));
    expect(t).toEqual([
      { role: "user", text: "Q" }, { role: "tool", text: "web" }, { role: "assistant", text: "Part one. Part two." },
    ]);
    // Separate complete messages (Even Terminal) all stay.
    let u: Transcript = applyTranscript([], ev({ type: "text", text: "First message." }));
    u = applyTranscript(u, ev({ type: "tool_start", tool: "Edit" }));
    u = applyTranscript(u, ev({ type: "text", text: "Second message." }));
    expect(u.map((entry) => entry.text)).toEqual(["First message.", "Edit", "Second message."]);
  });

  it("records errors and stays bounded", () => {
    let t: Transcript = applyTranscript([], ev({ type: "error", message: "boom" }));
    expect(t).toEqual([{ role: "error", text: "boom" }]);
    for (let i = 0; i < MAX_ENTRIES + 20; i += 1) t = applyTranscript(t, ev({ type: "user_prompt", text: `q${i}` }));
    expect(t).toHaveLength(MAX_ENTRIES);
    expect(t.at(-1)?.text).toBe(`q${MAX_ENTRIES + 19}`);
  });

  it("is escaped on the phone page", () => {
    const html = transcriptHtml([{ role: "assistant", text: "<img src=x onerror=alert(1)>" }], "de");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(html).toContain("Agent");
    expect(transcriptHtml([], "de")).toContain("Brille");
    const list = sessionListHtml([session("b\"><x", "<b>Title</b>", 300)], "b\"><x", "de", NOW, true);
    expect(list).not.toContain("<b>Title");
    expect(list).toContain("5 min");
    expect(list).toContain("offen");
  });
});

describe("paging a long answer on the glasses", () => {
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);

  it("counts back from the newest part, full screens, oldest filled from the start", () => {
    expect(pageWindow(lines, 5, 7, 0)).toEqual({ lines: lines.slice(15), page: 0, pages: 4 });
    expect(pageWindow(lines, 5, 7, 1).lines).toEqual(lines.slice(8, 15));
    expect(pageWindow(lines, 5, 7, 2).lines).toEqual(lines.slice(1, 8));
    expect(pageWindow(lines, 5, 7, 3).lines).toEqual(lines.slice(0, 7));
    expect(pageWindow(lines, 5, 7, 99).page).toBe(3);
    expect(pageWindow(lines.slice(0, 3), 5, 7, 2)).toEqual({ lines: lines.slice(0, 3), page: 0, pages: 1 });
  });

  const s: Session = session("h1", "Hermes work", 60);
  const long: AgentState = { ...EMPTY_STATE, session: s, controllable: true, text: "word ".repeat(300) };

  it("shows where you are and how to get back", () => {
    const pages = answerPages(long);
    expect(pages).toBe(pageWindow(wrap(long.text), BODY_ROWS).pages);
    expect(pages).toBeGreaterThan(2);
    expect(buildView(long, NOW, "de").header).toBe("AGENT · bereit · Hermes work");
    expect(buildView(long, NOW, "de").footer).toBe("Tippen = hören · Wischen · Halten = Liste · 2× = Ende");
    expect(buildView(long, NOW, "de", 1).header).toBe(`AGENT · Seite ${pages - 1}/${pages} · Hermes work`);
    expect(buildView(long, NOW, "de", 1).footer).toBe("Tippen = neueste · Wischen · 2× = Ende");
    expect(buildView(long, NOW, "en", pages - 1).header).toBe(`AGENT · page 1/${pages} · Hermes work`);
    expect(buildView(long, NOW, "en", pages - 1).footer).toBe("Tap = newest · Swipe · 2× = exit");
    expect(buildView(long, NOW, "en", 1).body).toHaveLength(BODY_ROWS);
    // A short answer has nothing to page.
    expect(answerPages({ ...long, text: "short" })).toBe(1);
    expect(buildView({ ...long, text: "short" }, NOW, "en").footer).not.toContain("Swipe");
    // Decisions and errors are never paged.
    expect(answerPages({ ...long, pending: { kind: "permission", title: "Bash", detail: "ls" } })).toBe(1);
    expect(answerPages({ ...long, error: "x" })).toBe(1);
  });

  const ctx = (state: AgentState, page: number, pages: number): GestureContext =>
    ({ screen: "agent", state, selected: 0, sessionCount: 0, decisions: true, demo: false, page, pages });

  it("swipe up goes older, down newer, tap jumps to the newest", () => {
    expect(routeGesture("scrollUp", ctx(long, 0, 4))).toEqual({ kind: "page", page: 1 });
    expect(routeGesture("scrollDown", ctx(long, 2, 4))).toEqual({ kind: "page", page: 1 });
    expect(routeGesture("scrollUp", ctx(long, 3, 4))).toEqual({ kind: "ignore" });
    expect(routeGesture("scrollDown", ctx(long, 0, 4))).toEqual({ kind: "ignore" });
    expect(routeGesture("click", ctx(long, 2, 4))).toEqual({ kind: "page", page: 0 });
    expect(routeGesture("click", ctx(long, 0, 4))).toEqual({ kind: "replay" });
  });

  it("never pages behind a permission request (the swipe moves the answer cursor) or behind an error", () => {
    const asking: AgentState = { ...long, pending: { kind: "permission", title: "Bash", detail: "ls" } };
    expect(routeGesture("scrollUp", ctx(asking, 0, 4))).toEqual({ kind: "choose", index: 0 });
    expect(routeGesture("scrollDown", ctx(asking, 0, 4))).toEqual({ kind: "choose", index: 1 });
    expect(routeGesture("scrollUp", ctx({ ...long, error: "x" }, 0, 4))).toEqual({ kind: "ignore" });
    expect(routeGesture("click", ctx({ ...long, error: "x" }, 2, 4))).toEqual({ kind: "retry" });
    expect(routeGesture("scrollUp", { ...ctx(long, 0, 4), demo: true })).toEqual({ kind: "ignore" });
  });
});

describe("session list on the glasses", () => {
  const list = [session("b", "Newest", 30, "running"), session("c", "Middle", 7200)];

  it("offers \"+ new session\", the age and the busy mark", () => {
    const view = sessionList(list, 1, "de", true, { canCreate: true, now: NOW });
    expect(view.body).toEqual(["  + Neue Sitzung", "> Newest · jetzt *", "  Middle · 2 h", "  Hilfe"]);
    expect(view.header).toBe("AGENT · Sitzungen (2)");
    expect(view.footer).toBe("Tippen = öffnen · Wischen · 2× = zurück");
  });

  it("with no sessions but a way to start one, the list is not a dead end", () => {
    expect(sessionList([], 0, "en", false, { canCreate: true, now: NOW }).body).toEqual(["> + New session", "  Help"]);
  });

  it("says honestly when the backend keeps no list", () => {
    const view = sessionList([session("o", "OpenClaw", 0)], 1, "de", true, { canCreate: true, listable: false, now: NOW });
    expect(view.body).toEqual(["  + Neue Sitzung", "> OpenClaw", "  Hilfe", "", "Dieser Dienst führt keine Sitzungsliste."]);
  });

  it("keeps long titles and the age inside one row", () => {
    const view = sessionList([session("l", "T".repeat(120), 300)], 0, "en", false, { now: NOW });
    expect(view.body[0]?.length).toBeLessThanOrEqual(LINE_WIDTH);
    expect(view.body[0]).toMatch(/… · 5 min$/);
  });
});

describe("OpenClaw new conversation", () => {
  it("forgets the in-app context but keeps the one conversation id", async () => {
    const bodies: string[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ""));
      return new Response(JSON.stringify({ choices: [{ message: { content: "Hi." } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const backend = new OpenClawBackend({ baseUrl: "http://gw", token: "t", fetchImpl });
    expect(backend.capabilities).toMatchObject({ sessions: false, createSession: true });
    await backend.prompt("openclaw-main", "first");
    expect(await backend.history("openclaw-main")).toHaveLength(2);
    const fresh = await backend.createSession();
    expect(fresh.id).toBe("openclaw-main");
    expect(await backend.history("openclaw-main")).toEqual([]);
    await backend.prompt("openclaw-main", "second");
    expect(JSON.parse(bodies[1] ?? "{}").messages).toEqual([{ role: "user", content: "second" }]);
  });
});

// The real app against a fake Hermes bridge: list on the glasses, new session from it, paging.
const harness = vi.hoisted(() => ({ bridge: null as unknown }));
vi.mock("@evenrealities/even_hub_sdk", async (importOriginal) => {
  const scope = globalThis as { window?: unknown };
  const saved = scope.window;
  scope.window = undefined;
  try {
    return { ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()), waitForEvenAppBridge: async () => harness.bridge };
  } finally {
    scope.window = saved;
  }
});

class FakeBridgeSocket {
  static last: FakeBridgeSocket | null = null;
  static answer = "word ".repeat(300);
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  constructor(readonly url: string) {
    FakeBridgeSocket.last = this;
    queueMicrotask(() => { this.readyState = 1; this.onopen?.(); });
  }
  send(raw: string): void {
    const m = JSON.parse(raw) as Record<string, unknown>;
    this.sent.push(m);
    const now = Date.now() / 1000;
    if (m.t === "hello") this.emit({ t: "hello.ok", active: "h1" });
    if (m.t === "sessions.list") {
      this.emit({ t: "sessions", active: "h1", items: [
        { id: "h0", title: "Older work", updated: now - 7200 },
        { id: "h1", title: "Hermes work", updated: now - 300 },
      ] });
    }
    if (m.t === "sessions.switch") {
      this.emit({ t: "history", id: m.id, items: [{ kind: "user", text: "Explain" }, { kind: "assistant", text: FakeBridgeSocket.answer }] });
    }
    if (m.t === "sessions.new") this.emit({ t: "active", id: "h2" });
  }
  close(): void { this.readyState = 3; }
  emit(value: unknown): void { queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(value) })); }
}

describe("Agent Glass with Hermes sessions (integration)", () => {
  beforeEach(() => {
    resetGestureDedupe();
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval", "Date"] });
    vi.setSystemTime(NOW);
    vi.stubGlobal("window", { addEventListener: () => undefined, removeEventListener: () => undefined });
    vi.stubGlobal("location", { search: "", pathname: "/", hash: "" });
    vi.stubGlobal("document", { getElementById: () => null, querySelector: () => null, addEventListener: () => undefined, removeEventListener: () => undefined });
    vi.stubGlobal("WebSocket", FakeBridgeSocket);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("opens the last session, pages its answer, lists sessions with age and starts a new one", async () => {
    let handler: ((event: unknown) => void) | undefined;
    const screens: string[] = [];
    const created: { images: number }[] = [];
    const page: Record<number, string> = {};
    const snapshot = (): string => [page[1], page[2], page[3]].join("\n");
    harness.bridge = {
      getLocalStorage: async (key: string) => key === "quietglass.agentglass.v1"
        ? JSON.stringify({ provider: "hermes", baseUrl: "ws://bridge:8765", token: "bridge-token", sessionId: "h1" })
        : "en",
      setLocalStorage: async () => true,
      rebuildPageContainer: async (built: { textObject?: { containerID: number; content: string }[]; imageObject?: unknown[] }) => {
        for (const item of built.textObject ?? []) page[item.containerID] = item.content;
        created.push({ images: built.imageObject?.length ?? 0 });
        screens.push(snapshot());
        return true;
      },
      createStartUpPageContainer: async (built: { textObject?: { containerID: number; content: string }[]; imageObject?: unknown[] }) => {
        for (const item of built.textObject ?? []) page[item.containerID] = item.content;
        created.push({ images: built.imageObject?.length ?? 0 });
        screens.push(snapshot());
        return 0;
      },
      textContainerUpgrade: async (update: { containerID: number; content: string }) => {
        page[update.containerID] = update.content;
        screens.push(snapshot());
        return true;
      },
      updateImageRawData: async () => "success",
      shutDownPageContainer: async () => false,
      onEvenHubEvent: (callback: (event: unknown) => void) => { handler = callback; return () => undefined; },
      onDeviceStatusChanged: () => () => undefined,
    };
    const gesture = async (eventType: number): Promise<void> => {
      resetGestureDedupe();
      handler?.({ sysEvent: { eventType, eventSource: 1 } });
      await vi.advanceTimersByTimeAsync(50);
    };

    vi.resetModules();
    await import("../src/main");
    await vi.waitFor(() => expect(handler).toBeDefined());
    await vi.advanceTimersByTimeAsync(200);
    // The open session opens on the status cockpit (an image, no text); a swipe opens the answer text.
    expect(created.at(-1)).toMatchObject({ images: 4 });
    await gesture(1);
    expect(page[1]).toBe("AGENT · ready · Hermes work");
    expect(page[3]).toBe("Tap = replay · Swipe · Hold = sessions · 2× = back");

    await gesture(1); // swipe up: one screen back
    expect(page[1]).toMatch(/^AGENT · page \d+\/\d+ · Hermes work$/);
    expect(page[3]).toBe("Tap = newest · Swipe · 2× = back");
    await gesture(0); // tap: back to the newest
    expect(page[3]).toContain("Hold = sessions");

    await gesture(9); // hold: session list, cursor on the open session
    await vi.advanceTimersByTimeAsync(200);
    expect(page[1]).toBe("AGENT · sessions (2)");
    expect(page[2]?.split("\n")).toEqual(["  + New session", "> Hermes work · 5 min *", "  Older work · 2 h", "  Help"]);

    await gesture(1); // up to "+ New session"
    await gesture(0); // tap: start it
    await vi.advanceTimersByTimeAsync(200);
    expect(FakeBridgeSocket.last?.sent.map((m) => m.t)).toContain("sessions.new");
    expect(page[1]).toContain("AGENT");
  });
});
