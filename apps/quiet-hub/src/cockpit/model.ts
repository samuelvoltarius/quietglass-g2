import type { Locale } from "../i18n";
import { tr } from "../i18n";
import { messages } from "../messages";
import type { AgentInfo } from "../api/types";
import { linkBlocks, selectedAgent, unreadEvents, type HubModel } from "../hub/model";
import { describeActivity } from "../hub/activity";
import { footer } from "../glasses/footer";
import { moodFor } from "../glasses/icons";
import type { Mood } from "../glasses/mascot";

/**
 * What the cockpit shows, in words and numbers, decided without drawing (QUS v1): the headline (the state),
 * the label/value cells, the mascot's mood, the caption and the hint line. compose.ts only lays this out.
 */

export type Tone = "ok" | "working" | "waiting" | "offline";
export type HubState = "working" | "waiting" | "ready" | "offline" | "noServer";

export interface CockpitCell {
  readonly label: string;
  readonly value: string;
  /** Drawn with a frame round it (something wants you). */
  readonly alert?: boolean;
}

export interface CockpitModel {
  readonly title: string;
  readonly clock: string;
  /** One big line, already upper case. */
  readonly headline: readonly string[];
  readonly cells: readonly CockpitCell[];
  /** The mascot's mood; its frame is drawn in the left half. */
  readonly mood: Mood;
  /** Left bottom, under the mascot. */
  readonly caption: string;
  /** The one footer line with the gestures. */
  readonly hint: string;
  readonly tone: Tone;
  readonly state: HubState;
}

const DASH = "–";

/** "HH:MM" of an epoch ms in the phone's time (24 h). */
export function hhmm(time: number): string {
  const date = new Date(time);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** How the hub stands: no server, offline, an agent waits for you, an agent works, or ready. */
export function hubState(model: HubModel): HubState {
  if (model.link?.problem === "missing" || model.report.connection === "missing") return "noServer";
  if (linkBlocks(model.link) || model.report.connection === "error") return "offline";
  if (model.report.approvals.length > 0) return "waiting";
  if (model.report.agents.some((agent) => agent.busy)) return "working";
  return "ready";
}

/** The agent the cockpit is about: the one that waits for you, else a working one, else the selected one. */
export function focusAgent(model: HubModel): AgentInfo | undefined {
  const agents = model.report.agents;
  const waitingId = model.report.approvals[0]?.agentId;
  return agents.find((agent) => agent.id === waitingId) ?? agents.find((agent) => agent.busy) ?? selectedAgent(model) ?? agents[0];
}

/** "<1 min", "7 min", "1 h 05": coarse on purpose - the cell changes once a minute, not every second. */
export function durationText(ms: number, locale: Locale): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return tr(messages, locale, "cp.lessMin");
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")}`;
}

/** Steps the running question has finished (the step in progress does not count yet). */
export function finishedSteps(agent: AgentInfo): number {
  const steps = agent.steps ?? [];
  return agent.activity !== "" && steps.at(-1) === agent.activity ? steps.length - 1 : steps.length;
}

/** The five cells: Agent, Sitzung, Dauer, Schritte, Ungelesen. */
export function cockpitCells(model: HubModel, now: number, locale: Locale): CockpitCell[] {
  const t = (key: string): string => tr(messages, locale, key);
  const agent = focusAgent(model);
  const unread = unreadEvents(model.report.inbox).length;
  const running = agent?.busy === true;
  const since = typeof agent?.busySince === "number" && agent.busySince > 0 ? agent.busySince : null;
  return [
    { label: t("cp.agent"), value: agent?.label ?? DASH },
    { label: t("cp.session"), value: agent?.session?.title ? agent.session.title : DASH },
    { label: t("cp.duration"), value: running && since !== null ? durationText(now - since, locale) : DASH },
    { label: t("cp.steps"), value: running && agent !== undefined ? String(finishedSteps(agent)) : DASH },
    { label: t("cp.unread"), value: String(unread), ...(unread > 0 ? { alert: true } : {}) },
  ];
}

const HEADLINE: Record<HubState, string> = {
  working: "cp.working", waiting: "cp.waiting", ready: "cp.ready", offline: "cp.offline", noServer: "cp.noServer",
};

/** Under the mascot: the demo hint, what the agent does, what waits, or how many agents are online. */
export function cockpitCaption(model: HubModel, locale: Locale): string {
  const t = (key: string, vars: Record<string, string | number> = {}): string => tr(messages, locale, key, vars);
  if (model.setupHint === true) return t("cp.demo");
  const state = hubState(model);
  const agent = focusAgent(model);
  if (state === "waiting") return model.report.approvals[0]?.title ?? "";
  if (state === "working" && agent !== undefined) return describeActivity(agent.activity, locale).label;
  const agents = model.report.agents;
  if (agents.length === 0) return t("cp.noAgents");
  return t("cp.online", { online: agents.filter((entry) => entry.online).length, total: agents.length });
}

export function cockpitHint(locale: Locale): string {
  return footer(locale, { tap: tr(messages, locale, "f.agents") }, "back");
}

export function cockpitModel(model: HubModel, locale: Locale, now: number): CockpitModel {
  const state = hubState(model);
  return {
    title: "QUIET HUB",
    clock: hhmm(now),
    headline: [tr(messages, locale, HEADLINE[state])],
    cells: cockpitCells(model, now, locale),
    mood: moodFor(model, now),
    caption: cockpitCaption(model, locale),
    hint: cockpitHint(locale),
    tone: state === "ready" ? "ok" : state === "working" ? "working" : state === "waiting" ? "waiting" : "offline",
    state,
  };
}

/** A key that changes exactly when what the cockpit would draw changes (the tile sender dedupes on pixels; this is for tests). */
export function modelKey(model: CockpitModel): string {
  return JSON.stringify([model.clock, model.headline, model.cells, model.mood, model.caption, model.hint]);
}
