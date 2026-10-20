import type { CallSheet, ScheduleRow } from "../api/types";
import { clockMinutes } from "../api/types";
import type { Locale } from "../i18n";
import { footer } from "../glasses/footer";
import { minutesText } from "../glasses/views";
import { t } from "../messages";
import { hhmm } from "../sun/light";
import type { LightModel } from "../sun/model";

/**
 * What the day cockpit shows (QUS v1), decided without drawing: the one
 * headline (the next scene), the label/value cells, the day timeline for the
 * left half and the single hint line. compose.ts only lays this out.
 */

export interface DayCell {
  readonly label: string;
  readonly value: string;
  /** Drawn with a frame round it. */
  readonly alert?: boolean;
}

export type EntryState = "past" | "now" | "next" | "later";

export interface DayEntry {
  readonly time: string;
  readonly what: string;
  readonly state: EntryState;
}

export interface DayModel {
  readonly title: string;
  readonly clock: string;
  /** One or two lines, already upper case. */
  readonly headline: readonly string[];
  readonly cells: readonly DayCell[];
  /** The rows of the timeline window (at most TIMELINE_ROWS). */
  readonly timeline: readonly DayEntry[];
  /** Rows of the schedule hidden above and below the window. */
  readonly hiddenBefore: number;
  readonly hiddenAfter: number;
  readonly caption: string;
  readonly hint: string;
}

export interface DayInput {
  readonly sheet: CallSheet;
  readonly now: Date;
  readonly locale: Locale;
  /** The customer's name when the server knows customers. */
  readonly customer: string;
  readonly light: LightModel | null;
  readonly demo: boolean;
}

export const TIMELINE_ROWS = 4;
const DASH = "–";

interface Timed { readonly row: ScheduleRow; readonly minutes: number }

/** The schedule rows that carry a readable time, in clock order. */
export function timedRows(sheet: CallSheet): Timed[] {
  const out: Timed[] = [];
  for (const row of sheet.schedule) {
    const minutes = clockMinutes(row.time);
    if (minutes !== null) out.push({ row, minutes });
  }
  return out.sort((a, b) => a.minutes - b.minutes);
}

/** "19:12" - when the next golden or blue hour starts; "jetzt" while the golden hour runs. */
export function lightCell(light: LightModel | null, locale: Locale): string {
  if (!light || !light.ok || !light.span) return DASH;
  if (light.golden) return t(locale, "g.f.now");
  return light.span.split("–")[0] ?? DASH;
}

export function dayModel(input: DayInput): DayModel {
  const { sheet, now, locale } = input;
  const L = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  const rows = timedRows(sheet);
  const minutes = now.getHours() * 60 + now.getMinutes();
  const nextIndex = rows.findIndex((entry) => entry.minutes > minutes);
  const nowIndex = nextIndex === -1 ? rows.length - 1 : nextIndex - 1;
  const next = nextIndex >= 0 ? rows[nextIndex] : undefined;

  let headline: string[];
  if (rows.length === 0) headline = [L("g.day.none")];
  else if (next) headline = [next.row.time.trim().slice(0, 5), next.row.what.toUpperCase()];
  else headline = [L("g.day.over")];

  const last = rows[rows.length - 1];
  const cells: DayCell[] = [
    { label: L("g.day.scene"), value: rows.length === 0 ? DASH : `${next ? nextIndex + 1 : rows.length}/${rows.length}` },
    { label: L("g.day.place"), value: sheet.location.trim() || DASH },
    { label: L("g.day.client"), value: input.customer.trim() || sheet.contact.trim() || DASH },
    { label: L("g.day.call"), value: sheet.call.trim() || DASH },
    { label: L("g.day.end"), value: last ? last.row.time.trim().slice(0, 5) : DASH },
    { label: L("g.day.light"), value: lightCell(input.light, locale) },
  ];

  // The window keeps the running (or next) row in view.
  const anchor = nowIndex >= 0 ? nowIndex : 0;
  const first = Math.max(0, Math.min(anchor - 1, rows.length - TIMELINE_ROWS));
  const window = rows.slice(first, first + TIMELINE_ROWS);
  const timeline = window.map((entry, offset): DayEntry => {
    const index = first + offset;
    const state: EntryState = index === nextIndex ? "next" : index === nowIndex ? "now" : index < nowIndex || nextIndex === -1 ? "past" : "later";
    return { time: entry.row.time.trim().slice(0, 5), what: entry.row.what, state };
  });

  const caption = next ? L("g.day.in", { when: minutesText(next.minutes - minutes) }) : input.demo ? L("g.demoWord") : sheet.date || "";
  return {
    title: L("g.title"),
    clock: hhmm(now.getTime()),
    headline,
    cells,
    timeline,
    hiddenBefore: first,
    hiddenAfter: Math.max(0, rows.length - first - window.length),
    caption,
    hint: footer(locale, { tap: L("g.f.light") }, "back"),
  };
}

/** A key that changes exactly when what the cockpit would draw changes. */
export function dayKey(model: DayModel): string {
  return JSON.stringify([model.clock, model.headline, model.cells, model.timeline, model.hiddenBefore, model.hiddenAfter, model.caption, model.hint]);
}
