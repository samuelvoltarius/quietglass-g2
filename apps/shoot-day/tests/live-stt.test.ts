import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EMPTY_LIVE_TEXT, applyLiveMessage, joinLiveText, liveSttUrl, openLiveStt, parseLiveMessage, tailText,
} from "../src/voice/live-stt";
import { FakeSocket } from "./fake-socket";

const WS = FakeSocket as unknown as typeof WebSocket;

afterEach(() => { vi.useRealTimers(); FakeSocket.last = null; FakeSocket.all = []; });

describe("transcript assembly", () => {
  it("joins finals and the current partial; a final clears the partial", () => {
    let state = EMPTY_LIVE_TEXT;
    state = applyLiveMessage(state, { text: "wie ist", final: false });
    expect(joinLiveText(state)).toBe("wie ist");
    state = applyLiveMessage(state, { text: "Wie ist der Stand?", final: true });
    state = applyLiveMessage(state, { text: "und  der", final: false });
    expect(joinLiveText(state)).toBe("Wie ist der Stand? und der");
    state = applyLiveMessage(state, { text: "", final: true });
    expect(joinLiveText(state)).toBe("Wie ist der Stand?");
    expect(state.finals).toEqual(["Wie ist der Stand?"]);
  });

  it("parses partial and final frames, ignores junk", () => {
    expect(parseLiveMessage('{"type":"partial","text":"a","final":false}')).toEqual({ text: "a", final: false });
    expect(parseLiveMessage('{"type":"final","text":"b"}')).toEqual({ text: "b", final: true });
    expect(parseLiveMessage("{nope")).toBeNull();
    expect(parseLiveMessage('{"type":"ready"}')).toBeNull();
    expect(parseLiveMessage(new ArrayBuffer(2))).toBeNull();
  });

  it("keeps the newest words of a long text", () => {
    expect(tailText("kurz", 10)).toBe("kurz");
    const tail = tailText("eins zwei drei vier fünf sechs", 14);
    expect(tail.length).toBeLessThanOrEqual(14);
    expect(tail.startsWith("…")).toBe(true);
    expect(tail.endsWith("sechs")).toBe(true);
  });

  it("takes the phone override first, then the build default, and only ws(s) addresses", () => {
    expect(liveSttUrl("", "wss://stt.example:8449")).toBe("wss://stt.example:8449");
    expect(liveSttUrl(" wss://mine.example ", "wss://stt.example")).toBe("wss://mine.example");
    expect(liveSttUrl(undefined, undefined)).toBe("");
    expect(liveSttUrl("https://stt.example", "")).toBe("");
    expect(liveSttUrl("kaputt", "")).toBe("");
  });
});

describe("live session", () => {
  it("holds PCM back until open, then sends start, the held blocks and live blocks", async () => {
    const seen: string[] = [];
    const session = openLiveStt({ url: "wss://stt.example", language: "de", WS, onText: (text) => seen.push(text) });
    const socket = FakeSocket.last!;
    expect(socket.binaryType).toBe("arraybuffer");
    session.send(new Uint8Array([1, 2]));
    expect(socket.sent).toEqual([]);
    socket.open();
    expect(session.state).toBe("ready");
    expect(socket.json()[0]).toEqual({ type: "start", language: "de", sampleRate: 16_000, encoding: "s16le", stream: true });
    session.send(new Uint8Array([3, 4]));
    expect(socket.binary().map((b) => [...b])).toEqual([[1, 2], [3, 4]]);
    socket.say("hallo");
    socket.say("hallo welt");
    socket.say("hallo welt");
    expect(seen).toEqual(["hallo", "hallo welt"]);
  });

  it("finish sends stop, takes the last final and closes", async () => {
    const session = openLiveStt({ url: "wss://stt.example", language: "de", WS, graceMs: 500 });
    const socket = FakeSocket.last!;
    socket.open();
    socket.say("Kamera zwei");
    const done = session.finish();
    expect(socket.json().at(-1)).toEqual({ type: "stop" });
    socket.say("Kamera zwei läuft", true);
    expect(await done).toBe("Kamera zwei läuft");
    expect(socket.closed).toBe(true);
  });

  it("finish returns what was heard when no final comes within the grace time", async () => {
    vi.useFakeTimers();
    const session = openLiveStt({ url: "wss://stt.example", language: "de", WS, graceMs: 900 });
    const socket = FakeSocket.last!;
    socket.open();
    socket.say("nur partiell");
    const done = session.finish();
    await vi.advanceTimersByTimeAsync(900);
    expect(await done).toBe("nur partiell");
  });

  it("no handshake within the connect time: failed, finish says use the batch path", async () => {
    vi.useFakeTimers();
    const session = openLiveStt({ url: "wss://stt.example", language: "de", WS, connectTimeoutMs: 3_000 });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(session.state).toBe("failed");
    expect(FakeSocket.last!.closed).toBe(true);
    expect(await session.finish()).toBeNull();
  });

  it("a drop while speaking fails the session (batch path), a drop after stop keeps the text", async () => {
    const first = openLiveStt({ url: "wss://stt.example", language: "de", WS });
    FakeSocket.last!.open();
    FakeSocket.last!.say("etwas");
    FakeSocket.last!.drop();
    expect(first.state).toBe("failed");
    expect(await first.finish()).toBeNull();

    const second = openLiveStt({ url: "wss://stt.example", language: "de", WS, graceMs: 2_000 });
    const socket = FakeSocket.last!;
    socket.open();
    socket.say("fast fertig", true);
    const done = second.finish();
    socket.drop();
    expect(await done).toBe("fast fertig");
  });

  it("without a URL or WebSocket it is failed from the start", async () => {
    const session = openLiveStt({ url: "", language: "de", WS });
    expect(session.state).toBe("failed");
    expect(FakeSocket.all).toEqual([]);
    expect(await session.finish()).toBeNull();
  });

  it("cancel closes at once and sends nothing more", () => {
    const session = openLiveStt({ url: "wss://stt.example", language: "de", WS });
    const socket = FakeSocket.last!;
    socket.open();
    session.cancel();
    session.send(new Uint8Array([9]));
    expect(socket.closed).toBe(true);
    expect(socket.binary()).toEqual([]);
  });
});
