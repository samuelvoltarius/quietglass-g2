import type { Locale } from "../i18n";
import { t } from "../messages";
import type { TranscriptEntry } from "../companion/transcript";
import { footer } from "../glasses/footer";

/**
 * What the summary cockpit shows after a "Gespräch" ended (QUS v1), decided without
 * drawing: the big duration, the speaker shares, four label/value cells, caption and
 * hint line. compose.ts only lays this out. All of it comes from the transcript of
 * the conversation, so it exists only when there is something to count.
 */

export interface CockpitCell {
  readonly label: string;
  readonly value: string;
}

/** One speaker's share of the spoken words, 0..100. */
export interface ShareBar {
  readonly label: string;
  readonly value: number;
  readonly text: string;
}

export interface TalkCockpitModel {
  readonly title: string;
  readonly clock: string;
  /** One line, upper case: "12 MIN". */
  readonly headline: readonly string[];
  /** Rows of three columns. */
  readonly cells: readonly CockpitCell[];
  /** The left half: one bar per speaker (at most four); empty when nobody was told apart. */
  readonly bars: readonly ShareBar[];
  /** Left bottom: "13:51 – 14:03". */
  readonly caption: string;
  readonly hint: string;
}

export interface TalkStats {
  readonly durationMs: number;
  readonly startAt: number;
  readonly endAt: number;
  readonly words: number;
  readonly questions: number;
  /** Speakers told apart, most words first; empty when the server sends no labels. */
  readonly shares: readonly { readonly speaker: string; readonly words: number; readonly percent: number }[];
  /** Most frequent language code of the lines (lower case), or "". */
  readonly language: string;
}

export const MAX_BARS = 4;

const countWords = (text: string): number => text.split(/\s+/).filter((word) => word !== "").length;

/** Percentages of `parts` that add up to exactly 100 (largest remainder). */
export function percentages(parts: readonly number[]): number[] {
  const total = parts.reduce((sum, part) => sum + part, 0);
  if (total <= 0) return parts.map(() => 0);
  const raw = parts.map((part) => (part * 100) / total);
  const floors = raw.map(Math.floor);
  let left = 100 - floors.reduce((sum, part) => sum + part, 0);
  const order = raw.map((value, index) => ({ index, rest: value - Math.floor(value) })).sort((a, b) => b.rest - a.rest || a.index - b.index);
  for (const { index } of order) { if (left <= 0) break; floors[index]! += 1; left -= 1; }
  return floors;
}

/** The numbers of a finished conversation; null when there is nothing worth a picture (fewer than two lines, no words). */
export function talkStats(log: readonly TranscriptEntry[]): TalkStats | null {
  if (log.length < 2) return null;
  let words = 0; let questions = 0;
  const perSpeaker = new Map<string, number>();
  const languages = new Map<string, number>();
  for (const entry of log) {
    const count = countWords(entry.text);
    words += count;
    if (entry.text.includes("?")) questions += 1;
    if (entry.speaker) perSpeaker.set(entry.speaker, (perSpeaker.get(entry.speaker) ?? 0) + count);
    if (entry.language) languages.set(entry.language.toLowerCase(), (languages.get(entry.language.toLowerCase()) ?? 0) + 1);
  }
  if (words === 0) return null;
  const ranked = [...perSpeaker.entries()].sort((a, b) => b[1] - a[1]);
  const percent = percentages(ranked.map(([, count]) => count));
  const language = [...languages.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
  const startAt = log[0]!.at; const endAt = log[log.length - 1]!.at;
  return {
    durationMs: Math.max(0, endAt - startAt), startAt, endAt, words, questions, language,
    shares: ranked.map(([speaker, count], index) => ({ speaker, words: count, percent: percent[index]! })),
  };
}

/** "45 S", "12 MIN", "1:05 H" – the same in both languages. */
export function durationWord(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${Math.max(1, seconds)} S`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} MIN`;
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")} H`;
}

export function hhmm(time: number): string {
  const date = new Date(time);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export interface TalkCockpitInput {
  readonly log: readonly TranscriptEntry[];
  readonly locale: Locale;
  readonly now: number;
  readonly translating: boolean;
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
}

/** "DE→EN" while translating, else the language that was spoken; "–" when unknown. */
export function languageValue(stats: TalkStats, input: Pick<TalkCockpitInput, "translating" | "sourceLanguage" | "targetLanguage">): string {
  const source = stats.language || (input.sourceLanguage && input.sourceLanguage !== "auto" ? input.sourceLanguage.toLowerCase() : "");
  const up = (code: string): string => code.slice(0, 5).toUpperCase();
  if (input.translating && input.targetLanguage) return source ? `${up(source)}→${up(input.targetLanguage)}` : up(input.targetLanguage);
  return source ? up(source) : "–";
}

/** The footer line of the cockpit: the same gestures as the text summary, plus what a swipe does. */
export function cockpitHint(locale: Locale): string {
  return footer(locale, { tap: t(locale, "g.a.more"), swipe: t(locale, "g.a.text") }, "exit");
}

/** The summary cockpit for a finished conversation, or null (then the text summary stays). */
export function talkCockpitModel(input: TalkCockpitInput): TalkCockpitModel | null {
  const stats = talkStats(input.log);
  if (!stats) return null;
  const x = (key: string): string => t(input.locale, key);
  const bars: ShareBar[] = stats.shares.slice(0, MAX_BARS).map((share): ShareBar => ({
    label: share.speaker === "ME" ? x("g.me") : share.speaker,
    value: share.percent,
    text: `${share.percent}%`,
  }));
  // Nobody told apart: one full bar for the whole conversation, so the left half is never empty.
  if (bars.length === 0) bars.push({ label: x("g.c.all"), value: 100, text: "100%" });
  return {
    title: x("g.c.title"),
    clock: hhmm(input.now),
    headline: [durationWord(stats.durationMs)],
    cells: [
      { label: x("g.c.speakers"), value: stats.shares.length > 0 ? String(stats.shares.length) : "–" },
      { label: x("g.c.words"), value: String(stats.words) },
      { label: x("g.c.questions"), value: String(stats.questions) },
      { label: x("g.c.language"), value: languageValue(stats, input) },
    ],
    bars,
    caption: `${hhmm(stats.startAt)} – ${hhmm(stats.endAt)}`,
    hint: cockpitHint(input.locale),
  };
}

/** Changes exactly when a different picture is needed; the clock is part of it. */
export function modelKey(model: TalkCockpitModel): string {
  return JSON.stringify([model.clock, model.headline, model.cells, model.bars, model.caption, model.hint]);
}
