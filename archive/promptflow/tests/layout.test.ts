import { describe, it, expect } from "vitest";
import { layoutScript, lineOfParagraph, wrapText } from "../src/prompter/layout";
import { parseScript } from "../src/script/parse";

describe("wrapText", () => {
  it("fills a line up to the budget", () => {
    expect(wrapText("aaa bbb ccc", 7)).toEqual(["aaa bbb", "ccc"]);
  });

  it("never drops a word longer than the budget", () => {
    const lines = wrapText("hi supercalifragilistic", 6);
    expect(lines.join("")).toContain("supercalifragilistic");
  });

  it("returns nothing for blank input", () => {
    expect(wrapText("   ", 10)).toEqual([]);
  });

  it("falls back to one line when the budget is meaningless", () => {
    expect(wrapText("a b c", 0)).toEqual(["a b c"]);
  });

  it("honours an injected measurement", () => {
    const double = (s: string) => s.length * 2;
    expect(wrapText("aaa bbb", 7, double)).toEqual(["aaa", "bbb"]);
  });
});

describe("layoutScript", () => {
  const script = parseScript("# T\n\nalpha beta gamma delta\n\nsecond");

  it("maps every line back to its paragraph", () => {
    const lines = layoutScript(script, { maxWidth: 11 });
    expect(lines.map((l) => l.paragraph)).toEqual([0, 0, 1]);
  });

  it("marks the first line of each paragraph", () => {
    const lines = layoutScript(script, { maxWidth: 11 });
    expect(lines.map((l) => l.paragraphStart)).toEqual([true, false, true]);
  });

  it("counts words per line for pacing", () => {
    const lines = layoutScript(script, { maxWidth: 11 });
    expect(lines.map((l) => l.words)).toEqual([2, 2, 1]);
  });

  it("finds the first line of a paragraph", () => {
    const lines = layoutScript(script, { maxWidth: 11 });
    expect(lineOfParagraph(lines, 1)).toBe(2);
    expect(lineOfParagraph(lines, 99)).toBe(0);
  });
});
