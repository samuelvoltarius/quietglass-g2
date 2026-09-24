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
  const visible = Math.max(1, options.visibleLines ?? preset.visibleLines);
  const lead = Math.max(0, options.leadLines ?? preset.leadLines);

  if (lines.length === 0) {
    return {
      header: script.title || "PromptFlow",
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
    header: headerText(script, lines, current),
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
