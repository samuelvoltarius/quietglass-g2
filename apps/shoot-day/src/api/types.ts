/**
 * The data a Shoot Day server serves, and the validation applied to every
 * reply. Nothing from the network is trusted: strings are coerced and cut,
 * lists are capped, and anything malformed is dropped rather than drawn.
 */

export interface Shot {
  readonly scene: string;
  readonly shot: string;
  readonly desc: string;
  readonly size: string;
}

export interface ShotList {
  readonly project: string;
  readonly shots: readonly Shot[];
}

export type TakeStatus = "OK" | "NG";

export interface Take {
  readonly scene: string;
  readonly shot: string;
  readonly n: number;
  readonly status: TakeStatus;
  readonly note: string;
  readonly ts: number;
}

export interface ScheduleRow {
  readonly time: string;
  readonly what: string;
}

export interface CallSheet {
  readonly date: string;
  readonly call: string;
  readonly location: string;
  readonly contact: string;
  readonly notes: string;
  readonly schedule: readonly ScheduleRow[];
}

export interface EquipmentItem {
  readonly group: string;
  readonly name: string;
  readonly need: boolean;
  readonly packed: boolean;
}

export interface Equipment {
  readonly project: string;
  readonly items: readonly EquipmentItem[];
}

export const LIMITS = {
  text: 200,
  shots: 500,
  takes: 5000,
  schedule: 200,
  items: 500,
  prompter: 50_000,
} as const;

const str = (value: unknown, max: number = LIMITS.text): string =>
  (typeof value === "string" ? value : typeof value === "number" ? String(value) : "").slice(0, max);

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const list = (value: unknown, max: number): unknown[] => (Array.isArray(value) ? value.slice(0, max) : []);

export function parseShotList(raw: unknown): ShotList {
  const value = record(raw);
  const shots: Shot[] = [];
  for (const entry of list(value["shots"], LIMITS.shots)) {
    const s = record(entry);
    const scene = str(s["scene"], 20).trim();
    const shot = str(s["shot"], 20).trim();
    if (!scene && !shot) continue;
    shots.push({ scene, shot, desc: str(s["desc"]), size: str(s["size"], 20) });
  }
  return { project: str(value["project"], 80), shots };
}

export function parseTake(raw: unknown): Take | null {
  const t = record(raw);
  const n = Number(t["n"]);
  const ts = Number(t["ts"]);
  const scene = str(t["scene"], 20);
  const shot = str(t["shot"], 20);
  if (!Number.isFinite(n) || n < 1 || (!scene && !shot)) return null;
  return {
    scene, shot, n: Math.floor(n),
    status: t["status"] === "NG" ? "NG" : "OK",
    note: str(t["note"], 80),
    ts: Number.isFinite(ts) ? ts : 0,
  };
}

export function parseTakes(raw: unknown): Take[] {
  const out: Take[] = [];
  for (const entry of list(record(raw)["takes"], LIMITS.takes)) {
    const take = parseTake(entry);
    if (take) out.push(take);
  }
  return out;
}

export function parsePrompter(raw: unknown): string {
  return str(record(raw)["text"], LIMITS.prompter);
}

export function parseCallSheet(raw: unknown): CallSheet {
  const value = record(raw);
  const schedule: ScheduleRow[] = [];
  for (const entry of list(value["schedule"], LIMITS.schedule)) {
    const row = record(entry);
    const what = str(row["what"]);
    const time = str(row["time"], 20);
    if (what || time) schedule.push({ time, what });
  }
  return {
    date: str(value["date"], 40),
    call: str(value["call"], 20),
    location: str(value["location"]),
    contact: str(value["contact"]),
    notes: str(value["notes"], 1000),
    schedule,
  };
}

export function parseEquipment(raw: unknown): Equipment {
  const value = record(raw);
  const items: EquipmentItem[] = [];
  for (const entry of list(value["items"], LIMITS.items)) {
    const item = record(entry);
    const name = str(item["name"], 80).trim();
    if (!name) continue;
    items.push({ group: str(item["group"], 40), name, need: item["need"] === true, packed: item["packed"] === true });
  }
  return { project: str(value["project"], 80), items };
}

/** "09:30" or "9.30" → minutes since midnight; anything else → null. */
export function clockMinutes(time: string): number | null {
  const match = /^\s*(\d{1,2})[:.](\d{2})/.exec(time);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** What is on now, and what comes next, by the clock. */
export function scheduleNow(rows: readonly ScheduleRow[], now: Date): { now?: ScheduleRow; next?: ScheduleRow; inMinutes?: number } {
  const minutes = now.getHours() * 60 + now.getMinutes();
  let current: ScheduleRow | undefined;
  let next: ScheduleRow | undefined;
  let inMinutes: number | undefined;
  for (const row of rows) {
    const at = clockMinutes(row.time);
    if (at === null) continue;
    if (at <= minutes) current = row;
    else if (!next) { next = row; inMinutes = at - minutes; }
  }
  return {
    ...(current ? { now: current } : {}),
    ...(next ? { next } : {}),
    ...(inMinutes !== undefined ? { inMinutes } : {}),
  };
}
