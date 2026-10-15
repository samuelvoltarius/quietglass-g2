import { lightBar, mothLine } from "../lumen/moth";
import type { LumenStatus } from "../lumen/client";
import type { Locale } from "../i18n";
import { messages, t } from "../messages";
import { armedFooter, footer } from "./footer";

/**
 * What the glasses show.
 *
 * The moth is a pixel sprite in the header corner (src/glasses/sprite.ts); the
 * body is all text: one line of what the moth does, then the task, then the
 * medium and duration. The light window sits in the footer.
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
  /** A hold armed "new quest" and waits for its confirming tap: the footer says what that tap does. */
  readonly confirmQuest?: boolean;
  /** The help page is open. */
  readonly help?: boolean;
  /** Language of everything the app itself writes; LUMEN's own words pass through. */
  readonly locale: Locale;
  readonly lineWidth?: number;
  /** First start: the data is made up; a one-line hint says how to connect (QIS v1.2 no. 7). */
  readonly demo?: boolean;
  /** The page carries the glasses' side menu (SIDE_MENU in main.ts). Off by default: swipe opens the help, hold asks for a new quest. */
  readonly sideMenu?: boolean;
}

/**
 * Body and footer span the full 576 px display: about 56 characters.
 * The header leaves its top-right 64 px to the pixel moth, which leaves
 * room for about 48.
 */
export const LINE_COLS = 56;
export const HEADER_COLS = 48;
export const BODY_COLS = 56;
const DEFAULT_WIDTH = BODY_COLS;

/** Lines the body container shows before the text runs into the footer. */
export const MAX_BODY_ROWS = 7;

/** `LUMEN · state` (QIS v1), within the width the pixel moth leaves. */
function headerOf(label: string): string {
  return truncate(`LUMEN · ${label}`, HEADER_COLS);
}

export function buildView(
  status: LumenStatus | null,
  options: ViewOptions,
): LumenView {
  const { locale } = options;
  const x = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  const width = options.lineWidth ?? DEFAULT_WIDTH;

  if (options.help) return helpView(locale, width);

  if (options.error) {
    return {
      header: headerOf(x("g.s.error")),
      body: fitBody(wrap(errorText(options.error, locale), width), [], [x("g.checkAddress")], width),
      footer: footer(locale, { tap: x("g.v.retry") }, "exit"),
    };
  }

  if (!status) {
    return { header: headerOf(x("g.s.connecting")), body: [x("g.connecting")], footer: footer(locale, {}, "exit") };
  }

  if (options.phase === "shooting") {
    return { header: headerOf(x("g.s.photo")), body: [x("g.shooting")], footer: footer(locale, {}, "exit") };
  }

  // Nothing can be done while the photo is on its way: no gesture is offered.
  if (options.phase === "submitting") {
    return { header: headerOf(x("g.s.sending")), body: [x("g.sending")], footer: "" };
  }

  if (options.phase === "result" && options.result) {
    const text = options.result.ok
      ? x(options.result.text === "done" ? "g.done" : "g.sent")
      : errorText(options.result.text, locale);
    return {
      header: headerOf(x(options.result.ok ? "g.accepted" : "g.rejected")),
      body: fitBody([], wrap(text, width), [], width),
      footer: footer(locale, { tap: x("g.v.on") }, "back"),
    };
  }

  // LUMEN's own wording, which can be any length: one line, never a wrap.
  const head = [truncate(mothLine(status.moth.state, status.moth.gesture), width)];
  const light = lightLine(status, locale);
  const armed = Boolean(options.confirmQuest);
  const demo = options.demo ? [truncate(x("g.demo"), width)] : [];

  const body = status.quest
    // The instruction is what you act on; the short name is the heading.
    ? fitBody(head, wrap(status.quest.task ?? status.quest.title, width), [truncate(questMeta(status.quest, locale), width), light, ...demo].filter(Boolean), width)
    : fitBody(head, wrap(x("g.noQuest"), width), [light, ...demo].filter(Boolean), width);

  return {
    // LUMEN's own word for the moth's state (it can be any length) stands in the header.
    header: headerOf(armed ? x("g.s.newQuest") : status.moth.state),
    body,
    footer: armed
      ? armedFooter(locale, x("g.v.newQuest"))
      // QIS v1.2 with a side menu: help and "new quest" live there and a swipe does nothing here.
      : options.sideMenu === true
        ? footer(locale, { ...(status.quest ? { tap: x("g.v.photo") } : {}), hold: x("g.v.menu") }, "exit")
        : footer(locale, { ...(status.quest ? { tap: x("g.v.photo") } : {}), swipe: x("g.v.help"), hold: x("g.v.quest") }, "exit"),
  };
}

/** The help page (QIS v1): the gestures in footer order, then what the app needs. */
export function helpView(locale: Locale, width = DEFAULT_WIDTH): LumenView {
  const x = (key: string): string => t(locale, key);
  return {
    header: headerOf(x("g.s.help")),
    body: ["g.h.tap", "g.h.swipe", "g.h.hold", "g.h.end", "g.h.needs"].map((key) => truncate(x(key), width)),
    footer: footer(locale, { tap: x("g.v.back") }, "back"),
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

/**
 * Light, streak and light window on one full-width line (the footer carries the gestures now, QIS v1).
 * When that is too long (a long streak, a window hours away, German), the streak goes first. The light
 * window is the reason this line exists: it is the reason to stand up now rather than later.
 */
function lightLine(status: LumenStatus, locale: Locale): string {
  const bar = lightBar(status.moth.light, 8);
  const streak = status.moth.streak > 0 ? t(locale, "g.streak", { days: status.moth.streak }) : "";
  const light = status.window ? windowLabel(status.window.kind, status.window.minutesAway, locale) : "";

  const join = (parts: string[]): string => parts.filter(Boolean).join(" · ");
  for (const parts of [[bar, streak, light], [bar, light]]) {
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
