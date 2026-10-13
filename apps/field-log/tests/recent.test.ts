import { describe, expect, it } from "vitest";
import { addEntry, attachToLatest, startInspection, type Inspection } from "../src/log/entries";
import { buildView, MAX_BODY_ROWS, RECENT_ENTRIES, recentEntryLines } from "../src/glasses/view";

const base = { phase: "idle" as const, severity: "note" as const, pending: null, status: "idle" as const, mock: false, locale: "en" as const };

function withEntries(texts: string[], severities: Array<"note" | "minor" | "major"> = []): Inspection {
  let inspection = startInspection("i", "Walk", 0);
  texts.forEach((text, i) => { inspection = addEntry(inspection, text, severities[i] ?? "note", 1000 + i); });
  return inspection;
}

describe("resting screen lists the last three entries", () => {
  it("shows up to three, oldest first, newest at the bottom", () => {
    const view = buildView(withEntries(["one", "two", "three", "four", "five"]), base, 60_000);
    expect(RECENT_ENTRIES).toBe(3);
    expect(view.body.slice(0, 3).map((row) => row.trim())).toEqual(["three", "four", "five"]);
    expect(view.body.join("\n")).not.toContain("one");
    expect(view.body.join("\n")).not.toContain("two");
  });

  it("shows fewer when there are fewer", () => {
    const view = buildView(withEntries(["only"]), base, 60_000);
    expect(view.body[0]?.trim()).toBe("only");
    expect(view.body).toHaveLength(3); // entry, tally, next type
  });

  it("marks major and minor entries and photos", () => {
    let inspection = withEntries(["cracked", "loose", "fine"], ["major", "minor", "note"]);
    inspection = attachToLatest(inspection, { dataUri: "data:x", mimeType: "image/jpeg", size: 10 });
    const lines = recentEntryLines(inspection, 3, 56, "en");
    expect(lines[0]).toBe("! cracked");
    expect(lines[1]).toBe("· loose");
    expect(lines[2]).toMatch(/^ {2}fine/);
    expect(lines[2]).toMatch(/photo|Foto/i);
  });

  it("cuts a long entry to one row, never wrapping into the others", () => {
    const view = buildView(withEntries(["x".repeat(200), "short"]), base, 60_000);
    for (const row of view.body) expect(row.length).toBeLessThanOrEqual(56);
    expect(view.body[0]).toMatch(/…$/);
  });

  it("keeps the tally and the next type last, and fits the body even with a server error", () => {
    const entries = withEntries(["a", "b", "c", "d"]);
    for (const status of ["idle", "error"] as const) {
      const view = buildView(entries, { ...base, voice: true, status }, 60_000);
      expect(view.body.length).toBeLessThanOrEqual(MAX_BODY_ROWS);
      expect(view.body.at(-1)).toMatch(/Next|next/);
      expect(view.body.at(-2)).toMatch(/note|minor|major|Note/i);
    }
  });
});
