import { tr, type Locale } from "../i18n";
import { messages } from "../messages";
import type { HomeEntity, HomeView } from "../api/types";
import { areaEntries, detailChoices, entityLabel, listEntries, stateText, type ZuhauseState } from "../hub/zuhause";
import type { StartTile } from "./start";
import { hhmm, type CockpitCell, type CockpitModel } from "./model";
import { BLIND, HOUSE, LAMP_OFF, LAMP_ON, LOCK, PLUG, SENSOR, STAR, TV, type TvScreen } from "./widgets";

/**
 * Zuhause as pictures (0.13.2, Alfred: "TV hat keine Übersicht"): the favourites and rooms as tiles
 * (lamp on/off, TV, plug, blind, sensor value, room), six per page; a light, blind or TV opened shows
 * its picture left (TV Glance's TV with the volume bar, a brightness / position ring) and its choices
 * as cells right, the selected one framed. Same gestures as the text page (src/hub/zuhause.ts).
 */

type T = (key: string, vars?: Record<string, string | number>) => string;

function iconOf(entity: HomeEntity): readonly string[] {
  switch (entity.kind) {
    case "light": return entity.on ? LAMP_ON : LAMP_OFF;
    case "media": return TV;
    case "switch": return PLUG;
    case "cover": case "garage": return BLIND;
    case "lock": case "alarm": return LOCK;
    case "scene": return STAR;
    default: return SENSOR;
  }
}

function entityTile(entity: HomeEntity, locale: Locale): StartTile {
  const state = stateText(entity, locale);
  const readOnly = entity.kind === "sensor" || entity.kind === "motion";
  // Sensors: the value is the big number; everything else: the state word.
  const media = entity.kind === "media";
  const value = media ? (!entity.available ? stateText(entity, locale) : entity.on ? (entity.value !== undefined && entity.value !== "" ? entity.value : tr(messages, locale, "zh.on")) : tr(messages, locale, "zh.off"))
    : readOnly ? state : entity.kind === "light" && entity.on && typeof entity.brightness === "number" && entity.brightness > 0 ? `${entity.brightness} %` : state;
  const sub = media && entity.on ? (entity.muted === true ? tr(messages, locale, "zh.muted") : typeof entity.volume === "number" ? `${tr(messages, locale, "zh.volume")} ${entity.volume} %` : "") : "";
  return {
    key: `entity:${entity.id}`, label: entityLabel(entity, locale).toUpperCase(), value, sub,
    graphic: { kind: "icon", rows: iconOf(entity), dim: !entity.available || (!entity.on && !readOnly && entity.kind !== "scene") },
  };
}

/** Tiles of the level shown (top list or one room), in the order the cursor walks. */
export function homeTiles(view: HomeView, state: ZuhauseState, locale: Locale): StartTile[] {
  const t: T = (key, vars = {}) => tr(messages, locale, key, vars);
  if (state.level === "area") {
    return areaEntries(view, state.areaId).map((id) => view.entities[id]).filter((e): e is HomeEntity => e !== undefined).map((e) => entityTile(e, locale));
  }
  return listEntries(view).map((entry): StartTile => {
    if (entry.type === "entity") {
      const entity = view.entities[entry.id];
      return entity === undefined ? { key: entry.id, label: entry.id, value: "–", sub: "", graphic: { kind: "icon", rows: SENSOR, dim: true } } : entityTile(entity, locale);
    }
    const area = view.areas.find((a) => a.id === entry.id);
    const members = (area?.entities ?? []).map((id) => view.entities[id]).filter((e): e is HomeEntity => e !== undefined && e.group !== true);
    const lights = members.filter((e) => e.kind === "light");
    const on = lights.filter((e) => e.on).length;
    return {
      key: `area:${entry.id}`, label: (area?.name ?? entry.id).toUpperCase(),
      value: lights.length === 0 ? t("zh.areaTile", { n: members.length }) : t("tile.on", { n: on }), sub: lights.length === 0 ? "" : t("zh.sumLights", { on, n: lights.length }),
      graphic: { kind: "icon", rows: HOUSE, dim: on === 0 },
    };
  });
}

/** Index of the cursor in homeTiles. */
export function homeIndex(state: ZuhauseState): number {
  return state.level === "area" ? state.areaIndex : state.index;
}

/** Header of the tile page: "ZUHAUSE" or the room's name. */
export function homeHeader(view: HomeView, state: ZuhauseState, locale: Locale): string {
  const area = state.level === "area" ? view.areas.find((a) => a.id === state.areaId) : undefined;
  return (area?.name ?? tr(messages, locale, "screen.home")).toUpperCase();
}

function tvScreen(entity: HomeEntity): TvScreen {
  if (!entity.available) return "unknown";
  if (!entity.on) return "off";
  if (entity.state === "playing") return "playing";
  if (entity.state === "paused") return "paused";
  return "idle";
}

/** One light, blind or TV opened: picture left, the choices as cells (selected one framed). */
export function homeDetail(entity: HomeEntity, choice: number | null, locale: Locale, now: number, hint: string): CockpitModel {
  const t: T = (key, vars = {}) => tr(messages, locale, key, vars);
  const choices = detailChoices(entity, locale);
  const at = choice === null ? -1 : Math.min(choice, choices.length - 1);
  const cells: CockpitCell[] = choices.map((c, i) => ({ label: i === at ? t("zh.cellChosen") : "", value: c.label, alert: i === at }));
  const head = { title: t("screen.home").toUpperCase(), clock: hhmm(now), hint, mood: "idle" as const, tone: "ok" as const, state: "ready" as const };
  const name = entityLabel(entity, locale).toUpperCase();
  if (entity.kind === "media") {
    const volume = typeof entity.volume === "number" ? entity.volume : null;
    return {
      ...head, headline: [name], cells, caption: stateText(entity, locale),
      graphic: { kind: "tv", screen: tvScreen(entity), volume, muted: entity.muted === true, volumeLabel: t("zh.volume"), volumeText: entity.muted === true ? t("zh.muted") : volume === null ? "–" : `${volume} %` },
    };
  }
  const percent = entity.kind === "light" ? (entity.on ? (typeof entity.brightness === "number" && entity.brightness > 0 ? entity.brightness : 100) : 0)
    : typeof entity.position === "number" ? entity.position : entity.on ? 100 : 0;
  return {
    ...head, headline: [name], cells, caption: stateText(entity, locale),
    graphic: { kind: "ring", percent, tone: entity.available ? "ok" : "offline", center: `${percent} %`, sub: t(entity.kind === "light" ? "zh.ringLight" : "zh.ringCover") },
  };
}

/** The agents as tiles (agent list): a face per agent in its mood, its state, its machine. */
export function agentTiles(report: import("../api/types").HubReport, locale: Locale): StartTile[] {
  const t: T = (key, vars = {}) => tr(messages, locale, key, vars);
  const waiting = new Set(report.approvals.map((card) => card.agentId));
  return report.agents.map((agent): StartTile => {
    const mood = !agent.online ? "asleep" : waiting.has(agent.id) ? "waiting" : agent.busy ? "working" : agent.error ? "error" : "idle";
    const value = !agent.online ? t("tile.agentOff") : waiting.has(agent.id) ? t("tile.agentWaits") : agent.busy ? t("tile.agentBusy") : t("tile.agentReady");
    return { key: `agent:${agent.id}`, label: agent.label.toUpperCase(), value, sub: agent.machine ?? "", graphic: { kind: "mascot", mood }, alert: waiting.has(agent.id) };
  });
}
