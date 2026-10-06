import { describe, expect, it } from "vitest";
import type { Caption } from "../src/podcast/parse";
import { BODY_ROWS, LINE_WIDTH, captionRows, escapeHtml, formatTime, wrap } from "../src/podcast/view";

const short = (start: number, text: string): Caption => ({ start, end: start + 2, text });

describe("formatTime", () => {
  it("formats minutes and seconds", () => { expect([formatTime(0), formatTime(65.9), formatTime(3725)]).toEqual(["00:00", "01:05", "62:05"]); });
  it("never prints NaN or negatives", () => { expect([formatTime(Number.NaN), formatTime(-4)]).toEqual(["00:00", "00:00"]); });
});

describe("wrap", () => {
  it("fills lines up to the budget", () => { expect(wrap("aaa bbb ccc", 7)).toEqual(["aaa bbb", "ccc"]); });
  it("cuts an over-long word instead of dropping it", () => { expect(wrap("hi abcdefghij", 4)).toEqual(["hi", "abcd", "efgh", "ij"]); });
  it("returns nothing for blank input", () => { expect(wrap("  ", 10, "00:00  ")).toEqual([]); });
  it("keeps a prefix verbatim on the first line", () => { expect(wrap("aa bb", 10, "00:01  ")).toEqual(["00:01  aa", "bb"]); });
});

describe("captionRows", () => {
  it("never exceeds the body rows", () => {
    // Regression: title + spacer + four captions with spacers was 10 rows in a 7-row container.
    const captions = [0, 4, 9, 14, 20].map((start) => short(start, "Short line"));
    const rows = captionRows("Episode", captions, 0);
    expect(rows.length).toBeLessThanOrEqual(BODY_ROWS);
    expect(rows).toEqual(["EPISODE", "", "00:00  Short line", "", "00:04  Short line", "", "00:09  Short line"]);
  });
  it("wraps a long caption instead of letting the display clip it", () => {
    const long = "word ".repeat(80).trim();
    const rows = captionRows("Ep", [short(0, long), short(5, "Next")], 0);
    expect(rows).toHaveLength(BODY_ROWS);
    expect(rows.every((row) => row.length <= LINE_WIDTH)).toBe(true);
    expect(rows.at(-1)?.endsWith("…")).toBe(true);
  });
  it("starts at the cursor", () => {
    expect(captionRows("Ep", [short(0, "A"), short(4, "B")], 1)).toEqual(["EP", "", "00:04  B"]);
  });
  it("shortens an over-long episode title", () => {
    const [title] = captionRows("x".repeat(80), [], 0);
    expect(title).toHaveLength(LINE_WIDTH);
    expect(title?.endsWith("…")).toBe(true);
  });
});

describe("escapeHtml", () => {
  it("neutralises markup from feeds and transcripts", () => {
    // Regression: a feed title decoded to "<img onerror=...>" was injected into the phone page.
    expect(escapeHtml(`<img src=x onerror="a('b')">&`)).toBe("&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;");
  });
});
