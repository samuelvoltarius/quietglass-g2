import { describe, expect, it } from "vitest";
import { fetchWarnings, inAustria, parseWarnings, topWarning, warningsUrl, type Warning } from "../src/cockpit/warnings";

const NOW = Date.UTC(2026, 9, 13, 12, 0);
const s = (ms: number): number => Math.round(ms / 1000);

/** Shaped like GeoSphere's answer (getWarningsForCoords), with the polygon left out. */
const answer = (warnings: unknown[]) => ({
  type: "Feature", geometry: { type: "MultiPolygon", coordinates: [] },
  properties: { location: { type: "Municipal", properties: { gemeindenr: 50101, name: "Salzburg", urlname: "salzburg" } }, warnings },
});
const warning = (type: number, level: number, startMs: number, endMs: number) => ({
  type: "Feature",
  properties: { warnid: 1, warntypid: type, warnstufeid: level, begin: "13.10.2026 14:00", end: "13.10.2026 22:00", text: "…", rawinfo: { wtype: type, wlevel: level, start: String(s(startMs)), end: String(s(endMs)) } },
});

describe("GeoSphere warnings", () => {
  it("reads type, level and times, and the municipality", () => {
    const result = parseWarnings(answer([warning(1, 2, NOW, NOW + 3_600_000), warning(5, 1, NOW, NOW + 7_200_000)]));
    expect(result.status).toBe("ok");
    expect(result.place).toBe("Salzburg");
    expect(result.warnings).toEqual([{ type: "wind", level: 2, start: NOW, end: NOW + 3_600_000 }, { type: "thunder", level: 1, start: NOW, end: NOW + 7_200_000 }]);
  });
  it("falls back to warntypid / warnstufeid without rawinfo and skips junk", () => {
    const result = parseWarnings(answer([{ properties: { warntypid: 3, warnstufeid: 3 } }, { properties: { warntypid: 9, warnstufeid: 1 } }, { properties: { warntypid: 2, warnstufeid: 7 } }, null, 5]));
    expect(result.warnings).toEqual([{ type: "snow", level: 3, start: Number.NaN, end: Number.NaN }]);
  });
  it("knows an empty list and the error answer outside Austria", () => {
    expect(parseWarnings(answer([]))).toEqual({ status: "ok", warnings: [], place: "Salzburg" });
    expect(parseWarnings({ type: "Error", msg: "Could not find municipal for coords." }).status).toBe("outside");
    expect(parseWarnings(null).status).toBe("outside");
  });
  it("shows the highest level in force or starting within a day", () => {
    const list: Warning[] = [
      { type: "rain", level: 1, start: NOW - 3_600_000, end: NOW + 3_600_000 },
      { type: "wind", level: 2, start: NOW + 5 * 3_600_000, end: NOW + 9 * 3_600_000 },
      { type: "heat", level: 3, start: NOW - 9 * 3_600_000, end: NOW - 3_600_000 },
      { type: "snow", level: 3, start: NOW + 30 * 3_600_000, end: NOW + 40 * 3_600_000 },
    ];
    expect(topWarning(list, NOW)?.type).toBe("wind");
    expect(topWarning(list.slice(0, 1), NOW)?.type).toBe("rain");
    expect(topWarning([], NOW)).toBeNull();
    // Unknown times count as in force.
    expect(topWarning([{ type: "ice", level: 1, start: Number.NaN, end: Number.NaN }], NOW)?.type).toBe("ice");
  });
  it("asks only for places in Austria, in German or English", async () => {
    expect(inAustria(47.8, 13.05)).toBe(true);
    expect(inAustria(48.14, 11.57 - 3)).toBe(false);
    expect(warningsUrl(47.8, 13.05, "de")).toBe("https://warnungen.zamg.at/wsapp/api/getWarningsForCoords?lon=13.0500&lat=47.8000&lang=de");
    expect(warningsUrl(47.8, 13.05, "fr")).toContain("lang=en");
    let calls = 0;
    const fetchImpl = (async () => { calls += 1; return new Response("{}"); }) as typeof fetch;
    expect((await fetchWarnings(52.5, 13.4, "de", fetchImpl)).status).toBe("outside");
    expect(calls).toBe(0);
  });
  it("treats 404 as outside and other errors as failures", async () => {
    const notFound = (async () => new Response(JSON.stringify({ type: "Error" }), { status: 404 })) as typeof fetch;
    expect((await fetchWarnings(47.8, 13.05, "de", notFound)).status).toBe("outside");
    const broken = (async () => new Response("nope", { status: 503 })) as typeof fetch;
    await expect(fetchWarnings(47.8, 13.05, "de", broken)).rejects.toThrow("HTTP 503");
    const good = (async () => new Response(JSON.stringify(answer([warning(1, 1, NOW, NOW + 1000)])))) as typeof fetch;
    expect((await fetchWarnings(47.8, 13.05, "de", good)).warnings).toHaveLength(1);
  });
});
