import { ApiError, DEFAULT_TIMEOUT_MS, MAX_THUMBNAIL_BYTES, toApiError, type PrinterApi } from "./client";
import { parseStatus, type Command } from "./status";

/**
 * Direct mode (0.6.0): the phone talks to Moonraker itself, no bridge. Works
 * where the phone can reach the printer (same Wi-Fi, or a VPN into it) and
 * Moonraker lets the app's origin in (`cors_domains` in moonraker.conf). It
 * does what examples/klipper-bridge.mjs does - status, slicer preview, layer
 * model - so the rest of the app cannot tell the two apart.
 */

export interface MoonrakerOptions {
  /** e.g. http://192.168.1.50:7125 */
  readonly baseUrl: string;
  /** Moonraker API key (sent as X-Api-Key); not needed for trusted clients. */
  readonly apiKey?: string;
  /** Pause / resume / cancel from the glasses; off unless switched on on the phone. */
  readonly allowControl?: boolean;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

const QUERY = "/printer/objects/query?print_stats&display_status&heater_bed&extruder&virtual_sdcard&gcode_move";
const PATHS: Record<Command, string> = { pause: "/printer/print/pause", resume: "/printer/print/resume", cancel: "/printer/print/cancel" };

const round = (n: unknown): number | null => (typeof n === "number" && Number.isFinite(n) ? Math.round(n) : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? v as Record<string, unknown> : {});

/** Moonraker's object query in the bridge's compact shape. */
export function shapeStatus(raw: unknown, controllable: boolean): Record<string, unknown> {
  const s = obj(obj(obj(raw)["result"])["status"]);
  const ps = obj(s["print_stats"]);
  const display = obj(s["display_status"]);
  const sd = obj(s["virtual_sdcard"]);
  const gm = obj(s["gcode_move"]);
  const progressRaw = typeof display["progress"] === "number" ? display["progress"] : typeof sd["progress"] === "number" ? sd["progress"] : 0;
  const progress = Math.max(0, Math.min(100, Math.round(Number(progressRaw) * 100)));
  const printed = typeof ps["print_duration"] === "number" ? ps["print_duration"] : 0;
  // Klipper reports no remaining time itself; extrapolate from progress.
  const minutesLeft = progress > 1 ? Math.max(0, Math.round((printed / (progress / 100) - printed) / 60)) : null;
  const info = obj(ps["info"]);
  const heater = (h: unknown): { now: number | null; target: number } | null => {
    if (!h || typeof h !== "object") return null;
    const o = obj(h);
    return { now: round(o["temperature"]), target: round(o["target"]) ?? 0 };
  };
  const position = Array.isArray(gm["gcode_position"]) ? gm["gcode_position"] as unknown[] : [];
  return {
    online: true,
    state: typeof ps["state"] === "string" ? ps["state"] : "unknown",
    file: typeof ps["filename"] === "string" ? ps["filename"] : "",
    progress,
    layer: round(info["current_layer"]),
    layers: round(info["total_layer"]),
    minutesLeft,
    nozzle: heater(s["extruder"]),
    bed: heater(s["heater_bed"]),
    speed: round((typeof gm["speed_factor"] === "number" ? gm["speed_factor"] : 1) * 100) ?? 100,
    z: typeof position[2] === "number" ? Math.round(position[2] * 100) / 100 : null,
    message: typeof ps["message"] === "string" ? ps["message"] : "",
    controllable,
  };
}

function validFile(name: string): boolean {
  return name.length > 0 && name.length <= 255 && !name.split("/").includes("..") && !name.startsWith("/");
}

const encodePath = (file: string): string => file.split("/").map(encodeURIComponent).join("/");

/** Same layer model as the bridge (see examples/klipper-bridge.mjs gcodeLayers). */
const SEG_BUDGET = 40_000;
const MIN_SEG_MM = 0.6;
const WORD: Record<string, RegExp> = {};
for (const letter of ["X", "Y", "Z", "E"]) WORD[letter] = new RegExp("(?:^|\\s)" + letter + "(-?\\d*\\.?\\d+)", "i");
const word = (line: string, letter: string): number | null => {
  const m = line.match(WORD[letter]!);
  return m ? Number(m[1]) : null;
};

export function gcodeLayers(): { line(raw: string): void; done(): Record<string, unknown> } {
  let absXYZ = true, absE = true;
  let x = 0, y = 0, z = 0, e = 0;
  const layers: { z: number; segs: number[] }[] = [];
  let layer: { z: number; segs: number[] } | null = null;
  let px: number | null = null, py: number | null = null;
  return {
    line(raw) {
      const line = raw.split(";")[0]!.trim();
      if (!line) return;
      const cmd = line.split(/\s+/)[0]!.toUpperCase();
      if (cmd === "G90") { absXYZ = true; return; }
      if (cmd === "G91") { absXYZ = false; return; }
      if (cmd === "M82") { absE = true; return; }
      if (cmd === "M83") { absE = false; return; }
      if (cmd === "G92") { const ne = word(line, "E"); if (ne !== null) e = ne; return; }
      if (!/^G0?[0-3]$/.test(cmd)) return;
      const nx = word(line, "X"), ny = word(line, "Y"), nz = word(line, "Z"), ne = word(line, "E");
      const tx = nx === null ? x : absXYZ ? nx : x + nx;
      const ty = ny === null ? y : absXYZ ? ny : y + ny;
      const tz = nz === null ? z : absXYZ ? nz : z + nz;
      let extrudes = false;
      if (ne !== null) {
        const te = absE ? ne : e + ne;
        extrudes = te - e > 1e-5;
        e = te;
      }
      if (extrudes && (tx !== x || ty !== y)) {
        if (!layer || tz > layer.z + 0.01) { layer = { z: tz, segs: [] }; layers.push(layer); px = null; }
        if (px === null) { px = x; py = y; }
        if (Math.hypot(tx - px, ty - (py as number)) >= MIN_SEG_MM) { layer.segs.push(px, py as number, tx, ty); px = tx; py = ty; }
      } else {
        px = null;
      }
      x = tx; y = ty; z = tz;
    },
    done() {
      const total = layers.reduce((n, l) => n + l.segs.length / 4, 0);
      const every = Math.max(1, Math.ceil(total / SEG_BUDGET));
      const kept = layers.filter((_, i) => i % every === 0 || i === layers.length - 1);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const l of kept) {
        for (let i = 0; i < l.segs.length; i += 2) {
          x0 = Math.min(x0, l.segs[i]!); x1 = Math.max(x1, l.segs[i]!);
          y0 = Math.min(y0, l.segs[i + 1]!); y1 = Math.max(y1, l.segs[i + 1]!);
        }
      }
      const count = kept.reduce((n, l) => n + l.segs.length, 0);
      const ints = new Int16Array(count);
      const start: number[] = [];
      let k = 0;
      for (const l of kept) {
        start.push(k / 4);
        for (const v of l.segs) ints[k++] = Math.max(-32768, Math.min(32767, Math.round(v * 10)));
      }
      const r = (n: number): number => Math.round(n * 100) / 100;
      return {
        bounds: kept.length ? [r(x0), r(y0), r(kept[0]!.z), r(x1), r(y1), r(kept[kept.length - 1]!.z)] : [0, 0, 0, 0, 0, 0],
        z: kept.map((l) => r(l.z)),
        start,
        segs: toBase64(new Uint8Array(ints.buffer, ints.byteOffset, ints.byteLength)),
        layersTotal: layers.length,
      };
    },
  };
}

function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

export function createMoonrakerClient(options: MoonrakerOptions): PrinterApi {
  const base = options.baseUrl.trim().replace(/\/+$/, "");
  const doFetch = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const controllable = options.allowControl === true;
  // A custom header makes every request a CORS preflight; without a key the GETs stay "simple".
  const headers = (accept: string): Record<string, string> => ({ Accept: accept, ...(options.apiKey ? { "X-Api-Key": options.apiKey } : {}) });

  const timed = async (path: string, init: RequestInit, ms: number): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      return await doFetch(base + path, { ...init, cache: "no-store", signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };

  const json = async (path: string, init: RequestInit = {}): Promise<unknown> => {
    try {
      const response = await timed(path, { ...init, headers: { ...headers("application/json"), ...(init.headers as Record<string, string> | undefined) } }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      if (response.status === 401 || response.status === 403) throw new ApiError("auth", response.status);
      if (!response.ok) throw new ApiError("http", response.status);
      try {
        return await response.json();
      } catch {
        throw new ApiError("bad-reply", response.status);
      }
    } catch (error) {
      throw toApiError(error);
    }
  };

  let thumbCache: { file: string; png: Uint8Array | null } = { file: "", png: null };
  let model: { file: string; status: "preparing" | "ready" | "failed"; value: unknown; at: number } | null = null;

  const buildModel = async (file: string): Promise<unknown> => {
    const response = await timed("/server/files/gcodes/" + encodePath(file), { headers: headers("text/plain") }, 300_000);
    if (!response.ok || !response.body) throw new Error("gcode " + response.status);
    const parser = gcodeLayers();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let rest = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const lines = (rest + decoder.decode(value, { stream: true })).split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) parser.line(line);
    }
    if (rest) parser.line(rest);
    return { file, ...parser.done() };
  };

  return {
    demo: false,
    status: async () => parseStatus(shapeStatus(await json(QUERY), controllable)),
    command: async (command) => {
      if (!controllable) throw new ApiError("refused", 403, "control-off");
      await json(PATHS[command], { method: "POST" });
    },
    thumbnail: async (file) => {
      if (!validFile(file)) return null;
      if (thumbCache.file === file) return thumbCache.png;
      try {
        const meta = obj(obj(await json("/server/files/metadata?filename=" + encodeURIComponent(file)))["result"]);
        const list = Array.isArray(meta["thumbnails"]) ? meta["thumbnails"].map(obj) : [];
        const usable = list.filter((t) => typeof t["relative_path"] === "string" && (t["relative_path"] as string).toLowerCase().endsWith(".png") && Number(t["width"]) > 0);
        const fitting = usable.filter((t) => Number(t["width"]) <= 400);
        const pick = (fitting.length ? fitting : usable).sort((a, b) => Number(b["width"]) - Number(a["width"]))[0];
        let png: Uint8Array | null = null;
        if (pick) {
          const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/") + 1) : "";
          const response = await timed("/server/files/gcodes/" + encodePath(dir + (pick["relative_path"] as string)), { headers: headers("image/png") }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
          if (response.ok) {
            const bytes = new Uint8Array(await response.arrayBuffer());
            if (bytes.length > 8 && bytes.length <= MAX_THUMBNAIL_BYTES && bytes[0] === 0x89 && bytes[1] === 0x50) png = bytes;
          }
        }
        thumbCache = { file, png };
        return png;
      } catch {
        return null;   // busy or away: ask again next time
      }
    },
    layers: async (file) => {
      if (!validFile(file)) return null;
      if (model?.file === file) {
        if (model.status === "ready") return model.value;
        if (model.status === "preparing") return "preparing";
        if (Date.now() - model.at < 60_000) return null;   // a failed attempt is retried after a minute
      }
      const started = { file, status: "preparing" as const, value: null, at: Date.now() };
      model = started;
      buildModel(file).then(
        (value) => { if (model === started) model = { file, status: "ready", value, at: Date.now() }; },
        () => { if (model === started) model = { file, status: "failed", value: null, at: Date.now() }; },
      );
      return "preparing";
    },
  };
}

/**
 * Which kind of address the user entered: Moonraker answers /printer/info with
 * a `result`, the bridge answers /api/printer/info with `found`. Port 7125 is
 * Moonraker's default, so it is tried first there.
 */
export async function detectKind(baseUrl: string, fetchImpl: typeof fetch = fetch, timeoutMs = 4_000): Promise<"moonraker" | "bridge" | null> {
  const base = baseUrl.trim().replace(/\/+$/, "");
  const probe = async (path: string, key: string): Promise<boolean> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(base + path, { cache: "no-store", signal: controller.signal });
      if (!response.ok) return false;
      return key in obj(await response.json());
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  };
  const order: ["moonraker" | "bridge", string, string][] = [["moonraker", "/printer/info", "result"], ["bridge", "/api/printer/info", "found"]];
  if (!/:7125$/.test(base)) order.reverse();
  for (const [kind, path, key] of order) if (await probe(path, key)) return kind;
  return null;
}

/** Moonraker's default port (7125), or an address the user marked as Moonraker with a `/moonraker` path. */
export function isMoonrakerUrl(url: string): boolean {
  try {
    const parsed = new URL(url.trim());
    return parsed.port === "7125" || /\/moonraker\/?$/.test(parsed.pathname);
  } catch {
    return false;
  }
}

/**
 * What the user typed, as a usable base URL: a bare IP or host name becomes
 * Moonraker on its default port (`192.168.1.50` -> `http://192.168.1.50:7125`).
 * Anything with a scheme is taken as it is (a bridge, or Moonraker elsewhere).
 */
export function normalizeAddress(input: string): string {
  const value = input.trim().replace(/\/+$/, "");
  if (!value) return "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
  return /:\d+$/.test(value) ? "http://" + value : "http://" + value + ":7125";
}

/** The home networks a phone is usually on; the printer is searched there. */
export const SEARCH_NETS = ["192.168.0", "192.168.1", "192.168.178", "192.168.2", "10.0.0"] as const;

/**
 * Looks for Moonraker on the usual home networks (port 7125), 32 addresses at
 * a time, and returns the first that answers - or null. `onProgress` gets the
 * network being searched.
 */
export async function findPrinter(
  fetchImpl: typeof fetch = fetch,
  nets: readonly string[] = SEARCH_NETS,
  onProgress?: (net: string) => void,
  timeoutMs = 900,
): Promise<string | null> {
  const ping = async (base: string): Promise<boolean> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(base + "/printer/info", { cache: "no-store", signal: controller.signal });
      return response.ok && "result" in obj(await response.json());
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  };
  for (const net of nets) {
    onProgress?.(net);
    const hosts = Array.from({ length: 254 }, (_, i) => `http://${net}.${i + 1}:7125`);
    for (let i = 0; i < hosts.length; i += 32) {
      const batch = hosts.slice(i, i + 32);
      const hits = await Promise.all(batch.map(async (host) => ((await ping(host)) ? host : "")));
      const found = hits.find(Boolean);
      if (found) return found;
    }
  }
  return null;
}
