/**
 * "Zuhause": the Home Assistant page of Quiet Hub, as pure functions.
 *
 * The daemon sends a curated view (favourites, areas, per-area groups, sensors);
 * this module turns it into the split page of the glasses (list left, state of
 * the selected row right), decides what a tap does to an entity, and patches
 * the view optimistically so a switch flips at once instead of after the next
 * poll. Older daemons only send the flat `home.devices` list: that becomes a
 * favourites-only view switched through the old `/home/toggle`.
 *
 * Levels: list (favourites, then areas) -> area (its groups and entities) ->
 * detail (one light or cover). QIS v1.2 #5: in the detail swipe only MOVES to
 * the next light / cover of the same list; a tap opens a small choice list
 * (light: Aus · 30 % · 60 % · 100 %, plus An when no level is known; cover:
 * Auf · Zu · Stopp), swipe moves in it, tap runs the chosen entry, 2× closes it.
 *
 * Hold never reaches the app from the temple (only from the R1 ring), so a tap on a light,
 * cover or TV in the list opens that choice list directly (`openDetail`). TV / projector
 * (kind "media", daemon HA_MEDIA): Lauter · Leiser · Stumm · Play/Pause · Aus; the list
 * stays open after a volume step, so tap, tap, tap turns it up step by step.
 */
import { tr, type Locale } from "../i18n";
import { messages } from "../messages";
import { fit } from "../glasses/screen";
import type { HomeAction, HomeEntity, HomeSnapshot, HomeView, HubReport } from "../api/types";

/** Characters of one row in the left list and in the right state column (split page). */
export const LIST_CHARS = 30;
export const SIDE_CHARS = 21;
/** Rows of the body container. */
const ROWS = 7;
/** One swipe in a light's detail changes the brightness by this much. */
export const DIM_STEP = 10;

export type ZuhauseLevel = "list" | "area" | "detail";

export interface ZuhauseState {
  readonly level: ZuhauseLevel;
  /** Selected row of the top list (favourites, then areas). */
  readonly index: number;
  readonly areaId: string | null;
  readonly areaIndex: number;
  readonly detailId: string | null;
  /** Detail page: selected row of the open choice list (null/absent = closed). */
  readonly choice?: number | null;
  /** A sensitive action waiting for the confirming tap (token from the daemon). */
  readonly pending: { readonly token: string; readonly target: string; readonly until: number } | null;
}

export const initialZuhause = (): ZuhauseState => ({ level: "list", index: 0, areaId: null, areaIndex: 0, detailId: null, choice: null, pending: null });

/** A view built from the flat device list of an older daemon. */
export interface ZuhauseView extends HomeView {
  readonly legacy?: boolean;
}

export type ListEntry = { readonly type: "entity"; readonly id: string } | { readonly type: "area"; readonly id: string };

/** The view to show; null when the daemon has no Home Assistant (labelled stand-ins). */
export function homeViewOf(report: HubReport): ZuhauseView | null {
  if (report.home.demo === true) return null;
  if (report.homeView !== undefined) return report.homeView;
  return legacyView(report.home);
}

function legacyView(home: HomeSnapshot): ZuhauseView {
  const entities: Record<string, HomeEntity> = {};
  for (const device of home.devices) {
    entities[device.id] = device.writable
      ? { id: device.id, name: device.label, kind: device.kind === "cover" ? "cover" : "switch", state: device.state, on: device.on, available: true }
      : { id: device.id, name: device.label, kind: "sensor", state: device.state, on: device.on, available: true, value: device.state };
  }
  return { favorites: home.devices.map((device) => device.id), areas: [], entities, legacy: true };
}

export function listEntries(view: HomeView): ListEntry[] {
  return [
    ...view.favorites.filter((id) => view.entities[id] !== undefined).map((id): ListEntry => ({ type: "entity", id })),
    ...view.areas.map((area): ListEntry => ({ type: "area", id: area.id })),
  ];
}

export function areaEntries(view: HomeView, areaId: string | null): string[] {
  const area = view.areas.find((entry) => entry.id === areaId);
  return area === undefined ? [] : area.entities.filter((id) => view.entities[id] !== undefined);
}

const clamp = (value: number, length: number): number => Math.max(0, Math.min(value, Math.max(0, length - 1)));

/** Keeps the selection valid after a new report (an area or entity may be gone). */
export function clampZuhause(state: ZuhauseState, view: HomeView | null): ZuhauseState {
  if (view === null) return { ...initialZuhause(), index: state.index };
  const index = clamp(state.index, listEntries(view).length);
  const areaOk = state.areaId !== null && view.areas.some((area) => area.id === state.areaId);
  if (state.level === "area" && !areaOk) return { ...state, level: "list", index, areaId: null, areaIndex: 0, detailId: null };
  const detailOk = state.detailId !== null && view.entities[state.detailId] !== undefined;
  if (state.level === "detail" && !detailOk) return { ...state, level: areaOk ? "area" : "list", index, detailId: null, choice: null };
  return { ...state, index, areaIndex: clamp(state.areaIndex, areaEntries(view, state.areaId).length) };
}

/** The entity the selection points at (detail, area row or favourite), if any. */
export function selectedEntity(state: ZuhauseState, view: HomeView): HomeEntity | undefined {
  if (state.level === "detail" && state.detailId !== null) return view.entities[state.detailId];
  if (state.level === "area") {
    const id = areaEntries(view, state.areaId)[state.areaIndex];
    return id === undefined ? undefined : view.entities[id];
  }
  const entry = listEntries(view)[state.index];
  return entry?.type === "entity" ? view.entities[entry.id] : undefined;
}

// ---- words ------------------------------------------------------------------

export function entityLabel(entity: HomeEntity, locale: Locale): string {
  if (entity.group === true) return tr(messages, locale, entity.kind === "light" ? "zh.allLights" : "zh.allCovers");
  return entity.name;
}

/** Short state: "an · 60 %", "offen", "21,5 °C", "Bewegung", "1/3 an". */
export function stateText(entity: HomeEntity, locale: Locale): string {
  const t = (key: string, vars: Record<string, string | number> = {}): string => tr(messages, locale, key, vars);
  if (!entity.available) return t("zh.unavailable");
  if (entity.group === true) return t(entity.kind === "light" ? "zh.groupOn" : "zh.groupOpen", { n: entity.state });
  switch (entity.kind) {
    case "light":
      if (!entity.on) return t("zh.off");
      return typeof entity.brightness === "number" && entity.brightness > 0 ? `${t("zh.on")} · ${entity.brightness} %` : t("zh.on");
    case "switch": return t(entity.on ? "zh.on" : "zh.off");
    case "cover":
    case "garage":
      if (typeof entity.position === "number" && entity.position > 0 && entity.position < 100) return t("zh.openPct", { n: entity.position });
      return t(entity.state === "opening" ? "zh.opening" : entity.state === "closing" ? "zh.closing" : entity.on ? "zh.open" : "zh.closed");
    case "lock": return t(entity.on ? "zh.unlocked" : "zh.locked");
    case "alarm": return t(entity.on ? "zh.armed" : "zh.disarmed");
    case "scene": return t("zh.scene");
    case "motion": return t(entity.on ? "zh.motion" : "zh.still");
    case "media": {
      if (!entity.on) return t("zh.off");
      const parts = [entity.value !== undefined && entity.value !== "" ? entity.value : t("zh.on")];
      if (entity.muted === true) parts.push(t("zh.muted"));
      else if (typeof entity.volume === "number") parts.push(`${entity.volume} %`);
      return parts.join(" · ");
    }
    default: return entity.value !== undefined && entity.value !== "" ? entity.value : entity.state;
  }
}

/** ● on, ○ off, » scene, · read-only. */
function markOf(entity: HomeEntity): string {
  if (entity.kind === "sensor" || entity.kind === "motion") return "·";
  if (entity.kind === "scene") return "»";
  return entity.on && entity.available ? "●" : "○";
}

function row(text: string, selected: boolean): string {
  return (selected ? "> " : "  ") + fit(text, LIST_CHARS - 2);
}

function windowed(rows: readonly string[], selected: number, size: number): string[] {
  if (rows.length <= size) return [...rows];
  const start = Math.max(0, Math.min(selected - Math.floor(size / 2), rows.length - size));
  return rows.slice(start, start + size);
}

/** "##########" for 100 %, "----------" for 0. */
export function levelBar(percent: number): string {
  const filled = Math.round(Math.max(0, Math.min(100, percent)) / 10);
  return `${"#".repeat(filled)}${"-".repeat(10 - filled)}`;
}

function entityRow(entity: HomeEntity, locale: Locale): string {
  return `${markOf(entity)} ${entityLabel(entity, locale)}`;
}

/** Left column of the split page. */
export function listRows(state: ZuhauseState, view: HomeView, locale: Locale): string[] {
  const t = (key: string, vars: Record<string, string | number> = {}): string => tr(messages, locale, key, vars);
  if (state.level === "detail") {
    const entity = state.detailId === null ? undefined : view.entities[state.detailId];
    if (entity === undefined) return [t("zh.gone")];
    const rows = [fit(entityRow(entity, locale), LIST_CHARS), fit(stateText(entity, locale), LIST_CHARS)];
    if (typeof state.choice === "number") {
      const choices = detailChoices(entity, locale);
      const at = Math.min(state.choice, choices.length - 1);
      return [...rows, ...windowed(choices.map((c, i) => row(c.label, i === at)), at, ROWS - rows.length)];
    }
    if (entity.kind === "light" && entity.group !== true) {
      const level = entity.on ? (typeof entity.brightness === "number" ? entity.brightness : 100) : 0;
      rows.push("", `[${levelBar(level)}] ${level} %`);
    } else if ((entity.kind === "cover" || entity.kind === "garage") && typeof entity.position === "number") {
      rows.push("", `[${levelBar(entity.position)}] ${entity.position} %`);
    } else if (entity.kind === "media" && typeof entity.volume === "number") {
      rows.push("", `[${levelBar(entity.volume)}] ${entity.volume} %`);
    }
    return rows;
  }
  if (state.level === "area") {
    const ids = areaEntries(view, state.areaId);
    if (ids.length === 0) return [t("zh.areaEmpty")];
    const rows = ids.map((id, i) => {
      const entity = view.entities[id];
      return row(entity === undefined ? id : entityRow(entity, locale), i === state.areaIndex);
    });
    return windowed(rows, state.areaIndex, ROWS);
  }
  const entries = listEntries(view);
  if (entries.length === 0) return [fit(t("zh.empty"), LIST_CHARS), fit(t("zh.emptyHint"), LIST_CHARS)];
  const rows = entries.map((entry, i) => {
    if (entry.type === "area") {
      const area = view.areas.find((a) => a.id === entry.id);
      return row(`→ ${area?.name ?? entry.id}`, i === state.index);
    }
    const entity = view.entities[entry.id];
    return row(entity === undefined ? entry.id : entityRow(entity, locale), i === state.index);
  });
  return windowed(rows, state.index, ROWS);
}

/** What a tap does, said in the right column. */
function tapHint(entity: HomeEntity, locale: Locale): string {
  const t = (key: string): string => tr(messages, locale, key);
  if (entity.sensitive === true) return t("zh.hintSensitive");
  switch (entity.kind) {
    case "light": return t(entity.group === true ? "zh.hintSwitch" : "zh.hintLight");
    case "switch": return t("zh.hintSwitch");
    case "cover":
    case "garage": return t("zh.hintCover");
    case "scene": return t("zh.hintScene");
    case "media": return t("zh.hintMedia");
    default: return t("zh.readOnly");
  }
}

function areaSummary(view: HomeView, areaId: string, locale: Locale): string[] {
  const t = (key: string, vars: Record<string, string | number> = {}): string => tr(messages, locale, key, vars);
  const area = view.areas.find((entry) => entry.id === areaId);
  if (area === undefined) return [];
  const members = area.entities.map((id) => view.entities[id]).filter((e): e is HomeEntity => e !== undefined && e.group !== true);
  const lights = members.filter((e) => e.kind === "light");
  const covers = members.filter((e) => e.kind === "cover" || e.kind === "garage");
  const lines = [area.name];
  if (lights.length > 0) lines.push(t("zh.sumLights", { on: lights.filter((e) => e.on).length, n: lights.length }));
  if (covers.length > 0) lines.push(t("zh.sumCovers", { on: covers.filter((e) => e.on).length, n: covers.length }));
  for (const sensor of members.filter((e) => e.kind === "sensor" && e.sensorClass !== "battery").slice(0, 2)) lines.push(stateText(sensor, locale));
  if (members.some((e) => e.kind === "motion" && e.on)) lines.push(t("zh.motion"));
  const low = members.find((e) => e.kind === "sensor" && e.sensorClass === "battery" && Number.parseFloat(e.value ?? "") < 20);
  if (low !== undefined) lines.push(t("zh.batteryLow", { value: low.value ?? "" }));
  return lines;
}

/** Right column: the state of the selected row and what a gesture does there. */
export function sideRows(state: ZuhauseState, view: HomeView, locale: Locale): string[] {
  const t = (key: string, vars: Record<string, string | number> = {}): string => tr(messages, locale, key, vars);
  let lines: string[];
  if (state.level === "detail") {
    const entity = state.detailId === null ? undefined : view.entities[state.detailId];
    if (entity === undefined) lines = [];
    else if (typeof state.choice === "number") lines = [t("zh.choiceRun"), t("zh.choiceSelect"), t("zh.choiceClose")];
    else {
      const siblings = detailSiblings(state, view);
      const at = siblings.indexOf(entity.id);
      lines = [t("zh.detailTap"), ...(siblings.length > 1 ? [t("zh.detailSwipe"), `${at + 1}/${siblings.length}`] : []), t("zh.back")];
    }
  } else {
    const entry = state.level === "list" ? listEntries(view)[state.index] : undefined;
    if (entry?.type === "area") {
      lines = [...areaSummary(view, entry.id, locale), "", t("zh.hintArea")];
    } else {
      const entity = selectedEntity(state, view);
      if (entity === undefined) {
        lines = [];
      } else {
        lines = [entityLabel(entity, locale), stateText(entity, locale)];
        if (entity.group === true) lines.push(t("zh.members", { n: entity.members?.length ?? 0 }));
        else if (entity.kind === "light" && entity.on && typeof entity.brightness === "number") lines.push(`${levelBar(entity.brightness)}`);
        lines.push("", canDetail(entity) ? t("zh.detailTap") : tapHint(entity, locale));
      }
    }
  }
  // Too long: the spacer rows go first, so the hint at the end stays visible.
  while (lines.length > ROWS && lines.includes("")) lines.splice(lines.indexOf(""), 1);
  if (lines.length > ROWS) lines = [...lines.slice(0, ROWS - 1), lines[lines.length - 1] ?? ""];
  return lines.map((line) => fit(line, SIDE_CHARS));
}

// ---- actions -----------------------------------------------------------------

/** Lights (not groups), covers and TVs have a detail level; sensitive ones never (always two-step). */
export function canDetail(entity: HomeEntity): boolean {
  if (entity.sensitive === true || !entity.available) return false;
  return (entity.kind === "light" && entity.group !== true) || entity.kind === "cover" || entity.kind === "media";
}

/**
 * Tap on a list row with a detail: the detail opens with its choice list, the cursor on the likely
 * wish (a light that is on: "Aus"; off: the brightest level / "An"; a TV that is off: "An").
 */
export function openDetail(state: ZuhauseState, entity: HomeEntity, locale: Locale): ZuhauseState {
  const choices = detailChoices(entity, locale);
  const choice = entity.kind === "light" && !entity.on ? choices.length - 1 : 0;
  return { ...state, pending: null, level: "detail", detailId: entity.id, choice };
}

/** A TV keeps its choice list open after these (tap, tap, tap = three steps louder). */
export function keepsChoice(action: HomeAction): boolean {
  return action === "volume_up" || action === "volume_down" || action === "mute";
}

/** One entry of the detail choice list and the daemon action it runs (the same calls as before). */
export interface DetailChoice { readonly label: string; readonly action: HomeAction; readonly value?: number }

/** Brightness steps of the light choice list. */
export const LIGHT_LEVELS = [30, 60, 100] as const;

/**
 * The choice list of a detail: light `Aus · 30 % · 60 % · 100 %` (+ `An` when the light
 * reports no level, i.e. it may be on/off only), cover `Auf · Zu · Stopp`.
 * "Aus" and the levels are the brightness action (0 = off), "An" is turn_on.
 */
export function detailChoices(entity: HomeEntity, locale: Locale): DetailChoice[] {
  const t = (key: string): string => tr(messages, locale, key);
  if (entity.kind === "media") {
    if (!entity.on) return [{ label: t("zh.choiceOn"), action: "turn_on" }];
    return [
      { label: t("zh.louder"), action: "volume_up" },
      { label: t("zh.quieter"), action: "volume_down" },
      { label: t(entity.muted === true ? "zh.unmute" : "zh.mute"), action: "mute" },
      { label: t("zh.playPause"), action: "play_pause" },
      { label: t("zh.choiceOff"), action: "turn_off" },
    ];
  }
  if (entity.kind === "light") {
    const knownLevel = typeof entity.brightness === "number" && entity.brightness > 0;
    return [
      { label: t("zh.choiceOff"), action: "brightness", value: 0 },
      ...LIGHT_LEVELS.map((n): DetailChoice => ({ label: `${n} %`, action: "brightness", value: n })),
      ...(knownLevel ? [] : [{ label: t("zh.choiceOn"), action: "turn_on" as const }]),
    ];
  }
  return [
    { label: t("zh.choiceOpen"), action: "open" },
    { label: t("zh.choiceClose2"), action: "close" },
    { label: t("zh.choiceStop"), action: "stop" },
  ];
}

/** Lights / covers of the list the detail was opened from (area, else favourites): swipe moves between them. */
export function detailSiblings(state: ZuhauseState, view: HomeView): string[] {
  const ids = state.areaId !== null
    ? areaEntries(view, state.areaId)
    : listEntries(view).filter((entry) => entry.type === "entity").map((entry) => entry.id);
  return ids.filter((id) => { const e = view.entities[id]; return e !== undefined && canDetail(e); });
}

/** The detail moves one light / cover on (wraps); the list selection follows, so 2× lands on it. Never changes a device. */
export function moveDetail(state: ZuhauseState, view: HomeView, step: number): ZuhauseState {
  const siblings = detailSiblings(state, view);
  if (siblings.length === 0 || state.detailId === null) return state;
  const at = Math.max(0, siblings.indexOf(state.detailId));
  const id = siblings[((at + step) % siblings.length + siblings.length) % siblings.length] ?? state.detailId;
  if (state.areaId !== null) return { ...state, detailId: id, choice: null, areaIndex: Math.max(0, areaEntries(view, state.areaId).indexOf(id)) };
  return { ...state, detailId: id, choice: null, index: Math.max(0, listEntries(view).findIndex((entry) => entry.type === "entity" && entry.id === id)) };
}

/** What a tap on the list does to an entity; null = read-only. */
export function tapAction(entity: HomeEntity): HomeAction | null {
  switch (entity.kind) {
    case "light":
    case "switch":
    case "cover":
    case "garage":
    case "lock":
    case "alarm": return "toggle";
    case "scene": return "run";
    case "media": return "toggle";
    default: return null;
  }
}

/** Optimistic local result of an action (the next report brings the real state). */
export function applyHomeAction(view: HomeView, target: string, action: HomeAction, value?: number): HomeView {
  const entity = view.entities[target];
  if (entity === undefined) return view;
  const ids = entity.group === true ? [...(entity.members ?? [])] : [target];
  const turnOn = (e: HomeEntity): boolean => {
    if (action === "toggle") return entity.group === true ? !entity.on : !e.on;
    if (action === "brightness") return (value ?? 0) > 0;
    return action === "turn_on" || action === "open";
  };
  if (action === "run" || action === "stop" || action === "volume_up" || action === "volume_down" || action === "play_pause") return view;
  if (action === "mute") return entity.kind === "media" ? { ...view, entities: { ...view.entities, [target]: { ...entity, muted: entity.muted !== true } } } : view;
  const entities: Record<string, HomeEntity> = { ...view.entities };
  for (const id of ids) {
    const e = entities[id];
    if (e === undefined || e.sensitive === true) continue;
    const on = turnOn(e);
    const patch: { -readonly [K in keyof HomeEntity]?: HomeEntity[K] } = { on };
    if (e.kind === "light") patch.brightness = action === "brightness" ? Math.max(0, Math.min(100, value ?? 0)) : on ? (e.brightness === 0 || e.brightness === undefined ? null : e.brightness) : 0;
    if (e.kind === "cover" || e.kind === "garage") { patch.state = on ? "open" : "closed"; if (typeof e.position === "number") patch.position = on ? 100 : 0; }
    else patch.state = on ? "on" : "off";
    entities[id] = { ...e, ...patch } as HomeEntity;
  }
  for (const group of Object.values(entities).filter((e) => e.group === true)) {
    const members = (group.members ?? []).map((m) => entities[m]).filter((e): e is HomeEntity => e !== undefined);
    const on = members.filter((m) => m.on).length;
    entities[group.id] = { ...group, on: on > 0, state: `${on}/${members.length}` };
  }
  return { ...view, entities };
}

/** Next brightness one step up or down (kept for callers; the detail no longer dims on swipe). */
export function dimmed(entity: HomeEntity, up: boolean): number {
  const now = entity.on ? (typeof entity.brightness === "number" && entity.brightness > 0 ? entity.brightness : 100) : 0;
  return Math.max(0, Math.min(100, now + (up ? DIM_STEP : -DIM_STEP)));
}

/** "3 Lichter an" for the overview from the view (groups are not counted twice). */
export function viewSummary(view: HomeView, locale: Locale): { lights: string; count: number } {
  const real = Object.values(view.entities).filter((e) => e.group !== true);
  const lights = real.filter((e) => e.kind === "light");
  const on = lights.filter((e) => e.on).length;
  const key = lights.length === 0 ? (real.some((e) => e.on) ? "home.onN" : "home.on0") : on === 0 ? "home.lights0" : on === 1 ? "home.lights1" : "home.lightsN";
  return { lights: tr(messages, locale, key, { n: lights.length === 0 ? real.filter((e) => e.on).length : on }), count: real.length };
}
