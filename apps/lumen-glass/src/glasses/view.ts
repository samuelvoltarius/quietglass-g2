import type { LumenStatus } from "../lumen/client";
import type { Locale } from "../i18n";
import { messages, t } from "../messages";
import { armedFooter, footer } from "./footer";

/**
 * What the text pages of the glasses show (QUS v1): the start page, the quest
 * as a reading view (title, then the instruction, then medium and duration)
 * and the photo flow. The moth is the cockpit image (src/cockpit), not text.
 *
 * Every page is a header `Mode · ● live`, a few rows and ONE footer line.
 */
export interface LumenView {
  readonly header: string;
  readonly body: readonly string[];
  readonly footer: string;
}

export type Phase = "idle" | "shooting" | "submitting" | "result";

/** What is on the glasses: the start page, the quest, or the moth (a cockpit image, see src/cockpit). */
export type Screen = "start" | "quest" | "moth";

export interface ViewOptions {
  readonly phase: Phase;
  /** Outcome of the last submission. */
  readonly result: { readonly ok: boolean; readonly text: string } | null;
  readonly error: string | null;
  /** A hold armed "new quest" and waits for its confirming tap: the footer says what that tap does. */
  readonly confirmQuest?: boolean;
  /** Language of everything the app itself writes; LUMEN's own words pass through. */
  readonly locale: Locale;
  readonly lineWidth?: number;
  /** First start: the data is made up; a one-line hint says how to connect (QIS v1.2 no. 7). */
  readonly demo?: boolean;
  /** The text page to build: the start page or the quest (default). */
  readonly screen?: Screen;
  /** The cursor of the start page. */
  readonly startCursor?: number;
}

/** Body and footer span the full 576 px display: about 56 characters. */
export const LINE_COLS = 56;
export const HEADER_COLS = 56;
export const BODY_COLS = 56;
const DEFAULT_WIDTH = BODY_COLS;

/** Lines the body container shows before the text runs into the footer. */
export const MAX_BODY_ROWS = 7;

/** `Mode · state` within the header row (QUS 1.1). */
function headerOf(title: string, label: string): string {
  return truncate(`${title} · ${label}`, HEADER_COLS);
}

/** The state in the header: `● live`, `Demo` or `offline`. */
export function liveLabel(locale: Locale, state: "live" | "demo" | "offline"): string {
  return state === "live" ? "● " + t(locale, "g.live") : t(locale, state === "demo" ? "g.demoWord" : "g.s.offline");
}

export type StartRow = { readonly kind: "quest" } | { readonly kind: "moth" };

/** The selectable rows: at most three entries, here the quest and the moth. */
export function startRows(): StartRow[] {
  return [{ kind: "quest" }, { kind: "moth" }];
}

export function buildView(
  status: LumenStatus | null,
  options: ViewOptions,
): LumenView {
  const { locale } = options;
  const x = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  const width = options.lineWidth ?? DEFAULT_WIDTH;
  const live = options.demo ? liveLabel(locale, "demo") : options.error || !status ? liveLabel(locale, "offline") : liveLabel(locale, "live");

  if (options.screen === "start") {
    const rows = startRows();
    const at = Math.min(Math.max(0, options.startCursor ?? 0), rows.length - 1);
    const labels = rows.map((row) => row.kind === "quest"
      ? `${x("g.start.quest")} · ${status?.quest ? truncate(status.quest.title, 28) : x("g.start.noQuest")}`
      : `${x("g.start.moth")} · ${status ? `${Math.round(status.moth.light)} %` : "–"}`);
    const body = labels.map((label, index) => truncate((index === at ? "● " : "  ") + label, width));
    if (options.error) body.push(truncate(errorText(options.error, locale), width));
    if (options.demo) body.push(truncate(x("g.demo"), width));
    return { header: headerOf(x("g.title"), live), body, footer: footer(locale, { tap: x("g.v.open"), swipe: x("g.v.pick") }, "exit") };
  }

  if (options.error) {
    return {
      header: headerOf(x("g.title"), x("g.s.error")),
      body: fitBody([], wrap(errorText(options.error, locale), width), [x("g.checkAddress")], width),
      footer: footer(locale, { tap: x("g.v.retry") }, "back"),
    };
  }

  if (!status) {
    return { header: headerOf(x("g.title"), x("g.s.connecting")), body: [x("g.connecting")], footer: footer(locale, {}, "back") };
  }

  if (options.phase === "shooting") {
    return { header: headerOf(x("g.title"), x("g.s.photo")), body: [x("g.shooting")], footer: footer(locale, {}, "back") };
  }

  // Nothing can be done while the photo is on its way: no gesture is offered.
  if (options.phase === "submitting") {
    return { header: headerOf(x("g.title"), x("g.s.sending")), body: [x("g.sending")], footer: "" };
  }

  if (options.phase === "result" && options.result) {
    const text = options.result.ok
      ? x(options.result.text === "done" ? "g.done" : "g.sent")
      : errorText(options.result.text, locale);
    return {
      header: headerOf(x("g.title"), x(options.result.ok ? "g.accepted" : "g.rejected")),
      body: fitBody([], wrap(text, width), [], width),
      footer: footer(locale, { tap: x("g.v.on") }, "back"),
    };
  }

  // The quest: its short name is the heading, the instruction is what you act on, then medium and duration.
  const armed = Boolean(options.confirmQuest);
  const demo = options.demo ? [truncate(x("g.demo"), width)] : [];
  const quest = status.quest;
  const body = quest
    ? fitBody([truncate(quest.title, width)], wrap(quest.task ?? quest.title, width), [truncate(questMeta(quest, locale), width), ...demo].filter(Boolean), width)
    : fitBody([], wrap(x("g.noQuest"), width), demo, width);

  return {
    header: headerOf(x("g.start.quest"), armed ? x("g.s.newQuest") : live),
    body,
    footer: armed
      ? armedFooter(locale, x("g.v.newQuest"))
      : footer(locale, { ...(quest ? { tap: x("g.v.photo") } : {}), hold: x("g.v.quest") }, "back"),
  };
}

/**
 * The client reports its own failures in fixed English words (see
 * src/lumen/client.ts); those are translated here. A bare HTTP status or a
 * generic failure becomes a plain sentence; anything else is LUMEN's own wording and passes through.
 */
export function errorText(error: string, locale: Locale): string {
  const key = Object.keys(messages.en).find((name) => name.startsWith("g.err.") && messages.en[name] === error);
  if (key) return t(locale, key);
  // QIS v1.2 no. 8: no HTTP codes or exception text on the glasses; the phone's More tab has the detail.
  if (/^HTTP \d+/.test(error) || error === "failed") return t(locale, "g.err.failed");
  return error;
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
  // A blank row separates a heading from the text; without a heading there is nothing to separate.
  const spacer = head.length > 0 && text.length + 1 <= room ? [""] : [];
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
