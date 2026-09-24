import { describe, it, expect } from "vitest";
import { parseScript } from "../src/script/parse";
import { nextSectionStart, previousSectionStart, sectionAtParagraph } from "../src/script/model";

describe("parseScript", () => {
  it("takes the first level-1 heading as the title, not as a section", () => {
    const script = parseScript("# Keynote\n\nHello there.");
    expect(script.title).toBe("Keynote");
    expect(script.sections).toHaveLength(0);
    expect(script.paragraphs).toEqual(["Hello there."]);
  });

  it("opens a section for lower-level headings", () => {
    const script = parseScript("# Talk\n\nIntro line.\n\n## Part One\n\nBody line.");
    expect(script.sections).toEqual([{ id: "s1", title: "Part One", startParagraph: 1 }]);
  });

  it("joins wrapped lines into one paragraph but keeps blank lines as breaks", () => {
    const script = parseScript("One line\ncontinues here.\n\nSecond paragraph.");
    expect(script.paragraphs).toEqual(["One line continues here.", "Second paragraph."]);
  });

  it("keeps list items as separate beats", () => {
    const script = parseScript("- first point\n- second point");
    expect(script.paragraphs).toEqual(["first point", "second point"]);
  });

  it("strips markdown emphasis the display cannot render", () => {
    const script = parseScript("This is **bold** and *italic* and `code`.");
    expect(script.paragraphs[0]).toBe("This is bold and italic and code.");
  });

  it("keeps link text and drops the target", () => {
    expect(parseScript("See [our site](https://example.com) now.").paragraphs[0])
      .toBe("See our site now.");
  });

  it("treats plain text as prose when markdown is off", () => {
    const script = parseScript("# not a heading\n\nbody", { markdown: false });
    expect(script.title).toBe("");
    expect(script.paragraphs).toEqual(["# not a heading", "body"]);
  });

  it("uses the fallback title when no heading exists", () => {
    expect(parseScript("just words", { fallbackTitle: "Untitled" }).title).toBe("Untitled");
  });

  it("returns an empty script for empty or blank input", () => {
    expect(parseScript("").paragraphs).toEqual([]);
    expect(parseScript("   \n\n  ").paragraphs).toEqual([]);
  });

  it("normalises CRLF input", () => {
    expect(parseScript("a\r\n\r\nb").paragraphs).toEqual(["a", "b"]);
  });
});

describe("section lookup", () => {
  const script = parseScript("# T\n\np0\n\n## A\n\np1\n\np2\n\n## B\n\np3");

  it("finds the section owning a paragraph", () => {
    expect(sectionAtParagraph(script, 0)).toBeNull();
    expect(sectionAtParagraph(script, 1)?.title).toBe("A");
    expect(sectionAtParagraph(script, 2)?.title).toBe("A");
    expect(sectionAtParagraph(script, 3)?.title).toBe("B");
  });

  it("walks forward to the next section start", () => {
    expect(nextSectionStart(script, 0)).toBe(1);
    expect(nextSectionStart(script, 1)).toBe(3);
    expect(nextSectionStart(script, 3)).toBeNull();
  });

  it("returns to the start of the current section before the previous one", () => {
    expect(previousSectionStart(script, 2)).toBe(1);
    expect(previousSectionStart(script, 1)).toBeNull();
    expect(previousSectionStart(script, 3)).toBe(1);
  });
});
