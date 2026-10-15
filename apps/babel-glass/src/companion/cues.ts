import { wrap } from "../captions/buffer";
import type { Locale } from "../i18n";
import { t } from "../messages";
import type { BabelData } from "../storage/persist";
import { clockLabel, speakerLine, type TranscriptEntry } from "./transcript";

/**
 * Tip cards (Kundengespräch only): like Even's "Conversate", short live cards
 * for the wearer — a question worth asking, a term that was meant, a quick
 * calculation, a careful legal/practical warning. Asked from the
 * babel-llm-proxy (`POST /context/cue`, with the customer's Shoot Day context)
 * every CUE_INTERVAL_MS while at least CUE_MIN_NEW_LINES new final lines came
 * in, never while a reply suggestion (or a popup the user asked for) is up.
 * One card: title (≤ 40) + one sentence (≤ 140), shown CUE_POPUP_MS in at most
 * CUE_ROWS rows of CUE_WIDTH, lowest popup priority.
 */

export type CueKind = "tipp" | "begriff" | "fakt" | "achtung";

export interface CueCard {
  readonly title: string;
  readonly text: string;
  readonly kind: CueKind;
  /** When it arrived (ms). */
  readonly at: number;
}

export const CUE_INTERVAL_MS = 20_000;
export const CUE_MIN_NEW_LINES = 2;
export const CUE_POPUP_MS = 8_000;
export const CUE_WIDTH = 46;
export const CUE_ROWS = 3;
export const CUE_KEEP = 50;
/** The proxy gives up after 6 s; a little more for the way there and back. */
export const CUE_TIMEOUT_MS = 7_500;
/** Transcript window sent: the last 3 minutes, at most 6000 characters (newest kept). */
export const CUE_WINDOW_MS = 3 * 60_000;
export const CUE_MAX_CHARS = 6_000;
export const CUE_TITLE_MAX = 40;
export const CUE_TEXT_MAX = 140;

const KINDS: readonly CueKind[] = ["tipp", "begriff", "fakt", "achtung"];

/**
 * Kind markers. The glasses font has no emoji (no other popup uses one), so
 * plain ASCII: "*" tipp (💡 in Conversate), "?" begriff, "#" fakt, "!" achtung.
 */
export const CUE_MARK: Readonly<Record<CueKind, string>> = { tipp: "*", begriff: "?", fakt: "#", achtung: "!" };

/** Setting "Tipp-Karten": absent = on. */
export function cueCardsOn(data: BabelData): boolean {
  return data.cueCards !== false;
}

/** `https://host:8448/v1` → `https://host:8448/context/cue`. */
export function cueUrl(llmUrl: string): string {
  const base = llmUrl.trim().replace(/\/+$/, "").replace(/\/chat\/completions$/, "").replace(/\/v1$/, "");
  return base + "/context/cue";
}

const clean = (value: unknown, max: number): string => {
  if (typeof value !== "string") return "";
  const one = value.replace(/\s+/g, " ").trim();
  const chars = [...one];
  return chars.length <= max ? one : chars.slice(0, max - 1).join("").trimEnd() + "…";
};

/** `{cue: {title, text, kind}}` (or the bare card) as a card; null for `{none: true}` or anything malformed. */
export function readCue(value: unknown, at: number): CueCard | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const raw = v["cue"] && typeof v["cue"] === "object" ? (v["cue"] as Record<string, unknown>) : v;
  if (raw["none"] === true) return null;
  const title = clean(raw["title"], CUE_TITLE_MAX);
  const text = clean(raw["text"], CUE_TEXT_MAX);
  if (!title || !text) return null;
  const kind = KINDS.includes(raw["kind"] as CueKind) ? (raw["kind"] as CueKind) : "tipp";
  return { title, text, kind, at };
}

/** The lines of the last CUE_WINDOW_MS as "A: …", newest kept within CUE_MAX_CHARS. */
export function cueTranscript(log: readonly TranscriptEntry[], now: number): string {
  const lines = log.filter((entry) => now - entry.at <= CUE_WINDOW_MS).map(speakerLine);
  const kept: string[] = [];
  let total = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] ?? "";
    if (total + line.length + 1 > CUE_MAX_CHARS) break;
    kept.unshift(line);
    total += line.length + 1;
  }
  return kept.join("\n");
}

/** The card on the glasses: "<mark> <title>" then the sentence, at most CUE_ROWS rows of CUE_WIDTH. */
export function cueRows(card: Pick<CueCard, "title" | "text" | "kind">, width = CUE_WIDTH, rows = CUE_ROWS): string[] {
  const head = wrap(CUE_MARK[card.kind] + " " + card.title, width).slice(0, 1);
  const all = [...head, ...wrap(card.text, width)];
  if (all.length <= rows) return all;
  const out = all.slice(0, rows);
  const last = [...(out[rows - 1] ?? "")];
  out[rows - 1] = (last.length + 1 > width ? last.slice(0, width - 1) : last).join("").trimEnd() + "…";
  return out;
}

export interface CueFetchConfig {
  readonly url: string;
  readonly apiKey?: string;
  /** The customer picked on the start screen (Shoot Day id); sent as X-Babel-Customer. */
  readonly customer?: string;
  readonly model?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

/** Never throws: a card, or null (none, failure, timeout) after at most `timeoutMs`. */
export async function fetchCue(
  config: CueFetchConfig,
  request: { readonly transcript: string; readonly recentTitles: readonly string[] },
): Promise<CueCard | null> {
  if (!request.transcript.trim()) return null;
  const doFetch = config.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => { controller?.abort(); resolve(null); }, config.timeoutMs ?? CUE_TIMEOUT_MS);
  });
  const call = (async (): Promise<CueCard | null> => {
    try {
      const response = await doFetch(cueUrl(config.url), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(config.apiKey ? { Authorization: "Bearer " + config.apiKey } : {}),
          ...(config.customer ? { "X-Babel-Customer": config.customer } : {}),
        },
        body: JSON.stringify({
          transcript: request.transcript,
          recent_titles: request.recentTitles.slice(-CUE_KEEP),
          ...(config.model ? { model: config.model } : {}),
        }),
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (!response.ok) return null;
      return readCue(await response.json(), (config.now ?? Date.now)());
    } catch {
      return null;
    }
  })();
  try {
    return await Promise.race([call, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export interface CueWatcherOptions {
  /** Kundengespräch, listening, setting on, model server set. */
  readonly enabled: () => boolean;
  /** A popup that must not be interrupted is on screen (reply suggestion, word finder, own sentence). */
  readonly blocked: () => boolean;
  /** Final lines so far (the transcript length). */
  readonly lines: () => number;
  readonly request: () => Promise<CueCard | null>;
  readonly onCue: (card: CueCard) => void;
  readonly intervalMs?: number;
  readonly minNewLines?: number;
}

export interface CueWatcher {
  /** Called by the app's ticker; starts at most one request. */
  tick(now: number): void;
  /** Captions (re)started: the first card comes one interval later, counting lines from here. */
  start(now: number): void;
  /** Captions stopped / conversation cleared: a running request's answer is dropped. */
  stop(): void;
  readonly busy: boolean;
}

export function createCueWatcher(options: CueWatcherOptions): CueWatcher {
  const interval = options.intervalMs ?? CUE_INTERVAL_MS;
  const minNew = options.minNewLines ?? CUE_MIN_NEW_LINES;
  let lastAt = 0;
  let linesAt = 0;
  let busy = false;
  let run = 0;
  return {
    get busy() { return busy; },
    start(now) { lastAt = now; linesAt = options.lines(); run += 1; busy = false; },
    stop() { run += 1; busy = false; },
    tick(now) {
      if (busy || now - lastAt < interval) return;
      if (!options.enabled() || options.blocked()) return;
      const lines = options.lines();
      // A cleared conversation starts counting again.
      if (lines < linesAt) linesAt = 0;
      if (lines - linesAt < minNew) return;
      lastAt = now;
      linesAt = lines;
      busy = true;
      const mine = ++run;
      void options.request().catch(() => null).then((card) => {
        if (mine !== run) return;
        busy = false;
        if (card) options.onCue(card);
      });
    },
  };
}

/** Adds a card, keeping the last CUE_KEEP. */
export function keepCue(cards: readonly CueCard[], card: CueCard): CueCard[] {
  return [...cards, card].slice(-CUE_KEEP);
}

/** The cards for the summary call, after the transcript (the proxy cuts them off before the Shoot Day filing). */
export function cueSummaryBlock(cards: readonly CueCard[], locale: Locale): string {
  if (cards.length === 0) return "";
  const head = locale === "de"
    ? "Tipp-Karten während des Gesprächs (Hinweise der Brille, nicht gesagt):"
    : "Tip cards during the conversation (hints shown on the glasses, not said):";
  return "\n\n" + head + "\n" + cards.map((c) => "- " + clockLabel(c.at) + " " + c.title + ": " + c.text).join("\n");
}

const escapeHtml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** The phone's list (Gespräch tab), newest first; "" without cards. */
export function cuesHtml(cards: readonly CueCard[], locale: Locale): string {
  if (cards.length === 0) return "";
  const items = [...cards].reverse().map((c) =>
    `<li><small>${clockLabel(c.at)}</small> <b>${escapeHtml(CUE_MARK[c.kind] + " " + c.title)}</b> — ${escapeHtml(c.text)}</li>`).join("");
  return `<h3>${t(locale, "p.cuesTitle")}</h3><ul class="insights cues">${items}</ul>`;
}
