import type { Locale } from "../i18n";
import { footer } from "../glasses/footer";
import { cents, money, providerTag, shorten, staleAge, MISSING, type Position } from "../markets/model";
import { t } from "../text";
import { hhmm, type CockpitCell, type CockpitGraphic, type CockpitModel, type Tone } from "./compose";

/**
 * What the cockpit shows, in words and numbers, decided without drawing
 * (QUS v1): the headline, the label/value cells, the graphic for the left
 * half, the caption and the hint line. compose.ts only lays this out.
 *
 * Two kinds of page: the overview (the whole portfolio) and one position.
 */

/** What the bridge last delivered: `updatedAt` is the data's age reference (ms), `failed` whether the latest refresh failed. */
export interface FeedStatus {
  readonly source: "live" | "demo";
  readonly updatedAt: number;
  readonly failed: boolean;
  readonly errors: readonly { readonly provider: string; readonly message: string }[];
}

/** One point of the portfolio curve: the total value at a moment. */
export interface HistoryPoint { readonly at: number; readonly value: number }

export type CockpitPage = { readonly kind: "overview" } | { readonly kind: "position"; readonly index: number };

export interface CockpitInput {
  readonly positions: readonly Position[];
  readonly status: FeedStatus;
  readonly history: readonly HistoryPoint[];
  readonly page: CockpitPage;
  readonly now: number;
  readonly locale: Locale;
}

/** The sample curve of the demo: a calm climb to the demo portfolio's value, one point every 15 s. */
export function demoHistory(now: number): HistoryPoint[] {
  const shape = [20.9, 21.05, 20.95, 21.2, 21.1, 21.35, 21.3, 21.5, 21.65];
  return shape.map((value, index) => ({ at: now - (shape.length - 1 - index) * 15_000, value }));
}

/** The pages a swipe walks through: the overview and every position. */
export function cockpitPages(positions: readonly Position[]): CockpitPage[] {
  return [{ kind: "overview" }, ...positions.map((_, index): CockpitPage => ({ kind: "position", index }))];
}

export const usd = (value: number): string => `$${(Math.round(value * 100) / 100).toFixed(2)}`;

export function totals(positions: readonly Position[]): { value: number; pnl: number | null; realized: number | null } {
  const sum = (pick: (position: Position) => number | null | undefined): number | null => {
    const values = positions.map(pick).filter((v): v is number => typeof v === "number");
    return values.length === 0 ? null : values.reduce((a, b) => a + b, 0);
  };
  return { value: positions.reduce((a, p) => a + p.currentValue, 0), pnl: sum((p) => p.pnl), realized: sum((p) => p.realizedPnl) };
}

/** How the feed stands: stale/failed data is "offline", a failed provider "warn", demo and fresh live data "ok". */
export function feedTone(status: FeedStatus, now: number): Tone {
  if (status.source === "demo") return "ok";
  if (staleAge(status.updatedAt, now, status.failed) !== null) return "offline";
  return status.errors.length > 0 ? "warn" : "ok";
}

export interface FeedWord { readonly kind: "live" | "demo" | "stale"; readonly age?: string }

export function feedWord(status: FeedStatus, now: number): FeedWord {
  if (status.source === "demo") return { kind: "demo" };
  const age = staleAge(status.updatedAt, now, status.failed);
  return age === null ? { kind: "live" } : { kind: "stale", age };
}

/** The state as the words of a header or a pill: `● live`, `Demo`, `veraltet 3m`. */
export function feedLabel(word: FeedWord, locale: Locale): string {
  if (word.kind === "live") return "● " + t(locale, "live");
  if (word.kind === "demo") return t(locale, "demoWord");
  return `${t(locale, "staleWord")} ${word.age ?? ""}`.trim();
}

export function providerLabel(provider: string): string {
  return provider === "kalshi" ? "Kalshi" : provider === "polymarket" ? "Polymarket" : provider || MISSING;
}

/** The six cells of the overview. */
export function overviewCells(positions: readonly Position[], status: FeedStatus, locale: Locale): CockpitCell[] {
  const total = totals(positions);
  const pnls = positions.map((p) => p.pnl).filter((v): v is number => v !== null);
  const best = pnls.length > 0 ? Math.max(...pnls) : null;
  const worst = pnls.length > 0 ? Math.min(...pnls) : null;
  const flag = (value: number | null): { alert?: true } => (value !== null && value < 0 ? { alert: true } : {});
  const sources = [...new Set(positions.map((p) => providerTag(p.provider)))].join(" ");
  return [
    { label: t(locale, "cellPositions"), value: String(positions.length) },
    { label: t(locale, "cellPnl"), value: money(total.pnl), ...flag(total.pnl) },
    { label: t(locale, "cellRealized"), value: money(total.realized) },
    { label: t(locale, "cellTop"), value: money(best), ...flag(best) },
    { label: t(locale, "cellFlop"), value: money(worst), ...flag(worst) },
    { label: t(locale, "cellSource"), value: status.source === "demo" ? t(locale, "demoWord") : sources || MISSING },
  ];
}

/** The six cells of one position. */
export function positionCells(position: Position, index: number, count: number, locale: Locale): CockpitCell[] {
  return [
    { label: t(locale, "cellValue"), value: usd(position.currentValue) },
    { label: t(locale, "cellQuantity"), value: String(Math.round(position.quantity * 100) / 100) },
    { label: t(locale, "cellRealized"), value: money(position.realizedPnl ?? null) },
    { label: t(locale, "cellProvider"), value: providerLabel(position.provider) },
    { label: t(locale, "cellPrice"), value: cents(position.price) },
    { label: "#", value: `${index + 1}/${count}` },
  ];
}

/** The newest answer, "Stand 14:05"; stale data says since when. */
export function captionFor(status: FeedStatus, now: number, locale: Locale): string {
  if (status.source === "demo") return t(locale, "demoWord");
  const stale = staleAge(status.updatedAt, now, status.failed) !== null;
  return t(locale, stale ? "staleAt" : "dataAt", { time: hhmm(status.updatedAt) });
}

/** The hint line: only the gestures that do something here. */
export function cockpitHint(locale: Locale, pages: number): string {
  return footer(locale, { tap: t(locale, "reload"), ...(pages > 1 ? { swipe: t(locale, "pages") } : {}) }, "back");
}

export function cockpitModel(input: CockpitInput): CockpitModel {
  const { positions, status, now, locale } = input;
  const tone = feedTone(status, now);
  const base = { title: t(locale, "title").toUpperCase(), clock: hhmm(now), hint: cockpitHint(locale, positions.length + 1), tone };
  const position = input.page.kind === "position" ? positions[input.page.index] : undefined;
  if (position && input.page.kind === "position") {
    const graphic: CockpitGraphic = { kind: "gauge", value: position.price, center: cents(position.price), sub: shorten(position.outcome || providerTag(position.provider), 10), tone: position.pnl !== null && position.pnl < 0 ? "warn" : "ok" };
    return {
      ...base,
      headline: [money(position.pnl), shorten(position.outcome, 14).toUpperCase()].filter((line) => line !== ""),
      cells: positionCells(position, input.page.index, positions.length, locale),
      graphic,
      caption: shorten(position.title, 22),
    };
  }
  const total = totals(positions);
  const points = input.history.map((point) => point.value);
  const first = input.history[0];
  return {
    ...base,
    headline: positions.length === 0 ? [MISSING] : [usd(total.value), money(total.pnl)],
    cells: overviewCells(positions, status, locale),
    graphic: { kind: "spark", points, top: t(locale, "graphicTop"), bottom: first && points.length >= 2 ? t(locale, "graphicSince", { time: hhmm(first.at) }) : "", tone },
    caption: captionFor(status, now, locale),
  };
}
