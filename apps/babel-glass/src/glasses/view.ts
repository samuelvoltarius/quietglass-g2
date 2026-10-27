import {
  isFollowingLive, visibleLines, wrap, type CaptionBuffer, type CaptionLine,
} from "../captions/buffer";
import type { SttStatus } from "../stt/provider";
import { transliterate } from "../text/translit";
import type { Locale } from "../i18n";
import { t } from "../messages";
import { armedFooter, footer as gestureFooter, menuArmedFooter, ROW_WIDTH } from "./footer";
import { SIDE_MENU, type MenuArmed } from "../input/menu-confirm";
import { lineWho, whoLabel } from "../companion/roles";

/**
 * What the glasses show.
 *
 * Captions need the whole display, so everything else is compressed into one
 * status line. The microphone indicator is part of that line and is never
 * suppressed while the mic is open.
 */
export interface CaptionView {
  readonly header: string;
  readonly body: readonly string[];
  readonly footer: string;
}

/**
 * Text budget for everything the app itself writes on the glasses: the header
 * and footer are one row each, status screens use at most GLASS_ROWS rows.
 * Captions follow the per-mode width in MODE_PRESETS instead.
 */
export const GLASS_COLS = ROW_WIDTH;
export const GLASS_ROWS = 7;
/** Rows the 214 px body container shows; anything beyond is clipped at the bottom. */
export const BODY_ROWS = 7;

/** Between the parts of the header and footer. */
const SEP = " · ";
/** The app name every header starts with (QIS v1: "APPNAME · state"). */
const NAME = "BABEL";

export type CaptionMode = "conversation" | "lecture" | "travel" | "captionOnly";

export interface ModePreset {
  /** Caption rows on screen. */
  readonly rows: number;
  /** Characters per row before wrapping. */
  readonly width: number;
  /** Show the translation instead of, or beneath, the original. */
  readonly showOriginal: boolean;
}

export const MODE_PRESETS: Readonly<Record<CaptionMode, ModePreset>> = {
  // Back and forth: few lines, both languages, so you can check a word.
  conversation: { rows: 4, width: 56, showOriginal: true },
  // One speaker at length: more history, translation only.
  lecture: { rows: 6, width: 58, showOriginal: false },
  // Signs and short exchanges: big and brief.
  travel: { rows: 3, width: 48, showOriginal: true },
  // No translation at all — accessibility captions in one language.
  captionOnly: { rows: 6, width: 58, showOriginal: true },
};

export interface ViewOptions {
  readonly mode: CaptionMode;
  readonly listening: boolean;
  readonly status: SttStatus;
  readonly translating: boolean;
  /** Scroll-back distance; 0 follows the live edge. */
  readonly offset: number;
  /** True when the provider in use is a mock. */
  readonly mock: boolean;
  /**
   * Show the original (never the translation) in Latin letters, for when the
   * display font cannot draw Cyrillic.
   */
  readonly transliterateOriginal?: boolean;
  /** Configured source language; picks the transliteration table. */
  readonly sourceLanguage?: string;
  /** Last translation failure, shown so a broken backend is not silent. */
  readonly translateError?: string | null;
  /** UI language of the glasses texts; captions are never touched by it. */
  readonly locale: Locale;
  /** Prefix lines with the speaker label ("A: …") when the server sends one. */
  readonly speakers?: boolean;
  /** 1.1.1 (Gespräch, switch "Sprecher erkennen (Brille)"): mark lines "Ich:" / "Ggü:" by voice profile or glasses role. */
  readonly roles?: boolean;
  /** 1.1.1: a voice profile is in force (it wins over the glasses' role). */
  readonly profile?: boolean;
  /** Clock for the header; omitted = no time shown. */
  readonly now?: number;
  /** A short explanation (or, kind "word", the Wortfinder result) shown on top of the captions. */
  readonly popup?: ViewPopup | null;
  /** End-of-conversation summary (shown while not listening). */
  readonly summary?: SummaryState | null;
  /** Page of a finished summary that is longer than one screen (0 = first). */
  readonly summaryPage?: number;
  /** Why the microphone is off although the user wanted it on. */
  readonly notice?: MicNotice | null;
  /**
   * QIS v1 arm-and-confirm: "stop"
   * (a tap on running captions armed the stop). The footer says what the next tap does.
   */
  readonly armed?: "stop" | null;
  /**
   * QIS v1.2 #3: a side-menu item waits for its second click ("voiceDelete" = Meine Stimme löschen,
   * "restart" = Kunde wechseln / Modus / Personen while captions run). The footer says what the second click does.
   */
  readonly menuArmed?: MenuArmed | null;
  /**
   * 0.5.0: the help screen ("what runs when"), already as rows, and the page shown.
   * 0.6.2: also the "Kunde" page (`title` = header label); the view appends the end row.
   */
  readonly help?: {
    readonly rows: readonly string[]; readonly page: number; readonly title?: string;
    /** 0.6.3 (Kunde page): what a tap on the first page does (the mode row); a one-page sheet's end row then says 2× = schließen. */
    readonly tapLabel?: string;
  } | null;
  /** 1.0.0: the mode's name, first part of the running header ("Übersetzen · ● live"). */
  readonly modeLabel?: string | null;
  /**
   * 1.0.0: the start screen (rows already marked "> " at the cursor, see glasses/start.ts).
   * Shown whenever captions are stopped and no notice, summary or help is on screen.
   */
  readonly start?: { readonly rows: readonly string[] } | null;
}

/** A paged popup's rows with the closing row ("— Ende · Tippen = schließen —") at the very end. */
export function sheetRows(rows: readonly string[], locale: Locale, tapAction = false): string[] {
  return [...rows, t(locale, tapAction ? "g.pageEndBack" : "g.pageEnd")];
}

/** Pages a paged popup (help, Kunde) needs, end row included. */
export function sheetPageCount(rows: readonly string[], locale: Locale): number {
  return Math.max(1, Math.ceil(sheetRows(rows, locale).length / BODY_ROWS));
}

/** Next page after a swipe towards the end; null = past the last page, the popup closes. */
export function sheetNext(page: number, rows: readonly string[], locale: Locale): number | null {
  return page + 1 >= sheetPageCount(rows, locale) ? null : page + 1;
}

export interface ViewPopup {
  readonly term: string;
  readonly info: string;
  /**
   * "info": explanation (term + info). "word": Wortfinder, "reply": reply
   * suggestion, "say": own sentence translated on demand — shown as `lines`
   * (already fitted), each popup labelled by its kind.
   */
  readonly kind?: "info" | "word" | "reply" | "say" | "cue";
  readonly lines?: readonly string[];
  /** A short note of the app itself ("übersetze …"): shown without the kind label. */
  readonly plain?: boolean;
}

/** The label every popup starts with, so one always knows which helper speaks. */
export function popupLabel(kind: NonNullable<ViewPopup["kind"]>, locale: Locale): string {
  return t(locale, "g.lab." + kind);
}

/** The body rows of a popup, label first, wrapped to the full width. */
export function popupRows(popup: ViewPopup, locale: Locale, width = POPUP_WIDTH): string[] {
  const kind = popup.kind ?? "info";
  const label = popup.plain ? "" : popupLabel(kind, locale);
  const glue = kind === "say" || popup.plain ? "" : " ";
  if (kind === "info") return [...wrap(label + glue + popup.term, width), ...wrap(popup.info, width)];
  const lines = popup.lines ?? [popup.info];
  const [first = "", ...rest] = lines;
  return [...wrap(label + glue + first, width), ...rest.flatMap((line) => wrap(line, width))];
}

/** The microphone was refused, the server stayed away, or the time limit ran out. */
export type MicNotice =
  | { readonly kind: "micDenied" }
  | { readonly kind: "noServer" }
  | { readonly kind: "micLimit"; readonly minutes: number };

function noticeLines(notice: MicNotice, locale: Locale): string[] {
  switch (notice.kind) {
    case "micDenied": return [t(locale, "g.micDenied"), t(locale, "g.micDenied2")];
    case "noServer": return [t(locale, "g.noServer")];
    case "micLimit": return [t(locale, "g.micLimit", { minutes: String(notice.minutes) })];
  }
}

export type SummaryState =
  /** `short`/`long`: what the language model has written so far (streaming). */
  | { readonly state: "working"; readonly short?: readonly string[]; readonly long?: readonly string[] }
  | { readonly state: "done"; readonly short: readonly string[]; readonly long?: readonly string[] }
  | { readonly state: "error"; readonly error: string };

/** Marks the line the recogniser may still change. */
export const PENDING_MARK = "… ";
/** Full-width body: the icon sits in the header, not beside the text. */
export const POPUP_WIDTH = 56;

/** The original caption as it should appear on the glasses. */
export function originalText(line: CaptionLine, options: ViewOptions): string {
  if (!options.transliterateOriginal) return line.text;
  const configured = options.sourceLanguage && options.sourceLanguage !== "auto"
    ? options.sourceLanguage
    : undefined;
  return transliterate(line.text, configured ?? line.language);
}

function clock(now: number | undefined): string {
  if (now === undefined) return "";
  const d = new Date(now);
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

/** "A: " for another person; 0.8.0: "Ich: " / "Me: " for the user's own voice ("ME" from the server). */
export function speakerPrefix(speaker: string, locale: Locale): string {
  return (speaker === "ME" ? t(locale, "g.me") : speaker) + ": ";
}

export function buildView(buffer: CaptionBuffer, options: ViewOptions): CaptionView {
  const view = composeView(buffer, options);
  if (!options.menuArmed) return view;
  const label = t(options.locale, options.menuArmed === "voiceDelete" ? "g.a.voiceDelete" : "g.a.restart");
  // Without the side menu the confirming step is a tap on the same list row.
  return { ...view, footer: SIDE_MENU ? menuArmedFooter(options.locale, label) : armedFooter(options.locale, label) };
}

function composeView(buffer: CaptionBuffer, options: ViewOptions): CaptionView {
  const preset = MODE_PRESETS[options.mode];

  const x = (key: string, vars: Record<string, string> = {}): string => t(options.locale, key, vars);

  const head = (...parts: string[]): string => [NAME, ...parts].join(SEP);
  const listeningNow = options.listening;
  const armed = options.armed === "stop" && !listeningNow ? null : options.armed ?? null;

  if (options.help) {
    // 0.6.2: always "Seite x/y"; the last page ends in "— Ende · Tippen = schließen —" and a further swipe closes it.
    const tapLabel = options.help.tapLabel;
    // A one-page Kunde sheet: the tap is the mode row, so its end row says 2× = schließen.
    const rows = sheetRows(options.help.rows, options.locale, tapLabel !== undefined && options.help.rows.length + 1 <= BODY_ROWS);
    const pages = Math.max(1, Math.ceil(rows.length / BODY_ROWS));
    const page = Math.min(Math.max(0, Math.floor(options.help.page)), pages - 1);
    const time = clock(options.now);
    const lead = x("g.pageOf", { page: String(page + 1), pages: String(pages) });
    return {
      // The microphone indicator stays, whatever is on screen.
      header: clip(head(options.help.title ?? x("g.s.help"), ...(listeningNow ? [x("g.mic")] : []), ...(time ? [time] : [])), GLASS_COLS),
      body: rows.slice(page * BODY_ROWS, (page + 1) * BODY_ROWS),
      footer: tapLabel !== undefined && page === 0
        ? gestureFooter(options.locale, { tap: tapLabel, swipe: x("g.a.scroll") }, "back", lead)
        : page + 1 < pages
        ? gestureFooter(options.locale, { swipe: x("g.a.scroll") }, "back", lead)
        : gestureFooter(options.locale, { tap: x("g.a.close") }, "back", lead),
    };
  }

  if (!listeningNow) {
    const mark = options.mock ? [x("g.mock")] : [];
    // "Mikro aus" stays: the microphone state is never hidden.
    const idleHead = (): string => clip(head(x("g.s.off"), ...mark), GLASS_COLS);
    if (options.notice) {
      return {
        header: idleHead(),
        body: [...noticeLines(options.notice, options.locale), "", x("g.tapToStart")],
        footer: gestureFooter(options.locale, { tap: x("g.a.more") }, "exit"),
      };
    }
    if (options.summary) return summaryView(options.summary, options);
    // 1.0.0: three entries (Übersetzen, Englisch sprechen, Gespräch), customers under "Gespräch".
    return {
      header: idleHead(),
      body: (options.start?.rows ?? []).slice(0, BODY_ROWS),
      footer: x("g.f.start"),
    };
  }

  const lines = visibleLines(buffer, preset.rows, options.offset);
  const body: string[] = [];
  const pending = buffer.pending;

  for (const line of lines) {
    const original = originalText(line, options);
    const translated = options.translating && line.translated !== undefined
      ? line.translated
      : original;
    const who = line === pending ? null : lineWho(line, { speakers: options.speakers === true, roles: options.roles === true, profile: options.profile === true });
    const prefix = line === pending
      ? PENDING_MARK
      : who ? whoLabel(who, (key) => t(options.locale, key)) + ": " : "";
    const primary = prefix + translated;
    body.push(...wrap(primary, preset.width));

    // In conversation and travel modes the original is kept below the
    // translation, because checking a single word is the common need.
    if (options.translating && preset.showOriginal && line.translated !== undefined) {
      body.push(...wrap("  " + original, preset.width));
    }
  }

  if (body.length === 0) body.push(statusLabel(options.status, options.locale));

  const history = !isFollowingLive(buffer, preset.rows, options.offset);
  const header = liveHeader({
    locale: options.locale, status: options.status, modeLabel: options.modeLabel ?? "",
    mock: options.mock, translating: options.translating,
    ...(options.translateError ? { translateError: options.translateError } : {}),
    history, armedStop: armed === "stop",
  });

  if (options.popup) {
    // The popup on top (labelled by its kind), the newest captions below it.
    const rows = popupRows(options.popup, options.locale);
    // A long popup gets the whole body (captions return when it closes);
    // a short one leaves room for the newest captions below it.
    const room = BODY_ROWS - rows.length - 1;
    return {
      header,
      body: room >= 1 ? [...rows, "—".repeat(26), ...body.slice(-room)] : rows.slice(0, BODY_ROWS),
      footer: armed === "stop" ? armedFooter(options.locale, x("g.a.stopLong")) : x("g.f.popup"),
    };
  }

  return {
    header,
    // Keep the newest lines: the body clips at the bottom, so sending more
    // than BODY_ROWS would hide exactly the caption being spoken right now.
    body: body.slice(-Math.min(preset.rows * 2, BODY_ROWS)),
    footer: armed === "stop" ? armedFooter(options.locale, x("g.a.stopLong")) : x(history ? "g.f.runHistory" : "g.f.run"),
  };
}

/**
 * The header while listening (1.0.0): "Übersetzen · ● live". Mode name and state only; what
 * else the glasses must not hide stays: the demo marker, a translation error, the armed "Stopp?".
 * When it does not fit, the least important parts go first — the mode and the state always stay.
 */
export function liveHeader(options: Pick<ViewOptions, "locale" | "status"> & Partial<Pick<ViewOptions, "mock" | "translating" | "translateError">> & {
  readonly modeLabel?: string;
  readonly history?: boolean;
  readonly armedStop?: boolean;
}): string {
  const x = (key: string): string => t(options.locale, key);
  const parts: Array<{ text: string; keep: number }> = [
    { text: options.modeLabel || NAME, keep: 1000 },
    { text: runStatus(options.status, options.locale), keep: 100 },
  ];
  if (options.armedStop) parts.push({ text: x("g.s.stopAsk"), keep: 95 });
  // Scrolled back: the view stands still, the microphone does not (its "●" stays in the state part).
  if (options.history) parts.push({ text: x("g.run.history"), keep: 90 });
  // The demo marker is never traded for anything below it.
  if (options.mock) parts.push({ text: x("g.mock"), keep: 92 });
  if (options.translating && options.translateError) {
    // The error gets whatever room the fixed parts leave, shortened rather than dropped.
    const room = GLASS_COLS - length(parts.map((part) => part.text).join(SEP) + SEP);
    if (room >= 6) {
      parts.push({ text: clip(t(options.locale, "g.translateError", { error: translateErrorLabel(options.translateError, options.locale) }), room), keep: 85 });
    }
  }
  const text = (): string => parts.map((part) => part.text).join(SEP);
  while (length(text()) > GLASS_COLS && parts.length > 2) {
    let lowest = 2;
    for (let i = 3; i < parts.length; i++) if (parts[i]!.keep < parts[lowest]!.keep) lowest = i;
    parts.splice(lowest, 1);
  }
  return text();
}

/** The small state of the running screen: live, connecting or offline. The microphone is open in all three, so all carry the "●". */
export function runStatus(status: SttStatus, locale: Locale): string {
  if (status === "ready") return t(locale, "g.run.live");
  return t(locale, status === "connecting" ? "g.run.connecting" : "g.run.offline");
}

/** Separator between the short and the detailed summary. */
const SUMMARY_RULE = "—".repeat(26);

/**
 * The summary as glasses rows: the short lines first, then (when there is
 * more) the detailed points. Nothing is cut; long summaries are paged.
 */
export function summaryRows(short: readonly string[], long: readonly string[] = []): string[] {
  const rows = short.flatMap((line) => wrap("· " + line, POPUP_WIDTH));
  const sameAsShort = long.length === short.length && long.every((line, i) => line === short[i]);
  if (long.length && !sameAsShort) {
    if (rows.length) rows.push(SUMMARY_RULE);
    rows.push(...long.flatMap((line) => wrap("- " + line, POPUP_WIDTH)));
  }
  return rows;
}

/** Pages a finished summary needs on the glasses (at least 1). */
export function summaryPageCount(short: readonly string[], long: readonly string[] = []): number {
  return Math.max(1, Math.ceil(summaryRows(short, long).length / BODY_ROWS));
}

function summaryView(summary: SummaryState, options: ViewOptions): CaptionView {
  const x = (key: string, vars: Record<string, string> = {}): string => t(options.locale, key, vars);
  const mark = options.mock ? [x("g.mock")] : [];
  const head = (...extra: string[]): string => [NAME, x("g.head.summary"), ...extra, ...mark].join(SEP);
  const plainFooter = gestureFooter(options.locale, { tap: x("g.a.more") }, "exit");
  if (summary.state === "working") {
    // Streaming: the text grows at the bottom, so the newest rows stay in view.
    const rows = summaryRows(summary.short ?? [], summary.long ?? []);
    return {
      header: head(),
      body: rows.length ? rows.slice(-BODY_ROWS) : [x("g.summaryWorking")],
      footer: plainFooter,
    };
  }
  if (summary.state === "error") {
    return {
      header: head(),
      body: wrap(x("g.summaryError", { error: translateErrorLabel(summary.error, options.locale) }), POPUP_WIDTH),
      footer: plainFooter,
    };
  }
  const rows = summaryRows(summary.short, summary.long ?? []);
  const pages = Math.max(1, Math.ceil(rows.length / BODY_ROWS));
  if (pages === 1) {
    // Fits one screen: the phone hint still goes below when there is room.
    const body = rows.length < BODY_ROWS - 1 ? [...rows, "", x("g.summaryPhone")] : rows;
    return { header: head(), body, footer: plainFooter };
  }
  const page = Math.min(Math.max(0, Math.floor(options.summaryPage ?? 0)), pages - 1);
  return {
    // The page counter sits in the header; the footer keeps room for the swipe that turns the page.
    header: head((page + 1) + "/" + pages),
    body: rows.slice(page * BODY_ROWS, (page + 1) * BODY_ROWS),
    footer: gestureFooter(options.locale, { tap: x("g.a.more"), swipe: x("g.a.page") }, "exit"),
  };
}

/** Character count, not UTF-16 units: "●" and umlauts are one each. */
function length(text: string): number {
  return [...text].length;
}

function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : chars.slice(0, max - 1).join("") + "…";
}

/** The translator's short error words, in the UI language; anything else as is. */
const ERROR_KEYS: Readonly<Record<string, string>> = {
  "timed out": "g.err.timeout",
  "unreachable": "g.err.unreachable",
  "unreadable response": "g.err.unreadable",
  "empty response": "g.err.empty",
};

export function translateErrorLabel(error: string, locale: Locale): string {
  const key = ERROR_KEYS[error];
  return key ? t(locale, key) : error;
}

export function statusLabel(status: SttStatus, locale: Locale): string {
  switch (status) {
    case "connecting": return t(locale, "g.status.connecting");
    case "reconnecting": return t(locale, "g.status.reconnecting");
    case "error": return t(locale, "g.status.error");
    case "ready": return t(locale, "g.status.ready");
    default: return t(locale, "g.status.idle");
  }
}
