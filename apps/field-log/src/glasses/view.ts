import { countBySeverity, durationSeconds, type Inspection, type Severity } from "../log/entries";
import type { SttStatus } from "../stt/provider";

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

export type Phase = "idle" | "recording" | "transcribing" | "review";

export interface ViewOptions {
  readonly phase: Phase;
  readonly severity: Severity;
  /** Text awaiting confirmation in the review phase. */
  readonly pending: string | null;
  readonly status: SttStatus;
  readonly mock: boolean;
  readonly lineWidth?: number;
}

const DEFAULT_WIDTH = 44;

/** Rows the body container holds; more are pushed off the display. */
export const MAX_BODY_ROWS = 7;
/** Characters the header holds on one line in the G2's proportional font. */
export const HEADER_WIDTH = 46;

export function buildView(
  inspection: Inspection | null,
  options: ViewOptions,
  now = Date.now(),
): LogView {
  if (!inspection) {
    return {
      header: "FieldLog",
      body: ["No inspection running.", "Start one in the phone app."],
      footer: "",
    };
  }

  const width = options.lineWidth ?? DEFAULT_WIDTH;
  const counts = countBySeverity(inspection);
  const tally = counts.major + " major · " + counts.minor + " minor · " + counts.note + " notes";

  switch (options.phase) {
    case "recording":
      return {
        header: sectionLabel(inspection),
        body: ["Listening…", severityLabel(options.severity)],
        footer: MIC_ON + (options.mock ? "  ·  MOCK" : "") + "  ·  tap = stop",
      };

    case "transcribing":
      return {
        header: sectionLabel(inspection),
        body: ["Transcribing…"],
        footer: statusLabel(options.status),
      };

    // The transcript is shown before it is kept. Speech recognition is
    // imperfect and an inspection report is a document someone acts on, so a
    // wrong entry must be catchable at the moment it is made.
    case "review":
      return {
        header: "Keep this?",
        // The severity row always stays visible; a long transcript is cut
        // with "…" — the full text is in the log on the phone.
        body: [
          ...clampRows(wrap(options.pending ?? "", width), MAX_BODY_ROWS - 1, width),
          severityLabel(options.severity),
        ],
        footer: "tap = keep  ·  swipe = discard  ·  hold = photo",
      };

    case "idle":
    default:
      return {
        header: sectionLabel(inspection),
        body: [
          lastEntryLine(inspection, width),
          tally,
        ].filter(Boolean),
        footer: formatDuration(durationSeconds(inspection, now)) + "  ·  tap = record",
      };
  }
}

function sectionLabel(inspection: Inspection): string {
  return truncate(inspection.section || inspection.title, HEADER_WIDTH);
}

function lastEntryLine(inspection: Inspection, width: number): string {
  const last = inspection.entries[inspection.entries.length - 1];
  if (!last) return "No entries yet.";
  const mark = last.severity === "major" ? "! " : last.severity === "minor" ? "· " : "  ";
  const photo = last.attachment ? " [photo]" : "";
  return truncate(mark + last.text + photo, width);
}

export function severityLabel(severity: Severity): string {
  switch (severity) {
    case "major": return "MAJOR";
    case "minor": return "minor";
    default: return "note";
  }
}

export function statusLabel(status: SttStatus): string {
  switch (status) {
    case "connecting": return "connecting…";
    case "reconnecting": return "reconnecting…";
    case "error": return "speech server error";
    default: return "working…";
  }
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
