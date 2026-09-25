import { describe, it, expect } from "vitest";
import { parseMarkdown, parsePack, toPack } from "../src/checklist/parse";

const BREAK = "\n";

describe("markdown import", () => {
  it("reads a plain task list", () => {
    const { checklist } = parseMarkdown(["# Packing", "- [ ] passport", "- [ ] charger"].join(BREAK));
    expect(checklist.title).toBe("Packing");
    expect(checklist.steps.map((s) => s.text)).toEqual(["passport", "charger"]);
  });

  it("accepts ticked boxes and plain bullets alike", () => {
    const { checklist } = parseMarkdown(["- [x] done already", "- just a bullet"].join(BREAK));
    expect(checklist.steps).toHaveLength(2);
  });

  it("opens sections on second-level headings", () => {
    const { checklist } = parseMarkdown(
      ["# Trip", "## Documents", "- passport", "## Tech", "- charger"].join(BREAK),
    );
    expect(checklist.steps[0]?.section).toBe("Documents");
    expect(checklist.steps[1]?.section).toBe("Tech");
  });

  it("marks optional and critical steps from their markers", () => {
    const { checklist } = parseMarkdown(
      ["- sunscreen (optional)", "- (!) turn off the gas", "- normal"].join(BREAK),
    );
    expect(checklist.steps[0]).toMatchObject({ text: "sunscreen", kind: "optional" });
    expect(checklist.steps[1]).toMatchObject({ text: "turn off the gas", kind: "critical" });
    expect(checklist.steps[2]?.kind).toBe("normal");
  });

  it("attaches an indented line as the step detail", () => {
    const { checklist } = parseMarkdown(["- check oil", "    engine must be cold"].join(BREAK));
    expect(checklist.steps).toHaveLength(1);
    expect(checklist.steps[0]?.detail).toBe("engine must be cold");
  });

  it("warns instead of failing on an empty list", () => {
    const result = parseMarkdown("# Nothing here");
    expect(result.checklist.steps).toHaveLength(0);
    expect(result.warnings).toContain("No steps found.");
  });

  it("names an untitled list rather than leaving it blank", () => {
    expect(parseMarkdown("- one").checklist.title).toBe("Untitled checklist");
  });

  it("handles CRLF input", () => {
    expect(parseMarkdown("- a\r\n- b").checklist.steps).toHaveLength(2);
  });
});

describe("pack import", () => {
  const pack = JSON.stringify({
    id: "preflight",
    title: "Pre-flight",
    description: "Before every shoot",
    steps: [
      { id: "battery", text: "Check battery", kind: "critical" },
      { id: "card", text: "Format card", detail: "Two cards for long days" },
      { id: "ask", text: "Shooting indoors?", choices: [
        { label: "Yes", goto: "lights" },
        { label: "No", goto: "nd" },
      ] },
      { id: "lights", text: "Set up lights" },
      { id: "nd", text: "Fit ND filter", kind: "optional" },
    ],
  });

  it("reads every field", () => {
    const { checklist, warnings } = parsePack(pack);
    expect(warnings).toEqual([]);
    expect(checklist.title).toBe("Pre-flight");
    expect(checklist.description).toBe("Before every shoot");
    expect(checklist.steps).toHaveLength(5);
    expect(checklist.steps[0]?.kind).toBe("critical");
    expect(checklist.steps[1]?.detail).toBe("Two cards for long days");
  });

  it("infers the choice kind from the presence of choices", () => {
    const step = parsePack(pack).checklist.steps[2];
    expect(step?.kind).toBe("choice");
    expect(step?.choices).toHaveLength(2);
  });

  it("reports a jump to a step that does not exist", () => {
    const broken = JSON.stringify({
      steps: [{ id: "a", text: "go", choices: [{ label: "x", goto: "ghost" }] }],
    });
    expect(parsePack(broken).warnings.join(" ")).toContain("ghost");
  });

  it("drops steps without text and says so", () => {
    const result = parsePack(JSON.stringify({ steps: [{ text: "" }, { text: "real" }] }));
    expect(result.checklist.steps).toHaveLength(1);
    expect(result.warnings.join(" ")).toContain("no text");
  });

  it("fails softly on invalid JSON", () => {
    const result = parsePack("{oops");
    expect(result.checklist.steps).toEqual([]);
    expect(result.warnings).toContain("Not valid JSON.");
  });

  it("ignores unknown fields so newer packs still load", () => {
    const future = JSON.stringify({
      title: "Future", futureFlag: true,
      steps: [{ text: "step", unknownField: 42 }],
    });
    expect(parsePack(future).checklist.steps).toHaveLength(1);
  });

  it("round-trips through toPack without losing anything", () => {
    const original = parsePack(pack).checklist;
    const again = parsePack(toPack(original)).checklist;
    expect(again.steps).toEqual(original.steps);
    expect(again.title).toBe(original.title);
    expect(again.description).toBe(original.description);
  });

  it("stamps the format marker so packs are identifiable", () => {
    expect(JSON.parse(toPack(parsePack(pack).checklist)).format).toBe("quietglass/flowlist@1");
  });
});
