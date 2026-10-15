import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyLive, chooseTranscript, EMPTY_TRANSCRIPT, liveSttUrl, openLiveStt, parseLiveMessage, shouldRedraw, tailLines, transcriptText,
} from "../src/voice/live-stt";
import { MAX_VOICE_MS } from "../src/voice/stt";
import { voiceView } from "../src/glasses/picker";

/** A WebSocket stand-in: the test opens it, sends server messages and reads what the client sent. */
class FakeSocket {
  static last: FakeSocket | null = null;
  readyState = 0;
  sent: unknown[] = [];
  closed = false;
  binaryType = "";
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  constructor(readonly url: string) { FakeSocket.last = this; }
  send(data: unknown): void { this.sent.push(data); }
  close(): void { if (this.closed) return; this.closed = true; this.readyState = 3; this.onclose?.({} as CloseEvent); }
  open(): void { this.readyState = 1; this.onopen?.({} as Event); }
  say(message: object): void { this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent); }
}

afterEach(() => { vi.useRealTimers(); FakeSocket.last = null; });

describe("live transcript", () => {
  it("joins finals and the current partial; an empty final only clears the partial", () => {
    let state = EMPTY_TRANSCRIPT;
    state = applyLive(state, parseLiveMessage(JSON.stringify({ type: "partial", text: "Mirabell", final: false }))!);
    expect(transcriptText(state)).toBe("Mirabell");
    state = applyLive(state, parseLiveMessage(JSON.stringify({ type: "final", text: "Mirabellplatz", final: true }))!);
    state = applyLive(state, { final: false, text: "Salz" });
    expect(transcriptText(state)).toBe("Mirabellplatz Salz");
    state = applyLive(state, { final: true, text: "" });
    expect(transcriptText(state)).toBe("Mirabellplatz");
    expect(parseLiveMessage("not json")).toBeNull();
    expect(parseLiveMessage(JSON.stringify({ type: "ready" }))).toBeNull();
  });

  it("shows the newest words when the text is longer than the screen", () => {
    expect(tailLines("eins zwei drei vier fünf sechs", 10, 2)).toEqual(["drei vier", "fünf sechs"]);
    expect(tailLines("", 10, 2)).toEqual([]);
  });

  it("redraws only for new text and not more often than every 300 ms", () => {
    expect(shouldRedraw("a", "", 1000, 0)).toBe(true);
    expect(shouldRedraw("ab", "a", 1200, 1000)).toBe(false);
    expect(shouldRedraw("ab", "a", 1300, 1000)).toBe(true);
    expect(shouldRedraw("a", "a", 5000, 0)).toBe(false);
  });

  it("uses the live text when the connection held, else the batch upload", () => {
    expect(chooseTranscript({ ok: true, text: " Hauptbahnhof " }, true)).toEqual({ use: "live", text: "Hauptbahnhof" });
    expect(chooseTranscript({ ok: true, text: "" }, true)).toEqual({ use: "batch" });
    expect(chooseTranscript({ ok: false, text: "Haupt" }, true)).toEqual({ use: "batch" });
    expect(chooseTranscript(null, true)).toEqual({ use: "batch" });
    expect(chooseTranscript({ ok: false, text: "Haupt" }, false)).toEqual({ use: "live", text: "Haupt" });
    expect(chooseTranscript({ ok: false, text: "" }, false)).toEqual({ use: "none" });
  });

  it("has no live server in a build without VITE_LIVE_STT_URL, and a generous hard stop", () => {
    expect(liveSttUrl(undefined)).toBe("");
    expect(liveSttUrl(" wss://stt.test ")).toBe("wss://stt.test");
    expect(MAX_VOICE_MS).toBe(30_000);
  });

  it("shows the live words on the glasses while recording", () => {
    const view = voiceView({ phase: "recording", live: "Mirabellplatz Salzburg" }, "de");
    expect(view.body.join("\n")).toContain("Mirabellplatz Salzburg");
  });
});

describe("live connection", () => {
  it("sends the start frame, buffered and later PCM, stop, and returns the last final", async () => {
    const texts: string[] = [];
    const session = openLiveStt({ url: "wss://stt.test", language: "de", onText: (t) => texts.push(t), WS: FakeSocket as never, graceMs: 500 });
    const ws = FakeSocket.last!;
    session.send(new Uint8Array([1, 2]));
    ws.open();
    session.send(new Uint8Array([3, 4]));
    expect(JSON.parse(ws.sent[0] as string)).toEqual({ type: "start", language: "de", sampleRate: 16000, encoding: "s16le", stream: true });
    expect(ws.sent.slice(1)).toEqual([new Uint8Array([1, 2]), new Uint8Array([3, 4])]);
    ws.say({ type: "partial", text: "Mirabell", final: false });
    const finishing = session.finish();
    expect(JSON.parse(ws.sent[ws.sent.length - 1] as string)).toEqual({ type: "stop" });
    ws.say({ type: "final", text: "Mirabellplatz", final: true });
    expect(await finishing).toEqual({ ok: true, text: "Mirabellplatz" });
    expect(texts).toEqual(["Mirabell", "Mirabellplatz"]);
    expect(ws.closed).toBe(true);
  });

  it("gives up after 3 s without a connection, so the batch path takes over", async () => {
    vi.useFakeTimers();
    const session = openLiveStt({ url: "wss://stt.test", language: "de", onText: () => undefined, WS: FakeSocket as never });
    vi.advanceTimersByTime(3_001);
    expect(FakeSocket.last!.closed).toBe(true);
    expect(await session.finish()).toEqual({ ok: false, text: "" });
  });

  it("reports a dropped connection as not ok, keeping what was heard", async () => {
    const session = openLiveStt({ url: "wss://stt.test", language: "de", onText: () => undefined, WS: FakeSocket as never });
    const ws = FakeSocket.last!;
    ws.open();
    ws.say({ type: "final", text: "Linz", final: true });
    ws.close();
    expect(await session.finish()).toEqual({ ok: false, text: "Linz" });
  });

  it("survives a socket that cannot even be created", async () => {
    const Broken = class { constructor() { throw new Error("blocked"); } };
    const session = openLiveStt({ url: "wss://stt.test", language: "de", onText: () => undefined, WS: Broken as never });
    session.send(new Uint8Array([1]));
    expect(await session.finish()).toEqual({ ok: false, text: "" });
  });
});
