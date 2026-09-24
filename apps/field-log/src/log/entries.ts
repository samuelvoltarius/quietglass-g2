/**
 * The inspection log.
 *
 * The workflow this is built around: you are walking through a building, a
 * vehicle, a site. You see something. Both hands are occupied or dirty. You
 * speak the defect, optionally attach a photo, and carry on — the log is
 * assembled for you and exported afterwards.
 */

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
export function toMarkdown(inspection: Inspection, withImages = false): string {
  const lines: string[] = [];
  lines.push("# " + inspection.title);
  lines.push("");
  lines.push("Started: " + new Date(inspection.startedAt).toISOString());
  if (inspection.finishedAt !== null) {
    lines.push("Finished: " + new Date(inspection.finishedAt).toISOString());
  }

  const counts = countBySeverity(inspection);
  lines.push("");
  lines.push("Major: " + counts.major + " · Minor: " + counts.minor + " · Notes: " + counts.note);
  lines.push("");

  let section: string | undefined;
  for (const entry of inspection.entries) {
    if (entry.section !== section) {
      section = entry.section;
      if (section) { lines.push("## " + section); lines.push(""); }
    }
    const mark = entry.severity === "major" ? "**MAJOR**"
      : entry.severity === "minor" ? "*minor*" : "note";
    lines.push("- [" + timeOf(entry.at) + "] " + mark + " — " + entry.text);
    if (entry.attachment) {
      lines.push(withImages
        ? "  ![photo](" + entry.attachment.dataUri + ")"
        : "  (photo attached, " + Math.round(entry.attachment.size / 1024) + " kB)");
    }
  }

  return lines.join("\n") + "\n";
}

export function toCsv(inspection: Inspection): string {
  const rows = [["time", "section", "severity", "text", "photo"].join(",")];
  for (const entry of inspection.entries) {
    rows.push([
      new Date(entry.at).toISOString(),
      csvField(entry.section ?? ""),
      entry.severity,
      csvField(entry.text),
      entry.attachment ? "yes" : "no",
    ].join(","));
  }
  return rows.join("\n") + "\n";
}

function csvField(value: string): string {
  return /[",\n]/.test(value) ? '"' + value.split('"').join('""') + '"' : value;
}

function timeOf(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return pad(date.getHours()) + ":" + pad(date.getMinutes());
}
