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
      body: [...moth, "", ...wrap(options.result.text, width)],
      footer: "tap = carry on",
    };
  }

  const body: string[] = [...moth];
  body.push(mothLine(status.moth.state, status.moth.gesture));

  if (status.quest) {
    body.push("");
    // The instruction is what you act on; the short name is the heading.
    body.push(...wrap(status.quest.task ?? status.quest.title, width));
    const meta = questMeta(status.quest);
    if (meta) body.push(meta);
  } else {
    body.push("");
    body.push("No quest. Hold for a new one.");
  }

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
  if (minutes <= 0) return name + " now";
  if (minutes < 60) return name + " in " + Math.round(minutes) + "m";
  const hours = Math.floor(minutes / 60);
  return name + " in " + hours + "h " + Math.round(minutes % 60) + "m";
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
