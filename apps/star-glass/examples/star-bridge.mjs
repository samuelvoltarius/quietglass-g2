#!/usr/bin/env node
/**
 * Star Glass bridge: reads N.I.N.A. through the "Advanced API" plugin on the
 * imaging computer and serves one compact status for the glasses, plus a small
 * grayscale preview of the newest frame.
 *
 * Why a bridge: the Advanced API listens on the imaging PC only and answers
 * with large, verbose JSON (and full-size images). The bridge asks it every
 * couple of seconds, keeps short histories (HFR, camera temperature, guiding
 * RMS) and hands the phone a few hundred bytes. Reach it over HTTPS, e.g. with
 * `tailscale serve`.
 *
 *   node star-bridge.mjs                                   # http://127.0.0.1:8893/api/star
 *   STAR_NINA=http://127.0.0.1:1888 node star-bridge.mjs
 *   STAR_TAILSCALE_USERS=you@example.com node star-bridge.mjs
 *
 * Environment
 *   PORT                  port (default 8893)
 *   HOST                  address to bind (default 127.0.0.1 — this machine only)
 *   TOKEN                 bearer token accepted on every /api request
 *   STAR_TAILSCALE_USERS  Tailscale logins (comma list) that need no token when
 *                         `tailscale serve` proxies the request (loopback only)
 *   STAR_NINA             Advanced API base (default http://127.0.0.1:1888)
 *   STAR_POLL_MS          how often N.I.N.A. is asked (default 2000)
 *   STAR_PREVIEW=0        no preview image
 *   STAR_WS=0             do not listen to the Advanced API websocket
 *   STAR_ALLOW_CONTROL=1  allow stopping / starting the sequence. Refused anyway
 *                         unless a TOKEN or STAR_TAILSCALE_USERS is set.
 *   STAR_SITE=1           share the observing site from N.I.N.A. (mount or
 *                         profile), rounded to 2 decimals (~1 km), so the app
 *                         can fetch the weather forecast for it. Off by default.
 *
 * Weather: if N.I.N.A. has a weather device (ASCOM ObservingConditions) or a
 * safety monitor connected, their readings go into the status (`weather`,
 * `safety`). Wind is converted from m/s to km/h.
 *
 * Without STAR_SITE=1 the status never contains the site coordinates the API reports.
 * Dependency-free: Node 18+ (the websocket needs Node 22+, polling works without).
 */
import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { inflateSync, deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const PORT = Number(process.env["PORT"] ?? process.env["STAR_PORT"] ?? 8893);
const HOST = process.env["HOST"] ?? process.env["STAR_HOST"] ?? "127.0.0.1";
const TOKEN = process.env["TOKEN"] ?? "";
const NINA = (process.env["STAR_NINA"] ?? "http://127.0.0.1:1888").replace(/\/+$/, "");
const API = NINA + "/v2/api";
const POLL_MS = Math.max(500, Number(process.env["STAR_POLL_MS"] ?? 2000));
const PREVIEW = process.env["STAR_PREVIEW"] !== "0";
const USE_WS = process.env["STAR_WS"] !== "0";
const TAILSCALE_USERS = String(process.env["STAR_TAILSCALE_USERS"] ?? "").split(",").map((u) => u.trim().toLowerCase()).filter(Boolean);
/**
 * Stopping a sequence is consequential: it needs the explicit switch AND a way
 * to tell who asks (token or tailnet login). Otherwise any web page in a local
 * browser could post it.
 */
const CONTROL = process.env["STAR_ALLOW_CONTROL"] === "1" && (TOKEN !== "" || TAILSCALE_USERS.length > 0);
const CONTROL_BLOCKED = process.env["STAR_ALLOW_CONTROL"] === "1" && !CONTROL;
/** Share the site (rounded) for the weather forecast: opt-in. */
const SHARE_SITE = process.env["STAR_SITE"] === "1";
/** The profile is large; its site is read at most this often. */
const PROFILE_MS = 10 * 60_000;

/** Preview box on the glasses (one image container). */
export const PREVIEW_W = 288;
export const PREVIEW_H = 144;
/** Values kept per history. */
export const HISTORY = 40;
/** A history sample at most this often (temperature, RMS). */
const SAMPLE_MS = 30_000;

// ---------------------------------------------------------------------------
// Small helpers (exported for the tests)
// ---------------------------------------------------------------------------
const num = (value) => (typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : null);
const round = (value, digits = 0) => {
  const n = num(value);
  if (n === null) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};
const text = (value) => (typeof value === "string" ? value : "");

/**
 * Reads the running position out of `sequence/state`: the target of the
 * running deep-sky container, the running leaf step, its exposure time, and
 * frame n/m from the nearest loop condition (or a TakeExposure count).
 */
export function readSequence(tree) {
  const out = { state: "none", target: null, step: null, frame: null, frames: null, exposureSeconds: null, loaded: false };
  if (!Array.isArray(tree)) return out;
  let running = false;
  let anyItems = false;
  let finishedTargets = false;
  let deepest = null;

  const walk = (node, path) => {
    if (!node || typeof node !== "object") return;
    const items = Array.isArray(node.Items) ? node.Items : null;
    const status = text(node.Status).toUpperCase();
    if (status === "RUNNING") {
      running = true;
      if (!deepest || path.length + 1 > deepest.length) deepest = [...path, node];
    }
    if (items) for (const child of items) walk(child, [...path, node]);
  };
  for (const root of tree) {
    if (!root || typeof root !== "object") continue;
    if (Array.isArray(root.Items) && root.Items.length > 0) anyItems = true;
    if (/target/i.test(text(root.Name)) && text(root.Status).toUpperCase() === "FINISHED") finishedTargets = true;
    walk(root, []);
  }
  out.loaded = anyItems;
  if (running && deepest) {
    out.state = "running";
    const leaf = deepest[deepest.length - 1];
    out.step = text(leaf.Name).replace(/_Container$/, "") || null;
    for (let i = deepest.length - 1; i >= 0; i--) {
      const node = deepest[i];
      const name = text(node?.Target?.TargetName);
      if (name) { out.target = name; break; }
    }
    const exposure = num(leaf.ExposureTime);
    if (exposure !== null && exposure > 0) out.exposureSeconds = exposure;
    for (let i = deepest.length - 1; i >= 0; i--) {
      const node = deepest[i];
      const loop = (Array.isArray(node?.Conditions) ? node.Conditions : []).find((c) => num(c?.Iterations) !== null && num(c?.CompletedIterations) !== null);
      if (loop) {
        out.frames = num(loop.Iterations);
        out.frame = Math.min(out.frames, num(loop.CompletedIterations) + 1);
        break;
      }
      // A TakeExposure with a count of its own.
      const count = num(node?.ExposureCount);
      const total = num(node?.TotalExposureCount ?? node?.Iterations);
      if (count !== null && total !== null && total > 0) { out.frames = total; out.frame = Math.min(total, count + 1); break; }
    }
  } else if (finishedTargets) {
    out.state = "finished";
  } else if (anyItems) {
    out.state = "idle";
    // The first target that still has work: what a resume would continue with.
    const firstTarget = (node) => {
      if (!node || typeof node !== "object") return null;
      const name = text(node.Target?.TargetName);
      if (name && text(node.Status).toUpperCase() !== "FINISHED") return name;
      for (const child of Array.isArray(node.Items) ? node.Items : []) { const found = firstTarget(child); if (found) return found; }
      return null;
    };
    for (const root of tree) { out.target = firstTarget(root); if (out.target) break; }
  }
  return out;
}

/** Hours to the meridian flip -> whole minutes, only while the mount tracks. */
export function flipMinutes(mount) {
  const hours = num(mount?.TimeToMeridianFlip);
  if (!mount?.TrackingEnabled || hours === null || hours >= 23.9) return null;
  return Math.max(0, Math.round(hours * 60));
}

/** Guiding RMS in arc seconds from guider/info (several shapes seen across versions). */
export function readGuider(info) {
  if (!info?.Connected) return { connected: false, guiding: null, rms: null, ra: null, dec: null };
  const rmsErr = info.RMSError ?? {};
  const arc = (part) => round(part?.Arcseconds ?? (num(part?.Pixel) !== null && num(info.PixelScale) ? num(part.Pixel) * num(info.PixelScale) : null), 2);
  const state = text(info.State).toLowerCase();
  return {
    connected: true,
    guiding: state ? state === "guiding" : null,
    rms: arc(rmsErr.Total),
    ra: arc(rmsErr.RA),
    dec: arc(rmsErr.Dec),
  };
}

/**
 * Weather device readings (ASCOM ObservingConditions via `equipment/weather/info`).
 * Values a device does not provide come as NaN / "NaN" and are dropped.
 * Wind speed and gusts are m/s in ASCOM; the glasses get km/h.
 */
export function readWeather(info) {
  if (!info?.Connected) return { connected: false };
  const kmh = (value) => { const n = num(value); return n === null ? null : Math.round(n * 3.6); };
  return {
    connected: true,
    name: text(info.DisplayName || info.Name) || null,
    cloudCover: round(info.CloudCover),
    rainRate: round(info.RainRate, 1),
    humidity: round(info.Humidity),
    dewPoint: round(info.DewPoint, 1),
    temperature: round(info.Temperature, 1),
    windSpeed: kmh(info.WindSpeed),
    windGust: kmh(info.WindGust),
    skyQuality: round(info.SkyQuality, 2),
  };
}

/** Safety monitor (`equipment/safetymonitor/info`): IsSafe, when connected. */
export function readSafety(info) {
  if (!info?.Connected) return { connected: false, safe: null };
  return { connected: true, safe: typeof info.IsSafe === "boolean" ? info.IsSafe : null };
}

/**
 * The observing site, rounded to 2 decimals: the mount's site first, then the
 * profile's astrometry settings. Null when unknown or the unset 0/0.
 */
export function readSite(mount, profile) {
  const pick = (lat, lon) => {
    const a = num(lat), b = num(lon);
    if (a === null || b === null || Math.abs(a) > 90 || Math.abs(b) > 180 || (a === 0 && b === 0)) return null;
    return { lat: round(a, 2), lon: round(b, 2) };
  };
  const astro = profile?.AstrometrySettings ?? profile?.Astrometry ?? null;
  return (mount?.Connected ? pick(mount.SiteLatitude, mount.SiteLongitude) : null) ?? pick(astro?.Latitude, astro?.Longitude);
}

// ---- PNG in, PNG out (only what N.I.N.A. streams: 8/16 bit, gray/RGB/alpha) ----
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Decodes a non-interlaced PNG to 8-bit gray. Throws on anything else. */
export function decodePngGray(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 33 || !buffer.subarray(0, 8).equals(PNG_SIG)) throw new Error("not a png");
  let at = 8;
  let width = 0, height = 0, depth = 0, type = 0, interlace = 0;
  const idat = [];
  while (at + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(at);
    const kind = buffer.toString("latin1", at + 4, at + 8);
    const data = buffer.subarray(at + 8, at + 8 + length);
    if (kind === "IHDR") {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      depth = data[8]; type = data[9]; interlace = data[12];
    } else if (kind === "IDAT") idat.push(data);
    else if (kind === "IEND") break;
    at += 12 + length;
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[type];
  if (!width || !height || !channels || (depth !== 8 && depth !== 16) || interlace !== 0) throw new Error("unsupported png");
  const bpp = channels * (depth / 8);
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  const out = new Uint8Array(width * height);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Uint8Array.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let add = 0;
      if (filter === 1) add = a;
      else if (filter === 2) add = b;
      else if (filter === 3) add = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[i] = (line[i] + add) & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const o = x * bpp;
      // High byte of 16-bit samples; color -> luma.
      const s = (k) => line[o + k * (depth / 8)];
      out[y * width + x] = channels >= 3 ? Math.round(0.299 * s(0) + 0.587 * s(1) + 0.114 * s(2)) : s(0);
    }
    prev = line;
  }
  return { width, height, pixels: out };
}

/**
 * Fits an image into the preview box (aspect kept, black bars), averaging the
 * source pixels per target pixel, then stretches the 35th..99.7th percentile (sky background dark) to
 * the full range so faint stars stay visible in the glasses' 16 gray levels.
 */
export function fitPreview(image, width = PREVIEW_W, height = PREVIEW_H) {
  const scale = Math.min(width / image.width, height / image.height);
  const w = Math.max(1, Math.round(image.width * scale));
  const h = Math.max(1, Math.round(image.height * scale));
  const ox = Math.floor((width - w) / 2);
  const oy = Math.floor((height - h) / 2);
  const box = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y / scale), y1 = Math.max(y0 + 1, Math.floor((y + 1) / scale));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x / scale), x1 = Math.max(x0 + 1, Math.floor((x + 1) / scale));
      let sum = 0, n = 0, peak = 0;
      for (let sy = y0; sy < Math.min(y1, image.height); sy++) {
        for (let sx = x0; sx < Math.min(x1, image.width); sx++) {
          const v = image.pixels[sy * image.width + sx];
          sum += v; n++; if (v > peak) peak = v;
        }
      }
      // Half mean, half peak: a single bright star pixel survives the shrink.
      box[y * w + x] = n ? Math.round((sum / n + peak) / 2) : 0;
    }
  }
  const sorted = Uint8Array.from(box).sort();
  const lo = sorted[Math.floor(sorted.length * 0.35)] ?? 0;
  const hi = Math.max(lo + 1, sorted[Math.floor(sorted.length * 0.997)] ?? 255);
  const out = new Uint8Array(width * height);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = (box[y * w + x] - lo) / (hi - lo);
      out[(y + oy) * width + x + ox] = Math.max(0, Math.min(255, Math.round(v * 255)));
    }
  }
  return { width, height, pixels: out };
}

let crcTable = null;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(kind, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(kind, 4, "latin1");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
/** 8-bit grayscale PNG. */
export function encodePngGray(image) {
  const raw = Buffer.alloc((image.width + 1) * image.height);
  for (let y = 0; y < image.height; y++) {
    raw[y * (image.width + 1)] = 0;
    Buffer.from(image.pixels.buffer, image.pixels.byteOffset + y * image.width, image.width).copy(raw, y * (image.width + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header[8] = 8; header[9] = 0;
  return Buffer.concat([PNG_SIG, chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// ---------------------------------------------------------------------------
// Talking to N.I.N.A.
// ---------------------------------------------------------------------------
async function nina(path, ms = 4000) {
  const response = await fetch(API + path, { signal: AbortSignal.timeout(ms) });
  const body = await response.json();
  if (!body || body.Success !== true) throw Object.assign(new Error(text(body?.Error) || "nina error"), { status: response.status, body });
  return body.Response;
}
const soft = (promise) => promise.then((value) => value, () => null);

/** Notable Advanced API events kept for the glasses (with their age). */
const NOTABLE = /^(SEQUENCE-(STARTING|FINISHED)|GUIDER-(START|STOP|DISCONNECTED|DITHER)|MOUNT-(BEFORE|AFTER)-FLIP|AUTOFOCUS-(STARTING|FINISHED)|ERROR-.*|CAMERA-(DISCONNECTED|DOWNLOAD-TIMEOUT)|MOUNT-(DISCONNECTED|PARKED)|IMAGE-SAVE)$/;

const state = {
  ok: false,
  reason: "starting",
  version: "",
  sequence: readSequence(null),
  camera: null,
  mount: null,
  focuser: null,
  filter: null,
  guider: readGuider(null),
  weather: readWeather(null),
  safety: readSafety(null),
  profile: null,
  profileAt: 0,
  exposure: { active: false, total: null, endsAt: null },
  /** First time a given exposure end time was seen: the start, when no sequence says how long. */
  exposureSeen: new Map(),
  last: null,
  imageCount: 0,
  history: { hfr: [], temp: [], rms: [] },
  lastSample: 0,
  events: [],
  wsEvents: [],
  preview: null,
  previewKey: null,
  previewFor: null,
  imagesDirty: true,
  lastSaveTime: "",
  lastImagesAt: 0,
};

const pushHistory = (list, value) => {
  if (value === null || value === undefined) return;
  list.push(value);
  if (list.length > HISTORY) list.splice(0, list.length - HISTORY);
};

async function refreshImages() {
  const all = await soft(nina("/image-history?all=true", 6000));
  if (!Array.isArray(all)) return;
  state.imageCount = all.length;
  const lights = all.map((img, index) => ({ img, index })).filter(({ img }) => text(img?.ImageType).toUpperCase() === "LIGHT");
  state.history.hfr = lights.map(({ img }) => num(img.HFR)).filter((v) => v !== null && v > 0).slice(-HISTORY).map((v) => round(v, 2));
  const newest = all.length > 0 ? { img: all[all.length - 1], index: all.length - 1 } : null;
  if (!newest) { state.last = null; return; }
  const img = newest.img;
  state.last = {
    index: newest.index,
    at: text(img.Date) || null,
    type: text(img.ImageType) || null,
    filter: text(img.Filter) || null,
    exposure: num(img.ExposureTime),
    hfr: round(img.HFR, 2),
    stars: num(img.Stars),
    target: text(img.TargetName) || null,
    temp: round(img.Temperature, 1),
    median: round(img.Median),
  };
  if (PREVIEW && state.previewFor !== `${newest.index}|${text(img.Filename)}`) {
    try {
      const want = fitSize(state.camera);
      const response = await fetch(`${API}/image/${newest.index}?resize=true&size=${want.w}x${want.h}&stream=true`, { signal: AbortSignal.timeout(15000) });
      if (!response.ok || !String(response.headers.get("content-type")).includes("png")) throw new Error("no png");
      const png = encodePngGray(fitPreview(decodePngGray(Buffer.from(await response.arrayBuffer()))));
      state.preview = png;
      state.previewFor = `${newest.index}|${text(img.Filename)}`;
      state.previewKey = createHash("sha1").update(png).digest("hex").slice(0, 12);
    } catch (error) {
      console.warn("preview failed: " + error.message);
      state.previewFor = `${newest.index}|${text(img.Filename)}`;
    }
  }
}

/** Ask N.I.N.A. for twice the preview box (it resizes on its side), keeping the sensor's aspect. */
function fitSize(camera) {
  const w = num(camera?.XSize) ?? 4, h = num(camera?.YSize) ?? 3;
  const scale = Math.min((PREVIEW_W * 2) / w, (PREVIEW_H * 2) / h);
  return { w: Math.max(8, Math.round(w * scale)), h: Math.max(8, Math.round(h * scale)) };
}

async function refresh() {
  const version = await soft(nina("/version", 3000));
  if (version === null) { state.ok = false; state.reason = "nina-silent"; return; }
  state.version = String(version);
  const [camera, mount, focuser, wheel, guider, sequence, events, weather, safety] = await Promise.all([
    soft(nina("/equipment/camera/info")),
    soft(nina("/equipment/mount/info")),
    soft(nina("/equipment/focuser/info")),
    soft(nina("/equipment/filterwheel/info")),
    soft(nina("/equipment/guider/info")),
    soft(nina("/sequence/state")),
    soft(nina("/event-history")),
    soft(nina("/equipment/weather/info")),
    soft(nina("/equipment/safetymonitor/info")),
  ]);
  state.ok = true;
  state.reason = "";
  state.camera = camera;
  state.mount = mount;
  state.focuser = focuser;
  state.filter = wheel?.Connected ? text(wheel.SelectedFilter?.Name) || null : null;
  state.guider = readGuider(guider);
  state.sequence = readSequence(sequence);
  state.weather = readWeather(weather);
  state.safety = readSafety(safety);
  if (SHARE_SITE && !readSite(mount, null) && Date.now() - state.profileAt > PROFILE_MS) {
    state.profileAt = Date.now();
    state.profile = await soft(nina("/profile/show?active=true", 6000));
  }

  const now = Date.now();
  const exposing = camera?.Connected === true && camera.IsExposing === true;
  const endsAt = Date.parse(text(camera?.ExposureEndTime));
  if (exposing && Number.isFinite(endsAt)) {
    if (!state.exposureSeen.has(endsAt)) state.exposureSeen.set(endsAt, now);
    if (state.exposureSeen.size > 8) state.exposureSeen.delete(state.exposureSeen.keys().next().value);
    const guessed = (endsAt - state.exposureSeen.get(endsAt)) / 1000;
    state.exposure = { active: true, total: state.sequence.exposureSeconds ?? (guessed > 0.5 ? guessed : null), endsAt };
  } else {
    state.exposure = { active: false, total: null, endsAt: null };
  }

  if (Array.isArray(events)) {
    const notable = events.filter((e) => NOTABLE.test(text(e?.Event)));
    if (notable.length && text(notable[notable.length - 1]?.Event) === "IMAGE-SAVE") state.imagesDirty = true;
    const lastSave = [...events].reverse().find((e) => text(e?.Event) === "IMAGE-SAVE");
    if (lastSave && text(lastSave.Time) !== state.lastSaveTime) { state.lastSaveTime = text(lastSave.Time); state.imagesDirty = true; }
    state.events = notable.filter((e) => text(e.Event) !== "IMAGE-SAVE").slice(-8).map((e) => ({ name: text(e.Event), time: Date.parse(text(e.Time)) }));
  }
  if (state.imagesDirty || now - state.lastImagesAt > 30_000) {
    state.imagesDirty = false;
    state.lastImagesAt = now;
    await refreshImages();
  }
  if (now - state.lastSample >= SAMPLE_MS) {
    state.lastSample = now;
    if (camera?.Connected) pushHistory(state.history.temp, round(camera.Temperature, 1));
    if (state.guider.connected) pushHistory(state.history.rms, state.guider.rms);
  }
}

/** What the glasses get. No file paths; the site (rounded) only with STAR_SITE=1. */
export function snapshot(s = state, now = Date.now(), shareSite = SHARE_SITE) {
  if (!s.ok) return { v: 1, online: false, reason: s.reason, controllable: CONTROL };
  const c = s.camera, m = s.mount, f = s.focuser;
  const remaining = s.exposure.active && s.exposure.endsAt ? Math.max(0, (s.exposure.endsAt - now) / 1000) : null;
  const total = s.exposure.total;
  return {
    v: 1,
    online: true,
    version: s.version,
    sequence: { state: s.sequence.state, target: s.sequence.target, step: s.sequence.step, frame: s.sequence.frame, frames: s.sequence.frames },
    exposure: {
      active: s.exposure.active,
      total: total === null ? null : round(total, 1),
      remaining: remaining === null ? null : round(remaining, 1),
      progress: remaining !== null && total ? Math.max(0, Math.min(100, Math.round(100 * (1 - remaining / total)))) : null,
    },
    filter: s.filter,
    camera: c?.Connected ? {
      connected: true,
      name: text(c.DisplayName || c.Name),
      temp: round(c.Temperature, 1),
      setpoint: c.CanSetTemperature ? round(c.TemperatureSetPoint ?? c.TargetTemp, 1) : null,
      cooler: c.CoolerOn === true,
      power: round(c.CoolerPower),
      canCool: c.CanSetTemperature === true,
      atTarget: c.AtTargetTemp === true,
      gain: num(c.Gain),
    } : { connected: false },
    mount: m?.Connected ? {
      connected: true,
      tracking: m.TrackingEnabled === true,
      parked: m.AtPark === true,
      slewing: m.Slewing === true,
      alt: round(m.Altitude, 1),
      az: round(m.Azimuth, 1),
      flipMinutes: flipMinutes(m),
      pier: text(m.SideOfPier).replace(/^pier/, "").toLowerCase() || null,
    } : { connected: false },
    focuser: f?.Connected ? { connected: true, position: num(f.Position), temp: round(f.Temperature, 1), moving: f.IsMoving === true } : { connected: false },
    guider: s.guider,
    last: s.last,
    images: s.imageCount,
    history: s.history,
    events: s.events.map((e) => ({ name: e.name, ageSeconds: Number.isFinite(e.time) ? Math.max(0, Math.round((now - e.time) / 1000)) : null })),
    preview: s.preview ? s.previewKey : null,
    controllable: CONTROL,
    weather: s.weather,
    safety: s.safety,
    ...(shareSite ? { site: readSite(m, s.profile) } : {}),
  };
}

// ---- optional websocket: an image or sequence event refreshes at once ----
function listen() {
  if (!USE_WS || typeof globalThis.WebSocket !== "function") return;
  const url = NINA.replace(/^http/, "ws") + "/v2/socket";
  let socket;
  try { socket = new WebSocket(url); } catch { setTimeout(listen, 15000); return; }
  socket.addEventListener("message", (message) => {
    try {
      const body = JSON.parse(String(message.data));
      const name = text(body?.Response?.Event ?? body?.Event);
      if (name === "IMAGE-SAVE") state.imagesDirty = true;
      if (/^(IMAGE-SAVE|SEQUENCE-|GUIDER-|MOUNT-)/.test(name)) void tick();
    } catch { /* not ours */ }
  });
  socket.addEventListener("close", () => setTimeout(listen, 15000));
  socket.addEventListener("error", () => { try { socket.close(); } catch { /* closed */ } });
}

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try { await refresh(); } catch (error) { state.ok = false; state.reason = "nina-silent"; console.warn("refresh failed: " + error.message); } finally { ticking = false; }
}

const COMMANDS = { stop: "/sequence/stop", start: "/sequence/start?skipValidation=true" };
async function command(name) {
  if (!CONTROL) return { status: 403, body: { ok: false, error: "control-off" } };
  if (!Object.hasOwn(COMMANDS, name)) return { status: 400, body: { ok: false, error: "unknown-command" } };
  try {
    await nina(COMMANDS[name], 8000);
  } catch (error) {
    return { status: 409, body: { ok: false, error: "nina-refused", detail: String(error.body?.Response ?? error.message).slice(0, 80) } };
  }
  console.log("sent sequence " + name);
  void tick();
  return { status: 200, body: { ok: true, command: name } };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
function cors(request) {
  const origin = String(request.headers["origin"] ?? "");
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}
function send(request, response, code, body) {
  if (code === 204) { response.writeHead(204, cors(request)); response.end(); return; }
  response.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors(request) });
  response.end(JSON.stringify(body));
}

function tailscaleUser(request) {
  const peer = String(request.socket?.remoteAddress ?? "").replace(/^::ffff:/, "");
  if (peer !== "127.0.0.1" && peer !== "::1") return "";
  const login = String(request.headers["tailscale-user-login"] ?? "").trim().toLowerCase();
  return TAILSCALE_USERS.includes(login) ? login : "";
}
const digest = (value) => createHash("sha256").update(value).digest();
function authorised(request) {
  if (tailscaleUser(request) !== "") return true;
  if (!TOKEN) return TAILSCALE_USERS.length === 0;
  return timingSafeEqual(digest(String(request.headers["authorization"] ?? "")), digest("Bearer " + TOKEN));
}
/** Access log without secrets: only the kind of credential. */
function authForm(request) {
  if (tailscaleUser(request)) return "tailscale";
  const header = String(request.headers["authorization"] ?? "");
  return header ? `len${header.length} fp=${createHash("sha256").update(header).digest("hex").slice(0, 8)}` : "none";
}

function readBody(request) {
  return new Promise((resolve) => {
    let raw = "";
    let done = false;
    const finish = (value) => { if (!done) { done = true; resolve(value); } };
    request.on("data", (part) => { raw += part; if (raw.length > 2048) { finish(null); request.destroy(); } });
    request.on("end", () => { try { finish(JSON.parse(raw || "{}")); } catch { finish(null); } });
    request.on("error", () => finish(null));
  });
}

export function startServer() {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "OPTIONS") { send(request, response, 204); return; }
    if (!authorised(request)) {
      console.warn(`401 ${request.method} ${url.pathname} auth=${authForm(request)}`);
      send(request, response, 401, { error: "unauthorized" });
      return;
    }
    try {
      if (url.pathname === "/api/star" && request.method === "GET") { send(request, response, 200, snapshot()); return; }
      if (url.pathname === "/api/star/preview.png" && request.method === "GET") {
        if (!state.preview) { send(request, response, 404, { error: "no preview" }); return; }
        response.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store", "X-Preview-Key": state.previewKey ?? "", ...cors(request) });
        response.end(state.preview);
        return;
      }
      if (url.pathname === "/api/star/cmd" && request.method === "POST") {
        const body = await readBody(request);
        const result = await command(typeof body?.command === "string" ? body.command : "");
        send(request, response, result.status, result.body);
        return;
      }
      if (url.pathname === "/health") { send(request, response, 200, { ok: true, nina: state.ok }); return; }
      send(request, response, 404, { error: "not found" });
    } catch (error) {
      console.error("request failed: " + error.message);
      send(request, response, 500, { error: "internal error" });
    }
  });
  server.listen(PORT, HOST, () => {
    console.log("Star Glass bridge on http://" + HOST + ":" + PORT + "/api/star");
    console.log("  N.I.N.A.: " + API);
    console.log("  control: " + (CONTROL ? "on" : "off") + ", preview: " + (PREVIEW ? "on" : "off") + ", site: " + (SHARE_SITE ? "shared (rounded)" : "private"));
    if (CONTROL_BLOCKED) console.log("  STAR_ALLOW_CONTROL=1 ignored: control needs a TOKEN or STAR_TAILSCALE_USERS.");
    if (!TOKEN && TAILSCALE_USERS.length === 0) console.log("  No TOKEN and no STAR_TAILSCALE_USERS: anyone who can reach this port can read the status.");
  });
  void tick();
  setInterval(() => { void tick(); }, POLL_MS);
  listen();
  return server;
}

const same = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase();
if (process.argv[1] && same(fileURLToPath(import.meta.url), process.argv[1])) startServer();
