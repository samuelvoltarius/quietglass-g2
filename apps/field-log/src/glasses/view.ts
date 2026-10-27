import type { Inspection, LogEntry, Severity } from "../log/entries";
import { MAX_UPLOAD_SECONDS } from "../stt/provider";
import type { Locale } from "../i18n";
import { t } from "../messages";
import { armedFooter, FOOTER_WIDTH, footer } from "./footer";
import { checklistProgress, hasPhoto, itemState, roomProgress, type CheckRoom } from "../checklist/checklist";
import type { WalkCursor } from "../checklist/walk";

export { FOOTER_WIDTH };

/**
 * What the text pages of the glasses show (QUS v1): the start list, the notes
 * list, the reading view of one note, the quick-note list and the review of a
 * transcript. The resting and recording states are the cockpit image
 * (src/cockpit), not text.
 *
 * Every page is the same three parts: a header, a body of at most
 * MAX_BODY_ROWS rows and ONE footer line with the gestures that do something.
 */
export interface LogView {
  readonly header: string;
  readonly body: readonly string[];
  readonly footer: string;
}

/**
 * - `idle`: between entries
 * - `pick`: choosing a quick note (no speech server needed)
 * - `recording` / `transcribing` / `review`: dictation through a speech server
 */
export type Phase = "idle" | "pick" | "recording" | "transcribing" | "review";

/** The choice under review: 0 = keep, 1 = keep and take a photo, 2 = discard. A swipe moves it, a tap carries it out. */
export type ReviewChoice = 0 | 1 | 2;

export type LiveView = "off" | "connecting" | "live" | "lost";

/** Why a tap did not do what it usually does. */
export type FieldNotice = "micDenied" | "noPhoto" | "heardNothing";

/** Rows the body container holds; more are pushed off the display. */
export const MAX_BODY_ROWS = 7;
/** Rows a list shows at most (QUS 1.3). */
export const VISIBLE_ROWS = 5;
/** Characters one row holds in the G2's proportional font. */
export const LINE_WIDTH = 56;
export const HEADER_WIDTH = 56;

export type LiveWord = "live" | "local" | "demo";

/** `live` with a speech server, `local` with quick notes only, `demo` for the sample data. */
export function liveWord(voice: boolean, demo: boolean): LiveWord {
  return demo ? "demo" : voice ? "live" : "local";
}

/** `FIELDLOG · ● live` (QUS 1.1): the mode, a dot while live, the state as a word otherwise. */
export function headerLine(locale: Locale, title: string, word: LiveWord): string {
  const state = word === "live" ? "● " + t(locale, "g.live") : word === "demo" ? t(locale, "g.demoWord") : t(locale, "g.localWord");
  return truncate(`${title} · ${state}`, HEADER_WIDTH);
}

export function severityLabel(severity: Severity, locale: Locale = "en"): string {
  return t(locale, "g.sev." + severity);
}

// ---- start page ---------------------------------------------------------------------

export type StartRow =
  /** The room-by-room checklist of the walk. Only when the walk has one. */
  | { readonly kind: "checklist"; readonly done: number; readonly total: number }
  /** Opens the recorder (speech server) or the quick-note list (none). */
  | { readonly kind: "record" }
  /** The notes of the open walk, newest first. Only when there are some. */
  | { readonly kind: "notes"; readonly count: number }
  /** The type of the next entry; a tap sets the next one. */
  | { readonly kind: "type" };

/** Progress of the walk's checklist, for the start list. */
export interface ChecklistRow { readonly done: number; readonly total: number }

/**
 * At most three entries (QUS 1.1): record, the notes (only when there are some), the type.
 * A walk with a checklist starts with it instead, and its type row goes (a defect on a checklist
 * item takes its type from the item: critical = major, otherwise minor).
 */
export function startRows(entryCount: number, checklist: ChecklistRow | null = null): StartRow[] {
  const notes = entryCount > 0 ? [{ kind: "notes", count: entryCount } as const] : [];
  if (checklist) return [{ kind: "checklist", done: checklist.done, total: checklist.total }, { kind: "record" }, ...notes];
  return [{ kind: "record" }, ...notes, { kind: "type" }];
}

export interface StartOptions {
  readonly locale: Locale;
  readonly voice: boolean;
  readonly demo: boolean;
  readonly severity: Severity;
  readonly entryCount: number;
  readonly checklist?: ChecklistRow | null;
}

function startLabel(row: StartRow, options: StartOptions): string {
  const { locale } = options;
  switch (row.kind) {
    case "checklist": return t(locale, "g.start.check", { done: row.done, total: row.total });
    case "record": return t(locale, options.voice ? "g.start.record" : "g.start.quick");
    case "notes": return t(locale, "g.start.notes", { n: row.count });
    case "type": return t(locale, "g.start.type", { severity: severityLabel(options.severity, locale) });
  }
}

export function startView(cursor: number, options: StartOptions): LogView {
  const { locale } = options;
  const rows = startRows(options.entryCount, options.checklist ?? null);
  const at = Math.min(Math.max(0, cursor), rows.length - 1);
  const selected = rows[at];
  const body = rows.map((row, index) => truncate((index === at ? "● " : "  ") + startLabel(row, options), LINE_WIDTH));
  const tap = selected?.kind === "record" ? t(locale, options.voice ? "g.w.speak" : "g.w.pickNote")
    : selected?.kind === "notes" || selected?.kind === "checklist" ? t(locale, "g.w.open")
      : t(locale, "g.w.setType");
  return {
    header: headerLine(locale, t(locale, "g.title"), liveWord(options.voice, options.demo)),
    body,
    footer: footer(locale, { tap, swipe: t(locale, "g.w.pick") }, "exit"),
  };
}

// ---- notes list and reading view -----------------------------------------------------

/** The window of `rows` around the cursor: where it starts. */
export function windowStart(total: number, cursor: number, rows: number): number {
  return Math.max(0, Math.min(cursor - Math.floor(rows / 2), total - rows));
}

/** Entries newest first: the list the glasses show. */
export function newestFirst(inspection: Inspection): LogEntry[] {
  return [...inspection.entries].reverse();
}

function entryTime(entry: LogEntry): string {
  const date = new Date(entry.at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** One row of the notes list: `● 14:02 ! Fenster …` (a dot for the selection, `!` for important). */
export function noteRow(entry: LogEntry, selected: boolean, locale: Locale): string {
  const mark = entry.severity === "major" ? "! " : entry.severity === "minor" ? "· " : "";
  const photo = entry.attachment ? " " + t(locale, "g.photo") : "";
  return truncate(`${selected ? "● " : "  "}${entryTime(entry)} ${mark}${entry.text}${photo}`, LINE_WIDTH);
}

export function notesView(inspection: Inspection, cursor: number, locale: Locale, voice: boolean, demo: boolean): LogView {
  const list = newestFirst(inspection);
  const at = Math.min(Math.max(0, cursor), Math.max(0, list.length - 1));
  const first = windowStart(list.length, at, VISIBLE_ROWS);
  return {
    header: headerLine(locale, t(locale, "g.h.notes"), liveWord(voice, demo)),
    body: list.slice(first, first + VISIBLE_ROWS).map((entry, index) => noteRow(entry, first + index === at, locale)),
    footer: footer(locale, { tap: t(locale, "g.w.open"), swipe: t(locale, "g.w.pick") }, "back"),
  };
}

/** The text of one note, split into pages of `rows` rows. */
export function readPages(text: string, rows: number = MAX_BODY_ROWS - 1, width: number = LINE_WIDTH): string[][] {
  const lines = wrap(text, width);
  if (lines.length === 0) return [[""]];
  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += rows) pages.push(lines.slice(i, i + rows));
  return pages;
}

/** How many pages the reading view has for the note at `index` (newest first). */
export function readPageCount(inspection: Inspection, index: number, locale: Locale): number {
  const entry = newestFirst(inspection)[index];
  if (!entry) return 1;
  return readPages(entry.text + (entry.attachment ? " " + t(locale, "g.photo") : "")).length;
}

/** The reading view of one note: a context header, the text, the way on. */
export function readView(inspection: Inspection, index: number, page: number, locale: Locale): LogView {
  const list = newestFirst(inspection);
  const at = Math.min(Math.max(0, index), Math.max(0, list.length - 1));
  const entry = list[at];
  if (!entry) return { header: t(locale, "g.h.notes"), body: [""], footer: footer(locale, {}, "back") };
  const pages = readPages(entry.text + (entry.attachment ? " " + t(locale, "g.photo") : ""));
  const shown = Math.min(Math.max(0, page), pages.length - 1);
  const more = pages.length > 1 ? ` ${shown + 1}/${pages.length}` : "";
  const head = t(locale, "g.h.read", { i: at + 1, n: list.length, time: entryTime(entry), severity: severityLabel(entry.severity, locale) });
  return {
    header: truncate(head, HEADER_WIDTH - more.length) + more,
    body: pages[shown] ?? [""],
    footer: footer(locale, { tap: t(locale, "g.w.next"), ...(pages.length > 1 ? { swipe: t(locale, "g.w.page") } : {}) }, "back"),
  };
}

// ---- quick notes and review ----------------------------------------------------------

export interface PickOptions {
  readonly locale: Locale;
  readonly severity: Severity;
  readonly quickNotes: readonly string[];
  /** Highlighted row, the cancel row included. */
  readonly pickIndex: number;
  /** Recording a defect of this checklist item: the header names it. */
  readonly forItem?: string;
}

/** The quick-note list: five rows, a dot on the highlighted one, "Cancel" last. */
export function pickView(options: PickOptions): LogView {
  const { locale } = options;
  const notes = [...options.quickNotes, t(locale, "g.cancel")];
  const index = Math.min(Math.max(0, options.pickIndex), notes.length - 1);
  const rows = notes.map((note, i) => truncate((i === index ? "● " : "  ") + note, LINE_WIDTH));
  const first = windowStart(rows.length, index, VISIBLE_ROWS);
  return {
    header: options.forItem !== undefined
      ? truncate(t(locale, "g.h.defect") + " · " + options.forItem, HEADER_WIDTH)
      : truncate(t(locale, "g.h.pickType", { severity: severityLabel(options.severity, locale) }), HEADER_WIDTH),
    body: rows.slice(first, first + VISIBLE_ROWS),
    footer: footer(locale, { tap: t(locale, "g.w.save"), swipe: t(locale, "g.w.pick") }, "back"),
  };
}

export interface ReviewOptions {
  readonly locale: Locale;
  readonly severity: Severity;
  readonly pending: string | null;
  readonly reviewChoice: ReviewChoice;
  /** "Discard" was tapped once: the footer says a second tap discards. */
  readonly confirmDiscard: boolean;
  /** The text covers only the last part of a long recording. */
  readonly truncated: boolean;
}

/** Text rows the review shows above its three choices. */
const REVIEW_TEXT_ROWS = 3;

/** The transcript is shown before it is kept (a report is a document someone acts on). */
export function reviewView(options: ReviewOptions): LogView {
  const { locale } = options;
  const choice = options.reviewChoice;
  const armed = choice === 2 && options.confirmDiscard;
  const row = (selected: boolean, text: string): string => (selected ? "● " : "  ") + text;
  const head = options.truncated
    ? t(locale, "g.h.reviewCut", { seconds: MAX_UPLOAD_SECONDS })
    : t(locale, "g.h.reviewType", { severity: severityLabel(options.severity, locale) });
  return {
    header: truncate(head, HEADER_WIDTH),
    // The three choices always stay visible; a long transcript is cut with "…" - the full text is in the log on the phone.
    body: [
      ...clampRows(wrap(options.pending ?? "", LINE_WIDTH), REVIEW_TEXT_ROWS, LINE_WIDTH),
      row(choice === 0, t(locale, "g.choice.keep")),
      row(choice === 1, t(locale, "g.choice.keepPhoto")),
      row(choice === 2, (armed ? t(locale, "g.choice.sure") : "") + t(locale, "g.choice.discard")),
    ],
    // 2× does nothing here (the text is not lost by a slip); while armed it cancels.
    footer: armed
      ? armedFooter(locale, t(locale, "g.a.discard"))
      : footer(locale, { tap: t(locale, choice === 0 ? "g.w.keep" : choice === 1 ? "g.w.keepPhoto" : "g.w.discard"), swipe: t(locale, "g.w.choice") }, null),
  };
}

// ---- checklist --------------------------------------------------------------------------

/** One room of the overview: `● Küche 5/7 · 1 [Foto] fehlt` — the name gives way, the numbers never. */
export function roomRow(inspection: Inspection, room: CheckRoom, selected: boolean, locale: Locale): string {
  const progress = roomProgress(inspection, room);
  const extra = [
    ...(progress.missingPhotos > 0 ? [t(locale, "g.room.photo", { n: progress.missingPhotos })] : []),
    ...(progress.criticalOpen > 0 ? [t(locale, "g.room.critical", { n: progress.criticalOpen })] : []),
  ];
  const tail = ` ${progress.done}/${progress.total}` + extra.map((part) => " · " + part).join("");
  const lead = selected ? "● " : "  ";
  return truncate(lead + truncate(room.name, Math.max(6, LINE_WIDTH - lead.length - tail.length)) + tail, LINE_WIDTH);
}

/** The rooms of the checklist with their progress; a tap walks the room. */
export function roomsView(inspection: Inspection, cursor: number, locale: Locale): LogView {
  const rooms = inspection.checklist?.rooms ?? [];
  const total = checklistProgress(inspection);
  const at = Math.min(Math.max(0, cursor), Math.max(0, rooms.length - 1));
  const first = windowStart(rooms.length, at, VISIBLE_ROWS);
  return {
    header: truncate(t(locale, "g.h.rooms", { done: total.done, total: total.total }), HEADER_WIDTH),
    body: rooms.slice(first, first + VISIBLE_ROWS).map((room, index) => roomRow(inspection, room, first + index === at, locale)),
    footer: footer(locale, { tap: t(locale, "g.w.open"), swipe: t(locale, "g.w.pick") }, "back"),
  };
}

/** Text rows of the item itself above its state and the two choices. */
const ITEM_TEXT_ROWS = 2;

/**
 * One item of a room: its text (`!` when critical), its state, the photo it
 * needs, and the two choices OK / Defect. On a critical item the first tap on
 * OK only arms it (`SICHER? OK`, the footer says what a second tap does).
 */
export function itemView(inspection: Inspection, room: CheckRoom, cursor: WalkCursor, armed: boolean, locale: Locale): LogView {
  const index = Math.min(Math.max(0, cursor.item), Math.max(0, room.items.length - 1));
  const item = room.items[index];
  if (!item) return { header: truncate(room.name, HEADER_WIDTH), body: [""], footer: footer(locale, {}, "back") };
  const state = itemState(inspection, item);
  const position = ` · ${index + 1}/${room.items.length}` + (item.critical ? " · " + t(locale, "g.item.critical") : "");
  const photo = item.photo ? [t(locale, hasPhoto(inspection, item) ? "g.item.photoGiven" : "g.item.photoNeeded")] : [];
  const showArmed = armed && cursor.choice === 0;
  const row = (selected: boolean, text: string): string => (selected ? "● " : "  ") + text;
  return {
    header: truncate(room.name, Math.max(6, HEADER_WIDTH - position.length)) + position,
    body: [
      ...clampRows(wrap((item.critical ? "! " : "") + item.text, LINE_WIDTH), ITEM_TEXT_ROWS, LINE_WIDTH),
      t(locale, "g.item." + state),
      ...photo,
      row(cursor.choice === 0, (showArmed ? t(locale, "g.choice.sure") : "") + t(locale, "g.choice.ok")),
      row(cursor.choice === 1, t(locale, "g.choice.defect")),
    ],
    footer: showArmed
      ? armedFooter(locale, t(locale, "g.a.ok"))
      : footer(locale, {
        tap: cursor.choice === 1 ? t(locale, "g.w.defect") : t(locale, item.critical ? "g.w.okCritical" : "g.w.ok"),
        swipe: t(locale, "g.w.pick"),
      }, "back"),
  };
}

// ---- helpers --------------------------------------------------------------------------

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

/** The length of a walk: 12m or 1h 5m. */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + "m";
  return Math.floor(minutes / 60) + "h " + (minutes % 60) + "m";
}
