import type { AgentState } from "../terminal/types";
import type { Locale } from "../i18n";
import { localizeError, t } from "../messages";
import { ageLabel } from "../sessions/model";
import { footer } from "./footer";

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

export const LINE_WIDTH = 56;
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
export function shortTitle(title: string, width = 46): string {
  return title.length <= width ? title : title.slice(0, width - 1) + "…";
}

/** What the wearer can arm with a first tap. */
export type Armed = "allow" | "deny" | "interrupt";

/** The state of the answer list and of an armed action; the glasses only draw it. */
export interface ChoiceUi {
  /** Cursor in the list: 0 = Erlauben, 1 = Ablehnen. */
  readonly choice: 0 | 1;
  readonly armed: Armed | null;
  /** Whether the backend can answer approvals at all (hermes/openclaw cannot). */
  readonly decisions: boolean;
}

const NO_UI: ChoiceUi = { choice: 0, armed: null, decisions: true };
/** The header leaves the top-right corner to the face, so it is a little shorter than a body row. */
const HEADER_WIDTH = 48;

const MARK_ON = "● ";
const MARK_OFF = "○ ";

/** `AGENT · state` (and the session title when there is room), the QIS header. */
export function headerLine(locale: Locale, state: string, title = ""): string {
  const base = `${t(locale, "g.title")} · ${state}`;
  return clip(title ? `${base} · ${title}` : base, HEADER_WIDTH);
}

export function buildView(state: AgentState, now: Date, locale: Locale = "en", page = 0, ui: ChoiceUi = NO_UI): AgentView {
  const x = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  if (state.error) {
    // The setup hint only helps against Even Terminal (the phone page names
    // the --allow-cors flag); under Hermes or OpenClaw it would send the user
    // looking in the wrong place. The error text comes from the backend and can
    // be arbitrarily long, so it is clipped to the rows that are left.
    const hint = /Even Terminal/.test(state.error)
      ? ["", x("g.setupHint")] : [];
    const room = BODY_ROWS - 1 - hint.length;
    return {
      header: headerLine(locale, x("g.s.error")),
      body: ["", ...head(wrap(localizeError(state.error, locale)), room), ...hint],
      footer: footer(locale, { tap: x("g.f.retry") }, "exit"),
    };
  }

  if (!state.session) {
    return {
      header: headerLine(locale, x("g.s.noSession")),
      body: ["", x("g.noSession")],
      footer: footer(locale, { hold: x("g.f.sessions") }, "exit"),
    };
  }

  const title = shortTitle(state.session.title, 24);

  // The decision screen. It deliberately drops the running text: while the
  // agent is blocked, nothing else on the display can be acted on, and a wall
  // of context is exactly what you do not want to read before saying yes.
  if (state.pending) {
    const detail = wrap(state.pending.detail);
    const heading = clip(state.pending.title === "Question" ? x("g.question")
      : state.pending.title === "Tool" ? x("g.tool") : state.pending.title);
    const permission = state.pending.kind === "permission";
    // On a session Even Terminal does not own (or a backend without approvals)
    // a list would offer a control that fails in silence: say where to answer.
    if (!permission || !state.controllable || !ui.decisions) {
      return {
        header: headerLine(locale, x(permission ? "g.s.permission" : "g.s.question"), title),
        body: [heading, "", ...tail(detail, BODY_ROWS - 4), "", x("g.watchAnswer")],
        footer: footer(locale, {}, "exit"),
      };
    }
    // Approvals are never a swipe direction: a list, the swipe moves the
    // cursor, a tap arms, a second tap sends. Swipe, 2x or 4 s cancel.
    const armedHere = ui.armed === "allow" || ui.armed === "deny";
    const list = [
      MARK_OFF + x("g.opt.allow"),
      MARK_OFF + x("g.opt.deny"),
    ];
    list[ui.choice] = MARK_ON + (ui.choice === 0 ? x("g.opt.allow") : x("g.opt.deny"));
    return {
      header: headerLine(locale, x(armedHere ? "g.s.armed" : "g.s.permission"), title),
      body: [heading, ...tail(detail, BODY_ROWS - 4), "", ...list],
      footer: armedHere
        ? x(ui.armed === "allow" ? "g.confirm.allow" : "g.confirm.deny")
        : footer(locale, { tap: x("g.f.choose"), swipe: true }, "exit"),
    };
  }

  const lines = wrap(state.text || "…");
  const newestRows = state.tool ? BODY_ROWS - 2 : BODY_ROWS;
  const paged = pageWindow(lines, newestRows, BODY_ROWS, page);

  if (paged.page > 0) {
    // Reading back through a long answer: the whole display is text, and the
    // header says where you are; a tap returns to the newest part.
    return {
      header: headerLine(locale, x("g.s.page", { n: paged.pages - paged.page, total: paged.pages }), title),
      body: paged.lines,
      footer: footer(locale, { tap: x("g.f.newest"), swipe: true }, "exit"),
    };
  }

  const body = [...paged.lines];

  if (state.tool) {
    body.push("");
    body.push(clip(`> ${state.tool}`));
  }

  const status = state.busy
    ? x("g.s.working", { time: elapsed(state.startedAt, now) })
    : state.controllable ? x("g.s.ready") : x("g.s.watchOnly");

  // Interrupting is armed first (a hold alone never stops the agent).
  if (ui.armed === "interrupt") {
    return {
      header: headerLine(locale, x("g.s.armed"), title),
      body,
      footer: x("g.confirm.interrupt"),
    };
  }
  const hold = state.busy && state.controllable ? x("g.f.interrupt") : x("g.f.sessions");
  return {
    header: headerLine(locale, status, title),
    body,
    footer: footer(locale, { tap: x("g.f.replay"), ...(paged.pages > 1 ? { swipe: true as const } : {}), hold }, "exit"),
  };
}

/** The help page: the four gestures in footer order, plus what the app needs. */
export function helpView(locale: Locale = "en"): AgentView {
  return {
    header: headerLine(locale, t(locale, "g.s.help")),
    body: ["", ...[1, 2, 3, 4, 5].flatMap((n) => wrap(t(locale, "g.help." + n)).slice(0, 1))],
    footer: footer(locale, { tap: t(locale, "g.f.close") }, "back"),
  };
}

export interface PageWindow {
  readonly lines: readonly string[];
  /** 0 = the newest part; counts back towards the start of the answer. */
  readonly page: number;
  readonly pages: number;
}

/**
 * One screen of a long answer, counted back from its end.
 *
 * Page 0 is the newest part (what the glasses show while the agent types,
 * leaving room for the tool line); every older page is a full screen. The
 * oldest page is filled from the start, so it never shows half a screen.
 */
export function pageWindow(
  lines: readonly string[], newestRows: number, rows: number = BODY_ROWS, page = 0,
): PageWindow {
  const before = Math.max(0, lines.length - newestRows);
  const pages = 1 + Math.ceil(before / rows);
  const current = Math.min(Math.max(0, Math.floor(page)), pages - 1);
  if (current === 0) return { lines: tail(lines, newestRows), page: 0, pages };
  const end = before - rows * (current - 1);
  const start = Math.max(0, end - rows);
  return { lines: lines.slice(start, Math.min(lines.length, start + rows)), page: current, pages };
}

/** How many screens the current answer takes on the glasses (1 = no paging). */
export function answerPages(state: AgentState): number {
  if (state.error || !state.session || state.pending) return 1;
  return pageWindow(wrap(state.text || "…"), state.tool ? BODY_ROWS - 2 : BODY_ROWS).pages;
}

export interface SessionListOptions {
  /** First row is "+ New session"; `selected` 0 then means that row. */
  readonly canCreate?: boolean;
  /**
   * False when the backend has no session list at all (OpenClaw keeps one
   * conversation in the app). The list says so instead of pretending.
   */
  readonly listable?: boolean;
  /** For the age column; without it no age is shown. */
  readonly now?: Date;
}

/** The session picker, shown on a long press. */
export function sessionList(
  sessions: readonly { title: string; cwd: string; status: string; timestamp?: Date }[],
  selected: number,
  locale: Locale = "en",
  /** A session is open behind the list: a double tap goes back to it. */
  canGoBack = false,
  options: SessionListOptions = {},
): AgentView {
  const canCreate = options.canCreate === true;
  const listable = options.listable !== false;
  const empty = sessions.length === 0 && !canCreate;

  const labels = [
    ...(canCreate ? [{ text: t(locale, "g.newSession"), suffix: "" }] : []),
    ...sessions.map((session) => {
      const busy = session.status && session.status !== "idle" ? " *" : "";
      const age = listable && options.now ? ageLabel(session.timestamp, options.now, locale) : "";
      return { text: session.title, suffix: `${age ? ` · ${age}` : ""}${busy}` };
    }),
    // The last root entry of every Quietglass app (the side menu is off, so help is a row again).
    { text: t(locale, "g.opt.help"), suffix: "" },
  ];
  // A backend without a list gets one honest line at the bottom; an empty
  // list says so above the single "Hilfe" row.
  const intro = empty ? ["", t(locale, "g.noSessions"), t(locale, "g.agentRunning"), ""] : [];
  const rows = (listable ? BODY_ROWS : BODY_ROWS - 2) - intro.length;
  const first = Math.max(0, Math.min(selected - rows + 1, labels.length - rows));
  const window = labels.slice(first, first + rows);

  const body = window.map((label, offset) => {
    const cursor = first + offset === selected ? ">" : " ";
    const room = LINE_WIDTH - 2 - label.suffix.length;
    return `${cursor} ${shortTitle(label.text.replace(/\s+/g, " "), room)}${label.suffix}`.slice(0, LINE_WIDTH);
  });
  if (!listable) body.push("", clip(t(locale, "g.noList")));

  return {
    header: headerLine(locale, t(locale, "g.s.sessions", { count: sessions.length })),
    body: [...intro, ...body],
    footer: footer(locale, { tap: t(locale, "g.f.open"), swipe: true }, canGoBack ? "back" : "exit"),
  };
}
