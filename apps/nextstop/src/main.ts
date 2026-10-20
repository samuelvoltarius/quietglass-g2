import {
  AppLocationAccuracy, AudioInputSource, waitForEvenAppBridge, type AppLocation, type EvenAppBridge,
} from "@evenrealities/even_hub_sdk";
import { HafasBackend } from "./transit/hafas";
import { MotisBackend } from "./transit/motis";
import type { Departure, Ride, Stop, TransitBackend } from "./transit/types";
import { delayMinutes, metresBetween, minutesUntil } from "./transit/types";
import type { Position } from "./ride/tracker";
import { boardingIndex, followRide } from "./ride/follow";
import { gestureFromEvent, menuItemIdFromEvent } from "./input/gestures";
import { bySoonest, messageScene } from "./glasses/board";
import { followLoadingScene, followScene } from "./cockpit/follow";
import { boardScene } from "./cockpit/scene";
import { liveWord, startRows, startView } from "./start";
import { sameScene } from "./glasses/diff";
import { createPage, forgetPage, rebuildPage, updatePage } from "./glasses/render";
import { load, save, type Settings } from "./storage/persist";
import { loadSession, saveSession, type SavedSession } from "./storage/session";
import { lifecycleFromEvent } from "./lifecycle";
import { mountPhoneUi } from "./ui/phone";
import { buildTtsUrl, DEFAULT_VOICES, ServerTts } from "./speech/server-tts";
import { Companion } from "./speech/companion";
import { createExitRequest, isBackSignal, settleRestore } from "./exit";
import { explainFailure, glassesText, noStopsHint, type Explanation } from "./text";
import { resolveLocale, rememberLocale, setLocale, type Locale } from "./i18n";
import { t } from "./messages";
import type { Destination, Journey, TransitLeg } from "./route/journey";
import { buildWav } from "./audio/wav";
import { MAX_VOICE_MS, MIN_VOICE_BYTES, pcmBytes, sttBase, transcribe } from "./voice/stt";
import { chooseTranscript, liveSttUrl, LIVE_REDRAW_MS, openLiveStt, shouldRedraw, type LiveSession } from "./voice/live-stt";
import { addFavorite, loadPlaces, savePlaces, targetsOf, type Places, type Target } from "./route/places";
import { estimatedArrival, guideState, buildSteps, stepBy, withFreshTimes, withLeg, type Step, type StepOverride } from "./route/guide";
import { helpView, placesView, voiceView, type VoiceState } from "./route/view";
import { armedFooter, ft } from "./footer";
import { planScene } from "./route/plan-scene";
import { BEAT_MS, beatOf, guideScene, plainScene, type Scene } from "./route/scene";
import { MENU, menuFor, type Screen } from "./route/menu";

/**
 * The glasses' side menu. Off: its clicks never reach the app on the real glasses, and while a page carries a
 * menu the hold opens it instead of reaching the app (step log of 15.10.2026). Without it the departure list
 * ends with "Hilfe" again and a hold in the guidance arms "stop guidance" (one more tap carries it out).
 */
const SIDE_MENU = false;
import type { Planner } from "./route/planner";
import { DEMO_PLACES, DEMO_POSITION, demoBackend, demoFromUrl, demoPlanner, demoPosition, demoWalkRoute } from "./demo/demo";
import { OFF_ROUTE_METRES, fetchWalkRoute, project, walkNav, type WalkNav, type WalkRoute } from "./route/walk";
import { cameraFor, settleView, type Settled } from "./map/camera";
import { classesFor, containsBox, createStreetSource, legBox, type BBox, type Street } from "./map/streets";
import type { WalkMapInput } from "./map/draw";

/**
 * NextStop.
 *
 * Two screens. Standing somewhere: what leaves from the stop you are at.
 * Sitting in a vehicle: which stop is next and when to get off.
 *
 * Everything on screen is re-derived from the position, the clock and the
 * last answer received. Nothing counts stops as they go by, so a missed GPS
 * update or a backgrounded app costs one frame rather than the rest of the
 * journey.
 */

/**
 * A position supplied in the URL, for development only.
 *
 *     http://127.0.0.1:5201/?at=47.8060,13.0430
 *
 * The simulator has no GPS at all, so without this the app can only ever be
 * seen saying "Warte auf deinen Standort" and the actual board never appears on a desk.
 * It is off unless the parameter is present, a real fix always overrides it,
 * and the phone app states plainly when it is in use — an invented position
 * that looked like a measured one would be exactly the kind of quiet lie this
 * app exists to avoid.
 */
export function positionFromUrl(search: string): Position | null {
  const raw = new URLSearchParams(search).get("at");
  if (!raw) return null;
  const [lat, lon] = raw.split(",").map((part) => Number(part.trim()));
  if (lat === undefined || lon === undefined) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

/** How long the first location answer may take before the app goes on without it. */
const FIRST_FIX_MS = 10000;
/** A request that has not been answered by then is reported as a failure the passenger can tap away. */
const RIDE_TIMEOUT_MS = 15000;
/** The glasses' microphone answers within this, or the voice page says it is not available. */
const MIC_TIMEOUT_MS = 5000;

/** Rejects when the promise has not settled in time; the promise itself runs on. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${ms} ms`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

async function boot(): Promise<void> {
  const bridge: EvenAppBridge = await waitForEvenAppBridge();

  const search = globalThis.location?.search ?? "";
  const demo = demoFromUrl(search);
  /** The clock of everything on screen; only the demo ever runs it ahead. */
  const startedAt = Date.now();
  const clock = (): Date => demo.offsetMinutes === 0 && demo.speed === 1
    ? new Date()
    : new Date(Date.now() + demo.offsetMinutes * 60000 + (Date.now() - startedAt) * (demo.speed - 1));
  const recorded: unknown = demo.enabled ? (await import("./demo/plan-salzburg.json")).default : null;

  let settings: Settings = await load(bridge);

  // Spoken guidance: Piper server voice (private build: VITE_TTS_URL), phone voice as fallback.
  const tts = new ServerTts({ url: buildTtsUrl(), voices: DEFAULT_VOICES });
  const companion = new Companion();
  let journeyId = 0;
  const seeded = positionFromUrl(search) ?? (demo.enabled ? { ...DEMO_POSITION } : null);
  let position: Position | null = seeded;

  let stops: readonly Stop[] = [];
  let stopIndex = 0;
  let departures: readonly Departure[] = [];
  let selected = 0;

  let locale: Locale = demo.locale ?? await resolveLocale(bridge);
  setLocale(locale);

  /** Destinations: favourites and the "go now" target. Demo mode never writes. */
  let places: Places = demo.enabled ? DEMO_PLACES : await loadPlaces(bridge);
  let placeIndex = 0;
  /** Which entry of the start page is marked. */
  let startCursor = 0;

  /**
   * What the glasses say is kept as a function of the language rather than as
   * finished text, so switching the language on the phone redraws the very
   * same message in the other language at once.
   */
  type Say = (locale: Locale) => Explanation;
  /**
   * The bus picked on the board, from the tap on. It exists while its stops
   * are still being fetched, so the glasses answer the tap at once instead of
   * showing the unchanged board until the network has replied.
   */
  interface FollowState {
    readonly departure: Departure;
    readonly stop: Stop;
    readonly status: "loading" | "ready" | "error";
    readonly ride: Ride | null;
    /** Index of the passenger's stop in `ride.stops`, -1 when it is not found. */
    readonly boarding: number;
    readonly error?: Say;
  }
  let following: FollowState | null = null;
  let error: Say | null = null;
  let busy: Say = (lang) => ({ error: glassesText(lang).searching, hint: "" });

  // The route pages: which one is open, the connections found, the guide.
  let screen: Screen = "start";
  interface PlanState {
    readonly target: Destination;
    readonly status: "loading" | "ready" | "error";
    readonly journeys: readonly Journey[];
    readonly selected: number;
    readonly error?: Say;
  }
  let plan: PlanState | null = null;
  let planSeq = 0;
  interface GuideSession {
    readonly journey: Journey;
    readonly steps: readonly Step[];
    readonly override: StepOverride | null;
    readonly target: Destination;
  }
  let guide: GuideSession | null = null;
  /**
   * QIS v1: what a first single tap (or the menu entry "Begleitung beenden") has armed. The next
   * single tap within ARM_MS carries it out; a swipe, a 2x, a hold or the timeout cancels it.
   */
  type ArmKind = "follow" | "stopGuide" | "search" | "saveVoice" | "again";
  let armed: { readonly kind: ArmKind; readonly until: number } | null = null;
  let armTimer: ReturnType<typeof setTimeout> | null = null;
  const ARM_MS = 4000;
  const isArmed = (kind: ArmKind): boolean => armed !== null && armed.kind === kind && armed.until > Date.now();
  const disarm = (): void => {
    armed = null;
    if (armTimer !== null) clearTimeout(armTimer);
    armTimer = null;
  };
  let guideTimer: ReturnType<typeof setInterval> | null = null;

  // Spoken destination: the recording, the state of the voice page.
  let voice: VoiceState | null = null;
  let voiceSeq = 0;
  let micActive = false;
  let recordTimer: ReturnType<typeof setTimeout> | null = null;
  const micChunks: Uint8Array[] = [];
  /** Live recognition of the recording in progress (private build: VITE_LIVE_STT_URL), and its redraw throttle. */
  let live: LiveSession | null = null;
  let liveShown = "";
  let liveShownAt = 0;
  let liveTimer: ReturnType<typeof setTimeout> | null = null;

  let lastScene: Scene | null = null;
  /** Menu and page kind of the page on the glasses: when it changes, the page is rebuilt. */
  let menuKey = "";
  let lastKind: Scene["kind"] = "text";
  let pageReady = false;
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  let tickTimer: ReturnType<typeof setInterval> | null = null;
  let beatTimer: ReturnType<typeof setInterval> | null = null;
  let closed = false;
  /** Left through the system: no GPS, no microphone, no timers, nothing drawn until the app is back. */
  let backgrounded = false;
  /** The stop picked before a restart, chosen again once the nearby stops are known. */
  let wantedStopId: string | null = null;
  /**
   * Every request for the board or a ride takes a number; an answer that comes
   * back after a newer request was started is dropped. Without it, holding to
   * switch stops while the old stop's board was still loading put the old
   * stop's departures under the new stop's name.
   */
  let requestSeq = 0;
  /** The newest request that has finished; the timer refresh waits for it. */
  let settledSeq = 0;
  const settle = (seq: number): void => { if (seq === requestSeq) settledSeq = seq; };

  const backend = (): TransitBackend => demo.enabled
    ? demoBackend(clock)
    : settings.backend === "motis"
      ? new MotisBackend({ baseUrl: settings.motisUrl })
      : new HafasBackend({ baseUrl: settings.oebbUrl });

  /**
   * Connections and place search always go to MOTIS, whatever the board uses.
   * The demo plans from the real time while the screens may run ahead of it,
   * so that `t=` can step through a guide that was planned just now.
   */
  const planner = (): Planner => demo.enabled
    ? demoPlanner(recorded, () => new Date())
    : new MotisBackend({ baseUrl: settings.motisUrl });

  /**
   * Where the guide thinks the passenger is. The demo's position is a fixed
   * pin used only to plan from, so the guide runs on the demo clock instead of
   * pretending that pin is a GPS fix of someone standing still.
   */
  const guidePosition = (): Position | null => {
    if (!demo.enabled) return position;
    return guide ? demoPosition(guide.journey, clock()) : null;
  };

  // The walking route of the step on screen, and when it was worked out.
  interface WalkState {
    readonly key: string;
    readonly route: WalkRoute | null;
    readonly fetchedAt: number;
    readonly loading: boolean;
  }
  let walkState: WalkState | null = null;
  let reroutedUntil = 0;
  const walkKey = (leg: { toLat: number; toLon: number; start: Date }): string => `${leg.toLat},${leg.toLon},${leg.start.getTime()}`;
  const fetchWalk = (from: { lat: number; lon: number }, to: { lat: number; lon: number }): Promise<WalkRoute | null> =>
    demo.enabled
      ? Promise.resolve(demoWalkRoute(from, to))
      : fetchWalkRoute(from, to, { language: locale });

  /** What the walking page shows: where the walker is on the route of the current step. */
  const walkDisplay = (state: ReturnType<typeof guideState>, at: Position | null): WalkNav | null => {
    if (state.step.kind !== "walk" || !at || !walkState?.route) return null;
    if (walkState.key !== walkKey(state.step.leg)) return null;
    return walkNav(walkState.route, at);
  };

  // The streets behind the walking map: fetched once per walking leg (and again only when a reroute leaves
  // the area loaded), bounded to a few seconds. A failure leaves the map with route and markers alone.
  interface StreetState {
    readonly key: string;
    readonly box: BBox;
    readonly status: "loading" | "done" | "failed";
    readonly streets: readonly Street[];
  }
  let streetState: StreetState | null = null;
  const streetSource = createStreetSource();
  // The map view that is on the glasses: it moves on only when the walker moved noticeably (src/map/camera.ts).
  let mapSettled: { readonly key: string; readonly settled: Settled } | null = null;

  /** The map of the walking page: the route, the target and the streets, at the view that was settled on. */
  const walkMap = (state: ReturnType<typeof guideState>, at: Position | null): WalkMapInput | null => {
    if (state.step.kind !== "walk" || !at || !walkState?.route) return null;
    if (walkState.key !== walkKey(state.step.leg)) return null;
    const leg = state.step.leg;
    const shape = walkState.route.shape;
    const target = { lat: leg.toLat, lon: leg.toLon };
    const key = `${walkState.key}@${walkState.fetchedAt}`;
    const settled = settleView(mapSettled?.key === key ? mapSettled.settled : null, cameraFor(shape, at, target), Date.now());
    mapSettled = { key, settled };
    const streets = streetState?.key === walkState.key && streetState.streets.length > 0 ? streetState.streets : null;
    const nav = walkNav(walkState.route, at);
    const turnAt = nav.next.type === "arrive" ? null : shape[nav.nextShapeIndex ?? nav.next.shapeIndex] ?? null;
    return {
      view: settled.view, shape, target, targetKind: leg.toDestination ? "goal" : "stop",
      turn: turnAt, nextStreet: nav.next.type === "arrive" ? undefined : nav.next.street, currentStreet: nav.current,
      streets, routeKey: key, streetsKey: streets ? `${walkState.key}:${streets.length}` : "none",
    };
  };

  const currentStop = (): Stop | undefined => stops[stopIndex];
  const targets = (): readonly Target[] => targetsOf(places);

  /** Everything the board screen shows: the board, a followed bus, waiting and failures - one page shape. */
  const boardPage = (): Scene => {
    const now = clock();
    if (following) {
      const current = following;
      if (current.status === "loading") return followLoadingScene(current.departure, now, locale, current.stop.name);
      if (current.status === "ready" && current.ride) {
        const state = followRide(current.ride, current.boarding, current.departure.expected, now, position);
        if (state) return followScene(current.departure, state, now, locale, isArmed("follow"));
      }
      const said = current.error?.(locale) ?? { error: glassesText(locale).noRide, hint: glassesText(locale).noRideHint };
      return messageScene(said.error, said.hint, ft(locale, "exit", { tap: "back" }), "!");
    }

    if (error) {
      const { error: message, hint } = error(locale);
      return messageScene(message, hint, ft(locale, "back", { tap: "again" }), "!");
    }

    const stop = currentStop();
    if (!stop) {
      const { error: what, hint } = busy(locale);
      return messageScene(what, hint, ft(locale, "back"), "...");
    }

    const away = position
      ? metresBetween(position.lat, position.lon, stop.lat, stop.lon)
      : null;
    return boardScene(stop, departures, away, locale, selected, now);
  };

  const planPage = (state: PlanState): Scene => {
    if (state.status === "loading") {
      return messageScene(t(locale, "r.searchingPlans"), state.target.name, ft(locale, "back"), "...");
    }
    if (state.status === "error" || state.journeys.length === 0) {
      const { error: message, hint } = state.error
        ? state.error(locale)
        : { error: t(locale, "r.noPlans"), hint: t(locale, "r.noPlansHint") };
      return messageScene(message, hint, ft(locale, "back", { tap: "again" }), "!");
    }
    return planScene(state.journeys, state.selected, clock(), locale);
  };

  /** The same page with another footer row (the armed row). */
  const withFooter = (scene: Scene, footer: string): Scene => ({ ...scene, view: { ...scene.view, footer } });

  const currentScene = (): Scene => {
    if (screen === "start") {
      return plainScene(startView(startCursor, {
        locale, stopName: currentStop()?.name ?? null,
        word: liveWord({ demo: demo.enabled, hasPosition: position !== null, failed: error !== null && departures.length === 0 }),
      }));
    }
    if (screen === "help") return plainScene(helpView(locale));
    if (screen === "places") return plainScene(placesView(targets(), placeIndex, clock(), locale));
    if (screen === "plans" && plan) {
      const page = planPage(plan);
      return isArmed("again") ? withFooter(page, armedFooter(locale, t(locale, "q.search"))) : page;
    }
    if (screen === "voice" && voice) {
      const page = plainScene(voiceView(voice, clock(), locale));
      return isArmed("saveVoice") ? withFooter(page, armedFooter(locale, t(locale, "q.save"))) : page;
    }
    if (screen === "guide" && guide) {
      const now = clock();
      const at = guidePosition();
      const state = guideState(guide.steps, now, at, guide.override);
      return guideScene(state, now, at, locale, {
        armed: isArmed("stopGuide") ? "stop" : isArmed("search") ? "search" : undefined,
        walk: walkDisplay(state, at),
        map: walkMap(state, at),
        arrival: estimatedArrival(guide.journey),
        rerouted: reroutedUntil > Date.now(),
        beat: beatOf(Date.now()),
      });
    }
    return boardPage();
  };

  // While the exit dialog may be on screen (asked, no input since) no timer, poll or stream may draw: a page call
  // could cover it. Data keeps being collected; the back signal restores the page the way of the first one.
  let exitAsked = (): boolean => false;
  const drawOnce = async (): Promise<void> => {
    if (exitAsked()) return;
    // After the double tap the page is gone; drawing again would bring it back.
    if (closed || backgrounded) return;
    const scene = currentScene();
    // The key still names the language and the page, so each page change (and a language change) rebuilds once, menu or not.
    const menu = SIDE_MENU ? menuFor(screen, locale) : { key: `${locale}:${screen}`, items: [] };
    const layout = `${menu.key}|${scene.kind}`;
    if (sameScene(lastScene, scene) && layout === menuKey) return;

    let result;
    if (!pageReady) {
      result = await createPage(bridge, scene, menu);
      if (result.ok) { menuKey = layout; lastKind = scene.kind; }
    } else if (layout !== menuKey) {
      // Another page means another menu or other pictures: the one reason to rebuild.
      const kindChanged = scene.kind !== lastKind;
      menuKey = layout;
      lastKind = scene.kind;
      result = await rebuildPage(bridge, scene, menu);
      if (!result.ok) {
        console.warn("[nextstop] page rebuild failed:", result.reason);
        // Pictures cannot be updated into a page that was not rebuilt; try creating it afresh.
        result = kindChanged ? await createPage(bridge, scene, menu) : await updatePage(bridge, scene);
      }
    } else {
      result = await updatePage(bridge, scene);
    }
    if (closed) return;
    // A picture that did not go through is sent again with the next draw.
    if (result.ok) { pageReady = true; lastScene = result.partial ? null : scene; return; }
    pageReady = false;
    menuKey = "";
    console.warn("[nextstop] draw failed:", result.reason);
  };

  /** One draw at a time; requests made meanwhile collapse into one more. */
  let drawing: Promise<void> | null = null;
  let redrawQueued = false;
  const draw = (): Promise<void> => {
    if (exitAsked()) return Promise.resolve();
    if (drawing) { redrawQueued = true; return drawing; }
    drawing = (async () => {
      do {
        redrawQueued = false;
        await drawOnce();
      } while (redrawQueued && !closed);
    })().finally(() => { drawing = null; });
    return drawing;
  };

  /** Turns a thrown failure into something a passenger can act on. */
  const sayFailure = (thrown: unknown): Say => {
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    console.warn("[nextstop] request failed:", message);
    const backendId = settings.backend;
    return (lang) => explainFailure(message, backendId, lang);
  };
  const explain = (thrown: unknown): void => { error = sayFailure(thrown); };

  const loadDepartures = async (seq = ++requestSeq): Promise<void> => {
    const stop = currentStop();
    if (!stop) { settle(seq); return; }
    try {
      const next = await withTimeout(backend().departures(stop.id, 12), RIDE_TIMEOUT_MS);
      if (seq !== requestSeq) return;
      // Soonest first by the time now expected, and the selection stays on the
      // same bus when a refresh reorders the board under the passenger's eyes.
      const kept = departures[selected]?.tripId;
      departures = bySoonest(next);
      const again = kept ? departures.findIndex((departure) => departure.tripId === kept) : -1;
      selected = again >= 0 ? again : Math.min(selected, Math.max(0, departures.length - 1));
      error = null;
    } catch (thrown) {
      if (seq !== requestSeq) return;
      // A failed refresh of a board already on screen keeps the board: its
      // minutes are worked out from the clock and stay right for a while, and
      // the next refresh comes in half a minute. Only an empty board says why.
      if (departures.length > 0) console.warn("[nextstop] refresh failed, board kept:", thrown instanceof Error ? thrown.message : String(thrown));
      else explain(thrown);
    }
    settle(seq);
    await draw();
  };

  const findStops = async (): Promise<void> => {
    const seq = ++requestSeq;
    if (!position) {
      busy = (lang) => ({ error: glassesText(lang).waitingForLocation, hint: glassesText(lang).waitingHint });
      settle(seq);
      await draw();
      return;
    }
    busy = (lang) => ({ error: glassesText(lang).searching, hint: "" });
    await draw();
    try {
      const found = await withTimeout(backend().nearbyStops(position.lat, position.lon, 5), RIDE_TIMEOUT_MS);
      if (seq !== requestSeq) return;
      stops = found;
      departures = [];
      // Back at the stop picked before a restart, when it is still among the nearby ones.
      const again = wantedStopId ? stops.findIndex((stop) => stop.id === wantedStopId) : -1;
      wantedStopId = null;
      stopIndex = Math.max(0, again);
      selected = 0;
      const backendId = settings.backend;
      error = stops.length === 0
        ? (lang) => ({ error: glassesText(lang).noStops, hint: noStopsHint(backendId, lang) })
        : null;
    } catch (thrown) {
      if (seq !== requestSeq) return;
      explain(thrown);
    }
    await loadDepartures(seq);
  };

  /**
   * Tap on the board: follow the selected bus. The page answers at once
   * (same page shape, only words and pictures change), the stops of the ride
   * follow when they arrive, and a failure or a timeout is shown rather than
   * left as a board that seems to ignore the tap.
   */
  const startFollow = async (picked?: { departure: Departure; stop: Stop }): Promise<void> => {
    const departure = picked?.departure ?? departures[selected];
    const stop = picked?.stop ?? currentStop();
    if (!departure || !stop) return;
    const seq = ++requestSeq;
    following = { departure, stop, status: "loading", ride: null, boarding: -1 };
    void draw();
    let next: FollowState;
    try {
      const loaded = await withTimeout(backend().ride(departure.tripId), RIDE_TIMEOUT_MS);
      next = loaded
        ? { departure, stop, status: "ready", ride: loaded, boarding: boardingIndex(loaded, stop, departure.expected) }
        : { departure, stop, status: "error", ride: null, boarding: -1 };
    } catch (thrown) {
      next = { departure, stop, status: "error", ride: null, boarding: -1, error: sayFailure(thrown) };
    }
    if (seq !== requestSeq || following?.departure !== departure) return;
    following = next;
    settle(seq);
    await draw();
  };

  /** Fresh times for the followed bus (delays move); a failure keeps what is there. */
  const refreshFollow = async (): Promise<void> => {
    const current = following;
    if (!current || current.status !== "ready" || !current.ride) return;
    try {
      const loaded = await withTimeout(backend().ride(current.departure.tripId), RIDE_TIMEOUT_MS);
      if (following !== current || !loaded) return;
      following = { ...current, ride: loaded, boarding: boardingIndex(loaded, current.stop, current.departure.expected) };
      void draw();
    } catch {
      // The times already shown stay; the next refresh tries again.
    }
  };

  /** Back to the board: the departures already held show at once, fresh ones follow. */
  const stopFollow = async (): Promise<void> => {
    following = null;
    error = null;
    void draw();
    await loadDepartures();
  };

  // ---- route: destinations, connections, guide -----------------------------

  const stopGuideTimer = (): void => {
    if (guideTimer !== null) clearInterval(guideTimer);
    guideTimer = null;
    // Whatever was being said belongs to the journey that just ended.
    tts.stop();
    companion.reset();
  };

  /** The companion's next spoken line for the guide on screen, if there is one. */
  const announce = (): void => {
    if (closed || backgrounded || screen !== "guide" || !guide || !settings.announce || demo.enabled) return;
    const now = clock();
    const at = guidePosition();
    const state = guideState(guide.steps, now, at, guide.override);
    const a = companion.next({ journeyId, state, now, walk: walkDisplay(state, at), locale, hasFix: at !== null });
    if (a) tts.speak(a.text, { lang: locale, priority: a.priority, key: a.key, maxAgeMs: a.maxAgeMs });
  };
  const voiceState = (): "needs-tap" | "server" | "browser" | "off" => {
    if (!settings.announce || !tts.available) return "off";
    if (!tts.unlocked) return "needs-tap";
    return tts.lastSource === "browser" || !tts.configured ? "browser" : "server";
  };

  /** Drops a recording or an answer in flight; the microphone is always switched off. */
  const abortVoice = (): void => {
    voiceSeq++;
    if (recordTimer !== null) clearTimeout(recordTimer);
    recordTimer = null;
    if (micActive) void bridge.audioControl(false).catch(() => undefined);
    micActive = false;
    micChunks.length = 0;
    live?.abort();
    live = null;
    if (liveTimer !== null) clearTimeout(liveTimer);
    liveTimer = null;
    voice = null;
  };

  /** New live words: onto the glasses, at most every LIVE_REDRAW_MS and only when the text changed. */
  const showLive = (text: string, seq: number): void => {
    if (seq !== voiceSeq || voice?.phase !== "recording") return;
    voice = { phase: "recording", live: text };
    const now = Date.now();
    if (shouldRedraw(text, liveShown, now, liveShownAt)) {
      liveShown = text; liveShownAt = now;
      void draw();
    } else if (liveTimer === null && text !== liveShown) {
      liveTimer = setTimeout(() => {
        liveTimer = null;
        const latest = voice?.phase === "recording" ? voice.live ?? "" : "";
        if (seq !== voiceSeq || latest === liveShown) return;
        liveShown = latest; liveShownAt = Date.now();
        void draw();
      }, Math.max(0, LIVE_REDRAW_MS - (now - liveShownAt)));
    }
  };

  /** The page the help was opened from: a guide or a plan must survive a look at the help. */
  let helpReturn: Screen = "board";
  const openHelp = (): void => {
    disarm();
    if (screen !== "help") helpReturn = screen;
    screen = "help";
    void draw();
  };
  const closeHelp = (): void => {
    disarm();
    const back = helpReturn;
    helpReturn = "board";
    if ((back === "guide" && guide) || (back === "plans" && plan) || (back === "voice" && voice) || back === "places") {
      screen = back;
      void draw();
      return;
    }
    openBoard();
  };

  /** The start page: nothing running, nothing asked. */
  const openStart = (): void => {
    disarm();
    abortVoice();
    planSeq++;
    stopGuideTimer();
    guide = null;
    screen = "start";
    void draw();
  };

  const openBoard = (): void => {
    disarm();
    abortVoice();
    planSeq++;
    stopGuideTimer();
    guide = null;
    screen = "board";
    void draw();
  };

  const openPlaces = (): void => {
    disarm();
    abortVoice();
    planSeq++;
    stopGuideTimer();
    guide = null;
    screen = "places";
    placeIndex = Math.min(placeIndex, Math.max(0, targets().length - 1));
    void draw();
  };

  /** Looks up connections from here to the target. A newer search drops an older answer. */
  const startPlan = async (target: Destination): Promise<void> => {
    const seq = ++planSeq;
    disarm();
    stopGuideTimer();
    guide = null;
    screen = "plans";
    plan = { target, status: "loading", journeys: [], selected: 0 };
    void draw();
    if (!position) {
      plan = {
        target, status: "error", journeys: [], selected: 0,
        error: (lang) => ({ error: t(lang, "r.needPosition"), hint: t(lang, "r.needPositionHint") }),
      };
      await draw();
      return;
    }
    try {
      const journeys = await planner().plan(position, target, locale, 4);
      if (seq !== planSeq) return;
      plan = { target, status: "ready", journeys, selected: 0 };
    } catch (thrown) {
      if (seq !== planSeq) return;
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      console.warn("[nextstop] plan failed:", message);
      plan = { target, status: "error", journeys: [], selected: 0, error: (lang) => explainFailure(message, "motis", lang) };
    }
    await draw();
  };

  const showVoiceError = (error: string, hint: string): void => {
    voice = { phase: "error", error, hint };
    screen = "voice";
    void draw();
  };

  /** Hold on the goal list: record until the release, or until the hard stop. */
  const startVoice = async (): Promise<void> => {
    if (screen !== "places" && screen !== "board" && screen !== "start") return;
    const seq = ++voiceSeq;
    screen = "voice";
    if (!demo.enabled && !sttBase(settings.sttUrl) && !liveSttUrl()) {
      showVoiceError(t(locale, "r.voiceNoServer"), t(locale, "r.voiceNoServerHint"));
      return;
    }
    voice = { phase: "recording" };
    liveShown = ""; liveShownAt = 0;
    void draw();
    if (demo.enabled) return;
    micChunks.length = 0;
    // Live words while speaking, when the build has a live server; it connects while the microphone starts.
    live?.abort();
    const liveUrl = liveSttUrl();
    live = liveUrl ? openLiveStt({ url: liveUrl, language: locale, onText: (text) => showLive(text, seq) }) : null;
    // Blocks may arrive before the answer to the request does; they must not be dropped.
    micActive = true;
    const asked = bridge.audioControl(true, AudioInputSource.Glasses).catch(() => false);
    const granted = await withTimeout(asked, MIC_TIMEOUT_MS).catch(() => {
      // No answer in time: should the microphone come on later after all, it goes off again at once.
      void asked.then((late) => { if (late) void bridge.audioControl(false).catch(() => undefined); });
      return false;
    });
    if (seq !== voiceSeq) {
      // Cancelled while the microphone was starting: do not leave it on.
      if (granted) void bridge.audioControl(false).catch(() => undefined);
      return;
    }
    micActive = granted;
    if (!granted) {
      live?.abort();
      live = null;
      showVoiceError(t(locale, "r.voiceMic"), t(locale, "r.voiceMicHint"));
      return;
    }
    // A recording must end even when the release event never arrives.
    recordTimer = setTimeout(() => { recordTimer = null; void finishVoice(); }, MAX_VOICE_MS);
  };

  /** Release: send what was said, look the words up as a place, show up to three hits. */
  const finishVoice = async (): Promise<void> => {
    if (!voice || voice.phase !== "recording") return;
    const seq = ++voiceSeq;
    if (recordTimer !== null) clearTimeout(recordTimer);
    recordTimer = null;
    if (liveTimer !== null) clearTimeout(liveTimer);
    liveTimer = null;
    const liveText = voice.live;
    voice = { phase: "working", ...(liveText ? { heard: liveText } : {}) };
    void draw();
    if (!demo.enabled) {
      micActive = false;
      await bridge.audioControl(false).catch(() => undefined);
      // Blocks still in flight arrive after the off-switch; without the pause the tail is lost.
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    try {
      let heard = "Hauptbahnhof Salzburg";
      if (!demo.enabled) {
        const session = live;
        live = null;
        const liveOutcome = session ? await session.finish() : null;
        if (seq !== voiceSeq) return;
        const choice = chooseTranscript(liveOutcome, sttBase(settings.sttUrl) !== "");
        if (choice.use === "live") {
          micChunks.length = 0;
          heard = choice.text;
        } else if (choice.use === "none") {
          micChunks.length = 0;
          // The live server was not reachable (and there is no batch server): said like any network failure.
          if (!liveOutcome?.ok) throw new Error("live speech server: network failed");
          showVoiceError(t(locale, "r.voiceNothing"), t(locale, "r.voiceNothingHint"));
          return;
        } else {
          // Batch: the whole recording to the speech server, as before live words existed.
          const bytes = micChunks.reduce((sum, chunk) => sum + chunk.length, 0);
          if (bytes < MIN_VOICE_BYTES) {
            micChunks.length = 0;
            if (seq === voiceSeq) showVoiceError(t(locale, "r.voiceShort"), t(locale, "r.voiceShortHint"));
            return;
          }
          const wav = buildWav(micChunks);
          micChunks.length = 0;
          heard = await transcribe(wav, sttBase(settings.sttUrl), locale);
        }
      }
      if (seq !== voiceSeq) return;
      if (!heard) { showVoiceError(t(locale, "r.voiceNothing"), t(locale, "r.voiceNothingHint")); return; }
      const found = (await planner().geocode(heard, position, locale)).slice(0, 3);
      if (seq !== voiceSeq) return;
      if (found.length === 0) {
        showVoiceError(t(locale, "r.voiceNoPlace", { text: heard }), t(locale, "r.voiceNoPlaceHint"));
        return;
      }
      voice = { phase: "results", heard, results: found, selected: 0, saved: false };
      void draw();
    } catch (thrown) {
      if (seq !== voiceSeq) return;
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      console.warn("[nextstop] voice failed:", message);
      const said = explainFailure(message, "motis", locale);
      showVoiceError(said.error, said.hint);
    }
  };

  const updatePlaces = async (next: Places): Promise<void> => {
    places = next;
    placeIndex = Math.min(placeIndex, Math.max(0, targets().length - 1));
    if (!demo.enabled) await savePlaces(bridge, next);
    void draw();
  };

  /**
   * Fresh times for the vehicles still ahead. The connection was planned once;
   * delays reported since then arrive here, one trip request per vehicle, and
   * a failure simply leaves the times as they were.
   */
  const refreshGuide = async (): Promise<void> => {
    const current = guide;
    if (!current || demo.enabled) return;
    const horizon = clock().getTime() - 5 * 60000;
    let journey = current.journey;
    const ahead = journey.legs
      .filter((leg): leg is TransitLeg => leg.kind === "transit" && leg.tripId !== ""
        && (leg.stops[leg.stops.length - 1]?.expected.getTime() ?? 0) > horizon)
      .slice(0, 2);
    for (const leg of ahead) {
      try {
        const fresh = await planner().ride(leg.tripId);
        if (fresh) journey = withLeg(journey, leg.tripId, withFreshTimes(leg, fresh.stops));
      } catch {
        // Keep the planned times; the guide must not go quiet over a failed refresh.
      }
    }
    if (guide !== current || closed) return;
    guide = { ...current, journey, steps: buildSteps(journey) };
    void draw();
  };

  /**
   * Keeps a walking route for the walking step on screen: asked for when the
   * step begins, and again from where the walker stands once they are more
   * than OFF_ROUTE_METRES from it (at most every 15 s).
   */
  const ensureWalk = async (): Promise<void> => {
    const session = guide;
    const at = guidePosition();
    if (screen !== "guide" || !session || !at) return;
    const state = guideState(session.steps, clock(), at, session.override);
    if (state.step.kind !== "walk") return;
    const leg = state.step.leg;
    const key = walkKey(leg);
    const current = walkState;
    if (current?.loading) return;
    const now = Date.now();
    let reason: "new" | "off" | null = null;
    if (!current || current.key !== key) reason = "new";
    else if (!current.route) reason = now - current.fetchedAt > 30000 ? "new" : null;
    else if (project(current.route, at).off > OFF_ROUTE_METRES && now - current.fetchedAt > 15000) reason = "off";
    if (!reason) return;

    const old = reason === "off" ? current?.route ?? null : null;
    walkState = { key, route: old, fetchedAt: now, loading: true };
    let route: WalkRoute | null = null;
    try {
      route = await fetchWalk(at, { lat: leg.toLat, lon: leg.toLon });
    } catch (thrown) {
      console.warn("[nextstop] walking route failed:", thrown instanceof Error ? thrown.message : String(thrown));
    }
    if (closed || guide !== session) return;
    walkState = { key, route: route ?? old, fetchedAt: Date.now(), loading: false };
    if (reason === "off" && route) reroutedUntil = Date.now() + 5000;
    void draw();
    void ensureStreets();
  };

  /**
   * The streets for the walking leg on screen, once its route is known. Nothing here can hold the guidance up:
   * the map is drawn at once without streets and again when they arrive; no answer in time means no streets.
   */
  const ensureStreets = async (): Promise<void> => {
    const session = guide;
    const walking = walkState;
    if (demo.enabled || screen !== "guide" || !session || !walking?.route || walking.loading) return;
    const state = guideState(session.steps, clock(), guidePosition(), session.override);
    if (state.step.kind !== "walk" || walkKey(state.step.leg) !== walking.key) return;
    const leg = state.step.leg;
    const box = legBox([{ lat: leg.fromLat, lon: leg.fromLon }, { lat: leg.toLat, lon: leg.toLon }, ...walking.route.shape]);
    if (!box) return;
    const known = streetState?.key === walking.key ? streetState : null;
    if (known && (known.status !== "done" || containsBox(known.box, box))) return;
    const key = walking.key;
    const kept = known?.streets ?? [];
    const classes = classesFor(box);
    if (classes.length === 0) { streetState = { key, box, status: "done", streets: [] }; return; }
    streetState = { key, box, status: "loading", streets: kept };
    let outcome: Awaited<ReturnType<typeof streetSource.load>>;
    try {
      outcome = await streetSource.load(box, classes);
    } catch {
      outcome = { streets: [], error: "server" };
    }
    // The passenger may have left the guide or moved on to another leg meanwhile.
    if (closed || screen !== "guide" || !guide || streetState?.key !== key) return;
    streetState = outcome.error === null
      ? { key, box, status: "done", streets: outcome.streets }
      : { key, box, status: "failed", streets: kept };
    if (outcome.error !== null) console.warn("[nextstop] map streets failed:", outcome.error);
    void draw();
  };

  const startGuide = (journey: Journey, target: Destination, override: StepOverride | null = null): void => {
    walkState = null;
    streetState = null;
    mapSettled = null;
    stopGuideTimer();
    journeyId += 1;
    guide = { journey, steps: buildSteps(journey), override, target };
    disarm();
    screen = "guide";
    guideTimer = setInterval(() => { void refreshGuide(); }, 60000);
    void ensureWalk();
    void draw();
  };

  const leaveGuide = (): void => {
    stopGuideTimer();
    guide = null;
    disarm();
    screen = plan && plan.status === "ready" ? "plans" : "places";
    void draw();
  };

  const stepGuide = (direction: -1 | 1): void => {
    if (!guide) return;
    const state = guideState(guide.steps, clock(), guidePosition(), guide.override);
    guide = { ...guide, override: stepBy(state, direction) };
    void draw();
  };

  /**
   * Refresh only matters on the board. While riding, the stop list does not
   * change, and re-fetching it every half minute would spend battery and a
   * volunteer-run service's capacity on an answer already held.
   */
  const scheduleRefresh = (): void => {
    if (refreshTimer !== null) clearInterval(refreshTimer);
    if (closed) return;
    if (backgrounded) return;
    refreshTimer = setInterval(() => {
      // A request the passenger started — a stop switch, a ride being loaded —
      // is never pre-empted by the background refresh.
      // The start page keeps the board fresh too, so a tap on "Abfahrten" shows current minutes at once.
      if ((screen === "board" || screen === "start") && !following && settledSeq === requestSeq) void loadDepartures();
      if (screen === "board" && following?.status === "ready" && settledSeq === requestSeq) void refreshFollow();
      // The ride screen still redraws, because its countdown moves with the
      // clock even when no new data has arrived.
      void draw();
    }, settings.refreshSeconds * 1000);
  };

  // Not awaited: the handlers below must be in place before the first page and
  // the first board arrive, or a slow page or backend left the glasses deaf —
  // even to the double tap that leaves — for as long as it took.
  void draw();

  // What was running before a restart (phone locked, app unloaded): the guide
  // carries on at the right step, a followed bus is followed again.
  const saved: SavedSession | null = demo.enabled ? null : await loadSession(bridge);
  if (saved) {
    wantedStopId = saved.stopId;
    if (saved.guide) startGuide(saved.guide.journey, saved.guide.target, saved.guide.override);
    else if (saved.screen === "places") screen = "places";
    if (saved.follow) { screen = "board"; void startFollow(saved.follow); }
  }
  let lastSaved = "";
  const persistSession = (): void => {
    if (demo.enabled) return;
    const session: SavedSession = {
      savedAt: Date.now(),
      screen: (screen === "help" ? helpReturn : screen) === "guide" && guide ? "guide" : screen === "board" || screen === "start" || (screen === "help" && helpReturn === "board") ? "board" : "places",
      stopId: currentStop()?.id ?? wantedStopId,
      follow: following ? { departure: following.departure, stop: following.stop } : null,
      guide: guide ? { journey: guide.journey, target: guide.target, override: guide.override } : null,
    };
    // savedAt alone does not make it new: written only when something else changed, or every few minutes.
    const key = JSON.stringify({ ...session, savedAt: Math.floor(session.savedAt / 300_000) });
    if (key === lastSaved) return;
    lastSaved = key;
    void saveSession(bridge, session).catch((thrown: unknown) => { console.warn("[nextstop] saving the session failed:", thrown); });
  };

  void findStops();
  scheduleRefresh();

  const stopListening = bridge.onAppLocationChanged((location: AppLocation) => {
    if (closed) return;
    if (typeof location?.latitude !== "number" || typeof location?.longitude !== "number") return;
    const previous = position;
    position = {
      lat: location.latitude,
      lon: location.longitude,
      ...(typeof location.accuracy === "number" ? { accuracy: location.accuracy } : {}),
    };

    // The first fix after starting cold is what finally makes a stop findable.
    if (!previous && !following) { void findStops(); return; }
    void ensureWalk();
    announce();
    void draw();
  });

  /** Arms an action: the next single tap within ARM_MS carries it out (QIS v1). */
  const arm = (kind: ArmKind): void => {
    disarm();
    armed = { kind, until: Date.now() + ARM_MS };
    // The footer returns to normal on its own when nobody confirms.
    armTimer = setTimeout(() => { armTimer = null; armed = null; void draw(); }, ARM_MS + 50);
    void draw();
  };

  /** A followed ride that is still going: ending it is risky, so it is armed first. */
  const rideRunning = (): boolean => {
    const current = following;
    if (!current || current.status !== "ready" || !current.ride) return false;
    const state = followRide(current.ride, current.boarding, current.departure.expected, clock(), position);
    return state !== null && state.phase !== "finished";
  };

  /** The second single tap: does what was armed, if the screen still fits it. */
  const carryOut = (kind: ArmKind): void => {
    if (kind === "follow" && screen === "board" && following) { void stopFollow(); return; }
    if (kind === "stopGuide" && screen === "guide" && guide) { leaveGuide(); return; }
    if (kind === "search" && screen === "guide" && guide) { void startPlan(guide.target); return; }
    if (kind === "again" && screen === "plans" && plan) { void startPlan(plan.target); return; }
    if (kind === "saveVoice" && screen === "voice") saveVoiceHit();
  };

  /** Keeps the picked voice hit as a favourite (an equal place is renamed, so this is armed). */
  const saveVoiceHit = (): void => {
    if (screen !== "voice" || voice?.phase !== "results") return;
    const hit = voice.results[voice.selected];
    if (hit) {
      voice = { ...voice, saved: true };
      void updatePlaces(addFavorite(places, hit));
    }
  };

  /** A gesture on the departures page. */
  const onBoardGesture = (gesture: string): void => {
    switch (gesture) {
      case "click":
        if (following) {
          // A running ride is ended by arming, then a second tap. Loading, failed or finished: back at once.
          if (rideRunning()) { arm("follow"); return; }
          void stopFollow();
          return;
        }
        if (error) { void findStops(); return; }
        void startFollow();
        return;
      case "longPress":
        // Hold = say where you want to go, right from the start page. Cycling
        // through nearby stops is in the menu ("Andere Haltestelle", only with a side menu).
        if (following) return;
        void startVoice();
        return;
      case "scrollUp":
        if (following || departures.length === 0) return;
        selected = Math.max(0, selected - 1);
        void draw();
        return;
      case "scrollDown":
        if (following || departures.length === 0) return;
        selected = Math.min(departures.length - 1, selected + 1);
        void draw();
        return;
      case "doubleClick":
        // A followed ride is a running job: 2x opens the system exit dialog (it keeps updating until the user confirms).
        // The board itself is one level below the start page.
        if (following) { void requestExit(); return; }
        openStart();
        return;
      default:
        return;
    }
  };

  /** The start page: at most three entries; a tap opens the one marked. */
  const onStartGesture = (gesture: string): void => {
    const rows = startRows();
    switch (gesture) {
      case "click":
        if (rows[startCursor] === "goals") openPlaces(); else openBoard();
        return;
      case "scrollUp": startCursor = Math.max(0, startCursor - 1); void draw(); return;
      case "scrollDown": startCursor = Math.min(rows.length - 1, startCursor + 1); void draw(); return;
      case "longPress": void startVoice(); return;
      case "doubleClick": void requestExit(); return;
      default: return;
    }
  };

  const onPlacesGesture = (gesture: string): void => {
    const list = targets();
    switch (gesture) {
      case "scrollUp": placeIndex = Math.max(0, placeIndex - 1); void draw(); return;
      case "scrollDown": placeIndex = Math.min(Math.max(0, list.length - 1), placeIndex + 1); void draw(); return;
      case "click": {
        const target = list[placeIndex];
        if (target) void startPlan({ name: target.name, lat: target.lat, lon: target.lon });
        return;
      }
      case "doubleClick": openStart(); return;
      case "longPress": void startVoice(); return;
      default: return;
    }
  };

  const onVoiceGesture = (gesture: string): void => {
    const state = voice;
    if (!state) { openPlaces(); return; }
    if (state.phase === "recording") {
      if (gesture === "longPressRelease") void finishVoice();
      else if (gesture === "doubleClick") openPlaces();
      return;
    }
    if (state.phase === "working") { if (gesture === "doubleClick") openPlaces(); return; }
    if (state.phase === "error") { if (gesture === "click" || gesture === "doubleClick") openPlaces(); return; }
    switch (gesture) {
      case "scrollUp": voice = { ...state, selected: Math.max(0, state.selected - 1) }; void draw(); return;
      case "scrollDown": voice = { ...state, selected: Math.min(state.results.length - 1, state.selected + 1) }; void draw(); return;
      case "click": {
        const hit = state.results[state.selected];
        if (hit) void startPlan({ name: hit.name, lat: hit.lat, lon: hit.lon });
        return;
      }
      case "doubleClick": openPlaces(); return;
      default: return;
    }
  };

  const onPlansGesture = (gesture: string): void => {
    if (!plan) { openPlaces(); return; }
    switch (gesture) {
      case "scrollUp":
        plan = { ...plan, selected: Math.max(0, plan.selected - 1) };
        void draw();
        return;
      case "scrollDown":
        plan = { ...plan, selected: Math.min(Math.max(0, Math.min(plan.journeys.length, 4) - 1), plan.selected + 1) };
        void draw();
        return;
      case "click": {
        if (plan.status === "loading") return;
        const journey = plan.journeys[plan.selected];
        if (plan.status === "ready" && journey) { startGuide(journey, plan.target); return; }
        void startPlan(plan.target);
        return;
      }
      case "doubleClick": openPlaces(); return;
      default: return;
    }
  };

  const onGuideGesture = (gesture: string): void => {
    if (!guide) { openPlaces(); return; }
    const state = guideState(guide.steps, clock(), guidePosition(), guide.override);
    switch (gesture) {
      case "scrollUp": stepGuide(-1); return;
      case "scrollDown": stepGuide(1); return;
      case "click":
        if (state.phase === "arrived") { leaveGuide(); return; }
        // A missed bus may only look missed: planning anew drops this guide, so it is armed first.
        if (state.phase === "missed") { arm("search"); return; }
        stepGuide(1);
        return;
      case "doubleClick":
        // QIS v1: 2x never ends a running trip. At the end there is nothing left to lose (back);
        // otherwise it is the system exit dialog, which the passenger has to confirm.
        if (state.phase === "arrived") { leaveGuide(); return; }
        void requestExit();
        return;
      case "longPress":
        // Without a side menu a hold asks to stop the guidance; one more single tap carries it out
        // (swipe, 2x or 4 s without input cancel). Nothing to stop once the goal is reached.
        if (SIDE_MENU || state.phase === "arrived") return;
        arm("stopGuide");
        return;
      default: return;
    }
  };

  /** `confirmed`: the same entry was armed by the click before and the 4 s are not over. */
  const onMenu = (itemId: number, confirmed: ArmKind | null = null): void => {
    switch (itemId) {
      case MENU.route: openPlaces(); return;
      case MENU.board:
        if (screen === "help") { closeHelp(); return; }
        openBoard();
        return;
      case MENU.refresh:
        // Reloading never drops a ride that is being followed: it only fetches fresh times.
        if (screen === "board") { if (following) void refreshFollow(); else void findStops(); }
        return;
      case MENU.help: openHelp(); return;
      case MENU.otherStop:
        if (screen !== "board" || following || stops.length < 2) return;
        stopIndex = (stopIndex + 1) % stops.length;
        selected = 0;
        void loadDepartures();
        return;
      case MENU.goals: openPlaces(); return;
      case MENU.again:
        if (screen !== "plans" || !plan) return;
        if (confirmed === "again") { void startPlan(plan.target); return; }
        arm("again");
        return;
      case MENU.next: stepGuide(1); return;
      case MENU.prev: stepGuide(-1); return;
      case MENU.stop:
        if (!guide || screen !== "guide") return;
        if (confirmed === "stopGuide") { leaveGuide(); return; }
        arm("stopGuide");
        return;
      case MENU.saveVoice:
        if (screen !== "voice" || voice?.phase !== "results") return;
        if (confirmed === "saveVoice") { saveVoiceHit(); return; }
        arm("saveVoice");
        return;
      default: return;
    }
  };

  bridge.onEvenHubEvent((event) => {
    if (closed) return;
    // The 4/5 right after an exit call are the system dialog's own show/close, not the app entering/leaving:
    // they must neither stop GPS, timers and the microphone nor redraw over the dialog.
    if (requestExit.onLifecycle(event) !== null) return;
    const lifecycle = lifecycleFromEvent(event);
    if (isBackSignal(event)) requestExit.back();
    if (lifecycle === "foreground") { comeBack(); return; }
    if (lifecycle === "background") { void goBackground(); return; }
    if (lifecycle === "exit") {
      // Left on purpose (the user confirmed the exit dialog): a guide or a followed bus is over, the next start begins on the board.
      following = null;
      guide = null;
      screen = "start";
      persistSession();
      void goBackground().then(() => { void shutDown(); });
      return;
    }
    // Native contextual menu: arrives on its own event, whatever container captures input.
    const menuId = menuItemIdFromEvent(event);
    if (menuId !== null) {
      if (backgrounded) comeBack();
      // QIS v1.2: the second click on the same armed entry within 4 s carries it out.
      const pending = armed !== null && armed.until > Date.now() ? armed.kind : null;
      disarm();
      onMenu(menuId, pending);
      persistSession();
      return;
    }

    // PCM blocks of a recording arrive on the same channel as gestures.
    const audio = (event as { audioEvent?: { audioPcm?: unknown } }).audioEvent;
    if (audio !== undefined) {
      if (micActive) {
        const bytes = pcmBytes(audio.audioPcm);
        if (bytes !== null && bytes.length > 0) { micChunks.push(bytes); live?.send(bytes); }
      }
      return;
    }

    const gesture = gestureFromEvent(event, { invertScroll: settings.invertScroll });
    if (!gesture) return;
    // A gesture means the app is on the glasses again, even if no "foreground" came first.
    if (backgrounded) {
      const restore = comeBack();
      // A double tap on a root page (board, running guide) that arrives while the app thinks it is backgrounded
      // comes back AND asks the exit dialog; it waits for the restore draw like the exit helper does for its own.
      if (gesture.gesture === "doubleClick" && (screen === "start" || screen === "guide" || (screen === "board" && following !== null))) {
        disarm();
        void settleRestore(restore).then(() => requestExit());
      }
      return;
    }
    // QIS v1: an armed action takes the next single tap; any other gesture only cancels it.
    if (armed && gesture.gesture !== "longPressRelease") {
      const pending = armed;
      const live = pending.until > Date.now();
      disarm();
      if (live && gesture.gesture === "click") { carryOut(pending.kind); persistSession(); return; }
      if (live) { void draw(); return; }
    }
    switch (screen) {
      case "help": if (gesture.gesture === "click" || gesture.gesture === "doubleClick") closeHelp(); break;
      case "start": onStartGesture(gesture.gesture); break;
      case "voice": onVoiceGesture(gesture.gesture); break;
      case "places": onPlacesGesture(gesture.gesture); break;
      case "plans": onPlansGesture(gesture.gesture); break;
      case "guide": onGuideGesture(gesture.gesture); break;
      default: onBoardGesture(gesture.gesture);
    }
    persistSession();
  });

  /**
   * Only a confirmed exit stops everything that could draw again or keep GPS
   * awake. A cancelled or failed dialog leaves the app exactly as it was.
   */
  /** Everything off for good: after a confirmed exit, or when the system ends the app. */
  const shutDown = async (): Promise<void> => {
    closed = true;
    requestSeq++;
    planSeq++;
    abortVoice();
    if (refreshTimer !== null) clearInterval(refreshTimer);
    if (tickTimer !== null) clearInterval(tickTimer);
    if (beatTimer !== null) clearInterval(beatTimer);
    stopGuideTimer();
    refreshTimer = null;
    tickTimer = null;
    beatTimer = null;
    if (typeof stopListening === "function") stopListening();
    await bridge.stopAppLocationUpdates().catch(() => undefined);
  };
  // shutDownPageContainer(1) resolves when the dialog is SHOWN, not when the user answered: the result never
  // tears the app down (the system ends it: sysEvent 6/7). On the next input the page comes back as a first page.
  const requestExit = createExitRequest(bridge, {
    onBack: () => {
      // The dialog took the page away. Put it up again the way of the
      // first one (create), so the glasses deliver input - and the next 2x - to the app again.
      if (closed) return;
      pageReady = false;
      menuKey = "";
      lastScene = null;
      forgetPage(bridge);
      return draw();
    },
  }, "nextstop");
  exitAsked = requestExit.asked;

  /**
   * Left through the system (not by the double tap): GPS, microphone and the
   * timers stop, what was running is saved. The guide itself is kept; it is
   * worked out from the clock and the position, so it is right again on return.
   */
  const goBackground = async (): Promise<void> => {
    if (backgrounded || closed) return;
    persistSession();
    backgrounded = true;
    abortVoice();
    tts.stop();
    if (refreshTimer !== null) clearInterval(refreshTimer);
    if (tickTimer !== null) clearInterval(tickTimer);
    if (beatTimer !== null) clearInterval(beatTimer);
    if (guideTimer !== null) clearInterval(guideTimer);
    refreshTimer = null;
    tickTimer = null;
    beatTimer = null;
    guideTimer = null;
    await bridge.stopAppLocationUpdates().catch(() => undefined);
  };

  /** Returns the restore draw (null if nothing was backgrounded), so a following exit request can wait for it. */
  const comeBack = (): Promise<void> | null => {
    if (!backgrounded || closed) return null;
    backgrounded = false;
    if (screen === "voice") { voice = null; screen = "places"; }
    pageReady = false;
    menuKey = "";
    lastScene = null;
    startLocation(false);
    scheduleRefresh();
    startTimers();
    if (guide) {
      guideTimer = setInterval(() => { void refreshGuide(); }, 60000);
      void refreshGuide();
      void ensureWalk();
    }
    const restore = draw();
    if (screen === "board") {
      if (following?.status === "ready") void refreshFollow();
      else if (!following) void loadDepartures();
    }
    return restore;
  };

  bridge.onDeviceStatusChanged((status) => {
    if (status?.connectType === "connected" && !closed) {
      pageReady = false;
      menuKey = "";
      void draw();
    }
  });

  // Location starts only now, with every handler in place: the phone may be
  // asking for permission, and a cold GPS fix indoors can take long. Awaited
  // before the handlers, either one left the glasses deaf — no tap, no hold
  // for the voice goal, not even the double tap that leaves.
  function startLocation(initial: boolean): void {
    void (async () => {
      await withTimeout(bridge.startAppLocationUpdates({
        accuracy: AppLocationAccuracy.High,
        distanceFilter: 10,
      }), FIRST_FIX_MS).catch(() => false);
      const firstFix = await withTimeout(
        bridge.getAppLocation({ accuracy: AppLocationAccuracy.High }), FIRST_FIX_MS,
      ).catch(() => null);
      if (closed || backgrounded || !firstFix || typeof firstFix.latitude !== "number") return;
      // A real fix always wins over the URL parameter.
      position = { lat: firstFix.latitude, lon: firstFix.longitude };
      // On return from the background the board is only refreshed (comeBack), not searched anew.
      if (initial && !following) void findStops();
    })();
  }
  startLocation(true);

  function startTimers(): void {
    if (tickTimer !== null) clearInterval(tickTimer);
    if (beatTimer !== null) clearInterval(beatTimer);
    // A second beat so the countdown stays honest between data refreshes.
    tickTimer = setInterval(() => { void ensureWalk(); void ensureStreets(); announce(); void draw(); persistSession(); }, 2000);
    // The half-second beat of the animated guide pages (the bus, the pulse of
    // "get off"): it redraws only while such a page is on screen, so the quiet
    // pages keep their 2 s rhythm and send nothing in between.
    beatTimer = setInterval(() => {
      if (!closed && lastScene?.animated && (screen === "guide" || screen === "board")) void draw();
    }, BEAT_MS);
  }
  startTimers();

  mountPhoneUi({
    getLocale: () => locale,
    setLocale: (next) => {
      locale = next;
      rememberLocale(bridge, next);
      void draw();
    },
    getSettings: () => settings,
    onVoiceActivate: () => { tts.unlock(); if (tts.available) tts.speak(locale === "de" ? "Sprachausgabe ist bereit." : "Voice is ready.", { lang: locale }); },
    getVoiceState: voiceState,
    setSettings: async (next) => {
      if (!next.announce) tts.stop();
      const backendChanged = next.backend !== settings.backend
        || next.oebbUrl !== settings.oebbUrl
        || next.motisUrl !== settings.motisUrl;
      settings = next;
      await save(bridge, next);
      scheduleRefresh();
      if (backendChanged) { following = null; await findStops(); }
      await draw();
    },
    getPosition: () => position,
    isSeeded: () => position === seeded && seeded !== null,
    getStops: () => stops,
    getBoard: () => {
      const stop = currentStop();
      if (!stop) return null;
      const now = clock();
      return {
        stop: stop.name,
        metres: position ? Math.round(metresBetween(position.lat, position.lon, stop.lat, stop.lon)) : null,
        departures: departures.slice(0, 8).map((departure) => ({
          line: departure.line, headsign: departure.headsign, minutes: minutesUntil(departure.expected, now),
          delay: departure.source === "realtime" ? delayMinutes(departure) : null,
          cancelled: departure.cancelled, track: departure.track ?? "", clock: departure.expected.getTime(),
        })),
      };
    },
    refresh: () => { void findStops(); },
    getPlaces: () => places,
    setPlaces: updatePlaces,
    searchPlaces: (text) => planner().geocode(text, position, locale),
    isDemo: () => demo.enabled,
  });

  // Development only: open straight on a route page, so a desk simulator can show it.
  if (demo.enabled && demo.scene) {
    if (demo.scene === "board") {
      openBoard();
    } else if (demo.scene === "places") {
      openPlaces();
    } else if (demo.scene === "recording" || demo.scene === "voice") {
      openPlaces();
      await startVoice();
      if (demo.scene === "voice") await finishVoice();
    } else {
      const first = targets()[0];
      if (first) {
        await startPlan({ name: first.name, lat: first.lat, lon: first.lon });
        const planned = plan as PlanState | null;
        const journey = planned?.journeys[0];
        if (demo.scene === "guide" && journey && planned) startGuide(journey, planned.target);
      }
    }
  }
}

void boot().catch((error: unknown) => {
  console.error("[nextstop] failed to start:", error);
});
