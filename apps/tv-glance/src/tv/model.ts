/**
 * What TV Glance knows about the TV, the same for every backend (Home
 * Assistant, the Android TV bridge, the demo). Pure data, no I/O.
 */

export type Power = "on" | "off" | "unknown";

/** What the TV is doing, as far as the backend can tell. */
export type Activity = "playing" | "paused" | "idle" | "unknown";

export interface TvState {
  /** A name for the TV (friendly name in Home Assistant, the bridge's device name). */
  readonly name: string;
  readonly power: Power;
  readonly activity: Activity;
  /** The running app ("Netflix"), when reported. */
  readonly app: string | null;
  /** What is playing ("The Crown"), when reported. */
  readonly title: string | null;
  /** The selected input or source ("HDMI 1"), when reported. */
  readonly source: string | null;
  /** 0..100, or null when the TV does not report it. */
  readonly volume: number | null;
  readonly muted: boolean | null;
  /** Sources/apps the TV offers to switch to (Home Assistant `source_list`). */
  readonly sources: readonly string[];
  /** Apps the backend itself offers (the bridge's TV_APPS). */
  readonly apps: readonly AppEntry[];
  /** Home Assistant reports the device as `unavailable` (projector asleep, TV unplugged): nothing can be sent. */
  readonly unavailable?: boolean;
}

export const UNKNOWN_STATE: TvState = {
  name: "", power: "unknown", activity: "unknown", app: null, title: null, source: null, volume: null, muted: null, sources: [], apps: [],
};

/** The keys of the D-pad list (the names the Android TV Remote integration and androidtvremote2 use). */
export const DPAD_KEYS = ["DPAD_UP", "DPAD_DOWN", "DPAD_LEFT", "DPAD_RIGHT", "DPAD_CENTER", "BACK", "HOME"] as const;
export type DpadKey = (typeof DPAD_KEYS)[number];

export function isDpadKey(value: unknown): value is DpadKey {
  return typeof value === "string" && (DPAD_KEYS as readonly string[]).includes(value);
}

/** One entry of the configurable app list: a label for the glasses and the id the backend launches. */
export interface AppEntry {
  readonly label: string;
  /** Home Assistant: a source name or an app id for `play_media`; bridge: a package name or app link. */
  readonly id: string;
}

/**
 * Parses the app list typed on the phone: one entry per line, `Label=id` or
 * just `id` (then the id is the label too). Empty lines and duplicates go.
 */
export function parseAppList(text: string): AppEntry[] {
  const out: AppEntry[] = [];
  for (const raw of text.split(/\r?\n|;/)) {
    const line = raw.trim();
    if (!line) continue;
    const at = line.indexOf("=");
    const label = (at > 0 ? line.slice(0, at) : line).trim();
    const id = (at > 0 ? line.slice(at + 1) : line).trim();
    if (!label || !id || out.some((entry) => entry.id === id)) continue;
    out.push({ label: label.slice(0, 40), id: id.slice(0, 200) });
    if (out.length >= 20) break;
  }
  return out;
}

export function formatAppList(entries: readonly AppEntry[]): string {
  return entries.map((entry) => (entry.label === entry.id ? entry.id : `${entry.label}=${entry.id}`)).join("\n");
}

/** Clamps a volume to 0..100 (whole numbers), or null. */
export function clampVolume(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

/**
 * What the "Apps & input" list offers: the TV's sources, the backend's apps
 * and the apps configured on the phone, without duplicates (by id), at most 12.
 */
export function launchEntries(state: TvState, configured: readonly AppEntry[]): AppEntry[] {
  const out: AppEntry[] = [];
  const add = (entry: AppEntry): void => { if (!out.some((item) => item.id === entry.id)) out.push(entry); };
  for (const source of state.sources) add({ label: source, id: source });
  for (const entry of state.apps) add(entry);
  for (const entry of configured) add(entry);
  return out.slice(0, 12);
}
