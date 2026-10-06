import { describe, expect, it } from "vitest";
import { parseBridge, parseIcs, parseIcsDate } from "../src/agenda/model";
describe("agenda import", () => {
  it("parses an ICS event", () => { const result = parseIcs("BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:1\nDTSTART:20261003T093000\nSUMMARY:Werkstatt\nEND:VEVENT\nEND:VCALENDAR", { now: new Date(2026, 9, 3) }); expect(result[0]).toMatchObject({ title: "Werkstatt", at: "2026-10-03T09:30:00" }); });
  it("parses bridge reminders", () => { expect(parseBridge([{ at: "2026-10-03T09:30:00", title: "Milch", kind: "reminder" }])[0]?.kind).toBe("reminder"); });
  it("keeps invalid dates visible", () => { expect(parseIcsDate("TODAY")).toBe("TODAY"); });
});
