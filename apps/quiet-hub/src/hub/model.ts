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
 * speaks into the selected session. A pending permission card takes over the
 * agent page: tap = allow, double tap = deny. While recording, double tap
 * discards the recording, so no state can trap the wearer.
 */
import type { ScreenView } from "../glasses/screen";
import { fit, marked, wrap } from "../glasses/screen";
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

export type HubGesture = "click" | "doubleClick" | "scrollUp" | "scrollDown" | "longPress" | "longPressRelease";

export interface HubModel {
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
  | { readonly kind: "readEvent"; readonly id: string }
  | { readonly kind: "toggle"; readonly device: string }
  | { readonly kind: "printer"; readonly action: "pause" | "resume" | "cancel" };

export function createModel(report: HubReport): HubModel {
  return {
    report: normalizeReport(report), screen: "root", rootSelected: 0, confirm: null, message: null, recording: false,
    agentIndex: 0, agentView: "list", questionIndex: 0, recordAgent: null, sessions: null, sessionIndex: 1,
  };
}

/** A fresh report from the daemon keeps the wearer's selections. */
export function mergeReport(model: HubModel, next: HubReport): HubModel {
  const report = normalizeReport(next);
  const clamp = (value: number, length: number): number => Math.max(0, Math.min(value, Math.max(0, length - 1)));
  return {
    ...model,
    report: {
      ...report,
      home: { ...report.home, selected: clamp(model.report.home.selected, report.home.devices.length) },
      printer: { ...report.printer, selected: model.report.printer.selected },
      inbox: { ...report.inbox, selected: clamp(model.report.inbox.selected, report.inbox.events.length) },
    },
    agentIndex: clamp(model.agentIndex, report.agents.length),
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

/** Printer actions in menu order, derived so paused and printing agree. */
export function printerActions(snapshot: PrinterSnapshot, locale: Locale = "de"): ReadonlyArray<{ action: "pause" | "resume" | "cancel"; label: string }> {
  const run = snapshot.state === "paused"
    ? [{ action: "resume" as const, label: tr(messages, locale, "action.resume") }]
    : snapshot.state === "printing"
      ? [{ action: "pause" as const, label: tr(messages, locale, "action.pause") }]
      : [];
  return [...run, { action: "cancel" as const, label: tr(messages, locale, "action.cancel") }];
}

/**
 * Applies one gesture. `now` is passed in, never read from the clock, so the
 * confirm and message timeouts are testable without waiting.
 */
export function decide(model: HubModel, gesture: HubGesture, now: number, locale: Locale = "de"): { model: HubModel; effect?: Effect } {
  const report = model.report;

  if (gesture === "longPressRelease") {
    if (model.screen === "agent" && model.recording) {
      const agentId = model.recordAgent ?? selectedAgent(model)?.id;
      const next = { ...model, recording: false, recordAgent: null };
      if (agentId === undefined) return { model: next };
      return { model: next, effect: { kind: "recordStop", agentId } };
    }
    return { model };
  }

  // While recording nothing else may happen — a stray swipe during dictation
  // must not switch pages or fire a question. The way out is always open:
  // tap ends and sends the recording, double tap discards it.
  if (model.recording) {
    if (gesture === "click") {
      const agentId = model.recordAgent ?? selectedAgent(model)?.id;
      const next = { ...model, recording: false, recordAgent: null };
      return agentId === undefined ? { model: next } : { model: next, effect: { kind: "recordStop", agentId } };
    }
    if (gesture === "doubleClick") {
      return {
        model: { ...model, recording: false, recordAgent: null, message: { text: tr(messages, locale, "voice.cancelled"), until: now + MESSAGE_MS } },
        effect: { kind: "recordAbort" },
      };
    }
    return { model };
  }

  // A permission card owns the agent page: tap allows, double tap denies.
  const card = model.screen === "agent" ? pendingApproval(report) : undefined;
  if (card !== undefined) {
    if (gesture === "click") return { model: { ...model, message: null }, effect: { kind: "approve", cardId: card.id, decision: "allow" } };
    if (gesture === "doubleClick") return { model: { ...model, message: null }, effect: { kind: "approve", cardId: card.id, decision: "deny" } };
    return { model };
  }

  if (gesture === "longPress") {
    if (model.screen === "agent") {
      const agent = selectedAgent(model);
      if (agent === undefined || !agent.online || agent.busy) {
        const key = agent !== undefined && agent.online ? "agent.busy" : "agent.offline";
        return { model: { ...model, message: { text: tr(messages, locale, key), until: now + MESSAGE_MS } } };
      }
      return {
        model: { ...model, confirm: null, message: null, recording: true, recordAgent: agent.id },
        effect: { kind: "recordStart" },
      };
    }
    // Refresh is harmless: no confirm, just a line of feedback.
    return {
      model: { ...model, confirm: null, message: { text: tr(messages, locale, "feedback.refreshed"), until: now + MESSAGE_MS } },
    };
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
      const opened: HubModel = { ...model, screen: target, confirm: null, agentView: report.agents.length > 1 ? "list" : "sessions", questionIndex: 0, sessionIndex: 1 };
      // One agent: skip straight to its session page.
      const only = report.agents[0];
      if (target === "agent" && report.agents.length === 1 && only !== undefined) return openSessions({ ...opened, agentIndex: 0 }, only);
      return { model: opened };
    }
    if (model.screen === "agent") {
      const agent = selectedAgent(model);
      if (agent === undefined) return { model };
      if (model.agentView === "list") {
        if (!agent.online) return { model: { ...model, message: { text: tr(messages, locale, "agent.offline"), until: now + MESSAGE_MS } } };
        return openSessions({ ...model, message: null }, agent);
      }
      if (model.agentView === "sessions") return chooseSession(model, agent, now, locale);
      if (agent.busy) return { model: { ...model, message: { text: tr(messages, locale, "agent.busy"), until: now + MESSAGE_MS } } };
      if (!agent.online) return { model: { ...model, message: { text: tr(messages, locale, "agent.offline"), until: now + MESSAGE_MS } } };
      const question = agentItems(agent, report.agent.questions)[model.questionIndex];
      if (question === undefined) return { model };
      return {
        model: withReport({ ...model, message: null }, patchAgent(report, agent.id, { busy: true, answer: null, activity: "", error: null, lastQuestion: question })),
        effect: { kind: "ask", agentId: agent.id, question },
      };
    }

    if (model.screen === "inbox") {
    const event = report.inbox.events[report.inbox.selected];
    if (event === undefined || event.read) return { model };
    return {
      model: { ...model, message: { text: tr(messages, locale, "inbox.read"), until: now + MESSAGE_MS } },
      effect: { kind: "readEvent", id: event.id },
    };
  }

    if (model.screen === "home") {
    const device = report.home.devices[report.home.selected];
    if (device === undefined || !device.writable) return { model };
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
        confirm: { what: device.id, label: `${label} (${device.on ? tr(messages, locale, "state.off") : tr(messages, locale, "state.on")})`, until: now + CONFIRM_MS },
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
    if (agent !== undefined && agent.busy && model.agentView === "ask") {
      return {
        model: withReport({ ...model, message: null }, patchAgent(report, agent.id, { busy: false, activity: "", stopped: true })),
        effect: { kind: "cancel", agentId: agent.id },
      };
    }
    if (model.agentView === "ask" && agent !== undefined) return openSessions({ ...model, message: null }, agent);
    if (model.agentView === "sessions" && report.agents.length > 1) return { model: { ...model, agentView: "list", message: null } };
  }
  return { model: { ...model, screen: "root", confirm: null, message: null } };
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
  if (!agent.online) return { model: { ...model, message: { text: tr(messages, locale, "agent.offline"), until: now + MESSAGE_MS } } };
  const askView: HubModel = { ...model, agentView: "ask", questionIndex: 0, message: null };
  const busy = { model: { ...model, message: { text: tr(messages, locale, "agent.busy"), until: now + MESSAGE_MS } } };
  if (model.sessionIndex === 0) {
    if (agent.busy) return busy;
    return {
      model: withReport(askView, patchAgent(model.report, agent.id, { answer: null, lastQuestion: null, suggestions: [], stopped: false, error: null, session: { id: null, title: "" } })),
      effect: { kind: "newSession", agentId: agent.id },
    };
  }
  if (model.sessionIndex === 1) return { model: askView };
  const listed = model.sessions?.items[model.sessionIndex - 2];
  if (listed === undefined) return { model };
  if (agent.session?.id === listed.id) return { model: askView };
  if (agent.busy) return busy;
  return {
    model: withReport(askView, patchAgent(model.report, agent.id, { stopped: false, error: null, session: { id: listed.id, title: listed.title } })),
    effect: { kind: "selectSession", agentId: agent.id, sessionId: listed.id, title: listed.title },
  };
}

// ---- views ---------------------------------------------------------------

function linkText(report: HubReport, locale: Locale): string {
  const key = `link.${report.connection}`;
  return tr(messages, locale, key);
}

/**
 * The agent's tappable list: its follow-up suggestions when the last answer
 * offered some, else the saved questions. One helper so cycling, asking and
 * rendering can never disagree about which list is live.
 */
export function agentItems(agent: AgentInfo, questions: readonly string[]): readonly string[] {
  return agent.suggestions.length > 0 ? agent.suggestions : questions;
}

/** Rows around the selection, so a long list scrolls instead of overflowing. */
function windowed(rows: readonly string[], selected: number, size: number): string[] {
  if (rows.length <= size) return [...rows];
  const start = Math.max(0, Math.min(selected - Math.floor(size / 2), rows.length - size));
  return rows.slice(start, start + size);
}

function agentListRows(model: HubModel, locale: Locale): string[] {
  const agents = model.report.agents;
  if (agents.length === 0) return [tr(messages, locale, "agent.none")];
  const rows = agents.map((agent) => {
    const dot = agent.online ? "●" : "○";
    const state = !agent.online ? ` ${tr(messages, locale, "agent.off")}` : agent.busy ? " …" : agent.stopped === true ? ` ${tr(messages, locale, "agent.stopped")}` : "";
    return fit(`${dot} ${agent.label}${state}`);
  });
  const window = windowed(rows.map((row, i) => marked(row, i === model.agentIndex)), model.agentIndex, 7);
  return window;
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

function agentAskRows(model: HubModel, locale: Locale): string[] {
  const agent = selectedAgent(model);
  if (agent === undefined) return [tr(messages, locale, "agent.none")];
  const items = agentItems(agent, model.report.agent.questions);
  const title = sessionTitle(agent, locale);
  const head = fit(`${agent.online ? "●" : "○"} ${agent.label} · ${title || agent.machine || agent.kind}`);
  const hasAnswer = (agent.answer ?? "") !== "" || agent.busy || agent.error !== null || agent.stopped === true;
  const questionRows = items.map((q, i) => marked(q, i === model.questionIndex));
  const rows = [head, ...windowed(questionRows, model.questionIndex, hasAnswer ? 2 : 5)];
  if (items.length === 0) rows.push(tr(messages, locale, "agent.empty"));
  if (hasAnswer) {
    if ((agent.lastQuestion ?? "") !== "") rows.push(fit(tr(messages, locale, "agent.you", { text: agent.lastQuestion ?? "" })));
    const answer = (agent.answer ?? "") !== ""
      ? wrap(agent.answer ?? "")
      : agent.error !== null ? wrap(agent.error) : agent.busy ? [tr(messages, locale, "agent.busy")] : [];
    // The newest words matter while streaming: show the tail.
    const room = 7 - rows.length - (agent.stopped === true ? 1 : 0);
    if (room > 0) rows.push(...answer.slice(-room));
    if (agent.stopped === true) rows.push(tr(messages, locale, "agent.stopped"));
  }
  return rows;
}

function approvalRows(card: Approval, total: number, locale: Locale): string[] {
  const rows = [fit(`! ${tr(messages, locale, "approval.title")} · ${card.agentId}${total > 1 ? ` (${total})` : ""}`), ...wrap(card.title).slice(0, 4)];
  const options = card.suggestions ?? [];
  if (options.length > 0) rows.push(fit(options.join(" / ")));
  return rows;
}

function homeRows(home: HomeSnapshot): string[] {
  const rows = home.devices.map((device, i) => {
    const mark = device.on ? "●" : "○";
    return marked(`${mark} ${device.label} — ${device.state}`, i === home.selected);
  });
  return windowed(rows, home.selected, 7);
}

function printerRows(printer: PrinterSnapshot, locale: Locale): string[] {
  const rows: string[] = [];
  if (printer.offline === true) {
    rows.push(tr(messages, locale, "printer.offline"));
  } else if (printer.job === null) {
    rows.push(tr(messages, locale, "printer.idle"));
  } else {
    const percent = printer.progress ?? (printer.layers > 0 ? Math.round((printer.layer / printer.layers) * 100) : 0);
    const filled = Math.round(percent / 100 * 12);
    rows.push(fit(printer.job));
    rows.push(`${"#".repeat(filled)}${"-".repeat(12 - filled)}  ${percent} %`);
    const parts = [printer.layers > 0 ? `${printer.layer} / ${printer.layers}` : "", printer.etaMin !== null ? `${printer.etaMin} min` : ""].filter(Boolean);
    if (parts.length > 0) rows.push(parts.join(" · "));
    rows.push(`${printer.nozzleC}° · ${printer.bedC}°`);
    printerActions(printer, locale).forEach((entry, i) => rows.push(marked(entry.label, i === printer.selected)));
  }
  if (printer.demo === true) rows.push(tr(messages, locale, "demo.note"));
  return rows;
}

function unreadCount(inbox: InboxSnapshot): number {
  return inbox.events.filter((event) => !event.read).length;
}

function rootRows(report: HubReport, locale: Locale): string[] {
  const online = report.agents.filter((agent) => agent.online).length;
  const busy = report.agents.some((agent) => agent.busy);
  const agentState = report.approvals.length > 0
    ? tr(messages, locale, "root.approvals", { count: report.approvals.length })
    : busy ? tr(messages, locale, "agent.busy") : `${online}/${report.agents.length} ${tr(messages, locale, "root.online")}`;
  const printerState = report.printer.offline === true
    ? tr(messages, locale, "printer.offline")
    : report.printer.job === null ? tr(messages, locale, "printer.idle")
      : `${report.printer.state} ${report.printer.progress ?? Math.round((report.printer.layer / Math.max(1, report.printer.layers)) * 100)} %`;
  return [
    tr(messages, locale, "root.agent", { state: agentState }),
    tr(messages, locale, "root.home", { count: report.home.devices.length }),
    tr(messages, locale, "root.printer", { state: printerState }),
    tr(messages, locale, "root.inbox", { count: unreadCount(report.inbox) }),
  ];
}

function eventMark(event: AgentEvent, locale: Locale): string {
  return tr(messages, locale, `inbox.${event.status}`);
}

function inboxRows(inbox: InboxSnapshot, locale: Locale): string[] {
  if (inbox.events.length === 0) return [tr(messages, locale, "inbox.empty")];
  const event = inbox.events[inbox.selected] ?? inbox.events[0];
  if (event === undefined) return [tr(messages, locale, "inbox.empty")];
  const status = eventMark(event, locale);
  const unread = event.read ? " " : "●";
  const rows = [marked(`${unread} ${status} ${event.provider}`, true), ...wrap(event.title).slice(0, 2)];
  if (event.detail !== null && event.detail !== "") rows.push("", ...wrap(event.detail).slice(0, 2));
  rows.push(`${inbox.selected + 1}/${inbox.events.length}`);
  return rows;
}

export function buildView(model: HubModel, locale: Locale, now: number): ScreenView {
  const report = model.report;
  const title = tr(messages, locale, "app.title");
  const page = tr(messages, locale, `screen.${model.screen}`);
  const header = fit(`${title} · ${page} · ${linkText(report, locale)}`);

  let body: readonly string[];
  let footer: string;
  if (model.screen === "root") {
    body = rootRows(report, locale).map((row, index) => marked(row, index === model.rootSelected));
    footer = tr(messages, locale, "root.help");
  } else if (model.screen === "agent") {
    const card = pendingApproval(report);
    const agent = selectedAgent(model);
    if (card !== undefined) {
      body = approvalRows(card, report.approvals.length, locale);
      footer = tr(messages, locale, "approval.help");
    } else if (model.agentView === "list") {
      body = agentListRows(model, locale);
      footer = tr(messages, locale, "agent.list");
    } else if (model.agentView === "sessions") {
      body = sessionRows(model, locale);
      footer = tr(messages, locale, "sessions.help");
    } else {
      body = agentAskRows(model, locale);
      footer = tr(messages, locale, agent?.busy === true ? "agent.running" : agent?.stopped === true ? "agent.stoppedHelp" : "agent.ask");
    }
  } else if (model.screen === "home") {
    body = homeRows(report.home);
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
  } else if (model.message !== null && model.message.until > now) {
    footer = model.message.text;
  }
  // Recording wins over everything: the user must always see that the mic is on.
  if (model.recording) footer = tr(messages, locale, "agent.record");

  return { header, body: body.slice(0, 7), footer: fit(footer) };
}
