/**
 * Quiet Hub "Zuhause": a small, curated view of Home Assistant for the glasses.
 *
 * The daemon is the only one that talks to Home Assistant; the URL and the
 * long-lived token live inside `createHomeView` and are never returned, logged
 * or put into a report. The glasses get favourites, areas with their lights,
 * switches and covers, one group per area ("Alle Lichter", "Alle Rollos"),
 * read-only sensors (temperature, humidity, motion, battery) and scenes.
 *
 * Locks, alarm panels and garage doors/gates are hidden unless HA_SENSITIVE
 * names them; then every action on them is two-step: the first request only
 * returns a short-lived single-use token, the second request (`confirm`)
 * executes it.
 *
 * Only actions that fit an entity's kind are accepted, and only on entities in
 * the current view - the glasses can never call an arbitrary HA service.
 *
 * TV / projector (media_player, kind "media"): on/off, play/pause, mute and volume steps. When HA has a
 * `remote.<same object id>` (Android TV Remote), a volume step is ONE remote key press (VOLUME_UP/DOWN);
 * `media_player.volume_up` may jump 10 % on some TVs (TV Glance 0.2.2).
 *
 * Env: HA_MEDIA (media_player[=label], comma list; shown first), HA_FAVORITES (entity_id[=label], comma list; falls back to HA_DEVICES),
 * HA_AREAS (auto | off | comma list of area names/ids, in order),
 * HA_EXCLUDE (entity ids to hide), HA_SENSITIVE (lock,alarm,garage),
 * HA_POLL_MS (default 5000), HA_HOME=off disables the view.
 */
import { randomUUID } from "node:crypto";
import { parseDevices } from "./quiet-hub-adapters.mjs";

export const SENSITIVE_KINDS = ["lock", "alarm", "garage"];
export const CONFIRM_TTL_MS = 30_000;
const AREA_REFRESH_MS = 5 * 60_000;
const MAX_AREAS = 16;
const MAX_PER_AREA = 14;
const MAX_FAVORITES = 12;
const SENSOR_CLASSES = new Set(["temperature", "humidity", "battery"]);
const MOTION_CLASSES = new Set(["motion", "occupancy", "presence"]);
const GARAGE_CLASSES = new Set(["garage", "gate"]);
const KIND_ORDER = ["media", "light", "switch", "cover", "garage", "lock", "alarm", "scene", "sensor", "motion"];

/** All areas with their entities in one template call (HA has no REST area registry). */
export const AREA_TEMPLATE = '{% set ns = namespace(a=[]) %}{% for id in areas() %}{% set ns.a = ns.a + [{"id": id, "name": area_name(id), "entities": area_entities(id)}] %}{% endfor %}{{ ns.a | tojson }}';

/** States in which a TV / projector counts as off. */
const MEDIA_OFF = new Set(["off", "standby", "unavailable", "unknown"]);
/** Actions a media entity accepts (besides toggle / turn_on / turn_off). */
export const MEDIA_ACTIONS = ["volume_up", "volume_down", "mute", "play_pause"];

const list = (text) => String(text ?? "").split(",").map((part) => part.trim()).filter(Boolean);

/** Daemon config from env (or options). Nothing here is secret. */
export function parseHomeConfig(env = {}) {
  const plain = parseDevices(env.HA_FAVORITES ?? "").length > 0 ? parseDevices(env.HA_FAVORITES) : parseDevices(env.HA_DEVICES ?? "");
  const media = parseDevices(env.HA_MEDIA ?? "").filter((spec) => spec.entity.startsWith("media_player."));
  const favorites = [...media, ...plain.filter((spec) => !media.some((m) => m.entity === spec.entity))];
  const areasRaw = String(env.HA_AREAS ?? "auto").trim();
  const areas = areasRaw === "" || areasRaw.toLowerCase() === "auto" ? "auto" : areasRaw.toLowerCase() === "off" ? "off" : list(areasRaw);
  const sensitive = new Set(list(env.HA_SENSITIVE).map((k) => k.toLowerCase()).filter((k) => SENSITIVE_KINDS.includes(k)));
  const pollMs = Math.max(2000, Number(env.HA_POLL_MS ?? 5000) || 5000);
  return { favorites: favorites.slice(0, MAX_FAVORITES), areas, exclude: new Set(list(env.HA_EXCLUDE)), sensitive, pollMs, media: new Set(media.map((spec) => spec.entity)) };
}

/** Which Quiet Hub kind an HA entity is, or null when it is not shown at all. */
export function kindOf(state) {
  const id = String(state?.entity_id ?? "");
  const domain = id.split(".")[0];
  const deviceClass = String(state?.attributes?.device_class ?? "");
  switch (domain) {
    case "light": return "light";
    case "media_player": return "media";
    case "switch":
    case "input_boolean":
    case "fan": return "switch";
    case "cover": return GARAGE_CLASSES.has(deviceClass) ? "garage" : "cover";
    case "scene":
    case "script": return "scene";
    case "lock": return "lock";
    case "alarm_control_panel": return "alarm";
    case "sensor": return SENSOR_CLASSES.has(deviceClass) ? "sensor" : null;
    case "binary_sensor": return MOTION_CLASSES.has(deviceClass) ? "motion" : null;
    default: return null;
  }
}

const round1 = (n) => Math.round(n * 10) / 10;
const pct = (n) => Math.max(0, Math.min(100, Math.round(n)));

/** One HA state -> the HomeEntity the glasses understand (no localized words: the glasses translate). */
export function entityFromState(state, label = "", lang = "de") {
  const kind = kindOf(state);
  if (kind === null) return null;
  const id = String(state.entity_id);
  const raw = String(state.state ?? "unknown");
  const attrs = state.attributes ?? {};
  const available = raw !== "unavailable" && raw !== "unknown";
  const name = String(label || attrs.friendly_name || id).slice(0, 40);
  const entity = { id, name, kind, state: raw, on: false, available };
  if (kind === "light") {
    entity.on = raw === "on";
    entity.brightness = entity.on && typeof attrs.brightness === "number" ? pct(attrs.brightness / 255 * 100) : entity.on ? null : 0;
  } else if (kind === "media") {
    entity.on = !MEDIA_OFF.has(raw);
    entity.volume = typeof attrs.volume_level === "number" ? pct(attrs.volume_level * 100) : null;
    entity.muted = attrs.is_volume_muted === true;
    const what = String(attrs.app_name ?? attrs.source ?? attrs.media_title ?? "").trim();
    if (entity.on && what !== "") entity.value = what.slice(0, 24);
  } else if (kind === "switch" || kind === "motion") {
    entity.on = raw === "on";
  } else if (kind === "cover" || kind === "garage") {
    entity.on = raw === "open" || raw === "opening";
    if (typeof attrs.current_position === "number") entity.position = pct(attrs.current_position);
  } else if (kind === "lock") {
    entity.on = raw === "unlocked" || raw === "open" || raw === "opening";
  } else if (kind === "alarm") {
    entity.on = raw.startsWith("armed") || raw === "triggered";
  } else if (kind === "sensor") {
    entity.sensorClass = String(attrs.device_class);
    const n = Number(raw);
    const unit = String(attrs.unit_of_measurement ?? "");
    entity.value = Number.isFinite(n) && available ? `${String(round1(n)).replace(".", lang === "de" ? "," : ".")}${unit === "%" ? " %" : unit ? ` ${unit}` : ""}` : "";
  }
  if (SENSITIVE_KINDS.includes(kind)) entity.sensitive = true;
  return entity;
}

const byKind = (entities) => (a, b) => KIND_ORDER.indexOf(entities[a].kind) - KIND_ORDER.indexOf(entities[b].kind) || entities[a].name.localeCompare(entities[b].name);

/** A virtual group entity ("Alle Lichter" / "Alle Rollos") over the members of one area. */
function groupEntity(areaId, kind, members, entities) {
  const live = members.map((id) => entities[id]).filter((e) => e.available);
  const on = live.filter((e) => e.on).length;
  return {
    id: `group:${areaId}:${kind}`, name: kind === "light" ? "*lights" : "*covers", kind, state: `${on}/${members.length}`,
    on: on > 0, available: live.length > 0, members: [...members], group: true,
  };
}

/**
 * Pure: HA states (+ the area template answer) -> the HomeView of the report.
 * Favourites first in their configured order, then the areas.
 */
export function buildHomeView({ states, areas = [], config, lang = "de", error = null }) {
  const index = new Map((Array.isArray(states) ? states : []).map((s) => [s.entity_id, s]));
  const entities = {};
  const shown = (kind) => kind !== null && (!SENSITIVE_KINDS.includes(kind) || config.sensitive.has(kind));
  const add = (id, label = "") => {
    if (entities[id]) return true;
    if (config.exclude.has(id)) return false;
    const state = index.get(id);
    if (!state) return false;
    const entity = entityFromState(state, label, lang);
    if (entity === null || !shown(entity.kind)) return false;
    // A TV / projector only when HA_MEDIA names it (an area's every speaker would crowd the page).
    if (entity.kind === "media" && !(config.media ?? new Set()).has(id)) return false;
    // TV / projector: the matching remote.* carries the single-step volume keys.
    if (entity.kind === "media" && index.has(`remote.${id.slice("media_player.".length)}`)) entity.remote = `remote.${id.slice("media_player.".length)}`;
    entities[id] = entity;
    return true;
  };
  const favorites = config.favorites.filter((spec) => add(spec.entity, spec.label === spec.entity ? "" : spec.label)).map((spec) => spec.entity);

  const outAreas = [];
  if (config.areas !== "off") {
    let chosen = Array.isArray(areas) ? areas.filter((a) => a && typeof a.id === "string") : [];
    if (Array.isArray(config.areas)) {
      const wanted = config.areas.map((w) => w.toLowerCase());
      chosen = wanted.map((w) => chosen.find((a) => a.id.toLowerCase() === w || String(a.name ?? "").toLowerCase() === w)).filter(Boolean);
    }
    for (const area of chosen.slice(0, MAX_AREAS)) {
      const ids = (Array.isArray(area.entities) ? area.entities : []).filter((id) => typeof id === "string" && add(id));
      if (ids.length === 0) continue;
      ids.sort(byKind(entities));
      const groups = [];
      for (const kind of ["light", "cover"]) {
        const members = ids.filter((id) => entities[id].kind === kind);
        if (members.length >= 2) {
          const group = groupEntity(area.id, kind, members, entities);
          entities[group.id] = group;
          groups.push(group.id);
        }
      }
      outAreas.push({ id: area.id, name: String(area.name ?? area.id).slice(0, 40), entities: [...groups, ...ids].slice(0, MAX_PER_AREA) });
    }
  }
  return { favorites, areas: outAreas, entities, sensitive: config.sensitive.size > 0, error };
}

/** HA service call(s) for one action on one entity; null = not allowed for that kind. */
export function serviceCall(entity, action, value, entities = {}) {
  const id = entity.id;
  const domain = id.split(".")[0];
  if (entity.group === true) {
    const members = entity.members.filter((m) => entities[m] && !entities[m].sensitive);
    if (members.length === 0) return null;
    if (entity.kind === "light") {
      const turnOn = action === "turn_on" || (action === "toggle" && !entity.on);
      if (action !== "toggle" && action !== "turn_on" && action !== "turn_off") return null;
      return { domain: "light", service: turnOn ? "turn_on" : "turn_off", data: { entity_id: members } };
    }
    const service = { open: "open_cover", close: "close_cover", stop: "stop_cover", toggle: entity.on ? "close_cover" : "open_cover" }[action];
    return service ? { domain: "cover", service, data: { entity_id: members } } : null;
  }
  switch (entity.kind) {
    case "media":
      if (action === "toggle" || action === "turn_on" || action === "turn_off") {
        const service = action === "toggle" ? (entity.on ? "turn_off" : "turn_on") : action;
        return { domain: "media_player", service, data: { entity_id: id } };
      }
      if (action === "volume_up" || action === "volume_down") {
        return entity.remote
          ? { domain: "remote", service: "send_command", data: { entity_id: entity.remote, command: action === "volume_up" ? "VOLUME_UP" : "VOLUME_DOWN" } }
          : { domain: "media_player", service: action, data: { entity_id: id } };
      }
      if (action === "mute") return { domain: "media_player", service: "volume_mute", data: { entity_id: id, is_volume_muted: entity.muted !== true } };
      if (action === "play_pause") return { domain: "media_player", service: "media_play_pause", data: { entity_id: id } };
      return null;
    case "light":
      if (action === "brightness") {
        const n = Number(value);
        if (!Number.isFinite(n)) return null;
        return n <= 0 ? { domain: "light", service: "turn_off", data: { entity_id: id } } : { domain: "light", service: "turn_on", data: { entity_id: id, brightness_pct: pct(n) } };
      }
      // falls through to the on/off actions
    case "switch":
      if (action === "toggle" || action === "turn_on" || action === "turn_off") return { domain, service: action, data: { entity_id: id } };
      return null;
    case "cover":
    case "garage": {
      const service = { open: "open_cover", close: "close_cover", stop: "stop_cover", toggle: entity.on ? "close_cover" : "open_cover" }[action];
      return service ? { domain: "cover", service, data: { entity_id: id } } : null;
    }
    case "scene":
      return action === "run" || action === "toggle" || action === "turn_on" ? { domain, service: "turn_on", data: { entity_id: id } } : null;
    case "lock": {
      const service = { lock: "lock", unlock: "unlock", toggle: entity.on ? "lock" : "unlock" }[action];
      return service ? { domain: "lock", service, data: { entity_id: id } } : null;
    }
    case "alarm": {
      const service = { arm: "alarm_arm_away", disarm: "alarm_disarm", toggle: entity.on ? "alarm_disarm" : "alarm_arm_away" }[action];
      return service ? { domain: "alarm_control_panel", service, data: { entity_id: id } } : null;
    }
    default:
      return null;
  }
}

/** What the action does, in words, for the confirm line ("Haustür: aufsperren"). */
function confirmLabel(entity, call, lang) {
  const words = {
    de: { unlock: "aufsperren", lock: "zusperren", alarm_disarm: "Alarm aus", alarm_arm_away: "Alarm scharf", open_cover: "öffnen", close_cover: "schließen", stop_cover: "stoppen" },
    en: { unlock: "unlock", lock: "lock", alarm_disarm: "disarm", alarm_arm_away: "arm", open_cover: "open", close_cover: "close", stop_cover: "stop" },
  }[lang] ?? {};
  return `${entity.name}: ${words[call.service] ?? call.service}`.slice(0, 48);
}

/** Optimistic local state after an accepted call, until the next poll says otherwise. */
function applyLocally(view, entity, call) {
  const ids = Array.isArray(call.data.entity_id) ? call.data.entity_id : [call.data.entity_id];
  for (const id of ids) {
    const e = view.entities[id];
    if (!e) continue;
    if (call.service === "turn_on") { e.on = true; if (typeof call.data.brightness_pct === "number") e.brightness = call.data.brightness_pct; }
    else if (call.service === "turn_off") { e.on = false; if (e.kind === "light") e.brightness = 0; }
    else if (call.service === "toggle") e.on = !e.on;
    else if (call.service === "open_cover") e.on = true;
    else if (call.service === "close_cover") e.on = false;
    else if (call.service === "unlock") e.on = true;
    else if (call.service === "lock") e.on = false;
    else if (call.service === "alarm_arm_away") e.on = true;
    else if (call.service === "alarm_disarm") e.on = false;
    else if (call.service === "volume_mute") e.muted = call.data.is_volume_muted === true;
  }
  for (const group of Object.values(view.entities).filter((e) => e.group === true)) {
    const members = group.members.map((m) => view.entities[m]).filter(Boolean);
    const on = members.filter((m) => m.on).length;
    group.on = on > 0;
    group.state = `${on}/${members.length}`;
  }
  void entity;
}

export function createHomeView({ url, token, config, fetchImpl = globalThis.fetch, timeoutMs = 8000, lang = "de", now = () => Date.now(), log = () => undefined }) {
  const base = String(url).replace(/\/+$/, "");
  let view = { favorites: [], areas: [], entities: {}, sensitive: config.sensitive.size > 0, error: null };
  let areas = [];
  let areasAt = -Infinity;
  let lastOk = 0;
  const pending = new Map();

  const call = async (path, init = {}, as = "json") => {
    const res = await fetchImpl(`${base}${path}`, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });
    if (!res.ok) throw new Error(`Home Assistant HTTP ${res.status}`);
    return as === "text" ? res.text() : res.json();
  };

  async function loadAreas() {
    if (config.areas === "off" || now() - areasAt < AREA_REFRESH_MS) return;
    try {
      const text = await call("/api/template", { method: "POST", body: JSON.stringify({ template: AREA_TEMPLATE }) }, "text");
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) areas = parsed;
      areasAt = now();
    } catch (error) {
      // Areas are optional (older HA, template blocked): favourites still work. Retry later.
      areasAt = now() - AREA_REFRESH_MS + 60_000;
      log("home: areas unavailable:", String(error?.message ?? error).slice(0, 100));
    }
  }

  async function refresh() {
    try {
      await loadAreas();
      const states = await call("/api/states");
      view = buildHomeView({ states, areas, config, lang });
      lastOk = now();
    } catch (error) {
      view = { ...view, error: String(error?.message ?? error).slice(0, 120) };
    }
    return view;
  }

  async function execute(entity, call_) {
    try {
      await call(`/api/services/${call_.domain}/${call_.service}`, { method: "POST", body: JSON.stringify(call_.data) });
    } catch (error) {
      return { ok: false, status: 502, error: String(error?.message ?? error).slice(0, 120) };
    }
    applyLocally(view, entity, call_);
    // HA needs a moment to report the new state; the next poll corrects the optimistic one.
    return { ok: true, status: 200 };
  }

  function sweep() {
    for (const [key, entry] of pending) if (entry.expiresAt <= now()) pending.delete(key);
  }

  /** One action from the glasses. Sensitive kinds answer 202 with a confirm token instead of acting. */
  async function action(target, act, value) {
    sweep();
    const entity = view.entities[String(target ?? "")];
    if (!entity) return { ok: false, status: 404, error: "not in the home view" };
    if (!entity.available && entity.group !== true) return { ok: false, status: 409, error: "unavailable" };
    const svc = serviceCall(entity, String(act ?? ""), value, view.entities);
    if (svc === null) return { ok: false, status: 400, error: "action not allowed for this entity" };
    if (entity.sensitive === true) {
      const tokenId = randomUUID();
      const expiresAt = now() + CONFIRM_TTL_MS;
      pending.set(tokenId, { target: entity.id, call: svc, expiresAt });
      return { ok: true, status: 202, confirm: { token: tokenId, label: confirmLabel(entity, svc, lang), expiresInMs: CONFIRM_TTL_MS } };
    }
    return execute(entity, svc);
  }

  /** Second step of a sensitive action: the token is single-use and expires after 30 s. */
  async function confirm(tokenId) {
    sweep();
    const entry = pending.get(String(tokenId ?? ""));
    if (!entry) return { ok: false, status: 410, error: "confirm token unknown or expired" };
    pending.delete(String(tokenId));
    const entity = view.entities[entry.target];
    if (!entity) return { ok: false, status: 404, error: "not in the home view" };
    return execute(entity, entry.call);
  }

  return { refresh, action, confirm, view: () => view, status: () => ({ lastOk, error: view.error }), pendingCount: () => pending.size };
}
