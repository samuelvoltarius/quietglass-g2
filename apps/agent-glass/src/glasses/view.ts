import type { AgentState } from "../terminal/types";
import type { Locale } from "../i18n";
import { localizeError, t } from "../messages";

/**
 * What the glasses show while an agent works.
 *
 * One screen matters more than all the others: the moment the agent stops and
 * asks permission. Everything else here is context you may glance at; that one
 * is the reason to look up at all, so it takes the whole display and says
 * plainly what will happen.
 *
 * Display lessons already paid for elsewhere in Quietglass and applied here:
 * the font is **proportional**, so columns built from spaces do not line up —
 * separators are explicit. And the glasses draw nothing at all for characters
 * like "▸", so markers stay ASCII.
 */

export interface AgentView {
  readonly header: string;
  readonly body: readonly string[];
  readonly footer: string;
}

export const LINE_WIDTH = 46;
export const BODY_ROWS = 7;

/** Wraps text to the display width, keeping words intact. */
export function wrap(text: string, width: number = LINE_WIDTH): readonly string[] {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) { out.push(""); continue; }
    let line = "";
    for (const word of words) {
      // A single word longer than the display is hard-cut; without this it
      // would silently push the whole line past the right edge.
      if (word.length > width) {
        if (line) { out.push(line); line = ""; }
        for (let i = 0; i < word.length; i += width) out.push(word.slice(i, i + width));
        continue;
      }
      if (!line) line = word;
      else if (line.length + 1 + word.length <= width) line += ` ${word}`;
      else { out.push(line); line = word; }
    }
    if (line) out.push(line);
  }
  return out;
}

/**
 * Keeps the **end** of a long text rather than the beginning.
 *
 * While the agent is typing, the newest sentence is the one worth reading; the
 * start of a long answer has already scrolled out of interest.
 */
export function tail(lines: readonly string[], rows: number): readonly string[] {
  return lines.length <= rows ? lines : lines.slice(lines.length - rows);
}

export function elapsed(since: Date | null, now: Date): string {
  if (!since) return "";
  const seconds = Math.max(0, Math.round((now.getTime() - since.getTime()) / 1000));
  if (seconds < 60) return `${seconds} s`;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** First rows of a list, with the last kept row marked as cut when needed. */
export function head(lines: readonly string[], rows: number): readonly string[] {
  if (lines.length <= rows) return lines;
  const kept = lines.slice(0, rows);
  kept[rows - 1] = clip(`${kept[rows - 1] ?? ""}…`);
  return kept;
}

/** Hard limit for a single row that does not go through `wrap`. */
export function clip(text: string, width: number = LINE_WIDTH): string {
  const flat = text.replace(/\s+/g, " ");
  return flat.length <= width ? flat : flat.slice(0, width - 1) + "…";
}

/** Shortens a session title to something readable in one glance. */
export function shortTitle(title: string, width = 40): string {
  return title.length <= width ? title : title.slice(0, width - 1) + "…";
}

export function buildView(state: AgentState, now: Date, locale: Locale = "en"): AgentView {
  const x = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  if (state.error) {
    // The CORS hint only helps against Even Terminal; under Hermes or OpenClaw
    // it would send the user looking in the wrong place. The error text comes
    // from the backend and can be arbitrarily long, so it is clipped to the
    // rows that are left.
    const hint = /Even Terminal/.test(state.error)
      ? ["", x("g.corsHint1"), x("g.corsHint2")] : [];
    const room = BODY_ROWS - 1 - hint.length;
    return {
      header: x("g.title"),
      body: ["", ...head(wrap(localizeError(state.error, locale)), room), ...hint],
      footer: x("g.tapRetry"),
    };
  }

  if (!state.session) {
    return {
      header: x("g.title"),
      body: ["", x("g.noSession")],
      footer: x("g.holdChoose"),
    };
  }

  // The decision screen. It deliberately drops the running text: while the
  // agent is blocked, nothing else on the display can be acted on, and a wall
  // of context is exactly what you do not want to read before saying yes.
  if (state.pending) {
    const detail = wrap(state.pending.detail);
    return {
      header: state.pending.kind === "permission" ? x("g.permission") : x("g.question"),
      body: [
        // Tool names are the agent's own identifiers and stay as they are;
        // only the generic fallbacks from the event parser are translated.
        clip(state.pending.title === "Question" ? x("g.question")
          : state.pending.title === "Tool" ? x("g.tool") : state.pending.title),
        "",
        ...tail(detail, BODY_ROWS - 2),
      ],
      // Neither answer sits on a plain tap. A stray touch must not be able to
      // authorise a command, and swiping in two directions is symmetric,
      // deliberate, and unmistakable in either direction.
      //
      // On a session Even Terminal does not own, the swipes would 404. Saying
      // where the answer has to be given beats offering a control that fails
      // in silence.
      footer: state.controllable
        ? x("g.decide")
        : x("g.watchAnswer"),
    };
  }

  const lines = wrap(state.text || "…");
  const body = [...tail(lines, state.tool ? BODY_ROWS - 2 : BODY_ROWS)];

  if (state.tool) {
    body.push("");
    body.push(clip(`> ${state.tool}`));
  }

  const status = state.busy
    ? x("g.working", { time: elapsed(state.startedAt, now) })
    : state.controllable ? x("g.ready") : x("g.watchOnly");

  const action = !state.controllable
    ? x("g.holdSwitch")
    : state.busy ? x("g.holdInterrupt") : x("g.holdSwitch");

  return {
    header: shortTitle(state.session.title),
    body,
    footer: `${status} · ${action}`,
  };
}

/** The session picker, shown on a long press. */
export function sessionList(
  sessions: readonly { title: string; cwd: string; status: string }[],
  selected: number,
  locale: Locale = "en",
): AgentView {
  if (sessions.length === 0) {
    return {
      header: t(locale, "g.sessions"),
      body: ["", t(locale, "g.noSessions"),
        "", t(locale, "g.agentRunning")],
      footer: t(locale, "g.tapBack"),
    };
  }

  const first = Math.max(0, Math.min(selected - BODY_ROWS + 1, sessions.length - BODY_ROWS));
  const window = sessions.slice(Math.max(0, first), Math.max(0, first) + BODY_ROWS);

  return {
    header: t(locale, "g.sessionsCount", { count: sessions.length }),
    body: window.map((session, offset) => {
      const index = Math.max(0, first) + offset;
      const cursor = index === selected ? ">" : " ";
      const busy = session.status && session.status !== "idle" ? " *" : "";
      return `${cursor} ${shortTitle(session.title, 38)}${busy}`.slice(0, LINE_WIDTH);
    }),
    footer: t(locale, "g.selectOpen"),
  };
}
