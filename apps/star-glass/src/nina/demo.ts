import { encodePng } from "../glasses/gfx";
import { starField } from "../glasses/charts";
import type { StarApi } from "./client";
import { parseStatus } from "./status";

/**
 * `?demo=1`: an imaging night without a telescope. M 31 in Ha, 180 s frames,
 * a cooled camera, guiding around 0.6", a meridian flip ahead. Scenes for the
 * alert lines: `&scene=flip` (flip in 6 min), `lost` (guiding lost),
 * `warm` (cooling off), `done` (sequence finished).
 */
export type DemoScene = "run" | "flip" | "lost" | "warm" | "done";

export const DEMO_EXPOSURE_S = 180;
const DEMO_FRAMES = 60;

/** Smooth, repeatable "measurements" (no randomness: screenshots stay stable). */
const wave = (i: number, a: number, b: number): number => Math.sin(i * a) * 0.5 + Math.sin(i * b + 1.3) * 0.5;

export function demoHistory(count = 40): { hfr: number[]; temp: number[]; rms: number[] } {
  const hfr: number[] = [];
  const temp: number[] = [];
  const rms: number[] = [];
  for (let i = 0; i < count; i++) {
    hfr.push(Math.round((2.25 + wave(i, 0.31, 0.83) * 0.22 + (i > 30 ? (i - 30) * 0.03 : 0)) * 100) / 100);
    temp.push(Math.round((-10 + wave(i, 0.7, 1.9) * 0.15) * 10) / 10);
    rms.push(Math.round((0.62 + wave(i, 0.47, 1.21) * 0.14) * 100) / 100);
  }
  return { hfr, temp, rms };
}

export function createDemoNina(now: () => number = Date.now, scene: DemoScene = "run", startFrame = 23): StarApi {
  const started = now();
  const finished = scene === "done";
  let stopped = false;
  return {
    demo: true,
    status: async () => {
      const elapsed = (now() - started) / 1000 + 117;           // 117 s into a frame at start
      const frame = Math.min(DEMO_FRAMES, startFrame + Math.floor(elapsed / DEMO_EXPOSURE_S));
      const into = elapsed % DEMO_EXPOSURE_S;
      const running = !stopped && !finished;
      const history = demoHistory();
      const flip = scene === "flip" ? 6 : Math.max(0, 42 - Math.floor(elapsed / 60));
      return parseStatus({
        online: true,
        version: "demo",
        sequence: running
          ? { state: "running", target: "M 31 Andromeda", step: "Smart Exposure", frame, frames: DEMO_FRAMES }
          : finished
            ? { state: "finished", target: null, step: null, frame: null, frames: null }
            : { state: "idle", target: "M 31 Andromeda", step: null, frame: null, frames: null },
        exposure: running
          ? { active: true, total: DEMO_EXPOSURE_S, remaining: DEMO_EXPOSURE_S - into, progress: Math.round((into / DEMO_EXPOSURE_S) * 100) }
          : { active: false, total: null, remaining: null, progress: null },
        filter: "Ha",
        camera: {
          connected: true, name: "ZWO ASI2600MM Pro", temp: scene === "warm" ? 3.4 : -10.0, setpoint: -10, cooler: scene !== "warm",
          power: scene === "warm" ? 0 : 38, canCool: true, atTarget: scene !== "warm",
        },
        mount: { connected: true, tracking: running, parked: false, slewing: false, alt: 64.2, az: 118.6, flipMinutes: running ? flip : null, pier: "east" },
        focuser: { connected: true, position: 25310, temp: 8.4, moving: false },
        guider: {
          connected: true,
          guiding: scene === "lost" ? false : running,
          rms: scene === "lost" ? 3.8 : history.rms[history.rms.length - 1] ?? 0.62,
          ra: 0.41, dec: 0.47,
        },
        last: {
          index: frame - 2, at: null, type: "LIGHT", filter: "Ha", exposure: DEMO_EXPOSURE_S,
          hfr: history.hfr[history.hfr.length - 1] ?? 2.3, stars: 1842, target: "M 31 Andromeda",
        },
        images: frame - 1,
        history,
        events: scene === "done" ? [{ name: "SEQUENCE-FINISHED", ageSeconds: 95 }] : scene === "lost" ? [{ name: "GUIDER-STOP", ageSeconds: 40 }] : [],
        preview: "demo-" + String(frame - 1),
        controllable: true,
        weather: {
          connected: true, name: "Demo AAG CloudWatcher", cloudCover: 15, rainRate: 0, humidity: 72, dewPoint: 2.1,
          temperature: 6.8, windSpeed: 9, windGust: 16, skyQuality: 20.9,
        },
        safety: { connected: true, safe: true },
      });
    },
    preview: async (key) => encodePng(starField(Number(key.replace(/\D/g, "")) || 1)),
    command: async (command) => {
      if (command === "stop") stopped = true;
      if (command === "start") stopped = false;
    },
  };
}
