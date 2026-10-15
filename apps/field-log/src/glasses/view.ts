import { countBySeverity, durationSeconds, type Inspection, type Severity } from "../log/entries";
import { MAX_UPLOAD_SECONDS, type SttStatus } from "../stt/provider";
import type { Locale } from "../i18n";
import { t } from "../messages";
import { armedFooter, FOOTER_WIDTH, footer } from "./footer";

export { FOOTER_WIDTH };

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
  /** Something the user asked for did not happen: said on the resting screen. */
  readonly notice?: FieldNotice | null;
  /** The choice under review: 0 = keep, 1 = keep and take a photo, 2 = discard. A swipe moves it, a tap carries it out. */
  readonly reviewChoice?: ReviewChoice;
  /** "Discard" was tapped once: the footer says a second tap discards. */
  readonly confirmDiscard?: boolean;
  /** The help page is open. */
  readonly help?: boolean;
  /** The page carries the glasses' side menu (SIDE_MENU in main.ts). Off by default: the hold and the swipe do the menu's work. */
  readonly sideMenu?: boolean;
  /** Without a side menu: the type selector on the resting screen stands on its last entry, "Help". */
  readonly helpSelected?: boolean;
  /** Live text while recording: off (batch only), connecting, live, or lost (batch takes over). */
  readonly live?: LiveView;
  /** Everything heard so far (finals + current partial), shown while recording. */
  readonly liveText?: string;
  /** How long the microphone has been on, shown in the recording footer. */
  readonly elapsedMs?: number;
  /** The text under review covers only the last part of a long recording. */
  readonly truncated?: boolean;
}

/** 0 = keep, 1 = keep and take a photo (the camera shutter is its confirmation), 2 = discard (armed first). */
export type ReviewChoice = 0 | 1 | 2;

export type LiveView = "off" | "connecting" | "live" | "lost";

/** Why a tap or a hold did not do what it usually does. */
export type FieldNotice = "micDenied" | "noPhoto" | "heardNothing";

const DEFAULT_WIDTH = 56;

/** Rows the body container holds; more are pushed off the display. */
export const MAX_BODY_ROWS = 7;
/** Characters the header holds on one line in the G2's proportional font. */
export const HEADER_WIDTH = 56;

export function buildView(
  inspection: Inspection | null,
  options: ViewOptions,
  now = Date.now(),
): LogView {
  const locale = options.locale ?? "en";
  const L = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  const width = options.lineWidth ?? DEFAULT_WIDTH;

  const head = (state: string): string => truncate(`${L("g.title")} · ${state}`, HEADER_WIDTH);

  // The help page: every gesture of the app, reachable from the resting screen.
  if (options.help) {
    return {
      header: head(L("g.h.help")),
      body: [1, 2, 3, 4, 5, 6, 7].map((n) => L("g.help" + n)),
      footer: footer(locale, {}, "back"),
    };
  }

  // Never a dead end: a tap starts an inspection right here.
  if (!inspection) {
    return {
      header: head(L("g.h.none")),
      body: [L("g.none.1"), L("g.none.2")],
      footer: footer(locale, { tap: L("g.w.start"), hold: L(options.sideMenu === true ? "g.w.menu" : "g.w.help") }, "exit"),
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
        header: head(L("g.h.pick")),
        body: [...windowAround(rows, index, MAX_BODY_ROWS - 1), savedAs(options.severity, locale)],
        footer: footer(locale, { tap: L("g.w.save"), swipe: L("g.w.pick") }, "back"),
      };
    }

    case "recording": {
      const live = options.live ?? "off";
      const text = live === "live" ? (options.liveText ?? "").trim() : "";
      // Newest words visible: the tail of the text, the severity row below it.
      const body = text
        ? [...tailRows(wrap(text, width), MAX_BODY_ROWS - 1, width), savedAs(options.severity, locale)]
        : [
          L("g.listening"),
          ...(live === "lost" ? [truncate(L("g.live.lost"), width)] : []),
          savedAs(options.severity, locale),
        ];
      const parts = [
        MIC_ON + (options.elapsedMs !== undefined ? " " + clockLabel(options.elapsedMs) : ""),
        ...(options.mock ? [L("g.mock")] : []),
        ...(live === "connecting" ? [L("g.live.connecting")] : live === "lost" ? [L("g.live.off")] : []),
      ];
      return {
        header: head(parts.join(" · ")),
        body,
        // 2× does nothing while the microphone is on: a running recording is never lost by a slip.
        footer: footer(locale, { tap: L("g.w.done") }, null),
      };
    }

    case "transcribing":
      return {
        header: head(L("g.transcribing")),
        body: [L("g.transcribing")],
        // No gesture does anything while the text is being recognised: the footer says how far it is.
        footer: statusLabel(options.status, locale),
      };

    // The transcript is shown before it is kept. Speech recognition is
    // imperfect and an inspection report is a document someone acts on, so a
    // wrong entry must be catchable at the moment it is made.
    case "review": {
      // A swipe only moves between the two choices; discarding is a choice that is armed first (QIS v1).
      const choice = options.reviewChoice ?? 0;
      const armed = choice === 2 && options.confirmDiscard === true;
      const keepRow = (choice === 0 ? "> " : "  ") + L("g.choice.keep");
      const photoRow = (choice === 1 ? "> " : "  ") + L("g.choice.keepPhoto");
      const discardRow = (choice === 2 ? "> " : "  ") + (armed ? L("g.choice.sure") : "") + L("g.choice.discard");
      return {
        header: head(L(options.truncated ? "g.h.reviewCut" : "g.h.review", { seconds: MAX_UPLOAD_SECONDS })),
        // The severity row and the three choices always stay visible; a long transcript is cut
        // with "…" — the full text is in the log on the phone.
        body: [
          ...clampRows(wrap(options.pending ?? "", width), MAX_BODY_ROWS - 4, width),
          savedAs(options.severity, locale),
          keepRow,
          photoRow,
          discardRow,
        ],
        // 2× does nothing here (the text is not lost by a slip); while armed it cancels.
        footer: armed
          ? armedFooter(locale, L("g.a.discard"))
          : footer(locale, { tap: L(choice === 0 ? "g.w.keep" : choice === 1 ? "g.w.keepPhoto" : "g.w.discard"), swipe: L("g.w.choice") }, null),
      };
    }

    case "idle":
    default: {
      // A failed connection says what to do instead of silently ignoring taps.
      const error = options.notice === "micDenied"
        ? [L("g.micDenied.1"), truncate(L("g.micDenied.2"), width)]
        : options.notice === "noPhoto" ? [truncate(L("g.noPhoto"), width)]
        : options.notice === "heardNothing" ? [truncate(L("g.heardNothing"), width)]
        : options.voice && options.status === "error"
          ? [L("g.serverError.1"), truncate(L("g.serverError.2"), width)]
          : [];
      const time = formatDuration(durationSeconds(inspection, now));
      const sideMenu = options.sideMenu === true;
      const next = truncate(!sideMenu && options.helpSelected === true
        ? L("g.nextHelp")
        : L(sideMenu ? "g.nextSeverityMenu" : "g.nextSeverity", { severity: severityLabel(options.severity, locale) }), width);
      const restHeader = sectionHeader(inspection, L("g.title"), L("g.h.since", { time }));
      // With a side menu (QIS v1.2) the hold opens it and a swipe does nothing here; without one the swipe
      // picks the type (or the Help stop), the tap opens Help on that stop, the hold takes a photo.
      const restFooter = sideMenu
        ? footer(locale, { tap: L(options.voice ? "g.w.record" : "g.w.note"), hold: L("g.w.menu") }, "exit")
        : footer(locale, {
          tap: L(options.helpSelected === true ? "g.w.help" : options.voice ? "g.w.record" : "g.w.note"),
          swipe: L("g.w.type"),
          hold: L("g.w.photo"),
        }, "exit");
      if (inspection.entries.length === 0) {
        return {
          header: restHeader,
          body: [...error, ...(error.length > 0 ? [""] : []), L("g.noEntries"), truncate(L("g.firstNote"), width), "", next],
          footer: restFooter,
        };
      }
      // The last three entries, newest at the bottom, then the tally and the next type.
      // A server error takes its rows from the older entries first.
      const room = MAX_BODY_ROWS - error.length - 2;
      const body = [...error, ...recentEntryLines(inspection, Math.min(RECENT_ENTRIES, room), width, locale), tally, next];
      return {
        header: restHeader,
        body,
        footer: restFooter,
      };
    }
  }
}

/** `FIELDLOG · section · for 12m`: the section gives way when the line is too long, the time stays. */
function sectionHeader(inspection: Inspection, app: string, since: string): string {
  const fixed = `${app} · `.length + ` · ${since}`.length;
  const label = truncate(inspection.section || inspection.title, Math.max(4, HEADER_WIDTH - fixed));
  return `${app} · ${label} · ${since}`;
}

/** How many entries the resting screen lists. */
export const RECENT_ENTRIES = 3;

/** The last `count` entries, oldest first so the newest sits at the bottom. */
export function recentEntryLines(inspection: Inspection, count: number, width: number, locale: Locale): string[] {
  if (count <= 0) return [];
  return inspection.entries.slice(-count).map((entry) => {
    const mark = entry.severity === "major" ? "! " : entry.severity === "minor" ? "· " : "  ";
    const photo = entry.attachment ? " " + t(locale, "g.photo") : "";
    return truncate(mark + entry.text + photo, width);
  });
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

/** The last `max` rows; a cut at the front is marked with "…" so the newest words stay visible. */
export function tailRows(lines: readonly string[], max: number, width: number): string[] {
  if (lines.length <= max) return [...lines];
  const kept = lines.slice(lines.length - max);
  kept[0] = truncate("… " + (kept[0] ?? ""), width);
  return kept;
}

/** Recording time as m:ss. */
export function clockLabel(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
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
