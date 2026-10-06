// Pin a zone east of UTC so UTC-vs-local mistakes show up on every machine.
(globalThis as unknown as { process: { env: Record<string, string> } }).process.env.TZ = "Europe/Vienna";
import { describe, expect, it } from "vitest";
import { byTime, demoAgenda, fetchBridge, parseBridge, parseIcs, parseIcsDate, toggleDone, unescapeIcsText, unfoldIcs, when, type AgendaItem } from "../src/agenda/model";

const ics = (...events: string[][]): string => ["BEGIN:VCALENDAR", ...events.flatMap((lines) => ["BEGIN:VEVENT", ...lines, "END:VEVENT"]), "END:VCALENDAR"].join("\r\n");

describe("parseIcsDate", () => {
  it("keeps the UTC marker so the time is shifted into the local zone", () => {
    // Regression: "20261003T093000Z" became a floating 09:30 and showed 09:30 instead of 11:30 in Vienna.
    expect(parseIcsDate("20261003T093000Z")).toBe("2026-10-03T09:30:00Z");
    expect(when(parseIcsDate("20261003T093000Z"), "de-AT")).toBe("11:30");
  });
  it("treats a time without Z as local", () => {
    expect(when(parseIcsDate("20261003T093000"), "de-AT")).toBe("09:30");
  });
  it("expands an all-day date and a time without seconds", () => {
    expect(parseIcsDate("20261003")).toBe("2026-10-03T00:00:00");
    expect(parseIcsDate("20261003T0930")).toBe("2026-10-03T09:30:00");
  });
});

describe("unfoldIcs and text escapes", () => {
  it("unfolds CRLF and bare-LF continuation lines", () => {
    // Regression: textarea paste normalises to LF, and LF folds were left as separate lines, cutting titles.
    expect(unfoldIcs("SUMMARY:Long\r\n  title\nDESCRIPTION:a\n\tb")).toEqual(["SUMMARY:Long title", "DESCRIPTION:ab"]);
  });
  it("unescapes commas, semicolons, backslashes and newlines", () => {
    // Regression: only "\," was handled, so "Raum\; 2" showed a stray backslash.
    expect(unescapeIcsText("A\\, B\\; C\\\\D\\nE")).toBe("A, B; C\\D E");
  });
});

describe("parseIcs", () => {
  it("reads a folded summary from pasted LF text", () => {
    const text = ["BEGIN:VEVENT", "UID:x", "DTSTART:20261003T090000", "SUMMARY:Quarterly planning wi", " th the whole team", "END:VEVENT"].join("\n");
    expect(parseIcs(text)[0]?.title).toBe("Quarterly planning with the whole team");
  });
  it("ignores parameters on property names", () => {
    expect(parseIcs(ics(["DTSTART;TZID=Europe/Vienna:20261003T080000", "SUMMARY;LANGUAGE=de:Werkstatt"]))[0]).toMatchObject({ at: "2026-10-03T08:00:00", title: "Werkstatt" });
  });
  it("skips events without a summary or start and lines outside events", () => {
    expect(parseIcs(ics(["SUMMARY:No start"], ["DTSTART:20261003T080000"], ["DTSTART:20261003T090000", "SUMMARY:Kept"]))).toHaveLength(1);
    expect(parseIcs("SUMMARY:Stray\nDTSTART:20261003T080000")).toEqual([]);
  });
  it("derives an id when UID is missing", () => {
    expect(parseIcs(ics(["DTSTART:20261003T090000", "SUMMARY:Gym"]))[0]?.id).toBe("20261003T090000-Gym");
  });
  it("orders UTC and local events chronologically", () => {
    // 07:30Z is 09:30 in Vienna, so it belongs after the local 09:00 event.
    const items = parseIcs(ics(["DTSTART:20261003T073000Z", "SUMMARY:Call"], ["DTSTART:20261003T090000", "SUMMARY:Coffee"]));
    expect(items.map((item) => item.title)).toEqual(["Coffee", "Call"]);
  });
});

describe("parseBridge", () => {
  it("rejects a non-array response", () => { expect(() => parseBridge({ items: [] })).toThrow("must be an array"); });
  it("skips null and incomplete rows instead of failing", () => {
    // Regression: a null entry threw "Cannot read properties of null".
    expect(parseBridge([null, { title: "No time" }, { at: "2026-10-03T09:00:00", title: "Ok" }]).map((item) => item.title)).toEqual(["Ok"]);
  });
  it("fills ids, normalises kinds and keeps only a true done flag", () => {
    const [first, second] = parseBridge([{ at: "2026-10-03T09:00:00", title: "A", kind: "task", done: "yes" }, { id: "r", at: "2026-10-03T10:00:00", title: "B", kind: "reminder", done: true }]);
    expect(first).toEqual({ id: "item-0", at: "2026-10-03T09:00:00", title: "A", kind: "event" });
    expect(second).toMatchObject({ id: "r", kind: "reminder", done: true });
  });
  it("sorts by instant, not by string, across offsets", () => {
    // Regression: "08:00Z" (10:00 local) sorted before "09:30+02:00" because the strings compared lexically.
    expect(parseBridge([{ at: "2026-10-03T08:00:00Z", title: "Late" }, { at: "2026-10-03T09:30:00+02:00", title: "Early" }]).map((item) => item.title)).toEqual(["Early", "Late"]);
  });
});

describe("byTime", () => {
  const item = (at: string): AgendaItem => ({ id: at, at, title: at, kind: "event" });
  it("puts unreadable times after real ones and orders them by text", () => {
    expect([item("TODAY"), item("2026-10-03T09:00:00"), item("ANYTIME")].sort(byTime).map((entry) => entry.at)).toEqual(["2026-10-03T09:00:00", "ANYTIME", "TODAY"]);
  });
});

describe("toggleDone", () => {
  const items: AgendaItem[] = [{ id: "a", at: "x", title: "Milk", kind: "reminder", done: true }, { id: "b", at: "x", title: "Meeting", kind: "event" }];
  it("flips a reminder without rewriting its title", () => {
    expect(toggleDone(items, "a")[0]).toEqual({ id: "a", at: "x", title: "Milk", kind: "reminder", done: false });
    expect(toggleDone(toggleDone(items, "a"), "a")[0]?.done).toBe(true);
  });
  it("leaves events and titles alone", () => {
    expect(toggleDone(items, "b")).toEqual(items);
  });
});

describe("when and demoAgenda", () => {
  it("degrades on an unreadable time", () => { expect(when("TODAY")).toBe("--:--"); });
  it("offers upcoming demo items in order", () => {
    const demo = demoAgenda();
    expect(demo).toHaveLength(4);
    expect([...demo].sort(byTime)).toEqual(demo);
    expect(Date.parse(demo[0]!.at)).toBeGreaterThan(Date.now() - 3_600_000);
  });
});

describe("fetchBridge", () => {
  it("parses a good response", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify([{ at: "2026-10-03T09:00:00", title: "Ok" }]))) as typeof fetch;
    expect(await fetchBridge("http://bridge/items", { fetchImpl })).toHaveLength(1);
  });
  it("reports the HTTP status", async () => {
    const fetchImpl = (async () => new Response("", { status: 404 })) as typeof fetch;
    await expect(fetchBridge("http://bridge/items", { fetchImpl })).rejects.toThrow("HTTP 404");
  });
  it("aborts a bridge that never answers", async () => {
    // Regression: plain fetch() had no timeout.
    const fetchImpl = ((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })) as typeof fetch;
    await expect(fetchBridge("http://bridge/items", { fetchImpl, timeoutMs: 10 })).rejects.toThrow("timed out");
  });
});
