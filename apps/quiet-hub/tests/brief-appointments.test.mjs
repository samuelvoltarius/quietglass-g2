import { afterEach, describe, expect, it } from "vitest";
import { startHub } from "./helpers.mjs";
import { appointmentOut, APPOINTMENTS_FRESH_MS, createBrief, isoIn, locateEvents, parseBriefConfig, zonedToEpoch } from "../examples/quiet-hub-brief.mjs";

/**
 * GET /brief/appointments: today's appointments with coordinates for the
 * navigation app (OpenGlance). Calendar + geocoding only, cached ~2 min,
 * coordinates never in a log line.
 */

const ZONE = "Europe/Vienna";
/** Wednesday 14 Oct 2026, 07:00 in Vienna (CEST = UTC+2). */
const NOW = Date.UTC(2026, 9, 14, 5, 0, 0);
const vienna = (h, m = 0) => zonedToEpoch(2026, 10, 14, h, m, 0, ZONE);
const ics = (...events) => ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//EN", ...events.flatMap((e) => ["BEGIN:VEVENT", ...e, "END:VEVENT"]), "END:VCALENDAR"].join("\r\n");
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

const CAL = ics(
  ["UID:a", "SUMMARY:Testkunde Vorgespraech", "LOCATION:Hauptstr. 5\\, 5201 Musterdorf", "DTSTART;TZID=Europe/Vienna:20261014T103000", "DTEND;TZID=Europe/Vienna:20261014T113000"],
  ["UID:b", "SUMMARY:Videocall", "LOCATION:https://meet.example/abc", "DTSTART;TZID=Europe/Vienna:20261014T120000"],
  ["UID:c", "SUMMARY:Feiertag", "DTSTART;VALUE=DATE:20261014", "DTEND;VALUE=DATE:20261015"],
  ["UID:d", "SUMMARY:Werkstatt", "LOCATION:Linz", "DTSTART;TZID=Europe/Vienna:20261014T150000", "DTEND;TZID=Europe/Vienna:20261014T160000"],
);
const PLACES = { Musterdorf: [47.9, 13.12], Linz: [48.3, 14.29] };
const ENV = {
  BRIEF_ICS_URLS: "https://cal.test/a.ics", BRIEF_LAT: "47.8", BRIEF_LON: "13.04", BRIEF_TZ: ZONE,
  BRIEF_WEATHER_URL: "https://weather.test/v1/forecast", BRIEF_GEOCODE_URL: "https://geo.test/v1/search", BRIEF_TIMEOUT_MS: "1000",
};

function sources(overrides = {}) {
  const calls = [];
  const routes = {
    "cal.test": () => new Response(CAL),
    "geo.test": (u) => {
      const name = u.searchParams.get("name");
      const hit = Object.entries(PLACES).find(([town]) => name.endsWith(town));
      return json(hit ? { results: [{ name: hit[0], latitude: hit[1][0], longitude: hit[1][1] }] } : {});
    },
    "weather.test": () => json({ current: { temperature_2m: 9, weather_code: 3 }, daily: { temperature_2m_max: [15], temperature_2m_min: [6] } }),
    ...overrides,
  };
  const fetchImpl = async (url) => {
    const u = new URL(url);
    calls.push(`${u.host}${u.pathname}${u.search}`);
    const route = routes[u.host];
    if (!route) throw new Error(`unexpected host ${u.host}`);
    return route(u);
  };
  return { fetchImpl, calls };
}
const count = (calls, host) => calls.filter((c) => c.startsWith(host)).length;

describe("isoIn", () => {
  it("writes the wall clock with the zone's offset (summer and winter)", () => {
    expect(isoIn(vienna(10, 30), ZONE)).toBe("2026-10-14T10:30:00+02:00");
    expect(isoIn(zonedToEpoch(2026, 12, 1, 8, 5, 0, ZONE), ZONE)).toBe("2026-12-01T08:05:00+01:00");
    expect(isoIn(Date.UTC(2026, 0, 1, 0, 0, 0), "UTC")).toBe("2026-01-01T00:00:00+00:00");
    expect(Date.parse(isoIn(vienna(10, 30), ZONE))).toBe(vienna(10, 30));
  });
});

describe("locateEvents", () => {
  const events = [
    { title: "A", place: "Linz", allDay: false, startMs: vienna(9), start: "09:00", end: "" },
    { title: "B", place: "", allDay: false, startMs: vienna(11), start: "11:00", end: "" },
    { title: "C", place: "Nirgendwo", allDay: true, startMs: vienna(0), start: "", end: "" },
  ];

  it("adds startIso and allDay to all, coordinates where the place is found", async () => {
    const out = await locateEvents(events, ZONE, async (place) => (place === "Linz" ? { lat: 48.3, lon: 14.29, name: "Linz" } : null));
    expect(out[0]).toMatchObject({ startIso: "2026-10-14T09:00:00+02:00", allDay: false, lat: 48.3, lon: 14.29, placeLabel: "Linz" });
    expect(out[1].lat).toBeUndefined();
    expect(out[2]).toMatchObject({ allDay: true, startIso: "2026-10-14T00:00:00+02:00" });
    expect(out[2].lat).toBeUndefined();
  });

  it("never throws and does not wait longer than the limit for a slow geocoder", async () => {
    const failing = await locateEvents(events, ZONE, async () => { throw new Error("down"); });
    expect(failing.every((e) => e.lat === undefined)).toBe(true);
    const started = Date.now();
    const slow = await locateEvents(events, ZONE, () => new Promise(() => {}), 50);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(slow.every((e) => e.lat === undefined && e.startIso !== "")).toBe(true);
  });

  it("sends only plain fields", () => {
    const out = appointmentOut({ title: "A", place: "Linz", allDay: false, start: "09:00", end: "10:00", startMs: 1, endMs: 2, startIso: "x", lat: 48.3, lon: 14.29, placeLabel: "Linz" });
    expect(out).toEqual({ time: "09:00", end: "10:00", title: "A", place: "Linz", allDay: false, startIso: "x", lat: 48.3, lon: 14.29, placeLabel: "Linz" });
    expect(Object.keys(appointmentOut({ title: "B", allDay: true, start: "" }))).not.toContain("lat");
  });
});

describe("brief.appointments()", () => {
  it("returns today's events with coordinates, without fetching the weather", async () => {
    const { fetchImpl, calls } = sources();
    const brief = createBrief({ config: parseBriefConfig(ENV), fetchImpl, now: () => NOW });
    const out = await brief.appointments();
    expect(out.date).toBe("2026-10-14");
    expect(out.status).toBe("ok");
    expect(out.events.map((e) => `${e.time || "ganztags"} ${e.title}`)).toEqual(["ganztags Feiertag", "10:30 Testkunde Vorgespraech", "12:00 Videocall", "15:00 Werkstatt"]);
    expect(out.events[1]).toMatchObject({ placeLabel: "Musterdorf", lat: 47.9, lon: 13.12, startIso: "2026-10-14T10:30:00+02:00", allDay: false });
    expect(out.events[2].lat).toBeUndefined(); // online meeting: never geocoded
    expect(out.events[3]).toMatchObject({ placeLabel: "Linz", lat: 48.3 });
    expect(count(calls, "weather.test")).toBe(0);
  });

  it("answers from its list for 2 min, then asks calendar + geocoder again (geocoder from cache)", async () => {
    let clock = NOW;
    const { fetchImpl, calls } = sources();
    const brief = createBrief({ config: parseBriefConfig(ENV), fetchImpl, now: () => clock });
    await brief.appointments();
    const geo = count(calls, "geo.test");
    clock += APPOINTMENTS_FRESH_MS - 1000;
    await brief.appointments();
    expect(count(calls, "cal.test")).toBe(1);
    clock += 2000;
    await brief.appointments();
    expect(count(calls, "cal.test")).toBe(2);
    expect(count(calls, "geo.test")).toBe(geo);
    expect(count(calls, "weather.test")).toBe(0);
  });

  it("parallel requests share one collection", async () => {
    const { fetchImpl, calls } = sources();
    const brief = createBrief({ config: parseBriefConfig(ENV), fetchImpl, now: () => NOW });
    const all = await Promise.all([brief.appointments(), brief.appointments(), brief.appointments()]);
    expect(all.every((a) => a.events.length === 4)).toBe(true);
    expect(count(calls, "cal.test")).toBe(1);
  });

  it("reuses a fresh full brief (its calendar block carries the coordinates too)", async () => {
    const { fetchImpl, calls } = sources();
    const brief = createBrief({ config: parseBriefConfig(ENV), fetchImpl, now: () => NOW });
    const full = await brief.get();
    expect(full.calendar.events.find((e) => e.title === "Werkstatt")).toMatchObject({ lat: 48.3, lon: 14.29, placeLabel: "Linz", startIso: "2026-10-14T15:00:00+02:00" });
    const before = count(calls, "cal.test");
    const out = await brief.appointments();
    expect(out.events).toHaveLength(4);
    expect(count(calls, "cal.test")).toBe(before);
  });

  it("no calendar source: status off, nothing fetched", async () => {
    const brief = createBrief({ config: parseBriefConfig({ BRIEF_TZ: ZONE }), fetchImpl: async () => { throw new Error("must not fetch"); }, now: () => NOW });
    expect(await brief.appointments()).toMatchObject({ status: "off", events: [] });
  });

  it("calendar down: status error and an empty list", async () => {
    const { fetchImpl } = sources({ "cal.test": () => json({}, 503) });
    const brief = createBrief({ config: parseBriefConfig(ENV), fetchImpl, now: () => NOW });
    expect(await brief.appointments()).toMatchObject({ status: "error", events: [] });
  });
});

describe("daemon GET /brief/appointments", () => {
  let hub;
  afterEach(async () => { await hub?.close(); hub = undefined; });

  it("needs the token, answers {date, events}, never logs coordinates or titles", async () => {
    const { fetchImpl } = sources();
    const lines = [];
    const logged = [];
    hub = await startHub({ briefEnv: ENV, briefFetch: fetchImpl, now: () => NOW, accessLog: (line) => lines.push(line), log: (...args) => logged.push(args.join(" ")) });
    expect((await fetch(`${hub.url}/brief/appointments`)).status).toBe(401);
    const res = await hub.api("/brief/appointments");
    expect(res.status).toBe(200);
    expect(res.json.date).toBe("2026-10-14");
    expect(res.json.events.find((e) => e.placeLabel === "Musterdorf")).toMatchObject({ lat: 47.9, lon: 13.12, time: "10:30" });
    expect(res.json.weather).toBeUndefined();
    expect(lines.join("\n")).toContain("GET /brief/appointments 200");
    const all = [...lines, ...logged].join("\n");
    expect(all).not.toMatch(/47\.9|13\.12|48\.3|14\.29|Testkunde|Musterdorf/);
  });

  it("BRIEF=off: 404", async () => {
    hub = await startHub({ briefEnv: { BRIEF: "off" } });
    expect((await hub.api("/brief/appointments")).status).toBe(404);
  });
});
