import type { DisplayLine } from "../prompter/layout";
import type { Script } from "../script/model";
import { sectionAtParagraph } from "../script/model";
import { lineAtWords, progress, remainingSeconds, type PrompterState } from "../prompter/engine";
import { MODE_PRESETS } from "../prompter/engine";

/**
 * What the glasses should show, as plain strings.
 *
 * Kept free of SDK types so it can be unit-tested and so the rendering layer
 * stays a thin adapter. The G2 is 576 x 288 with no font control, so the view
 * is expressed purely as lines of text.
 */
export interface PrompterView {
  readonly header: string;
  readonly body: readonly string[];
  readonly footer: string;
}

/**
 * The body container holds seven rows of text; an eighth is pushed off the
 * bottom of the display rather than shrunk to fit.
 */
export const MAX_BODY_ROWS = 7;
/** Characters the header holds on one line in the G2's proportional font. */
export const HEADER_WIDTH = 46;
/** Width of the current-line marker (`> ` / two spaces). */
export const CURSOR_WIDTH = 2;

/**
 * Width to wrap the script at. The marker is drawn in front of every line, so
 * it has to come out of the budget, or each full line overflows and the
 * firmware wraps it a second time.
 */
export function textWidth(lineWidth: number, showCursor: boolean): number {
  return Math.max(1, lineWidth - (showCursor ? CURSOR_WIDTH : 0));
}

export interface ViewOptions {
  /** Overrides the mode preset when the user picked a size on the phone. */
  readonly visibleLines?: number;
  readonly leadLines?: number;
  /** Marks the line being spoken. Off by default: a moving marker draws the eye. */
  readonly showCursor?: boolean;
}

export function buildView(
  script: Script,
  lines: readonly DisplayLine[],
  state: PrompterState,
  options: ViewOptions = {},
): PrompterView {
  const preset = MODE_PRESETS[state.mode];
  const visible = Math.min(MAX_BODY_ROWS, Math.max(1, options.visibleLines ?? preset.visibleLines));
  const lead = Math.max(0, options.leadLines ?? preset.leadLines);

  if (lines.length === 0) {
    return {
      header: truncate(script.title || "PromptFlow", HEADER_WIDTH),
      body: ["No script loaded.", "Paste one in the phone app."],
      footer: "",
    };
  }

  const current = lineAtWords(lines, state.wordsRead);
  const start = clamp(current - lead, 0, Math.max(0, lines.length - visible));
  const window = lines.slice(start, start + visible);

  const body = window.map((line, index) => {
    const text = line.text;
    if (!options.showCursor) return text;
    return start + index === current ? `> ${text}` : `  ${text}`;
  });

  return {
    header: truncate(headerText(script, lines, current), HEADER_WIDTH),
    body,
    footer: footerText(state, lines),
  };
}

function headerText(script: Script, lines: readonly DisplayLine[], current: number): string {
  const paragraph = lines[current]?.paragraph ?? 0;
  const section = sectionAtParagraph(script, paragraph);
  return section?.title || script.title || "PromptFlow";
}

/**
 * One glanceable status line: running state, speed, time left, progress.
 * Paused is stated explicitly — a stopped prompter must never look like a
 * running one that simply has no new words yet.
 */
function footerText(state: PrompterState, lines: readonly DisplayLine[]): string {
  const parts: string[] = [];

  if (state.mode === "notes") parts.push("NOTES");
  else parts.push(state.running ? "READING" : "PAUSED");

  if (state.wpm > 0) parts.push(`${state.wpm} wpm`);

  const left = remainingSeconds(state, lines);
  if (left !== null) parts.push(formatDuration(left));

  parts.push(`${Math.round(progress(state, lines) * 100)}%`);
  return parts.join("  ·  ");
}

export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

export function truncate(text: string, maxWidth: number): string {
  if (text.length <= maxWidth) return text;
  return text.slice(0, Math.max(0, maxWidth - 1)).trimEnd() + "…";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
