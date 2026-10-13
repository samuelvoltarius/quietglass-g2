import type { ImageLane } from "../glasses/lane";
import { encodePng } from "../glasses/pixel";
import { clock, fit } from "../rain/model";
import { RADAR_TILES } from "./frame";
import { frameAt, isStale, loadRadar, syntheticRadar, type RadarData } from "./load";
import type { Position } from "./tiles";

/**
 * The radar page's behaviour: when to load, which frame is on screen, and the
 * words around it. It knows nothing about containers or the bridge; the app
 * asks it for text and for the images of the current frame.
 *
 * The loop runs only between `start()` and `stop()` (the page is on screen),
 * one step every 700 ms.
 */

export const STEP_MS = 700;
const FULL_WIDTH = 56;

export type RadarStatus = "idle" | "loading" | "ready" | "noLocation" | "error";

export interface RadarText { readonly header: string; readonly note: string; readonly footer: string; }

export interface RadarDeps {
  /** The place the forecast is for, or null while there is none. */
  readonly position: () => Position | null;
  readonly t: (key: string, vars?: Record<string, string | number>) => string;
  readonly locale: () => string;
  /** Asks the app to draw the radar page again. */
  readonly redraw: () => void;
  readonly load?: (position: Position) => Promise<RadarData>;
  readonly now?: () => number;
  /** With ?demo=1 a failed load falls back to a made-up radar, so the page can be tried offline. */
  readonly demo?: boolean;
}

export interface RadarSession {
  status(): RadarStatus;
  /** The page came on screen: load if needed, start the loop. */
  start(): void;
  /** The page left the screen: stop the loop. */
  stop(): void;
  /** A tap: load again. */
  reload(): void;
  text(): RadarText;
  /** Asks the lane for the four pieces of the current frame; unchanged pieces cost nothing. */
  requestImages(lane: ImageLane): void;
  /** Frame on screen, for tests. */
  frameIndex(): number;
}

export function createRadarSession(deps: RadarDeps): RadarSession {
  const load = deps.load ?? ((position: Position) => loadRadar(position));
  const now = deps.now ?? Date.now;
  let status: RadarStatus = "idle";
  let data: RadarData | null = null;
  let tick = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;
  /** Bumped per load, so a slow answer for an old place never replaces a newer one. */
  let generation = 0;

  const begin = (force: boolean): void => {
    const position = deps.position();
    if (!position) { status = "noLocation"; deps.redraw(); return; }
    if (!force && !isStale(data, position, now())) { if (status !== "ready") status = "ready"; return; }
    const mine = ++generation;
    if (!data) status = "loading";
    deps.redraw();
    load(position).then(
      (loaded) => { if (mine !== generation) return; data = loaded; tick = 0; status = "ready"; deps.redraw(); },
      () => {
        if (mine !== generation) return;
        if (deps.demo) { data = syntheticRadar(position, now()); tick = 0; status = "ready"; deps.redraw(); return; }
        // Old pictures stay up when a reload fails; only a first load shows the error.
        status = data ? "ready" : "error"; deps.redraw();
      },
    );
  };

  const stopTimer = (): void => { clearInterval(timer); timer = undefined; };

  return {
    status: () => status,
    start() {
      if (running) return;
      running = true;
      begin(false);
      stopTimer();
      timer = setInterval(() => { if (status === "ready" && data) { tick += 1; deps.redraw(); } }, STEP_MS);
    },
    stop() { running = false; stopTimer(); },
    reload() { begin(true); },
    frameIndex: () => (data ? frameAt(tick, data.frames.length) : 0),
    text() {
      const title = `RAINLENS  ${deps.t("radar")}`;
      const footer = fit(`${deps.t("radarCredit")} · ${deps.t("radarControls")}`, FULL_WIDTH);
      if (status === "ready" && data && data.frames.length > 0) {
        const index = frameAt(tick, data.frames.length);
        const frame = data.frames[index]!;
        const dots = data.frames.map((_, i) => (i === index ? "●" : "○")).join("");
        const sample = data.synthetic ? ` ${deps.t("radarSample")}` : "";
        return { header: fit(`${title}  ${clock(new Date(frame.time * 1000).toISOString(), deps.locale())}  ${dots}${sample}`, FULL_WIDTH), note: "", footer };
      }
      const note = status === "noLocation" ? deps.t("radarNoLocation") : status === "error" ? deps.t("radarError") : deps.t("radarLoading");
      return { header: fit(title, FULL_WIDTH), note, footer };
    },
    requestImages(lane) {
      if (status !== "ready" || !data) return;
      const frame = data.frames[frameAt(tick, data.frames.length)];
      if (!frame) return;
      RADAR_TILES.forEach((target, index) => lane.request(target, `r:${frame.keys[index]}`, () => encodePng(frame.tiles[index]!)));
    },
  };
}
