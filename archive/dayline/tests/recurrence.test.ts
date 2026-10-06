// Pin a zone east of UTC so UTC-vs-local mistakes show up on every machine.
(globalThis as unknown as { process: { env: Record<string, string> } }).process.env.TZ = "Europe/Vienna";
import { describe, expect, it } from "vitest";
import { ICS_WINDOW_DAYS, latestOnly, parseIcs, parseIcsTime, parseRrule, resolveTzid, splitIcsLine, when } from "../src/agenda/model";
import { agendaLine } from "../src/agenda/view";

const ics = (...events: string[][]): string => ["BEGIN:VCALENDAR", ...events.flatMap((lines) => ["BEGIN:VEVENT", ...lines, "END:VEVENT"]), "END:VCALENDAR"].join("\r\n");
/** Tuesday 6 October 2026, midday Vienna time. */
const NOW = new Date(2026, 9, 6, 12);
const at = (text: string, now: Date = NOW, days?: number): string[] => parseIcs(text, days === undefined ? { now } : { now, days }).map((item) => item.at);

describe("ICS window", () => {
  it("drops events before today but keeps today's earlier ones", () => {
    // Regression: an exported calendar showed years-old entries first.
    const items = parseIcs(ics(["UID:a", "DTSTART:20190101T090000", "SUMMARY:Old"], ["UID:b", "DTSTART:20261005T090000", "SUMMARY:Yesterday"], ["UID:c", "DTSTART:20261006T080000", "SUMMARY:This morning"], ["UID:d", "DTSTART:20261008T080000", "SUMMARY:Thursday"]), { now: NOW });
    expect(items.map((item) => item.title)).toEqual(["This morning", "Thursday"]);
  });
  it("keeps an event that started earlier and is still running", () => {
    const items = parseIcs(ics(["DTSTART;VALUE=DATE:20261005", "DTEND;VALUE=DATE:20261008", "SUMMARY:Trip"], ["DTSTART;VALUE=DATE:20261005", "DTEND;VALUE=DATE:20261006", "SUMMARY:Ended"]), { now: NOW });
    expect(items.map((item) => item.title)).toEqual(["Trip"]);
  });
  it("stops at the end of the window", () => {
    expect(ICS_WINDOW_DAYS).toBe(30);
    expect(at(ics(["DTSTART:20261104T090000", "SUMMARY:In"], ["DTSTART:20261105T090000", "SUMMARY:Out"]))).toEqual(["2026-11-04T09:00:00"]);
  });
  it("skips cancelled events", () => {
    expect(at(ics(["DTSTART:20261007T090000", "STATUS:CANCELLED", "SUMMARY:Off"]))).toEqual([]);
  });
  it("ignores properties of nested VALARM blocks", () => {
    expect(parseIcs(ics(["DTSTART:20261007T090000", "SUMMARY:Dentist", "BEGIN:VALARM", "DESCRIPTION:Reminder", "SUMMARY:Alarm text", "END:VALARM"]), { now: NOW })[0]?.title).toBe("Dentist");
  });
});

describe("RRULE expansion", () => {
  it("expands a daily rule that began years ago into the window only", () => {
    // Regression: recurring events showed once, at their first date years back (or not at all).
    expect(at(ics(["UID:d", "DTSTART:20200101T073000", "RRULE:FREQ=DAILY", "SUMMARY:Standup"]), NOW, 3)).toEqual(["2026-10-06T07:30:00", "2026-10-07T07:30:00", "2026-10-08T07:30:00"]);
  });
  it("honours INTERVAL", () => {
    expect(at(ics(["DTSTART:20261001T100000", "RRULE:FREQ=DAILY;INTERVAL=3", "SUMMARY:x"]), NOW, 10)).toEqual(["2026-10-07T10:00:00", "2026-10-10T10:00:00", "2026-10-13T10:00:00"]);
  });
  it("expands weekly BYDAY within each week", () => {
    // 1 Oct 2026 is a Thursday.
    expect(at(ics(["DTSTART:20261001T180000", "RRULE:FREQ=WEEKLY;BYDAY=TU,TH", "SUMMARY:Gym"]), NOW, 9)).toEqual(["2026-10-06T18:00:00", "2026-10-08T18:00:00", "2026-10-13T18:00:00"]);
  });
  it("expands every second week on the DTSTART weekday", () => {
    expect(at(ics(["DTSTART:20260922T090000", "RRULE:FREQ=WEEKLY;INTERVAL=2", "SUMMARY:x"]), NOW, 30)).toEqual(["2026-10-06T09:00:00", "2026-10-20T09:00:00", "2026-11-03T09:00:00"]);
  });
  it("counts COUNT from DTSTART, not from today", () => {
    expect(at(ics(["DTSTART:20261004T090000", "RRULE:FREQ=DAILY;COUNT=4", "SUMMARY:x"]))).toEqual(["2026-10-06T09:00:00", "2026-10-07T09:00:00"]);
  });
  it("treats UNTIL as inclusive", () => {
    expect(at(ics(["DTSTART:20261006T090000", "RRULE:FREQ=DAILY;UNTIL=20261008T070000Z", "SUMMARY:x"]))).toEqual(["2026-10-06T09:00:00", "2026-10-07T09:00:00", "2026-10-08T09:00:00"]);
    expect(at(ics(["DTSTART;VALUE=DATE:20261006", "RRULE:FREQ=DAILY;UNTIL=20261007", "SUMMARY:x"]))).toEqual(["2026-10-06T00:00:00", "2026-10-07T00:00:00"]);
  });
  it("skips months without the day and handles nth weekdays", () => {
    expect(at(ics(["DTSTART:20260131T090000", "RRULE:FREQ=MONTHLY", "SUMMARY:x"]), new Date(2026, 9, 1), 92)).toEqual(["2026-10-31T09:00:00", "2026-12-31T09:00:00"]);
    expect(at(ics(["DTSTART:20260113T090000", "RRULE:FREQ=MONTHLY;BYDAY=2TU", "SUMMARY:x"]), new Date(2026, 9, 1), 61)).toEqual(["2026-10-13T09:00:00", "2026-11-10T09:00:00"]);
    expect(at(ics(["DTSTART:20260130T090000", "RRULE:FREQ=MONTHLY;BYDAY=-1FR", "SUMMARY:x"]), new Date(2026, 9, 1), 31)).toEqual(["2026-10-30T09:00:00"]);
  });
  it("expands yearly birthdays and skips 29 February in common years", () => {
    expect(at(ics(["DTSTART;VALUE=DATE:19900712", "RRULE:FREQ=YEARLY", "SUMMARY:x"]), new Date(2026, 6, 1), 30)).toEqual(["2026-07-12T00:00:00"]);
    expect(at(ics(["DTSTART;VALUE=DATE:20240229", "RRULE:FREQ=YEARLY", "SUMMARY:x"]), new Date(2027, 1, 1), 60)).toEqual([]);
  });
  it("removes EXDATEs, including comma lists and TZID dates", () => {
    const text = ics(["DTSTART;TZID=Europe/Vienna:20261006T090000", "RRULE:FREQ=DAILY;COUNT=4", "EXDATE;TZID=Europe/Vienna:20261007T090000,20261008T090000", "SUMMARY:x"]);
    expect(at(text).map((iso) => when(iso, "de-AT", NOW))).toEqual(["09:00", "09.10. 09:00"]);
  });
  it("shows a moved instance once, at its new time", () => {
    const text = ics(["UID:m", "DTSTART:20261006T090000", "RRULE:FREQ=DAILY;COUNT=3", "SUMMARY:Sync"], ["UID:m", "RECURRENCE-ID:20261007T090000", "DTSTART:20261007T150000", "SUMMARY:Sync (moved)"]);
    expect(parseIcs(text, { now: NOW }).map((item) => `${item.at} ${item.title}`)).toEqual(["2026-10-06T09:00:00 Sync", "2026-10-07T15:00:00 Sync (moved)", "2026-10-08T09:00:00 Sync"]);
  });
  it("gives every occurrence its own id so toggling one does not toggle all", () => {
    const ids = parseIcs(ics(["UID:r", "DTSTART:20261006T090000", "RRULE:FREQ=DAILY;COUNT=2", "SUMMARY:x"]), { now: NOW }).map((item) => item.id);
    expect(new Set(ids).size).toBe(2);
  });
  it("keeps the wall-clock time of a TZID series across the DST change", () => {
    // Vienna leaves summer time on 25 October 2026.
    const text = ics(["DTSTART;TZID=Europe/Vienna:20261023T090000", "RRULE:FREQ=DAILY;COUNT=4", "SUMMARY:x"]);
    expect(at(text, new Date(2026, 9, 23))).toEqual(["2026-10-23T07:00:00.000Z", "2026-10-24T07:00:00.000Z", "2026-10-25T08:00:00.000Z", "2026-10-26T08:00:00.000Z"]);
  });
  it("leaves unsupported rules as a single event instead of guessing", () => {
    expect(parseRrule("FREQ=MONTHLY;BYDAY=MO,TU;BYSETPOS=-1")).toBeNull();
    expect(parseRrule("FREQ=HOURLY")).toBeNull();
    expect(at(ics(["DTSTART:20261007T090000", "RRULE:FREQ=MONTHLY;BYSETPOS=1;BYDAY=MO", "SUMMARY:x"]))).toEqual(["2026-10-07T09:00:00"]);
  });
  it("supports weekdays written as a daily rule", () => {
    // 10 and 11 October 2026 are a weekend.
    expect(at(ics(["DTSTART:20261001T080000", "RRULE:FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR", "SUMMARY:x"]), new Date(2026, 9, 9), 4)).toEqual(["2026-10-09T08:00:00", "2026-10-12T08:00:00"]);
  });
});

describe("TZID", () => {
  it("converts an IANA zone instead of reading the time as device-local", () => {
    // Regression: 09:00 New York showed as 09:00 in Vienna.
    const items = parseIcs(ics(["DTSTART;TZID=America/New_York:20261007T090000", "SUMMARY:Call"]), { now: NOW });
    expect(items[0]?.at).toBe("2026-10-07T13:00:00.000Z");
    expect(when(items[0]!.at, "de-AT")).toBe("15:00");
  });
  it("accepts quoted and Mozilla-style ids", () => {
    expect(parseIcsTime("20261007T090000", { TZID: "/mozilla.org/20050126_1/America/New_York" })?.zone.kind).toBe("tz");
    expect(resolveTzid("\"Asia/Tokyo\"")).not.toBeNull();
  });
  it("falls back to local time for an unknown TZID without throwing", () => {
    expect(resolveTzid("W. Europe Standard Time")).toBeNull();
    expect(at(ics(["DTSTART;TZID=Nowhere/Atlantis:20261007T090000", "SUMMARY:x"]))).toEqual(["2026-10-07T09:00:00"]);
  });
  it("splits a property whose quoted parameter holds a colon", () => {
    expect(splitIcsLine("DESCRIPTION;ALTREP=\"http://x.test/a\":Text")).toEqual({ name: "DESCRIPTION", params: { ALTREP: "http://x.test/a" }, value: "Text" });
  });
});

describe("dates on the agenda", () => {
  it("adds the date to items on other days", () => {
    const item = { id: "x", at: "2026-10-08T09:30:00", title: "Dentist", kind: "event" as const };
    expect(agendaLine(item, false, "de-AT", NOW)).toBe("  08.10. 09:30     Dentist");
    expect(agendaLine({ ...item, at: "2026-10-06T09:30:00" }, false, "de-AT", NOW)).toBe("  09:30     Dentist");
  });
});

describe("latestOnly", () => {
  it("makes an earlier load stale once a newer one begins", () => {
    // Regression: a slow bridge answer replaced a just-imported ICS file.
    const loads = latestOnly(); const bridge = loads.begin(); const importIcs = loads.begin();
    expect([bridge(), importIcs()]).toEqual([false, true]);
  });
});
