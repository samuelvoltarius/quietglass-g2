import {
  isFollowingLive, visibleLines, wrap, type CaptionBuffer, type CaptionLine,
} from "../captions/buffer";
import type { SttStatus } from "../stt/provider";
import { transliterate } from "../text/translit";
import type { Locale } from "../i18n";
import { t } from "../messages";

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
export const GLASS_COLS = 46;
export const GLASS_ROWS = 7;
/** Rows the 214 px body container shows; anything beyond is clipped at the bottom. */
export const BODY_ROWS = 7;

/** Between the parts of the footer. */
const SEP = " · ";

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
  conversation: { rows: 4, width: 44, showOriginal: true },
  // One speaker at length: more history, translation only.
  lecture: { rows: 6, width: 46, showOriginal: false },
  // Signs and short exchanges: big and brief.
  travel: { rows: 3, width: 40, showOriginal: true },
  // No translation at all — accessibility captions in one language.
  captionOnly: { rows: 6, width: 46, showOriginal: true },
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
}

/** The original caption as it should appear on the glasses. */
export function originalText(line: CaptionLine, options: ViewOptions): string {
  if (!options.transliterateOriginal) return line.text;
  const configured = options.sourceLanguage && options.sourceLanguage !== "auto"
    ? options.sourceLanguage
    : undefined;
  return transliterate(line.text, configured ?? line.language);
}

export function buildView(buffer: CaptionBuffer, options: ViewOptions): CaptionView {
  const preset = MODE_PRESETS[options.mode];

  const x = (key: string): string => t(options.locale, key);

  if (!options.listening) {
    return {
      header: x("g.title"),
      body: [x("g.notListening"), x("g.tapToStart")],
      footer: options.mock ? x("g.mockProvider") : x("g.tapStart"),
    };
  }

  const lines = visibleLines(buffer, preset.rows, options.offset);
  const body: string[] = [];

  for (const line of lines) {
    const original = originalText(line, options);
    const primary = options.translating && line.translated !== undefined
      ? line.translated
      : original;
    body.push(...wrap(primary, preset.width));

    // In conversation and travel modes the original is kept below the
    // translation, because checking a single word is the common need.
    if (options.translating && preset.showOriginal && line.translated !== undefined) {
      body.push(...wrap("  " + original, preset.width));
    }
  }

  if (body.length === 0) body.push(statusLabel(options.status, options.locale));

  return {
    header: "",
    // Keep the newest lines: the body clips at the bottom, so sending more
    // than BODY_ROWS would hide exactly the caption being spoken right now.
    body: body.slice(-Math.min(preset.rows * 2, BODY_ROWS)),
    footer: footerText(buffer, options, preset.rows),
  };
}

/**
 * One status row. The microphone indicator, the mock marker and a connection
 * problem always stay; if the row is too long the tap hint goes first, then
 * the history marker, and a translation error is shortened last.
 */
function footerText(
  buffer: CaptionBuffer,
  options: ViewOptions,
  rows: number,
): string {
  const x = (key: string, vars: Record<string, string> = {}): string => t(options.locale, key, vars);
  // Shown whenever the microphone is open. Not suppressible.
  const fixed: string[] = [x("g.mic")];
  if (options.mock) fixed.push(x("g.mock"));
  if (options.status !== "ready") fixed.push(statusLabel(options.status, options.locale));

  const error = options.translating && options.translateError
    ? x("g.translateError", { error: translateErrorLabel(options.translateError, options.locale) })
    : null;
  const history = isFollowingLive(buffer, rows, options.offset) ? null : x("g.history");
  const hint = x("g.tapStop");

  const join = (parts: ReadonlyArray<string | null>): string =>
    parts.filter((part): part is string => part !== null).join(SEP);

  for (const parts of [[...fixed, error, history, hint], [...fixed, error, history], [...fixed, error]]) {
    const text = join(parts);
    if (length(text) <= GLASS_COLS) return text;
  }

  const head = join(fixed);
  const room = GLASS_COLS - length(head) - SEP.length;
  return error && room > 1 ? head + SEP + clip(error, room) : head;
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
