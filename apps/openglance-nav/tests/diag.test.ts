import { afterEach, describe, expect, it, vi } from "vitest";

describe("step log for faults on the real glasses", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it("stays silent without a traffic URL (public build): nothing recorded, nothing sent", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.resetModules();
    const { diag, diagOn, flushDiag, startDiag } = await import("../src/diag/diag");
    startDiag("", "x");
    diag("bridge", { what: "rebuild" });
    await flushDiag();
    expect(diagOn()).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends batches as a simple text/plain POST to <traffic>/diag, without positions, and keeps them when sending fails", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const bodies: string[] = [];
    let fail = true;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://traffic.test/diag");
      expect((init.headers as Record<string, string>)["Content-Type"]).toBe("text/plain");
      bodies.push(String(init.body));
      return new Response("{}", { status: fail ? 503 : 200 });
    }));
    vi.resetModules();
    const { diag, flushDiag, startDiag, stopDiag } = await import("../src/diag/diag");
    startDiag("https://traffic.test/", "0.17.5");
    diag("bridge", { what: "rebuild", ms: 12, ok: true });
    await flushDiag();
    fail = false;
    await flushDiag();
    const sent = JSON.parse(bodies[1]!) as { app: string; ver: string; events: { k: string }[] };
    expect(sent.app).toBe("openglance");
    expect(sent.ver).toBe("0.17.5");
    expect(sent.events.map((e) => e.k)).toEqual(["start", "bridge"]);
    expect(bodies[1]).not.toMatch(/lat|lon/);
    await flushDiag();
    expect(bodies).toHaveLength(2); // nothing left to send
    stopDiag();
  });
});
