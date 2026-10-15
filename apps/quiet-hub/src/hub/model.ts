/**
 * Quiet Hub state machine and views.
 *
 * Follows the Quietglass Interaction Standard (QIS v1, docs/BEDIENSTANDARD.md).
 * The root page is a conventional menu: swipe selects and tap opens. Inside a
 * page, swipe selects and tap acts. Double tap ONLY goes back one level (on
 * root it opens Even's native exit dialog); it never stops, answers or sends.
 * Everything that stops, answers or switches something risky is ARMED first:
 * a tap arms (footer: "Nochmal tippen = <Aktion>"), a second tap within
 * CONFIRM_MS carries it out, swipe / 2x / the timeout cancel. That covers
 * stopping a running agent (tap while it works, or the menu entry), allow /
 * deny / vLLM replies on a permission card, and the home / printer actions.
 * The agent page is three levels:
 *   agents (list) -> sessions of that agent -> the open session (ask).
 * Double tap climbs ask -> sessions -> agents -> overview. A session opened
 * from an alert remembers that: there double tap goes straight back to the
 * overview. Hold-to-talk speaks into the selected session; the transcript is
 * shown and needs a tap to be sent. QIS v1.2 #2: 2x on the recording or the
 * transcript goes back one level and KEEPS the voice note (it comes back when
 * that conversation is opened again); discarding is the armed menu entry
 * "Verwerfen" (menu arms, the next tap or a second menu click discards). Without the
 * side menu (SIDE_MENU = false) a hold on the voice note arms the discard and one tap confirms.
 * A pending permission card takes over the agent page: swipe picks allow /
 * deny / a vLLM reply, tap arms it, a second tap sends it, double tap goes back
 * to the overview without deciding. No state can trap the wearer.
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
import type { AgentEvent, AgentInfo, Approval, ApprovalOption, HomeSnapshot, HubReport, InboxSnapshot, PrinterSnapshot, SessionInfo } from "../api/types";
import { normalizeReport } from "../api/normalize";
import {
  applyHomeAction, areaEntries, canDetail, clampZuhause, detailChoices, entityLabel, moveDetail, homeViewOf, initialZuhause, listEntries, listRows,
  selectedEntity, sideRows, stateText, tapAction, viewSummary, type ZuhauseState, type ZuhauseView,
} from "./zuhause";
import type { Brief, HomeAction, HomeEntity } from "../api/types";
import { briefBlocks, briefFooter, briefHeader, briefPages, briefSummary, type BriefLoad } from "./brief";
import { armedFooter, footer, type FooterEnd, type FooterParts } from "../glasses/footer";

export type Screen = "root" | "agent" | "home" | "printer" | "inbox" | "brief";
export const SCREENS: readonly Screen[] = ["root", "agent", "home", "printer", "inbox", "brief"];
/**
 * The glasses' side menu (menuObject, QIS v1.2). Off: its clicks never reach the app and, while a page carries it,
 * a hold opens it instead of reaching the app (step log from the real glasses, 15.10.2026). Off means: the pages
 * carry no menu, hold does what it did before (speak, details, refresh; on a voice note: arm the discard) and the
 * overview has its help row again. The menu code below stays so it can be switched back on.
 */
export const SIDE_MENU = false;

/** A row of the overview menu: a page, or the help overlay (last row while there is no side menu). */
export type RootItem = Exclude<Screen, "root"> | "help";
/** Rows of the overview menu, in row order (new rows go last: older saved selections stay valid). */
export const ROOT_ITEMS: readonly RootItem[] = SIDE_MENU ? ["agent", "home", "printer", "inbox", "brief"] : ["agent", "home", "printer", "inbox", "brief", "help"];

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

/**
 * Voice note in flight: transcribing, or transcript waiting for the wearer's tap.
 * `parked`: 2x went back and kept it; it owns the screen again in that agent's conversation.
 */
export type PendingVoice =
  | { readonly state: "transcribing"; readonly agentId: string; readonly parked?: boolean }
  | { readonly state: "confirm"; readonly agentId: string; readonly text: string; readonly scroll?: number; readonly parked?: boolean };

/** Arm id of the explicit "discard voice note" action. */
const DISCARD_VOICE = "voice:discard";

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
  /** Live transcript of the running recording (live STT); empty/absent when there is none. */
  readonly liveText?: string;
  /** How many chat rows the open conversation is scrolled up from its newest line (0 = bottom). */
  readonly chatScroll?: number;
  /** Until when the face smiles because an answer just arrived (epoch ms). */
  readonly cheerUntil?: number;
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
  /** Where the open session was opened from ("inbox" = an alert): double tap returns to the overview. */
  readonly origin?: "inbox" | null;
  /** Selected row of a permission card: 0 = allow, 1 = deny, 2.. = vLLM replies. */
  readonly cardIndex?: number;
  /** Setting "quiet while the agent works" (phone page / glasses menu). */
  readonly quietWhileWorking?: boolean;
  /** Until when a gesture or an alert keeps the display awake although the agent works (epoch ms). */
  readonly wakeUntil?: number;
  /** Zuhause page: level (list / area / detail), selections and a pending sensitive confirm. */
  readonly zh?: ZuhauseState;
  /** Tagesstart: the newest briefing (from /brief or the report), its page and how loading went. */
  readonly brief?: Brief | null;
  readonly briefPage?: number;
  readonly briefLoad?: BriefLoad;
  /** First start without a server: demo data and the hint line "Demo · Verbindung am Handy einrichten" (QIS v1.2 #7). */
  readonly setupHint?: boolean;
}

/** The voice note owns the screen: not parked, or parked and its conversation is open again. */
export function voiceOwns(model: HubModel): boolean {
  const voice = model.voice;
  if (voice === null || model.help || model.picker !== null) return false;
  if (voice.parked !== true) return true;
  return model.screen === "agent" && model.agentView === "ask" && pendingApproval(model.report) === undefined && selectedAgent(model)?.id === voice.agentId;
}

/**
 * One level back from the agent page without an effect (2x on a recording or a voice note):
 * conversation -> its sessions (alert: overview), sessions -> agent list -> overview.
 */
function backFromAgent(model: HubModel): HubModel {
  const agent = selectedAgent(model);
  if (model.screen !== "agent") return { ...model, confirm: null };
  if (model.agentView === "ask") {
    // Without a loaded session list (opened from an alert or the menu) the overview is the honest level.
    if (model.origin === "inbox" || agent === undefined || model.sessions?.agentId !== agent.id) return backToOverview(model);
    return { ...model, agentView: "sessions", sessionIndex: 1, confirm: null, chatScroll: 0 };
  }
  if (model.agentView === "sessions" && model.report.agents.length > 1) return { ...model, agentView: "list", confirm: null };
  return backToOverview(model);
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
  | { readonly kind: "approve"; readonly cardId: string; readonly decision: "allow" | "deny"; readonly note?: string }
  | { readonly kind: "cancel"; readonly agentId: string }
  | { readonly kind: "exit" }
  | { readonly kind: "refresh" }
  | { readonly kind: "readAll"; readonly ids: readonly string[] }
  | { readonly kind: "readEvent"; readonly id: string }
  /** Mark an event read and open its agent in the session the event came from. */
  | { readonly kind: "openEvent"; readonly id: string; readonly agentId: string; readonly sessionId: string | null }
  | { readonly kind: "toggle"; readonly device: string }
  /** Zuhause (daemon 0.7.0+): one action on an entity or group; a sensitive one returns a confirm token. */
  | { readonly kind: "homeAction"; readonly target: string; readonly action: HomeAction; readonly value?: number }
  /** Second step of a lock / alarm / garage action. */
  | { readonly kind: "homeConfirm"; readonly token: string }
  | { readonly kind: "printer"; readonly action: "pause" | "resume" | "cancel" }
  /** The glasses menu switched "quiet while the agent works": main persists it in the settings. */
  | { readonly kind: "quietSetting"; readonly on: boolean }
  /** Tagesstart: fetch the briefing (refresh = the daemon asks every source again). */
  | { readonly kind: "brief"; readonly refresh: boolean };

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
      inbox: { ...report.inbox, selected: clampIndex(model.report.inbox.selected, unreadEvents(report.inbox).length) },
    },
    agentIndex,
    answerKey: key,
    answerPage: fresh ? 0 : Math.min(model.answerPage, pages),
    zh: clampZuhause(model.zh ?? initialZuhause(), homeViewOf(report)),
    ...briefFrom(model, report.brief),
  };
}

/** The report's copy of the briefing replaces the shown one only when it is newer. */
function briefFrom(model: HubModel, next: Brief | null | undefined): Partial<HubModel> {
  if (next === null || next === undefined || typeof next.at !== "number") return {};
  if (model.brief !== null && model.brief !== undefined && model.brief.at >= next.at) return {};
  return { brief: next, briefLoad: "ready" };
}

/** Answer of GET /brief (or why there is none); the page keeps its last data when a refresh fails. */
export function withBrief(model: HubModel, brief: Brief | null, load: BriefLoad, locale: Locale = "de", now = Date.now()): HubModel {
  if (brief !== null) {
    const pages = briefPages(briefBlocks(brief, "ready", locale, now)).length;
    return { ...model, brief, briefLoad: "ready", briefPage: Math.min(model.briefPage ?? 0, pages - 1) };
  }
  if (model.brief !== null && model.brief !== undefined && load === "error") {
    return model.screen === "brief" ? say({ ...model, briefLoad: "ready" }, tr(messages, locale, "brief.failed"), now) : model;
  }
  return { ...model, briefLoad: load };
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
    ...model, screen: target, confirm: null, picker: null, help: false, questionIndex: 0, sessionIndex: 1, origin: null, cardIndex: 0,
    agentView: report.agents.length > 1 ? "list" : "sessions", answerPage: 0,
    message: announce ? { text: tr(messages, locale, "ack.opened", { page: tr(messages, locale, `screen.${target}`) }), until: now + MESSAGE_MS } : null,
  };
  if (target === "root") return { model: { ...base, agentView: model.agentView } };
  // Zuhause opens on its list, the list selection kept.
  if (target === "home") return { model: { ...base, zh: { ...initialZuhause(), index: model.zh?.index ?? 0 } } };
  // Tagesstart opens on its first page and asks the daemon (it answers from its cache when fresh).
  if (target === "brief") {
    const has = model.brief !== null && model.brief !== undefined;
    return { model: { ...base, briefPage: 0, briefLoad: has ? "ready" : "loading" }, effect: { kind: "brief", refresh: false } };
  }
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
      model: say(withReport(askView, patchAgent(model.report, agent.id, { answer: null, lastQuestion: null, suggestions: [], stopped: false, error: null, chat: [], steps: [], session: { id: null, title: "" } })), tr(messages, locale, "ack.newSession"), now),
      effect: { kind: "newSession", agentId: agent.id },
    };
  }
  // The hub may not know what was said before (e.g. after a restart): load it.
  const reload = (id: string | null | undefined, title: string): { model: HubModel; effect?: Effect } =>
    id && (agent.chat ?? []).length === 0 && !agent.busy
      ? { model: askView, effect: { kind: "selectSession", agentId: agent.id, sessionId: id, title } }
      : { model: askView };
  if (model.sessionIndex === 1) return reload(agent.session?.id, agent.session?.title ?? "");
  const listed = model.sessions?.items[model.sessionIndex - 2];
  if (listed === undefined) return { model };
  if (agent.session?.id === listed.id) return reload(listed.id, listed.title);
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
      const next = { ...model, recording: false, recordAgent: null, liveText: "" };
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
  // tap ends the recording; double tap ends it too and goes back one level,
  // keeping what was said (QIS v1.2 #2: never discarded by 2x).
  if (model.recording) {
    const agentId = model.recordAgent ?? selectedAgent(model)?.id;
    const next = { ...model, recording: false, recordAgent: null, liveText: "" };
    if (gesture === "click") {
      return agentId === undefined ? { model: next } : { model: { ...next, voice: { state: "transcribing", agentId } }, effect: { kind: "recordStop", agentId } };
    }
    if (gesture === "doubleClick" || gesture === "ringDoubleClick") {
      if (agentId === undefined) return { model: next, effect: { kind: "recordAbort" } };
      return {
        model: say(backFromAgent({ ...next, voice: { state: "transcribing", agentId, parked: true } }), t("voice.kept"), now),
        effect: { kind: "recordStop", agentId },
      };
    }
    return { model };
  }

  if (model.help) return { model: { ...model, help: false } };

  // A voice note being transcribed or waiting for confirmation owns the screen:
  // tap sends the transcript; double tap goes back and keeps it; discarding is the
  // armed menu entry (then the next tap discards instead of sending).
  if (model.voice !== null && voiceOwns(model)) {
    const discardArmed = model.confirm !== null && model.confirm.until > now && model.confirm.what === DISCARD_VOICE;
    if (gesture === "doubleClick" || gesture === "ringDoubleClick") {
      // 2x first cancels an armed discard (QIS v1), otherwise it goes back with the note kept.
      if (discardArmed) return { model: { ...model, confirm: null } };
      return { model: say(backFromAgent({ ...model, confirm: null, voice: { ...model.voice, parked: true } }), t("voice.kept"), now) };
    }
    if (gesture === "click" && discardArmed) return { model: say({ ...model, confirm: null, voice: null }, t("voice.discarded"), now) };
    // Without the side menu: hold arms the discard (the footer says so), one tap confirms, anything else cancels.
    if (gesture === "longPress" && !SIDE_MENU) {
      if (discardArmed) return { model: { ...model, confirm: null } };
      return { model: { ...model, message: null, confirm: { what: DISCARD_VOICE, label: t("confirm.discard"), until: now + CONFIRM_MS } } };
    }
    if (gesture === "click" && model.voice.state === "confirm") {
      const { agentId, text } = model.voice;
      const agent = report.agents.find((entry) => entry.id === agentId);
      if (agent === undefined || !agent.online) return { model: say({ ...model, voice: null }, t("agent.offline"), now) };
      if (agent.busy) return { model: say(model, t("agent.busy"), now) };
      return {
        model: say(withReport({ ...model, voice: null }, patchAgent(report, agentId, asked(agent, text))), t("ack.sent", { text: fit(text, 30) }), now),
        effect: { kind: "ask", agentId, question: text },
      };
    }
    if ((gesture === "scrollUp" || gesture === "scrollDown") && model.voice.state === "confirm") {
      const max = Math.max(0, wrap(model.voice.text).length - VOICE_ROWS);
      const scroll = Math.min(max, Math.max(0, (model.voice.scroll ?? 0) + (gesture === "scrollUp" ? -1 : 1)));
      return { model: { ...model, confirm: null, voice: { ...model.voice, scroll } } };
    }
    if (gesture === "scrollUp" || gesture === "scrollDown") return { model: { ...model, confirm: null } };
    return { model };
  }

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

  // A permission card owns the agent page: swipe picks allow / deny / a reply,
  // tap sends it, double tap goes back to the overview and leaves it open.
  const card = model.screen === "agent" ? pendingApproval(report) : undefined;
  if (card !== undefined) {
    const choices = cardChoices(card, locale);
    const index = clampIndex(model.cardIndex ?? 0, choices.length);
    if (gesture === "scrollUp" || gesture === "scrollDown") {
      return { model: { ...model, confirm: null, cardIndex: cycle(choices.length, index, gesture === "scrollUp" ? -1 : 1) } };
    }
    if (gesture === "click") {
      const choice = choices[index] ?? choices[0];
      if (choice === undefined) return { model };
      // QIS v1: answering for the wearer is armed first; the second tap on the same row sends it.
      const what = `approve:${card.id}:${index}`;
      const armed = model.confirm;
      if (armed !== null && armed.until > now && armed.what === what) {
        return { model: say({ ...model, confirm: null, cardIndex: 0 }, t(choice.decision === "allow" ? "ack.allowed" : "ack.denied"), now), effect: approveEffect(card, choice) };
      }
      return { model: { ...model, message: null, confirm: { what, label: choice.label, until: now + CONFIRM_MS } } };
    }
    if (gesture === "doubleClick") return { model: say(backToOverview(model), t("approval.later"), now) };
    return { model };
  }

  if (model.screen === "home") {
    const handled = decideHome(model, gesture, now, locale);
    if (handled !== null) return handled;
  }
  if (model.screen === "brief") {
    const handled = decideBrief(model, gesture, now, locale);
    if (handled !== null) return handled;
  }

  if (gesture === "longPress") {
    if (model.screen === "agent") {
      const agent = selectedAgent(model);
      if (agent === undefined || !agent.online || agent.busy) {
        const key = agent !== undefined && agent.online ? "agent.busy" : "agent.offline";
        return { model: say({ ...model, confirm: null }, t(key), now) };
      }
      // A kept voice note is never overwritten by a new recording: send or discard it first.
      if (model.voice !== null) return { model: say({ ...model, confirm: null }, t("voice.waiting"), now) };
      return {
        model: { ...model, confirm: null, message: null, recording: true, recordAgent: agent.id, liveText: "" },
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
      if (agent === undefined) return { model };
      return { model: { ...scrollChat(model, agent, step, locale), confirm: null } };
    }
    if (model.screen === "home") {
      const devices = report.home.devices;
      return { model: withReport({ ...model, confirm: null }, { ...report, home: { ...report.home, selected: cycle(devices.length, report.home.selected, step) } }) };
    }
    if (model.screen === "inbox") {
      const events = unreadEvents(report.inbox);
      return { model: withReport({ ...model, confirm: null }, { ...report, inbox: { ...report.inbox, selected: cycle(events.length, report.inbox.selected, step) } }) };
    }
    const actions = printerActions(report.printer);
    return { model: withReport({ ...model, confirm: null }, { ...report, printer: { ...report.printer, selected: cycle(actions.length, report.printer.selected, step) } }) };
  }

  if (gesture === "click") {
    if (model.screen === "root") {
      const target = ROOT_ITEMS[model.rootSelected] ?? "agent";
      if (target === "help") return { model: { ...model, help: true, message: null } };
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
      // A running agent: tap arms the stop, the second tap carries it out (double tap never stops).
      if (agent.busy) return armStop(model, agent, now, locale);
      // Scrolled into the history: a tap jumps back to the newest line and the suggestions.
      if ((model.chatScroll ?? 0) > 0) return { model: { ...model, chatScroll: 0 } };
      if (!agent.online) return { model: say(model, t("agent.offline"), now) };
      const question = agentItems(agent, report.agent.questions)[model.questionIndex];
      if (question === undefined) return { model: say(model, t("ack.nothing"), now) };
      return {
        model: say(withReport({ ...model, answerPage: 0, chatScroll: 0 }, patchAgent(report, agent.id, asked(agent, question))), t("ack.sent", { text: fit(question, 30) }), now),
        effect: { kind: "ask", agentId: agent.id, question },
      };
    }

    if (model.screen === "inbox") {
      const event = unreadEvents(report.inbox)[report.inbox.selected];
      if (event === undefined) return { model: say(model, t("ack.nothing"), now) };
      const agentIndex = event.agentId ? report.agents.findIndex((agent) => agent.id === event.agentId) : -1;
      const target = report.agents[agentIndex];
      if (target !== undefined && event.agentId) {
        // Straight into the conversation the event is about, at the start of its answer.
        const sameSession = event.sessionId === null || event.sessionId === undefined || target.session?.id === event.sessionId;
        // The alert leaves the list at once; another session never shows the previous session's chat or suggestions.
        const readReport = { ...report, inbox: { ...report.inbox, events: report.inbox.events.map((entry) => (entry.id === event.id ? { ...entry, read: true } : entry)) } };
        const opened = sameSession ? readReport : patchAgent(readReport, target.id, {
          session: { id: event.sessionId ?? null, title: "" }, chat: [], steps: [], answer: null, lastQuestion: null, suggestions: [], suggesting: true, stopped: false, error: null,
        });
        return {
          model: { ...model, report: opened, screen: "agent", agentView: "ask", agentIndex, questionIndex: 0, answerPage: 0, chatScroll: 0, confirm: null, message: null, origin: "inbox" },
          effect: { kind: "openEvent", id: event.id, agentId: event.agentId, sessionId: sameSession ? null : (event.sessionId ?? null) },
        };
      }
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
    // Opened from an alert: one double tap is back at the overview.
    if (model.agentView === "ask" && model.origin === "inbox") return { model: backToOverview(model) };
    // Climb one level, running or not: double tap never stops the agent (QIS v1).
    if (model.agentView === "ask" && agent !== undefined) return openSessions({ ...model, message: null }, agent);
    if (model.agentView === "sessions" && report.agents.length > 1) return { model: { ...model, agentView: "list", message: null } };
  }
  return { model: { ...model, screen: "root", confirm: null, message: null } };
}

// ---- Zuhause --------------------------------------------------------------------

function zhOf(model: HubModel): ZuhauseState {
  return model.zh ?? initialZuhause();
}

/** Applies the optimistic result of an action to the report's view. */
function withHomeView(model: HubModel, view: ZuhauseView): HubModel {
  return view.legacy === true ? model : { ...model, report: { ...model.report, homeView: view } };
}

/** One action on an entity: optimistic state now, the daemon call as effect (old daemons: /home/toggle). */
function homeAct(model: HubModel, view: ZuhauseView, entity: HomeEntity, action: HomeAction, now: number, locale: Locale, value?: number): { model: HubModel; effect: Effect } {
  const t = (key: string, vars: Record<string, string | number> = {}): string => tr(messages, locale, key, vars);
  const label = entityLabel(entity, locale);
  if (view.legacy === true) {
    const flipped = { ...entity, on: !entity.on };
    return { model: say({ ...model, confirm: null }, t("zh.sent", { label, state: stateText(flipped, locale) }), now), effect: { kind: "toggle", device: entity.id } };
  }
  const next = applyHomeAction(view, entity.id, action, value);
  const after = next.entities[entity.id] ?? entity;
  const text = action === "brightness" && (value ?? 0) > 0 ? t("zh.dim", { label, n: value ?? 0 })
    : action === "stop" ? t("zh.stopped", { label })
      : action === "run" ? `${label} »`
        : t("zh.sent", { label, state: stateText(after, locale) });
  const effect: Effect = value === undefined ? { kind: "homeAction", target: entity.id, action } : { kind: "homeAction", target: entity.id, action, value };
  return { model: say(withHomeView({ ...model, confirm: null }, next), text, now), effect };
}

/** The daemon answered a sensitive action with a token: the next tap on the same row confirms it. */
export function withHomePending(model: HubModel, target: string, confirm: { token: string; label: string; expiresInMs: number }, now: number): HubModel {
  // QIS v1: the second tap has CONFIRM_MS, however long the daemon would keep the code.
  const until = now + Math.max(1000, Math.min(confirm.expiresInMs, CONFIRM_MS));
  return {
    ...model,
    message: null,
    confirm: { what: `home:${target}`, label: confirm.label, until },
    zh: { ...zhOf(model), pending: { token: confirm.token, target, until } },
  };
}

/** Taps, swipes, holds and double taps on the Zuhause page; null = the generic handling applies. */
function decideHome(model: HubModel, gesture: HubGesture, now: number, locale: Locale): { model: HubModel; effect?: Effect } | null {
  const t = (key: string, vars: Record<string, string | number> = {}): string => tr(messages, locale, key, vars);
  const view = homeViewOf(model.report);
  if (view === null || (view.legacy === true && view.favorites.length === 0)) return null;
  const zh = zhOf(model);
  const step = gesture === "scrollUp" ? -1 : 1;
  const clearPending = (m: HubModel): HubModel => ({ ...m, confirm: null, zh: { ...zhOf(m), pending: null } });

  // Detail (QIS v1.2 #5): swipe only moves to the next light / cover; tap opens the choice list,
  // where swipe moves, tap runs the chosen entry and 2x closes it without doing anything.
  if (zh.level === "detail") {
    const entity = zh.detailId === null ? undefined : view.entities[zh.detailId];
    const open = typeof zh.choice === "number";
    if (gesture === "doubleClick") {
      if (open) return { model: { ...model, message: null, zh: { ...zh, choice: null } } };
      return { model: { ...model, message: null, zh: { ...zh, level: zh.areaId !== null ? "area" : "list", detailId: null, choice: null } } };
    }
    if (entity === undefined) return { model: { ...model, zh: { ...zh, level: "list", detailId: null, choice: null } } };
    if (gesture === "scrollUp" || gesture === "scrollDown") {
      if (open) {
        const n = detailChoices(entity, locale).length;
        return { model: { ...model, confirm: null, zh: { ...zh, choice: ((zh.choice ?? 0) + step + n) % n } } };
      }
      return { model: { ...model, confirm: null, message: null, zh: moveDetail(zh, view, step) } };
    }
    if (gesture === "click") {
      if (!open) return { model: { ...model, message: null, zh: { ...zh, choice: 0 } } };
      const choices = detailChoices(entity, locale);
      // The list can shrink while open ("An" goes once the light reports a level): stay on its last row.
      const choice = choices[Math.min(zh.choice ?? 0, choices.length - 1)];
      const closed: HubModel = { ...model, zh: { ...zh, choice: null } };
      if (choice === undefined || !entity.available) return { model: say(closed, t("zh.unavailable"), now) };
      return homeAct(closed, view, entity, choice.action, now, locale, choice.value);
    }
    if (gesture === "longPress") return { model };
    return null;
  }

  if (gesture === "scrollUp" || gesture === "scrollDown") {
    const base = clearPending(model);
    if (zh.level === "area") {
      const n = areaEntries(view, zh.areaId).length;
      return { model: { ...base, zh: { ...zhOf(base), areaIndex: n === 0 ? 0 : ((zh.areaIndex + step) % n + n) % n } } };
    }
    const n = listEntries(view).length;
    return { model: { ...base, zh: { ...zhOf(base), index: n === 0 ? 0 : ((zh.index + step) % n + n) % n } } };
  }

  if (gesture === "doubleClick") {
    if (zh.level === "area") return { model: { ...clearPending(model), message: null, zh: { ...zh, pending: null, level: "list", areaId: null, areaIndex: 0 } } };
    return { model: { ...clearPending(model), screen: "root", message: null } };
  }

  if (gesture === "click") {
    if (zh.level === "list") {
      const entry = listEntries(view)[zh.index];
      if (entry === undefined) return { model: say(model, t("ack.nothing"), now) };
      if (entry.type === "area") return { model: { ...clearPending(model), message: null, zh: { ...zh, pending: null, level: "area", areaId: entry.id, areaIndex: 0 } } };
    }
    const entity = selectedEntity(zh, view);
    if (entity === undefined) return { model: say(model, t("ack.nothing"), now) };
    const action = tapAction(entity);
    if (action === null || !entity.available) return { model: say(model, t(entity.available ? "zh.noAction" : "zh.unavailable"), now) };
    if (entity.sensitive === true && view.legacy !== true) {
      const pending = zh.pending;
      if (pending !== null && pending.target === entity.id && pending.until > now) {
        return {
          model: say(clearPending(model), t("zh.confirmed", { label: model.confirm?.label ?? entityLabel(entity, locale) }), now),
          effect: { kind: "homeConfirm", token: pending.token },
        };
      }
      // First tap: the daemon only hands out a token; nothing moves yet.
      return { model: say(clearPending(model), t("zh.asking"), now), effect: { kind: "homeAction", target: entity.id, action } };
    }
    return homeAct(model, view, entity, action, now, locale);
  }

  if (gesture === "longPress") {
    const entity = selectedEntity(zh, view);
    if (entity !== undefined && canDetail(entity) && view.legacy !== true) {
      return { model: { ...clearPending(model), message: null, zh: { ...zh, pending: null, level: "detail", detailId: entity.id, choice: null } } };
    }
    return null;
  }
  return null;
}

// ---- Tagesstart -----------------------------------------------------------------

/** Pages of the briefing as the glasses show it right now. */
export function briefPageRows(model: HubModel, locale: Locale, now: number): string[][] {
  return briefPages(briefBlocks(model.brief, model.briefLoad ?? "loading", locale, now));
}

/** Swipe pages through the blocks, tap (or hold) reloads, double tap goes back (generic). */
function decideBrief(model: HubModel, gesture: HubGesture, now: number, locale: Locale): { model: HubModel; effect?: Effect } | null {
  if (gesture === "scrollUp" || gesture === "scrollDown") {
    const pages = briefPageRows(model, locale, now).length;
    const page = Math.max(0, Math.min(pages - 1, (model.briefPage ?? 0) + (gesture === "scrollUp" ? -1 : 1)));
    return { model: { ...model, confirm: null, briefPage: page } };
  }
  if (gesture === "click" || gesture === "longPress") {
    const has = model.brief !== null && model.brief !== undefined;
    return {
      model: say({ ...model, confirm: null, briefLoad: has ? "ready" : "loading" }, tr(messages, locale, "brief.refreshing"), now),
      effect: { kind: "brief", refresh: true },
    };
  }
  return null;
}

/** The overview, the cursor on a waiting card ("Agent") or on "Meldungen" while unread alerts are left. */
function backToOverview(model: HubModel): HubModel {
  const unread = unreadEvents(model.report.inbox).length > 0;
  return {
    ...model, screen: "root", origin: null, cardIndex: 0, confirm: null, message: null, chatScroll: 0, picker: null,
    // A waiting card first (one tap opens it again), else the next unread alert.
    rootSelected: model.report.approvals.length > 0 ? ROOT_ITEMS.indexOf("agent") : unread ? ROOT_ITEMS.indexOf("inbox") : model.rootSelected,
  };
}

export interface CardChoice { readonly label: string; readonly decision: "allow" | "deny"; readonly note?: string }

/** Rows of a permission card: allow, deny, then the vLLM's replies for this very card. */
export function cardChoices(card: Approval, locale: Locale): CardChoice[] {
  const options: readonly ApprovalOption[] = card.options ?? [];
  return [
    { label: tr(messages, locale, "approval.allow"), decision: "allow" },
    { label: tr(messages, locale, "approval.deny"), decision: "deny" },
    ...options.map((option): CardChoice => ({ label: option.text, decision: option.decision, note: option.text })),
  ];
}

function approveEffect(card: Approval, choice: CardChoice): Effect {
  return choice.note === undefined
    ? { kind: "approve", cardId: card.id, decision: choice.decision }
    : { kind: "approve", cardId: card.id, decision: choice.decision, note: choice.note };
}

/** First tap arms the stop (footer: "Nochmal tippen = stoppen"), a second one within CONFIRM_MS stops. */
function armStop(model: HubModel, agent: AgentInfo, now: number, locale: Locale): { model: HubModel; effect?: Effect } {
  const what = `stop:${agent.id}`;
  const armed = model.confirm;
  if (armed !== null && armed.until > now && armed.what === what) return stopAgent({ ...model, confirm: null }, agent, now, locale);
  return { model: { ...model, message: null, confirm: { what, label: tr(messages, locale, "confirm.stop"), until: now + CONFIRM_MS } } };
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
  agent: 1, home: 2, printer: 3, inbox: 4, help: 5, refresh: 6, overview: 7, brief: 8, briefRefresh: 50,
  stop: 10, newSession: 11, switchAgent: 12, allow: 13, deny: 14, quiet: 15,
  toggle: 20, detail: 21, pauseResume: 30, cancelPrint: 31, markAll: 40, discardVoice: 60,
} as const;

export interface MenuItemSpec { readonly id: number; readonly label: string }
export interface MenuSpec {
  /** Changes exactly when the glasses need a different menu (=> one rebuild). */
  readonly key: string;
  readonly items: readonly MenuItemSpec[];
}

/** Actions of the current page. At most 6, verb labels, ids non-zero. */
export function menuFor(model: HubModel, locale: Locale, enabled: boolean = SIDE_MENU): MenuSpec {
  if (!enabled) return { key: "none", items: [] };
  const item = (id: number, key: string): MenuItemSpec => ({ id, label: tr(messages, locale, key) });
  const card = model.screen === "agent" && pendingApproval(model.report) !== undefined;
  let items: MenuItemSpec[];
  // A voice note on screen: only the explicit (armed) discard and help.
  if (model.voice !== null && voiceOwns(model)) {
    return { key: `${locale}:voice`, items: [item(MENU.discardVoice, "menu.discardVoice"), item(MENU.help, "menu.help")] };
  }
  if (model.screen === "root") {
    items = [item(MENU.agent, "menu.agent"), item(MENU.home, "menu.home"), item(MENU.printer, "menu.printer"), item(MENU.inbox, "menu.inbox"), item(MENU.brief, "menu.brief"), item(MENU.help, "menu.help")];
  } else if (model.screen === "agent") {
    items = card
      ? [item(MENU.allow, "menu.allow"), item(MENU.deny, "menu.deny"), item(MENU.help, "menu.help")]
      : [item(MENU.stop, "menu.stop"), item(MENU.newSession, "menu.newSession"), item(MENU.switchAgent, "menu.switchAgent"), item(MENU.quiet, "menu.quiet"), item(MENU.overview, "menu.overview"), item(MENU.help, "menu.help")];
  } else if (model.screen === "home") {
    items = [item(MENU.toggle, "menu.toggle"), item(MENU.detail, "menu.detail"), item(MENU.refresh, "menu.refresh"), item(MENU.overview, "menu.overview"), item(MENU.help, "menu.help")];
  } else if (model.screen === "brief") {
    items = [item(MENU.briefRefresh, "menu.briefRefresh"), item(MENU.overview, "menu.overview"), item(MENU.help, "menu.help")];
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
  if (model.recording) return { model: say(model, t("ack.busyVoice"), now) };
  if (model.voice !== null && voiceOwns(model)) {
    if (itemId === MENU.help) return { model: { ...model, help: true, picker: null } };
    if (itemId !== MENU.discardVoice) return { model: say(model, t("ack.busyVoice"), now) };
    // QIS v1.2 #3: the first click arms ("Nochmal tippen = verwerfen"); the next tap or a second click within CONFIRM_MS discards.
    const armed = model.confirm;
    if (armed !== null && armed.until > now && armed.what === DISCARD_VOICE) return { model: say({ ...model, confirm: null, voice: null }, t("voice.discarded"), now) };
    return { model: { ...model, message: null, confirm: { what: DISCARD_VOICE, label: t("confirm.discard"), until: now + CONFIRM_MS } } };
  }
  if (itemId === MENU.discardVoice) return { model: say(model, t("ack.nothing"), now) };
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
    case MENU.brief: return openScreen(base, "brief", now, locale, true);
    case MENU.briefRefresh: return decide({ ...base, screen: "brief" }, "click", now, locale);
    case MENU.allow:
    case MENU.deny: {
      const card = base.screen === "agent" ? pendingApproval(report) : undefined;
      if (card === undefined) return { model: say(base, t("ack.nothing"), now) };
      // The menu only picks the row and arms it; the answer leaves with the next tap (QIS v1).
      const index = itemId === MENU.allow ? 0 : 1;
      const choice = cardChoices(card, locale)[index];
      return { model: { ...base, cardIndex: index, message: null, confirm: { what: `approve:${card.id}:${index}`, label: choice?.label ?? "", until: now + CONFIRM_MS } } };
    }
    case MENU.stop: {
      const agent = selectedAgent(base);
      if (agent === undefined || !agent.busy) return { model: say(base, t("ack.noRun"), now) };
      // Arm only; the next tap on the open session stops (QIS v1).
      return armStop({ ...base, screen: "agent", agentView: "ask", chatScroll: 0 }, agent, now, locale);
    }
    case MENU.newSession: {
      const agent = selectedAgent(base);
      if (agent === undefined) return { model: say(base, t("agent.none"), now) };
      return chooseSession({ ...base, screen: "agent", sessionIndex: 0 }, agent, now, locale);
    }
    case MENU.quiet: {
      // Fixed label (no rebuild when it flips); the footer says the new state.
      const on = base.quietWhileWorking !== true;
      return { model: say({ ...base, quietWhileWorking: on }, t(on ? "ack.quietOn" : "ack.quietOff"), now), effect: { kind: "quietSetting", on } };
    }
    case MENU.switchAgent:
      if (report.agents.length < 2) return { model: say(base, t("ack.oneAgent"), now) };
      return { model: { ...base, screen: "agent", agentView: "list", message: null } };
    case MENU.toggle: return decide(base, "click", now, locale);
    case MENU.detail: {
      if (base.screen !== "home") return { model };
      const out = decide(base, "longPress", now, locale);
      // Nothing to dim or move here: say so instead of the refresh a hold would be.
      return out.effect?.kind === "refresh" ? { model: say(base, t("zh.noAction"), now) } : out;
    }
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
  const parked = model.voice.parked === true;
  // Parked: the wearer is elsewhere; the transcript waits in that conversation (no footer takeover).
  return { ...model, voice: parked ? { state: "confirm", agentId, text, parked: true } : { state: "confirm", agentId, text }, ...(parked ? {} : { message: null }) };
}

/** The live recogniser heard more while the wearer still holds: shown on the listening page. */
export function withLiveText(model: HubModel, text: string): HubModel {
  if (!model.recording || (model.liveText ?? "") === text) return model;
  return { ...model, liveText: text };
}

/** Rows of the listening page: the newest words of the live transcript (tail when it is longer than the page). */
export function liveRows(text: string, rows: number): string[] {
  const lines = wrap(text);
  return lines.slice(Math.max(0, lines.length - rows));
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
  // Fresh ones for this conversation are on their way: never fill the gap with other lists.
  if (agent.suggesting === true) return [];
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

function approvalRows(card: Approval, total: number, selected: number, locale: Locale): string[] {
  const head = fit(`! ${tr(messages, locale, "approval.title")} · ${card.agentId}${total > 1 ? ` (${total})` : ""}`);
  const tool = card.tool ?? (card.title.includes(":") ? card.title.slice(0, card.title.indexOf(":")) : "");
  const command = card.detail ?? (card.tool !== undefined || !card.title.includes(":") ? card.title : card.title.slice(card.title.indexOf(":") + 1).trim());
  // Tool, command (one or two rows), then the choices below (scrolling when there are more).
  const what = [...(tool !== "" ? [fit(tr(messages, locale, "approval.tool", { tool }))] : []), ...wrap(command).slice(0, 2)];
  const choices = cardChoices(card, locale);
  const index = clampIndex(selected, choices.length);
  const room = 7 - 1 - what.length;
  return [head, ...what, ...windowed(choices.map((choice, i) => marked(choice.label, i === index)), index, room)];
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

function rootRows(report: HubReport, selected: number, locale: Locale, now: number, brief: Brief | null | undefined = report.brief, setupHint = false): string[] {
  const t = (key: string, vars: Record<string, string | number> = {}): string => tr(messages, locale, key, vars);
  const waiting = waitingAgents(report);
  const online = report.agents.filter((agent) => agent.online).length;
  const busy = report.agents.filter((agent) => agent.busy && !waiting.has(agent.id)).length;
  const extra = (busy > 0 ? t("root.busyN", { n: busy }) : "") + (report.approvals.length > 0 ? t("root.waitN", { n: report.approvals.length }) : "");
  const dots = report.agents.slice(0, 8).map((agent) => agentDot(agent, waiting)).join("");
  const agentRow = report.agents.length === 0 ? t("root.agentNone") : t("root.agent", { dots, online, total: report.agents.length, extra });
  const homeView = report.homeView !== undefined && report.home.demo !== true ? report.homeView : null;
  const homeRow = report.home.demo === true ? t("root.homeNotConfigured")
    : homeView !== null && Object.keys(homeView.entities).length > 0 ? t("root.homeLights", viewSummary(homeView, locale))
      : report.home.devices.length === 0 ? t("root.homeNone")
        : t("root.homeLights", { lights: homeSummary(report.home, locale), count: report.home.devices.length });
  const printerRow = report.printer.demo === true ? t("root.printerNotConfigured") : t("root.printer", { state: printerSummary(report.printer, locale) });
  const briefRow = t("root.brief", { summary: briefSummary(brief, locale, now) });
  // The rows follow ROOT_ITEMS; help is the last row while there is no side menu.
  const menu = [agentRow, homeRow, printerRow, t("root.inbox", { count: unreadCount(report.inbox) }), briefRow, ...(SIDE_MENU ? [] : [t("root.help")])].map((row, index) => marked(row, index === selected));

  // What needs attention right now (two lines below the five rows; the agent row counts the busy ones).
  const notes: string[] = [];
  if (setupHint) notes.push("  " + t("root.demoHint"));
  for (const card of report.approvals.slice(0, 2)) notes.push(fit("  " + t("root.waits", { agent: card.agentId, what: card.title })));
  const alert = report.inbox.events.find((event) => !event.read && (event.status === "error" || (event.status === "waiting" && report.approvals.length === 0)));
  if (alert !== undefined) notes.push(fit("  " + t("root.alert", { provider: alert.provider, title: alert.title })));
  for (const agent of report.agents.filter((entry) => entry.busy && !waiting.has(entry.id))) {
    notes.push(fit("  " + t("root.working", { agent: agent.label, what: busyShort(agent, locale, now) })));
  }
  if (notes.length === 0) notes.push("  " + (report.agents.length === 0 ? t("root.hintNoAgents") : t("root.hintQuiet")));
  return [...menu, ...notes.slice(0, 7 - menu.length).map((note) => fit(note))];
}

function eventMark(event: AgentEvent, locale: Locale): string {
  return tr(messages, locale, `inbox.${event.status}`);
}

/** Read events leave the list; the root count already only counts unread ones. */
export function unreadEvents(inbox: InboxSnapshot): readonly AgentEvent[] {
  return inbox.events.filter((event) => !event.read);
}

function inboxRows(inbox: InboxSnapshot, locale: Locale): string[] {
  const events = unreadEvents(inbox);
  if (events.length === 0) return wrap(tr(messages, locale, "inbox.empty"));
  const event = events[inbox.selected] ?? events[0];
  if (event === undefined) return [tr(messages, locale, "inbox.empty")];
  const status = eventMark(event, locale);
  const rows = [marked(`● ${status} ${event.provider}`, true), fit(tr(messages, locale, "agent.you", { text: event.title }))];
  if (event.detail !== null && event.detail !== "") rows.push(...wrap(event.detail).slice(0, 3));
  rows.push(`${inbox.selected + 1}/${events.length}`);
  return rows;
}

/** Header = the fixed status line: page · connection · unread · busy agents · waiting. */
export function statusLine(model: HubModel, locale: Locale): string {
  const report = model.report;
  const t = (key: string, vars: Record<string, string | number> = {}): string => tr(messages, locale, key, vars);
  const zh = model.screen === "home" ? zhOf(model) : null;
  const area = zh !== null && zh.level !== "list" ? homeViewOf(report)?.areas.find((entry) => entry.id === zh.areaId)?.name : undefined;
  const parts = [
    "QUIET HUB",
    ...(model.screen === "root" ? [] : [area !== undefined ? `${t("screen.home")} · ${fit(area, 14)}` : t(`screen.${model.screen}`)]),
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

/** QIS v1 help: the four gestures in footer order (Tippen, Wischen, Halten, 2×), the menu and what the app needs. */
function helpRows(locale: Locale): string[] {
  return ["help.title", "help.tap", "help.swipe", "help.hold", "help.double", "help.menu", "help.needs"].map((key) => tr(messages, locale, key));
}

/** Gestures a footer names, as message keys of the actions ("f.open"). */
interface FooterKeys { readonly tap?: string; readonly swipe?: string; readonly hold?: string }

/** Footer that is only a hint and the way out (nothing to tap here). */
function footer_(locale: Locale, end: FooterEnd, lead: string): string {
  return footer(locale, {}, end, lead);
}

/** Footer through the shared QIS builder: fixed order, `2× = zurück|Ende` last, always one row wide. */
function ft(locale: Locale, keys: FooterKeys, end: FooterEnd = "back", lead = ""): string {
  const parts: { tap?: string; swipe?: string; hold?: string } = {};
  if (keys.tap !== undefined) parts.tap = tr(messages, locale, keys.tap);
  if (keys.swipe !== undefined) parts.swipe = tr(messages, locale, keys.swipe);
  if (keys.hold !== undefined) parts.hold = tr(messages, locale, keys.hold);
  return footer(locale, parts as FooterParts, end, lead);
}

export function buildView(model: HubModel, locale: Locale, now: number): ScreenView {
  const report = model.report;
  const voiceShown = model.voice !== null && voiceOwns(model);
  const askAgent = model.screen === "agent" && model.agentView === "ask" && report.approvals.length === 0 && !voiceShown && !model.recording && !model.help && model.picker === null ? selectedAgent(model) : undefined;
  const briefShown = model.screen === "brief" && !model.help && model.picker === null && !voiceShown && !model.recording && !linkBlocks(model.link);
  const header = askAgent !== undefined ? chatHeader(askAgent, locale, now) : briefShown ? briefHeader(model.brief, locale, now) : statusLine(model, locale);

  let body: readonly string[];
  let footer: string;
  // The Zuhause page is a split page (list left, state right) whatever overlay shows; an overlay leaves the column empty.
  let side: readonly string[] | undefined = model.screen === "home" ? [] : undefined;
  const voiceAgent = !voiceShown ? undefined : report.agents.find((agent) => agent.id === model.voice?.agentId);
  if (model.help) {
    body = helpRows(locale);
    footer = ft(locale, { tap: "f.close" });
  } else if (model.picker !== null) {
    const entries = pickerEntries(model, locale);
    body = [tr(messages, locale, "picker.title"), ...windowed(entries.map((entry, i) => marked(entry.label, i === model.picker)), model.picker, 6)];
    footer = ft(locale, { tap: "f.open", swipe: "f.select" });
  } else if (model.recording) {
    const live = model.liveText ?? "";
    body = live === ""
      ? ["", tr(messages, locale, "voice.recording"), tr(messages, locale, "voice.recordingHint")]
      : [tr(messages, locale, "voice.live"), ...liveRows(live, 6)];
    footer = tr(messages, locale, "agent.record");
  } else if (model.voice !== null && voiceShown) {
    const name = fit(`${voiceAgent?.online === false ? "○" : "●"} ${voiceAgent?.label ?? model.voice.agentId}`);
    if (model.voice.state === "transcribing") {
      body = [name, "", tr(messages, locale, "voice.processing")];
      footer = tr(messages, locale, "voice.processing");
    } else {
      const lines = wrap(model.voice.text);
      const from = Math.min(model.voice.scroll ?? 0, Math.max(0, lines.length - VOICE_ROWS));
      const more = lines.length > VOICE_ROWS ? ` ${from + 1}-${Math.min(lines.length, from + VOICE_ROWS)}/${lines.length}` : "";
      body = [name, `${tr(messages, locale, "voice.understood")}${more}`, ...lines.slice(from, from + VOICE_ROWS)];
      footer = ft(locale, SIDE_MENU ? { tap: "f.send" } : { tap: "f.send", hold: "f.discard" });
    }
  } else if (linkBlocks(model.link) && model.link !== null) {
    body = linkRows(model.link, locale);
    const end: FooterEnd = model.screen === "root" ? "exit" : "back";
    footer = model.link.problem === "missing" || model.link.problem === "insecure"
      ? footer_(locale, end, tr(messages, locale, "f.scanQr"))
      : ft(locale, { tap: "f.again" }, end);
  } else if (model.screen === "root") {
    body = rootRows(report, model.rootSelected, locale, now, model.brief ?? report.brief, model.setupHint === true);
    footer = ft(locale, { tap: "f.open", swipe: "f.select" }, "exit");
  } else if (model.screen === "agent") {
    const card = pendingApproval(report);
    const agent = selectedAgent(model);
    if (card !== undefined) {
      body = approvalRows(card, report.approvals.length, model.cardIndex ?? 0, locale);
      footer = ft(locale, { tap: "f.send", swipe: "f.select" });
    } else if (model.agentView === "list") {
      body = agentListRows(model, locale, now);
      footer = ft(locale, { tap: "f.sessions", swipe: "f.select" });
    } else if (model.agentView === "sessions") {
      body = sessionRows(model, locale);
      footer = ft(locale, { tap: "f.open", swipe: "f.select" });
    } else {
      body = agent === undefined ? [tr(messages, locale, "agent.none")] : chatRows(model, agent, locale);
      footer = agent?.busy === true ? ft(locale, { tap: "f.stop" })
        : (model.chatScroll ?? 0) > 0 ? ft(locale, { tap: "f.newest", swipe: "f.scroll" })
          : ft(locale, { tap: "f.send", swipe: "f.select", hold: "f.speak" });
    }
  } else if (model.screen === "home") {
    const view = homeViewOf(report);
    if (view === null || (view.legacy === true && view.favorites.length === 0)) {
      body = homeRows(report.home, locale);
      footer = ft(locale, { tap: "f.switch", swipe: "f.select" });
    } else {
      const zh = zhOf(model);
      body = listRows(zh, view, locale);
      side = sideRows(zh, view, locale);
      const detail = zh.level === "detail" && zh.detailId !== null ? view.entities[zh.detailId] : undefined;
      footer = detail === undefined ? ft(locale, { tap: "f.switch", swipe: "f.select", hold: "f.detail" })
        : typeof zh.choice === "number" ? ft(locale, { tap: "f.run", swipe: "f.select" })
          : ft(locale, { tap: "f.choose", swipe: "f.device" });
    }
  } else if (model.screen === "brief") {
    const pages = briefPageRows(model, locale, now);
    const page = Math.max(0, Math.min(model.briefPage ?? 0, pages.length - 1));
    body = pages[page] ?? [];
    footer = briefFooter(page, pages.length, locale);
  } else if (model.screen === "printer") {
    body = printerRows(report.printer, locale);
    footer = ft(locale, { tap: "f.action", swipe: "f.select" });
  } else {
    body = inboxRows(report.inbox, locale);
    footer = ft(locale, { tap: "f.open", swipe: "f.select" });
  }

  if (model.confirm !== null && model.confirm.until > now) {
    footer = armedFooter(locale, model.confirm.label);
  } else if (model.message !== null && model.message.until > now && !voiceShown && !model.recording) {
    footer = model.message.text;
  }
  // Recording wins over everything: the user must always see that the mic is on.
  if (model.recording) footer = tr(messages, locale, "agent.record");

  return { header, body: body.slice(0, 7), footer: fit(footer), ...(side === undefined ? {} : { side }) };
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

/** "✓ Führt Befehl aus · find /etc" for each step the agent already finished (not the running one). */
function doneSteps(agent: AgentInfo, locale: Locale): string[] {
  const steps = agent.steps ?? [];
  const finished = agent.activity !== "" && steps.at(-1) === agent.activity ? steps.slice(0, -1) : steps;
  return finished.map((step) => {
    const activity = describeActivity(step, locale);
    return fit(`· ${activity.label}${activity.detail !== "" ? ` · ${activity.detail}` : ""}`);
  });
}


// ---- conversation view -------------------------------------------------------

/** Chat rows visible below the divider. */
export const CHAT_ROWS = 6;
const DIVIDER = "—".repeat(37);

/** What a question does to the agent at once, before the daemon answers (shows up in the chat right away). */
function asked(agent: AgentInfo, question: string): Partial<AgentInfo> {
  return {
    busy: true, answer: null, activity: "", error: null, lastQuestion: question, steps: [], busySince: Date.now(),
    chat: [...(agent.chat ?? []), { role: "user" as const, text: question }],
  };
}

/** Header of the open conversation: what the agent is doing (or who it is) and the time. */
function chatHeader(agent: AgentInfo, locale: Locale, now: number): string {
  const clock = new Date(now).toLocaleTimeString(locale === "de" ? "de-AT" : "en-GB", { hour: "2-digit", minute: "2-digit" });
  const title = sessionTitle(agent, locale);
  const doing = agent.busy
    ? workingLine(agent, locale, now).replace(/^» /, "")
    : `${agent.online ? "●" : "○"} ${agent.label}${title ? ` · ${title}` : ""}`;
  return fit(`QUIET HUB · ${fit(doing, 30)} · ${clock}`);
}

/** The whole conversation as rows, oldest first; the steps while it works, the suggestions at its end. */
export function chatLines(agent: AgentInfo, items: readonly string[], selected: number, locale: Locale): string[] {
  const turns = agent.chat !== undefined && agent.chat.length > 0
    ? agent.chat
    : [
      ...((agent.lastQuestion ?? "") !== "" ? [{ role: "user" as const, text: agent.lastQuestion ?? "" }] : []),
      ...((agent.answer ?? "") !== "" && !agent.busy ? [{ role: "assistant" as const, text: agent.answer ?? "" }] : []),
    ];
  const lines: string[] = [];
  turns.forEach((turn, i) => {
    if (turn.role === "user") {
      if (i > 0) lines.push("");
      lines.push(...wrap(tr(messages, locale, "agent.you", { text: turn.text })));
    } else {
      lines.push(...wrap(turn.text));
    }
  });
  if (agent.busy) {
    // The words streaming in, then what it has done so far.
    if ((agent.answer ?? "") !== "") lines.push(...wrap(agent.answer ?? ""));
    lines.push(...doneSteps(agent, locale));
  } else if (agent.error !== null) {
    lines.push(...wrap(agent.error));
  }
  if (agent.stopped === true) lines.push(tr(messages, locale, "agent.stopped"));
  if (!agent.busy) {
    lines.push("");
    if (items.length > 0) lines.push(...items.map((q, i) => marked(q, i === selected)));
    else lines.push(emptyRow(agent, locale));
  }
  return lines;
}

function chatRows(model: HubModel, agent: AgentInfo, locale: Locale): string[] {
  const items = agentItems(agent, model.report.agent.questions);
  const lines = chatLines(agent, items, model.questionIndex, locale);
  const scroll = Math.min(model.chatScroll ?? 0, Math.max(0, lines.length - CHAT_ROWS));
  const end = lines.length - scroll;
  const window = lines.slice(Math.max(0, end - CHAT_ROWS), end);
  const marker = scroll > 0 ? `${DIVIDER.slice(0, 28)} ↑ ${tr(messages, locale, "chat.older")}` : DIVIDER;
  return [marker, ...window];
}

/**
 * Swipe in the conversation: at the bottom it moves through the suggestions;
 * past the first one (or without any) it scrolls the chat up a screen at a
 * time, and back down again.
 */
function scrollChat(model: HubModel, agent: AgentInfo, step: number, locale: Locale): HubModel {
  const items = agentItems(agent, model.report.agent.questions);
  const lines = chatLines(agent, items, model.questionIndex, locale);
  const maxScroll = Math.max(0, lines.length - CHAT_ROWS);
  const scroll = Math.min(model.chatScroll ?? 0, maxScroll);
  if (scroll === 0 && items.length > 0 && !agent.busy) {
    if (step > 0) return { ...model, questionIndex: Math.min(items.length - 1, model.questionIndex + 1) };
    if (model.questionIndex > 0) return { ...model, questionIndex: model.questionIndex - 1 };
  }
  if (step < 0) return { ...model, chatScroll: Math.min(maxScroll, scroll + CHAT_ROWS - 1) };
  return { ...model, chatScroll: Math.max(0, scroll - (CHAT_ROWS - 1)) };
}
