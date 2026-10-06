import { countBySeverity, durationSeconds, type Inspection, type Severity } from "../log/entries";
import type { SttStatus } from "../stt/provider";
import type { Locale } from "../i18n";
import { t } from "../messages";

/**
 * What the glasses show.
 *
 * During a walk the display answers two questions and nothing else: am I
 * recording, and what did I just say? Reviewing the log happens on the phone
 * afterwards — on the glasses it would only slow the walk down.
 */
export interface LogView {
  readonly header: string;
  readonly body: readonly string[];
  readonly footer: string;
}

const MIC_ON = "● MIC";

/**
 * - `idle`: between entries
 * - `pick`: choosing a quick note (no speech server needed)
 * - `recording` / `transcribing` / `review`: dictation through a speech server
 */
export type Phase = "idle" | "pick" | "recording" | "transcribing" | "review";

export interface ViewOptions {
  readonly phase: Phase;
  readonly severity: Severity;
  /** Text awaiting confirmation in the review phase. */
  readonly pending: string | null;
  readonly status: SttStatus;
  readonly mock: boolean;
  readonly lineWidth?: number;
  readonly locale?: Locale;
  /** True when a speech server is set up: tap dictates instead of picking. */
  readonly voice?: boolean;
  /** Quick notes offered in the `pick` phase; "Cancel" is appended. */
  readonly quickNotes?: readonly string[];
  /** Highlighted row in the `pick` phase, the cancel row included. */
  readonly pickIndex?: number;
}

const DEFAULT_WIDTH = 44;

/** Rows the body container holds; more are pushed off the display. */
export const MAX_BODY_ROWS = 7;
/** Characters the header holds on one line in the G2's proportional font. */
export const HEADER_WIDTH = 46;
/** The footer is a single line too. */
export const FOOTER_WIDTH = 46;

export function buildView(
  inspection: Inspection | null,
  options: ViewOptions,
  now = Date.now(),
): LogView {
  const locale = options.locale ?? "en";
  const L = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  const width = options.lineWidth ?? DEFAULT_WIDTH;

  // Never a dead end: a tap starts an inspection right here.
  if (!inspection) {
    return {
      header: "FieldLog",
      body: [L("g.none.1"), L("g.none.2")],
      footer: L("g.none.footer"),
    };
  }

  const counts = countBySeverity(inspection);
  const tally = L("g.tally", counts);

  switch (options.phase) {
    case "pick": {
      const notes = [...(options.quickNotes ?? []), L("g.cancel")];
      const index = Math.min(Math.max(0, options.pickIndex ?? 0), notes.length - 1);
      const rows = notes.map((note, i) => truncate((i === index ? "> " : "  ") + note, width));
      return {
        header: L("g.pick.header"),
        body: [...windowAround(rows, index, MAX_BODY_ROWS - 1), savedAs(options.severity, locale)],
        footer: L("g.pick.footer"),
      };
    }

    case "recording":
      return {
        header: sectionLabel(inspection),
        body: [L("g.listening"), savedAs(options.severity, locale)],
        footer: MIC_ON + (options.mock ? "  ·  " + L("g.mock") : "") + "  ·  " + L("g.recording.footer"),
      };

    case "transcribing":
      return {
        header: sectionLabel(inspection),
        body: [L("g.transcribing")],
        footer: statusLabel(options.status, locale),
      };

    // The transcript is shown before it is kept. Speech recognition is
    // imperfect and an inspection report is a document someone acts on, so a
    // wrong entry must be catchable at the moment it is made.
    case "review":
      return {
        header: L("g.review.header"),
        // The severity row always stays visible; a long transcript is cut
        // with "…" — the full text is in the log on the phone.
        body: [
          ...clampRows(wrap(options.pending ?? "", width), MAX_BODY_ROWS - 1, width),
          savedAs(options.severity, locale),
        ],
        footer: L("g.review.footer"),
      };

    case "idle":
    default: {
      // A failed connection says what to do instead of silently ignoring taps.
      const error = options.voice && options.status === "error"
        ? [L("g.serverError.1"), truncate(L("g.serverError.2"), width), ""]
        : [];
      const time = formatDuration(durationSeconds(inspection, now));
      const body = inspection.entries.length === 0
        ? [L("g.noEntries"), truncate(L("g.firstNote"), width)]
        : [lastEntryLine(inspection, width, locale), tally];
      return {
        header: sectionLabel(inspection),
        body: [...error, ...body, "", truncate(L("g.nextSeverity", { severity: severityLabel(options.severity, locale) }), width)],
        footer: truncate(L(options.voice ? "g.idle.voice" : "g.idle.quick", { time }), FOOTER_WIDTH),
      };
    }
  }
}

function sectionLabel(inspection: Inspection): string {
  return truncate(inspection.section || inspection.title, HEADER_WIDTH);
}

function lastEntryLine(inspection: Inspection, width: number, locale: Locale): string {
  const last = inspection.entries[inspection.entries.length - 1];
  if (!last) return t(locale, "g.noEntries");
  const mark = last.severity === "major" ? "! " : last.severity === "minor" ? "· " : "  ";
  const photo = last.attachment ? " " + t(locale, "g.photo") : "";
  return truncate(mark + last.text + photo, width);
}

export function severityLabel(severity: Severity, locale: Locale = "en"): string {
  return t(locale, "g.sev." + severity);
}

/** The row that says which type the entry will be filed as. */
function savedAs(severity: Severity, locale: Locale): string {
  return t(locale, "g.as", { severity: severityLabel(severity, locale) });
}

export function statusLabel(status: SttStatus, locale: Locale = "en"): string {
  switch (status) {
    case "connecting": return t(locale, "g.status.connecting");
    case "reconnecting": return t(locale, "g.status.reconnecting");
    case "error": return t(locale, "g.status.error");
    default: return t(locale, "g.status.working");
  }
}

/** A run of `size` items that keeps `index` in view. */
function windowAround(items: readonly string[], index: number, size: number): string[] {
  if (items.length <= size) return [...items];
  const start = Math.min(Math.max(0, index - Math.floor(size / 2)), items.length - size);
  return items.slice(start, start + size);
}

/** Greedy word wrap; a word longer than the line is split rather than overflowing. */
export function wrap(text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  if (maxWidth <= 0) return [text];

  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current === "" ? word : current + " " + word;
    if (candidate.length <= maxWidth) { current = candidate; continue; }
    if (current !== "") lines.push(current);
    current = word;
    while (current.length > maxWidth) {
      lines.push(current.slice(0, maxWidth));
      current = current.slice(maxWidth);
    }
  }
  if (current !== "") lines.push(current);
  return lines;
}

/** At most `max` rows; a cut is marked with an ellipsis on the last row kept. */
function clampRows(lines: readonly string[], max: number, width: number): string[] {
  if (lines.length <= max) return [...lines];
  const kept = lines.slice(0, Math.max(0, max));
  // Appending first forces truncate() to cut, so the row always ends in "…".
  if (kept.length > 0) kept[kept.length - 1] = truncate((kept[kept.length - 1] ?? "") + " …", width);
  return kept;
}

export function truncate(text: string, maxWidth: number): string {
  if (text.length <= maxWidth) return text;
  return text.slice(0, Math.max(0, maxWidth - 1)).trimEnd() + "…";
}

export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + "m";
  return Math.floor(minutes / 60) + "h " + (minutes % 60) + "m";
}
