/**
 * Step log for hunting faults that only show on the real glasses (ported from
 * apps/klipper-glance/src/diag/diag.ts).
 *
 * The private build sends what the app does - every call into the glasses
 * with its time and result, every event from them, every page change, the
 * exit dialog steps, errors and stalls of the JS thread - to the owner's own
 * traffic service (`POST <VITE_TRAFFIC_URL>/diag`, tailnet only). Entries carry
 * kinds, names, counts and milliseconds only.
 * Without a traffic URL (public build, tests) nothing is recorded or sent.
 */

/** App tag in every batch, so the shared log can be filtered per app. */
const APP = "cadence";

export interface DiagEvent {
  /** Milliseconds since the app started. */
  readonly t: number;
  /** What happened, e.g. "call", "event", "drawSkip", "exitAsk", "lag", "error". */
  readonly k: string;
  readonly [field: string]: string | number | boolean | null | undefined;
}

type Fields = Record<string, string | number | boolean | null | undefined>;

const MAX_BUFFER = 2_000;
const FLUSH_MS = 3_000;
/** A timer that fires this much later than asked means the JS thread was busy. */
const LAG_REPORT_MS = 700;
const LAG_TICK_MS = 250;

let base = "";
let started = 0;
let session = "";
let version = "";
let buffer: DiagEvent[] = [];
let sending = false;
let flushTimer: ReturnType<typeof setInterval> | null = null;
let lagTimer: ReturnType<typeof setInterval> | null = null;
/** Things that happen too often to log one by one (refused tiles, sensor stream events): counted, written with each flush. */
const counts = new Map<string, number>();
/** The last draw skip reason logged; repeats of it are only counted. */
let lastSkip = "";
let skipRepeats = 0;

/** Turns the log on (only with a traffic URL). Safe to call once at start. */
export function startDiag(trafficUrl: string, appVersion: string, now: () => number = Date.now): void {
  if (!trafficUrl || base) return;
  base = trafficUrl.replace(/\/+$/, "");
  started = now();
  version = appVersion;
  session = Math.floor(Math.random() * 36 ** 6).toString(36);
  diag("start", { ver: appVersion });
  flushTimer = setInterval(() => { void flushDiag(); }, FLUSH_MS);
  let expected = now() + LAG_TICK_MS;
  lagTimer = setInterval(() => {
    const late = now() - expected;
    // ~750 ms every second is the phone throttling a hidden page to 1 Hz (not a busy thread): "vis" tells them apart.
    if (late > LAG_REPORT_MS) diag("lag", { ms: Math.round(late), vis: (globalThis as { document?: { visibilityState?: string } }).document?.visibilityState ?? "" });
    expected = now() + LAG_TICK_MS;
  }, LAG_TICK_MS);
  const g = globalThis as { addEventListener?: (type: string, fn: (e: unknown) => void) => void };
  g.addEventListener?.("error", (e) => diag("error", { msg: errorText((e as { error?: unknown; message?: string }).error ?? (e as { message?: string }).message) }));
  g.addEventListener?.("unhandledrejection", (e) => diag("error", { msg: "unhandled: " + errorText((e as { reason?: unknown }).reason) }));
}

export function diagOn(): boolean {
  return base !== "";
}

/** Records one step; cheap and silent when the log is off. */
export function diag(kind: string, fields: Fields = {}): void {
  if (!base) return;
  if (buffer.length >= MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER + 1);
  const clipped: Fields = {};
  for (const [key, value] of Object.entries(fields)) clipped[key] = typeof value === "string" ? value.slice(0, 200) : value;
  buffer.push({ t: Date.now() - started, k: kind, ...clipped });
}

/** Counts something frequent; the totals go out as "count" entries with the next flush. */
export function diagCount(what: string): void {
  if (!base) return;
  counts.set(what, (counts.get(what) ?? 0) + 1);
}

/**
 * A draw that returned early, with why (`null` = this draw went ahead). A reason is logged when it changes;
 * repeats of the same reason are only counted ("drawSkipRepeat" when it changes again).
 */
export function diagSkip(reason: string | null, fields: Fields = {}): void {
  if (!base) return;
  const next = reason ?? "";
  if (next === lastSkip) {
    if (reason !== null) skipRepeats += 1;
    return;
  }
  if (skipRepeats > 0) diag("drawSkipRepeat", { reason: lastSkip, n: skipRepeats });
  skipRepeats = 0;
  lastSkip = next;
  if (reason !== null) diag("drawSkip", { reason, ...fields });
}

function drainCounts(): void {
  for (const [what, n] of counts) diag("count", { what, n });
  counts.clear();
}

/** Sends what has gathered; one request at a time, entries kept when it fails. */
export async function flushDiag(): Promise<void> {
  if (!base) return;
  drainCounts();
  if (sending || buffer.length === 0) return;
  sending = true;
  const batch = buffer.slice(0, 400);
  try {
    const response = await fetch(`${base}/diag`, {
      method: "POST",
      // text/plain keeps it a "simple" request like the traffic call: no preflight.
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ app: APP, ver: version, sid: session, events: batch }),
    });
    if (response.ok) buffer = buffer.slice(batch.length);
  } catch {
    // Offline or the service is away: keep the entries for the next try.
  } finally {
    sending = false;
  }
}

export function stopDiag(): void {
  if (flushTimer) clearInterval(flushTimer);
  if (lagTimer) clearInterval(lagTimer);
  flushTimer = lagTimer = null;
  void flushDiag();
}

function errorText(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message} @ ${(value.stack ?? "").split("\n").slice(1, 3).join(" | ")}`;
  return String(value);
}
