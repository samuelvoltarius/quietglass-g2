import { drawMoth, lightBar, mothLine } from "../lumen/moth";
import type { LumenStatus } from "../lumen/client";

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
  readonly lineWidth?: number;
}

const DEFAULT_WIDTH = 46;

/** Lines the body container shows before the text runs into the footer. */
export const MAX_BODY_ROWS = 7;

export function buildView(
  status: LumenStatus | null,
  options: ViewOptions,
): LumenView {
  if (options.error) {
    return {
      header: "Lumen",
      body: [options.error, "Check the address in the phone app."],
      footer: "tap = retry",
    };
  }

  if (!status) {
    return { header: "Lumen", body: ["Connecting…"], footer: "" };
  }

  const width = options.lineWidth ?? DEFAULT_WIDTH;
  const moth = drawMoth(status.moth.state);

  if (options.phase === "shooting") {
    return {
      header: "",
      body: [...moth, "", "Taking a photo on your phone…"],
      footer: "",
    };
  }

  if (options.phase === "submitting") {
    return { header: "", body: [...moth, "", "Sending to Lumen…"], footer: "" };
  }

  if (options.phase === "result" && options.result) {
    return {
      header: options.result.ok ? "Accepted" : "Not accepted",
      body: fitBody([...moth], wrap(options.result.text, width), [], width),
      footer: "tap = carry on",
    };
  }

  // LUMEN's own wording, which can be any length: one line, never a wrap.
  const head = [...moth, truncate(mothLine(status.moth.state, status.moth.gesture), width)];

  const body = status.quest
    // The instruction is what you act on; the short name is the heading.
    ? fitBody(head, wrap(status.quest.task ?? status.quest.title, width), [questMeta(status.quest)].filter(Boolean), width)
    : fitBody(head, ["No quest. Hold for a new one."], [], width);

  return {
    header: "",
    body,
    footer: footerText(status, Boolean(status.quest)),
  };
}

/**
 * The line under the instruction: what medium, how long, and a warning when
 * the quest cannot be answered from here at all.
 *
 * LUMEN also hands out video quests. The glasses can only open the phone's
 * still camera, so saying so up front is better than letting the user shoot
 * and have it rejected.
 */
export function questMeta(quest: { medium: string | null; minutes: number | null }): string {
  const parts: string[] = [];
  if (quest.medium === "video") parts.push("VIDEO — shoot this on the camera");
  else if (quest.medium) parts.push(quest.medium.toUpperCase());
  if (quest.minutes !== null && quest.minutes > 0) parts.push(quest.minutes + " min");
  return parts.join("  ·  ");
}

function footerText(status: LumenStatus, hasQuest: boolean): string {
  const parts: string[] = [lightBar(status.moth.light)];

  if (status.moth.streak > 0) parts.push(status.moth.streak + "d");

  // The light window is the single most useful thing on this display: it is
  // the reason to stand up now rather than later.
  if (status.window) parts.push(windowLabel(status.window.kind, status.window.minutesAway));

  parts.push(hasQuest ? "tap = photo" : "hold = quest");
  return parts.join("  ·  ");
}

export function windowLabel(kind: string, minutes: number): string {
  const name = kind.startsWith("golden") ? "golden" : kind.startsWith("blau") ? "blue" : kind;
  // Round once, up front: rounding the remainder alone turned 119.7 into "1h 60m".
  const total = Math.round(minutes);
  if (!(total > 0)) return name + " now";
  if (total < 60) return name + " in " + total + "m";
  return name + " in " + Math.floor(total / 60) + "h " + (total % 60) + "m";
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
