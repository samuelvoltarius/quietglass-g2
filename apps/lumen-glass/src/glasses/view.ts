import { drawMoth, lightBar, mothLine } from "../lumen/moth";
import type { LumenStatus } from "../lumen/client";
import type { Locale } from "../i18n";
import { messages, t } from "../messages";

/**
 * What the glasses show.
 *
 * The moth gets the middle of the display, because seeing it is the point of
 * LUMEN — a number saying "light: 34" motivates nobody, a moth with folded
 * wings does. The quest sits under it, the light window in the corner.
 */
export interface LumenView {
  readonly header: string;
  readonly body: readonly string[];
  readonly footer: string;
}

export type Phase = "idle" | "shooting" | "submitting" | "result";

export interface ViewOptions {
  readonly phase: Phase;
  /** Outcome of the last submission. */
  readonly result: { readonly ok: boolean; readonly text: string } | null;
  readonly error: string | null;
  /** Language of everything the app itself writes; LUMEN's own words pass through. */
  readonly locale: Locale;
  readonly lineWidth?: number;
}

/**
 * Header and footer span the full 576 px display: about 46 characters.
 * The body sits right of the 96 px pixel moth (x 104, 472 px wide), which
 * leaves room for about 37.
 */
export const LINE_COLS = 46;
export const BODY_COLS = 37;
const DEFAULT_WIDTH = BODY_COLS;

/** Lines the body container shows before the text runs into the footer. */
export const MAX_BODY_ROWS = 7;

export function buildView(
  status: LumenStatus | null,
  options: ViewOptions,
): LumenView {
  const { locale } = options;
  const x = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  const width = options.lineWidth ?? DEFAULT_WIDTH;

  if (options.error) {
    return {
      header: "Lumen Glass",
      body: fitBody(wrap(errorText(options.error, locale), width), [], [x("g.checkAddress")], width),
      footer: x("g.tapRetry"),
    };
  }

  if (!status) {
    return { header: "Lumen Glass", body: [x("g.connecting")], footer: "" };
  }

  const moth = drawMoth(status.moth.state);

  if (options.phase === "shooting") {
    return {
      header: "",
      body: [...moth, "", x("g.shooting")],
      footer: "",
    };
  }

  if (options.phase === "submitting") {
    return { header: "", body: [...moth, "", x("g.sending")], footer: "" };
  }

  if (options.phase === "result" && options.result) {
    const text = options.result.ok ? x("g.sent") : errorText(options.result.text, locale);
    return {
      header: x(options.result.ok ? "g.accepted" : "g.rejected"),
      body: fitBody([...moth], wrap(text, width), [], width),
      footer: x("g.tapCarryOn"),
    };
  }

  // LUMEN's own wording, which can be any length: one line, never a wrap.
  const head = [...moth, truncate(mothLine(status.moth.state, status.moth.gesture), width)];

  const body = status.quest
    // The instruction is what you act on; the short name is the heading.
    ? fitBody(head, wrap(status.quest.task ?? status.quest.title, width), [truncate(questMeta(status.quest, locale), width)].filter(Boolean), width)
    : fitBody(head, wrap(x("g.noQuest"), width), [], width);

  return {
    header: "",
    body,
    footer: footerText(status, Boolean(status.quest), locale),
  };
}

/**
 * The client reports its own failures in fixed English words (see
 * src/lumen/client.ts); those are translated here. Anything else, such as
 * "HTTP 500" or a raw network message, is technical and shown as it came.
 */
export function errorText(error: string, locale: Locale): string {
  const key = Object.keys(messages.en).find((name) => name.startsWith("g.err.") && messages.en[name] === error);
  return key ? t(locale, key) : error;
}

/**
 * The line under the instruction: what medium, how long, and a warning when
 * the quest cannot be answered from here at all.
 *
 * LUMEN also hands out video quests. The glasses can only open the phone's
 * still camera, so saying so up front is better than letting the user shoot
 * and have it rejected.
 */
export function questMeta(quest: { medium: string | null; minutes: number | null }, locale: Locale): string {
  const parts: string[] = [];
  if (quest.medium === "video") parts.push(t(locale, "g.video"));
  else if (quest.medium) parts.push(quest.medium.toUpperCase());
  if (quest.minutes !== null && quest.minutes > 0) parts.push(t(locale, "g.minutes", { minutes: quest.minutes }));
  return parts.join(" · ");
}

/**
 * Light, streak, light window and the gesture hint, on one full-width line.
 * When that is too long (a long streak, a window hours away, German), the
 * streak goes first and then the hint — the phone page lists the gestures,
 * and the light window is the reason this footer exists.
 */
function footerText(status: LumenStatus, hasQuest: boolean, locale: Locale): string {
  const bar = lightBar(status.moth.light, 8);
  const streak = status.moth.streak > 0 ? t(locale, "g.streak", { days: status.moth.streak }) : "";
  // The light window is the single most useful thing on this display: it is
  // the reason to stand up now rather than later.
  const light = status.window ? windowLabel(status.window.kind, status.window.minutesAway, locale) : "";
  const hint = t(locale, hasQuest ? "g.tapPhoto" : "g.holdQuest");

  const join = (parts: string[]): string => parts.filter(Boolean).join(" · ");
  const candidates = [[bar, streak, light, hint], [bar, light, hint], [bar, light]];
  for (const parts of candidates) {
    const line = join(parts);
    if (line.length <= LINE_COLS) return line;
  }
  return truncate(join([bar, light]), LINE_COLS);
}

export function windowLabel(kind: string, minutes: number, locale: Locale): string {
  const name = kind.startsWith("golden") ? t(locale, "g.golden") : kind.startsWith("blau") ? t(locale, "g.blue") : kind;
  // Round once, up front: rounding the remainder alone turned 119.7 into "1h 60m".
  const total = Math.round(minutes);
  if (!(total > 0)) return t(locale, "g.windowNow", { name });
  const time = total < 60
    ? t(locale, "g.onlyMinutes", { minutes: total })
    : t(locale, "g.hoursMinutes", { hours: Math.floor(total / 60), minutes: total % 60 });
  return t(locale, "g.windowIn", { name, time });
}

/**
 * Fits moth, text and meta line into MAX_BODY_ROWS. The moth and the meta line
 * (medium, duration) stay; the spacer goes first, then the text is cut to the
 * rows left with an ellipsis, so nothing slides under the footer.
 */
export function fitBody(
  head: readonly string[],
  text: readonly string[],
  tail: readonly string[],
  width = DEFAULT_WIDTH,
): string[] {
  const room = Math.max(1, MAX_BODY_ROWS - head.length - tail.length);
  const spacer = text.length + 1 <= room ? [""] : [];
  const rows = room - spacer.length;
  const shown = text.length <= rows
    ? [...text]
    : [...text.slice(0, rows - 1), truncate((text[rows - 1] ?? "") + " …", width)];
  return [...head, ...spacer, ...shown, ...tail].slice(0, MAX_BODY_ROWS);
}

export function truncate(text: string, maxWidth: number): string {
  if (text.length <= maxWidth) return text;
  return text.slice(0, Math.max(0, maxWidth - 1)).trimEnd() + "…";
}

export function wrap(text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  if (maxWidth <= 0) return [text];

  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current === "" ? word : current + " " + word;
    if (candidate.length <= maxWidth) current = candidate;
    else { if (current !== "") lines.push(current); current = word; }
  }
  if (current !== "") lines.push(current);
  return lines;
}
