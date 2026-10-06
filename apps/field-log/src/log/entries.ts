/**
 * The inspection log.
 *
 * The workflow this is built around: you are walking through a building, a
 * vehicle, a site. You see something. Both hands are occupied or dirty. You
 * speak the defect, optionally attach a photo, and carry on — the log is
 * assembled for you and exported afterwards.
 */

import type { Locale } from "../i18n";
import { severityName, t } from "../messages";
import { joinCsv, localDateTime, textCell, type CsvFormat } from "../csv";

export type Severity = "note" | "minor" | "major";

export interface Attachment {
  /** Data URI from the phone camera or album. */
  readonly dataUri: string;
  readonly mimeType: string;
  /** Approximate size in bytes, for the export budget. */
  readonly size: number;
}

export interface LogEntry {
  readonly id: string;
  /** What was said, after transcription — or typed on the phone. */
  readonly text: string;
  readonly severity: Severity;
  readonly at: number;
  /** Section of the walk, e.g. a room or an assembly. */
  readonly section?: string;
  readonly attachment?: Attachment;
}

export interface Inspection {
  readonly id: string;
  readonly title: string;
  readonly startedAt: number;
  readonly finishedAt: number | null;
  readonly entries: readonly LogEntry[];
  /** Current section; new entries inherit it. */
  readonly section: string;
}

export function startInspection(id: string, title: string, now: number): Inspection {
  return { id, title, startedAt: now, finishedAt: null, entries: [], section: "" };
}

export function addEntry(
  inspection: Inspection,
  text: string,
  severity: Severity,
  now: number,
): Inspection {
  const trimmed = text.trim();
  if (!trimmed) return inspection;

  const entry: LogEntry = {
    id: nextEntryId(inspection.entries),
    text: trimmed,
    severity,
    at: now,
    ...(inspection.section ? { section: inspection.section } : {}),
  };
  return { ...inspection, entries: [...inspection.entries, entry] };
}

/** Attaches a photo to the most recent entry — the one just spoken. */
export function attachToLatest(inspection: Inspection, attachment: Attachment): Inspection {
  const index = inspection.entries.length - 1;
  const latest = inspection.entries[index];
  if (!latest) return inspection;
  return {
    ...inspection,
    entries: [...inspection.entries.slice(0, index), { ...latest, attachment }],
  };
}

export function removeEntry(inspection: Inspection, id: string): Inspection {
  return { ...inspection, entries: inspection.entries.filter((e) => e.id !== id) };
}

export function setSeverity(inspection: Inspection, id: string, severity: Severity): Inspection {
  const index = inspection.entries.findIndex((e) => e.id === id);
  const entry = inspection.entries[index];
  if (!entry) return inspection;
  return {
    ...inspection,
    entries: [
      ...inspection.entries.slice(0, index),
      { ...entry, severity },
      ...inspection.entries.slice(index + 1),
    ],
  };
}

export function setSection(inspection: Inspection, section: string): Inspection {
  return { ...inspection, section: section.trim() };
}

export function finish(inspection: Inspection, now: number): Inspection {
  return inspection.finishedAt === null ? { ...inspection, finishedAt: now } : inspection;
}

export function nextEntryId(entries: readonly LogEntry[]): string {
  let n = entries.length + 1;
  const taken = new Set(entries.map((e) => e.id));
  while (taken.has("e" + n)) n++;
  return "e" + n;
}

export function countBySeverity(inspection: Inspection): Record<Severity, number> {
  const counts: Record<Severity, number> = { note: 0, minor: 0, major: 0 };
  for (const entry of inspection.entries) counts[entry.severity]++;
  return counts;
}

export function durationSeconds(inspection: Inspection, now: number): number {
  const end = inspection.finishedAt ?? now;
  return Math.max(0, Math.round((end - inspection.startedAt) / 1000));
}

/**
 * Markdown export — readable as it stands and importable anywhere.
 *
 * Photos are referenced rather than embedded, because a report with a dozen
 * base64 images is neither readable nor emailable. `withImages` inlines them
 * for the cases where a self-contained file is wanted.
 */
export function toMarkdown(inspection: Inspection, withImages = false, locale: Locale = "en"): string {
  const lines: string[] = [];
  lines.push("# " + oneLine(inspection.title));
  lines.push("");
  lines.push(t(locale, "x.started") + ": " + stamp(inspection.startedAt, locale));
  if (inspection.finishedAt !== null) {
    lines.push(t(locale, "x.finished") + ": " + stamp(inspection.finishedAt, locale));
  }

  const counts = countBySeverity(inspection);
  lines.push("");
  lines.push(t(locale, "x.counts", counts));
  lines.push("");

  let section: string | undefined;
  for (const entry of inspection.entries) {
    if (entry.section !== section) {
      section = entry.section;
      if (section) { lines.push("## " + oneLine(section)); lines.push(""); }
    }
    const name = severityName(locale, entry.severity);
    const mark = entry.severity === "major" ? "**" + name.toUpperCase() + "**"
      : entry.severity === "minor" ? "*" + name + "*" : name;
    lines.push("- [" + timeOf(entry.at) + "] " + mark + " — " + oneLine(entry.text));
    if (entry.attachment) {
      lines.push(withImages
        ? "  ![" + t(locale, "x.photoAlt") + "](" + entry.attachment.dataUri + ")"
        : "  " + t(locale, "x.photoRef", { kb: Math.round(entry.attachment.size / 1024) }));
    }
  }

  return lines.join("\n") + "\n";
}

/**
 * CSV for a spreadsheet, one row per entry, in one of two formats (see
 * src/csv.ts). The header and the type/photo columns are in the user's language.
 *
 * - `standard`: comma, LF, RFC 4180 quoting, time as ISO 8601 in UTC so it
 *   sorts and parses everywhere.
 * - `excel-de`: for opening by double-click in German or Austrian Excel — `;`,
 *   CRLF, UTF-8 BOM, the time in local time as `07.10.2026 14:05`, and the
 *   exact ISO time in an extra last column.
 *
 * There are no decimal numbers in this file. Text cells are defused against
 * formulas: a transcript starting with `=`, `+`, `-` or `@` would otherwise be
 * evaluated when the export is opened.
 */
export function toCsv(inspection: Inspection, locale: Locale = "en", format: CsvFormat = "standard"): string {
  const excel = format === "excel-de";
  const header = t(locale, "x.csvHeader").split(",");
  if (excel) header.push(t(locale, "x.csvIso"));
  return joinCsv([
    header.map((name) => textCell(name, format)),
    ...inspection.entries.map((entry) => [
      excel ? localDateTime(entry.at) : new Date(entry.at).toISOString(),
      textCell(entry.section ?? "", format),
      textCell(locale === "en" ? entry.severity : severityName(locale, entry.severity), format),
      textCell(entry.text, format),
      textCell(t(locale, entry.attachment ? "x.yes" : "x.no"), format),
      ...(excel ? [new Date(entry.at).toISOString()] : []),
    ]),
  ], format);
}

/** Keeps dictated text on its own Markdown line: a line break would end the list item. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Date and time as people read them, in local time — the report is for humans. */
function stamp(timestamp: number, locale: Locale): string {
  return new Date(timestamp).toLocaleString(locale === "de" ? "de-AT" : "en-GB", { dateStyle: "medium", timeStyle: "short" });
}

function timeOf(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return pad(date.getHours()) + ":" + pad(date.getMinutes());
}
