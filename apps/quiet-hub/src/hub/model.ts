/**
 * Quiet Hub state machine and views.
 *
 * The root page is a conventional menu: swipe selects and tap opens. Inside a
 * page, swipe selects and tap acts; risky home/printer actions require a
 * second tap. Double tap goes back one level, except on root where Even
 * requires the native exit dialog. The agent page is three levels:
 *   agents (list) -> sessions of that agent -> the open session (ask).
 * Double tap climbs ask -> sessions -> agents -> overview; while an agent is
 * running, double tap in the open session is a real STOP first. Hold-to-talk
 * speaks into the selected session; the transcript is shown and needs a tap
 * to be sent (2x discards). A pending permission card takes over the agent
 * page: tap = allow, double tap = deny. While recording, double tap discards
 * the recording, so no state can trap the wearer.
 *
 * Every page also has a native contextual menu (tap + hold, drawn by the glasses
 * OS) with the page's actions; gestures stay as shortcuts. The R1 ring double
 * tap opens a page picker instead of exiting.
 */
import type { ScreenView } from "../glasses/screen";
import { fit, marked, wrap } from "../glasses/screen";
import { describeActivity, elapsedShort, workingDots } from "./activity";
import { tr, type Locale } from "../i18n";
import { messages } from "../messages";
import type { AgentEvent, AgentInfo, Approval, HomeSnapshot, HubReport, InboxSnapshot, PrinterSnapshot, SessionInfo } from "../api/types";
import { normalizeReport } from "../api/normalize";

export type Screen = "root" | "agent" | "home" | "printer" | "inbox";
export const SCREENS: readonly Screen[] = ["root", "agent", "home", "printer", "inbox"];
const ROOT_ITEMS: readonly Exclude<Screen, "root">[] = ["agent", "home", "printer", "inbox"];

/** How long a confirming double tap stays armed. */
export const CONFIRM_MS = 4000;
/** How long a feedback line stays in the footer. */
export const MESSAGE_MS = 5000;
/** Wrapped rows of one answer page (one more row carries the page indicator). */
export const PAGE_ROWS = 6;
/** Answers up to this many rows stay inline next to the questions. */
const INLINE_ROWS = 3;
/** Transcript rows shown at once while confirming a voice note; swipe scrolls. */
const VOICE_ROWS = 5;

export type HubGesture = "click" | "doubleClick" | "scrollUp" | "scrollDown" | "longPress" | "longPressRelease" | "ringDoubleClick";

/** Voice note in flight: transcribing, or transcript waiting for the wearer's tap. */
export type PendingVoice =
  | { readonly state: "transcribing"; readonly agentId: string }
  | { readonly state: "confirm"; readonly agentId: string; readonly text: string; readonly scroll?: number };

/** Why the hub cannot be used right now; null = the last report succeeded. */
export interface LinkStatus {
  readonly problem: "missing" | "unreachable" | "unauthorized" | "timeout" | "error" | "insecure";
  /** Server host only (never the token); "" when no server is configured. */
  readonly host: string;
  /** Failed attempts in a row. */
  readonly fails: number;
  /** True when a real report was received earlier in this run (then the last data stays visible for a moment). */
  readonly hadData: boolean;
}

/** The disconnected notice replaces the pages unless a short blip hit an already working link. */
export function linkBlocks(link: LinkStatus | null | undefined): boolean {
  return link !== null && link !== undefined && (!link.hadData || link.fails >= 2);
}

export interface HubModel {
  readonly link: LinkStatus | null;
  readonly report: HubReport;
  readonly screen: Screen;
  readonly rootSelected: number;
  readonly confirm: { readonly what: string; readonly label: string; readonly until: number } | null;
  readonly message: { readonly text: string; readonly until: number } | null;
  /** True while the microphone is recording a voice note. */
  readonly recording: boolean;
  /** Selected agent in the agent list, and which part of the agent page is open. */
  readonly agentIndex: number;
  readonly agentView: "list" | "sessions" | "ask";
  readonly questionIndex: number;
  /** Session list of the agent being browsed (null until first opened). */
  readonly sessions: SessionsState | null;
  /** Selected row of the session page: 0 = new, 1 = continue, 2.. = listed sessions. */
  readonly sessionIndex: number;
  /** Agent the running recording was started for. */
  readonly recordAgent: string | null;
  readonly voice: PendingVoice | null;
  /** Gesture help is showing; any gesture closes it. */
  readonly help: boolean;
  /** Page picker (ring double tap): selected entry, or null when closed. */
  readonly picker: number | null;
  /** Page of a long answer; the last page (= page count) is the question list. */
  readonly answerPage: number;
  /** Identifies the answer being paged, so a new answer starts on page 0. */
  readonly answerKey: string;
}

export interface SessionsState {
  readonly agentId: string;
  readonly status: "loading" | "ready" | "error" | "unsupported";
  readonly items: readonly SessionInfo[];
  readonly transport: string;
}

/** Side effects leave the model; main.ts runs them against the daemon. */
export type Effect =
  | { readonly kind: "ask"; readonly agentId: string; readonly question: string }
  | { readonly kind: "recordStart" }
  | { readonly kind: "recordAbort" }
  | { readonly kind: "loadSessions"; readonly agentId: string }
  | { readonly kind: "newSession"; readonly agentId: string }
  | { readonly kind: "selectSession"; readonly agentId: string; readonly sessionId: string; readonly title: string }
  | { readonly kind: "recordStop"; readonly agentId: string }
  | { readonly kind: "approve"; readonly cardId: string; readonly decision: "allow" | "deny" }
  | { readonly kind: "cancel"; readonly agentId: string }
  | { readonly kind: "exit" }
  | { readonly kind: "refresh" }
  | { readonly kind: "readAll"; readonly ids: readonly string[] }
  | { readonly kind: "readEvent"; readonly id: string }
  | { readonly kind: "toggle"; readonly device: string }
  | { readonly kind: "printer"; readonly action: "pause" | "resume" | "cancel" };

export function createModel(report: HubReport): HubModel {
  return {
    link: null, report: normalizeReport(report), screen: "root", rootSelected: 0, confirm: null, message: null, recording: false,
    agentIndex: 0, agentView: "list", questionIndex: 0, recordAgent: null, sessions: null, sessionIndex: 1,
    voice: null, help: false, picker: null, answerPage: 0, answerKey: "",
  };
}

const clampIndex = (value: number, length: number): number => Math.max(0, Math.min(value, Math.max(0, length - 1)));

function answerKeyOf(agent: AgentInfo | undefined): string {
  return agent === undefined ? "" : `${agent.id}|${agent.session?.id ?? ""}|${agent.lastQuestion ?? ""}`;
}

export function withLink(model: HubModel, link: LinkStatus | null): HubModel {
  if (link === null) return { ...model, link: null };
  // A failing link must never keep claiming "online" in the status line.
  return { ...model, link, report: { ...model.report, connection: link.problem === "missing" ? "missing" : "error" } };
}

/** A fresh report from the daemon keeps the wearer's selections. */
export function mergeReport(model: HubModel, next: HubReport): HubModel {
  const report = normalizeReport(next);
  const agentIndex = clampIndex(model.agentIndex, report.agents.length);
  const agent = report.agents[agentIndex];
  const key = answerKeyOf(agent);
  const fresh = key !== model.answerKey || agent?.busy === true;
  const pages = agent === undefined ? 0 : pageCount(agent);
  return {
    ...model,
    link: null,
    report: {
      ...report,
      home: { ...report.home, selected: clampIndex(model.report.home.selected, report.home.devices.length) },
      printer: { ...report.printer, selected: model.report.printer.selected },
      inbox: { ...report.inbox, selected: clampIndex(model.report.inbox.selected, report.inbox.events.length) },
    },
    agentIndex,
    answerKey: key,
    answerPage: fresh ? 0 : Math.min(model.answerPage, pages),
  };
}

/** Result of a session list request; stale answers for another agent are ignored. */
export function withSessions(model: HubModel, agentId: string, state: Omit<SessionsState, "agentId">): HubModel {
  if (selectedAgent(model)?.id !== agentId) return model;
  const next: SessionsState = { agentId, ...state };
  return { ...model, sessions: next, sessionIndex: Math.min(model.sessionIndex, sessionRowCount(next) - 1) };
}

/** Rows of the session page: [new, continue, ...listed]. */
export function sessionRowCount(state: SessionsState | null): number {
  return 2 + (state?.items.length ?? 0);
}

export function selectedAgent(model: HubModel): AgentInfo | undefined {
  return model.report.agents[model.agentIndex];
}

/** The permission card that currently owns the agent page, if any. */
export function pendingApproval(report: HubReport): Approval | undefined {
  return report.approvals[0];
}

function patchAgent(report: HubReport, id: string, patch: Partial<AgentInfo>): HubReport {
  return { ...report, agents: report.agents.map((agent) => (agent.id === id ? { ...agent, ...patch } : agent)) };
}

function withReport(model: HubModel, report: HubReport): HubModel {
  return { ...model, report };
}

function cycle(length: number, current: number, step: number): number {
  if (length <= 0) return 0;
  return ((current + step) % length + length) % length;
}

/** Short feedback line in the footer. */
function say(model: HubModel, text: string, now: number): HubModel {
  return { ...model, message: { text, until: now + MESSAGE_MS } };
}

/** Printer actions in menu order, derived so paused and printing agree. */
export function printerActions(snapshot: PrinterSnapshot, locale: Locale = "de"): ReadonlyArray<{ action: "pause" | "resume" | "cancel"; label: string }> {
  const run = snapshot.state === "paused"
    ? [{ action: "resume" as const, label: tr(messages, locale, "action.resume") }]
    : snapshot.state === "printing"
      ? [{ action: "pause" as const, label: tr(messages, locale, "action.pause") }]
      : [];
  return [...run, { action: "cancel" as const, label: tr(messages, locale, "action.cancel") }];
}

// ---- long answers ----------------------------------------------------------

/** Wrapped answer rows when the answer is long enough to be paged, else null. */
function pagedRows(agent: AgentInfo): string[] | null {
  const text = agent.answer ?? "";
  if (agent.busy || text === "") return null;
  const rows = wrap(text);
  return rows.length > INLINE_ROWS ? rows : null;
}

/** Pages of a long answer (0 when the answer is short or still streaming). */
export function pageCount(agent: AgentInfo): number {
  const rows = pagedRows(agent);
  return rows === null ? 0 : Math.ceil(rows.length / PAGE_ROWS);
}

/** Splits an answer into pages of PAGE_ROWS wrapped rows. */
export function paginate(text: string): string[][] {
  const rows = wrap(text);
  const pages: string[][] = [];
  for (let i = 0; i < rows.length; i += PAGE_ROWS) pages.push(rows.slice(i, i + PAGE_ROWS));
  return pages;
}

// ---- opening pages ----------------------------------------------------------

function openScreen(model: HubModel, target: Screen, now: number, locale: Locale, announce: boolean): { model: HubModel; effect?: Effect } {
  const report = model.report;
  const base: HubModel = {
    ...model, screen: target, confirm: null, picker: null, help: false, questionIndex: 0, sessionIndex: 1,
    agentView: report.agents.length > 1 ? "list" : "sessions", answerPage: 0,
    message: announce ? { text: tr(messages, locale, "ack.opened", { page: tr(messages, locale, `screen.${target}`) }), until: now + MESSAGE_MS } : null,
  };
  if (target === "root") return { model: { ...base, agentView: model.agentView } };
  const only = report.agents[0];
  // One agent: skip straight to its session page.
  if (target === "agent" && report.agents.length === 1 && only !== undefined) return openSessions({ ...base, agentIndex: 0 }, only);
  return { model: base };
}

/** Opens the session page of an agent and asks the daemon for its sessions. */
function openSessions(model: HubModel, agent: AgentInfo): { model: HubModel; effect?: Effect } {
  const keep = model.sessions?.agentId === agent.id ? model.sessions : null;
  const sessions: SessionsState = keep ?? { agentId: agent.id, status: "loading", items: [], transport: agent.transport ?? "" };
  return {
    model: { ...model, agentView: "sessions", sessions, sessionIndex: 1, confirm: null },
    effect: { kind: "loadSessions", agentId: agent.id },
  };
}

/** Tap on the session page: new, continue the current one, or open a listed one. */
function chooseSession(model: HubModel, agent: AgentInfo, now: number, locale: Locale): { model: HubModel; effect?: Effect } {
  if (!agent.online) return { model: say(model, tr(messages, locale, "agent.offline"), now) };
  const askView: HubModel = { ...model, agentView: "ask", questionIndex: 0, answerPage: 0, message: null };
  const busy = { model: say(model, tr(messages, locale, "agent.busy"), now) };
  if (model.sessionIndex === 0) {
    if (agent.busy) return busy;
    return {
      model: say(withReport(askView, patchAgent(model.report, agent.id, { answer: null, lastQuestion: null, suggestions: [], stopped: false, error: null, session: { id: null, title: "" } })), tr(messages, locale, "ack.newSession"), now),
      effect: { kind: "newSession", agentId: agent.id },
    };
  }
  if (model.sessionIndex === 1) return { model: askView };
  const listed = model.sessions?.items[model.sessionIndex - 2];
  if (listed === undefined) return { model };
  if (agent.session?.id === listed.id) return { model: askView };
  if (agent.busy) return busy;
  return {
    model: say(withReport(askView, patchAgent(model.report, agent.id, { stopped: false, error: null, session: { id: listed.id, title: listed.title } })), tr(messages, locale, "ack.session"), now),
    effect: { kind: "selectSession", agentId: agent.id, sessionId: listed.id, title: listed.title },
  };
}

// ---- gestures --------------------------------------------------------------

/**
 * Applies one gesture. `now` is passed in, never read from the clock, so the
 * confirm and message timeouts are testable without waiting.
 */
export function decide(model: HubModel, gesture: HubGesture, now: number, locale: Locale = "de"): { model: HubModel; effect?: Effect } {
  const report = model.report;
  const t = (key: string, vars: Record<string, string | number> = {}): string => tr(messages, locale, key, vars);

  if (gesture === "longPressRelease") {
    if (model.screen === "agent" && model.recording) {
      const agentId = model.recordAgent ?? selectedAgent(model)?.id;
      const next = { ...model, recording: false, recordAgent: null };
      if (agentId === undefined) return { model: next };
      return { model: { ...next, voice: { state: "transcribing", agentId } }, effect: { kind: "recordStop", agentId } };
    }
    return { model };
  }

  // No usable link: the page only offers "try again" (tap) and the way out.
  if (linkBlocks(model.link) && !model.help) {
    if (gesture === "click") return { model: say(model, t("link.retrying"), now), effect: { kind: "refresh" } };
    if (gesture === "doubleClick" || gesture === "ringDoubleClick") {
      return model.screen === "root" ? { model, effect: { kind: "exit" } } : { model: { ...model, screen: "root", picker: null } };
    }
    if (gesture === "scrollDown" || gesture === "scrollUp") {
      const at = SCREENS.indexOf(model.screen);
      const next = SCREENS[(at + (gesture === "scrollDown" ? 1 : SCREENS.length - 1)) % SCREENS.length] ?? "root";
      return { model: { ...model, screen: next, picker: null } };
    }
    return { model };
  }

  // While recording nothing else may happen — a stray swipe during dictation
  // must not switch pages or fire a question. The way out is always open:
  // tap ends the recording, double tap discards it.
  if (model.recording) {
    if (gesture === "click") {
      const agentId = model.recordAgent ?? selectedAgent(model)?.id;
      const next = { ...model, recording: false, recordAgent: null };
      return agentId === undefined ? { model: next } : { model: { ...next, voice: { state: "transcribing", agentId } }, effect: { kind: "recordStop", agentId } };
    }
    if (gesture === "doubleClick" || gesture === "ringDoubleClick") {
      return {
        model: say({ ...model, recording: false, recordAgent: null }, t("voice.cancelled"), now),
        effect: { kind: "recordAbort" },
      };
    }
    return { model };
  }

  // A voice note being transcribed or waiting for confirmation owns the screen:
  // tap sends the transcript, double tap throws it away.
  if (model.voice !== null) {
    if (gesture === "doubleClick" || gesture === "ringDoubleClick") return { model: say({ ...model, voice: null }, t("voice.discarded"), now) };
    if (gesture === "click" && model.voice.state === "confirm") {
      const { agentId, text } = model.voice;
      const agent = report.agents.find((entry) => entry.id === agentId);
      if (agent === undefined || !agent.online) return { model: say({ ...model, voice: null }, t("agent.offline"), now) };
      if (agent.busy) return { model: say(model, t("agent.busy"), now) };
      return {
        model: say(withReport({ ...model, voice: null }, patchAgent(report, agentId, { busy: true, answer: null, activity: "", error: null, lastQuestion: text })), t("ack.sent", { text: fit(text, 30) }), now),
        effect: { kind: "ask", agentId, question: text },
      };
    }
    if ((gesture === "scrollUp" || gesture === "scrollDown") && model.voice.state === "confirm") {
      const max = Math.max(0, wrap(model.voice.text).length - VOICE_ROWS);
      const scroll = Math.min(max, Math.max(0, (model.voice.scroll ?? 0) + (gesture === "scrollUp" ? -1 : 1)));
      return { model: { ...model, voice: { ...model.voice, scroll } } };
    }
    return { model };
  }

  if (model.help) return { model: { ...model, help: false } };

  // Page picker (R1 ring double tap).
  if (gesture === "ringDoubleClick" && model.picker === null) {
    return { model: { ...model, picker: Math.max(0, SCREENS.indexOf(model.screen)) + report.approvals.length, confirm: null } };
  }
  if (model.picker !== null) {
    const entries = pickerEntries(model, locale);
    if (gesture === "scrollUp" || gesture === "scrollDown") return { model: { ...model, picker: cycle(entries.length, model.picker, gesture === "scrollUp" ? -1 : 1) } };
    if (gesture === "click") {
      const chosen = entries[model.picker];
      return openScreen(model, chosen?.screen ?? model.screen, now, locale, true);
    }
    if (gesture === "doubleClick" || gesture === "ringDoubleClick") return { model: { ...model, picker: null } };
    return { model };
  }
  if (gesture === "ringDoubleClick") return { model };

  // A permission card owns the agent page: tap allows, double tap denies.
  const card = model.screen === "agent" ? pendingApproval(report) : undefined;
  if (card !== undefined) {
    if (gesture === "click") return { model: say(model, t("ack.allowed"), now), effect: { kind: "approve", cardId: card.id, decision: "allow" } };
    if (gesture === "doubleClick") return { model: say(model, t("ack.denied"), now), effect: { kind: "approve", cardId: card.id, decision: "deny" } };
    return { model };
  }

  if (gesture === "longPress") {
    if (model.screen === "agent") {
      const agent = selectedAgent(model);
      if (agent === undefined || !agent.online || agent.busy) {
        const key = agent !== undefined && agent.online ? "agent.busy" : "agent.offline";
        return { model: say(model, t(key), now) };
      }
      return {
        model: { ...model, confirm: null, message: null, recording: true, recordAgent: agent.id },
        effect: { kind: "recordStart" },
      };
    }
    // Refresh is harmless: no confirm, just a line of feedback.
    return { model: say({ ...model, confirm: null }, t("feedback.refreshed"), now), effect: { kind: "refresh" } };
  }

  if (gesture === "scrollUp" || gesture === "scrollDown") {
    const step = gesture === "scrollUp" ? -1 : 1;
    if (model.screen === "root") {
      return { model: { ...model, rootSelected: cycle(ROOT_ITEMS.length, model.rootSelected, step), confirm: null } };
    }
    if (model.screen === "agent") {
      if (model.agentView === "list") {
        return { model: { ...model, confirm: null, agentIndex: cycle(report.agents.length, model.agentIndex, step) } };
      }
      if (model.agentView === "sessions") {
        return { model: { ...model, confirm: null, sessionIndex: cycle(sessionRowCount(model.sessions), model.sessionIndex, step) } };
      }
      const agent = selectedAgent(model);
      const pages = agent === undefined ? 0 : pageCount(agent);
      if (agent !== undefined && pages > 0) {
        const page = Math.min(model.answerPage, pages);
        if (page < pages) return { model: { ...model, confirm: null, answerPage: Math.max(0, page + step) } };
        // Question page: swipe selects; swiping up past the first question goes back into the answer.
        const count = agentItems(agent, report.agent.questions).length;
        if (step < 0 && model.questionIndex === 0) return { model: { ...model, confirm: null, answerPage: pages - 1 } };
        return { model: { ...model, confirm: null, questionIndex: Math.min(Math.max(0, count - 1), Math.max(0, model.questionIndex + step)) } };
      }
      const items = agent === undefined ? [] : agentItems(agent, report.agent.questions);
      return { model: { ...model, confirm: null, questionIndex: cycle(items.length, model.questionIndex, step) } };
    }
    if (model.screen === "home") {
      const devices = report.home.devices;
      return { model: withReport({ ...model, confirm: null }, { ...report, home: { ...report.home, selected: cycle(devices.length, report.home.selected, step) } }) };
    }
    if (model.screen === "inbox") {
      const events = report.inbox.events;
      return { model: withReport({ ...model, confirm: null }, { ...report, inbox: { ...report.inbox, selected: cycle(events.length, report.inbox.selected, step) } }) };
    }
    const actions = printerActions(report.printer);
    return { model: withReport({ ...model, confirm: null }, { ...report, printer: { ...report.printer, selected: cycle(actions.length, report.printer.selected, step) } }) };
  }

  if (gesture === "click") {
    if (model.screen === "root") {
      const target = ROOT_ITEMS[model.rootSelected] ?? "agent";
      return openScreen(model, target, now, locale, false);
    }
    if (model.screen === "agent") {
      const agent = selectedAgent(model);
      if (agent === undefined) return { model: say(model, t("agent.none"), now) };
      if (model.agentView === "list") {
        if (!agent.online) return { model: say(model, t("agent.offline"), now) };
        return openSessions({ ...model, message: null }, agent);
      }
      if (model.agentView === "sessions") return chooseSession(model, agent, now, locale);
      // On an answer page a tap goes on to the questions instead of asking blindly.
      const pages = pageCount(agent);
      if (pages > 0 && model.answerPage < pages) return { model: say({ ...model, answerPage: pages }, t("ack.page", { n: pages + 1, total: pages + 1 }), now) };
      if (agent.busy) return { model: say(model, t("agent.busy"), now) };
      if (!agent.online) return { model: say(model, t("agent.offline"), now) };
      const question = agentItems(agent, report.agent.questions)[model.questionIndex];
      if (question === undefined) return { model: say(model, t("ack.nothing"), now) };
      return {
        model: say(withReport({ ...model, answerPage: 0 }, patchAgent(report, agent.id, { busy: true, answer: null, activity: "", error: null, lastQuestion: question })), t("ack.sent", { text: fit(question, 30) }), now),
        effect: { kind: "ask", agentId: agent.id, question },
      };
    }

    if (model.screen === "inbox") {
      const event = report.inbox.events[report.inbox.selected];
      if (event === undefined || event.read) return { model: say(model, t("ack.nothing"), now) };
      return {
        model: say(model, t("inbox.read"), now),
        effect: { kind: "readEvent", id: event.id },
      };
    }

    if (model.screen === "home") {
      const device = report.home.devices[report.home.selected];
      if (device === undefined || !device.writable) return { model: say(model, t("ack.noDevice"), now) };
      const label = device.label;
      const armed = model.confirm;
      if (armed !== null && armed.until > now && armed.what === device.id) {
        return {
          model: { ...model, confirm: null, message: null },
          effect: { kind: "toggle", device: device.id },
        };
      }
      return {
        model: {
          ...model,
          confirm: { what: device.id, label: `${label} (${device.on ? t("state.off") : t("state.on")})`, until: now + CONFIRM_MS },
        },
      };
    }

    const actions = printerActions(report.printer, locale);
    const chosen = actions[report.printer.selected] ?? actions[0];
    if (chosen === undefined) return { model };
    const label = chosen.label;
    const armed = model.confirm;
    if (armed !== null && armed.until > now && armed.what === `printer:${chosen.action}`) {
      return {
        model: { ...model, confirm: null, message: null },
        effect: { kind: "printer", action: chosen.action },
      };
    }
    return {
      model: {
        ...model,
        confirm: { what: `printer:${chosen.action}`, label, until: now + CONFIRM_MS },
      },
    };
  }

  // Even requires double tap on root to open its native exit dialog. On an
  // internal page it is a predictable Back gesture and never executes work.
  if (model.screen === "root") return { model, effect: { kind: "exit" } };
  if (model.screen === "agent") {
    const agent = selectedAgent(model);
    // A running agent: double tap is a real stop. Idle: climb one level.
    if (agent !== undefined && agent.busy && model.agentView === "ask") return stopAgent(model, agent, now, locale);
    if (model.agentView === "ask" && agent !== undefined) return openSessions({ ...model, message: null }, agent);
    if (model.agentView === "sessions" && report.agents.length > 1) return { model: { ...model, agentView: "list", message: null } };
  }
  return { model: { ...model, screen: "root", confirm: null, message: null } };
}

function stopAgent(model: HubModel, agent: AgentInfo, now: number, locale: Locale): { model: HubModel; effect: Effect } {
  return {
    model: say(withReport(model, patchAgent(model.report, agent.id, { busy: false, activity: "", stopped: true })), tr(messages, locale, "ack.stopped"), now),
    effect: { kind: "cancel", agentId: agent.id },
  };
}

// ---- page picker ------------------------------------------------------------

interface PickerEntry { readonly screen: Screen; readonly label: string }

/** Pending permission cards first (they all lead to the agent page), then the pages. */
export function pickerEntries(model: HubModel, locale: Locale): PickerEntry[] {
  const cards = model.report.approvals.map((card): PickerEntry => ({ screen: "agent", label: tr(messages, locale, "picker.card", { title: card.title }) }));
  const pages = SCREENS.map((screen): PickerEntry => ({ screen, label: tr(messages, locale, `screen.${screen}`) }));
  return [...cards, ...pages];
}

// ---- native contextual menu -----------------------------------------------

export const MENU = {
  agent: 1, home: 2, printer: 3, inbox: 4, help: 5, refresh: 6, overview: 7,
  stop: 10, newSession: 11, switchAgent: 12, allow: 13, deny: 14,
  toggle: 20, pauseResume: 30, cancelPrint: 31, markAll: 40,
} as const;

export interface MenuItemSpec { readonly id: number; readonly label: string }
export interface MenuSpec {
  /** Changes exactly when the glasses need a different menu (=> one rebuild). */
  readonly key: string;
  readonly items: readonly MenuItemSpec[];
}

/** Actions of the current page. At most 6, verb labels, ids non-zero. */
export function menuFor(model: HubModel, locale: Locale): MenuSpec {
  const item = (id: number, key: string): MenuItemSpec => ({ id, label: tr(messages, locale, key) });
  const card = model.screen === "agent" && pendingApproval(model.report) !== undefined;
  let items: MenuItemSpec[];
  if (model.screen === "root") {
    items = [item(MENU.agent, "menu.agent"), item(MENU.home, "menu.home"), item(MENU.printer, "menu.printer"), item(MENU.inbox, "menu.inbox"), item(MENU.refresh, "menu.refresh"), item(MENU.help, "menu.help")];
  } else if (model.screen === "agent") {
    items = card
      ? [item(MENU.allow, "menu.allow"), item(MENU.deny, "menu.deny"), item(MENU.help, "menu.help")]
      : [item(MENU.stop, "menu.stop"), item(MENU.newSession, "menu.newSession"), item(MENU.switchAgent, "menu.switchAgent"), item(MENU.overview, "menu.overview"), item(MENU.help, "menu.help")];
  } else if (model.screen === "home") {
    items = [item(MENU.toggle, "menu.toggle"), item(MENU.refresh, "menu.refresh"), item(MENU.overview, "menu.overview"), item(MENU.help, "menu.help")];
  } else if (model.screen === "printer") {
    items = [item(MENU.pauseResume, "menu.pauseResume"), item(MENU.cancelPrint, "menu.cancelPrint"), item(MENU.refresh, "menu.refresh"), item(MENU.overview, "menu.overview"), item(MENU.help, "menu.help")];
  } else {
    items = [item(MENU.markAll, "menu.markAll"), item(MENU.overview, "menu.overview"), item(MENU.help, "menu.help")];
  }
  return { key: `${locale}:${model.screen}${card ? ":card" : ""}`, items };
}

/** A menu item was chosen on the glasses. Menu clicks arrive regardless of the capture container. */
export function applyMenu(model: HubModel, itemId: number, now: number, locale: Locale = "de"): { model: HubModel; effect?: Effect } {
  const t = (key: string): string => tr(messages, locale, key);
  if (model.recording || model.voice !== null) return { model: say(model, t("ack.busyVoice"), now) };
  const base: HubModel = { ...model, help: false, picker: null };
  const report = base.report;
  switch (itemId) {
    case MENU.help: return { model: { ...base, help: true } };
    case MENU.refresh: return { model: say(base, t("feedback.refreshed"), now), effect: { kind: "refresh" } };
    case MENU.overview: return openScreen(base, "root", now, locale, false);
    case MENU.agent: return openScreen(base, "agent", now, locale, true);
    case MENU.home: return openScreen(base, "home", now, locale, true);
    case MENU.printer: return openScreen(base, "printer", now, locale, true);
    case MENU.inbox: return openScreen(base, "inbox", now, locale, true);
    case MENU.allow: return decide(base, "click", now, locale);
    case MENU.deny: return decide(base, "doubleClick", now, locale);
    case MENU.stop: {
      const agent = selectedAgent(base);
      if (agent === undefined || !agent.busy) return { model: say(base, t("ack.noRun"), now) };
      return stopAgent(base, agent, now, locale);
    }
    case MENU.newSession: {
      const agent = selectedAgent(base);
      if (agent === undefined) return { model: say(base, t("agent.none"), now) };
      return chooseSession({ ...base, screen: "agent", sessionIndex: 0 }, agent, now, locale);
    }
    case MENU.switchAgent:
      if (report.agents.length < 2) return { model: say(base, t("ack.oneAgent"), now) };
      return { model: { ...base, screen: "agent", agentView: "list", message: null } };
    case MENU.toggle: return decide(base, "click", now, locale);
    case MENU.pauseResume:
    case MENU.cancelPrint: {
      if (report.printer.job === null) return { model: say(base, t("ack.noJob"), now) };
      const actions = printerActions(report.printer, locale);
      const index = itemId === MENU.cancelPrint ? actions.length - 1 : 0;
      return decide(withReport(base, { ...report, printer: { ...report.printer, selected: index } }), "click", now, locale);
    }
    case MENU.markAll: {
      const ids = report.inbox.events.filter((event) => !event.read).map((event) => event.id);
      if (ids.length === 0) return { model: say(base, t("ack.nothing"), now) };
      return { model: say(base, t("ack.allRead"), now), effect: { kind: "readAll", ids } };
    }
    default: return { model };
  }
}

/** A voice transcript arrived from the daemon: wait for the wearer's tap, or note it was sent. */
export function withVoiceHeard(model: HubModel, agentId: string, text: string, alreadyAsked: boolean, now: number, locale: Locale = "de"): HubModel {
  if (model.voice === null || model.voice.state !== "transcribing" || model.voice.agentId !== agentId) return model;
  if (alreadyAsked) return say({ ...model, voice: null }, tr(messages, locale, "voice.sent", { text: fit(text, 30) }), now);
  return { ...model, voice: { state: "confirm", agentId, text }, message: null };
}

/** The voice note failed or came out empty. */
export function withVoiceFailed(model: HubModel, text: string, now: number): HubModel {
  return say({ ...model, voice: null }, text, now);
}

// ---- views ---------------------------------------------------------------

/**
 * The agent's tappable list: its follow-up suggestions when the last answer
 * offered some, else the saved questions. One helper so cycling, asking and
 * rendering can never disagree about which list is live.
 */
export function agentItems(agent: AgentInfo, questions: readonly string[]): readonly string[] {
  if (agent.suggestions.length > 0) return agent.suggestions;
  // After an answer only real vLLM suggestions count; the canned starters are for an empty session.
  if ((agent.answer ?? "") !== "" || agent.busy) return [];
  return questions;
}

/** Rows around the selection, so a long list scrolls instead of overflowing. */
function windowed(rows: readonly string[], selected: number, size: number): string[] {
  if (rows.length <= size) return [...rows];
  const start = Math.max(0, Math.min(selected - Math.floor(size / 2), rows.length - size));
  return rows.slice(start, start + size);
}

function waitingAgents(report: HubReport): Set<string> {
  return new Set(report.approvals.map((card) => card.agentId));
}

/** ● idle, * busy, ! waiting for you, ○ offline. */
function agentDot(agent: AgentInfo, waiting: Set<string>): string {
  if (!agent.online) return "○";
  if (waiting.has(agent.id)) return "!";
  return agent.busy ? "*" : "●";
}

function agentListRows(model: HubModel, locale: Locale, now: number): string[] {
  const agents = model.report.agents;
  if (agents.length === 0) return [tr(messages, locale, "agent.none"), tr(messages, locale, "root.hintNoAgents")];
  const waiting = waitingAgents(model.report);
  const rows = agents.map((agent) => {
    const state = !agent.online ? tr(messages, locale, "agent.off")
      : waiting.has(agent.id) ? tr(messages, locale, "agent.state.wait")
        : agent.busy ? busyShort(agent, locale, now)
          : agent.stopped === true ? tr(messages, locale, "agent.stopped") : "";
    return fit(`${agentDot(agent, waiting)} ${agent.label}${state ? ` · ${state}` : ""}${agent.machine ? ` · ${agent.machine}` : ""}`);
  });
  return windowed(rows.map((row, i) => marked(row, i === model.agentIndex)), model.agentIndex, 7);
}

function sessionTitle(agent: AgentInfo, locale: Locale): string {
  const title = agent.session?.title ?? "";
  if (title !== "") return title;
  return agent.session === null || agent.session === undefined ? "" : tr(messages, locale, "session.new");
}

function sessionRows(model: HubModel, locale: Locale): string[] {
  const agent = selectedAgent(model);
  if (agent === undefined) return [tr(messages, locale, "agent.none")];
  const state = model.sessions?.agentId === agent.id ? model.sessions : null;
  const transport = state?.transport || agent.transport || "";
  const head = fit(`${agent.online ? "●" : "○"} ${agent.label}${transport ? ` · ${transport}` : ""}`);
  const current = agent.session?.title ?? "";
  const rows = [
    tr(messages, locale, "sessions.new"),
    current !== "" ? tr(messages, locale, "sessions.continue", { title: current }) : tr(messages, locale, "sessions.continueNone"),
    ...(state?.items ?? []).map((item) => `${item.current || agent.session?.id === item.id ? "●" : " "} ${item.title}${item.when ? ` · ${item.when}` : ""}`),
  ];
  const list = windowed(rows.map((row, i) => marked(row, i === model.sessionIndex)), model.sessionIndex, 5);
  const note = state === null || state.status === "loading" ? tr(messages, locale, "sessions.loading")
    : state.status === "error" ? tr(messages, locale, "sessions.error")
      : state.status === "unsupported" ? tr(messages, locale, "sessions.unsupported") : null;
  return [head, ...list, ...(note === null ? [] : [fit(note)])];
}

function agentAskRows(model: HubModel, locale: Locale, now: number): string[] {
  const agent = selectedAgent(model);
  if (agent === undefined) return [tr(messages, locale, "agent.none")];
  const items = agentItems(agent, model.report.agent.questions);
  const title = sessionTitle(agent, locale);
  const head = fit(`${agent.online ? "●" : "○"} ${agent.label} · ${title || agent.machine || agent.kind}`);

  // Long answer: pages of text, the last page is the question list.
  const long = pagedRows(agent);
  if (long !== null) {
    const pages = Math.ceil(long.length / PAGE_ROWS);
    const page = Math.min(model.answerPage, pages);
    if (page < pages) {
      const text = long.slice(page * PAGE_ROWS, (page + 1) * PAGE_ROWS);
      return [...text, fit(tr(messages, locale, "answer.page", { dot: agent.online ? "●" : "○", name: agent.label, n: page + 1, total: pages + 1 }))];
    }
    const questionRows = items.map((q, i) => marked(q, i === model.questionIndex));
    const rows = [head, ...windowed(questionRows, model.questionIndex, 5)];
    if (items.length === 0) rows.push(emptyRow(agent, locale));
    rows.push(fit(tr(messages, locale, "answer.page", { dot: agent.online ? "●" : "○", name: agent.label, n: pages + 1, total: pages + 1 })));
    return rows;
  }

  const hasAnswer = (agent.answer ?? "") !== "" || agent.busy || agent.error !== null || agent.stopped === true;
  const questionRows = items.map((q, i) => marked(q, i === model.questionIndex));
  const rows = [head, ...windowed(questionRows, model.questionIndex, hasAnswer ? 2 : 5)];
  if (items.length === 0) rows.push(emptyRow(agent, locale));
  if (hasAnswer) {
    if ((agent.lastQuestion ?? "") !== "") {
      const you = wrap(tr(messages, locale, "agent.you", { text: agent.lastQuestion ?? "" }));
      rows.push(...(you.length > 2 ? [you[0] ?? "", fit(`${you[1] ?? ""} ${you.slice(2).join(" ")}`)] : you));
    }
    const answer = (agent.answer ?? "") !== ""
      ? wrap(agent.answer ?? "")
      : agent.error !== null ? wrap(agent.error) : [];
    const tool = agent.busy ? [workingLine(agent, locale, now)] : [];
    // The newest words matter while streaming: show the tail.
    const room = 7 - rows.length - (agent.stopped === true ? 1 : 0) - tool.length;
    if (room > 0) rows.push(...answer.slice(-room));
    rows.push(...tool);
    if (agent.stopped === true) rows.push(tr(messages, locale, "agent.stopped"));
  }
  return rows;
}

function approvalRows(card: Approval, total: number, locale: Locale): string[] {
  const rows = [fit(`! ${tr(messages, locale, "approval.title")} · ${card.agentId}${total > 1 ? ` (${total})` : ""}`)];
  const tool = card.tool ?? (card.title.includes(":") ? card.title.slice(0, card.title.indexOf(":")) : "");
  const command = card.detail ?? (card.tool !== undefined || !card.title.includes(":") ? card.title : card.title.slice(card.title.indexOf(":") + 1).trim());
  if (tool !== "") rows.push(fit(tr(messages, locale, "approval.tool", { tool })));
  rows.push(...wrap(command).slice(0, tool !== "" ? 3 : 4));
  const options = card.suggestions ?? [];
  if (options.length > 0) rows.push(fit(options.join(" / ")));
  return rows;
}

function homeRows(home: HomeSnapshot, locale: Locale): string[] {
  if (home.demo === true) return [tr(messages, locale, "home.notConfigured")];
  if (home.devices.length === 0) return [tr(messages, locale, "home.empty")];
  const rows = home.devices.map((device, i) => {
    const mark = device.on ? "●" : "○";
    return marked(`${mark} ${device.label} — ${device.state}`, i === home.selected);
  });
  return windowed(rows, home.selected, 7);
}

function printerRows(printer: PrinterSnapshot, locale: Locale): string[] {
  const rows: string[] = [];
  if (printer.demo === true) return [tr(messages, locale, "printer.notConfigured")];
  if (printer.offline === true) {
    rows.push(tr(messages, locale, "printer.offline"));
  } else if (printer.job === null) {
    rows.push(tr(messages, locale, "printer.idle"));
  } else {
    const percent = printerPercent(printer);
    const filled = Math.round(percent / 100 * 12);
    rows.push(fit(printer.job));
    rows.push(`${"#".repeat(filled)}${"-".repeat(12 - filled)}  ${percent} %`);
    const parts = [printer.layers > 0 ? `${printer.layer} / ${printer.layers}` : "", printer.etaMin !== null ? `${printer.etaMin} min` : ""].filter(Boolean);
    if (parts.length > 0) rows.push(parts.join(" · "));
    rows.push(`${printer.nozzleC}° · ${printer.bedC}°`);
    printerActions(printer, locale).forEach((entry, i) => rows.push(marked(entry.label, i === printer.selected)));
  }
  return rows;
}

function printerPercent(printer: PrinterSnapshot): number {
  return printer.progress ?? (printer.layers > 0 ? Math.round((printer.layer / printer.layers) * 100) : 0);
}

function unreadCount(inbox: InboxSnapshot): number {
  return inbox.events.filter((event) => !event.read).length;
}

/** "3 Lichter an" when the devices are lights, else a plain count of what is on. */
export function homeSummary(home: HomeSnapshot, locale: Locale): string {
  const lights = home.devices.filter((device) => /^light[._]/.test(device.id) || /licht|light|lamp|lampe/i.test(device.label));
  if (lights.length > 0) {
    const on = lights.filter((device) => device.on).length;
    return on === 0 ? tr(messages, locale, "home.lights0") : on === 1 ? tr(messages, locale, "home.lights1") : tr(messages, locale, "home.lightsN", { n: on });
  }
  const on = home.devices.filter((device) => device.on).length;
  return on === 0 ? tr(messages, locale, "home.on0") : tr(messages, locale, "home.onN", { n: on });
}

function printerSummary(printer: PrinterSnapshot, locale: Locale): string {
  if (printer.offline === true) return tr(messages, locale, "printer.offline");
  if (printer.state === "printing" || printer.state === "paused") {
    return tr(messages, locale, `printer.state.${printer.state}`, { pct: printerPercent(printer) }) + (printer.etaMin !== null ? ` · ${printer.etaMin} min` : "");
  }
  return tr(messages, locale, `printer.state.${printer.state}`);
}

function rootRows(report: HubReport, selected: number, locale: Locale): string[] {
  const t = (key: string, vars: Record<string, string | number> = {}): string => tr(messages, locale, key, vars);
  const waiting = waitingAgents(report);
  const online = report.agents.filter((agent) => agent.online).length;
  const busy = report.agents.filter((agent) => agent.busy && !waiting.has(agent.id)).length;
  const extra = (busy > 0 ? t("root.busyN", { n: busy }) : "") + (report.approvals.length > 0 ? t("root.waitN", { n: report.approvals.length }) : "");
  const dots = report.agents.slice(0, 8).map((agent) => agentDot(agent, waiting)).join("");
  const agentRow = report.agents.length === 0 ? t("root.agentNone") : t("root.agent", { dots, online, total: report.agents.length, extra });
  const homeRow = report.home.demo === true ? t("root.homeNotConfigured")
    : report.home.devices.length === 0 ? t("root.homeNone")
      : t("root.homeLights", { lights: homeSummary(report.home, locale), count: report.home.devices.length });
  const printerRow = report.printer.demo === true ? t("root.printerNotConfigured") : t("root.printer", { state: printerSummary(report.printer, locale) });
  const menu = [agentRow, homeRow, printerRow, t("root.inbox", { count: unreadCount(report.inbox) })].map((row, index) => marked(row, index === selected));

  // Up to three lines about what needs attention right now.
  const notes: string[] = [];
  for (const card of report.approvals.slice(0, 2)) notes.push(fit("  " + t("root.waits", { agent: card.agentId, what: card.title })));
  for (const agent of report.agents.filter((entry) => entry.busy && !waiting.has(entry.id))) {
    notes.push(fit("  " + t("root.working", { agent: agent.label, what: agent.activity !== "" ? agent.activity : t("agent.busy") })));
  }
  const alert = report.inbox.events.find((event) => !event.read && (event.status === "error" || (event.status === "waiting" && report.approvals.length === 0)));
  if (alert !== undefined) notes.push(fit("  " + t("root.alert", { provider: alert.provider, title: alert.title })));
  if (notes.length === 0) notes.push("  " + (report.agents.length === 0 ? t("root.hintNoAgents") : t("root.hintQuiet")));
  return [...menu, ...notes.slice(0, 3).map((note) => fit(note))];
}

function eventMark(event: AgentEvent, locale: Locale): string {
  return tr(messages, locale, `inbox.${event.status}`);
}

function inboxRows(inbox: InboxSnapshot, locale: Locale): string[] {
  if (inbox.events.length === 0) return wrap(tr(messages, locale, "inbox.empty"));
  const event = inbox.events[inbox.selected] ?? inbox.events[0];
  if (event === undefined) return [tr(messages, locale, "inbox.empty")];
  const status = eventMark(event, locale);
  const unread = event.read ? " " : "●";
  const rows = [marked(`${unread} ${status} ${event.provider}`, true), ...wrap(event.title).slice(0, 2)];
  if (event.detail !== null && event.detail !== "") rows.push("", ...wrap(event.detail).slice(0, 2));
  rows.push(`${inbox.selected + 1}/${inbox.events.length}`);
  return rows;
}

/** Header = the fixed status line: page · connection · unread · busy agents · waiting. */
export function statusLine(model: HubModel, locale: Locale): string {
  const report = model.report;
  const t = (key: string, vars: Record<string, string | number> = {}): string => tr(messages, locale, key, vars);
  const parts = [
    t(`screen.${model.screen}`),
    model.link !== null ? t(`link.short.${model.link.problem}`) : t(`link.short.${report.connection}`),
    t("status.new", { n: unreadCount(report.inbox) }),
    t("status.busy", { n: report.agents.filter((agent) => agent.busy).length }),
  ];
  if (report.approvals.length > 0) parts.push(t("status.waiting", { n: report.approvals.length }));
  return fit(parts.join(" · "));
}

function linkRows(link: LinkStatus, locale: Locale): string[] {
  const t = (key: string, vars: Record<string, string | number> = {}): string => tr(messages, locale, key, vars);
  const rows = [t(`link.title.${link.problem}`)];
  if (link.problem === "missing") rows.push(t("link.missingHint"));
  else {
    if (link.host !== "") rows.push(fit(t("link.host", { host: link.host })));
    if (link.problem === "insecure") rows.push(t("link.insecureHint"));
    else rows.push(t("link.autoRetry", { n: link.fails }));
    if (link.problem === "unauthorized") rows.push(t("link.tokenHint"));
  }
  return rows;
}

function helpRows(locale: Locale): string[] {
  return ["help.title", "help.swipe", "help.tap", "help.double", "help.hold", "help.menu", "help.ring"].map((key) => tr(messages, locale, key));
}

export function buildView(model: HubModel, locale: Locale, now: number): ScreenView {
  const report = model.report;
  const header = statusLine(model, locale);

  let body: readonly string[];
  let footer: string;
  const voiceAgent = model.voice === null ? undefined : report.agents.find((agent) => agent.id === model.voice?.agentId);
  if (model.help) {
    body = helpRows(locale);
    footer = tr(messages, locale, "help.footer");
  } else if (model.picker !== null) {
    const entries = pickerEntries(model, locale);
    body = [tr(messages, locale, "picker.title"), ...windowed(entries.map((entry, i) => marked(entry.label, i === model.picker)), model.picker, 6)];
    footer = tr(messages, locale, "picker.help");
  } else if (model.recording) {
    body = ["", tr(messages, locale, "voice.recording"), tr(messages, locale, "voice.recordingHint")];
    footer = tr(messages, locale, "agent.record");
  } else if (model.voice !== null) {
    const name = fit(`${voiceAgent?.online === false ? "○" : "●"} ${voiceAgent?.label ?? model.voice.agentId}`);
    if (model.voice.state === "transcribing") {
      body = [name, "", tr(messages, locale, "voice.processing")];
      footer = tr(messages, locale, "voice.processing");
    } else {
      const lines = wrap(model.voice.text);
      const from = Math.min(model.voice.scroll ?? 0, Math.max(0, lines.length - VOICE_ROWS));
      const more = lines.length > VOICE_ROWS ? ` ${from + 1}-${Math.min(lines.length, from + VOICE_ROWS)}/${lines.length}` : "";
      body = [name, `${tr(messages, locale, "voice.understood")}${more}`, ...lines.slice(from, from + VOICE_ROWS)];
      footer = tr(messages, locale, "voice.confirmHelp");
    }
  } else if (linkBlocks(model.link) && model.link !== null) {
    body = linkRows(model.link, locale);
    footer = tr(messages, locale, model.link.problem === "missing" || model.link.problem === "insecure" ? "link.footerMissing" : "link.footerRetry");
  } else if (model.screen === "root") {
    body = rootRows(report, model.rootSelected, locale);
    footer = tr(messages, locale, "root.help");
  } else if (model.screen === "agent") {
    const card = pendingApproval(report);
    const agent = selectedAgent(model);
    if (card !== undefined) {
      body = approvalRows(card, report.approvals.length, locale);
      footer = tr(messages, locale, "approval.hint");
    } else if (model.agentView === "list") {
      body = agentListRows(model, locale, now);
      footer = tr(messages, locale, "agent.list");
    } else if (model.agentView === "sessions") {
      body = sessionRows(model, locale);
      footer = tr(messages, locale, "sessions.help");
    } else {
      body = agentAskRows(model, locale, now);
      const paged = agent !== undefined && pageCount(agent) > 0;
      footer = tr(messages, locale, agent?.busy === true ? "agent.running"
        : agent?.stopped === true ? "agent.stoppedHelp"
          : paged ? (model.answerPage < pageCount(agent) ? "answer.pageHelp" : "answer.questionsHelp") : "agent.ask");
    }
  } else if (model.screen === "home") {
    body = homeRows(report.home, locale);
    footer = tr(messages, locale, "home.select");
  } else if (model.screen === "printer") {
    body = printerRows(report.printer, locale);
    footer = tr(messages, locale, "printer.select");
  } else {
    body = inboxRows(report.inbox, locale);
    footer = tr(messages, locale, "inbox.help");
  }

  if (model.confirm !== null && model.confirm.until > now) {
    const left = Math.ceil((model.confirm.until - now) / 1000);
    footer = `${tr(messages, locale, "confirm.label", { label: model.confirm.label })} ${tr(messages, locale, "confirm.countdown", { left })}`;
  } else if (model.message !== null && model.message.until > now && model.voice === null && !model.recording) {
    footer = model.message.text;
  }
  // Recording wins over everything: the user must always see that the mic is on.
  if (model.recording) footer = tr(messages, locale, "agent.record");

  return { header, body: body.slice(0, 7), footer: fit(footer) };
}

/** What stands in for an empty question list: suggestions on their way, none, or no saved questions. */
function emptyRow(agent: AgentInfo, locale: Locale): string {
  if (agent.suggesting === true) return tr(messages, locale, "agent.suggesting");
  if ((agent.answer ?? "") !== "" && !agent.busy) return tr(messages, locale, "agent.noSuggestions");
  return agent.busy ? "" : tr(messages, locale, "agent.empty");
}

/** "» Führt Tests aus.. · 23 s · npm test" — what a working agent is doing, animated. */
export function workingLine(agent: AgentInfo, locale: Locale, now: number): string {
  const activity = describeActivity(agent.activity, locale);
  const since = typeof agent.busySince === "number" && agent.busySince > 0 ? ` · ${elapsedShort(now - agent.busySince)}` : "";
  return fit(`» ${activity.label}${workingDots(now)}${since}${activity.detail !== "" ? ` · ${activity.detail}` : ""}`);
}

/** "Sucht im Web · 23 s" — the busy state in the agent list. */
function busyShort(agent: AgentInfo, locale: Locale, now: number): string {
  const label = describeActivity(agent.activity, locale).label;
  return typeof agent.busySince === "number" && agent.busySince > 0 ? `${label} · ${elapsedShort(now - agent.busySince)}` : label;
}
