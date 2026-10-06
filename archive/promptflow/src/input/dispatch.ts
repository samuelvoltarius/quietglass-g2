import type { Gesture } from "./gestures";
import type { DisplayLine } from "../prompter/layout";
import type { Script } from "../script/model";
import { nextSectionStart, previousSectionStart } from "../script/model";
import { lineOfParagraph } from "../prompter/layout";
import {
  adjustWpm,
  jumpLines,
  jumpToLine,
  lineAtWords,
  toggleRunning,
  WPM_STEP,
  type PrompterState,
} from "../prompter/engine";

/**
 * Gesture handling for the single prompter screen.
 *
 * The G2 rebuilds a page slowly on real hardware, so PromptFlow never changes
 * screens while reading: every gesture edits the state of the one page in
 * place. Leaving the app is the only transition.
 */

export type Effect = { readonly kind: "exit" };

export interface DispatchResult {
  readonly state: PrompterState;
  readonly effects: readonly Effect[];
}

export interface DispatchContext {
  readonly script: Script;
  readonly lines: readonly DisplayLine[];
  /** Lines moved by a single swipe while paused. */
  readonly stepLines?: number;
}

const NO_EFFECTS: readonly Effect[] = [];

export function dispatch(
  state: PrompterState,
  gesture: Gesture,
  context: DispatchContext,
): DispatchResult {
  const { script, lines } = context;
  const step = context.stepLines ?? 2;

  switch (gesture) {
    // The single most used control: start and stop the scroll.
    case "click":
      return { state: toggleRunning(state), effects: NO_EFFECTS };

    case "doubleClick":
      return { state, effects: [{ kind: "exit" }] };

    // While running, swipes trim the speed — the reader is mid-sentence and
    // must not lose their place. While paused, they move through the script.
    case "scrollUp":
      return state.running
        ? { state: adjustWpm(state, WPM_STEP), effects: NO_EFFECTS }
        : { state: jumpLines(state, lines, -step), effects: NO_EFFECTS };

    case "scrollDown":
      return state.running
        ? { state: adjustWpm(state, -WPM_STEP), effects: NO_EFFECTS }
        : { state: jumpLines(state, lines, step), effects: NO_EFFECTS };

    // Long press jumps by section. Deliberately not the primary control:
    // Even reserves long press for leaving the foreground app on some
    // firmware, so PromptFlow stays fully usable without it.
    case "longPress":
      return { state: jumpToSection(state, script, lines, 1), effects: NO_EFFECTS };

    case "longPressRelease":
      return { state, effects: NO_EFFECTS };

    default:
      return { state, effects: NO_EFFECTS };
  }
}

export function jumpToSection(
  state: PrompterState,
  script: Script,
  lines: readonly DisplayLine[],
  direction: 1 | -1,
): PrompterState {
  if (lines.length === 0) return state;
  const currentLine = lineAtWords(lines, state.wordsRead);
  const paragraph = lines[currentLine]?.paragraph ?? 0;

  const target = direction === 1
    ? nextSectionStart(script, paragraph)
    : previousSectionStart(script, paragraph);

  // No section ahead: run to the end; none behind: return to the top.
  if (target === null) {
    return jumpToLine(state, lines, direction === 1 ? lines.length - 1 : 0);
  }
  return jumpToLine(state, lines, lineOfParagraph(lines, target));
}
