import { afterEach, describe, expect, it } from "vitest";
import { startHub, TOKEN } from "./helpers.mjs";
import {
  createBrief, createGeocoder, dayBounds, distanceKm, eventsForDay, geocodeCandidates, hourForecast, mergeEvents, parsePlace, parseShootDate, shootEventsForDay, nightStats, nightWindow, parseBriefConfig, parseIcs, parseIcsDate, rainOutlook,
  readingsFrom, shapeCar, shapeKlipper, shapeMoonraker, shapeStatus, shapeSugar, shapeWeather, weatherQuery, zonedToEpoch,
} from "../examples/quiet-hub-brief.mjs";

const ZONE = "Europe/Vienna";
/** Wednesday 14 Oct 2026, 07:00 in Vienna (CEST = UTC+2). */
const NOW = Date.UTC(2026, 9, 14, 5, 0, 0);
const vienna = (h, m = 0, day = 14, month = 10) => zonedToEpoch(2026, month, day, h, m, 0, ZONE);

const ics = (...events) => ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//EN", ...events.flatMap((e) => ["BEGIN:VEVENT", ...e, "END:VEVENT"]), "END:VCALENDAR"].join("\r\n");
const today = (text) => eventsForDay(parseIcs(text, ZONE), NOW, ZONE);
const titles = (text) => today(text).map((e) => e.title);

describe("ICS parsing", () => {
  it("reads timed, all-day, UTC and floating events with folded lines and escapes", () => {
    const text = ics(
      ["UID:a", "SUMMARY:Zahnarzt\\, Kontrolle", "DTSTART;TZID=Europe/Vienna:20261014T113000", "DTEND;TZID=Europe/Vienna:20261014T121500"],
      ["UID:b", "SUMMARY:Geburtstag", "DTSTART;VALUE=DATE:20261014", "DTEND;VALUE=DATE:20261015"],
      ["UID:c", "SUMMARY:Call mit", "  Team USA", "DTSTART:20261014T150000Z", "DTEND:20261014T160000Z"],
      ["UID:d", "SUMMARY:Floating", "DTSTART:20261014T090000", "DURATION:PT30M"],
      ["UID:e", "SUMMARY:Morgen", "DTSTART;TZID=Europe/Vienna:20261015T090000", "DTEND;TZID=Europe/Vienna:20261015T100000"],
      ["UID:f", "SUMMARY:Abgesagt", "STATUS:CANCELLED", "DTSTART;TZID=Europe/Vienna:20261014T100000"],
    );
    const events = today(text);
    expect(events.map((e) => e.title)).toEqual(["Geburtstag", "Floating", "Zahnarzt, Kontrolle", "Call mit Team USA"]);
    expect(events[0]).toMatchObject({ allDay: true, start: "", end: "" });
    expect(events[1]).toMatchObject({ start: "09:00", end: "09:30" });
    expect(events[2]).toMatchObject({ start: "11:30", end: "12:15", startMs: vienna(11, 30) });
    // 15:00 UTC = 17:00 in Vienna.
    expect(events[3]).toMatchObject({ start: "17:00", end: "18:00" });
  });

  it("maps Windows zone names and ignores alarms inside an event", () => {
    const text = ics(["UID:w", "SUMMARY:Outlook", "DTSTART;TZID=\"W. Europe Standard Time\":20261014T080000", "DTEND;TZID=\"W. Europe Standard Time\":20261014T083000",
      "BEGIN:VALARM", "TRIGGER:-PT15M", "SUMMARY:Alarm text", "END:VALARM"]);
    expect(today(text)).toMatchObject([{ title: "Outlook", start: "08:00", end: "08:30" }]);
  });

  it("shows a multi-day all-day event on every day it covers, and an event running over midnight", () => {
    const text = ics(
      ["UID:u", "SUMMARY:Urlaub", "DTSTART;VALUE=DATE:20261012", "DTEND;VALUE=DATE:20261017"],
      ["UID:n", "SUMMARY:Nachtschicht", "DTSTART;TZID=Europe/Vienna:20261013T220000", "DTEND;TZID=Europe/Vienna:20261014T060000"],
      ["UID:o", "SUMMARY:Vorbei", "DTSTART;VALUE=DATE:20261010", "DTEND;VALUE=DATE:20261014"],
    );
    const events = today(text);
    expect(events.map((e) => e.title)).toEqual(["Urlaub", "Nachtschicht"]);
    expect(events[1]).toMatchObject({ start: "", end: "06:00" });
  });

  it("parses date values", () => {
    expect(parseIcsDate("20261014", {})).toEqual({ allDay: true, y: 2026, m: 10, d: 14 });
    expect(parseIcsDate("20261014T120000Z", {})).toMatchObject({ zone: "UTC", h: 12 });
    expect(parseIcsDate("garbage", {})).toBeNull();
  });
});

describe("RRULE (simple cases)", () => {
  const base = (rule, start = "20260901T073000", extra = []) => ics(["UID:r", "SUMMARY:Serie", `DTSTART;TZID=Europe/Vienna:${start}`, "DURATION:PT30M", `RRULE:${rule}`, ...extra]);

  it("daily, with interval, count and until", () => {
    expect(today(base("FREQ=DAILY"))).toMatchObject([{ title: "Serie", start: "07:30", end: "08:00" }]);
    // Sep 1 + 2n days: Oct 14 is day 43 -> odd -> not an occurrence.
    expect(titles(base("FREQ=DAILY;INTERVAL=2"))).toEqual([]);
    expect(titles(base("FREQ=DAILY;INTERVAL=2", "20260902T073000"))).toEqual(["Serie"]);
    expect(titles(base("FREQ=DAILY;COUNT=10"))).toEqual([]);
    expect(titles(base("FREQ=DAILY;COUNT=44"))).toEqual(["Serie"]);
    expect(titles(base("FREQ=DAILY;UNTIL=20261013T215959Z"))).toEqual([]);
    expect(titles(base("FREQ=DAILY;UNTIL=20261014T055959Z"))).toEqual(["Serie"]);
  });

  it("keeps the wall-clock time across the DST change", () => {
    // Started in winter (CET): still 07:30 local in October (CEST).
    expect(today(base("FREQ=DAILY", "20260115T073000"))).toMatchObject([{ start: "07:30" }]);
  });

  it("weekly, by weekday and every other week", () => {
    expect(titles(base("FREQ=WEEKLY"))).toEqual([]); // Sep 1 2026 is a Tuesday, Oct 14 a Wednesday
    expect(titles(base("FREQ=WEEKLY;BYDAY=MO,WE,FR"))).toEqual(["Serie"]);
    expect(titles(base("FREQ=WEEKLY", "20260902T073000"))).toEqual(["Serie"]);
    // Sep 2 -> Oct 14 is six weeks: every 2nd week yes, every 4th week no.
    expect(titles(base("FREQ=WEEKLY;INTERVAL=2", "20260902T073000"))).toEqual(["Serie"]);
    expect(titles(base("FREQ=WEEKLY;INTERVAL=4", "20260902T073000"))).toEqual([]);
    expect(titles(base("FREQ=WEEKLY;BYDAY=WE;COUNT=7"))).toEqual(["Serie"]); // Sep 2, 9, 16, 23, 30, Oct 7, Oct 14
    expect(titles(base("FREQ=WEEKLY;BYDAY=WE;COUNT=6"))).toEqual([]);
  });

  it("daily with BYDAY (workdays), monthly and yearly by date", () => {
    expect(titles(base("FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR"))).toEqual(["Serie"]);
    expect(titles(base("FREQ=DAILY;BYDAY=SA,SU"))).toEqual([]);
    expect(titles(ics(["UID:m", "SUMMARY:Miete", "DTSTART;VALUE=DATE:20260114", "RRULE:FREQ=MONTHLY"]))).toEqual(["Miete"]);
    expect(titles(ics(["UID:y", "SUMMARY:Jahrestag", "DTSTART;VALUE=DATE:20101014", "RRULE:FREQ=YEARLY"]))).toEqual(["Jahrestag"]);
  });

  it("drops EXDATE occurrences and replaces a moved instance (RECURRENCE-ID)", () => {
    expect(titles(base("FREQ=DAILY", "20260901T073000", ["EXDATE;TZID=Europe/Vienna:20261014T073000"]))).toEqual([]);
    const moved = ics(
      ["UID:s", "SUMMARY:Jour fixe", "DTSTART;TZID=Europe/Vienna:20260902T100000", "DURATION:PT1H", "RRULE:FREQ=WEEKLY"],
      ["UID:s", "SUMMARY:Jour fixe (verschoben)", "RECURRENCE-ID;TZID=Europe/Vienna:20261014T100000", "DTSTART;TZID=Europe/Vienna:20261014T140000", "DURATION:PT1H"],
    );
    expect(today(moved)).toMatchObject([{ title: "Jour fixe (verschoben)", start: "14:00", end: "15:00" }]);
  });

  it("falls back to the first occurrence for rules beyond the simple cases", () => {
    expect(titles(base("FREQ=MONTHLY;BYDAY=2WE"))).toEqual([]);
    expect(titles(base("FREQ=MONTHLY;BYDAY=2WE", "20261014T073000"))).toEqual(["Serie"]);
  });
});

describe("rain nowcast", () => {
  const sec = (ms) => Math.floor(ms / 1000);
  /** 15-minute slots from 07:00 for six hours, hourly after that, rain where `wet(endMs)` says so. */
  const weather = (wet15, wetHour = () => false) => {
    const m = []; const mv = [];
    for (let t = vienna(7, 15); t <= vienna(13, 0); t += 15 * 60_000) { m.push(sec(t)); mv.push(wet15(t) ? 0.4 : 0); }
    const h = []; const hv = [];
    for (let t = vienna(1); t <= vienna(23, 0, 15); t += 3_600_000) { h.push(sec(t)); hv.push(wetHour(t) ? 1.2 : 0); }
    return { minutely_15: { time: m, precipitation: mv }, hourly: { time: h, precipitation: hv } };
  };

  it("finds the first rain ahead from the 15-minute values", () => {
    const out = rainOutlook(weather((t) => t > vienna(14) || (t > vienna(9, 30) && t <= vienna(10, 15))), NOW, ZONE);
    expect(out).toMatchObject({ kind: "later", from: "09:30", until: "10:15" });
  });

  it("says it rains now, and until when", () => {
    const out = rainOutlook(weather((t) => t <= vienna(8, 30)), NOW, ZONE);
    expect(out).toMatchObject({ kind: "now", from: "", until: "08:30" });
  });

  it("uses hourly values after the 15-minute ones end (preceding-hour sums)", () => {
    // Hourly value at 15:00 = rain 14:00-15:00.
    const out = rainOutlook(weather(() => false, (t) => t === vienna(15) || t === vienna(16)), NOW, ZONE);
    expect(out).toMatchObject({ kind: "later", from: "14:00", until: "16:00" });
  });

  it("is dry when nothing reaches the threshold, unknown without data", () => {
    expect(rainOutlook(weather(() => false), NOW, ZONE).kind).toBe("none");
    expect(rainOutlook({}, NOW, ZONE).kind).toBe("unknown");
  });

  it("shapes the whole weather block", () => {
    const data = { ...weather(() => false), current: { temperature_2m: 8.6, weather_code: 61 }, daily: { temperature_2m_max: [15.4], temperature_2m_min: [5.5] } };
    expect(shapeWeather(data, NOW, ZONE)).toMatchObject({ status: "ok", tempC: 9, code: 61, maxC: 15, minC: 6, rain: { kind: "none" } });
    expect(weatherQuery({ lat: 47.8, lon: 13.04, zone: ZONE, weatherUrl: "https://weather.test/v1/forecast" })).toContain("minutely_15=precipitation");
  });
});

describe("glucose night", () => {
  /** Readings every 5 min from 21:30 the evening before until 07:00. */
  const series = (valueAt) => {
    const out = [];
    for (let t = vienna(21, 30, 13); t <= NOW; t += 5 * 60_000) out.push({ date: t, sgv: valueAt(t), direction: "Flat", type: "sgv" });
    return out.reverse(); // Nightscout answers newest first
  };

  it("window is 22:00 to 07:00 (or now when earlier)", () => {
    expect(nightWindow(NOW, ZONE)).toEqual({ start: vienna(22, 0, 13), end: vienna(7) });
    expect(nightWindow(vienna(3), ZONE)).toEqual({ start: vienna(22, 0, 13), end: vienna(3) });
  });

  it("counts min/max and minutes below 70 / above 180", () => {
    const low = (t) => t >= vienna(2) && t < vienna(2, 30);
    const high = (t) => t >= vienna(23, 0, 13) && t < vienna(0, 20);
    const sugar = shapeSugar(series((t) => (low(t) ? 62 : high(t) ? 205 : t < vienna(22, 0, 13) ? 300 : 110)), NOW, ZONE);
    expect(sugar.night).toMatchObject({ min: 62, max: 205, belowMin: 30, aboveMin: 80 });
    // The 300 before 22:00 does not count.
    expect(sugar.night.max).toBe(205);
    expect(sugar.current).toMatchObject({ mgdl: 110, direction: "Flat", ageMin: 0 });
  });

  it("does not count a sensor gap as low", () => {
    const readings = [{ at: vienna(1), mgdl: 60 }, { at: vienna(4), mgdl: 100 }];
    expect(nightStats(readings, vienna(22, 0, 13), vienna(7)).belowMin).toBe(15);
  });

  it("no readings: no night, no current value", () => {
    expect(shapeSugar([], NOW, ZONE)).toMatchObject({ status: "ok", current: null, night: null });
    expect(readingsFrom([{ sgv: 5, date: NOW }, { sgv: 100, date: NOW, type: "mbg" }, null, "x"])).toEqual([]);
  });
});

describe("car, printer, servers", () => {
  it("car from the BYD bridge /state", () => {
    expect(shapeCar({ mode: "charging", battery: { soc: 64, range_km: 240 }, charge: { active: true, eta_min: 55 }, body: { locked: true } }))
      .toMatchObject({ soc: 64, rangeKm: 240, charging: true, etaMin: 55, locked: true });
    expect(shapeCar({ battery: { soc: null }, charge: { active: false }, body: {} })).toMatchObject({ soc: null, charging: false, locked: null });
  });

  it("printer from the Klipper bridge or Moonraker", () => {
    expect(shapeKlipper({ online: true, state: "printing", file: "jobs/benchy.gcode", progress: 42, minutesLeft: 35 }))
      .toMatchObject({ state: "printing", file: "benchy", progress: 42, minutesLeft: 35 });
    expect(shapeMoonraker({ job: "box.gcode", state: "paused", progress: 10, etaMin: 90 })).toMatchObject({ state: "paused", file: "box", minutesLeft: 90 });
    expect(shapeMoonraker({ offline: true })).toMatchObject({ status: "error" });
  });

  it("status servers: new devices and warnings", () => {
    expect(shapeStatus({ name: "pi", metrics: [{ id: "cpu", level: "ok" }, { id: "disk", level: "warn" }], network: { new: 2 } })).toEqual({ ok: true, newDevices: 2, warn: 1 });
    expect(shapeStatus({})).toEqual({ ok: true, newDevices: null, warn: 0 });
  });
});

describe("config", () => {
  it("parses every source, rejects nonsense", () => {
    const cfg = parseBriefConfig({
      BRIEF_ICS_URLS: "webcal://cal.test/a.ics, https://cal.test/b.ics", BRIEF_LAT: "47.8", BRIEF_LON: "200", BRIEF_TZ: "Mars/Base",
      BRIEF_STATUS_URLS: "Pi|https://pi.test/status,https://nas.test/status,bad|ftp://x", BRIEF_CACHE_MS: "5",
    });
    expect(cfg.icsUrls).toEqual(["https://cal.test/a.ics", "https://cal.test/b.ics"]);
    expect(cfg.lat).toBe(47.8);
    expect(cfg.lon).toBeNull();
    expect(cfg.zone).not.toBe("Mars/Base");
    expect(cfg.statusUrls).toEqual([{ name: "Pi", url: "https://pi.test/status" }, { name: "#2", url: "https://nas.test/status" }]);
    expect(cfg.cacheMs).toBe(10_000);
    expect(parseBriefConfig({ BRIEF: "off" }).enabled).toBe(false);
    expect(dayBounds(NOW, ZONE)).toMatchObject({ date: "2026-10-14", start: vienna(0) });
  });
});

// ---- the whole brief against fake sources (never the real services) -----------------

const CAL = ics(["UID:a", "SUMMARY:Zahnarzt", "DTSTART;TZID=Europe/Vienna:20261014T113000", "DTEND;TZID=Europe/Vienna:20261014T121500"]);
const ENV = {
  BRIEF_ICS_URLS: "https://cal.test/a.ics", BRIEF_LAT: "47.8", BRIEF_LON: "13.04", BRIEF_TZ: ZONE, BRIEF_WEATHER_URL: "https://weather.test/v1/forecast",
  BRIEF_BYD_URL: "https://car.test", BRIEF_BYD_TOKEN: "car-secret", BRIEF_SUGAR_URL: "https://sugar.test", BRIEF_KLIPPER_URL: "https://printer.test",
  BRIEF_STATUS_URLS: "Pi|https://pi.test/status,NAS|https://nas.test/status", BRIEF_TIMEOUT_MS: "1000",
};

function fakeSources(overrides = {}) {
  const calls = [];
  const text = (body, status = 200) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  const routes = {
    "cal.test": () => text(CAL),
    "weather.test": () => text({ current: { temperature_2m: 9, weather_code: 3 }, daily: { temperature_2m_max: [15], temperature_2m_min: [6] }, minutely_15: { time: [Math.floor(vienna(14, 15) / 1000)], precipitation: [0.5] } }),
    "car.test": (init) => (init.headers.Authorization === "Bearer car-secret" ? text({ battery: { soc: 78, range_km: 296 }, charge: { active: false }, body: { locked: false } }) : text({ error: "401" }, 401)),
    "sugar.test": () => text([{ type: "sgv", sgv: 118, date: NOW - 3 * 60_000, direction: "SingleUp" }, { type: "sgv", sgv: 65, date: vienna(3), direction: "Flat" }]),
    "printer.test": () => text({ online: true, state: "printing", file: "benchy.gcode", progress: 42, minutesLeft: 35 }),
    "pi.test": () => text({ name: "pi", metrics: [], network: { new: 1 } }),
    "nas.test": () => text({ error: "down" }, 503),
    ...overrides,
  };
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    calls.push(`${u.host}${u.pathname}${u.search}`);
    const route = routes[u.host];
    if (!route) throw new Error(`unexpected host ${u.host}`);
    return route(init, u);
  };
  return { fetchImpl, calls };
}

describe("createBrief", () => {
  it("collects every block in one answer", async () => {
    const { fetchImpl, calls } = fakeSources();
    const brief = await createBrief({ config: parseBriefConfig(ENV), fetchImpl, now: () => NOW }).get();
    expect(brief.date).toBe("2026-10-14");
    expect(brief.calendar).toMatchObject({ status: "ok", total: 1, events: [{ title: "Zahnarzt", start: "11:30" }] });
    expect(brief.weather).toMatchObject({ status: "ok", tempC: 9, rain: { kind: "later", from: "14:00" } });
    expect(brief.car).toMatchObject({ status: "ok", soc: 78, locked: false });
    expect(brief.sugar).toMatchObject({ status: "ok", current: { mgdl: 118, direction: "SingleUp", ageMin: 3 }, night: { min: 65, belowMin: 15 } });
    expect(brief.printer).toMatchObject({ status: "ok", state: "printing", file: "benchy" });
    expect(brief.servers).toMatchObject({ status: "ok", down: 1, newDevices: 1, machines: [{ name: "Pi", ok: true }, { name: "NAS", ok: false }] });
    expect(calls.some((c) => c.startsWith("sugar.test/api/v1/entries/sgv.json?count=400&find%5Bdate%5D%5B%24gte%5D="))).toBe(true);
    expect(calls).toContain("car.test/state");
    expect(calls).toContain("printer.test/api/printer");
    // No source URL or token in the answer.
    expect(JSON.stringify(brief)).not.toMatch(/car-secret|car\.test|cal\.test|sugar\.test/);
  });

  it("unconfigured blocks are off; the printer falls back to the daemon's Moonraker", async () => {
    const brief = await createBrief({ config: parseBriefConfig({}), fetchImpl: async () => { throw new Error("no fetch expected"); }, now: () => NOW,
      moon: { printer: () => ({ job: "box.gcode", state: "printing", progress: 5, etaMin: 120 }) } }).get();
    expect(brief.calendar.status).toBe("off");
    expect(brief.weather.status).toBe("off");
    expect(brief.car.status).toBe("off");
    expect(brief.sugar.status).toBe("off");
    expect(brief.servers.status).toBe("off");
    expect(brief.printer).toMatchObject({ status: "ok", file: "box" });
  });

  it("a failing or hanging source only breaks its own block", async () => {
    const { fetchImpl } = fakeSources({
      "car.test": () => new Response("nope", { status: 500 }),
      "weather.test": () => new Promise(() => {}), // never answers
      "sugar.test": () => new Response("not json", { status: 200 }),
    });
    const started = Date.now();
    const brief = await createBrief({ config: parseBriefConfig(ENV), fetchImpl, now: () => NOW }).get();
    expect(Date.now() - started).toBeLessThan(3000);
    expect(brief.car).toMatchObject({ status: "error", error: "HTTP 500" });
    expect(brief.weather).toMatchObject({ status: "error", error: "timeout" });
    expect(brief.sugar.status).toBe("error");
    expect(brief.calendar.status).toBe("ok");
    expect(brief.printer.status).toBe("ok");
  });

  it("an unreachable calendar is an error, one of two failing is not", async () => {
    const one = fakeSources({ "cal.test": () => new Response("x", { status: 404 }) });
    expect((await createBrief({ config: parseBriefConfig(ENV), fetchImpl: one.fetchImpl, now: () => NOW }).get()).calendar.status).toBe("error");
    const two = fakeSources({ "cal2.test": () => { throw new Error("dns"); } });
    const cfg = parseBriefConfig({ ...ENV, BRIEF_ICS_URLS: "https://cal.test/a.ics,https://cal2.test/b.ics" });
    expect((await createBrief({ config: cfg, fetchImpl: two.fetchImpl, now: () => NOW }).get()).calendar).toMatchObject({ status: "ok", failed: 1, total: 1 });
  });

  it("caches ~2 min, refresh forces, and keeps last good values marked stale", async () => {
    let clock = NOW;
    let carUp = true;
    const { fetchImpl, calls } = fakeSources({
      "car.test": () => (carUp ? new Response(JSON.stringify({ battery: { soc: 50 } })) : new Response("x", { status: 502 })),
    });
    const brief = createBrief({ config: parseBriefConfig(ENV), fetchImpl, now: () => clock });
    await brief.get();
    const first = calls.length;
    await brief.get();
    expect(calls.length).toBe(first); // cached
    clock += 60_000;
    await brief.get();
    expect(calls.length).toBe(first);
    carUp = false;
    const forced = await brief.get(true);
    expect(calls.length).toBeGreaterThan(first);
    expect(forced.car).toMatchObject({ status: "ok", soc: 50, stale: true, error: "HTTP 502" });
    clock += 31 * 60_000;
    expect((await brief.get()).car).toMatchObject({ status: "error" });
  });

  it("peek returns the cache and refreshes in the background only while the page is in use", async () => {
    let clock = NOW;
    const { fetchImpl, calls } = fakeSources();
    const brief = createBrief({ config: parseBriefConfig(ENV), fetchImpl, now: () => clock });
    expect(brief.peek()).toBeNull();
    expect(calls.length).toBe(0);
    await brief.get();
    const after = calls.length;
    clock += 3 * 60_000;
    expect(brief.peek()?.at).toBe(NOW);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls.length).toBeGreaterThan(after);
    const later = calls.length;
    clock += 60 * 60_000;
    brief.peek();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls.length).toBe(later);
  });
});

describe("daemon GET /brief", () => {
  let hub;
  afterEach(async () => { await hub?.close(); hub = undefined; });

  it("answers with auth, stays in /report and refuses without a token", async () => {
    const { fetchImpl } = fakeSources();
    hub = await startHub({ briefEnv: ENV, briefFetch: fetchImpl, now: () => NOW });
    const unauthorized = await fetch(`${hub.url}/brief`);
    expect(unauthorized.status).toBe(401);
    const before = await hub.api("/report");
    expect(before.json.brief).toBeNull();
    const res = await hub.api("/brief");
    expect(res.status).toBe(200);
    expect(res.json.calendar.events[0].title).toBe("Zahnarzt");
    const refreshed = await hub.api("/brief?refresh=1");
    expect(refreshed.status).toBe(200);
    const report = await hub.api("/report");
    expect(report.json.brief.calendar.status).toBe("ok");
    expect(JSON.stringify(report.json)).not.toContain("car-secret");
    expect(TOKEN).toBeTruthy();
  });

  it("BRIEF=off: 404 and no brief in the report", async () => {
    hub = await startHub({ briefEnv: { BRIEF: "off" } });
    expect((await hub.api("/brief")).status).toBe(404);
    expect((await hub.api("/report")).json.brief).toBeUndefined();
  });

  it("no sources configured: the calendar says so, nothing is fetched", async () => {
    hub = await startHub({ briefFetch: async () => { throw new Error("must not fetch"); } });
    const res = await hub.api("/brief");
    expect(res.json.calendar.status).toBe("off");
    expect(res.json.weather.status).toBe("off");
  });
});

// ---- weather follows the wearer and the places of today's appointments ------------------

/** Open-Meteo-like answer whose hourly temperature is `base + hour` for 14 Oct (Vienna) and 15 Oct. */
const wxFor = (base, { pop = 10, mm = 0, wind = 5 } = {}) => {
  const times = Array.from({ length: 48 }, (_, i) => Math.floor(vienna(0) / 1000) + i * 3600);
  return {
    current: { temperature_2m: base, weather_code: 3 }, daily: { temperature_2m_max: [base + 5], temperature_2m_min: [base - 3] },
    hourly: { time: times, temperature_2m: times.map((_, i) => base + i), weather_code: times.map(() => 61), precipitation: times.map(() => mm), precipitation_probability: times.map(() => pop), wind_speed_10m: times.map(() => wind) },
  };
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const weatherCalls = (calls) => calls.filter((c) => c.startsWith("weather.test")).map((c) => Number(new URLSearchParams(c.split("?")[1]).get("latitude")).toFixed(2));

describe("parsePlace", () => {
  it("accepts numbers in range and rounds to 2 decimals", () => {
    expect(parsePlace("47.8034", "13.0412")).toEqual({ lat: 47.8, lon: 13.04 });
    expect(parsePlace("-33.8688", "151.2093")).toEqual({ lat: -33.87, lon: 151.21 });
    expect(parsePlace(null, null)).toBeNull();
    expect(parsePlace("", " ")).toBeNull();
  });
  it("rejects nonsense, out of range and a lone coordinate", () => {
    for (const [a, b] of [["abc", "13"], ["91", "13"], ["47", "181"], ["47", ""], [null, "13"], ["NaN", "1"], ["Infinity", "1"]]) expect(parsePlace(a, b)).toBe("invalid");
  });
});

describe("weather for the wearer's place", () => {
  const BASE = { ...ENV };
  let hub;
  afterEach(async () => { await hub?.close(); hub = undefined; });
  const sources = () => fakeSources({ "weather.test": (init, u) => json(wxFor(Number(u.searchParams.get("latitude")) > 48 ? 20 : 9)) });

  it("uses the sent place, else BRIEF_LAT/LON, else off - and says which", async () => {
    const { fetchImpl, calls } = sources();
    const brief = createBrief({ config: parseBriefConfig(BASE), fetchImpl, now: () => NOW });
    const here = await brief.get(false, { lat: 48.2082, lon: 16.3738 });
    expect(here.weather).toMatchObject({ status: "ok", place: "here", tempC: 20 });
    expect(weatherCalls(calls)).toEqual(["48.21"]);
    const dflt = await brief.get(false, null);
    expect(dflt.weather).toMatchObject({ place: "default", tempC: 9 });
    expect(weatherCalls(calls)).toEqual(["48.21", "47.80"]);
    const none = createBrief({ config: parseBriefConfig({ ...BASE, BRIEF_LAT: "", BRIEF_LON: "" }), fetchImpl, now: () => NOW });
    expect((await none.get()).weather.status).toBe("off");
    expect((await none.get(true, { lat: 1.5, lon: 2.5 })).weather).toMatchObject({ status: "ok", place: "here" });
  });

  it("caches per rounded place: same place once, another place separately, back again from cache", async () => {
    let clock = NOW;
    const { fetchImpl, calls } = sources();
    const brief = createBrief({ config: parseBriefConfig(BASE), fetchImpl, now: () => clock });
    const a = { lat: 48.2, lon: 16.37 };
    const b = { lat: 47.1, lon: 15.4 };
    await brief.get(false, a);
    await brief.get(false, { lat: 48.2004, lon: 16.3704 }); // rounds to a: whole brief cached
    expect(weatherCalls(calls)).toEqual(["48.20"]);
    clock += 30_000;
    await brief.get(false, b);
    expect(weatherCalls(calls)).toEqual(["48.20", "47.10"]);
    clock += 30_000;
    await brief.get(false, a); // brief for a is rebuilt, but a's forecast is still fresh
    expect(weatherCalls(calls)).toEqual(["48.20", "47.10"]);
    clock += 3 * 60_000;
    await brief.get(false, a);
    expect(weatherCalls(calls)).toEqual(["48.20", "47.10", "48.20"]);
  });

  it("GET /brief validates lat/lon, keeps refresh=1, and never logs coordinates", async () => {
    const { fetchImpl, calls } = sources();
    const lines = [];
    hub = await startHub({ briefEnv: BASE, briefFetch: fetchImpl, now: () => NOW, accessLog: (line) => lines.push(line) });
    const ok = await hub.api("/brief?lat=48.2082&lon=16.3738");
    expect(ok.status).toBe(200);
    expect(ok.json.weather).toMatchObject({ place: "here", tempC: 20 });
    const forced = await hub.api("/brief?refresh=1&lat=48.2082&lon=16.3738");
    expect(forced.status).toBe(200);
    expect(weatherCalls(calls)).toEqual(["48.21", "48.21"]);
    expect((await hub.api("/brief?lat=48.2")).status).toBe(400);
    expect((await hub.api("/brief?lat=x&lon=1")).status).toBe(400);
    expect((await hub.api("/brief?lat=95&lon=1")).status).toBe(400);
    expect((await hub.api("/brief")).json.weather.place).toBe("default");
    expect(lines.length).toBeGreaterThan(3);
    expect(lines.join("\n")).toContain("GET /brief");
    expect(lines.join("\n")).not.toMatch(/48\.2|16\.37|lat=|lon=/);
  });
});

describe("Shoot Day source", () => {
  it("reads the three date formats", () => {
    expect(parseShootDate("2026-10-14 10:30")).toEqual({ y: 2026, m: 10, d: 14, h: 10, mi: 30 });
    expect(parseShootDate("2026-10-14T09:05")).toMatchObject({ h: 9, mi: 5 });
    expect(parseShootDate("2026-10-14")).toEqual({ y: 2026, m: 10, d: 14, h: null, mi: null });
    expect(parseShootDate("14.10.2026 10:30")).toEqual({ y: 2026, m: 10, d: 14, h: 10, mi: 30 });
    expect(parseShootDate("14.10.2026")).toMatchObject({ d: 14, h: null });
    for (const bad of ["", "morgen", "2026-13-01", "2026-10-14 25:00", null]) expect(parseShootDate(bad)).toBeNull();
  });

  const projects = [
    { id: "p1", name: "Vorgespraech Ideen", customerId: "c1", date: "2026-10-14 10:30", place: "Hauptstr. 5, 5201 Musterdorf" },
    { id: "p2", name: "Café Muster Dreh", customerId: "c1", date: "14.10.2026", place: "" },
    { id: "p3", name: "Gestern", customerId: "c1", date: "2026-10-13 10:00", place: "Wien" },
    { id: "p4", name: "Morgen", customerId: "c1", date: "2026-10-15 10:00", place: "Wien" },
    { id: "p5", name: "Ohne Kunde", customerId: "zzz", date: "2026-10-14 16:00", place: "Linz" },
    { id: "p6", name: "Kaputt", customerId: "c1", date: "bald" },
  ];
  const customers = [{ id: "c1", name: "Hans Muster", company: "Café Muster" }];

  it("keeps only today, joins the customer name and marks date-only projects all-day", () => {
    const events = shootEventsForDay(projects, customers, NOW, ZONE);
    expect(events.map((e) => e.title)).toEqual(["Café Muster – Vorgespraech Ideen", "Café Muster Dreh", "Ohne Kunde"]);
    expect(events[0]).toMatchObject({ allDay: false, start: "10:30", startMs: vienna(10, 30), place: "Hauptstr. 5, 5201 Musterdorf" });
    expect(events[1]).toMatchObject({ allDay: true, start: "" });
    expect(events[2]).toMatchObject({ start: "16:00", place: "Linz" });
    expect(shootEventsForDay("nope", null, NOW, ZONE)).toEqual([]);
  });

  it("merges with ICS events, dedupes the same slot with a similar title and keeps the place", () => {
    const ical = parseIcs(ics(
      ["UID:a", "SUMMARY:Café Muster Vorgespraech", "DTSTART;TZID=Europe/Vienna:20261014T103000", "DTEND;TZID=Europe/Vienna:20261014T113000"],
      ["UID:b", "SUMMARY:Zahnarzt", "LOCATION:Praxis\\, Salzburg", "DTSTART;TZID=Europe/Vienna:20261014T080000", "DTEND;TZID=Europe/Vienna:20261014T090000"],
      ["UID:c", "SUMMARY:Linz Termin", "DTSTART;TZID=Europe/Vienna:20261014T100000"],
    ), ZONE);
    const merged = mergeEvents(eventsForDay(ical, NOW, ZONE), shootEventsForDay(projects, customers, NOW, ZONE));
    expect(merged.map((e) => `${e.start || "ganztags"} ${e.title}`)).toEqual([
      "ganztags Café Muster Dreh", "08:00 Zahnarzt", "10:00 Linz Termin", "10:30 Café Muster Vorgespraech", "16:00 Ohne Kunde",
    ]);
    expect(merged.find((e) => e.title === "Zahnarzt").place).toBe("Praxis, Salzburg");
    // the ICS entry has no place, the Shoot Day twin does: it is kept
    expect(merged.find((e) => e.title === "Café Muster Vorgespraech").place).toBe("Hauptstr. 5, 5201 Musterdorf");
    // different time or unrelated title: not a duplicate
    expect(mergeEvents([{ title: "Dreh", allDay: false, startMs: 1, endMs: 2, start: "a", end: "", place: "" }], [{ title: "Dreh", allDay: false, startMs: 5, endMs: 5, start: "b", end: "", place: "" }])).toHaveLength(2);
  });
});

describe("geocoding appointment places", () => {
  it("tries the whole text, the last part, then the town without postcode", () => {
    expect(geocodeCandidates("Hauptstr. 5, 5201 Musterdorf am See")).toEqual(["Hauptstr. 5, 5201 Musterdorf am See", "5201 Musterdorf am See", "Musterdorf am See"]);
    expect(geocodeCandidates("Linz")).toEqual(["Linz"]);
    expect(geocodeCandidates("A-5201 Musterdorf")).toEqual(["A-5201 Musterdorf", "Musterdorf"]);
    expect(geocodeCandidates("https://zoom.us/j/123")).toEqual([]);
    expect(geocodeCandidates("Zoom")).toEqual([]);
    expect(geocodeCandidates("  ")).toEqual([]);
  });

  it("falls back step by step, sends only the place string, caches hits and misses", async () => {
    const asked = [];
    const urls = [];
    const fetchImpl = async (url, init) => {
      const u = new URL(url);
      urls.push(u);
      asked.push(u.searchParams.get("name"));
      expect(init.headers.Authorization).toBeUndefined();
      return json(u.searchParams.get("name") === "Musterdorf am See" ? { results: [{ name: "Musterdorf am See", latitude: 47.9, longitude: 13.12 }] } : {});
    };
    let clock = NOW;
    const geo = createGeocoder({ url: "https://geo.test/v1/search", fetchImpl, now: () => clock });
    const place = "Hauptstr. 5, 5201 Musterdorf am See";
    expect(await geo.lookup(place)).toEqual({ lat: 47.9, lon: 13.12, name: "Musterdorf am See" });
    expect(asked).toEqual([place, "5201 Musterdorf am See", "Musterdorf am See"]);
    expect([...new Set(urls.flatMap((u) => [...u.searchParams.keys()]))].sort()).toEqual(["count", "format", "language", "name"]);
    expect(await geo.lookup(place)).toMatchObject({ lat: 47.9 });
    expect(asked).toHaveLength(3); // cached
    clock += 6.9 * 86_400_000;
    await geo.lookup(place);
    expect(asked).toHaveLength(3); // still within 7 days
    clock += 0.2 * 86_400_000;
    await geo.lookup(place);
    expect(asked).toHaveLength(6); // expired
    expect(await geo.lookup("Nirgendwo")).toBeNull();
    const before = asked.length;
    expect(await geo.lookup("Nirgendwo")).toBeNull();
    expect(asked).toHaveLength(before); // miss cached too
  });

  it("a failing geocoder gives null and is not cached", async () => {
    let up = false;
    const fetchImpl = async () => (up ? json({ results: [{ name: "Linz", latitude: 48.3, longitude: 14.29 }] }) : json({}, 503));
    const geo = createGeocoder({ url: "https://geo.test/v1/search", fetchImpl, now: () => NOW });
    expect(await geo.lookup("Linz")).toBeNull();
    up = true;
    expect(await geo.lookup("Linz")).toMatchObject({ name: "Linz" });
  });

  it("measures distance", () => {
    expect(Math.round(distanceKm({ lat: 47.8, lon: 13.04 }, { lat: 48.21, lon: 16.37 }))).toBe(252);
    expect(distanceKm({ lat: 1, lon: 1 }, { lat: 1, lon: 1 })).toBe(0);
  });
});

describe("hourly weather at the appointment", () => {
  it("picks the hour nearest to the start", () => {
    const data = wxFor(5, { pop: 60, mm: 0.4, wind: 41 });
    expect(hourForecast(data, vienna(10, 20))).toEqual({ tempC: 15, code: 61, pop: 60, mm: 0.4, windKmh: 41 });
    expect(hourForecast(data, vienna(10, 40))?.tempC).toBe(16);
    expect(hourForecast(data, vienna(10) + 7 * 86_400_000)).toBeNull();
    expect(hourForecast({}, vienna(10))).toBeNull();
  });
});

describe("Tagesstart weather per appointment place", () => {
  const CFG = { ...ENV, BRIEF_SHOOT_URL: "https://shoot.test", BRIEF_SHOOT_TOKEN: "shoot-secret", BRIEF_GEOCODE_URL: "https://geo.test/v1/search" };
  const PLACES = { Musterdorf: [47.9, 13.12], Linz: [48.3, 14.29], Salzburg: [47.81, 13.05], Graz: [47.07, 15.44] };
  const cal = ics(
    ["UID:a", "SUMMARY:Kunde Linz", "LOCATION:Linz", "DTSTART;TZID=Europe/Vienna:20261014T150000", "DTEND;TZID=Europe/Vienna:20261014T160000"],
    ["UID:b", "SUMMARY:Gespraech Salzburg", "LOCATION:Salzburg", "DTSTART;TZID=Europe/Vienna:20261014T130000", "DTEND;TZID=Europe/Vienna:20261014T140000"],
    ["UID:c", "SUMMARY:Zoom Runde", "LOCATION:https://zoom.us/j/1", "DTSTART;TZID=Europe/Vienna:20261014T120000"],
  );
  const routes = (extra = {}) => ({
    "cal.test": () => new Response(cal),
    "shoot.test": (init, u) => {
      if (init.headers.Authorization !== "Bearer shoot-secret") return json({ error: "401" }, 401);
      return u.pathname === "/api/projects"
        ? json({ projects: [{ id: "p1", name: "Vorgespraech Ideen", customerId: "c1", date: "2026-10-14 10:30", place: "Hauptstr. 5, Musterdorf" }, { id: "p2", name: "Spaeter", customerId: "c1", date: "2026-10-20", place: "Graz" }] })
        : json({ customers: [{ id: "c1", name: "Hans Muster", company: "Café Muster" }] });
    },
    "geo.test": (init, u) => {
      const name = u.searchParams.get("name");
      const hit = Object.entries(PLACES).find(([town]) => name.endsWith(town));
      return json(hit ? { results: [{ name: hit[0], latitude: hit[1][0], longitude: hit[1][1] }] } : {});
    },
    "weather.test": (init, u) => json(wxFor(Math.round(Number(u.searchParams.get("latitude"))), { pop: 60, mm: 0.5, wind: 35 })),
    ...extra,
  });
  const here = { lat: 47.8, lon: 13.04 };

  it("shows here plus the forecast at each appointment's hour and place, one request per place", async () => {
    const { fetchImpl, calls } = fakeSources(routes());
    const brief = createBrief({ config: parseBriefConfig(CFG), fetchImpl, now: () => NOW });
    const out = await brief.get(false, here);
    expect(out.calendar.events.map((e) => `${e.start} ${e.title}`)).toEqual(["10:30 Café Muster – Vorgespraech Ideen", "12:00 Zoom Runde", "13:00 Gespraech Salzburg", "15:00 Kunde Linz"]);
    expect(out.weather).toMatchObject({ status: "ok", place: "here" });
    // Salzburg is < 10 km from "here": no duplicate line; Musterdorf (10:30) and Linz (15:00) remain; online meeting skipped
    expect(out.weather.appts.map((a) => `${a.time} ${a.label} ${a.tempC}`)).toEqual(["10:30 Musterdorf 59", "15:00 Linz 63"]);
    expect(out.weather.appts[0]).toMatchObject({ pop: 60, mm: 0.5, windKmh: 35 });
    expect(weatherCalls(calls).sort()).toEqual(["47.80", "47.90", "48.30"]);
    // only place strings go to the geocoder
    expect(calls.filter((c) => c.startsWith("geo.test")).every((c) => !/47\.8|13\.04|shoot|secret/.test(c))).toBe(true);
  });

  it("geocodes each place once across requests (7-day cache); appointment forecasts live ~10 min", async () => {
    let clock = NOW;
    const { fetchImpl, calls } = fakeSources(routes());
    const brief = createBrief({ config: parseBriefConfig(CFG), fetchImpl, now: () => clock });
    await brief.get();
    const geo = () => calls.filter((c) => c.startsWith("geo.test")).length;
    const first = geo();
    expect(first).toBeGreaterThan(0);
    clock += 3 * 60_000;
    await brief.get();
    expect(geo()).toBe(first);
    expect(weatherCalls(calls).filter((l) => l === "47.90")).toHaveLength(1); // appointment forecast still fresh
    clock += 8 * 60_000;
    await brief.get();
    expect(geo()).toBe(first);
    expect(weatherCalls(calls).filter((l) => l === "47.90")).toHaveLength(2);
  });

  it("appointments show even without any default place; without a place of any kind the block is off", async () => {
    const env = { ...CFG, BRIEF_LAT: "", BRIEF_LON: "" };
    const { fetchImpl } = fakeSources(routes());
    const w = (await createBrief({ config: parseBriefConfig(env), fetchImpl, now: () => NOW }).get()).weather;
    expect(w.status).toBe("ok");
    expect(w.place).toBeUndefined();
    expect(w.appts).toHaveLength(3);
    const quiet = fakeSources(routes({ "cal.test": () => new Response(ics(["UID:z", "SUMMARY:x", "DTSTART;TZID=Europe/Vienna:20261014T150000"])), "shoot.test": () => json({ projects: [] }) }));
    expect((await createBrief({ config: parseBriefConfig(env), fetchImpl: quiet.fetchImpl, now: () => NOW }).get()).weather.status).toBe("off");
  });

  it("a failing geocoder, forecast or Shoot Day server never breaks the other blocks", async () => {
    const down = fakeSources(routes({ "geo.test": () => json({}, 500) }));
    const a = await createBrief({ config: parseBriefConfig(CFG), fetchImpl: down.fetchImpl, now: () => NOW }).get(false, here);
    expect(a.weather).toMatchObject({ status: "ok", place: "here", appts: [] });
    expect(a.car.status).toBe("ok");
    expect(a.calendar.status).toBe("ok");

    const oneForecast = fakeSources(routes({ "weather.test": (init, u) => (Number(u.searchParams.get("latitude")) === 48.3 ? json({}, 500) : json(wxFor(9))) }));
    const b = await createBrief({ config: parseBriefConfig(CFG), fetchImpl: oneForecast.fetchImpl, now: () => NOW }).get(false, here);
    expect(b.weather.appts.map((x) => x.label)).toEqual(["Musterdorf"]);
    expect(b.weather.tempC).toBe(9);

    const hereDown = fakeSources(routes({ "weather.test": (init, u) => (Number(u.searchParams.get("latitude")) === 47.8 ? json({}, 500) : json(wxFor(9))) }));
    const c = await createBrief({ config: parseBriefConfig(CFG), fetchImpl: hereDown.fetchImpl, now: () => NOW }).get(false, here);
    expect(c.weather).toMatchObject({ status: "ok", hereFailed: true });
    expect(c.weather.appts.length).toBe(2);

    const noShoot = fakeSources(routes({ "shoot.test": () => json({ error: "x" }, 502) }));
    const d = await createBrief({ config: parseBriefConfig(CFG), fetchImpl: noShoot.fetchImpl, now: () => NOW }).get(false, here);
    expect(d.calendar).toMatchObject({ status: "ok", failed: 1, total: 3 });
    expect(d.weather.appts.map((x) => x.label)).toEqual(["Linz"]);

    const allWeatherDown = fakeSources(routes({ "weather.test": () => json({}, 500) }));
    const e = await createBrief({ config: parseBriefConfig(CFG), fetchImpl: allWeatherDown.fetchImpl, now: () => NOW }).get(false, here);
    expect(e.weather.status).toBe("error");
    expect(e.calendar.status).toBe("ok");
  });
});
