import { describe, expect, it } from "vitest";
import { createClient } from "../src/api/client";
import { apptWeatherRow, briefBlocks, briefPages, weatherRows } from "../src/hub/brief";
import { briefPath, createLocator, LOCATE_TIMEOUT_MS, PLACE_TTL_MS, roundPlace } from "../src/hub/place";
import { demoBrief } from "../src/api/demo";
import { locationLine } from "../src/ui/phone";
import { MAX_BODY_ROWS } from "../src/glasses/screen";
import type { BriefWeather } from "../src/api/types";

describe("place rounding and query", () => {
  it("rounds to two decimals and rejects non-coordinates", () => {
    expect(roundPlace(47.80349, 13.04126)).toEqual({ lat: 47.8, lon: 13.04 });
    expect(roundPlace(-33.8688, 151.2093)).toEqual({ lat: -33.87, lon: 151.21 });
    for (const [a, b] of [[91, 0], [0, 181], [Number.NaN, 1], ["1", 2], [null, undefined], [0, 0]]) expect(roundPlace(a, b)).toBeNull();
  });

  it("builds /brief with lat/lon and keeps refresh=1", () => {
    expect(briefPath(false, null)).toBe("/brief");
    expect(briefPath(true, null)).toBe("/brief?refresh=1");
    expect(briefPath(false, { lat: 47.8, lon: 13.04 })).toBe("/brief?lat=47.80&lon=13.04");
    expect(briefPath(true, { lat: 47.8, lon: 13.04 })).toBe("/brief?refresh=1&lat=47.80&lon=13.04");
  });

  it("the client sends the rounded place as the query", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => { urls.push(url); return new Response(JSON.stringify({ at: 1 }), { status: 200 }); }) as unknown as typeof fetch;
    const api = createClient({ baseUrl: "http://hub.test:8080", token: "t", fetchImpl });
    await api.brief?.(false, { lat: 47.8, lon: 13.04 });
    await api.brief?.(true, null);
    await api.brief?.(true, { lat: 48.21, lon: 16.37 });
    expect(urls).toEqual(["http://hub.test:8080/brief?lat=47.80&lon=13.04", "http://hub.test:8080/brief?refresh=1", "http://hub.test:8080/brief?refresh=1&lat=48.21&lon=16.37"]);
  });
});

describe("locator", () => {
  it("rounds the fix, caches it for 30 minutes and asks again afterwards", async () => {
    let clock = 1_000;
    let asked = 0;
    const loc = createLocator({ now: () => clock, getLocation: async () => { asked += 1; return { latitude: 47.80349, longitude: 13.04126 }; } });
    expect(loc.state()).toBe("pending");
    expect(await loc.locate()).toEqual({ lat: 47.8, lon: 13.04 });
    expect(loc.state()).toBe("used");
    clock += PLACE_TTL_MS - 1;
    await loc.locate();
    expect(asked).toBe(1);
    clock += 2;
    await loc.locate();
    expect(asked).toBe(2);
  });

  it("falls back to no coordinates after the timeout and does not block", async () => {
    const loc = createLocator({ timeoutMs: 20, getLocation: () => new Promise(() => undefined) });
    const started = Date.now();
    expect(await loc.locate()).toBeNull();
    expect(Date.now() - started).toBeLessThan(500);
    expect(loc.state()).toBe("unavailable");
    expect(LOCATE_TIMEOUT_MS).toBeLessThanOrEqual(4_000);
  });

  it("a denied permission (null answer or error) gives no coordinates and the 'denied' state; a missing API 'unavailable'", async () => {
    const nullFix = createLocator({ getLocation: async () => null });
    expect(await nullFix.locate()).toBeNull();
    expect(nullFix.state()).toBe("denied");
    const thrown = createLocator({ getLocation: async () => { throw new Error("permission"); } });
    expect(await thrown.locate()).toBeNull();
    expect(thrown.state()).toBe("denied");
    const none = createLocator({});
    expect(await none.locate()).toBeNull();
    expect(none.state()).toBe("unavailable");
    const garbage = createLocator({ getLocation: async () => ({ latitude: 999, longitude: 1 }) });
    expect(await garbage.locate()).toBeNull();
  });

  it("shares one request while it is in flight", async () => {
    let asked = 0;
    const loc = createLocator({ getLocation: async () => { asked += 1; return { latitude: 1.234, longitude: 2.345 }; } });
    const [a, b] = await Promise.all([loc.locate(), loc.locate()]);
    expect(a).toEqual(b);
    expect(asked).toBe(1);
  });
});

describe("phone line about the location", () => {
  const c = { locUsed: "used", locDenied: "Standort nicht freigegeben – Wetter für den Standardort", locOff: "off", locWait: "wait" };
  it("says what happens", () => {
    expect(locationLine("denied", c)).toBe("Standort nicht freigegeben – Wetter für den Standardort");
    expect(locationLine("used", c)).toBe("used");
    expect(locationLine("unavailable", c)).toBe("off");
    expect(locationLine("pending", c)).toBe("wait");
  });
});

describe("weather rows: place and appointments", () => {
  const base: BriefWeather = { status: "ok", tempC: 9, code: 3, minC: 6, maxC: 15, rain: { kind: "none", from: "", until: "", mm: 0 } };
  it("names where the weather is for", () => {
    expect(weatherRows({ ...base, place: "here" }, "de")[0]).toMatch(/^Wetter hier · 9°/);
    expect(weatherRows({ ...base, place: "default" }, "de")[0]).toMatch(/^Wetter \(Standard\) · 9°/);
    expect(weatherRows({ ...base, place: "here" }, "en")[0]).toMatch(/^Weather here/);
    expect(weatherRows(base, "de")[0]).toMatch(/^Wetter · 9°/);
  });

  it("adds one row per appointment at its hour", () => {
    const appt = { time: "10:30", label: "Musterdorf", tempC: 9, pop: 60, mm: 0.8, windKmh: 12 };
    expect(apptWeatherRow(appt, "de")).toBe("  10:30 Musterdorf 9° · Regen 60%");
    expect(apptWeatherRow({ ...appt, pop: 10, mm: 0, windKmh: 41 }, "de")).toBe("  10:30 Musterdorf 9° · trocken · Wind 41 km/h");
    expect(apptWeatherRow({ ...appt, pop: null, mm: 1.2 }, "de")).toBe("  10:30 Musterdorf 9° · Regen 1.2 mm");
    expect(apptWeatherRow({ ...appt, time: "" }, "en")).toBe("  Musterdorf 9° · rain 60%");
    const rows = weatherRows({ ...base, place: "here", appts: [appt, { ...appt, time: "15:00", label: "Linz" }] }, "de");
    expect(rows).toHaveLength(3);
    expect(rows[2]).toContain("15:00 Linz");
  });

  it("works with appointments only, or when the current place failed", () => {
    const appt = { time: "10:30", label: "Musterdorf", tempC: 9, pop: 60, mm: 0.8, windKmh: 12 };
    expect(weatherRows({ status: "ok", appts: [appt] }, "de")).toEqual(["Wetter", "  10:30 Musterdorf 9° · Regen 60%"]);
    expect(weatherRows({ status: "ok", hereFailed: true, appts: [appt] }, "de")[0]).toBe("Wetter · nicht erreichbar");
  });

  it("keeps rows within 56 characters and pages within 7 rows", () => {
    const long = { time: "10:30", label: "Sankt Johann im Pongau am Wallersee", tempC: -12, pop: 100, mm: 12.5, windKmh: 118 };
    for (const locale of ["de", "en"] as const) {
      for (const row of weatherRows({ ...demoBrief(locale, 0).weather, appts: [long, long, long] }, locale)) expect([...row].length).toBeLessThanOrEqual(56);
      const pages = briefPages(briefBlocks({ ...demoBrief(locale, 0), weather: { ...demoBrief(locale, 0).weather, appts: [long, long, long] } }, "ready", locale, 0));
      for (const page of pages) expect(page.length).toBeLessThanOrEqual(MAX_BODY_ROWS);
    }
  });
});
