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
  /** Optional coordinates of the shoot's place (`lat`/`lon`), for the light view. */
  readonly latitude?: number;
  readonly longitude?: number;
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
    ...coordinates(value["lat"] ?? value["latitude"], value["lon"] ?? value["longitude"]),
  };
}

/** Both coordinates when they are real ones, else nothing. */
function coordinates(lat: unknown, lon: unknown): { latitude?: number; longitude?: number } {
  if (lat === null || lon === null || lat === undefined || lon === undefined || lat === "" || lon === "") return {};
  const latitude = Number(lat);
  const longitude = Number(lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return {};
  if (latitude === 0 && longitude === 0) return {};
  return { latitude, longitude };
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

// ---------------------------------------------------------------------------
// Customers, their projects, the card before an appointment, storyboards (0.5.0)
// ---------------------------------------------------------------------------

export interface CustomerItem {
  readonly id: string;
  readonly name: string;
  readonly company: string;
  readonly projectCount: number;
}

export interface CustomerList {
  readonly customers: readonly CustomerItem[];
  /** The project the glasses work on, and its customer ("" for none). */
  readonly activeProject: string;
  readonly activeCustomer: string;
}

export interface ProjectItem {
  readonly id: string;
  readonly name: string;
  readonly date: string;
  readonly place: string;
}

export interface CustomerProjects {
  readonly customer: CustomerItem;
  readonly projects: readonly ProjectItem[];
}

export interface MemoryNote {
  readonly date: string;
  readonly title: string;
  readonly summary: string;
}

export interface OpenIdea {
  readonly text: string;
  readonly tags: readonly string[];
  readonly project: string;
}

/** "Kunde vor dem Termin". */
export interface Brief {
  readonly id: string;
  readonly name: string;
  readonly company: string;
  readonly phone: string;
  readonly email: string;
  readonly notes: string;
  /** Last change to the customer or one of its projects (ms). */
  readonly updated: number;
  readonly ideas: readonly OpenIdea[];
  /** Babel's memory entries; null when the server has no Babel configured (then nothing is shown). */
  readonly memory: readonly MemoryNote[] | null;
  readonly memoryError: boolean;
}

export interface BoardScene {
  readonly n: number;
  /** Seconds into the clip; null when unknown. */
  readonly from: number | null;
  readonly to: number | null;
  readonly title: string;
  readonly content: string;
  readonly camera: string;
  readonly overlay: string;
  readonly goal: string;
  readonly done: boolean;
}

export interface Storyboard {
  readonly id: string;
  readonly title: string;
  readonly scenes: readonly BoardScene[];
}

const ID_PATTERN = /^[a-z]_[0-9a-f]{12}$|^unassigned$/;
const id = (value: unknown): string => {
  const text = str(value, 40);
  return ID_PATTERN.test(text) ? text : "";
};

function customerItem(raw: unknown): CustomerItem | null {
  const c = record(raw);
  const customerId = id(c["id"]);
  const name = str(c["name"], 120).trim();
  if (!customerId || !name) return null;
  const count = Number(c["projectCount"]);
  return { id: customerId, name, company: str(c["company"], 120).trim(), projectCount: Number.isFinite(count) && count > 0 ? Math.floor(count) : 0 };
}

export function parseCustomers(raw: unknown): CustomerList {
  const value = record(raw);
  const customers: CustomerItem[] = [];
  for (const entry of list(value["customers"], 5000)) {
    const item = customerItem(entry);
    if (item) customers.push(item);
  }
  return { customers, activeProject: id(value["active"]), activeCustomer: id(value["activeCustomer"]) };
}

export function parseCustomerProjects(raw: unknown): CustomerProjects | null {
  const value = record(raw);
  const customer = customerItem(value["customer"]);
  if (!customer) return null;
  const projects: ProjectItem[] = [];
  for (const entry of list(value["projects"], 5000)) {
    const p = record(entry);
    const projectId = id(p["id"]);
    const name = str(p["name"], 120).trim();
    if (projectId && name) projects.push({ id: projectId, name, date: str(p["date"], 40), place: str(p["place"]) });
  }
  return { customer, projects };
}

export function parseBrief(raw: unknown): Brief {
  const value = record(raw);
  const ideas: OpenIdea[] = [];
  for (const entry of list(value["ideas"], 200)) {
    const idea = record(entry);
    const text = str(idea["text"], 1000).trim();
    if (text) ideas.push({ text, tags: list(idea["tags"], 20).map((tag) => str(tag, 40)).filter(Boolean), project: str(idea["project"], 120) });
  }
  const updated = Number(value["updated"]);
  const memoryRaw = value["memory"];
  return {
    id: id(value["id"]),
    name: str(value["name"], 120),
    company: str(value["company"], 120),
    phone: str(value["phone"], 60),
    email: str(value["email"], 120),
    notes: str(value["notes"], 5000),
    updated: Number.isFinite(updated) && updated > 0 ? updated : 0,
    ideas,
    memory: Array.isArray(memoryRaw)
      ? list(memoryRaw, 5).map((entry) => {
        const m = record(entry);
        return { date: str(m["date"], 40), title: str(m["title"]), summary: str(m["summary"], 1000) };
      }).filter((m) => m.title || m.summary)
      : null,
    memoryError: value["memoryError"] === true,
  };
}

const seconds = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 86_400 ? n : null;
};

export function parseStoryboards(raw: unknown): Storyboard[] {
  const boards: Storyboard[] = [];
  for (const entry of list(record(raw)["storyboards"], 50)) {
    const b = record(entry);
    const boardId = id(b["id"]);
    if (!boardId) continue;
    const scenes: BoardScene[] = list(b["scenes"], 200).map((sceneRaw, index) => {
      const s = record(sceneRaw);
      const n = Number(s["n"]);
      return {
        n: Number.isInteger(n) && n > 0 ? n : index + 1,
        from: seconds(s["from"]),
        to: seconds(s["to"]),
        title: str(s["title"]),
        content: str(s["content"], 2000),
        camera: str(s["camera"], 500),
        overlay: str(s["overlay"], 500),
        goal: str(s["goal"], 500),
        done: s["done"] === true,
      };
    });
    boards.push({ id: boardId, title: str(b["title"]), scenes });
  }
  return boards;
}
