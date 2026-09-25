import { danglingJumps, type Checklist, type Choice, type Step, type StepKind } from "./model";

/**
 * Two import formats.
 *
 * **Markdown** is what people already have: task lists pasted out of notes.
 * **JSON pack** is the shareable format, which round-trips every feature
 * including branching, so checklists can be published and exchanged.
 */

export interface ParseResult {
  readonly checklist: Checklist;
  /** Non-fatal problems. The checklist is still usable. */
  readonly warnings: readonly string[];
}

const TASK = /^\s*[-*+]\s*\[[ xX]\]\s*(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const INDENTED = /^\s{2,}\S/;

/**
 * Markdown rules, chosen so an ordinary task list works unchanged:
 * - `# Heading` titles the list, `## Heading` opens a section
 * - `- [ ] text` or `- text` is a step
 * - a trailing `(optional)` makes it skippable, `(!)` makes it critical
 * - an indented line under a step becomes that step's detail text
 */
export function parseMarkdown(raw: string, id = "imported"): ParseResult {
  const warnings: string[] = [];
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");

  let title = "";
  let section: string | undefined;
  const steps: Step[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;

    const heading = HEADING.exec(trimmed);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      const text = (heading[2] ?? "").trim();
      if (level === 1 && !title) title = text;
      else section = text;
      continue;
    }

    // An indented continuation line is detail for the step above it.
    if (INDENTED.test(line) && steps.length > 0) {
      const last = steps[steps.length - 1];
      if (last) {
        steps[steps.length - 1] = {
          ...last,
          detail: last.detail ? last.detail + " " + trimmed : trimmed,
        };
      }
      continue;
    }

    const task = TASK.exec(line);
    const bullet = task ? null : BULLET.exec(line);
    const body = task?.[1] ?? bullet?.[1];
    if (body === undefined) continue;

    const marked = readMarkers(body.trim());
    if (!marked.text) {
      warnings.push("Skipped a step with no text.");
      continue;
    }

    steps.push({
      id: "s" + (steps.length + 1),
      text: marked.text,
      kind: marked.kind,
      ...(section === undefined ? {} : { section }),
    });
  }

  if (steps.length === 0) warnings.push("No steps found.");

  return {
    checklist: { id, title: title || "Untitled checklist", steps },
    warnings,
  };
}

function readMarkers(body: string): { text: string; kind: StepKind } {
  let text = body;
  let kind: StepKind = "normal";

  if (text.includes("(!)")) {
    kind = "critical";
    text = text.split("(!)").join("").trim();
  }
  if (/\(optional\)\s*$/i.test(text)) {
    kind = "optional";
    text = text.replace(/\(optional\)\s*$/i, "").trim();
  }
  return { text, kind };
}

/**
 * The shareable pack format. Unknown fields are ignored, so a pack written for
 * a newer FlowList still loads in an older one.
 */
export function parsePack(raw: string): ParseResult {
  const warnings: string[] = [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { checklist: { id: "", title: "", steps: [] }, warnings: ["Not valid JSON."] };
  }

  const root = (value ?? {}) as Record<string, unknown>;
  const rawSteps = Array.isArray(root["steps"]) ? root["steps"] : [];
  const steps: Step[] = [];

  rawSteps.forEach((candidate, index) => {
    const s = (candidate ?? {}) as Record<string, unknown>;
    const text = typeof s["text"] === "string" ? s["text"].trim() : "";
    if (!text) {
      warnings.push("Step " + (index + 1) + " has no text and was dropped.");
      return;
    }

    const choices = readChoices(s["choices"]);
    const id = typeof s["id"] === "string" && s["id"] ? s["id"] : "s" + (index + 1);

    steps.push({
      id,
      text,
      kind: readKind(s["kind"], choices.length > 0),
      ...(typeof s["detail"] === "string" ? { detail: s["detail"] } : {}),
      ...(typeof s["section"] === "string" ? { section: s["section"] } : {}),
      ...(choices.length > 0 ? { choices } : {}),
    });
  });

  if (steps.length === 0) warnings.push("No steps found.");

  const checklist: Checklist = {
    id: typeof root["id"] === "string" ? root["id"] : "imported",
    title: typeof root["title"] === "string" ? root["title"] : "Untitled checklist",
    steps,
    ...(typeof root["description"] === "string" ? { description: root["description"] } : {}),
  };

  for (const target of danglingJumps(checklist)) {
    warnings.push('A step jumps to "' + target + '", which does not exist.');
  }

  return { checklist, warnings };
}

function readChoices(value: unknown): Choice[] {
  if (!Array.isArray(value)) return [];
  const choices: Choice[] = [];
  for (const candidate of value) {
    const c = (candidate ?? {}) as Record<string, unknown>;
    const label = typeof c["label"] === "string" ? c["label"].trim() : "";
    if (!label) continue;
    choices.push({ label, ...(typeof c["goto"] === "string" ? { goto: c["goto"] } : {}) });
  }
  return choices;
}

function readKind(value: unknown, hasChoices: boolean): StepKind {
  if (hasChoices) return "choice";
  if (value === "optional" || value === "critical" || value === "choice") return value;
  return "normal";
}

/** Serialises a checklist as a shareable pack. */
export function toPack(list: Checklist): string {
  return JSON.stringify(
    {
      format: "quietglass/flowlist@1",
      id: list.id,
      title: list.title,
      ...(list.description ? { description: list.description } : {}),
      steps: list.steps.map((s) => ({
        id: s.id,
        text: s.text,
        kind: s.kind,
        ...(s.detail ? { detail: s.detail } : {}),
        ...(s.section ? { section: s.section } : {}),
        ...(s.choices ? { choices: s.choices } : {}),
      })),
    },
    null,
    2,
  );
}
