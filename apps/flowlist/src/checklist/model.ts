/**
 * FlowList data model.
 *
 * A checklist is a flat, ordered list of steps. Branching is expressed as
 * explicit jumps between steps rather than as nesting: on a 576 x 288 display
 * a nested tree cannot be shown, and a flat list keeps "where am I" answerable
 * with a single number.
 */

export type StepKind = "normal" | "optional" | "critical" | "choice";

export interface Choice {
  readonly label: string;
  /** Step id to continue at. Absent means "just continue". */
  readonly goto?: string;
}

export interface Step {
  readonly id: string;
  readonly text: string;
  /** Shown on demand (long press); keeps the default view uncluttered. */
  readonly detail?: string;
  readonly kind: StepKind;
  /** Only meaningful for kind "choice". */
  readonly choices?: readonly Choice[];
  /** Section heading this step belongs to, shown in the header. */
  readonly section?: string;
}

export interface Checklist {
  readonly id: string;
  readonly title: string;
  readonly steps: readonly Step[];
  /** Free-form, shown on the phone only. */
  readonly description?: string;
}

export const EMPTY_CHECKLIST: Checklist = { id: "", title: "", steps: [] };

export function stepById(list: Checklist, id: string): Step | undefined {
  return list.steps.find((s) => s.id === id);
}

export function indexOfStep(list: Checklist, id: string): number {
  return list.steps.findIndex((s) => s.id === id);
}

/** Steps that must be completed — the denominator for progress. */
export function requiredSteps(list: Checklist): readonly Step[] {
  return list.steps.filter((s) => s.kind !== "optional");
}

export function isSkippable(step: Step): boolean {
  return step.kind === "optional";
}

export function needsConfirmation(step: Step): boolean {
  return step.kind === "critical";
}

/**
 * Jump targets that do not exist would strand the user mid-run, so every
 * importer checks this and reports the offenders as warnings.
 */
export function danglingJumps(list: Checklist): string[] {
  const ids = new Set(list.steps.map((s) => s.id));
  const bad: string[] = [];
  for (const step of list.steps) {
    for (const choice of step.choices ?? []) {
      if (choice.goto && !ids.has(choice.goto)) bad.push(choice.goto);
    }
  }
  return bad;
}
