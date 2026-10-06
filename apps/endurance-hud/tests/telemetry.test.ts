import { afterEach, describe, expect, it, vi } from "vitest";
import { demoTelemetry, elapsed, fetchTelemetry, pace, parseTelemetry } from "../src/telemetry/model";

describe("telemetry", () => { it("normalizes a Garmin-style payload", () => expect(parseTelemetry({ sport: "run", speedKph: "12.5", powerWatts: 301 }).powerWatts).toBe(301)); it("formats pace", () => expect(pace(305)).toBe("5:05")); it("formats elapsed time", () => expect(elapsed(3661)).toBe("1:01:01")); });

describe("parsing bridge payloads", () => {
  it("accepts numeric strings", () => { expect(parseTelemetry({ speedKph: "12.5", heartRate: "150" })).toMatchObject({ speedKph: 12.5, heartRate: 150 }); });
  it("turns missing, NaN and Infinity values into 0", () => {
    const parsed = parseTelemetry({ speedKph: "fast", powerWatts: Number.NaN, heartRate: Infinity, cadence: undefined });
    expect([parsed.speedKph, parsed.powerWatts, parsed.heartRate, parsed.cadence]).toEqual([0, 0, 0, 0]);
  });
  it("defaults the sport to bike unless it is exactly run", () => {
    expect(parseTelemetry({ sport: "run" }).sport).toBe("run");
    expect(parseTelemetry({ sport: "RUN" }).sport).toBe("bike");
    expect(parseTelemetry({}).sport).toBe("bike");
  });
  it("keeps the reported source and timestamp, defaulting them when absent", () => {
    expect(parseTelemetry({ source: "garmin", updatedAt: "2026-01-01T00:00:00Z" })).toMatchObject({ source: "garmin", updatedAt: "2026-01-01T00:00:00Z" });
    const fallback = parseTelemetry({ source: 7 });
    expect(fallback.source).toBe("bridge");
    expect(Number.isNaN(Date.parse(fallback.updatedAt))).toBe(false);
  });
  it("handles a null or non-object body without a TypeError", () => {
    // Regression: `parseTelemetry(null)` threw "Cannot read properties of null (reading 'sport')".
    expect(parseTelemetry(null)).toMatchObject({ sport: "bike", speedKph: 0, source: "bridge" });
    expect(parseTelemetry("oops").heartRate).toBe(0);
  });
  it("provides a complete demo record", () => {
    const demo = demoTelemetry();
    expect(demo.source).toBe("demo");
    expect(Object.values(demo).every((value) => value !== undefined)).toBe(true);
  });
});

describe("pace", () => {
  it("shows placeholders for zero, negative and non-finite pace", () => {
    for (const value of [0, -30, Number.NaN, Infinity]) expect(pace(value)).toBe("--:--");
  });
  it("pads single-digit seconds", () => { expect(pace(301)).toBe("5:01"); expect(pace(60)).toBe("1:00"); });
  it("rolls 59.5+ seconds over into the next minute", () => {
    // Regression: pace(299.6) rendered "4:60" because seconds were rounded after splitting off the minutes.
    expect(pace(299.6)).toBe("5:00");
    expect(pace(359.5)).toBe("6:00");
  });
  it("rounds fractional seconds to the nearest second", () => { expect(pace(305.4)).toBe("5:05"); });
  it("handles very slow paces above an hour per km", () => { expect(pace(3725)).toBe("62:05"); });
});

describe("elapsed time", () => {
  it("omits hours below one hour", () => { expect(elapsed(0)).toBe("0:00"); expect(elapsed(59)).toBe("0:59"); expect(elapsed(2540)).toBe("42:20"); });
  it("pads minutes once hours are shown", () => { expect(elapsed(3600)).toBe("1:00:00"); expect(elapsed(36125)).toBe("10:02:05"); });
  it("drops fractional seconds", () => { expect(elapsed(61.9)).toBe("1:01"); });
  it("never renders negative or NaN clocks", () => {
    // Regression: elapsed(-5) gave "-1:-1:-5" and elapsed(NaN) gave "NaN:NaN".
    expect(elapsed(-5)).toBe("0:00");
    expect(elapsed(Number.NaN)).toBe("0:00");
    expect(elapsed(Infinity)).toBe("0:00");
  });
});

describe("polling the bridge", () => {
  afterEach(() => { vi.useRealTimers(); });
  it("parses a successful response", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ sport: "run", heartRate: 140 }), { status: 200 }));
    expect(await fetchTelemetry("http://b/live", { fetchImpl: fetchImpl as unknown as typeof fetch })).toMatchObject({ sport: "run", heartRate: 140 });
  });
  it("rejects HTTP errors", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 500 }));
    await expect(fetchTelemetry("http://b/live", { fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toThrow("HTTP 500");
  });
  it("times out instead of hanging forever", async () => {
    // Regression: without a timeout every 2 s poll against a stalled bridge stacked another pending request.
    vi.useFakeTimers();
    const fetchImpl = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const pending = fetchTelemetry("http://b/live", { timeoutMs: 500, fetchImpl: fetchImpl as unknown as typeof fetch });
    const assertion = expect(pending).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
  });
});
