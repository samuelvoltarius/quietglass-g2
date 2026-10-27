import type { TvBackend } from "./backend";
import { clampVolume, type AppEntry, type DpadKey, type TvState } from "./model";

/**
 * A fake TV for the first start (nothing configured) and for the store
 * review: it reacts to every command like a real one, entirely in memory.
 * The glasses and the phone label it DEMO. Nothing goes over the network.
 */

export const DEMO_SOURCES = ["Netflix", "YouTube", "Prime Video", "HDMI 1", "Live TV"] as const;
const TITLES: Record<string, string> = {
  Netflix: "The Night Train", YouTube: "Alpine Lakes in 4K", "Prime Video": "Harbour Lights", "HDMI 1": "", "Live TV": "Evening News",
};

export interface DemoBackend extends TvBackend {
  /** The keys sent so far (tests). */
  readonly keys: readonly DpadKey[];
}

export function createDemo(): DemoBackend {
  const keys: DpadKey[] = [];
  let tv: TvState = {
    name: "Demo TV", power: "on", activity: "playing", app: "Netflix", title: TITLES["Netflix"] ?? null, source: "Netflix",
    volume: 18, muted: false, sources: [...DEMO_SOURCES], apps: [],
  };
  const set = (next: Partial<TvState>): void => { tv = { ...tv, ...next }; };
  const whenOn = (change: () => void): void => { if (tv.power === "on") change(); };

  return {
    kind: "demo",
    dpad: true,
    keys,
    state: async () => tv,
    playPause: async () => whenOn(() => set({ activity: tv.activity === "playing" ? "paused" : "playing" })),
    volumeStep: async (direction) => whenOn(() => set({ volume: clampVolume((tv.volume ?? 0) + direction), muted: false })),
    mute: async (on) => whenOn(() => set({ muted: on })),
    power: async (on) => set(on ? { power: "on", activity: "idle" } : { power: "off", activity: "unknown" }),
    launch: async (entry: AppEntry) => whenOn(() => {
      const known = (DEMO_SOURCES as readonly string[]).includes(entry.id);
      set({ app: entry.id.startsWith("HDMI") || entry.id === "Live TV" ? null : entry.label, source: known ? entry.id : null, title: TITLES[entry.id] || null, activity: "playing" });
    }),
    key: async (key) => { whenOn(() => { keys.push(key); if (key === "HOME") set({ app: null, title: null, source: null, activity: "idle" }); }); },
  };
}
