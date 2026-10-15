import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyLine, chooseVoicePath, EMPTY_TRANSCRIPT, parseLiveMessage, startLiveStt, transcriptText,
} from "../src/stt/live-stt";
import { createModel, buildView, liveRows, withLiveText, type HubModel } from "../src/hub/model";
import { createDemoApi } from "../src/api/demo";

class FakeSocket {
  static last: FakeSocket | null = null;
  readyState = 0;
  binaryType = "";
  sent: unknown[] = [];
  closed = false;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  constructor(readonly url: string) { FakeSocket.last = this; }
  send(data: unknown): void { this.sent.push(data); }
  close(): void { this.closed = true; this.readyState = 3; }
  open(): void { this.readyState = 1; this.onopen?.({}); }
  say(payload: unknown): void { this.onmessage?.({ data: JSON.stringify(payload) }); }
  drop(): void { this.readyState = 3; this.onclose?.({}); }
}

afterEach(() => { vi.useRealTimers(); FakeSocket.last = null; });

describe("transcript assembly", () => {
  it("parses partial and final lines in the server's and common shapes", () => {
    expect(parseLiveMessage('{"type":"partial","text":"hallo wel","final":false}')).toEqual({ text: "hallo wel", final: false });
    expect(parseLiveMessage('{"type":"final","text":"Hallo Welt.","final":true,"speaker":"A"}')).toEqual({ text: "Hallo Welt.", final: true });
    expect(parseLiveMessage('{"transcript":"x","is_final":true}')).toEqual({ text: "x", final: true });
    expect(parseLiveMessage("kein json")).toBeNull();
    expect(parseLiveMessage('{"type":"ready"}')).toBeNull();
    expect(parseLiveMessage(new ArrayBuffer(2))).toBeNull();
  });

  it("joins all finals and the current partial", () => {
    let t = EMPTY_TRANSCRIPT;
    t = applyLine(t, { text: "Mach  bitte", final: false });
    expect(transcriptText(t)).toBe("Mach bitte");
    t = applyLine(t, { text: "Mach bitte die Tests.", final: true });
    t = applyLine(t, { text: "Und dann", final: false });
    expect(transcriptText(t)).toBe("Mach bitte die Tests. Und dann");
    // An empty final only clears the partial.
    t = applyLine(t, { text: "", final: true });
    expect(transcriptText(t)).toBe("Mach bitte die Tests.");
  });

  it("goes live only with a complete, non-empty transcript; else the WAV upload", () => {
    expect(chooseVoicePath({ ok: true, text: "Hallo" })).toBe("live");
    expect(chooseVoicePath({ ok: true, text: "  " })).toBe("upload");
    expect(chooseVoicePath({ ok: false, text: "Hallo" })).toBe("upload");
  });
});

describe("live STT session", () => {
  it("holds PCM until the socket opens, then sends the start frame and the audio", async () => {
    const texts: string[] = [];
    const session = startLiveStt({ url: "wss://stt.example:8449", language: "de", onText: (t) => texts.push(t), WS: FakeSocket as never });
    const ws = FakeSocket.last!;
    session.send(new Uint8Array([1, 2]));
    expect(ws.sent).toEqual([]);
    ws.open();
    expect(JSON.parse(ws.sent[0] as string)).toEqual({ type: "start", language: "de", sampleRate: 16000, encoding: "s16le", stream: true });
    expect(ws.sent[1]).toEqual(new Uint8Array([1, 2]));
    session.send(new Uint8Array([3]));
    expect(ws.sent[2]).toEqual(new Uint8Array([3]));

    ws.say({ type: "partial", text: "Hallo", final: false });
    ws.say({ type: "partial", text: "Hallo", final: false }); // unchanged: no callback
    ws.say({ type: "final", text: "Hallo Welt", final: true });
    expect(texts).toEqual(["Hallo", "Hallo Welt"]);

    // Release: "stop", then the last final ends the wait early.
    const done = session.finish();
    expect(JSON.parse(ws.sent.at(-1) as string)).toEqual({ type: "stop" });
    ws.say({ type: "final", text: "wie geht es", final: true });
    await expect(done).resolves.toEqual({ ok: true, text: "Hallo Welt wie geht es" });
    expect(ws.closed).toBe(true);
  });

  it("keeps the partial when no final comes within the grace", async () => {
    vi.useFakeTimers();
    const session = startLiveStt({ url: "wss://x", language: "de", onText: () => undefined, WS: FakeSocket as never, stopGraceMs: 900 });
    const ws = FakeSocket.last!;
    ws.open();
    ws.say({ type: "partial", text: "noch nicht fertig", final: false });
    const done = session.finish();
    await vi.advanceTimersByTimeAsync(900);
    await expect(done).resolves.toEqual({ ok: true, text: "noch nicht fertig" });
  });

  it("fails over to the upload when the socket does not open within 3 s", async () => {
    vi.useFakeTimers();
    const session = startLiveStt({ url: "wss://x", language: "de", onText: () => undefined, WS: FakeSocket as never });
    session.send(new Uint8Array([1]));
    await vi.advanceTimersByTimeAsync(3000);
    expect(session.status).toBe("failed");
    expect(FakeSocket.last!.closed).toBe(true);
    const result = await session.finish();
    expect(chooseVoicePath(result)).toBe("upload");
  });

  it("a drop while speaking makes the live text incomplete: upload", async () => {
    const session = startLiveStt({ url: "wss://x", language: "de", onText: () => undefined, WS: FakeSocket as never });
    const ws = FakeSocket.last!;
    ws.open();
    ws.say({ type: "final", text: "erster Teil", final: true });
    ws.drop();
    const result = await session.finish();
    expect(result.ok).toBe(false);
    expect(chooseVoicePath(result)).toBe("upload");
  });

  it("no URL (public build) or no WebSocket: failed at once, nothing thrown", async () => {
    const session = startLiveStt({ url: "", language: "de", onText: () => undefined, WS: FakeSocket as never });
    expect(session.status).toBe("failed");
    expect(FakeSocket.last).toBeNull();
    session.send(new Uint8Array([1]));
    expect(await session.finish()).toEqual({ ok: false, text: "" });
  });

  it("cancel closes without waiting", () => {
    const session = startLiveStt({ url: "wss://x", language: "de", onText: () => undefined, WS: FakeSocket as never });
    FakeSocket.last!.open();
    session.cancel();
    expect(FakeSocket.last!.closed).toBe(true);
    expect(session.status).toBe("failed");
  });
});

describe("listening page", () => {
  it("shows the newest words of the live transcript while recording", async () => {
    const report = await createDemoApi("de", "default").report();
    let model: HubModel = { ...createModel(report), screen: "agent", agentView: "ask", recording: true, recordAgent: report.agents[0]!.id };
    expect(buildView(model, "de", 0).body.join("\n")).toContain("Aufnahme");
    const long = Array.from({ length: 80 }, (_, i) => `Wort${i}`).join(" ");
    model = withLiveText(model, long);
    const view = buildView(model, "de", 0);
    expect(view.body[0]).toContain("Ich höre");
    expect(view.body.length).toBeLessThanOrEqual(7);
    expect(view.body.at(-1)).toContain("Wort79");
    expect(view.body.join(" ")).not.toContain("Wort0 ");
  });

  it("ignores live text when not recording and tails long text", () => {
    const base = createModel({ ...emptyLike() });
    expect(withLiveText(base, "x")).toBe(base);
    expect(liveRows("a b c", 6)).toEqual(["a b c"]);
  });
});

function emptyLike() {
  return {
    connection: "connected" as const,
    agent: { provider: "A", questions: [], selected: 0, answer: null, busy: false, suggestions: [] },
    agents: [],
    approvals: [],
    home: { devices: [], selected: 0 },
    printer: { job: null, state: "ready" as const, layer: 0, layers: 0, etaMin: null, nozzleC: 0, bedC: 0, selected: 0 },
    inbox: { events: [], selected: 0 },
  };
}
