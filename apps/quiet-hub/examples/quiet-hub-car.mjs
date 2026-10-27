/**
 * Quiet Hub "Auto": steering the car through Panoptes' phone API (`/api/handy/v1`), the only way the
 * Panoptes coordination allows (answer 27.10.2026). Never the old byd-bridge, never the BYD cloud.
 *
 * - The daemon pairs like a phone (`art=handy`, name "Quiet Hub") with a 4-digit check number; Alfred
 *   allows it on the car display or in Telegram, and decides there whether it may unlock.
 * - Its own P-256 key and the pairing JWT live only in CAR_IDENTITY (default
 *   ~/.config/quietglass/quiet-hub-car.json, mode 600). Nothing of it reaches a report or the glasses.
 * - Allowed: zusperren, klima_an (17-33 °C, 5-30 min), klima_aus, aufsperren. Never horn, lights,
 *   indicators, "find car" or the alarm: those actions do not exist here.
 * - Aufsperren: the glasses arm it with a tap and send it with a second tap; only then the daemon signs
 *   `panoptes-handy-v1|aufsperren|<kopplungId>|<zeitMs>|<nonce>` - a fresh signature per request, no retry,
 *   never from a timer, a rule or speech.
 * - The answer is passed on as it is: `{ok, weg, bestaetigt}` or `{ok:false, grund}`. `bestaetigt:false`
 *   is never shown as success.
 *
 * Pairing (once, on the daemon machine):  node examples/quiet-hub-car.mjs pair
 * Env: CAR_URL (Panoptes, e.g. http://<car tailnet ip>:8180), CAR_IDENTITY (file), CAR=off.
 */
import { createPrivateKey, generateKeyPairSync, randomBytes, randomInt, sign } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export const CAR_ACTIONS = ["zusperren", "klima_an", "klima_aus", "aufsperren"];
const PREFIX = "panoptes-handy-v1";
/** The JWT lives 30 days; renewed once a day while the daemon runs. */
const RENEW_MS = 24 * 60 * 60_000;

export function defaultIdentityFile(env = process.env) {
  return env.CAR_IDENTITY || join(homedir(), ".config", "quietglass", "quiet-hub-car.json");
}

export function parseCarConfig(env = {}) {
  const url = String(env.CAR_URL ?? "").trim().replace(/\/+$/, "");
  return { enabled: url !== "" && String(env.CAR ?? "").toLowerCase() !== "off", url, file: defaultIdentityFile(env) };
}

export function loadIdentity(file) {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    if (typeof raw.jwt !== "string" || typeof raw.kopplungId !== "string" || typeof raw.privateKey !== "string") return null;
    return raw;
  } catch {
    return null;
  }
}

export function saveIdentity(file, identity) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(identity, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
}

/** The exact text Panoptes verifies (HandySignatur.nachricht). */
export function unlockMessage(kopplungId, zeitMs, nonce) {
  return `${PREFIX}|aufsperren|${kopplungId}|${zeitMs}|${nonce}`;
}

/** Signature of one unlock, made only now: ECDSA P-256 / SHA-256, DER, base64. */
export function signUnlock(privateKeyPem, kopplungId, zeitMs, nonce = randomBytes(18).toString("base64url")) {
  const sig = sign("sha256", Buffer.from(unlockMessage(kopplungId, zeitMs, nonce), "utf8"), { key: createPrivateKey(privateKeyPem), dsaEncoding: "der" });
  return { zeit: zeitMs, nonce, sig: sig.toString("base64") };
}

/** Body of POST /api/handy/v1/aktion; null = not an allowed action or values out of range. */
export function actionBody(aktion, { tempC, minuten } = {}) {
  if (!CAR_ACTIONS.includes(aktion)) return null;
  if (aktion === "klima_an") {
    const t = Math.round(Number(tempC ?? 21));
    const m = Math.round(Number(minuten ?? 15));
    if (!(t >= 17 && t <= 33) || !(m >= 5 && m <= 30)) return null;
    return { aktion, tempC: t, minuten: m };
  }
  return { aktion };
}

/**
 * Panoptes' `GET /api/ha/v1/zustand` -> the car block the glasses show (same shape as the briefing's car).
 * Panoptes is the source of truth for the lock: `unlocked_lf` 0 = locked (the old bridge could say otherwise).
 */
export function carStateFrom(zustand, at) {
  const t = zustand?.telemetrie ?? {};
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const unlocked = num(t.unlocked_lf);
  const doors = ["door_open_lf", "door_open_rf", "door_open_lr", "door_open_rr"].map((k) => num(t[k])).filter((v) => v !== null);
  const power = num(t.power_level);
  return {
    status: "ok",
    soc: num(t.soc),
    rangeKm: num(t.ev_range_km),
    charging: t.is_charging === 1,
    chargeDone: false,
    etaMin: null,
    locked: unlocked === null ? null : unlocked === 0,
    doorOpen: doors.some((v) => v === 1),
    mode: power !== null && power > 0 ? (num(t.speed) ?? 0) > 0 ? "driving" : "on" : "parked",
    climateOn: t.climate_on === 1,
    outsideC: num(t.ext_temp),
    guard: typeof zustand?.waechter?.zustand === "string" ? zustand.waechter.zustand : null,
    at,
  };
}

/** Panoptes' answer reduced to what the glasses may see (never a token or a key). */
export function carResult(answer) {
  if (answer && answer.ok === true) return { ok: true, weg: String(answer.weg ?? ""), bestaetigt: answer.bestaetigt === true };
  return { ok: false, grund: String(answer?.grund ?? "unbekannt").slice(0, 60) };
}

export function createCar({ url, file, fetchImpl = globalThis.fetch, now = () => Date.now(), timeoutMs = 20_000, log = () => undefined }) {
  let identity = loadIdentity(file);
  let renewedAt = 0;

  const post = async (path, body) => {
    const res = await fetchImpl(`${url}${path}`, {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${identity.jwt}` },
      body: JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch { /* no body */ }
    return { status: res.status, json };
  };

  async function renew() {
    // Paired while the daemon ran: pick the file up here too, not only at the first command.
    if (identity === null) identity = loadIdentity(file);
    if (identity === null || now() - renewedAt < RENEW_MS) return;
    renewedAt = now();
    try {
      const { status, json } = await post("/api/sitzung/erneuern", {});
      if (status === 200 && typeof json?.jwt === "string") {
        identity = { ...identity, jwt: json.jwt, renewedAt: now() };
        saveIdentity(file, identity);
      } else {
        log("car: session renew failed, HTTP", status);
      }
    } catch (error) {
      renewedAt = now() - RENEW_MS + 10 * 60_000;
      log("car: session renew failed:", String(error?.message ?? error).slice(0, 80));
    }
  }

  /** One command. Unlock is signed here, right before it is sent; nothing is ever retried. */
  async function action(aktion, values = {}) {
    if (identity === null) identity = loadIdentity(file);
    if (identity === null) return { status: 503, result: { ok: false, grund: "nicht_gekoppelt" } };
    const body = actionBody(String(aktion ?? ""), values);
    if (body === null) return { status: 400, result: { ok: false, grund: "aktion" } };
    if (aktion === "aufsperren") body.signatur = signUnlock(identity.privateKey, identity.kopplungId, now());
    try {
      const { status, json } = await post("/api/handy/v1/aktion", body);
      if (status === 401 || status === 403) return { status: 200, result: { ok: false, grund: status === 401 ? "kopplung_abgelaufen" : String(json?.grund ?? "nur_handy") } };
      return { status: 200, result: carResult(json) };
    } catch (error) {
      log("car: action failed:", aktion, String(error?.message ?? error).slice(0, 80));
      return { status: 200, result: { ok: false, grund: "nicht_erreichbar" } };
    }
  }

  /** Last car state read from Panoptes; a failed read keeps the last one, marked stale. */
  let last = null;
  async function refresh() {
    if (identity === null) identity = loadIdentity(file);
    if (identity === null) return last;
    try {
      const res = await fetchImpl(`${url}/api/ha/v1/zustand`, { signal: AbortSignal.timeout(timeoutMs), headers: { Authorization: `Bearer ${identity.jwt}` } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      last = carStateFrom(await res.json(), now());
    } catch (error) {
      if (last !== null) last = { ...last, stale: true, since: last.since ?? last.at };
      else last = { status: "error", error: String(error?.message ?? error).slice(0, 60) };
    }
    return last;
  }

  return { action, renew, refresh, state: () => last, configured: () => identity !== null || loadIdentity(file) !== null };
}

/**
 * Pairs this machine as a phone: request with a check number, wait for Alfred's "Erlauben", store the JWT,
 * then report the public key once (first write wins). Prints only the check number and the outcome.
 */
export async function pair({ url, file, name = "Quiet Hub", fetchImpl = globalThis.fetch, wait = (ms) => new Promise((r) => setTimeout(r, ms)), print = console.log }) {
  if (existsSync(file) && loadIdentity(file) !== null) throw new Error(`already paired (${file}); revoke in Panoptes and delete the file to pair again`);
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pruefzahl = String(randomInt(0, 10_000)).padStart(4, "0");
  const ask = await fetchImpl(`${url}/auth/kopplung/anfrage`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ geraet: name, pruefzahl, art: "handy" }),
  });
  const started = await ask.json().catch(() => ({}));
  if (started.ok !== true || typeof started.id !== "string") throw new Error(`pairing request refused: ${started.grund ?? ask.status}`);
  print(`Prüfzahl ${pruefzahl} – bitte in Telegram oder am Auto-Display erlauben (2 min).`);
  let granted = null;
  for (let i = 0; i < 70 && granted === null; i += 1) {
    await wait(started.abfrageAlleMs ?? 2000);
    const res = await fetchImpl(`${url}/auth/kopplung/anfrage/${started.id}`);
    const state = await res.json().catch(() => ({}));
    if (state.status === "erlaubt") granted = state;
    else if (state.status !== "wartet") throw new Error(`pairing ended: ${state.status ?? res.status}`);
  }
  if (granted === null || typeof granted.jwt !== "string") throw new Error("pairing timed out");
  const identity = {
    url, kopplungId: String(granted.kopplungId), jwt: granted.jwt, pairedAt: Date.now(),
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
  saveIdentity(file, identity);
  const spki = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const report = await fetchImpl(`${url}/api/handy/v1/geraet`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${identity.jwt}` },
    body: JSON.stringify({ oeffentlicherSchluessel: spki, name }),
  });
  const reported = await report.json().catch(() => ({}));
  saveIdentity(file, { ...identity, keyReported: reported.ok === true });
  print(reported.ok === true ? `Gekoppelt (${identity.kopplungId}), Schlüssel hinterlegt.` : `Gekoppelt (${identity.kopplungId}), Schlüssel NICHT hinterlegt: ${reported.grund ?? report.status}`);
  return { kopplungId: identity.kopplungId, keyReported: reported.ok === true };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop()) && process.argv[2] === "pair") {
  const cfg = parseCarConfig(process.env);
  if (cfg.url === "") { console.error("CAR_URL is not set"); process.exit(2); }
  pair({ url: cfg.url, file: cfg.file }).then(() => process.exit(0), (error) => { console.error(String(error?.message ?? error)); process.exit(1); });
}
