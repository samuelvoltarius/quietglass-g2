import type { Locale } from "../i18n";
import { t } from "../messages";
import type { AgentState } from "../terminal/types";
import { agentMood } from "../glasses/face";
import type { Mood } from "../glasses/mascot";
import { footer } from "../glasses/footer";
import type { Armed } from "../glasses/view";

/**
 * What the status cockpit shows, in words and numbers, decided without
 * drawing (QUS v1): the headline, the label/value cells, the mascot of the
 * left half, the caption and the one hint line. compose.ts only lays this out.
 */

export type Tone = "ok" | "warn" | "critical" | "offline";

export interface CockpitCell {
  readonly label: string;
  readonly value: string;
  /** Drawn with a frame round it. */
  readonly alert?: boolean;
}

export interface CockpitModel {
  readonly title: string;
  readonly clock: string;
  /** One or two lines, upper case. */
  readonly headline: readonly string[];
  /** Rows of three columns. */
  readonly cells: readonly CockpitCell[];
  /** The mascot's mood and the time it is drawn for (it blinks and writes). */
  readonly mood: Mood;
  readonly now: number;
  /** Left bottom: the session title. */
  readonly caption: string;
  /** The one footer line with the gestures. */
  readonly hint: string;
  readonly tone: Tone;
}

export interface CockpitInput {
  readonly state: AgentState;
  readonly now: Date;
  readonly locale: Locale;
  readonly demo: boolean;
  /** No working line to the agent. */
  readonly offline: boolean;
  readonly armed: Armed | null;
  /** Hold interrupts (the agent is busy and can be steered) instead of opening the session list. */
  readonly canInterrupt: boolean;
}

const DASH = "–";

/** The mascot moves in these steps: every change costs a picture over Bluetooth, so it is calmer than the text page's face was. */
export const MASCOT_FRAME_MS = 1500;

/**
 * How long the agent has been working, coarse on purpose (5 s, then whole minutes): the cell is a picture, and a
 * value that changes every second would send a tile every second.
 */
export function coarseElapsed(since: Date | null, now: Date): string {
  if (!since) return "";
  const seconds = Math.max(0, Math.round((now.getTime() - since.getTime()) / 1000));
  if (seconds < 60) return `${Math.floor(seconds / 5) * 5} s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")}`;
}

/** "HH:MM" of a date in the phone's time (24 h). */
export function hhmm(time: Date): string {
  return `${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}`;
}

/** How the agent stands: offline, working/ready = ok, an armed interrupt = warn. */
export function toneOf(input: CockpitInput): Tone {
  if (input.offline) return "offline";
  if (input.armed === "interrupt") return "warn";
  return "ok";
}

/** The one statement of the page. */
export function headlineFor(input: CockpitInput): string[] {
  const x = (key: string): string => t(input.locale, key);
  if (input.armed === "interrupt") return [x("g.cp.interrupt")];
  if (input.offline) return [x("g.cp.offline")];
  return [x(input.state.busy ? "g.cp.working" : "g.cp.ready")];
}

/** The six cells: agent, session, time, steps, tool, access. */
export function cockpitCells(input: CockpitInput): CockpitCell[] {
  const { state, locale } = input;
  const x = (key: string): string => t(locale, key);
  const provider = state.session?.provider ? state.session.provider.toUpperCase() : DASH;
  const title = state.session?.title.replace(/\s+/g, " ").trim() ?? "";
  const time = state.busy ? coarseElapsed(state.startedAt, input.now) : "";
  return [
    { label: x("g.cp.agent"), value: provider },
    { label: x("g.cp.session"), value: title || DASH },
    { label: x("g.cp.time"), value: time || DASH },
    { label: x("g.cp.steps"), value: state.busy || (state.steps ?? 0) > 0 ? String(state.steps ?? 0) : DASH },
    { label: x("g.cp.tool"), value: state.tool ?? DASH },
    { label: x("g.cp.access"), value: x(state.controllable ? "g.cp.control" : "g.cp.watch") },
  ];
}

/** The hint line: only the gestures that do something here. */
export function cockpitHint(input: CockpitInput): string {
  const x = (key: string): string => t(input.locale, key);
  if (input.armed === "interrupt") return x("g.confirm.interrupt");
  const hold = input.canInterrupt ? x("g.f.interrupt") : x("g.f.sessions");
  const line = footer(input.locale, { tap: x("g.f.replay"), swipe: x("g.f.answer"), hold }, "exit");
  return input.demo ? footer(input.locale, { hint: x("g.demoFoot") }, "exit") : line;
}

export function cockpitModel(input: CockpitInput): CockpitModel {
  const { state } = input;
  return {
    title: input.demo ? `${t(input.locale, "g.title")} · DEMO` : t(input.locale, "g.title"),
    clock: hhmm(input.now),
    headline: headlineFor(input),
    cells: cockpitCells(input),
    mood: agentMood(state, input.offline),
    now: Math.floor(input.now.getTime() / MASCOT_FRAME_MS) * MASCOT_FRAME_MS,
    caption: state.session?.title.replace(/\s+/g, " ").trim() || DASH,
    hint: cockpitHint(input),
    tone: toneOf(input),
  };
}

/** A key that changes exactly when what the cockpit would draw changes (the mascot's step counts). */
export function modelKey(model: CockpitModel): string {
  return JSON.stringify([model.clock, model.headline, model.cells, model.mood, model.now, model.caption, model.hint]);
}
