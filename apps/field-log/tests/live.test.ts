import { afterEach, describe, expect, it, vi } from "vitest";
import { createLiveStt, liveSttUrl, LiveTranscript, parseTranscript, redrawDelay } from "../src/stt/live";
import { batchRange, MAX_UPLOAD_BYTES, sliceChunks, transcribeTimeoutMs } from "../src/stt/provider";
import { buildView, clockLabel, tailRows } from "../src/glasses/view";
import { startInspection } from "../src/log/entries";
import { FakeSocket } from "./fake-socket";

const WS = FakeSocket as unknown as typeof WebSocket;

describe("live transcript assembly", () => {
  it("joins all finals and the current partial; an empty final only clears the partial", () => {
    const heard = new LiveTranscript();
    expect(heard.apply({ text: "Fenster", final: false })).toBe(true);
    expect(heard.text()).toBe("Fenster");
    expect(heard.apply({ text: " Fenster  im Bad ", final: true })).toBe(true);
    expect(heard.apply({ text: "ist", final: false })).toBe(true);
    expect(heard.text()).toBe("Fenster im Bad ist");
    expect(heard.committed()).toBe("Fenster im Bad");
    expect(heard.apply({ text: "", final: true })).toBe(true);
    expect(heard.text()).toBe("Fenster im Bad");
    expect(heard.apply({ text: "ist", final: false })).toBe(true);
    expect(heard.apply({ text: "ist", final: false })).toBe(false);
  });

  it("parses the server's partial and final frames and ignores the rest", () => {
    expect(parseTranscript('{"type":"partial","text":"so far","stable":"so","final":false}')).toEqual({ text: "so far", final: false });
    expect(parseTranscript('{"type":"final","text":"done","final":true,"speaker":"A"}')).toEqual({ text: "done", final: true });
    expect(parseTranscript('{"type":"ready"}')).toBeNull();
    expect(parseTranscript("not json")).toBeNull();
    expect(parseTranscript(new ArrayBuffer(2))).toBeNull();
  });

  it("takes a live address only from a ws/wss build variable", () => {
    expect(liveSttUrl(" wss://live.test:8449 ")).toBe("wss://live.test:8449");
    expect(liveSttUrl("https://live.test")).toBe("");
    expect(liveSttUrl("")).toBe("");
    expect(liveSttUrl(undefined)).toBe("");
  });

  it("redraws live text at most every 300 ms", () => {
    expect(redrawDelay(0, 10_000)).toBe(0);
    expect(redrawDelay(10_000, 10_100)).toBe(200);
    expect(redrawDelay(10_000, 10_400)).toBe(0);
  });
});

describe("batch fallback", () => {
  it("sends everything that fits, else the last part and says so", () => {
    expect(batchRange(64_000, 0)).toEqual({ start: 0, truncated: false });
    expect(batchRange(MAX_UPLOAD_BYTES + 100, 0)).toEqual({ start: 100, truncated: true });
  });

  it("after a drop sends only what the live finals did not cover, reaching back a little", () => {
    expect(batchRange(400_000, 300_000)).toEqual({ start: 268_000, truncated: false });
    // Long after the last final: still capped to the last part.
    const range = batchRange(3_000_000, 100_000);
    expect(range).toEqual({ start: 3_000_000 - MAX_UPLOAD_BYTES, truncated: true });
    // Never an odd byte offset: 16-bit samples stay aligned.
    expect(batchRange(MAX_UPLOAD_BYTES + 101, 0).start % 2).toBe(0);
  });

  it("slices kept PCM blocks from an offset", () => {
    const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5]), new Uint8Array([6])];
    expect(sliceChunks(chunks, 0)).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
    expect(sliceChunks(chunks, 2)).toEqual(new Uint8Array([3, 4, 5, 6]));
    expect(sliceChunks(chunks, 5)).toEqual(new Uint8Array([6]));
    expect(sliceChunks(chunks, 6)).toEqual(new Uint8Array([]));
  });

  it("gives the server 20 s plus 1 s per 10 s of audio, at most 120 s", () => {
    expect(transcribeTimeoutMs(0)).toBe(20_000);
    expect(transcribeTimeoutMs(32_000 * 10)).toBe(21_000);
    expect(transcribeTimeoutMs(32_000 * 31)).toBe(24_000);
    expect(transcribeTimeoutMs(32_000 * 600)).toBe(80_000);
    expect(transcribeTimeoutMs(32_000 * 3_600)).toBe(120_000);
  });
});

describe("live client", () => {
  afterEach(() => { vi.useRealTimers(); FakeSocket.last = null; });

  it("queues audio until the socket is open, then sends the start frame and the queue", () => {
    const onTranscript = vi.fn();
    const live = createLiveStt({ url: "wss://live.test", language: "de", WS, onTranscript, onLost: vi.fn() });
    live.send(new Uint8Array([1]));
    live.send(new Uint8Array([2]));
    const socket = FakeSocket.last!;
    expect(socket.sent).toHaveLength(0);
    socket.open();
    expect(JSON.parse(socket.sent[0] as string)).toEqual({ type: "start", language: "de", sampleRate: 16_000, encoding: "s16le", stream: true });
    expect(socket.sent.slice(1)).toEqual([new Uint8Array([1]), new Uint8Array([2])]);
    live.send(new Uint8Array([3]));
    expect(socket.sent).toHaveLength(4);
    socket.reply({ type: "partial", text: "hallo", final: false });
    expect(onTranscript).toHaveBeenCalledWith({ text: "hallo", final: false });
  });

  it("gives up after 3 s without an open socket and reports the loss once", async () => {
    vi.useFakeTimers();
    const onLost = vi.fn();
    const live = createLiveStt({ url: "wss://live.test", language: "de", WS, onTranscript: vi.fn(), onLost });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(onLost).toHaveBeenCalledTimes(1);
    expect(live.state).toBe("lost");
    expect(FakeSocket.last!.closed).toBe(true);
    expect(await live.finish()).toBe(false);
  });

  it("a drop is reported, never reconnected, and later audio is not sent", () => {
    const onLost = vi.fn();
    const live = createLiveStt({ url: "wss://live.test", language: "de", WS, onTranscript: vi.fn(), onLost });
    const socket = FakeSocket.last!;
    socket.open();
    socket.drop();
    expect(onLost).toHaveBeenCalledTimes(1);
    live.send(new Uint8Array([9]));
    expect(socket.sent).toHaveLength(1);
    expect(FakeSocket.last).toBe(socket);
  });

  it("finish sends stop and waits for the last final, at most the grace time", async () => {
    vi.useFakeTimers();
    const heard = new LiveTranscript();
    const live = createLiveStt({ url: "wss://live.test", language: "de", token: "tok", WS, onTranscript: (t) => heard.apply(t), onLost: vi.fn() });
    const socket = FakeSocket.last!;
    socket.open();
    expect(JSON.parse(socket.sent[0] as string).token).toBe("tok");
    socket.reply({ type: "final", text: "Erster Satz.", final: true });
    const done = live.finish();
    expect(JSON.parse(socket.sent.at(-1) as string)).toEqual({ type: "stop" });
    socket.reply({ type: "final", text: "Zweiter.", final: true });
    expect(await done).toBe(true);
    expect(heard.text()).toBe("Erster Satz. Zweiter.");
    expect(socket.closed).toBe(true);

    const quiet = createLiveStt({ url: "wss://live.test", language: "de", WS, onTranscript: vi.fn(), onLost: vi.fn() });
    FakeSocket.last!.open();
    const waiting = quiet.finish(900);
    await vi.advanceTimersByTimeAsync(900);
    expect(await waiting).toBe(true);
  });
});

describe("recording view", () => {
  const inspection = startInspection("i1", "Flat 3", 0);
  const base = { phase: "recording" as const, severity: "note" as const, pending: null, status: "idle" as const, mock: false, locale: "de" as const };

  it("shows the newest words of a long live text, with a clock in the footer", () => {
    const text = Array.from({ length: 80 }, (_, i) => "Wort" + i).join(" ");
    const view = buildView(inspection, { ...base, live: "live", liveText: text, elapsedMs: 75_000 }, 0);
    expect(view.body.length).toBeLessThanOrEqual(7);
    expect(view.body.at(-2)).toContain("Wort79");
    expect(view.body[0]!.startsWith("…")).toBe(true);
    expect(view.header).toContain("1:15");
    expect(view.footer).toBe("Tippen = fertig");
  });

  it("says when the live text is lost and recording goes on", () => {
    const view = buildView(inspection, { ...base, live: "lost", liveText: "alt", elapsedMs: 0 }, 0);
    expect(view.body.join("\n")).toContain("Live-Text weg");
    expect(view.body.join("\n")).not.toContain("alt");
    expect(view.header).toContain("ohne Live-Text");
  });

  it("names a cut upload in the review header", () => {
    const view = buildView(inspection, { ...base, phase: "review", pending: "Rest", truncated: true }, 0);
    expect(view.header).toBe("FIELDLOG · Behalten? · nur die letzten 30 s");
  });

  it("helpers: tail rows and m:ss", () => {
    expect(tailRows(["a", "b", "c"], 2, 56)).toEqual(["… b", "c"]);
    expect(tailRows(["a"], 2, 56)).toEqual(["a"]);
    expect(clockLabel(600_000)).toBe("10:00");
    expect(clockLabel(9_500)).toBe("0:09");
  });
});
