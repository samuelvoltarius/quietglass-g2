import { describe, expect, it, vi } from "vitest";
import {
  APPT_PAST_MS, APPT_POLL_MS, appointmentRow, arrivalHint, arrivalText, briefConfigured, buildBriefToken, buildBriefUrl,
  clockOf, departure, departureText, ETA_REFRESH_MS, fetchAppointments, MAX_APPTS, nextEtaRequest, parseAppointments,
  shouldFetchAppointments, upcomingAppointments, type Appointment, type ApptEta,
} from "../src/appointments/appointments";
import { buildView, LINE_WIDTH, ROAD_WIDTH, ROW_WIDTH, SPEED_PLATE_CHARS, type ViewOptions } from "../src/glasses/view";
import { APPT_MARK, clampCursor, cursorFor, followCursor, listItems, listView, type ListAppt } from "../src/glasses/picker";
import { createMockProvider } from "../src/routing/provider";
import { progressOf, startNavigation, update } from "../src/nav/navigator";
import { EMPTY_DATA, parseData, type NavData } from "../src/storage/persist";
import { sugarDisplay } from "../src/sugar/glucose";
import { locales } from "../src/i18n";

/** Wednesday 14 Oct 2026, 09:00 local time of the test machine. */
const NOW = new Date(2026, 9, 14, 9, 0, 0).getTime();
const at = (h: number, m = 0): number => new Date(2026, 9, 14, h, m, 0).getTime();
const iso = (ms: number): string => new Date(ms).toISOString();

const appt = (h: number, m: number, title = "Testkunde Vorgespraech", placeLabel = "Musterdorf", lat = 47.9, lon = 13.12): Appointment => ({
  key: `${at(h, m)}|${lat.toFixed(4)},${lon.toFixed(4)}`, title, time: clockOf(at(h, m)), startMs: at(h, m), at: { lat, lon }, placeLabel,
});

describe("build configuration", () => {
  it("is off without an address; the token is optional (Tailscale login)", () => {
    expect(buildBriefUrl("")).toBe("");
    expect(buildBriefUrl(undefined)).toBe("");
    expect(buildBriefUrl("ftp://x")).toBe("");
    expect(buildBriefUrl("not a url")).toBe("");
    expect(buildBriefUrl("https://hub.example:8787/")).toBe("https://hub.example:8787");
    expect(buildBriefToken("  tok ")).toBe("tok");
    expect(briefConfigured("https://hub.example", "")).toBe(true);
    expect(briefConfigured("", "tok")).toBe(false);
    expect(briefConfigured("https://hub.example", "tok")).toBe(true);
  });

  it("the phone switch defaults to off in a build without the daemon, and is stored", () => {
    expect(EMPTY_DATA.appointments).toBe(false);
    expect(parseData(JSON.stringify({ appointments: true })).appointments).toBe(true);
    expect(parseData(JSON.stringify({ appointments: "yes" })).appointments).toBe(false);
  });
});

describe("parsing the daemon's answer", () => {
  const body = {
    date: "2026-10-14",
    events: [
      { time: "", title: "Feiertag", place: "", allDay: true, startIso: "2026-10-14T00:00:00+02:00" },
      { time: "15:00", title: "Werkstatt", place: "Linz", allDay: false, startIso: iso(at(15)), lat: 48.3, lon: 14.29, placeLabel: "Linz" },
      { time: "10:30", title: "Testkunde  Vorgespraech", place: "Hauptstr. 5, Musterdorf", allDay: false, startIso: iso(at(10, 30)), lat: 47.9, lon: 13.12, placeLabel: "Musterdorf" },
      { time: "12:00", title: "Videocall", place: "https://meet.example/x", allDay: false, startIso: iso(at(12)) },
      { time: "13:00", title: "Kaputt", allDay: false, startIso: "morgen", lat: 47, lon: 13 },
      { time: "14:00", title: "Weit weg", allDay: false, startIso: iso(at(14)), lat: 95, lon: 13 },
      "nonsense",
    ],
  };

  it("keeps timed appointments with coordinates, sorted by start", () => {
    const list = parseAppointments(body);
    expect(list.map((a) => a.title)).toEqual(["Testkunde Vorgespraech", "Werkstatt"]);
    expect(list[0]).toMatchObject({ time: "10:30", startMs: at(10, 30), at: { lat: 47.9, lon: 13.12 }, placeLabel: "Musterdorf" });
    expect(list[0]!.key).not.toBe(list[1]!.key);
    expect(parseAppointments(null)).toEqual([]);
    expect(parseAppointments({ events: "x" })).toEqual([]);
  });

  it("shows upcoming ones and those started at most 30 min ago, at most three", () => {
    const list = [appt(8, 0), appt(8, 31), appt(9, 30), appt(11, 0), appt(12, 0), appt(13, 0)];
    const shown = upcomingAppointments(list, NOW);
    expect(shown.map((a) => a.time)).toEqual([clockOf(at(8, 31)), clockOf(at(9, 30)), clockOf(at(11, 0))]);
    expect(shown).toHaveLength(MAX_APPTS);
    expect(upcomingAppointments([appt(8, 30)], NOW)).toEqual([]); // exactly 30 min ago: gone
    expect(APPT_PAST_MS).toBe(30 * 60_000);
  });
});

describe("fetching", () => {
  it("asks GET /brief/appointments with the bearer token and a timeout", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ events: [{ time: "10:30", title: "A", allDay: false, startIso: iso(at(10, 30)), lat: 47.9, lon: 13.12, placeLabel: "S" }] })));
    const list = await fetchAppointments("https://hub.example/", "tok", fetchImpl as unknown as typeof fetch);
    expect(list).toHaveLength(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://hub.example/brief/appointments");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("gives null on any failure, never asks without address, sends no header without token", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 401 }));
    expect(await fetchAppointments("https://hub.example", "tok", fetchImpl as unknown as typeof fetch)).toBeNull();
    const broken = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    expect(await fetchAppointments("https://hub.example", "tok", broken as unknown as typeof fetch)).toBeNull();
    const never = vi.fn(async () => new Response("{}"));
    expect(await fetchAppointments("", "tok", never as unknown as typeof fetch)).toBeNull();
    expect(never).not.toHaveBeenCalled();
    const open = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ events: [] })));
    await fetchAppointments("https://hub.example", "", open as unknown as typeof fetch);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0]?.[1]?.headers).toBeUndefined();
  });

  it("gives up after the timeout", async () => {
    const hang = (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
    expect(await fetchAppointments("https://hub.example", "tok", hang as unknown as typeof fetch, 20)).toBeNull();
  });
});

describe("no request storms", () => {
  it("asks once at start, then only every 5 min while the list is shown, never twice at once", () => {
    const base = { on: true, listShown: true, busy: false, lastAttemptAt: null as number | null, now: NOW };
    expect(shouldFetchAppointments(base)).toBe(true);
    expect(shouldFetchAppointments({ ...base, listShown: false })).toBe(true); // the start request
    expect(shouldFetchAppointments({ ...base, on: false })).toBe(false);
    expect(shouldFetchAppointments({ ...base, busy: true })).toBe(false);
    const asked = { ...base, lastAttemptAt: NOW };
    expect(shouldFetchAppointments({ ...asked, now: NOW + 2_000 })).toBe(false);
    expect(shouldFetchAppointments({ ...asked, now: NOW + APPT_POLL_MS - 1 })).toBe(false);
    expect(shouldFetchAppointments({ ...asked, now: NOW + APPT_POLL_MS })).toBe(true);
    expect(shouldFetchAppointments({ ...asked, now: NOW + APPT_POLL_MS, listShown: false })).toBe(false);
  });

  it("one travel-time request per appointment per 5 min", () => {
    const list = [appt(10, 0), appt(11, 0, "B", "Linz", 48.3, 14.29)];
    const etas = new Map<string, ApptEta>();
    expect(nextEtaRequest(list, etas, NOW)).toBe(list[0]);
    etas.set(list[0]!.key, { askedAt: NOW, travelS: null });
    expect(nextEtaRequest(list, etas, NOW)).toBe(list[1]);
    etas.set(list[1]!.key, { askedAt: NOW, travelS: 900 });
    expect(nextEtaRequest(list, etas, NOW + ETA_REFRESH_MS - 1)).toBeNull();
    expect(nextEtaRequest(list, etas, NOW + ETA_REFRESH_MS)).toBe(list[0]);
  });
});

describe("departure", () => {
  it("latest departure = start - travel time - 5 min", () => {
    // 10:30 start, 13 min drive, 5 min buffer: leave at 10:12, at 10:00 that is in 12 min.
    expect(departure(at(10, 30), 13 * 60, at(10, 0))).toEqual({ kind: "in", minutes: 12 });
    expect(departure(at(10, 30), 13 * 60, at(10, 11, ))).toEqual({ kind: "in", minutes: 1 });
    expect(departure(at(10, 30), 13 * 60, at(10, 11) + 30_000)).toEqual({ kind: "now" });
    expect(departure(at(10, 30), 13 * 60, at(10, 20))).toEqual({ kind: "now" });
    expect(departure(at(15, 0), 20 * 60, at(9, 0))).toEqual({ kind: "at", clock: clockOf(at(14, 35)) });
  });

  it("says it in German and English", () => {
    expect(departureText({ kind: "in", minutes: 12 }, "de")).toBe("los in 12 min");
    expect(departureText({ kind: "now" }, "de")).toBe("jetzt los!");
    expect(departureText({ kind: "at", clock: "14:35" }, "de")).toBe("los um 14:35");
    expect(departureText({ kind: "in", minutes: 12 }, "en")).toBe("leave in 12 min");
    expect(departureText({ kind: "now" }, "en")).toBe("go now!");
  });
});

describe("list row", () => {
  it("time, title, place and departure, the title giving way first", () => {
    const a = appt(10, 30);
    expect(appointmentRow(a, 41)).toBe(`${a.time} Testkunde Vorgespraech · Musterdorf`);
    expect(appointmentRow(a, 40)).toBe(`${a.time} Testkunde … · Musterdorf`);
    // No room for a readable title next to the departure: time, place, departure.
    expect(appointmentRow(a, 40, "los in 12 min")).toBe(`${a.time} Musterdorf · los in 12 min`);
    const long = appt(10, 30, "Testkunde Kaffeehaus Vorgespraech Ideen und Planung");
    const row = appointmentRow(long, 42, "los in 12 min");
    expect(row.length).toBeLessThanOrEqual(42);
    expect(row).toMatch(/^\d\d:\d\d Testk … · Musterdorf · los in 12 min$/);
    // The owner's example fits the 42 characters of an appointment row exactly.
    expect(appointmentRow(appt(10, 30, "Huber Kaffeebar – Vorgespraech"), 42, "los in 12 min")).toBe(`${a.time} Huber … · Musterdorf · los in 12 min`);
    // Very long place: both shrink, time and departure stay.
    const both = appointmentRow(appt(10, 30, "Testkunde Kaffeehaus", "Musterdorf am See Nord Gewerbegebiet"), 40, "jetzt los!");
    expect(both.length).toBeLessThanOrEqual(40);
    expect(both.startsWith(a.time + " ")).toBe(true);
    expect(both.endsWith(" · jetzt los!")).toBe(true);
    for (const w of [20, 30, 40]) expect(appointmentRow(long, w, "leave in 85 min").length).toBeLessThanOrEqual(w);
  });

  const data: NavData = { ...EMPTY_DATA, places: [{ id: "p1", label: "Zuhause", at: { lat: 47, lon: 13 } }], destinationId: "p1" };
  const rows: ListAppt[] = [{ appt: appt(10, 30), leave: "los in 12 min" }, { appt: appt(15, 0, "Werkstatt", "Linz", 48.3, 14.29), leave: null }];

  it("appointments come first, marked, and fit the row in de and en", () => {
    for (const locale of locales) {
      const view = listView(data, 0, locale, true, rows);
      expect(view.body[0]!.startsWith("→ " + APPT_MARK)).toBe(true);
      expect(view.body[0]).toBe(`→ ${APPT_MARK}${rows[0]!.appt.time} Testk … · Musterdorf · los in 12 min`);
      expect(view.body[1]!.startsWith("  " + APPT_MARK)).toBe(true);
      expect(view.body[1]).toContain(APPT_MARK + rows[1]!.appt.time + " Werkstatt · Linz");
      expect(view.body[2]).toContain("Zuhause");
      for (const line of view.body) expect(line.length).toBeLessThanOrEqual(LINE_WIDTH);
      expect(view.footer.length).toBeLessThanOrEqual(ROW_WIDTH);
    }
    expect(listItems(data, rows)[0]).toMatchObject({ kind: "appt" });
    expect(listView(data, 0, "de")).toEqual(listView(data, 0, "de", true, []));
  });

  it("the cursor stays on its entry when appointments arrive or pass", () => {
    expect(cursorFor(data, rows)).toBe(2); // the active destination
    expect(followCursor(data, 0, [], rows)).toBe(2); // was on Zuhause, still is
    expect(followCursor(data, 1, rows, rows.slice(1))).toBe(0); // the Linz row moved up
    expect(followCursor(data, 2, rows, [])).toBe(0);
    expect(followCursor(data, 0, rows, rows.slice(1))).toBe(0); // its appointment went: same position
    // Travel-mode row (after 3 items) keeps being the travel-mode row.
    expect(followCursor(data, 3, rows, [])).toBe(1);
    expect(clampCursor(data, 99, rows)).toBe(3);
  });
});

async function progressAt(index: number, mode: "driving" | "walking" = "driving") {
  const { route } = await createMockProvider().route({ from: { lat: 47.8, lon: 13.04 }, to: { lat: 47.9, lon: 13.12 }, mode });
  return progressOf(update(startNavigation(route!), route!.shape[index]!));
}

describe("driving HUD: arrival against the appointment", () => {
  const base: ViewOptions = { mode: "driving", navigating: true, rerouting: false, error: null, mock: false, waitingForFix: false, bigDistance: true };

  it("footer: Ankunft 10:22 · 8 min früher / · 5 min zu spät, within the row", async () => {
    const p = await progressAt(1);
    const eta = NOW + p.secondsRemaining * 1000;
    const etaClock = clockOf(eta);
    const early = buildView(p, { ...base, locale: "de", appointment: { startMs: eta + 8 * 60_000, title: "X" } }, NOW);
    if (early.footer !== "") expect(early.footer).toContain(`Ankunft ${etaClock} · 8 min früher`);
    const late = buildView(p, { ...base, locale: "de", appointment: { startMs: eta - 5 * 60_000, title: "X" } }, NOW);
    if (late.footer !== "") expect(late.footer).toContain("· 5 min zu spät");
    const en = buildView(p, { ...base, locale: "en", appointment: { startMs: eta, title: "X" } }, NOW);
    if (en.footer !== "") expect(en.footer).toContain(`Arrive ${etaClock} · on time`);
  });

  it("text layer: with battery, glucose and demo tag it still fits one row in de and en", () => {
    expect(arrivalText("10:22", 8, "de")).toBe("Ankunft 10:22 · 8 min früher");
    expect(arrivalText("10:22", -5, "de")).toBe("Ankunft 10:22 · 5 min zu spät");
    expect(arrivalText("10:22", -5, "en", true)).toBe("10:22 · 5 min late");
  });

  it("every footer variant stays within ROW_WIDTH; sugar warning wins; nothing without an appointment", async () => {
    const p = await progressAt(0);
    const sugar = sugarDisplay({ at: NOW, mgdl: 128, direction: "Flat" }, NOW);
    const low = sugarDisplay({ at: NOW, mgdl: 62, direction: "SingleDown" }, NOW);
    const battery = { soc: 87, arrival: 62, low: false } as never;
    for (const locale of locales) {
      for (const delta of [-125, -5, 0, 8, 240]) {
        const appointment = { startMs: NOW + p.secondsRemaining * 1000 + delta * 60_000, title: "Testkunde" };
        for (const extra of [{}, { sugar }, { battery }, { battery, sugar, mock: true }]) {
          const view = buildView(p, { ...base, ...extra, locale, appointment }, NOW);
          expect(view.footer.length, JSON.stringify([locale, delta, view.footer])).toBeLessThanOrEqual(ROW_WIDTH);
          if (view.footer !== "") expect(view.footer).toMatch(/früher|zu spät|pünktlich|early|late|on time/);
        }
        const warned = buildView(p, { ...base, locale, appointment, sugar: low }, NOW);
        expect(warned.footer).toMatch(/^! 62↓/);
      }
      const plain = buildView(p, { ...base, locale }, NOW);
      expect(plain.footer).not.toMatch(/früher|zu spät|early|late/);
      expect(buildView(p, { ...base, locale, appointment: null }, NOW)).toEqual(plain);
    }
  });

  it("map plate: a short early/late chip after the speed when it fits", async () => {
    const p = await progressAt(0);
    const appointment = { startMs: NOW + p.secondsRemaining * 1000 + 8 * 60_000, title: "X" };
    const free = buildView(p, { ...base, layout: "overview", locale: "de", speed: { kmh: 52, limit: null }, appointment }, NOW);
    expect(free.speed).toBe("52 km/h  8 früh");
    const full = buildView(p, { ...base, layout: "overview", locale: "de", speed: { kmh: 52, limit: 50 }, appointment }, NOW);
    expect(full.speed).toBe("52 | 50 km/h");
    for (const view of [free, full]) expect(view.speed!.length).toBeLessThanOrEqual(SPEED_PLATE_CHARS);
  });
});

describe("arrival at an appointment", () => {
  it("one extra line: Termin: <title> · Babel: Kundengespräch", async () => {
    const p = { ...(await progressAt(0)), arrived: true };
    const base: ViewOptions = { mode: "driving", navigating: true, rerouting: false, error: null, mock: false, waitingForFix: false };
    const de = buildView(p, { ...base, locale: "de", appointment: { startMs: NOW, title: "Testkunde" } }, NOW);
    expect(de.body).toEqual(["◉  Angekommen", "Termin: Testkunde · Babel: Kundengespräch"]);
    const en = buildView(p, { ...base, locale: "en", appointment: { startMs: NOW, title: "Testkunde Kaffeehaus Vorgespraech" } }, NOW);
    expect(en.body[1]!.startsWith("Appt: Testkunde")).toBe(true);
    expect(en.body[1]!.endsWith(" … · Babel: client talk")).toBe(true);
    expect(buildView(p, { ...base, locale: "de" }, NOW).body).toEqual(["◉  Angekommen"]);
    for (const locale of locales) expect(arrivalHint("A".repeat(80), locale, ROAD_WIDTH).length).toBeLessThanOrEqual(ROAD_WIDTH);
  });
});
