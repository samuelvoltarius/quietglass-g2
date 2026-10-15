import type { Locale } from "../i18n";
import type { CompanionLlm, Insight } from "./llm";
import type { TranscriptEntry } from "./transcript";

/**
 * Decides when to ask the language model whether the newest line holds a
 * question or an unusual term. One request at a time, a short debounce so a
 * burst of lines becomes one request, a minimum gap so the glasses are not
 * flooded, and every term only once.
 */
export interface InsightWatcherOptions {
  readonly llm: () => CompanionLlm | null;
  readonly locale: () => Locale;
  readonly onInsight: (insight: Insight) => void;
  /** The explanation while it is still being written (terms already shown are skipped). */
  readonly onPartial?: (insight: Insight) => void;
  /** A partial explanation was shown, but the finished answer brought none. */
  readonly onPartialDropped?: () => void;
  readonly onError?: (error: string) => void;
  /**
   * Hits from Babel's own memory for these lines ("Notizen des Nutzers"), or "".
   * Asked right before each explanation; a failure just means no notes.
   */
  readonly notes?: (recent: readonly TranscriptEntry[]) => Promise<string>;
  readonly debounceMs?: number;
  readonly minGapMs?: number;
  readonly context?: number;
  readonly now?: () => number;
}

export interface InsightWatcher {
  /** A new final line arrived; `log` is the whole transcript including it. */
  onFinal(log: readonly TranscriptEntry[]): void;
  /** Terms already explained, oldest first. */
  readonly known: readonly string[];
  reset(): void;
  stop(): void;
}

export const INSIGHT_DEBOUNCE_MS = 1_500;
export const INSIGHT_MIN_GAP_MS = 5_000;

export function createInsightWatcher(options: InsightWatcherOptions): InsightWatcher {
  const now = options.now ?? Date.now;
  const debounce = options.debounceMs ?? INSIGHT_DEBOUNCE_MS;
  const minGap = options.minGapMs ?? INSIGHT_MIN_GAP_MS;
  const context = options.context ?? 6;
  let known: string[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let busy = false;
  let lastAsked = -Infinity;
  let latest: readonly TranscriptEntry[] = [];
  let askedFor = -1;
  let stopped = false;

  const ask = async (): Promise<void> => {
    timer = undefined;
    const llm = options.llm();
    if (stopped || !llm || busy || latest.length === 0) return;
    const gap = now() - lastAsked;
    if (gap < minGap) { schedule(minGap - gap); return; }
    if (askedFor === latest.length) return;
    askedFor = latest.length;
    busy = true;
    lastAsked = now();
    let shownPartial = false;
    const isKnown = (term: string): boolean => known.some((k) => k.toLowerCase() === term.toLowerCase());
    const onProgress = options.onPartial
      ? (partial: Insight): void => {
          if (stopped || isKnown(partial.term)) return;
          shownPartial = true;
          options.onPartial?.(partial);
        }
      : undefined;
    const recent = latest.slice(-context);
    const notes = options.notes ? await options.notes(recent).catch(() => "") : "";
    const result = await llm.explain(recent, known, options.locale(), onProgress, notes || undefined)
      .catch(() => ({ ok: false as const, error: "failed" }));
    busy = false;
    if (stopped) return;
    const insight = result.ok ? result.value : null;
    if (shownPartial && (!insight || isKnown(insight.term))) options.onPartialDropped?.();
    if (!result.ok) { options.onError?.(result.error); return; }
    if (insight && !isKnown(insight.term)) {
      known = [...known, insight.term].slice(-40);
      options.onInsight(insight);
    }
    // Lines that arrived while the request ran get their own look.
    if (latest.length !== askedFor) schedule(debounce);
  };

  const schedule = (ms: number): void => {
    clearTimeout(timer);
    timer = setTimeout(() => { void ask(); }, ms);
  };

  return {
    onFinal(log) {
      latest = log;
      stopped = false;
      if (!busy) schedule(debounce);
    },
    get known() { return known; },
    reset() { known = []; askedFor = -1; latest = []; clearTimeout(timer); },
    stop() { stopped = true; clearTimeout(timer); },
  };
}
