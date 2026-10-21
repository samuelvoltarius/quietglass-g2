import { afterEach, describe, expect, it, vi } from "vitest";
import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";

/** Fresh module state per test: the log is switched on once per app start. */
async function load() {
  vi.resetModules();
  const diag = await import("../src/diag/diag");
  const bridge = await import("../src/diag/bridge");
  return { ...diag, ...bridge };
}

function fakeBridge() {
  let handler: ((event: unknown) => void) | null = null;
  const bridge = {
    onEvenHubEvent: (cb: (event: unknown) => void) => { handler = cb; return () => undefined; },
    shutDownPageContainer: vi.fn(async () => true),
    getUserInfo: vi.fn(async () => ({})),
  };
  return { bridge: bridge as unknown as EvenAppBridge, raw: bridge, emit: (event: unknown) => handler?.(event) };
}

describe("private step log", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("is off without a traffic URL: the bridge comes back untouched and nothing is sent", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const m = await load();
    m.startDiag("", "0.0.0");
    const { bridge } = fakeBridge();
    expect(m.traceBridge(bridge)).toBe(bridge);
    m.diag("x");
    m.diagCount("y");
    m.diagSkip("paused");
    await m.flushDiag();
    expect(m.diagOn()).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("records calls, raw events, counted streams and draw skips, and posts them with the app tag", async () => {
    const bodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => { bodies.push(init.body); return { ok: true }; }));
    const m = await load();
    m.startDiag("http://diag.test:8474/", "9.9.9");
    const fake = fakeBridge();
    const traced = m.traceBridge(fake.bridge);
    const seen: unknown[] = [];
    traced.onEvenHubEvent((event) => seen.push(event));
    fake.emit({ sysEvent: { eventType: 4 } });
    fake.emit({ audioEvent: { audioPcm: [1, 2] } });
    fake.emit({ audioEvent: { audioPcm: [3, 4] } });
    fake.emit({ audioEvent: { audioPcm: [5, 6] } });
    await traced.shutDownPageContainer(1);
    m.diagSkip("paused");
    m.diagSkip("paused");
    m.diagSkip(null);
    m.diagCount("tileRefused:exitAsked");
    // The flush started by the exit call may still be on its way: let it land, then send the rest.
    await new Promise((done) => setTimeout(done, 0));
    await m.flushDiag();
    m.stopDiag();
    expect(seen).toHaveLength(4);
    const sent = bodies.map((body) => JSON.parse(body) as { app: string; ver: string; events: { k: string; [key: string]: unknown }[] });
    expect(sent[0]!.ver).toBe("9.9.9");
    expect(sent.every((batch) => batch.app === "cadence")).toBe(true);
    const events = sent.flatMap((batch) => batch.events);
    const kinds = events.map((event) => event.k);
    expect(kinds).toContain("start");
    expect(events.filter((event) => event.k === "event")).toHaveLength(2);
    expect(events).toContainEqual(expect.objectContaining({ k: "call", fn: "shutDownPageContainer", arg: 1 }));
    expect(events).toContainEqual(expect.objectContaining({ k: "done", fn: "shutDownPageContainer", result: true }));
    expect(events).toContainEqual(expect.objectContaining({ k: "drawSkip", reason: "paused" }));
    expect(events).toContainEqual(expect.objectContaining({ k: "drawSkipRepeat", reason: "paused", n: 1 }));
    expect(events).toContainEqual(expect.objectContaining({ k: "count", what: "event:audio", n: 2 }));
    expect(events).toContainEqual(expect.objectContaining({ k: "count", what: "tileRefused:exitAsked", n: 1 }));
  });
});
