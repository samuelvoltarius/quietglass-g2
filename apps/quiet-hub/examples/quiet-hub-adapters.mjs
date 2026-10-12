/**
 * Quiet Hub adapters: Home Assistant and Moonraker (Klipper).
 *
 * Both are dependency-free and take their `fetch` as a parameter so tests can
 * run without a network. Tokens live only inside these closures — nothing here
 * ever returns or logs them.
 */

const round1 = (n) => Math.round(n * 10) / 10;

// ------------------------------------------------------------ Home Assistant

/** "light.office=Büro Licht, switch.plug" → [{entity, label}] */
export function parseDevices(text) {
  return String(text ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const index = part.indexOf("=");
      const entity = (index >= 0 ? part.slice(0, index) : part).trim();
      const label = index >= 0 ? part.slice(index + 1).trim() : "";
      return { entity, label: label || entity };
    })
    .filter((d) => /^[a-z_]+\.[\w-]+$/.test(d.entity));
}

const SWITCHABLE = new Set(["light", "switch", "fan", "input_boolean", "automation", "cover", "climate", "lock", "media_player", "script", "scene"]);
const T = {
  de: { on: "an", off: "aus", open: "offen", closed: "zu", unavailable: "n/v", locked: "zu", unlocked: "offen" },
  en: { on: "on", off: "off", open: "open", closed: "closed", unavailable: "n/a", locked: "locked", unlocked: "open" },
};

/** One HA entity → the DeviceSnapshot the glasses understand. */
export function deviceFromState(spec, entity, lang = "de") {
  const words = T[lang] ?? T.de;
  const domain = spec.entity.split(".")[0];
  if (!entity || entity.state === "unavailable" || entity.state === "unknown") {
    return { id: spec.entity, label: spec.label, kind: "switch", state: words.unavailable, on: false, writable: false };
  }
  const state = String(entity.state);
  if (domain === "climate") {
    const t = entity.attributes?.current_temperature ?? entity.attributes?.temperature;
    return { id: spec.entity, label: spec.label, kind: "climate", state: typeof t === "number" ? `${round1(t)}°`.replace(".", lang === "de" ? "," : ".") : (words[state] ?? state), on: state !== "off", writable: true };
  }
  if (domain === "cover") {
    return { id: spec.entity, label: spec.label, kind: "cover", state: words[state] ?? state, on: state === "open" || state === "opening", writable: true };
  }
  if (domain === "sensor" || domain === "binary_sensor") {
    const unit = entity.attributes?.unit_of_measurement ?? "";
    const n = Number(state);
    const shown = Number.isFinite(n) ? `${round1(n)}${unit}` : (words[state] ?? state);
    return { id: spec.entity, label: spec.label, kind: "switch", state: shown, on: state === "on", writable: false };
  }
  const on = state === "on" || state === "unlocked" || state === "playing";
  return { id: spec.entity, label: spec.label, kind: "switch", state: words[state] ?? state, on, writable: SWITCHABLE.has(domain) };
}

/** Which service flips this entity right now. */
export function serviceFor(entityId, currentlyOn) {
  const domain = entityId.split(".")[0];
  if (domain === "script" || domain === "scene") return [domain, "turn_on"];
  if (domain === "cover") return ["cover", currentlyOn ? "close_cover" : "open_cover"];
  if (domain === "lock") return ["lock", currentlyOn ? "lock" : "unlock"];
  if (domain === "climate" || domain === "media_player") return [domain, currentlyOn ? "turn_off" : "turn_on"];
  return [domain, "toggle"];
}

export function createHomeAssistant({ url, token, devices, fetchImpl = globalThis.fetch, timeoutMs = 8000, lang = "de" }) {
  const base = String(url).replace(/\/+$/, "");
  const specs = Array.isArray(devices) ? devices : parseDevices(devices);
  const byId = new Map(specs.map((s) => [s.entity, s]));
  let snapshot = specs.map((s) => deviceFromState(s, null, lang));
  let lastOk = 0;
  let lastError = null;

  const ha = async (path, init = {}) => {
    const res = await fetchImpl(`${base}${path}`, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });
    if (!res.ok) throw new Error(`Home Assistant HTTP ${res.status}`);
    return res.json();
  };

  async function refresh() {
    try {
      const states = await ha("/api/states");
      const index = new Map(states.map((s) => [s.entity_id, s]));
      snapshot = specs.map((s) => deviceFromState(s, index.get(s.entity), lang));
      lastOk = Date.now();
      lastError = null;
    } catch (error) {
      lastError = String(error?.message ?? error).slice(0, 120);
    }
    return snapshot;
  }

  async function toggle(entityId) {
    const spec = byId.get(entityId);
    if (!spec) return { ok: false, status: 404, error: "device not in HA_DEVICES" };
    const current = snapshot.find((d) => d.id === entityId);
    if (!current || !current.writable) return { ok: false, status: 409, error: "device is read-only or unavailable" };
    const [domain, service] = serviceFor(entityId, current.on);
    try {
      await ha(`/api/services/${domain}/${service}`, { method: "POST", body: JSON.stringify({ entity_id: entityId }) });
    } catch (error) {
      return { ok: false, status: 502, error: String(error?.message ?? error).slice(0, 120) };
    }
    await refresh();
    return { ok: true, status: 200 };
  }

  /** Read-only: the first notify.mobile_app_* service, or null. */
  async function findNotifyService() {
    const list = await ha("/api/services");
    const notify = (Array.isArray(list) ? list : []).find((entry) => entry?.domain === "notify");
    const names = Object.keys(notify?.services ?? {}).filter((name) => name.startsWith("mobile_app_"));
    return names.length > 0 ? `notify.${names[0]}` : null;
  }

  async function notify(service, title, message) {
    const [domain, name] = String(service).split(".");
    if (domain !== "notify" || !name) return false;
    await ha(`/api/services/notify/${name}`, { method: "POST", body: JSON.stringify({ title: String(title).slice(0, 80), message: String(message).slice(0, 240) }) });
    return true;
  }

  return { refresh, toggle, findNotifyService, notify, devices: () => snapshot, status: () => ({ lastOk, lastError }) };
}

// ----------------------------------------------------------------- Moonraker

export const MOONRAKER_QUERY = "/printer/objects/query?print_stats&display_status&heater_bed&extruder&virtual_sdcard";
const PRINT_PATHS = { pause: "/printer/print/pause", resume: "/printer/print/resume", cancel: "/printer/print/cancel" };
const rnd = (n) => (typeof n === "number" && Number.isFinite(n) ? Math.round(n) : 0);

/** Moonraker status → PrinterSnapshot. */
export function shapePrinter(raw) {
  const s = raw?.result?.status ?? {};
  const ps = s.print_stats ?? {};
  const progressRaw = s.display_status?.progress ?? s.virtual_sdcard?.progress ?? 0;
  const progress = Math.max(0, Math.min(100, Math.round(progressRaw * 100)));
  const printed = ps.print_duration ?? 0;
  const etaMin = progress > 1 && progress < 100 ? Math.max(0, Math.round((printed / (progress / 100) - printed) / 60)) : null;
  const raw_state = ps.state ?? "standby";
  const state = raw_state === "printing" ? "printing" : raw_state === "paused" ? "paused" : raw_state === "error" ? "error" : "ready";
  const active = state === "printing" || state === "paused";
  const file = typeof ps.filename === "string" && ps.filename !== "" ? ps.filename : null;
  return {
    job: active ? (file ?? "?") : null,
    state,
    layer: rnd(ps.info?.current_layer),
    layers: rnd(ps.info?.total_layer),
    progress,
    etaMin: active ? etaMin : null,
    nozzleC: rnd(s.extruder?.temperature),
    bedC: rnd(s.heater_bed?.temperature),
    selected: 0,
  };
}

export function createMoonraker({ url, fetchImpl = globalThis.fetch, timeoutMs = 5000 }) {
  const base = String(url).replace(/\/+$/, "");
  let snapshot = { job: null, state: "error", layer: 0, layers: 0, progress: 0, etaMin: null, nozzleC: 0, bedC: 0, selected: 0, offline: true };

  async function moon(path, init = {}) {
    const res = await fetchImpl(`${base}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`Moonraker HTTP ${res.status}`);
    return res.json();
  }

  async function refresh() {
    try {
      snapshot = shapePrinter(await moon(MOONRAKER_QUERY));
    } catch {
      snapshot = { ...snapshot, job: null, state: "error", offline: true };
    }
    return snapshot;
  }

  async function control(action) {
    if (!Object.hasOwn(PRINT_PATHS, action)) return { ok: false, status: 400, error: "unknown action" };
    try {
      await moon(PRINT_PATHS[action], { method: "POST" });
    } catch (error) {
      return { ok: false, status: 502, error: String(error?.message ?? error).slice(0, 120) };
    }
    await refresh();
    return { ok: true, status: 200 };
  }

  return { refresh, control, printer: () => snapshot };
}
