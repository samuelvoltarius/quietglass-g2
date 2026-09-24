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
        body: [
          ...wrap(options.pending ?? "", width),
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
  return inspection.section || inspection.title;
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

export function wrap(text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  if (maxWidth <= 0) return [text];

  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current === "" ? word : current + " " + word;
    if (candidate.length <= maxWidth) current = candidate;
    else { if (current !== "") lines.push(current); current = word; }
  }
  if (current !== "") lines.push(current);
  return lines;
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
