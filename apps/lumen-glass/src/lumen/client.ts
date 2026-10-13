/**
 * Talks to a LUMEN instance.
 *
 * LUMEN is a FastAPI app the user runs themselves. Nothing here assumes a
 * hosted service: the base URL is whatever they entered, and if it is on their
 * own network nothing leaves the house.
 */

import { clampLight, stateForLight, type MothState } from "./moth";

export interface Moth {
  readonly light: number;
  readonly state: MothState;
  /** LUMEN's own description of what the moth is doing. */
  readonly gesture: string | null;
  /** Consecutive days with work, straight from LUMEN. */
  readonly streak: number;
}

export interface Quest {
  readonly id: number;
  /** Short name, e.g. "Bird's Eye Pattern". */
  readonly title: string;
  /** The actual instruction. */
  readonly task: string | null;
  /** "foto" or "video". A video quest cannot be answered from the glasses. */
  readonly medium: string | null;
  readonly minutes: number | null;
  /** The criterion the photo has to satisfy, when LUMEN set one. */
  readonly checkable: string | null;
}

/** The next golden or blue hour LUMEN computed for the user's location. */
export interface LightWindow {
  readonly kind: string;
  readonly minutesAway: number;
}

export interface LumenStatus {
  readonly moth: Moth;
  readonly quest: Quest | null;
  readonly openQuests: number;
  readonly window: LightWindow | null;
}

export interface LumenOutcome<T> {
  readonly value: T | null;
  readonly error: string | null;
}

export interface ClientOptions {
  readonly baseUrl: string;
  /**
   * Optional access token, sent as `Authorization: Bearer`. LUMEN in open mode
   * needs none. A cookie cannot be sent from the glasses: `Cookie` is a
   * forbidden header in the WebView's fetch, and credentialed requests fail
   * because LUMEN's CORS answer allows no credentials (measured 13.10.2026).
   */
  readonly token?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT = 8000;
/**
 * A submission is judged while the request is open (NSFW check, two vision
 * passes): tens of seconds are normal, 8 s cut every upload off.
 */
export const UPLOAD_TIMEOUT = 90_000;

/**
 * How a submission ended. `confirmed`: LUMEN answered readably. `sent`: the
 * photo went out and the server took it, but its answer (a redirect to an
 * HTML page without CORS) cannot be read — the caller checks the status.
 */
export type Submission = "confirmed" | "sent";

export async function fetchStatus(options: ClientOptions): Promise<LumenOutcome<LumenStatus>> {
  const outcome = await request(options, "/api/status", { method: "GET" });
  if (outcome.error !== null) return { value: null, error: outcome.error };
  return { value: parseStatus(outcome.value), error: null };
}

/** Asks LUMEN for a new quest. */
export async function newQuest(options: ClientOptions): Promise<LumenOutcome<true>> {
  const outcome = await request(options, "/api/quest/neu", { method: "POST" });
  return outcome.error !== null
    ? { value: null, error: outcome.error }
    : { value: true, error: null };
}

/**
 * Submits a photo for a quest.
 *
 * LUMEN expects `multipart/form-data` with a `datei` field, exactly as its web
 * form sends it — so the glasses use the same path as the browser rather than
 * a second, parallel one that could drift.
 */
export async function submitPhoto(
  options: ClientOptions,
  questId: number,
  photo: Blob,
  filename = "photo.jpg",
): Promise<LumenOutcome<Submission>> {
  const form = new FormData();
  form.append("datei", photo, filename);

  // LUMEN's upload route is its web form's route: it answers with a 303 to an
  // HTML page and sends no CORS headers (only /api/* has them). A normal
  // cross-origin fetch therefore fails although the photo arrived. A
  // "no-cors" form post is a simple request that goes out all the same; its
  // answer is opaque, so the caller asks /api/status what became of the quest.
  // No header of our own (none would survive no-cors), no Content-Type: the
  // browser adds the multipart boundary.
  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? UPLOAD_TIMEOUT);
  try {
    const response = await doFetch(joinUrl(options.baseUrl, "/quest/" + questId + "/abgeben"), {
      method: "POST",
      body: form,
      mode: "no-cors",
      credentials: "omit",
      signal: controller.signal,
    });
    if (response.type === "opaque" || response.status === 0) return { value: "sent", error: null };
    if (response.status === 401 || response.status === 403) return { value: null, error: "not signed in to LUMEN" };
    const accepted = response.ok || (response.status >= 300 && response.status < 400);
    return accepted ? { value: "confirmed", error: null } : { value: null, error: "HTTP " + response.status };
  } catch (error) {
    return { value: null, error: describeError(error) };
  } finally {
    clearTimeout(timeout);
  }
}

/** Turns a base64 payload from the phone camera into a Blob for upload. */
export function blobFromBase64(base64: string, mimeType = "image/jpeg"): Blob {
  const clean = base64.includes(",") ? base64.slice(base64.indexOf(",") + 1) : base64;
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

async function request(
  options: ClientOptions,
  path: string,
  init: RequestInit,
): Promise<LumenOutcome<unknown>> {
  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT);

  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    // Never a Cookie header (forbidden in fetch, silently dropped) and never
    // credentials: "include" (LUMEN's CORS answer has no Allow-Credentials,
    // so the WebView throws every answer away). A token travels as Bearer.
    if (options.token) headers["Authorization"] = "Bearer " + options.token;

    const response = await doFetch(joinUrl(options.baseUrl, path), {
      ...init,
      headers: { ...headers, ...(init.headers ?? {}) },
      signal: controller.signal,
      credentials: "omit",
    });

    if (response.status === 401 || response.status === 403) {
      return { value: null, error: "not signed in to LUMEN" };
    }
    // LUMEN is a web app: after a successful submission it redirects back to a
    // page rather than answering with JSON. A 3xx here means "accepted", not
    // "failed" — treating it as an error would report every good upload as bad.
    const accepted = response.ok || (response.status >= 300 && response.status < 400);
    if (!accepted) return { value: null, error: "HTTP " + response.status };

    // Some LUMEN endpoints redirect back to a page instead of answering JSON;
    // a 2xx there still means the submission was accepted.
    const type = response.headers.get("content-type") ?? "";
    if (!type.includes("json")) return { value: null, error: null };

    return { value: await response.json(), error: null };
  } catch (error) {
    return { value: null, error: describeError(error) };
  } finally {
    clearTimeout(timeout);
  }
}

export function describeError(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return "LUMEN timed out";
  if (error instanceof TypeError) return "LUMEN unreachable";
  if (error instanceof Error && error.message) return error.message.slice(0, 50);
  return "failed";
}

/** Reads LUMEN's status payload defensively; a changed field must not crash the glasses. */
export function parseStatus(value: unknown): LumenStatus {
  const root = (value ?? {}) as Record<string, unknown>;
  const creature = (root["kreatur"] ?? {}) as Record<string, unknown>;

  const light = clampLight(numberOr(creature["licht"], 0));
  const state = typeof creature["zustand"] === "string"
    ? (creature["zustand"] as MothState)
    : stateForLight(light);

  const rawQuest = root["quest"];
  const quest = rawQuest && typeof rawQuest === "object"
    ? readQuest(rawQuest as Record<string, unknown>)
    : null;

  // Verified against a running LUMEN: the field is naechstes_lichtfenster.
  // The others are kept as fallbacks in case an older build names it differently.
  const rawWindow = root["naechstes_lichtfenster"]
    ?? root["naechstes_fenster"] ?? root["fenster"] ?? root["naechstes"];
  const window = rawWindow && typeof rawWindow === "object"
    ? readWindow(rawWindow as Record<string, unknown>)
    : null;

  return {
    moth: {
      light,
      state,
      gesture: typeof creature["geste"] === "string" ? creature["geste"] : null,
      streak: Math.max(0, numberOr(creature["streak"], 0)),
    },
    quest,
    openQuests: numberOr(root["offene_quests"], quest ? 1 : 0),
    window,
  };
}

function readQuest(raw: Record<string, unknown>): Quest | null {
  const id = numberOr(raw["id"], -1);
  if (id < 0) return null;
  // LUMEN sends both: a short name and the instruction itself.
  const title = firstString(raw, ["titel", "text", "beschreibung"]) ?? "Quest";
  const task = firstString(raw, ["aufgabe"]);
  const minutes = numberOr(raw["dauer_min"], -1);
  return {
    id,
    title,
    task,
    medium: firstString(raw, ["medium"]),
    minutes: minutes >= 0 ? minutes : null,
    checkable: firstString(raw, ["pruefbar", "kriterium"]),
  };
}

function readWindow(raw: Record<string, unknown>): LightWindow | null {
  const minutes = numberOr(raw["in_minuten"], -1);
  if (minutes < 0) return null;
  return { kind: typeof raw["art"] === "string" ? raw["art"] : "licht", minutesAway: minutes };
}

function firstString(raw: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function numberOr(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return fallback;
}

function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, "") + path;
}
