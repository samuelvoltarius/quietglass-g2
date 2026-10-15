import { version as APP_VERSION } from "../app.json";
import { diag, startDiag } from "./diag/diag";
import {
  AppLocationAccuracy, AudioInputSource, waitForEvenAppBridge, type AppLocation, type EvenAppBridge,
} from "@evenrealities/even_hub_sdk";
import { cumulativeMeters, formatDistance, projectOntoPath, type LatLng } from "./geo/geometry";
import {
  clientIdFor, createMockProvider, createValhallaProvider, MAX_ALTERNATES, type Route, type RouteOutcome, type RoutingProvider,
} from "./routing/provider";
import { choicesFrom, moveChoice, routeChoiceView, type EnergyModel, type RouteChoice } from "./routing/choice";
import {
  bestDetour, buildTrafficUrl, createTrafficClient, delayAhead, DETOUR_MIN_SAVING_MIN, DETOUR_OFFER_MS, lineAhead,
  trafficAhead, trafficText, detourText, TrafficPoller, TRAFFIC_NEAR_M, type TrafficAhead, type TrafficReport, type TrafficState,
} from "./traffic/traffic";
import { cameraAhead, camerasAlong, cameraText, createCameraSource, type Camera, type CameraAhead, type RouteCamera } from "./nav/cameras";
import { CameraCountryGate, coarseCountry, photonCountry } from "./geo/country";
import { createRequestGate, mayAutoReroute } from "./routing/throttle";
import {
  needsReroute, progressOf, startNavigation, update, type NavState,
} from "./nav/navigator";
import { gestureFromEvent, menuItemIdFromEvent } from "./input/gestures";
import { buildView, type GlassLayout, type NavView } from "./glasses/view";
import {
  chargerView, clampCursor, cursorFor, followCursor, helpView, listItems, listView, nextMode, voiceView,
  type ChargerListState, type ListAppt, type VoiceState,
  CAR_DESTINATION_ID, setCarSpot,
} from "./glasses/picker";
import { MAX_VOICE_MS, MIN_VOICE_BYTES, pcmBytes, sttBase, transcribe } from "./voice/stt";
import { buildWav } from "./voice/wav";
import { chooseTranscript, liveSttUrl, LIVE_REDRAW_MS, openLiveStt, shouldRedraw, type LiveSession } from "./voice/live-stt";
import { sameView } from "./glasses/diff";
import { forgetPage, showPage, updatePage, type MenuSpec, type PageKind } from "./glasses/render";
import { pixelArrowFor } from "./glasses/icons";
import { approachSteps, cardKey, type TurnCard } from "./glasses/turncard";
import { renderMapTiles, type MapScene } from "./overview/draw";
import { courseAhead, rangeFor } from "./overview/camera";
import type { BBox } from "./overview/project";
import { needsMapImage, type MapFrame } from "./overview/refresh";
import { AROUND_RADIUS_M, AROUND_REFETCH_EDGE_M, boxAround, classesFor, createStreetSource, wellInside, type Street } from "./overview/streets";
import { buildStreetsUrl, createRouteStreetSource, type RouteTraceOutcome } from "./overview/route-streets";
import { limitAt, SpeedMeter, type SpeedLimitSpan, type SpeedReading } from "./nav/speed";
import { demoStreets } from "./overview/demo";
import { createGeocoder, type Geocoder } from "./geocode/photon";
import { withMapsLinks } from "./geocode/gmaps";
import { resolveLocale, rememberLocale, setLocale, tr, type Locale } from "./i18n";
import { messages } from "./messages";
import {
  chooseDestination, destinationOf, geocoderUrlOf, load, routerUrlOf, save, saveFavorite, selectedRoute, selectionLabel, usesMockRouter,
  type Destination, type NavData,
} from "./storage/persist";
import { mergeRoutes, nameStops, planFrom, stopsPassed, type JoinKind, type RoutePoint, type SavedRoute } from "./trip/saved";
import { createRouteSync, sameRoutes } from "./trip/sync";
import {
  chargersAlong, createChargerSource, demoChargers, nearestFast, nextAhead, powerText,
  type Charger, type ChargerOutcome, type RouteCharger,
} from "./chargers/chargers";
import { mountPhoneUi, type CarLine } from "./ui/phone";
import { buildHud, hudView, speedBigKey, type AlertKind, type HudState } from "./glasses/hud";
import { BrakeAdvisor, limitDrops, type LimitDrop } from "./nav/brake";
import { reckonDistance, SpeedingWatch } from "./nav/speeding";
import { batteryEstimate, batteryRange, buildBydUrl, chooseSpeed, consumptionOf, fetchCar, CAR_POLL_IDLE_MS, CAR_POLL_NAV_MS, type BatteryEstimate, type CarSnapshot } from "./car/byd";
import { buildTtsUrl, DEFAULT_VOICES, ServerTts } from "./speech/server-tts";
import { buildSugarToken, buildSugarUrl, fetchSugar, sugarDisplay, SUGAR_POLL_MS, type SugarDisplay, type SugarReading } from "./sugar/glucose";
import { TurnAnnouncer } from "./speech/announcer";
import {
  briefConfigured, buildBriefToken, buildBriefUrl, departure, departureText, fetchAppointments, nextEtaRequest, samePlaceAs,
  shouldFetchAppointments, upcomingAppointments, type Appointment, type ApptEta,
} from "./appointments/appointments";
import {
  areaFor, bandPicks, createPeakSource, demoPeaks, facingFor, sightsFrom,
  type Course, type Facing, type Peak, type PeakOutcome,
} from "./peaks/peaks";
import { bandKey, layoutBand, renderBandPngs } from "./peaks/band";
import { bandView, peakListView, type PeakPageState } from "./peaks/view";

/** While the distance only counts down, the turn card is resent at most this often. */
const CARD_MIN_INTERVAL_MS = 2_000;
/** The large HUD speed is a picture: a new value goes out at most this often (each crosses Bluetooth). */
const SPEED_IMAGE_MIN_INTERVAL_MS = 1_000;
/** Sent with the step log, so a log line says which build wrote it. */
const DIAG_VERSION = APP_VERSION;
/** The glasses' side menu (QIS v1.2). Off: its clicks do not arrive on current firmware (step log 15.10.2026). */
const SIDE_MENU = false;
/** After this many refused HUD page changes in a row the classic turn page is used (until the app restarts). */
export const HUD_MAX_FAILURES = 2;
/** After a page change failed, the next attempt waits this long (a rebuild blocks the glasses for seconds). */
const PAGE_RETRY_MS = 5_000;
/** The overview must stay up this long before its streets are fetched. */
const STREETS_DWELL_MS = 1_500;
/** `shutDownPageContainer` mode that shows the system's exit confirmation. */
const EXIT_WITH_CONFIRMATION = 1;
/** Request URL limit for the public router's trace_attributes (a longer GET is refused). */
const PUBLIC_TRACE_URL_MAX = 7_500;
/** At most this many trace parts per route on the public router (one request per second). */
const PUBLIC_TRACE_CHUNKS = 4;
/** Asked-for GPS interval (the phone's default was left open before; 1 s is what a car display needs). */
const LOCATION_INTERVAL_MS = 1_000;
/** The HUD layout counts the distance down this often between GPS fixes (text only). */
const HUD_TICK_MS = 1_000;
/** The limits are asked for this long after the route, keeping one request per second. */
const TRACE_DELAY_MS = 1_200;
/** While only the facing direction changes, the peaks band is resent at most this often. */
const BAND_MIN_INTERVAL_MS = 1_500;
/** Where the peaks of the visited areas are kept on the phone (Even app storage). */
const PEAK_CACHE_KEY = "quietglass.openglance.peaks.v1";

const DEMO = new URLSearchParams(location.search).get("demo") === "1";
/** Demo only: `scene=far|near|map` starts on a given picture (far from the turn, close to it, the map). */
const SCENE = DEMO ? new URLSearchParams(location.search).get("scene") : null;

/** A cheap fingerprint of an image, to leave a map tile unsent when it did not change. */
function fingerprint(bytes: Uint8Array): number {
  let hash = 2166136261;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619);
  return hash >>> 0;
}

/** A navigation interrupted by the system is resumed when it started less than this long ago. */
const RESUME_WITHIN_MS = 6 * 60 * 60_000;
/** The side-menu entry "Navigation beenden" asks; ONE more click or tap within this time carries it out (QIS v1.2, section 2). */
const STOP_CONFIRM_MS = 4000;
/** Ids of the glasses' side menu (never 0). */
const MENU = { help: 1, viewTurns: 2, viewMap: 3, hud: 4, cameras: 5, stop: 6 } as const;
/** A tap right after the menu click (its own release) is not a confirmation. */
const STOP_SETTLE_MS = 400;

/** How long a location answer may take before navigation goes on without it. */
const FIRST_FIX_MS = 10000;

/** Rejects when the promise has not settled in time; the promise itself runs on. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${ms} ms`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

/** "47.80, 13.04" (anything after the second number is ignored) or null. */
function latLngFromParam(raw: string | null): LatLng | null {
  if (!raw) return null;
  const [lat, lon] = raw.split(",").map((part) => Number(part.trim()));
  if (lat === undefined || lon === undefined || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

async function boot(): Promise<void> {
  const bridge: EvenAppBridge = await waitForEvenAppBridge();

  let locale: Locale = await resolveLocale(bridge);
  setLocale(locale);
  let data: NavData = await load(bridge);
  if (DEMO) {
    // The demo also brings a saved route with one stop, and shows charging stations.
    const demoRoute: SavedRoute = {
      id: "s1", name: "Büro mit Ladestopp", mode: "driving", start: null,
      stops: [{ label: "Demo Schnelllader", at: { lat: 47.8105, lon: 13.0505 } }],
      to: { label: "Mirabellplatz", at: { lat: 47.815, lon: 13.048 } }, distance: 2400, duration: 310,
    };
    data = {
      ...data,
      places: [{ id: "demo", label: "Mirabellplatz", at: { lat: 47.815, lon: 13.048 } }],
      routes: [demoRoute],
      destinationId: SCENE === "stop" ? "s1" : "demo",
      demo: true,
      chargers: true,
      ...(SCENE ? { mode: "driving" as const, glassView: SCENE === "map" ? "overview" as const : "turns" as const } : {}),
    };
  }
  // Development only (vite dev server): `?at=lat,lon` stands in for the GPS the
  // simulator does not have, `?to=lat,lon,Name` puts a destination in the list.
  const devAt = import.meta.env.DEV ? latLngFromParam(new URLSearchParams(location.search).get("at")) : null;
  const devTo = import.meta.env.DEV ? new URLSearchParams(location.search).get("to") : null;
  if (devTo) {
    const at = latLngFromParam(devTo);
    const label = devTo.split(",").slice(2).join(",").trim() || "Ziel";
    if (at && !data.places.some((p) => p.label === label)) {
      const id = "dev" + data.places.length;
      data = { ...data, places: [...data.places, { id, label, at }], destinationId: id };
    }
  }
  /** Development only: `?chargers=1` switches charging stations on (the simulator has no phone page to tick it). */
  if (import.meta.env.DEV && new URLSearchParams(location.search).get("chargers") === "1") data = { ...data, chargers: true };
  /** Development only: `?heard=Tamsweg` stands in for what the speech server understood. */
  const devHeard = import.meta.env.DEV ? new URLSearchParams(location.search).get("heard") : null;
  let nav: NavState | null = null;
  let position: LatLng | null = DEMO ? { lat: 47.805, lon: 13.042 } : devAt;
  /** When the position was last measured; a fresh one lets a start skip waiting for the GPS. */
  let positionAt = position ? Number.POSITIVE_INFINITY : 0;
  /**
   * Which glasses page is up: the destination list (start page), speaking a
   * destination, or navigation (including starting it and its errors).
   */
  let screen: "list" | "voice" | "nav" | "chargers" | "peaks" | "help" | "routes" = DEMO && SCENE !== "list" && SCENE !== "voice" && SCENE !== "chargers" && SCENE !== "peaks" ? "nav" : "list";
  let cursor = cursorFor(data);
  /**
   * Stopping a navigation is armed, then confirmed (QIS v1.2, section 2): the
   * first click on the side-menu entry asks, ONE more click on it or a single
   * tap within STOP_CONFIRM_MS carries it out. A swipe, a double tap, a hold,
   * another menu entry or the timeout cancel. Nothing stops on one gesture.
   */
  let stopArmedUntil = 0;
  let stopArmedAt = 0;
  let stopTimer: ReturnType<typeof setTimeout> | null = null;
  const stopArmed = (): boolean => stopArmedUntil > Date.now();
  const disarmStop = (): void => {
    stopArmedUntil = 0;
    if (stopTimer !== null) { clearTimeout(stopTimer); stopTimer = null; }
  };
  let voice: VoiceState | null = null;
  /** Bumped whenever a recording or its answer is abandoned. */
  let voiceSeq = 0;
  let micActive = false;
  const micChunks: Uint8Array[] = [];
  let recordTimer: ReturnType<typeof setTimeout> | null = null;
  /** Live recognition of the recording in progress (private build: VITE_LIVE_STT_URL), and its redraw throttle. */
  let live: LiveSession | null = null;
  let liveShown = "";
  let liveShownAt = 0;
  let liveTimer: ReturnType<typeof setTimeout> | null = null;
  const canSpeak = (): boolean => sttBase("") !== "" || liveSttUrl() !== "";
  /** What a start is doing before the first route arrives ("gps", "route"), shown on the glasses. */
  let startPhase: "gps" | "route" | null = null;
  let rerouting = false;
  /** Message key of the error shown, translated at draw time. */
  let errorKey: string | null = null;
  let lastView: NavView | null = null;
  let pageReady = false;
  let pageKind: PageKind | null = null;
  /** The side menu the page on the glasses was built with; another menu means one page rebuild. */
  let pageMenuKey = "";
  /** The page the help was opened from (help is a page on top of it; a running navigation is never dropped by a look at the help). */
  let helpFrom: "list" | "nav" | "routes" = "list";
  /**
   * When a page could not be put up. A failed rebuild must not be retried on
   * every GPS fix: each attempt blocks the glasses for seconds and swallows
   * input — after arriving that looked like a complete hang.
   */
  let pageFailedAt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** The arrival page is up; GPS fixes no longer redraw it. */
  let arrivalShown = false;
  /** The map last sent and a fingerprint of each of its four tiles; a new one goes out only when it would look different. */
  let sentMap: { frame: MapFrame; hashes: readonly number[] } | null = null;
  /** What the turn images last sent showed, and when the card went out. */
  let sentIconKey = "";
  let sentCardKey = "";
  let sentRoad = "";
  let sentCardAt = 0;
  /** What the HUD's two pictures last showed. */
  let sentHudArrow = "";
  let sentHudLimit: number | null | undefined = undefined;
  let sentHudSpeed = "";
  /** HUD page changes the glasses refused in a row; at HUD_MAX_FAILURES the classic page takes over for this session. */
  let hudFailures = 0;
  let sentHudSpeedAt = 0;
  /** Direction of travel from the GPS, used on the map when the route cannot say (off route). */
  let gpsHeading: number | null = null;
  /** Bumped for every new route, so the overview image knows to redraw. */
  let routeVersion = 0;
  /**
   * Real streets for the overview, fetched once per route - lazily, the first
   * time the overview is shown - and never waited for: the route is drawn at
   * once and the streets join it when (if) they arrive.
   */
  const streetSource = createStreetSource();
  // Private build: the route's own street names from your Valhalla (VITE_STREETS_URL), reliable;
  // the streets around the route still come from Overpass when that answers.
  const streetsUrl = buildStreetsUrl();
  /**
   * One trace_attributes request per route brings both the route's street
   * names (map) and its speed limits (speed box). Your own Valhalla
   * (VITE_STREETS_URL) gets the whole route; the public router only a
   * request that fits a normal URL, i.e. the first part of a long route.
   */
  let trace: { route: number; url: string; result: Promise<RouteTraceOutcome> } | null = null;
  const traceUrl = (): string => streetsUrl || (usesMockRouter(data) ? "" : routerUrlOf(data).replace(/\/+$/, ""));
  const traceOf = (forRoute: number): Promise<RouteTraceOutcome> | null => {
    const url = traceUrl();
    if (!nav || forRoute !== routeVersion || !url) return null;
    if (trace && trace.route === forRoute && trace.url === url) return trace.result;
    // The public router takes a URL of limited length: a long route goes in a few parts, one per second,
    // so the limits (and brake hints) reach beyond the first stretch. Your own server gets it whole.
    const source = createRouteStreetSource({ url, ...(streetsUrl ? {} : { maxUrlLength: PUBLIC_TRACE_URL_MAX, chunks: PUBLIC_TRACE_CHUNKS }) });
    trace = { route: forRoute, url, result: source.load(nav.route.shape, data.mode) };
    return trace.result;
  };
  // Speed box (driving, cycling): smoothed GPS speed and the limit of the road from the trace.
  const speedMeter = new SpeedMeter();
  let speedLimits: { route: number; spans: readonly SpeedLimitSpan[] } | null = null;
  let limitsTimer: ReturnType<typeof setTimeout> | null = null;
  /** Where the limit drops along the route (once per route, from the same spans), and the hint/warning state. */
  let drops: { route: number; list: readonly LimitDrop[]; length: number } | null = null;
  const brakeAdvisor = new BrakeAdvisor();
  const speedingWatch = new SpeedingWatch();
  const dropsNow = (): { list: readonly LimitDrop[]; length: number } => {
    if (!nav || !speedLimits || speedLimits.route !== routeVersion) return { list: [], length: 0 };
    if (!drops || drops.route !== routeVersion) {
      const along = cumulativeMeters(nav.route.shape);
      drops = { route: routeVersion, list: limitDrops(speedLimits.spans, along), length: along[along.length - 1] ?? 0 };
    }
    return drops;
  };
  const showsSpeed = (): boolean => nav !== null && data.mode !== "walking" && !progressOf(nav).arrived;
  const speedNow = (): SpeedReading => {
    if (DEMO) return { kmh: 52, limit: 50 };
    let limit: number | null = null;
    if (nav?.position && speedLimits?.route === routeVersion) {
      const projection = projectOntoPath(nav.position, nav.route.shape);
      if (projection) limit = limitAt(speedLimits.spans, projection.index);
    }
    const now = Date.now();
    // With the car link the car's own speed, while it is fresh; otherwise the GPS (marked).
    return { ...chooseSpeed(car, speedMeter.kmh(now), now, BYD_URL !== "" && data.mode === "driving"), limit };
  };
  /** Fetches the limits of a new route, a moment after the route itself (the public server allows one request per second). */
  const loadSpeedLimits = (): void => {
    if (limitsTimer !== null) clearTimeout(limitsTimer);
    limitsTimer = null;
    if (!nav || data.mode === "walking" || DEMO) return;
    const forRoute = routeVersion;
    limitsTimer = setTimeout(() => {
      limitsTimer = null;
      if (closed) return;
      void traceOf(forRoute)?.then((result) => {
        if (closed || forRoute !== routeVersion) return;
        if (result.error) { console.warn("[openglance] speed limits unavailable:", result.error); return; }
        speedLimits = { route: forRoute, spans: result.limits };
        void draw();
      });
    }, TRACE_DELAY_MS);
  };
  let streets: { route: number; list: readonly Street[] } = { route: -1, list: [] };
  let streetsAskedFor = -1;
  let streetsVersion = 0;
  let closed = false;
  /** An exit confirmation is on screen; a second double tap must not stack another. */
  let exiting = false;
  let tickTimer: ReturnType<typeof setInterval> | null = null;
  let hudTimer: ReturnType<typeof setInterval> | null = null;

  // Car link (private build, VITE_BYD_URL): the byd-bridge's GET /state, read only -
  // the car's speed instead of the GPS and the battery at arrival. Nothing is sent to the car.
  const BYD_URL = DEMO ? "" : buildBydUrl();
  let car: CarSnapshot | null = null;
  let carStatus: CarLine["status"] = BYD_URL ? "waiting" : "off";
  let carTimer: ReturnType<typeof setTimeout> | null = null;
  let carShown = "";
  let carSpotKey = "";
  const navigatingByCar = (): boolean => nav !== null && data.mode === "driving";
  const scheduleCar = (delay?: number): void => {
    if (!BYD_URL || closed) return;
    if (carTimer !== null) clearTimeout(carTimer);
    carTimer = setTimeout(() => { void pollCar(); }, delay ?? (navigatingByCar() ? CAR_POLL_NAV_MS : CAR_POLL_IDLE_MS));
  };
  const pollCar = async (): Promise<void> => {
    carTimer = null;
    if (!BYD_URL || closed) return;
    const next = await fetchCar(BYD_URL, Date.now);
    if (closed) return;
    if (next) { car = next; carStatus = "ok"; } else carStatus = "offline";
    // "Wo ist mein Auto" on the list: the car's last place, as the BYD cloud reported it.
    const spot = next?.position ? { at: { lat: next.position.lat, lon: next.position.lon }, ageMin: next.position.ageMin } : null;
    const spotKey = spot ? `${spot.at.lat.toFixed(5)},${spot.at.lon.toFixed(5)},${spot.ageMin ?? ""}` : "";
    if (next && spotKey !== carSpotKey) {
      carSpotKey = spotKey;
      setCarSpot(spot);
      if (screen === "list") { cursor = clampCursor(data, cursor, shownAppts); void draw(); }
    }
    const shown = JSON.stringify([carStatus, car?.soc, car?.rangeKm]);
    if (shown !== carShown) {
      carShown = shown;
      // Not while something is being typed on the phone page.
      const active = (globalThis.document as Document | undefined)?.activeElement as HTMLElement | null | undefined;
      if (!active?.matches?.("input, select, textarea")) refreshPhone();
    }
    if (navigatingByCar()) void draw();
    scheduleCar();
  };
  const carLine = (): CarLine | null => (BYD_URL ? { status: carStatus, soc: car?.soc ?? null, rangeKm: car?.rangeKm ?? null } : null);
  /** Battery now and at arrival while navigating by car with the link; null otherwise. */
  const batteryNow = (): BatteryEstimate | null => {
    if (!BYD_URL || !nav || data.mode !== "driving") return null;
    const progress = progressOf(nav);
    if (progress.arrived) return null;
    return batteryEstimate(car, progress.distanceRemaining, data.carUsableKwh, Date.now());
  };
  // Glucose (private build, VITE_SUGAR_URL): the owner's own Nightscout server, read only, once a
  // minute and only while navigating by car. A failed request changes nothing on the glasses; the
  // text is redrawn through the normal diffed draw (text containers only, no page rebuild).
  const SUGAR_URL = DEMO ? "" : buildSugarUrl();
  const SUGAR_TOKEN = buildSugarToken();
  let sugarReading: SugarReading | null = null;
  let sugarTimer: ReturnType<typeof setTimeout> | null = null;
  let sugarBusy = false;
  const sugarActive = (): boolean => SUGAR_URL !== "" && data.sugar && nav !== null && data.mode === "driving";
  const sugarNow = (): SugarDisplay | null => (sugarActive() ? sugarDisplay(sugarReading, Date.now()) : null);
  const pollSugar = async (): Promise<void> => {
    sugarTimer = null;
    if (closed || sugarBusy || !sugarActive()) return;
    sugarBusy = true;
    try {
      const before = JSON.stringify(sugarNow());
      const next = await fetchSugar(SUGAR_URL, SUGAR_TOKEN);
      if (closed) return;
      if (next && (!sugarReading || next.at >= sugarReading.at)) sugarReading = next;
      if (JSON.stringify(sugarNow()) !== before) void draw();
    } finally {
      sugarBusy = false;
      if (!closed && sugarActive() && sugarTimer === null) sugarTimer = setTimeout(() => { void pollSugar(); }, SUGAR_POLL_MS);
    }
  };
  /** Called by the tick: starts polling when navigating by car begins (or the setting is switched on); nothing otherwise. */
  const ensureSugarPolling = (): void => {
    if (sugarActive() && sugarTimer === null && !sugarBusy) sugarTimer = setTimeout(() => { void pollSugar(); }, 0);
  };
  // Today's appointments (private build, VITE_BRIEF_URL + VITE_BRIEF_TOKEN): the owner's own Quiet
  // Hub daemon, GET /brief/appointments. Asked at start and every 5 min while the destination list is
  // shown (tick-driven, one request at a time, a failure waits the full interval); a failure keeps
  // what the list had and draws nothing new. Off in the demo and with the demo router.
  const BRIEF_URL = DEMO ? "" : buildBriefUrl();
  const BRIEF_TOKEN = buildBriefToken();
  const apptsOn = (): boolean => !DEMO && briefConfigured(BRIEF_URL, BRIEF_TOKEN) && data.appointments && !usesMockRouter(data);
  let appts: readonly Appointment[] = [];
  let apptsBusy = false;
  let apptsAskedAt: number | null = null;
  /** Travel time by car per appointment: at most one route request per appointment per ETA_REFRESH_MS, only while the list is open. */
  const apptEtas = new Map<string, ApptEta>();
  let etaBusy = false;
  /** The appointment being driven to (set by a tap on its row, found again by its place after a restart). */
  let apptTrip: Appointment | null = null;
  /** The appointment rows the list shows; the cursor follows its entry when they change. */
  let shownAppts: readonly ListAppt[] = [];
  const apptRows = (): readonly ListAppt[] => {
    if (!apptsOn()) return [];
    const now = Date.now();
    return upcomingAppointments(appts, now).map((appt) => {
      const travelS = apptEtas.get(appt.key)?.travelS ?? null;
      return { appt, leave: travelS === null ? null : departureText(departure(appt.startMs, travelS, now), locale) };
    });
  };
  /** Recomputes the rows; when other appointments are listed than before, the cursor stays on its entry. */
  const syncApptRows = (): readonly ListAppt[] => {
    const next = apptRows();
    const keys = (rows: readonly ListAppt[]): string => rows.map((r) => r.appt.key).join(",");
    if (keys(next) !== keys(shownAppts)) cursor = followCursor(data, cursor, shownAppts, next);
    shownAppts = next;
    return next;
  };
  const pollAppointments = async (): Promise<void> => {
    if (!shouldFetchAppointments({ on: apptsOn(), listShown: screen === "list", busy: apptsBusy, lastAttemptAt: apptsAskedAt, now: Date.now() })) return;
    apptsBusy = true;
    apptsAskedAt = Date.now();
    try {
      const next = await fetchAppointments(BRIEF_URL, BRIEF_TOKEN);
      if (closed || next === null) return;
      appts = next;
      // A navigation picked up after a restart finds its appointment again by the place.
      const going = trip;
      if (apptTrip === null && going) apptTrip = upcomingAppointments(next, Date.now()).find((a) => samePlaceAs(a.at, going.to)) ?? null;
      if (screen === "list") void draw();
    } finally {
      apptsBusy = false;
    }
  };
  /** The travel time of the next appointment that needs one: only on the list, with a position, one request at a time. */
  const pollApptEta = async (): Promise<void> => {
    if (!apptsOn() || screen !== "list" || etaBusy || !position || closed) return;
    const now = Date.now();
    const due = nextEtaRequest(upcomingAppointments(appts, now), apptEtas, now);
    if (!due) return;
    etaBusy = true;
    const before = apptEtas.get(due.key);
    apptEtas.set(due.key, { askedAt: now, travelS: before?.travelS ?? null });
    try {
      await routeGate.ready();
      const from = position;
      if (closed || screen !== "list" || !from) return;
      const outcome = await router().route({ from, to: due.at, mode: "driving" });
      if (closed) return;
      if (outcome.route) apptEtas.set(due.key, { askedAt: now, travelS: outcome.route.duration });
      else console.warn("[openglance] appointment drive time unavailable:", outcome.code);
      if (screen === "list") void draw();
    } finally {
      etaBusy = false;
    }
  };

  /**
   * Every route request takes a number, and an answer that arrives after a
   * newer request — or after navigation was stopped — is dropped. Without it a
   * slow reroute for the old destination could land after the route to the
   * new one, or switch navigation back on after a stop.
   */
  let routeSeq = 0;
  /** The public router allows one request per second; this keeps to it. */
  const routeGate = createRequestGate();
  let lastRouteAt: number | null = null;

  /**
   * The trip being navigated: where to, the stops still ahead (saved routes),
   * and how a saved route was begun. `routedStops` are the stops the current
   * route was calculated with; a reroute keeps those not yet passed.
   */
  let trip: { label: string; to: LatLng; stops: readonly RoutePoint[]; kind: JoinKind } | null = null;
  let routedStops: readonly RoutePoint[] = [];
  /** Bumped for every new trip (not for a reroute): charging stations are fetched once per trip. */
  let tripSeq = 0;

  // Charging stations (setting "chargers", OpenStreetMap via Overpass).
  const chargerSource = createChargerSource();
  /** Stations around the trip's first route, fetched once per trip while driving. */
  let tripChargers: { trip: number; list: readonly Charger[] } | null = null;
  let chargersAskedFor = -1;
  let chargersVersion = 0;
  let alongCache: { route: number; version: number; list: readonly RouteCharger[]; length: number } | null = null;
  /** The "charging nearby" page of the glasses. */
  let chargerList: ChargerListState | null = null;
  let chargerSeq = 0;

  // Route choice before a car start (the router offered other ways): the glasses page "routes".
  let routeChoice: RouteChoice | null = null;
  let choiceSeq = 0;
  /** Battery model for the route choice ("Akku −2 %"): only with the car link, where the battery matters. */
  const energyModel = (): EnergyModel | null => (BYD_URL ? { consumption: consumptionOf(car), usableKwh: data.carUsableKwh } : null);

  // Traffic (private build, VITE_TRAFFIC_URL): the own glass-traffic service. Only the route line goes there.
  const TRAFFIC_URL = DEMO ? "" : buildTrafficUrl();
  startDiag(TRAFFIC_URL, DIAG_VERSION);
  const trafficFetch = TRAFFIC_URL ? createTrafficClient(TRAFFIC_URL) : null;
  const trafficPoller = new TrafficPoller();
  let traffic: TrafficState | null = null;
  /** Another way that saves time, found after a traffic answer; a tap on its line takes it. */
  let detourOffer: { route: Route; savesMin: number; until: number; forRoute: number } | null = null;
  let detourBusy = false;
  /** Which hint line the glasses show now: a tap takes the detour only while its line is up. */
  let shownAlert: AlertKind | null = null;
  let classicHintKind: AlertKind | null = null;

  // Fixed speed-enforcement points (setting "cameras", OpenStreetMap via Overpass, once per route; never in Germany).
  const cameraSource = createCameraSource();
  const cameraGate = new CameraCountryGate(
    DEMO ? null : (p) => photonCountry(geocoderUrlOf(data))(p),
    () => { if (screen === "nav") void draw(); },
  );
  let tripCameras = new Map<string, Camera>();
  let camerasTrip = -1;
  let camerasAskedFor = -1;
  let camerasVersion = 0;
  let camerasCache: { route: number; version: number; list: readonly RouteCamera[] } | null = null;
  /** Metres along the current route, per point (once per route). */
  let routeAlongCache: { route: number; along: readonly number[] } | null = null;
  const routeAlong = (): readonly number[] => {
    if (!nav) return [];
    if (!routeAlongCache || routeAlongCache.route !== routeVersion) routeAlongCache = { route: routeVersion, along: cumulativeMeters(nav.route.shape) };
    return routeAlongCache.along;
  };
  const routeLength = (): number => { const along = routeAlong(); return along[along.length - 1] ?? 0; };

  // Peaks nearby (setting "peaks", OpenStreetMap via Overpass, one request per area, kept on the phone).
  const peakSource = createPeakSource({
    storage: {
      load: async () => (await bridge.getLocalStorage(PEAK_CACHE_KEY)) ?? "",
      save: async (raw) => { await bridge.setLocalStorage(PEAK_CACHE_KEY, raw); },
    },
  });
  let peakPage: PeakPageState | null = null;
  let peakSeq = 0;
  /** The peaks last loaded and for which area; distances and bearings are measured against them on every fix. */
  let peakData: { peaks: readonly Peak[]; area: string } | null = null;
  let peakLoading = false;
  /** GPS course and speed of the last fix: the band turns with it while moving. */
  let course: Course | null = null;
  /** What the band images last showed, a fingerprint of each half, and when they went out. */
  let sentBand: { key: string; hashes: readonly number[] } | null = null;
  let sentBandAt = 0;
  const facingNow = (): Facing => facingFor(course, Date.now(), data.peakFacing);

  // Spoken turn instructions: Piper server voice (private build: VITE_TTS_URL), phone voice as fallback.
  const tts = new ServerTts({ url: buildTtsUrl(), voices: DEFAULT_VOICES });
  const announcer = new TurnAnnouncer();
  const announce = (): void => {
    if (!nav || !data.announce || DEMO) return;
    const a = announcer.next(progressOf(nav), { routeId: routeVersion, mode: data.mode, locale, hasFix: nav.position !== null });
    if (a) tts.speak(a.text, { lang: locale, priority: a.priority, key: a.key, maxAgeMs: a.maxAgeMs });
  };
  const voiceState = (): "needs-tap" | "server" | "browser" | "off" => {
    if (!data.announce || !tts.available) return "off";
    if (!tts.unlocked) return "needs-tap";
    return tts.lastSource === "browser" || !tts.configured ? "browser" : "server";
  };

  const router = (): RoutingProvider => {
    if (usesMockRouter(data)) return createMockProvider();
    const url = routerUrlOf(data);
    const clientId = clientIdFor(url);
    return createValhallaProvider({
      url,
      language: locale === "de" ? "de-DE" : "en-US",
      ...(clientId ? { clientId } : {}),
    });
  };

  let geocoder: { url: string; instance: Geocoder } | null = null;
  const searchPlaces: Geocoder["search"] = (query, options) => {
    const url = geocoderUrlOf(data);
    if (!geocoder || geocoder.url !== url) geocoder = { url, instance: createGeocoder({ url }) };
    return geocoder.instance.search(query, options);
  };

  /**
   * The glasses' side menu (QIS v1.2). While navigating it holds the view, the HUD layout and the speed
   * hints (driving), the armed stop and the help; elsewhere the help and the two settings. Labels never
   * show a state (the page is not rebuilt for that), so the settings are toggles and the view is set
   * explicitly. It is part of the page: another menu key means one rebuild, which happens only when
   * the screen changes - never per fix.
   */
  const menuNow = (): MenuSpec => {
    // 15.10.2026, measured with the step log on the real glasses: the side
    // menu shows, but its clicks never reach the app, and while a page has a
    // menu the hold opens it instead of reaching the app. Until that works the
    // pages carry no menu; swipe and hold do what the menu was meant to.
    if (!SIDE_MENU) return { key: "none", items: [] };
    const item = (id: number, key: string): { id: number; label: string } => ({ id, label: tr(messages, locale, key) });
    if (screen === "nav" || (screen === "help" && helpFrom === "nav")) {
      const driving = data.mode === "driving";
      return {
        key: `nav:${locale}:${driving}`,
        items: [
          item(MENU.viewTurns, "m.viewTurns"), item(MENU.viewMap, "m.viewMap"),
          ...(driving ? [item(MENU.hud, "m.hud"), item(MENU.cameras, "m.cameras")] : []),
          item(MENU.stop, "m.stop"), item(MENU.help, "m.help"),
        ],
      };
    }
    return { key: `other:${locale}`, items: [item(MENU.help, "m.help"), item(MENU.hud, "m.hud"), item(MENU.cameras, "m.cameras")] };
  };

  /** Which of the three glasses pages the state calls for. */
  const kindNow = (): PageKind => {
    if (screen === "peaks") return peakPage?.phase === "ready" && peakPage.view === "list" ? "text" : "peaks";
    if (screen !== "nav") return "text";
    // Arrived at an appointment: the text page, so its hint line has room (one page change on arrival, none per fix).
    if (data.glassView === "overview" && nav && !errorKey && !(apptTrip && progressOf(nav).arrived)) return "overview";
    // Without a turn to show (idle, error, arrived) the plain text page does.
    if (!nav || errorKey || progressOf(nav).arrived) return "text";
    // Driving: the HUD layout unless the phone asks for the classic page - or
    // the glasses refused the HUD page twice in a row this session (then the
    // classic page, which they take, instead of "Route wird berechnet…" for ever).
    return data.mode === "driving" && data.hudLayout !== "classic" && hudFailures < HUD_MAX_FAILURES ? "hud" : "turns";
  };

  const currentView = (kind: PageKind): NavView => {
    if (screen === "list") return listView(data, cursor, locale, DEMO || canSpeak(), syncApptRows());
    if (screen === "help") return helpView(locale);
    if (screen === "routes" && routeChoice) return routeChoiceView(routeChoice, locale, trip?.label ?? selectionLabel(data), energyModel());
    if (screen === "voice" && voice) return voiceView(voice, locale);
    if (screen === "chargers" && chargerList) return chargerView(chargerList, locale);
    if (screen === "peaks" && peakPage) {
      return kind === "text" && peakPage.phase === "ready"
        ? peakListView(peakPage, data.peakRadiusKm, locale)
        : bandView(peakPage, facingNow(), data.peakRadiusKm, locale);
    }
    if (kind === "hud" && nav) return hudView(hudNow());
    const layout: GlassLayout = kind === "overview" ? "overview" : "turns";
    return buildView(nav ? progressOf(nav) : null, {
      mode: data.mode,
      navigating: nav !== null,
      rerouting,
      error: errorKey ? tr(messages, locale, errorKey) : null,
      status: startPhase === "gps" ? tr(messages, locale, "g.findingFix") : startPhase === "route" ? routingStatus() : null,
      mock: usesMockRouter(data),
      waitingForFix: nav !== null && position === null,
      locale,
      destination: trip?.label ?? selectionLabel(data),
      layout,
      bigDistance: kind === "turns",
      charger: kind === "turns" ? classicHint() : null,
      speed: showsSpeed() ? speedNow() : null,
      battery: kind === "turns" || kind === "overview" ? batteryNow() : null,
      sugar: kind === "turns" || kind === "overview" ? sugarNow() : null,
      armedStop: stopArmed(),
      appointment: nav && apptTrip ? { startMs: apptTrip.startMs, title: apptTrip.title } : null,
    });
  };

  /**
   * The HUD content now. Between fixes the distance to the turn is counted
   * down with the speed (dead reckoning, at most RECKON_MAX_MS ahead of the
   * last fix), so the 1-s tick moves the number without a new GPS fix.
   */
  const hudNow = () => {
    const progress = progressOf(nav!);
    const now = Date.now();
    const speed = showsSpeed() ? speedNow() : null;
    const sinceFix = Number.isFinite(positionAt) ? Math.max(0, now - positionAt) : 0;
    const distanceToTurn = DEMO ? progress.distanceToManeuver : reckonDistance(progress.distanceToManeuver, speed?.kmh ?? null, sinceFix);
    const ahead = progress.distanceToManeuver - distanceToTurn;
    const { list } = dropsNow();
    const alongNow = routeLength() - progress.distanceRemaining + ahead;
    const brake = list.length ? brakeAdvisor.update(list, alongNow, speed?.kmh ?? null) : null;
    // The limit is trusted while the position it came from is fresh.
    const speeding = speedingWatch.update(speed?.kmh ?? null, speed?.limit ?? null, DEMO ? 0 : sinceFix, now);
    const state: HudState | null = stopArmed() ? "armed" : rerouting ? "rerouting" : position === null ? "waitingFix" : progress.offRoute ? "offRoute" : null;
    return buildHud(progress, {
      locale,
      mock: usesMockRouter(data),
      distanceToTurn,
      speed,
      battery: batteryNow(),
      range: BYD_URL ? batteryRange(car, data.carUsableKwh, now) : null,
      sugar: sugarNow(),
      brake,
      speeding,
      charger: nextChargerLine(),
      appointment: apptTrip ? { startMs: apptTrip.startMs, title: apptTrip.title } : null,
      traffic: trafficNow(alongNow),
      camera: cameraNow(alongNow, speed, now),
      detour: detourNow(now),
      state,
    }, now);
  };

  /** The next jam/closure ahead, from the latest traffic answer for this route. */
  const trafficNow = (alongNow: number): TrafficAhead | null => (traffic?.route === routeVersion ? trafficAhead(traffic, alongNow) : null);
  const detourNow = (now: number): { savesMin: number } | null =>
    (detourOffer && detourOffer.forRoute === routeVersion && detourOffer.until > now ? { savesMin: detourOffer.savesMin } : null);

  /**
   * The enforcement point to mention, if any. The country is checked only when
   * one is actually ahead, so a lookup near the border happens only near a point.
   */
  const cameraNow = (alongNow: number, speed: SpeedReading | null, now: number): CameraAhead | null => {
    if (!nav || !data.cameras || data.mode !== "driving" || camerasTrip !== tripSeq) return null;
    if (!camerasCache || camerasCache.route !== routeVersion || camerasCache.version !== camerasVersion) {
      const begun = Date.now();
      camerasCache = { route: routeVersion, version: camerasVersion, list: camerasAlong(nav.route.shape, [...tripCameras.values()]) };
      diag("compute", { what: "camerasAlong", ms: Date.now() - begun, shape: nav.route.shape.length, cameras: tripCameras.size, hits: camerasCache.list.length });
    }
    const ahead = cameraAhead(camerasCache.list, alongNow, speed?.kmh ?? null, speed?.limit ?? null);
    if (!ahead) return null;
    return cameraGate.allowed(nav.position ?? position, now) ? ahead : null;
  };

  /** Classic page: the one small hint line under the card - traffic, speed hint, detour, then the next charger. */
  const classicHint = (): string | null => {
    classicHintKind = null;
    if (!nav || data.mode !== "driving") return nextChargerLine();
    const progress = progressOf(nav);
    const now = Date.now();
    const alongNow = routeLength() - progress.distanceRemaining;
    const ahead = trafficNow(alongNow);
    const speed = showsSpeed() ? speedNow() : null;
    const camera = cameraNow(alongNow, speed, now);
    const detour = detourNow(now);
    const pick = (kind: AlertKind, text: string): string => { classicHintKind = kind; return text; };
    if (ahead && ahead.distance < TRAFFIC_NEAR_M) return pick("trafficNear", trafficText(ahead, locale));
    if (camera) return pick("camera", cameraText(camera, locale));
    if (detour) return pick("detour", detourText(detour.savesMin, locale));
    if (ahead) return pick("trafficFar", trafficText(ahead, locale));
    return nextChargerLine();
  };

  /** Fetches the enforcement points along a new route once (not for a route wholly inside Germany). */
  const ensureCameras = (): void => {
    if (!nav || !data.cameras || data.mode !== "driving" || DEMO || usesMockRouter(data) || camerasAskedFor === routeVersion) return;
    if (camerasTrip !== tripSeq) { tripCameras = new Map(); camerasTrip = tripSeq; camerasVersion++; }
    const forRoute = routeVersion;
    camerasAskedFor = forRoute;
    const shape = nav.route.shape;
    const step = Math.max(1, Math.floor(shape.length / 50));
    if (shape.filter((_, i) => i % step === 0).every((p) => coarseCountry(p) === "DE")) return;
    void cameraSource.along(shape).then((outcome) => {
      if (closed) return;
      if (outcome.error) {
        console.warn("[openglance] speed hints unavailable:", outcome.error);
        // Asked too soon after the last route: try again once the pause is over.
        if (outcome.error === "cooldown") setTimeout(() => { if (camerasAskedFor === forRoute) camerasAskedFor = -1; }, (outcome.waitS ?? 30) * 1000);
        return;
      }
      for (const camera of outcome.cameras) tripCameras.set(camera.id, camera);
      camerasVersion++;
      void draw();
    });
  };

  /**
   * Traffic on the route ahead: every 2 min while driving, once after a new
   * route (not sooner than 15 s after the last request), one request at a time.
   */
  const pollTraffic = async (): Promise<void> => {
    if (!trafficFetch || !nav || data.mode !== "driving" || screen !== "nav" || closed || progressOf(nav).arrived) return;
    const now = Date.now();
    if (!trafficPoller.due(routeVersion, now)) return;
    const forRoute = routeVersion;
    const fromIndex = nav.position ? projectOntoPath(nav.position, nav.route.shape)?.index ?? 0 : 0;
    const startAlong = routeAlong()[fromIndex] ?? 0;
    trafficPoller.begin(forRoute, now);
    try {
      const report = await trafficFetch(lineAhead(nav.route.shape, fromIndex));
      if (closed || forRoute !== routeVersion || !nav) return;
      if (!report) { console.warn("[openglance] traffic unavailable"); return; }
      traffic = { route: forRoute, startAlong, report };
      void draw();
      void checkDetour(forRoute);
    } finally {
      trafficPoller.end();
    }
  };

  /**
   * With DETOUR_MIN_SAVING_MIN or more of delay (or a closure) ahead: the
   * router's other ways from here, each with its own traffic; the best one is
   * offered when it saves enough. Only for a trip without stops (the router
   * offers other ways for two places alone).
   */
  const checkDetour = async (forRoute: number): Promise<void> => {
    if (!trafficFetch || detourBusy || !nav || !trip || trip.stops.length || !position || forRoute !== routeVersion) return;
    const progress = progressOf(nav);
    const alongNow = routeLength() - progress.distanceRemaining;
    const late = delayAhead(traffic, alongNow);
    const closedAhead = trafficNow(alongNow)?.type === "closure";
    if (late < DETOUR_MIN_SAVING_MIN && !closedAhead) { detourOffer = null; return; }
    detourBusy = true;
    try {
      await routeGate.ready();
      const from = position;
      const to = trip?.to;
      if (closed || forRoute !== routeVersion || !from || !to) return;
      const outcome = await router().route({ from, to, mode: "driving", alternates: MAX_ALTERNATES });
      if (closed || forRoute !== routeVersion || !outcome.route) return;
      const candidates = choicesFrom(outcome.route, outcome.alternates);
      const reports: (TrafficReport | null)[] = [];
      for (const candidate of candidates) reports.push(await trafficFetch(lineAhead(candidate.shape)));
      if (closed || forRoute !== routeVersion) return;
      const best = bestDetour(progress.secondsRemaining, late, closedAhead, candidates.map((c, i) => ({
        durationS: c.duration,
        delayMin: reports[i]?.delayMin ?? 0,
        // Without its own traffic answer a way cannot be judged: it is not offered.
        closure: reports[i] ? reports[i]!.closure : true,
      })));
      const chosen = best ? candidates[best.index] : undefined;
      detourOffer = best && chosen ? { route: chosen, savesMin: best.savesMin, until: Date.now() + DETOUR_OFFER_MS, forRoute } : null;
      void draw();
    } finally {
      detourBusy = false;
    }
  };

  /** Tap on "Umfahrung spart 7 min · Tippen": drives the other way from here. */
  const takeDetour = (): void => {
    const offer = detourOffer;
    if (!offer || offer.forRoute !== routeVersion) return;
    adoptRoute(offer.route, []);
    void draw();
  };

  /** "Calculating route…", and for a saved route begun far from its start, how it is joined. */
  const routingStatus = (): string => {
    const base = tr(messages, locale, "g.routing");
    const note = trip?.kind === "joined" ? "g.tripJoined" : trip?.kind === "toFirstStop" ? "g.tripFirstStop" : trip?.kind === "direct" ? "g.tripDirect" : null;
    return note ? base + "\n" + tr(messages, locale, note) : base;
  };

  /** Charging stations along the current route (driving, setting on), measured on the route. */
  const chargersOnRoute = (): { list: readonly RouteCharger[]; length: number } => {
    if (!nav || !data.chargers || data.mode !== "driving" || !tripChargers || tripChargers.trip !== tripSeq) return { list: [], length: 0 };
    if (!alongCache || alongCache.route !== routeVersion || alongCache.version !== chargersVersion) {
      const along = cumulativeMeters(nav.route.shape);
      alongCache = { route: routeVersion, version: chargersVersion, list: chargersAlong(nav.route.shape, tripChargers.list), length: along[along.length - 1] ?? 0 };
    }
    return alongCache;
  };

  /** "Laden in 12 km · 150 kW" for the next fast station ahead, or null. */
  const nextChargerLine = (): string | null => {
    if (!nav) return null;
    const { list, length } = chargersOnRoute();
    if (!list.length) return null;
    const travelled = Math.max(0, length - progressOf(nav).distanceRemaining);
    const next = nextAhead(list, travelled);
    if (!next) return null;
    const power = powerText(next.charger);
    const d = formatDistance(next.along - travelled, locale);
    return tr(messages, locale, power ? "g.charger" : "g.chargerNoPower", { d, p: power });
  };

  /** Fetches the stations along the trip once, the first time a driving route is up with the setting on. */
  const ensureTripChargers = (): void => {
    if (!nav || !data.chargers || data.mode !== "driving" || chargersAskedFor === tripSeq) return;
    const forTrip = tripSeq;
    chargersAskedFor = forTrip;
    if (usesMockRouter(data)) {
      tripChargers = { trip: forTrip, list: demoChargers(nav.route.shape) };
      chargersVersion++;
      return;
    }
    void chargerSource.along(nav.route.shape).then((outcome) => {
      if (closed || forTrip !== tripSeq) return;
      if (outcome.error) {
        console.warn("[openglance] charging stations unavailable:", outcome.error);
        // Asked too soon after another request: try again on a later draw.
        if (outcome.error === "cooldown") chargersAskedFor = -1;
        return;
      }
      tripChargers = { trip: forTrip, list: outcome.chargers };
      chargersVersion++;
      void draw();
    });
  };

  /**
   * What the map would show now, as a picture description and as the frame
   * that is compared with what was sent. The map looks the way the car faces:
   * along the route when on it, by the GPS heading when off it, north up when
   * neither is known.
   */
  const mapNow = (): { scene: MapScene; frame: MapFrame } => {
    const now = Date.now();
    if (!nav) {
      const view = { center: position ?? { lat: 0, lon: 0 }, bearing: null, range: rangeFor(0) };
      return {
        scene: { route: [], next: null, streets: [], view },
        frame: { route: -1, streets: -1, maneuver: -1, range: view.range, position, bearing: null, at: now },
      };
    }
    const progress = progressOf(nav);
    const center = nav.position ?? nav.route.shape[0] ?? { lat: 0, lon: 0 };
    const onRoute = courseAhead(nav.route.shape, center);
    const bearing = progress.offRoute ? gpsHeading : onRoute ?? gpsHeading;
    const view = { center, bearing, range: rangeFor(progress.distanceToManeuver) };
    const next = progress.maneuver && !progress.arrived ? nav.route.shape[progress.maneuver.shapeIndex] ?? null : null;
    const list = data.streets && streets.route === routeVersion ? streets.list : [];
    const stations = chargersOnRoute().list;
    return {
      scene: {
        route: nav.route.shape, next, streets: list, view,
        ...(stations.length ? { chargers: stations.map((c) => c.charger.at) } : {}),
        ...(showsSpeed() ? { speedPlate: true } : {}),
        nextIndex: next && progress.maneuver ? progress.maneuver.shapeIndex : null,
        nextStreet: next ? progress.maneuver?.street : undefined,
        currentStreet: nav.route.maneuvers[nav.maneuverIndex]?.street,
      },
      frame: {
        route: routeVersion,
        // Switching streets off must redraw without them, so the setting is part of the picture.
        streets: data.streets ? streetsVersion : -1,
        maneuver: nav.maneuverIndex,
        range: view.range,
        position: center,
        bearing,
        at: now,
        ...(stations.length ? { chargers: chargersVersion } : {}),
        ...(showsSpeed() ? { speedPlate: true } : {}),
      },
    };
  };

  /**
   * Streets for the map, from two sources: the route's own street names (own
   * routing server, once per route) and the streets AROUND THE CAR (Overpass),
   * fetched around the current place and again whenever the car nears the edge
   * of what was loaded - the map follows the car, and a whole long route is
   * far too big to ask for (no street ever came on a 116 km trip, 15.10.).
   * Asked only once the map has stayed up for STREETS_DWELL_MS, so a swipe
   * through to the other view costs no request.
   */
  let streetsTimer: ReturnType<typeof setTimeout> | null = null;
  let streetParts: { route: number; own: readonly Street[]; around: readonly Street[] } = { route: -1, own: [], around: [] };
  let aroundBox: { route: number; box: BBox } | null = null;
  let aroundLoading = false;
  const joinStreets = (forRoute: number, which: "own" | "around", list: readonly Street[]): void => {
    if (closed || forRoute !== routeVersion) return;
    if (streetParts.route !== forRoute) streetParts = { route: forRoute, own: [], around: [] };
    if (which === "own" && !list.length) return;
    streetParts = { ...streetParts, [which]: list };
    streets = { route: forRoute, list: [...streetParts.own, ...streetParts.around] };
    streetsVersion++;
    void draw();
  };
  const aroundNeeded = (): LatLng | null => {
    if (!nav || aroundLoading) return null;
    const here = nav.position ?? nav.route.shape[0] ?? null;
    if (!here) return null;
    if (aroundBox && aroundBox.route === routeVersion && wellInside(aroundBox.box, here, AROUND_REFETCH_EDGE_M)) return null;
    return here;
  };
  const ensureStreets = (): void => {
    if (!nav || !data.streets || usesMockRouter(data) || streetsTimer !== null) return;
    if (streetsAskedFor === routeVersion && aroundNeeded() === null) return;
    const forRoute = routeVersion;
    streetsTimer = setTimeout(() => {
      streetsTimer = null;
      if (closed || !nav || forRoute !== routeVersion || data.glassView !== "overview") return;
      if (streetsAskedFor !== forRoute) {
        streetsAskedFor = forRoute;
        const own = streetsUrl ? traceOf(forRoute) : null;
        if (own) {
          void own.then((result) => {
            if (result.error) console.warn("[openglance] route street names unavailable:", result.error);
            joinStreets(forRoute, "own", result.streets);
          });
        }
      }
      const here = aroundNeeded();
      if (here) fetchStreetsAround(forRoute, here);
    }, STREETS_DWELL_MS);
  };
  const fetchStreetsAround = (forRoute: number, here: LatLng): void => {
    const box = boxAround(here, AROUND_RADIUS_M[data.mode]);
    const classes = box ? classesFor(box, data.mode) : [];
    if (!box || !classes.length) return;
    aroundLoading = true;
    const begun = Date.now();
    void streetSource.load(box, classes).then((outcome) => {
      aroundLoading = false;
      diag("streets", { ms: Date.now() - begun, n: outcome.streets.length, error: outcome.error ?? "" });
      if (outcome.error) { console.warn("[openglance] streets unavailable:", outcome.error); return; }
      if (forRoute !== routeVersion) return;
      aroundBox = { route: forRoute, box };
      joinStreets(forRoute, "around", outcome.streets);
    }, () => { aroundLoading = false; });
  };

  /** The turn card for a view: its big distance and how full the approach bar is. */
  const turnCardFor = (view: NavView): TurnCard | null => {
    if (view.big === undefined || !nav) return null;
    const leg = nav.route.maneuvers[nav.maneuverIndex]?.length ?? 0;
    return { label: view.big, steps: approachSteps(progressOf(nav).distanceToManeuver, leg, data.mode) };
  };

  const drawNow = async (): Promise<void> => {
    if (closed) return;
    if (screen === "nav") { ensureTripChargers(); ensureCameras(); }
    const kind = kindNow();
    const view = currentView(kind);
    shownAlert = screen !== "nav" ? null : view.hud ? view.hud.alertKind ?? null : kind === "turns" ? classicHintKind : null;
    const menu = menuNow();
    const samePage = pageReady && pageKind === kind && pageMenuKey === menu.key;
    // After a failed page change wait PAGE_RETRY_MS before the next attempt (one timer, not one per fix).
    if (!samePage && pageFailedAt && Date.now() - pageFailedAt < PAGE_RETRY_MS) {
      if (retryTimer === null) {
        retryTimer = setTimeout(() => { retryTimer = null; void draw(); }, PAGE_RETRY_MS - (Date.now() - pageFailedAt));
      }
      return;
    }
    const fail = (reason: string | undefined): void => {
      pageReady = false;
      pageFailedAt = Date.now();
      console.warn("[openglance] draw failed:", reason);
      diag("page.fail", { kind, reason: reason ?? "" });
    };

    if (kind === "overview") {
      ensureStreets();
      const { scene, frame } = mapNow();
      const needImage = !samePage || needsMapImage(sentMap?.frame ?? null, frame);
      if (samePage && sameView(lastView, view) && !needImage) return;
      let tiles: (Uint8Array | null)[] | undefined;
      let hashes: readonly number[] = [];
      if (needImage) {
        try {
          const pngs = await renderMapTiles(scene);
          hashes = pngs.map(fingerprint);
          // A tile that looks like the one already on the glasses is not sent again.
          tiles = pngs.map((png, index) => (samePage && sentMap?.hashes[index] === hashes[index] ? null : png));
        } catch (thrown) {
          console.warn("[openglance] map image failed:", thrown);
          return;
        }
      }
      if (closed) return;
      const images = tiles ? { map: tiles } : {};
      const result = samePage ? await updatePage(bridge, view, kind, images) : await showPage(bridge, view, kind, images, menu);
      if (closed) return;
      if (!result.ok) { fail(result.reason); return; }
      pageReady = true; pageKind = kind; pageMenuKey = menu.key; lastView = view; pageFailedAt = 0;
      if (tiles) sentMap = { frame, hashes };
      return;
    }

    if (kind === "peaks") {
      // The band goes out when what it shows changes, and while only the
      // facing direction moves no more often than BAND_MIN_INTERVAL_MS.
      const facing = facingNow();
      const picks = peakPage?.phase === "ready" ? bandPicks(peakPage.sights, facing.deg, peakPage.pick) : { shown: [], left: 0, right: 0 };
      const layout = layoutBand(picks, facing.deg, locale);
      const key = bandKey(layout, facing.deg);
      const now = Date.now();
      const needImage = !samePage || (key !== sentBand?.key && now - sentBandAt >= BAND_MIN_INTERVAL_MS);
      if (samePage && sameView(lastView, view) && !needImage) return;
      let halves: (Uint8Array | null)[] | undefined;
      let hashes: readonly number[] = [];
      if (needImage) {
        try {
          const pngs = await renderBandPngs(layout, facing.deg, locale);
          hashes = pngs.map(fingerprint);
          halves = pngs.map((png, index) => (samePage && sentBand?.hashes[index] === hashes[index] ? null : png));
        } catch (thrown) {
          console.warn("[openglance] peaks band failed:", thrown);
          return;
        }
      }
      if (closed) return;
      const images = halves ? { band: halves } : {};
      const result = samePage ? await updatePage(bridge, view, kind, images) : await showPage(bridge, view, kind, images, menu);
      if (closed) return;
      if (!result.ok) { fail(result.reason); return; }
      pageReady = true; pageKind = kind; pageMenuKey = menu.key; lastView = view; pageFailedAt = 0;
      if (halves) { sentBand = { key, hashes }; sentBandAt = now; }
      return;
    }

    if (kind === "hud") {
      // Three things are pictures: the arrow (sent when the manoeuvre TYPE
      // changes), the limit sign (when the limit changes) and the large speed
      // (when the shown km/h changes, at most once a second - turning "too
      // fast" on or off goes out at once). Distance and every line are text;
      // the texts go out before the pictures, so the speed never delays them.
      const hud = view.hud!;
      const arrowKey = hud.arrow ?? "none";
      const sendArrow = !samePage || arrowKey !== sentHudArrow;
      const sendLimit = !samePage || hud.limit !== sentHudLimit;
      const speedKey = speedBigKey(hud.speedBig);
      const speedNow = Date.now();
      const fastFlipped = speedKey.split("|")[1] !== sentHudSpeed.split("|")[1];
      const sendSpeed = !samePage || (speedKey !== sentHudSpeed && (fastFlipped || speedNow - sentHudSpeedAt >= SPEED_IMAGE_MIN_INTERVAL_MS));
      if (samePage && sameView(lastView, view) && !sendArrow && !sendLimit && !sendSpeed) return;
      const images = { hud: {
        ...(sendArrow ? { arrow: hud.arrow } : {}),
        ...(sendLimit ? { limit: hud.limit } : {}),
        ...(sendSpeed ? { speed: hud.speedBig ?? null } : {}),
      } };
      const result = samePage ? await updatePage(bridge, view, kind, images) : await showPage(bridge, view, kind, images, menu);
      if (closed) return;
      if (!result.ok) {
        fail(result.reason);
        if (!samePage) {
          hudFailures += 1;
          if (hudFailures >= HUD_MAX_FAILURES) {
            console.warn("[openglance] the glasses refused the HUD page twice - classic turn page for this session");
            pageFailedAt = 0; // try the classic page right away
            void draw();
          }
        }
        return;
      }
      hudFailures = 0;
      pageReady = true; pageKind = kind; pageMenuKey = menu.key; lastView = view; pageFailedAt = 0;
      if (sendArrow) sentHudArrow = arrowKey;
      if (sendLimit) sentHudLimit = hud.limit;
      if (sendSpeed) { sentHudSpeed = speedKey; sentHudSpeedAt = speedNow; }
      return;
    }

    if (kind === "turns") {
      // Arrow, distance and road go out only when they change: the arrow when
      // the manoeuvre does, the road with it, the card when its digits or bar
      // change and then no more often than CARD_MIN_INTERVAL_MS while it only
      // counts down. Each image crosses Bluetooth.
      const maneuver = nav ? progressOf(nav).maneuver : null;
      const icon = pixelArrowFor(view.big !== undefined ? maneuver?.type : undefined);
      const iconKey = icon.join("");
      const road = view.body[0] ?? "";
      const card = turnCardFor(view);
      const nextCardKey = cardKey(card);
      const now = Date.now();
      const sendIcon = !samePage || iconKey !== sentIconKey;
      const sendRoad = !samePage || road !== sentRoad;
      const sendCard = !samePage || (nextCardKey !== sentCardKey && (sendIcon || card === null || now - sentCardAt >= CARD_MIN_INTERVAL_MS));
      if (samePage && sameView(lastView, view) && !sendIcon && !sendCard && !sendRoad) return;
      const turn = { ...(sendIcon ? { icon } : {}), ...(sendCard ? { card } : {}), ...(sendRoad ? { road } : {}) };
      const result = samePage ? await updatePage(bridge, view, kind, { turn }) : await showPage(bridge, view, kind, { turn }, menu);
      if (closed) return;
      if (!result.ok) { fail(result.reason); return; }
      pageReady = true; pageKind = kind; pageMenuKey = menu.key; lastView = view; pageFailedAt = 0;
      if (sendIcon) sentIconKey = iconKey;
      if (sendRoad) sentRoad = road;
      if (sendCard) { sentCardKey = nextCardKey; sentCardAt = now; }
      return;
    }

    if (samePage && sameView(lastView, view)) return;
    const result = samePage ? await updatePage(bridge, view, kind) : await showPage(bridge, view, kind, {}, menu);
    if (closed) return;
    if (!result.ok) { fail(result.reason); return; }
    pageReady = true; pageKind = kind; pageMenuKey = menu.key; lastView = view; pageFailedAt = 0;
  };

  // Draws run one after another: a layout switch must not race a text update
  // into a page that is being replaced.
  // Calls that arrive while one draw runs share ONE follow-up draw, which
  // reads the newest state: a slow image upload no longer builds a queue of
  // stale draws behind it (before, every fix added one and the display lagged).
  let drawing: Promise<void> = Promise.resolve();
  let pendingDraw: Promise<void> | null = null;
  const draw = (): Promise<void> => {
    if (pendingDraw) return pendingDraw;
    const next = drawing.then(async () => {
      pendingDraw = null;
      const begun = Date.now();
      await drawNow();
      const ms = Date.now() - begun;
      if (ms > 300) diag("draw.slow", { ms, screen, kind: pageKind ?? "" });
    }).catch((thrown: unknown) => {
      console.warn("[openglance] draw failed:", thrown);
      diag("draw.throw", { msg: thrown instanceof Error ? `${thrown.message} @ ${(thrown.stack ?? "").split("\n").slice(1, 3).join(" | ")}` : String(thrown) });
    });
    pendingDraw = next;
    drawing = next;
    return next;
  };

  /** Glasses message key for a route that could not be had. */
  const routeErrorKey = (code: string | undefined): string => {
    switch (code) {
      // fetch threw: the server could not be reached at all (no Tailscale, wrong address, CORS).
      case "offline": return "err.routeUnreachable";
      case "timeout": return "err.routeTimeout";
      case "busy": return "err.busy";
      case "noRoute": return "err.noRoute";
      case "tooFar": return "err.tooFar";
      default: return "err.server";
    }
  };

  /** The trip for what is selected, begun at `from`: a saved route with its stops, or a single destination. */
  const buildTrip = (from: LatLng): typeof trip => {
    const saved = selectedRoute(data);
    if (saved) {
      const plan = planFrom(saved, from);
      return { label: saved.name, to: plan.to.at, stops: plan.stops, kind: plan.kind };
    }
    const destination = destinationOf(data);
    return destination ? { label: destination.label, to: destination.at, stops: [], kind: "asPlanned" } : null;
  };

  /**
   * Routes from `from`. `fresh` starts a new trip from what is selected; a
   * reroute keeps the trip and drops the stops already passed.
   */
  const computeRoute = async (from: LatLng, fresh = false, choose = false): Promise<void> => {
    const seq = ++routeSeq;
    if (fresh || !trip) {
      trip = buildTrip(from);
      tripSeq++;
      // Going to the place of one of today's appointments (also a navigation picked up after a restart): it counts as that appointment.
      const goingTo = trip?.to;
      if (apptTrip === null && goingTo && apptsOn()) apptTrip = upcomingAppointments(appts, Date.now()).find((a) => samePlaceAs(a.at, goingTo)) ?? null;
    } else if (nav) {
      trip = { ...trip, stops: routedStops.slice(stopsPassed(nav.route.maneuvers, nav.maneuverIndex, routedStops, nav.position)) };
    }
    const current = trip;
    if (!current) { startPhase = null; errorKey = "err.noDestination"; await draw(); return; }

    rerouting = nav !== null;
    if (!nav) startPhase = "route";
    errorKey = null;
    await draw();

    if (!usesMockRouter(data) && globalThis.navigator?.onLine === false) {
      if (seq !== routeSeq) return;
      rerouting = false;
      startPhase = null;
      errorKey = "err.phoneOffline";
      nav = null;
      await draw();
      return;
    }

    await routeGate.ready();
    if (seq !== routeSeq) return;
    lastRouteAt = Date.now();
    const stops = current.stops;
    // A fresh car start asks for other ways too (only without stops); reroutes take the fastest.
    const alternates = choose && data.mode === "driving" && !stops.length && !usesMockRouter(data) ? MAX_ALTERNATES : 0;
    const outcome = await router().route({
      from, to: current.to, mode: data.mode,
      ...(stops.length ? { via: stops.map((stop) => stop.at) } : {}),
      ...(alternates ? { alternates } : {}),
    });
    if (seq !== routeSeq) return;
    rerouting = false;
    startPhase = null;

    if (!outcome.route) {
      console.warn("[openglance] route failed:", outcome.code, outcome.error);
      errorKey = routeErrorKey(outcome.code);
      nav = null;
    } else {
      const choices = choose ? choicesFrom(outcome.route, outcome.alternates) : [];
      if (choices.length > 1) {
        // More than one way: the wearer picks before anything starts (swipe, tap, 2× back).
        errorKey = null;
        nav = null;
        openRouteChoice(choices);
        return;
      }
      adoptRoute(outcome.route, stops);
    }
    await draw();
  };

  /** Starts guiding along `route` (a new route, a reroute, a picked or a detour route). */
  const adoptRoute = (route: Route, stops: readonly RoutePoint[]): void => {
    diag("nav.adopt", { shape: route.shape.length, maneuvers: route.maneuvers.length, km: Math.round(route.distance / 1000) });
    errorKey = null;
    routeVersion++;
    routedStops = stops;
    detourOffer = null;
    // Arrivals at stops carry the stop's name ("Stopp 1: Ladepark").
    nav = startNavigation(nameStops(route, stops, tr(messages, locale, "g.stopWord")));
    // The mock router has no Overpass behind it: the demo brings its own named streets.
    if (usesMockRouter(data)) {
      const shape = nav.route.shape;
      streets = { route: routeVersion, list: demoStreets(shape, nav.route.maneuvers.filter((m) => m.street).map((m) => ({ from: m.shapeIndex, name: m.street as string }))) };
      streetsVersion++;
    }
    if (position) nav = update(nav, position);
    loadSpeedLimits();
    brakeAdvisor.reset();
    speedingWatch.reset();
  };

  /** The route picker: up to three ways; the traffic of each is asked for in the background. */
  const openRouteChoice = (routes: readonly Route[]): void => {
    const seq = ++choiceSeq;
    screen = "routes";
    routeChoice = { routes, selected: 0, traffic: routes.map(() => (trafficFetch ? undefined : null)) };
    void draw();
    if (!trafficFetch) return;
    void (async () => {
      for (const [index, route] of routes.entries()) {
        const report = await trafficFetch(lineAhead(route.shape));
        if (closed || seq !== choiceSeq || !routeChoice) return;
        routeChoice = { ...routeChoice, traffic: routeChoice.traffic.map((r, i) => (i === index ? report : r)) };
        void draw();
      }
    })();
  };

  /** Tap on the picker: guide along the chosen way. */
  const pickRoute = (): void => {
    const choice = routeChoice;
    const route = choice?.routes[choice.selected];
    if (!choice || !route) return;
    choiceSeq++;
    routeChoice = null;
    screen = "nav";
    adoptRoute(route, []);
    void draw();
    if (navigatingByCar()) scheduleCar(0);
  };

  /** A position younger than this starts the route at once; an older one waits for a fresh fix. */
  const FRESH_FIX_MS = 120_000;

  /**
   * Starts navigating to the selected destination. The glasses say at every
   * step what is happening (finding the position, calculating the route) and,
   * if it fails, why and what to do: nothing may look like "the tap did nothing".
   */
  const startNavigating = async (choose = true): Promise<void> => {
    const seq = ++routeSeq;
    diag("nav.start", { choose, hasPos: !!position, mode: data.mode, hud: data.hudLayout });
    disarmStop();
    screen = "nav";
    // Remembered, so navigation picks up again after the phone has ended the app (screen lock).
    if (!DEMO) saveData({ ...data, activeSince: Date.now() });
    nav = null;
    errorKey = null;
    rerouting = false;
    // A stop ends location updates to save battery; navigating again needs
    // them back, or the arrow froze on the first fix for the whole trip.
    void bridge.startAppLocationUpdates({
      accuracy: AppLocationAccuracy.High,
      distanceFilter: 5,
      intervalMs: LOCATION_INTERVAL_MS,
    }).catch(() => false);
    if (!position || Date.now() - positionAt > FRESH_FIX_MS) {
      startPhase = "gps";
      void draw();
      // Bounded twice: the native timeout is only a hint, and a permission
      // prompt can hold the answer back for as long as it stays open.
      const fix = await withTimeout(
        bridge.getAppLocation({ accuracy: AppLocationAccuracy.High, timeoutMs: FIRST_FIX_MS }), FIRST_FIX_MS + 2000,
      ).catch(() => null);
      if (seq !== routeSeq) return;
      if (fix && typeof fix.latitude === "number" && typeof fix.longitude === "number") {
        position = { lat: fix.latitude, lon: fix.longitude };
        positionAt = Date.now();
      }
    }
    if (!position) { startPhase = null; errorKey = "err.noGps"; await draw(); return; }
    await computeRoute(position, true, choose);
    // Navigating by car: ask the car now, then every few seconds.
    if (navigatingByCar()) scheduleCar(0);
  };

  /** Back to the destination list, with the cursor on the active destination. */
  const openList = (): void => {
    disarmStop();
    abortVoice();
    chargerSeq++;
    chargerList = null;
    peakSeq++;
    peakPage = null;
    choiceSeq++;
    routeChoice = null;
    screen = "list";
    shownAppts = apptRows();
    cursor = cursorFor(data, shownAppts);
    void draw();
    if (Date.now() - lastSyncAt > 30_000) void syncRoutes();
  };

  /** The help page on top of the page it was opened from; leaving the voice, charger and peak pages first, as 2× would. */
  const openHelp = (): void => {
    if (screen === "help") return;
    if (screen === "voice" || screen === "chargers" || screen === "peaks") openList();
    helpFrom = screen === "nav" ? "nav" : screen === "routes" ? "routes" : "list";
    disarmStop();
    screen = "help";
    void draw();
  };
  const closeHelp = (): void => {
    disarmStop();
    // Back to a running navigation (or the route choice), never to a dropped one.
    screen = helpFrom === "nav" && nav !== null ? "nav" : helpFrom === "routes" && routeChoice ? "routes" : "list";
    if (screen === "list") { shownAppts = apptRows(); cursor = cursorFor(data, shownAppts); }
    void draw();
  };

  const stopNavigating = async (): Promise<void> => {
    disarmStop();
    routeSeq++;
    if (data.activeSince !== null) saveData({ ...data, activeSince: null });
    nav = null;
    trip = null;
    apptTrip = null;
    routedStops = [];
    tripSeq++;
    traffic = null;
    detourOffer = null;
    trafficPoller.reset();
    errorKey = null;
    rerouting = false;
    startPhase = null;
    tts.stop();
    announcer.reset();
    openList();
    await bridge.stopAppLocationUpdates().catch(() => undefined);
    await draw();
  };

  const saveData = (next: NavData): void => {
    data = next;
    void save(bridge, next).catch((thrown: unknown) => { console.warn("[openglance] save failed:", thrown); });
  };

  // Saved routes shared with the route store (private build): planned on the PC,
  // they appear here; planned or deleted here, they appear there. At start, when
  // the destination list opens and after every change on the phone.
  const routeSync = DEMO ? null : createRouteSync();
  let refreshPhone: () => void = () => undefined;
  let syncing = false;
  let syncAgain = false;
  let lastSyncAt = 0;
  const syncRoutes = async (): Promise<void> => {
    if (!routeSync || closed) return;
    if (syncing) { syncAgain = true; return; }
    syncing = true;
    lastSyncAt = Date.now();
    try {
      const outcome = await routeSync.sync({ routes: data.routes, deleted: data.deletedRoutes });
      if (!outcome.result || closed) {
        if (outcome.error) console.warn("[openglance] route sync:", outcome.error);
        return;
      }
      // Changes made on the phone while the request was out are kept.
      const merged = mergeRoutes({ routes: data.routes, deleted: data.deletedRoutes }, outcome.result);
      if (sameRoutes({ routes: data.routes, deleted: data.deletedRoutes }, merged)) return;
      const stillThere = data.destinationId === null
        || nav !== null
        || [...data.places, ...data.recent, ...merged.routes].some((p) => p.id === data.destinationId);
      saveData({ ...data, routes: merged.routes, deletedRoutes: merged.deleted, destinationId: stillThere ? data.destinationId : null });
      if (screen === "list") cursor = clampCursor(data, cursor, shownAppts);
      refreshPhone();
      await draw();
    } finally {
      syncing = false;
      if (syncAgain) { syncAgain = false; void syncRoutes(); }
    }
  };

  /** Navigates to a destination from the list or from speech; it becomes the active one. */
  const navigateTo = (place: Destination): void => {
    apptTrip = null;
    saveData(chooseDestination(data, place));
    void startNavigating();
  };

  /**
   * Drives to one of today's appointments (the normal flow, by car). Only its
   * place goes into "recent" like any other destination; the title stays in memory.
   */
  const navigateToAppointment = (appt: Appointment): void => {
    saveData({ ...chooseDestination(data, { id: "", label: appt.placeLabel || appt.time, at: appt.at }), mode: "driving" });
    apptTrip = appt;
    void startNavigating();
  };

  /**
   * "Wo ist mein Auto": on foot to where the car was last reported. The place
   * is held under one fixed id, replaced on every walk, and never shown as a
   * row of its own - nothing piles up in any list.
   */
  const navigateToCar = (at: LatLng): void => {
    apptTrip = null;
    const spot = { id: CAR_DESTINATION_ID, label: tr(messages, locale, "l.carDest"), at };
    saveData({ ...data, recent: [spot, ...data.recent.filter((place) => place.id !== CAR_DESTINATION_ID)], destinationId: CAR_DESTINATION_ID, mode: "walking" });
    void startNavigating();
  };

  /** Starts a saved route: its way of travel, its stops, from wherever the glasses are. */
  const startRoute = (route: SavedRoute): void => {
    apptTrip = null;
    saveData({ ...data, destinationId: route.id, mode: route.mode });
    void startNavigating();
  };

  // ---- Charging nearby (glasses list entry, setting "chargers") ----

  const chargerError = (outcome: ChargerOutcome): ChargerListState => {
    const code = outcome.error === "invalid" || outcome.error === "oversized" ? "server" : outcome.error ?? "server";
    return { phase: "error", key: "c." + code, vars: { s: outcome.waitS ?? 30 } };
  };

  /** Shows the three nearest fast stations; asks the server at most every 30 s and reuses a recent answer. */
  const openChargers = async (): Promise<void> => {
    abortVoice();
    const seq = ++chargerSeq;
    screen = "chargers";
    const fresh = position !== null && Date.now() - positionAt <= FRESH_FIX_MS;
    chargerList = { phase: "loading", key: fresh || DEMO ? "c.loading" : "c.findingFix" };
    void draw();
    if (DEMO && position) {
      chargerList = { phase: "results", list: nearestFast(demoChargers(null, position), position, 3), selected: 0 };
      void draw();
      return;
    }
    if (!fresh) {
      const fix = await withTimeout(
        bridge.getAppLocation({ accuracy: AppLocationAccuracy.High, timeoutMs: FIRST_FIX_MS }), FIRST_FIX_MS + 2000,
      ).catch(() => null);
      if (seq !== chargerSeq || screen !== "chargers") return;
      if (fix && typeof fix.latitude === "number" && typeof fix.longitude === "number") {
        position = { lat: fix.latitude, lon: fix.longitude };
        positionAt = Date.now();
      }
    }
    const here = position;
    if (!here) { chargerList = { phase: "error", key: "c.noGps" }; void draw(); return; }
    chargerList = { phase: "loading", key: "c.loading" };
    void draw();
    const outcome = await chargerSource.nearby(here);
    if (seq !== chargerSeq || screen !== "chargers") return;
    if (outcome.error) chargerList = chargerError(outcome);
    else {
      const list = nearestFast(outcome.chargers, here, 3);
      chargerList = list.length ? { phase: "results", list, selected: 0 } : { phase: "error", key: "c.none" };
    }
    void draw();
  };

  // ---- Peaks nearby (glasses list entry, setting "peaks") ----

  const peakError = (outcome: PeakOutcome): PeakPageState => {
    const code = outcome.error === "invalid" || outcome.error === "oversized" ? "server" : outcome.error ?? "server";
    return { phase: "error", key: "k." + code, vars: { s: outcome.waitS ?? 20 } };
  };

  /** The peaks of the area around `here`: from the phone's memory when it has them, else one request. */
  const loadPeaksAround = async (here: LatLng): Promise<PeakOutcome> => {
    if (DEMO) return { peaks: demoPeaks(here), error: null, fromCache: true };
    return peakSource.get(here, data.peakRadiusKm);
  };

  const sightsNow = (here: LatLng): ReturnType<typeof sightsFrom> => sightsFrom(here, peakData?.peaks ?? [], data.peakRadiusKm * 1000);

  /** Opens the peaks page: position, then the peaks of the area. */
  const openPeaks = async (): Promise<void> => {
    abortVoice();
    const seq = ++peakSeq;
    screen = "peaks";
    const fresh = position !== null && Date.now() - positionAt <= FRESH_FIX_MS;
    peakPage = { phase: "loading", key: fresh || DEMO ? "k.loading" : "k.findingFix" };
    void draw();
    if (!fresh && !DEMO) {
      const fix = await withTimeout(
        bridge.getAppLocation({ accuracy: AppLocationAccuracy.High, timeoutMs: FIRST_FIX_MS }), FIRST_FIX_MS + 2000,
      ).catch(() => null);
      if (seq !== peakSeq || screen !== "peaks") return;
      if (fix && typeof fix.latitude === "number" && typeof fix.longitude === "number") {
        position = { lat: fix.latitude, lon: fix.longitude };
        positionAt = Date.now();
      }
    }
    const here = position;
    if (!here) { peakPage = { phase: "error", key: "k.noGps" }; void draw(); return; }
    peakPage = { phase: "loading", key: "k.loading" };
    void draw();
    peakLoading = true;
    const outcome = await loadPeaksAround(here).finally(() => { peakLoading = false; });
    if (seq !== peakSeq || screen !== "peaks") return;
    if (outcome.error) { peakPage = peakError(outcome); void draw(); return; }
    peakData = { peaks: outcome.peaks, area: areaFor(here, data.peakRadiusKm).key };
    peakPage = { phase: "ready", sights: sightsNow(position ?? here), pick: "near", view: "band", selected: 0 };
    void draw();
  };

  /**
   * A new fix while the peaks page is up: distances and bearings again from
   * the peaks already loaded; a new area (5 km cells) is asked for once,
   * quietly - while that is out, or if it fails, the old peaks stay.
   */
  const peaksMoved = (here: LatLng): void => {
    if (screen !== "peaks" || peakPage?.phase !== "ready" || !peakData) return;
    const sights = sightsNow(here);
    peakPage = { ...peakPage, sights, selected: Math.min(peakPage.selected, Math.max(0, sights.length - 1)) };
    const area = areaFor(here, data.peakRadiusKm).key;
    if (area === peakData.area || peakLoading || DEMO) return;
    const seq = peakSeq;
    peakLoading = true;
    void loadPeaksAround(here).finally(() => { peakLoading = false; }).then((outcome) => {
      if (seq !== peakSeq || outcome.error || screen !== "peaks" || peakPage?.phase !== "ready") return;
      peakData = { peaks: outcome.peaks, area };
      peakPage = { ...peakPage, sights: sightsNow(position ?? here), selected: 0 };
      void draw();
    });
  };

  // ---- Speaking a destination (hold on the list) ----

  /** Drops a recording or an answer in flight; the microphone is always switched off. */
  function abortVoice(): void {
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
  }

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

  const voiceError = (key: string, vars?: Record<string, string>): void => {
    voice = { phase: "error", key, ...(vars ? { vars } : {}) };
    screen = "voice";
    void draw();
  };

  /** Hold: record from the glasses microphone until the release (or MAX_VOICE_MS). */
  const startVoice = async (): Promise<void> => {
    abortVoice();
    const seq = voiceSeq;
    screen = "voice";
    if (!DEMO && !canSpeak()) { voiceError("v.noServer"); return; }
    voice = { phase: "recording" };
    liveShown = ""; liveShownAt = 0;
    void draw();
    if (DEMO) return;
    // Live words while speaking, when the build has a live server; it connects while the microphone starts.
    const liveUrl = liveSttUrl();
    if (liveUrl) live = openLiveStt({ url: liveUrl, language: locale, onText: (text) => showLive(text, seq) });
    // Blocks may arrive before the answer to the request does; they must not be dropped.
    micActive = true;
    const request = bridge.audioControl(true, AudioInputSource.Glasses);
    const granted = await withTimeout(request, 5000).catch(() => {
      // A yes that comes after the timeout would leave the microphone on for
      // good: switch it off as soon as it arrives (unless a new recording runs).
      void request.then((late) => { if (late && !micActive) void bridge.audioControl(false).catch(() => undefined); }, () => undefined);
      return false;
    });
    if (seq !== voiceSeq) {
      // Cancelled while the microphone was starting: do not leave it on.
      if (granted) void bridge.audioControl(false).catch(() => undefined);
      return;
    }
    micActive = granted;
    if (!granted) { live?.abort(); live = null; voiceError("v.noMic"); return; }
    // A recording must end even when the release event never arrives.
    recordTimer = setTimeout(() => { recordTimer = null; void finishVoice(); }, MAX_VOICE_MS);
  };

  /** Release: send what was said to the speech server, look the words up, show up to three places. */
  async function finishVoice(): Promise<void> {
    if (!voice || voice.phase !== "recording") return;
    const seq = ++voiceSeq;
    if (recordTimer !== null) clearTimeout(recordTimer);
    recordTimer = null;
    if (liveTimer !== null) clearTimeout(liveTimer);
    liveTimer = null;
    const liveText = voice.live;
    voice = { phase: "working", ...(liveText ? { heard: liveText } : {}) };
    void draw();
    if (!DEMO) {
      micActive = false;
      await bridge.audioControl(false).catch(() => undefined);
      // Blocks still in flight arrive after the off-switch; without the pause the tail is lost.
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    let heard = "Mirabellplatz Salzburg";
    if (!DEMO) {
      const session = live;
      live = null;
      const liveOutcome = session ? await session.finish() : null;
      if (seq !== voiceSeq) return;
      const choice = chooseTranscript(liveOutcome, sttBase("") !== "");
      if (choice.use === "live") {
        micChunks.length = 0;
        heard = choice.text;
      } else if (choice.use === "none" && !devHeard) {
        micChunks.length = 0;
        voiceError(liveOutcome?.ok ? "v.nothing" : "v.sttFailed");
        return;
      } else {
        // Batch: the whole recording to the speech server, as before live words existed.
        const bytes = micChunks.reduce((sum, chunk) => sum + chunk.length, 0);
        if (bytes < MIN_VOICE_BYTES && !devHeard) {
          micChunks.length = 0;
          voiceError("v.short");
          return;
        }
        const wav = buildWav(micChunks);
        micChunks.length = 0;
        try {
          if (choice.use === "batch") heard = await transcribe(wav, sttBase(""), locale);
        } catch (thrown) {
          if (seq !== voiceSeq) return;
          console.warn("[openglance] speech failed:", thrown instanceof Error ? thrown.message : thrown);
          if (!devHeard) { voiceError("v.sttFailed"); return; }
        }
      }
      if (devHeard) heard = devHeard;
    }
    if (seq !== voiceSeq) return;
    heard = heard.replace(/[.!?。…]+$/u, "").trim();
    if (!heard) { voiceError("v.nothing"); return; }
    voice = { phase: "working", heard };
    void draw();
    const outcome = await searchPlaces(heard, { lang: locale, near: position, limit: 3 });
    if (seq !== voiceSeq) return;
    const results = outcome.places.slice(0, 3);
    if (results.length === 0) {
      if (outcome.error === "empty" || outcome.error === "short" || outcome.error === null) voiceError("v.noPlace", { text: heard });
      else voiceError("v.searchFailed");
      return;
    }
    voice = { phase: "results", heard, results, selected: 0, saved: false };
    void draw();
  }

  // Demo scenes start on a given page.
  if (DEMO && SCENE === "chargers") {
    void openChargers();
  } else if (DEMO && SCENE === "peaks") {
    void openPeaks();
  } else if (DEMO && position && screen === "nav") {
    await computeRoute(position);
    // Demo scenes put the car part-way along the made-up route.
    const stop = SCENE === "near" ? 14 : SCENE === "map" ? 11 : SCENE === "stop" ? 20 : 0;
    const routed = nav as NavState | null;
    const spot = routed?.route.shape[stop];
    if (routed && spot && stop > 0) { position = spot; nav = update(routed, spot); await draw(); }
  } else await draw();

  // Location updates: the distance filter keeps the callback quiet while
  // stationary, which matters for battery on a long walk. Not awaited: the
  // phone may be asking for permission, and until it answered the gesture
  // handlers below were not installed — a tap to start did nothing.
  void bridge.startAppLocationUpdates({
    accuracy: AppLocationAccuracy.High,
    distanceFilter: 5,
    intervalMs: LOCATION_INTERVAL_MS,
  }).catch(() => false);

  const stopListening = bridge.onAppLocationChanged((location: AppLocation) => {
    if (closed) return;
    if (typeof location?.latitude !== "number" || typeof location?.longitude !== "number") return;
    position = { lat: location.latitude, lon: location.longitude };
    positionAt = Date.now();
    speedMeter.push(location.speed, positionAt);
    course = { heading: typeof location.heading === "number" ? location.heading : null, speed: typeof location.speed === "number" ? location.speed : null, at: positionAt };
    if (screen === "peaks") { peaksMoved(position); void draw(); }
    // The GPS heading means something only while moving; standing still it is noise.
    if (typeof location.heading === "number" && location.heading >= 0 && (location.speed ?? 0) >= 2.5) gpsHeading = location.heading;

    if (nav) {
      nav = update(nav, position);
      announce();
      // Arrived: nothing to resume any more.
      if (nav.arrived && data.activeSince !== null) saveData({ ...data, activeSince: null });
      // Rerouting is automatic: a driver cannot be expected to ask for it. It
      // is spaced out, though, so someone lingering beside the route does not
      // hammer a free public server; a tap still reroutes at once.
      if (needsReroute(nav) && !rerouting && mayAutoReroute(lastRouteAt, Date.now())) {
        void computeRoute(position);
      }
    }
    // Once the arrival page is up, further fixes change nothing on it: no redraw per fix.
    const arrived = nav?.arrived === true;
    if (!arrived) arrivalShown = false;
    if (screen === "nav" && !(arrived && arrivalShown && pageReady)) {
      void draw().then(() => { if (arrived && pageReady) arrivalShown = true; });
    }
  });

  const requestExit = (): void => {
    // Exit mode 1: the glasses ask the user to confirm (Even Hub requires
    // it on the root page; mode 0 exits without asking). Nothing stops
    // until the answer is yes — a cancelled exit keeps navigating as if
    // nothing happened. A failing call means the page is already gone,
    // so that also shuts down, and never as an unhandled rejection.
    if (exiting) return;
    exiting = true;
    void bridge.shutDownPageContainer(EXIT_WITH_CONFIRMATION)
      .then((confirmed) => confirmed !== false, (thrown: unknown) => {
        console.warn("[openglance] shutdown failed:", thrown);
        return true;
      })
      .then((leaving) => {
        exiting = false;
        diag("exit", { leaving, closed });
        if (closed) return;
        if (!leaving) {
          // Cancelled: the dialog may have taken the page away - put it up again the way of the first page.
          pageReady = false;
          lastView = null;
          forgetPage(bridge);
          void draw();
          return;
        }
        // Left on purpose: no navigation to pick up next time.
        if (data.activeSince !== null) saveData({ ...data, activeSince: null });
        return shutdown();
      });
  };

  /** Stops everything that could draw or listen again. */
  function shutdown(): Promise<void> {
    closed = true;
    routeSeq++;
    nav = null;
    abortVoice();
    chargerSeq++;
    peakSeq++;
    tts.stop();
    if (tickTimer !== null) clearInterval(tickTimer);
    if (hudTimer !== null) clearInterval(hudTimer);
    if (streetsTimer !== null) clearTimeout(streetsTimer);
    if (limitsTimer !== null) clearTimeout(limitsTimer);
    if (carTimer !== null) clearTimeout(carTimer);
    if (sugarTimer !== null) clearTimeout(sugarTimer);
    if (typeof stopListening === "function") stopListening();
    return bridge.stopAppLocationUpdates().then(() => undefined, () => undefined);
  }

  /** Start page: swipe moves the cursor, tap starts (or switches the travel mode), hold speaks. */
  const onListGesture = (gesture: string): void => {
    const items = listItems(data, shownAppts);
    switch (gesture) {
      case "scrollUp": cursor = clampCursor(data, cursor - 1, shownAppts); void draw(); return;
      case "scrollDown": cursor = clampCursor(data, cursor + 1, shownAppts); void draw(); return;
      case "click": {
        if (cursor >= items.length) {
          saveData({ ...data, mode: nextMode(data.mode) });
          void draw();
          return;
        }
        const item = items[cursor];
        if (!item) return;
        if (item.kind === "chargers") void openChargers();
        else if (item.kind === "peaks") void openPeaks();
        else if (item.kind === "route") startRoute(item.route);
        else if (item.kind === "appt") navigateToAppointment(item.appt);
        else if (item.kind === "car") navigateToCar(item.at);
        else navigateTo(item.place);
        return;
      }
      case "longPress": void startVoice(); return;
      default: return;
    }
  };

  const onVoiceGesture = (gesture: string): void => {
    const state = voice;
    if (!state) { openList(); return; }
    switch (state.phase) {
      case "recording":
        if (gesture === "longPressRelease" || gesture === "click") void finishVoice();
        return;
      case "working":
        return;
      case "error":
        if (gesture === "click") openList();
        else if (gesture === "longPress") void startVoice();
        return;
      case "results": {
        const last = state.results.length - 1;
        if (gesture === "scrollUp") { voice = { ...state, selected: Math.max(0, state.selected - 1) }; void draw(); return; }
        if (gesture === "scrollDown") { voice = { ...state, selected: Math.min(last, state.selected + 1) }; void draw(); return; }
        const hit = state.results[state.selected];
        if (!hit) return;
        if (gesture === "longPress") {
          // Save as a favourite: it stays on the list for next time.
          if (!state.saved) saveData(saveFavorite(data, { label: hit.label, at: hit.at }));
          voice = { ...state, saved: true };
          void draw();
          return;
        }
        if (gesture === "click") {
          // A place saved a moment ago is found again by its position and simply selected.
          abortVoice();
          navigateTo({ id: "", label: hit.label, at: hit.at });
        }
        return;
      }
    }
  };

  /** Charging nearby: swipe chooses, tap navigates there; after a failure hold asks again, tap goes back. */
  const onChargerGesture = (gesture: string): void => {
    const state = chargerList;
    if (!state) { openList(); return; }
    if (state.phase === "results") {
      const last = state.list.length - 1;
      if (gesture === "scrollUp") { chargerList = { ...state, selected: Math.max(0, state.selected - 1) }; void draw(); return; }
      if (gesture === "scrollDown") { chargerList = { ...state, selected: Math.min(last, state.selected + 1) }; void draw(); return; }
      if (gesture === "longPress") { openList(); return; }
      const hit = state.list[state.selected];
      if (gesture === "click" && hit) {
        chargerSeq++;
        chargerList = null;
        navigateTo({ id: "", label: hit.charger.name || tr(messages, locale, "c.noName"), at: hit.charger.at });
      }
      return;
    }
    if (state.phase === "error") {
      if (gesture === "click") openList();
      else if (gesture === "longPress") void openChargers();
    }
  };

  /**
   * Peaks: on the band tap opens the list, swipe switches nearest/highest,
   * hold asks again; on the list swipe chooses, tap navigates there, hold
   * goes back to the band. After a failure hold asks again, tap goes back.
   */
  const onPeakGesture = (gesture: string): void => {
    const state = peakPage;
    if (!state) { openList(); return; }
    if (state.phase === "ready" && state.view === "band") {
      if (gesture === "click") { peakPage = { ...state, view: "list", selected: 0 }; void draw(); return; }
      if (gesture === "scrollUp" || gesture === "scrollDown") { peakPage = { ...state, pick: state.pick === "near" ? "high" : "near" }; void draw(); return; }
      if (gesture === "longPress") void openPeaks();
      return;
    }
    if (state.phase === "ready") {
      const last = Math.max(0, state.sights.length - 1);
      if (gesture === "scrollUp") { peakPage = { ...state, selected: Math.max(0, state.selected - 1) }; void draw(); return; }
      if (gesture === "scrollDown") { peakPage = { ...state, selected: Math.min(last, state.selected + 1) }; void draw(); return; }
      if (gesture === "longPress") { peakPage = { ...state, view: "band" }; void draw(); return; }
      const hit = state.sights[state.selected];
      if (gesture === "click" && hit) {
        peakSeq++;
        peakPage = null;
        navigateTo({ id: "", label: hit.peak.name, at: hit.peak.at });
      }
      return;
    }
    if (state.phase === "error") {
      if (gesture === "click") openList();
      else if (gesture === "longPress") void openPeaks();
    }
  };

  /** Route choice: swipe moves, tap starts the chosen way (2× = back, handled with the other pages). */
  const onRouteChoiceGesture = (gesture: string): void => {
    if (!routeChoice) { openList(); return; }
    if (gesture === "scrollUp" || gesture === "scrollDown") {
      routeChoice = moveChoice(routeChoice, gesture === "scrollUp" ? -1 : 1);
      void draw();
      return;
    }
    if (gesture === "click") pickRoute();
  };

  /** Navigating (also while starting and after a failure). */
  const onNavGesture = (gesture: string): void => {
    switch (gesture) {
      case "click":
        // Arrived: the tap goes back to the destination list.
        if (nav && !errorKey && progressOf(nav).arrived) { void stopNavigating(); return; }
        if (errorKey) { void startNavigating(); return; }
        if (nav && progressOf(nav).offRoute && position) { void computeRoute(position); return; }
        // The hint line offers a faster way: the tap takes it (only while that line is what the glasses show).
        if (shownAlert === "detour" && detourNow(Date.now())) { takeDetour(); return; }
        // Arriving almost empty (car link): the tap opens "charging nearby".
        if (batteryNow()?.low) { void openChargers(); return; }
        // Otherwise the tap asks to stop (a second tap within STOP_CONFIRM_MS ends): on the
        // hardware a hold never reached the app (step log 15.10.), so the tap is the sure way.
        if (nav && !SIDE_MENU) armStop();
        return;
      // Without a working side menu (see SIDE_MENU): a swipe switches between the turn view and the map,
      // a hold asks to stop (one tap confirms, anything else cancels).
      case "scrollUp":
      case "scrollDown":
        if (SIDE_MENU) return;
        if (data.mode === "driving") {
          // By car a swipe walks HUD -> classic -> map (and back the other way): the HUD layout is chosen on the glasses.
          const views = ["hud", "classic", "map"] as const;
          const here = data.glassView === "overview" ? 2 : data.hudLayout === "classic" ? 1 : 0;
          const next = views[(here + (gesture === "scrollDown" ? 1 : views.length - 1)) % views.length]!;
          saveData(next === "map" ? { ...data, glassView: "overview" } : { ...data, glassView: "turns", hudLayout: next === "classic" ? "classic" : "new" });
          if (next === "hud") hudFailures = 0; // asked for again: give the HUD page a fresh chance
          refreshPhone();
        } else {
          saveData({ ...data, glassView: data.glassView === "overview" ? "turns" : "overview" });
        }
        void draw();
        return;
      case "longPress":
        if (SIDE_MENU || !nav) return;
        armStop();
        return;
      default:
        return;
    }
  };

  /** First menu click on "Navigation beenden" asks: the next click on it, or one tap, within STOP_CONFIRM_MS stops. */
  const armStop = (): void => {
    stopArmedAt = Date.now();
    stopArmedUntil = stopArmedAt + STOP_CONFIRM_MS;
    if (stopTimer !== null) clearTimeout(stopTimer);
    stopTimer = setTimeout(() => { stopTimer = null; stopArmedUntil = 0; void draw(); }, STOP_CONFIRM_MS + 20);
    void draw();
  };

  /** An entry of the glasses' side menu. */
  const onMenu = (id: number): void => {
    const confirming = id === MENU.stop && screen === "nav" && stopArmed();
    if (!confirming) disarmStop();
    switch (id) {
      case MENU.help: openHelp(); return;
      case MENU.viewTurns:
      case MENU.viewMap:
        saveData({ ...data, glassView: id === MENU.viewMap ? "overview" : "turns" });
        void draw();
        return;
      case MENU.hud:
        saveData({ ...data, hudLayout: data.hudLayout === "classic" ? "new" : "classic" });
        refreshPhone();
        void draw();
        return;
      case MENU.cameras:
        saveData({ ...data, cameras: !data.cameras });
        refreshPhone();
        void draw();
        return;
      case MENU.stop:
        if (screen !== "nav") return;
        if (confirming) { void stopNavigating(); return; }
        armStop();
        return;
      default:
    }
  };

  bridge.onEvenHubEvent((event) => {
    if (closed) return;
    if (!(event as { audioEvent?: unknown } | null)?.audioEvent) {
      const e = event as Record<string, unknown> | null;
      diag("event", { keys: e ? Object.keys(e).join(",") : "null", sys: (e?.sysEvent as { eventType?: number } | undefined)?.eventType ?? null, raw: JSON.stringify(event).slice(0, 160), screen });
    }
    // System lifecycle: back in front = draw afresh; ended by the system =
    // everything off, but an active navigation stays remembered for the restart.
    const systemType = (event as { sysEvent?: { eventType?: number } } | null)?.sysEvent?.eventType;
    if (systemType === 4) { pageReady = false; lastView = null; void draw(); return; }
    if (systemType === 5) { disarmStop(); return; }
    if (systemType === 6 || systemType === 7) { disarmStop(); void shutdown(); return; }
    // PCM blocks of a recording arrive on the same channel as gestures.
    const audio = (event as { audioEvent?: { audioPcm?: unknown } } | null)?.audioEvent;
    if (audio !== undefined) {
      if (micActive) {
        const bytes = pcmBytes(audio.audioPcm);
        if (bytes !== null && bytes.length > 0) { micChunks.push(bytes); live?.send(bytes); }
      }
      return;
    }
    // The side menu has its own event; it never reaches the capture container.
    const menuId = menuItemIdFromEvent(event);
    if (menuId !== null) { onMenu(menuId); return; }
    const gesture = gestureFromEvent(event, { invertScroll: data.invertScroll });
    if (!gesture) return;
    // A pending stop: one tap confirms; everything else (swipe, hold, double tap) only cancels.
    if (screen === "nav" && stopArmed()) {
      if (gesture.gesture === "longPressRelease") return;
      if (gesture.gesture === "click") {
        // The tail of the menu click itself is not a confirmation.
        if (Date.now() - stopArmedAt < STOP_SETTLE_MS) return;
        void stopNavigating();
        return;
      }
      disarmStop();
      void draw();
      return;
    }
    if (gesture.gesture === "doubleClick") {
      // Speaking, charging, peaks and help are pages on top of the list: double tap goes back. Elsewhere it closes the app.
      if (screen === "voice" || screen === "chargers" || screen === "peaks") { openList(); return; }
      if (screen === "help") { closeHelp(); return; }
      // The route choice is only a start that has not begun: nothing guides yet, so 2× goes back to the list
      // (ending that start).
      if (screen === "routes" && nav === null) { void stopNavigating(); return; }
      // While navigating 2× never opens the system's exit dialog: on the real glasses (15.10., 0.17.11)
      // cancelling that dialog left the app dead - every call into the glasses failed with
      // InvalidAccessError and the display froze on the last HUD. 2× asks to stop instead (a tap
      // confirms, as after a hold); a start that guides nothing yet simply goes back to the list.
      if (screen === "nav" || screen === "routes") {
        if (nav) armStop(); else void stopNavigating();
        return;
      }
      requestExit();
      return;
    }
    switch (screen) {
      case "help": if (gesture.gesture === "click") closeHelp(); return;
      case "list": onListGesture(gesture.gesture); return;
      case "voice": onVoiceGesture(gesture.gesture); return;
      case "chargers": onChargerGesture(gesture.gesture); return;
      case "peaks": onPeakGesture(gesture.gesture); return;
      case "routes": onRouteChoiceGesture(gesture.gesture); return;
      default: onNavGesture(gesture.gesture);
    }
  });

  bridge.onDeviceStatusChanged((status) => {
    if (status?.connectType === "connected" && !closed) {
      pageReady = false;
      void draw();
    }
  });

  // HUD layout: the distance counts down once a second between fixes (text only; draws are diffed and coalesced).
  hudTimer = setInterval(() => {
    if (!closed && screen === "nav" && nav && kindNow() === "hud") void draw();
  }, HUD_TICK_MS);
  tickTimer = setInterval(() => {
    ensureSugarPolling();
    void pollTraffic();
    void pollAppointments();
    void pollApptEta();
    void draw();
  }, 2000);
  // Appointments once at start (when the build has the daemon and the switch is on).
  void pollAppointments();
  void syncRoutes();
  scheduleCar(0);

  // Navigation that was running when the phone ended the app (screen lock,
  // memory): picked up again at once, if it is recent and the target still exists.
  if (!DEMO && data.activeSince !== null) {
    // Picked up while (probably) driving: the fastest way, no choice to make.
    if (Date.now() - data.activeSince < RESUME_WITHIN_MS && selectionLabel(data) !== null) void startNavigating(false);
    else saveData({ ...data, activeSince: null });
  }

  refreshPhone = mountPhoneUi({
    getData: () => data,
    setData: async (next) => {
      const routesChanged = next.routes !== data.routes || next.deletedRoutes !== data.deletedRoutes;
      const routeChanged = next.destinationId !== data.destinationId
        || next.mode !== data.mode
        || next.demo !== data.demo
        || next.valhallaUrl !== data.valhallaUrl;
      data = next;
      // A destination picked on the phone moves the cursor of the glasses list onto it.
      if (screen === "list") { shownAppts = apptRows(); cursor = cursorFor(data, shownAppts); }
      else cursor = clampCursor(data, cursor, shownAppts);
      if (!next.announce) tts.stop();
      await save(bridge, next);
      if (routesChanged) void syncRoutes();
      if (routeChanged && nav && position) await computeRoute(position, true);
      await draw();
    },
    getPosition: () => position,
    ...(BYD_URL ? { getCar: carLine } : {}),
    onVoiceActivate: () => { tts.unlock(); if (tts.available) tts.speak(locale === "de" ? "Sprachausgabe ist bereit." : "Voice is ready."); },
    getVoiceState: voiceState,
    getLocale: () => locale,
    setLocale: (next) => {
      locale = next;
      rememberLocale(bridge, next);
      void draw();
    },
    search: withMapsLinks((query) => searchPlaces(query, { lang: locale, near: position })),
    planRoute: async (points, mode): Promise<RouteOutcome> => {
      const from = points[0];
      const to = points[points.length - 1];
      if (!from || !to || points.length < 2) return { route: null, error: "no points", code: "noRoute" };
      const via = points.slice(1, -1);
      const request = { from, to, mode, ...(via.length ? { via } : {}) };
      if (usesMockRouter(data)) return createMockProvider().route(request);
      await routeGate.ready();
      return router().route(request);
    },
    loadPeaks: async () => {
      const here = position;
      if (!here) return { here: null, outcome: { peaks: [], error: null } };
      return { here, outcome: await loadPeaksAround(here) };
    },
    chargersAlong: (line) => (usesMockRouter(data)
      ? Promise.resolve({ chargers: demoChargers(line), error: null })
      : chargerSource.along(line)),
  });
}

void boot().catch((error: unknown) => {
  console.error("[openglance] failed to start:", error);
});
