import { describe, expect, it } from "vitest";
import type { AgendaItem } from "../src/agenda/model";
import { AGENDA_ROWS, BODY_ROWS, LINE_WIDTH, agendaLine, agendaRows, escapeHtml, fit, windowStart } from "../src/agenda/view";

const items: AgendaItem[] = Array.from({ length: 10 }, (_, index) => ({ id: String(index), at: `2026-10-03T${String(8 + index).padStart(2, "0")}:00:00`, title: `Item ${index}`, kind: index % 2 ? "reminder" : "event" }));

describe("agenda window", () => {
  it("fits the date line, a spacer and the agenda into the body", () => {
    expect(AGENDA_ROWS + 2).toBe(BODY_ROWS);
    expect(agendaRows(items, 0, "de-AT")).toHaveLength(AGENDA_ROWS);
  });
  it("keeps the cursor visible past the first page", () => {
    // Regression: only items 0-6 were drawn, so scrolling to item 8 selected an invisible row.
    const rows = agendaRows(items, 8, "de-AT");
    expect(rows.filter((row) => row.startsWith(">"))).toEqual(["> 16:00     Item 8"]);
    expect(rows.at(-1)).toContain("Item 8");
  });
  it("clamps the window at both ends", () => {
    expect(windowStart(10, 0)).toBe(0);
    expect(windowStart(10, 4)).toBe(0);
    expect(windowStart(10, 5)).toBe(1);
    expect(windowStart(10, 9)).toBe(5);
    expect(windowStart(3, 2)).toBe(0);
    expect(windowStart(0, 0)).toBe(0);
  });
  it("draws nothing for an empty agenda", () => { expect(agendaRows([], 0, "de-AT")).toEqual([]); });
});

describe("agendaLine", () => {
  it("marks reminders open or done and leaves events unboxed", () => {
    // Regression: every reminder drew "[ ]", so a bridge item arriving with done:true looked open.
    const reminder: AgendaItem = { id: "r", at: "2026-10-03T09:30:00", title: "Milk", kind: "reminder" };
    expect(agendaLine(reminder, false, "de-AT")).toBe("  09:30 [ ] Milk");
    expect(agendaLine({ ...reminder, done: true }, true, "de-AT")).toBe("> 09:30 [x] Milk");
    expect(agendaLine({ ...reminder, kind: "event" }, false, "de-AT")).toBe("  09:30     Milk");
  });
  it("cuts a long title to one line", () => {
    // Regression: long titles wrapped and pushed later rows out of the body.
    const line = agendaLine({ id: "x", at: "2026-10-03T09:30:00", title: "Quarterly planning with the whole extended leadership team", kind: "event" }, false, "de-AT");
    expect(Array.from(line)).toHaveLength(LINE_WIDTH);
    expect(line.endsWith("…")).toBe(true);
  });
});

describe("fit", () => {
  it("leaves short text alone", () => { expect(fit("short", 10)).toBe("short"); });
  it("counts emoji as one character and never splits a surrogate pair", () => {
    expect(fit("🎉🎉🎉🎉", 3)).toBe("🎉🎉…");
  });
});

describe("escapeHtml", () => {
  it("neutralises markup in imported titles", () => {
    // Regression: an ICS SUMMARY like <img onerror=...> was injected into the phone page.
    expect(escapeHtml(`<img src=x onerror="alert('x')">&`)).toBe("&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;");
  });
});
