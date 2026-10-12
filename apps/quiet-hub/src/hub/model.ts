/**
 * Quiet Hub state machine and views.
 *
 * The root page is a conventional menu: swipe selects and tap opens. Inside a
 * page, swipe selects and tap acts; risky home/printer actions require a
 * second tap. Double tap goes back, except on root where Even requires the
 * native exit dialog. Hold-to-talk remains available on the agent page.
 */
import type { ScreenView } from "../glasses/screen";
import { fit, marked, wrap } from "../glasses/screen";
import { tr, type Locale } from "../i18n";
import { messages } from "../messages";
import type { AgentEvent, AgentSnapshot, HomeSnapshot, HubReport, InboxSnapshot, PrinterSnapshot } from "../api/types";

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
}

/** Side effects leave the model; main.ts runs them against the daemon. */
export type Effect =
  | { readonly kind: "ask"; readonly question: string }
  | { readonly kind: "recordStart" }
  | { readonly kind: "recordStop" }
  | { readonly kind: "exit" }
  | { readonly kind: "readEvent"; readonly id: string }
  | { readonly kind: "toggle"; readonly device: string }
  | { readonly kind: "printer"; readonly action: "pause" | "resume" | "cancel" };

export function createModel(report: HubReport): HubModel {
  return { report, screen: "root", rootSelected: 0, confirm: null, message: null, recording: false };
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
      return { model: { ...model, recording: false }, effect: { kind: "recordStop" } };
    }
    return { model };
  }

  // While recording, nothing else may happen — a stray tap during dictation
  // must not switch pages or fire a question.
  if (model.recording) return { model };

  if (gesture === "longPress") {
    if (model.screen === "agent") {
      return {
        model: { ...model, confirm: null, message: null, recording: true },
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
      const items = agentItems(report.agent);
      return { model: withReport({ ...model, confirm: null }, { ...report, agent: { ...report.agent, selected: cycle(items.length, report.agent.selected, step) } }) };
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
      return { model: { ...model, screen: ROOT_ITEMS[model.rootSelected] ?? "agent", confirm: null } };
    }
    if (model.screen === "agent") {
    const question = agentItems(report.agent)[report.agent.selected];
    if (question === undefined) return { model };
    return {
      model: withReport(model, {
        ...report,
        agent: { ...report.agent, busy: true, answer: null, questions: report.agent.questions, selected: report.agent.selected },
      }),
      effect: { kind: "ask", question },
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
  return { model: { ...model, screen: "root", confirm: null, message: null } };
}

// ---- views ---------------------------------------------------------------

function linkText(report: HubReport, locale: Locale): string {
  const key = `link.${report.connection}`;
  return tr(messages, locale, key);
}

/**
 * The agent's tappable list: follow-up suggestions when the last answer
 * offered some, else the saved questions. One helper so cycling, asking and
 * rendering can never disagree about which list is live.
 */
export function agentItems(agent: AgentSnapshot): readonly string[] {
  return agent.suggestions.length > 0 ? agent.suggestions : agent.questions;
}

function agentRows(agent: AgentSnapshot, locale: Locale): string[] {
  const items = agentItems(agent);
  if (items.length === 0) return [tr(messages, locale, "agent.empty")];
  const rows = items.map((q, i) => marked(q, i === agent.selected)).slice(0, 3);
  if (agent.answer !== null) {
    rows.push("");
    rows.push(...wrap(agent.answer).slice(0, 3));
  }
  return rows;
}

function homeRows(home: HomeSnapshot): string[] {
  return home.devices.map((device, i) => {
    const mark = device.on ? "●" : "○";
    return marked(`${mark} ${device.label} — ${device.state}`, i === home.selected);
  });
}

function printerRows(printer: PrinterSnapshot, locale: Locale): string[] {
  const rows: string[] = [];
  if (printer.job === null) {
    rows.push(tr(messages, locale, "printer.idle"));
  } else {
    const percent = printer.layers > 0 ? Math.round((printer.layer / printer.layers) * 100) : 0;
    const filled = Math.round(percent / 100 * 12);
    rows.push(fit(printer.job));
    rows.push(`${"#".repeat(filled)}${"-".repeat(12 - filled)}  ${percent} %`);
    rows.push(`${printer.layer} / ${printer.layers}`);
    if (printer.etaMin !== null) rows.push(`${printer.etaMin} min`);
    rows.push(`${printer.nozzleC}° · ${printer.bedC}°`);
    rows.push("");
    const actions = printerActions(printer);
    actions.forEach((entry, i) => rows.push(marked(entry.label, i === printer.selected)));
  }
  return rows;
}

function unreadCount(inbox: InboxSnapshot): number {
  return inbox.events.filter((event) => !event.read).length;
}

function rootRows(report: HubReport, locale: Locale): string[] {
  const agentState = report.agent.busy ? tr(messages, locale, "agent.busy") : report.agent.provider;
  const printerState = report.printer.job === null ? tr(messages, locale, "printer.idle") : `${report.printer.state} ${report.printer.layer}/${report.printer.layers}`;
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
    body = agentRows(report.agent, locale);
    footer = tr(messages, locale, report.agent.busy ? "agent.busy" : "agent.ask");
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
