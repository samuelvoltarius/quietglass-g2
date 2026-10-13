import type { ImageLane } from "../glasses/lane";
import { encodePng } from "../glasses/pixel";
import { clock, fit } from "../rain/model";
import { baseMapFor } from "./basemap";
import { bitmapKey, composeFrame, splitTiles } from "./frame";
import { RADAR_TILES } from "./layout";
import { frameAt, isStale, loadRadar, syntheticRadar, type RadarData } from "./load";
import { RADAR_ZOOM, type Position } from "./tiles";

/**
 * The radar page's behaviour: when to load, which frame is on screen, and the
 * words around it. It knows nothing about containers or the bridge; the app
 * asks it for text and for the images of the current frame.
 *
 * The loop runs only between `start()` and `stop()` (the page is on screen),
 * one step every 700 ms - and only once the glasses have the previous frame
 * (`imagesIdle`), so a slow Bluetooth link slows the loop down instead of
 * mixing tiles of different frames.
 *
 * As soon as the place is known the base map is on screen, also while the
 * radar loads or when it cannot be reached; the header says which.
 */

export const STEP_MS = 700;
/** A load that takes longer than this counts as failed ("unreachable - tap to retry"). */
export const LOAD_TIMEOUT_MS = 30_000;
/** Place names longer than this are cut in the header. */
const PLACE_WIDTH = 18;
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
  /** True while the app is still looking for the place (first GPS fix). */
  readonly locating?: () => boolean;
  /** True when no radar image is waiting to go to the glasses; the loop only steps then. */
  readonly imagesIdle?: () => boolean;
  readonly loadTimeoutMs?: number;
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
  const load = deps.load ?? ((position: Position) => loadRadar(position, { locale: deps.locale() }));
  const loadTimeout = deps.loadTimeoutMs ?? LOAD_TIMEOUT_MS;
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
    if (!force && !isStale(data, position, now(), deps.locale())) { if (status !== "ready") status = "ready"; return; }
    const mine = ++generation;
    if (!data) status = "loading";
    deps.redraw();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limited = Promise.race([
      load(position),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("radar timed out")), loadTimeout); }),
    ]).finally(() => clearTimeout(timer));
    limited.then(
      (loaded) => { if (mine !== generation) return; data = loaded; tick = 0; status = "ready"; deps.redraw(); },
      () => {
        if (mine !== generation) return;
        if (deps.demo) { data = syntheticRadar(position, now(), RADAR_ZOOM, deps.locale()); tick = 0; status = "ready"; deps.redraw(); return; }
        // Old pictures stay up when a reload fails; only a first load shows the error.
        status = data ? "ready" : "error"; deps.redraw();
      },
    );
  };

  const stopTimer = (): void => { clearInterval(timer); timer = undefined; };

  /** The base map alone (no rain), shown while there is no radar picture; drawn once per place. */
  let mapOnly: { key: string; tiles: ReturnType<typeof splitTiles>; keys: string[] } | null = null;
  const baseTiles = (position: Position): NonNullable<typeof mapOnly> => {
    const base = baseMapFor(position, RADAR_ZOOM, deps.locale());
    if (mapOnly?.key !== base.key) {
      const tiles = splitTiles(composeFrame(position, () => null, RADAR_ZOOM, base));
      mapOnly = { key: base.key, tiles, keys: tiles.map(bitmapKey) };
    }
    return mapOnly;
  };
  /** The nearest town for the header, or "". */
  const placeLabel = (position: Position | null): string => {
    if (!position) return "";
    const nearest = baseMapFor(position, RADAR_ZOOM, deps.locale()).nearest;
    return nearest ? fit(nearest, PLACE_WIDTH) : "";
  };

  return {
    status: () => status,
    start() {
      if (running) return;
      running = true;
      begin(false);
      stopTimer();
      timer = setInterval(() => {
        if (status !== "ready" || !data) return;
        // Bluetooth first: the next frame only once the last one is on the glasses.
        if (deps.imagesIdle && !deps.imagesIdle()) return;
        tick += 1; deps.redraw();
      }, STEP_MS);
    },
    stop() { running = false; stopTimer(); },
    reload() { begin(true); },
    frameIndex: () => (data ? frameAt(tick, data.frames.length) : 0),
    text() {
      const title = deps.t("radar");
      const footer = fit(`${deps.t("radarCredit")} · ${deps.t("radarControls")}`, FULL_WIDTH);
      const position = data?.position ?? deps.position();
      const place = placeLabel(position);
      const head = (rest: string): string => fit([title, place, rest].filter(Boolean).join("  "), FULL_WIDTH);
      if (status === "ready" && data && data.frames.length > 0) {
        const index = frameAt(tick, data.frames.length);
        const frame = data.frames[index]!;
        const dots = data.frames.map((_, i) => (i === index ? "●" : "○")).join("");
        const sample = data.synthetic ? ` ${deps.t("radarSample")}` : "";
        return { header: head(`${clock(new Date(frame.time * 1000).toISOString(), deps.locale())}  ${dots}${sample}`), note: "", footer };
      }
      // With a place the map is on screen: the state goes into the header, the middle stays free.
      if (position && status === "error") return { header: fit(`${title}  ${deps.t("radarErrorShort")}`, FULL_WIDTH), note: "", footer };
      if (position && status !== "noLocation") return { header: head(deps.t("radarLoadingShort")), note: "", footer };
      const note = deps.locating?.() ? deps.t("radarLocating") : status === "error" ? deps.t("radarError") : status === "loading" ? deps.t("radarLoading") : deps.t("radarNoLocation");
      return { header: fit(title, FULL_WIDTH), note, footer };
    },
    requestImages(lane) {
      if (status === "ready" && data) {
        const frame = data.frames[frameAt(tick, data.frames.length)];
        if (!frame) return;
        RADAR_TILES.forEach((target, index) => lane.request(target, `r:${frame.keys[index]}`, () => encodePng(frame.tiles[index]!)));
        return;
      }
      // No radar (yet): the map alone, so the page is never empty once the place is known.
      const position = deps.position();
      if (!position) return;
      const map = baseTiles(position);
      RADAR_TILES.forEach((target, index) => lane.request(target, `r:${map.keys[index]}`, () => encodePng(map.tiles[index]!)));
    },
  };
}
