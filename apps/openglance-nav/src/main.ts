import {
  AppLocationAccuracy, AudioInputSource, waitForEvenAppBridge, type AppLocation, type EvenAppBridge,
} from "@evenrealities/even_hub_sdk";
import { cumulativeMeters, formatDistance, type LatLng } from "./geo/geometry";
import {
  clientIdFor, createMockProvider, createValhallaProvider, type Route, type RouteOutcome, type RoutingProvider,
} from "./routing/provider";
import { createRequestGate, mayAutoReroute } from "./routing/throttle";
import {
  needsReroute, progressOf, startNavigation, update, type NavState,
} from "./nav/navigator";
import { gestureFromEvent } from "./input/gestures";
import { buildView, type GlassLayout, type NavView } from "./glasses/view";
import {
  chargerView, clampCursor, cursorFor, listItems, listView, nextMode, voiceView, type ChargerListState, type VoiceState,
} from "./glasses/picker";
import { MAX_VOICE_MS, MIN_VOICE_BYTES, pcmBytes, sttBase, transcribe } from "./voice/stt";
import { buildWav } from "./voice/wav";
import { sameView } from "./glasses/diff";
import { showPage, updatePage, type PageKind } from "./glasses/render";
import { pixelArrowFor } from "./glasses/icons";
import { approachSteps, cardKey, type TurnCard } from "./glasses/turncard";
import { renderMapTiles, type MapScene } from "./overview/draw";
import { courseAhead, rangeFor } from "./overview/camera";
import { overviewProjector } from "./overview/layout";
import { thinPoints } from "./overview/project";
import { needsMapImage, type MapFrame } from "./overview/refresh";
import { createStreetSource, loadStreets, type Street } from "./overview/streets";
import { demoStreets } from "./overview/demo";
import { createGeocoder, type Geocoder } from "./geocode/photon";
import { resolveLocale, rememberLocale, setLocale, tr, type Locale } from "./i18n";
import { messages } from "./messages";
import {
  chooseDestination, destinationOf, geocoderUrlOf, load, routerUrlOf, save, saveFavorite, selectedRoute, selectionLabel, usesMockRouter,
  type Destination, type NavData,
} from "./storage/persist";
import { nameStops, planFrom, stopsPassed, type JoinKind, type RoutePoint, type SavedRoute } from "./trip/saved";
import {
  chargersAlong, createChargerSource, demoChargers, nearestFast, nextAhead, powerText,
  type Charger, type ChargerOutcome, type RouteCharger,
} from "./chargers/chargers";
import { mountPhoneUi } from "./ui/phone";
import { buildTtsUrl, DEFAULT_VOICES, ServerTts } from "./speech/server-tts";
import { TurnAnnouncer } from "./speech/announcer";

/** While the distance only counts down, the turn card is resent at most this often. */
const CARD_MIN_INTERVAL_MS = 2_000;
/** The overview must stay up this long before its streets are fetched. */
const STREETS_DWELL_MS = 1_500;
/** `shutDownPageContainer` mode that shows the system's exit confirmation. */
const EXIT_WITH_CONFIRMATION = 1;

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
  let screen: "list" | "voice" | "nav" | "chargers" = DEMO && SCENE !== "list" && SCENE !== "voice" && SCENE !== "chargers" ? "nav" : "list";
  let cursor = cursorFor(data);
  let voice: VoiceState | null = null;
  /** Bumped whenever a recording or its answer is abandoned. */
  let voiceSeq = 0;
  let micActive = false;
  const micChunks: Uint8Array[] = [];
  let recordTimer: ReturnType<typeof setTimeout> | null = null;
  /** What a start is doing before the first route arrives ("gps", "route"), shown on the glasses. */
  let startPhase: "gps" | "route" | null = null;
  let rerouting = false;
  /** Message key of the error shown, translated at draw time. */
  let errorKey: string | null = null;
  let lastView: NavView | null = null;
  let pageReady = false;
  let pageKind: PageKind | null = null;
  /** The map last sent and a fingerprint of each of its four tiles; a new one goes out only when it would look different. */
  let sentMap: { frame: MapFrame; hashes: readonly number[] } | null = null;
  /** What the turn images last sent showed, and when the card went out. */
  let sentIconKey = "";
  let sentCardKey = "";
  let sentRoad = "";
  let sentCardAt = 0;
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
  let streets: { route: number; list: readonly Street[] } = { route: -1, list: [] };
  let streetsAskedFor = -1;
  let streetsVersion = 0;
  let closed = false;
  /** An exit confirmation is on screen; a second double tap must not stack another. */
  let exiting = false;
  let tickTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Every route request takes a number, and an answer that arrives after a
   * newer request — or after navigation was stopped — is dropped. Without it a
   * slow reroute for the old destination could land after the route to the
   * new one, or switch navigation back on after a hold had stopped it.
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

  /** Which of the three glasses pages the state calls for. */
  const kindNow = (): PageKind => {
    if (screen !== "nav") return "text";
    if (data.glassView === "overview" && nav && !errorKey) return "overview";
    // Without a turn to show (idle, error, arrived) the plain text page does.
    return nav && !errorKey && !progressOf(nav).arrived ? "turns" : "text";
  };

  const currentView = (kind: PageKind): NavView => {
    if (screen === "list") return listView(data, cursor, locale, DEMO || sttBase("") !== "");
    if (screen === "voice" && voice) return voiceView(voice, locale);
    if (screen === "chargers" && chargerList) return chargerView(chargerList, locale);
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
      charger: kind === "turns" ? nextChargerLine() : null,
    });
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

  /** The thinned route, computed once per route: its extent decides which streets to fetch. */
  let thinned: { route: number; points: readonly LatLng[] } = { route: -1, points: [] };
  const overviewPoints = (): readonly LatLng[] => {
    if (!nav) return [];
    if (thinned.route !== routeVersion) thinned = { route: routeVersion, points: thinPoints(nav.route.shape) };
    return thinned.points;
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
      },
    };
  };

  /**
   * Starts the street fetch for the current route if it has not been asked
   * for yet - once the map has stayed up for STREETS_DWELL_MS, so a swipe
   * through to the other view does not cost the public server a request.
   */
  let streetsTimer: ReturnType<typeof setTimeout> | null = null;
  const ensureStreets = (): void => {
    if (!nav || !data.streets || usesMockRouter(data) || streetsAskedFor === routeVersion || streetsTimer !== null) return;
    const forRoute = routeVersion;
    streetsTimer = setTimeout(() => {
      streetsTimer = null;
      if (closed || !nav || forRoute !== routeVersion || data.glassView !== "overview" || streetsAskedFor === forRoute) return;
      streetsAskedFor = forRoute;
      fetchStreets(forRoute);
    }, STREETS_DWELL_MS);
  };
  const fetchStreets = (forRoute: number): void => {
    const points = overviewPoints();
    void loadStreets(streetSource, overviewProjector(points), data.mode).then((result) => {
      if (closed || forRoute !== routeVersion) return;
      if (result.error) console.warn("[openglance] streets unavailable:", result.error);
      if (!result.streets.length) return;
      streets = { route: forRoute, list: result.streets };
      streetsVersion++;
      void draw();
    });
  };

  /** The turn card for a view: its big distance and how full the approach bar is. */
  const turnCardFor = (view: NavView): TurnCard | null => {
    if (view.big === undefined || !nav) return null;
    const leg = nav.route.maneuvers[nav.maneuverIndex]?.length ?? 0;
    return { label: view.big, steps: approachSteps(progressOf(nav).distanceToManeuver, leg, data.mode) };
  };

  const drawNow = async (): Promise<void> => {
    if (closed) return;
    if (screen === "nav") ensureTripChargers();
    const kind = kindNow();
    const view = currentView(kind);
    const samePage = pageReady && pageKind === kind;
    const fail = (reason: string | undefined): void => {
      pageReady = false;
      console.warn("[openglance] draw failed:", reason);
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
      const result = samePage ? await updatePage(bridge, view, kind, images) : await showPage(bridge, view, kind, images);
      if (closed) return;
      if (!result.ok) { fail(result.reason); return; }
      pageReady = true; pageKind = kind; lastView = view;
      if (tiles) sentMap = { frame, hashes };
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
      const result = samePage ? await updatePage(bridge, view, kind, { turn }) : await showPage(bridge, view, kind, { turn });
      if (closed) return;
      if (!result.ok) { fail(result.reason); return; }
      pageReady = true; pageKind = kind; lastView = view;
      if (sendIcon) sentIconKey = iconKey;
      if (sendRoad) sentRoad = road;
      if (sendCard) { sentCardKey = nextCardKey; sentCardAt = now; }
      return;
    }

    if (samePage && sameView(lastView, view)) return;
    const result = samePage ? await updatePage(bridge, view, kind) : await showPage(bridge, view, kind);
    if (closed) return;
    if (!result.ok) { fail(result.reason); return; }
    pageReady = true; pageKind = kind; lastView = view;
  };

  // Draws run one after another: a layout switch must not race a text update
  // into a page that is being replaced.
  let drawing: Promise<void> = Promise.resolve();
  const draw = (): Promise<void> => {
    drawing = drawing.then(drawNow).catch((thrown: unknown) => { console.warn("[openglance] draw failed:", thrown); });
    return drawing;
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
  const computeRoute = async (from: LatLng, fresh = false): Promise<void> => {
    const seq = ++routeSeq;
    if (fresh || !trip) {
      trip = buildTrip(from);
      tripSeq++;
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
    const outcome = await router().route({ from, to: current.to, mode: data.mode, ...(stops.length ? { via: stops.map((stop) => stop.at) } : {}) });
    if (seq !== routeSeq) return;
    rerouting = false;
    startPhase = null;

    if (!outcome.route) {
      console.warn("[openglance] route failed:", outcome.code, outcome.error);
      errorKey = routeErrorKey(outcome.code);
      nav = null;
    } else {
      errorKey = null;
      routeVersion++;
      routedStops = stops;
      // Arrivals at stops carry the stop's name ("Stopp 1: Ladepark").
      nav = startNavigation(nameStops(outcome.route as Route, stops, tr(messages, locale, "g.stopWord")));
      // The mock router has no Overpass behind it: the demo brings its own named streets.
      if (usesMockRouter(data)) {
        const shape = nav.route.shape;
        streets = { route: routeVersion, list: demoStreets(shape, nav.route.maneuvers.filter((m) => m.street).map((m) => ({ from: m.shapeIndex, name: m.street as string }))) };
        streetsVersion++;
      }
      if (position) nav = update(nav, position);
    }
    await draw();
  };

  /** A position younger than this starts the route at once; an older one waits for a fresh fix. */
  const FRESH_FIX_MS = 120_000;

  /**
   * Starts navigating to the selected destination. The glasses say at every
   * step what is happening (finding the position, calculating the route) and,
   * if it fails, why and what to do: nothing may look like "the tap did nothing".
   */
  const startNavigating = async (): Promise<void> => {
    const seq = ++routeSeq;
    screen = "nav";
    // Remembered, so navigation picks up again after the phone has ended the app (screen lock).
    if (!DEMO) saveData({ ...data, activeSince: Date.now() });
    nav = null;
    errorKey = null;
    rerouting = false;
    // A hold stops location updates to save battery; navigating again needs
    // them back, or the arrow froze on the first fix for the whole trip.
    void bridge.startAppLocationUpdates({
      accuracy: AppLocationAccuracy.High,
      distanceFilter: 5,
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
    await computeRoute(position, true);
  };

  /** Back to the destination list, with the cursor on the active destination. */
  const openList = (): void => {
    abortVoice();
    chargerSeq++;
    chargerList = null;
    screen = "list";
    cursor = cursorFor(data);
    void draw();
  };

  const stopNavigating = async (): Promise<void> => {
    routeSeq++;
    if (data.activeSince !== null) saveData({ ...data, activeSince: null });
    nav = null;
    trip = null;
    routedStops = [];
    tripSeq++;
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

  /** Navigates to a destination from the list or from speech; it becomes the active one. */
  const navigateTo = (place: Destination): void => {
    saveData(chooseDestination(data, place));
    void startNavigating();
  };

  /** Starts a saved route: its way of travel, its stops, from wherever the glasses are. */
  const startRoute = (route: SavedRoute): void => {
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

  // ---- Speaking a destination (hold on the list) ----

  /** Drops a recording or an answer in flight; the microphone is always switched off. */
  function abortVoice(): void {
    voiceSeq++;
    if (recordTimer !== null) clearTimeout(recordTimer);
    recordTimer = null;
    if (micActive) void bridge.audioControl(false).catch(() => undefined);
    micActive = false;
    micChunks.length = 0;
    voice = null;
  }

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
    if (!DEMO && !sttBase("")) { voiceError("v.noServer"); return; }
    voice = { phase: "recording" };
    void draw();
    if (DEMO) return;
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
    if (!granted) { voiceError("v.noMic"); return; }
    // A recording must end even when the release event never arrives.
    recordTimer = setTimeout(() => { recordTimer = null; void finishVoice(); }, MAX_VOICE_MS);
  };

  /** Release: send what was said to the speech server, look the words up, show up to three places. */
  async function finishVoice(): Promise<void> {
    if (!voice || voice.phase !== "recording") return;
    const seq = ++voiceSeq;
    if (recordTimer !== null) clearTimeout(recordTimer);
    recordTimer = null;
    voice = { phase: "working" };
    void draw();
    if (!DEMO) {
      micActive = false;
      await bridge.audioControl(false).catch(() => undefined);
      // Blocks still in flight arrive after the off-switch; without the pause the tail is lost.
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    let heard = "Mirabellplatz Salzburg";
    if (!DEMO) {
      const bytes = micChunks.reduce((sum, chunk) => sum + chunk.length, 0);
      if (bytes < MIN_VOICE_BYTES && !devHeard) {
        micChunks.length = 0;
        if (seq === voiceSeq) voiceError("v.short");
        return;
      }
      const wav = buildWav(micChunks);
      micChunks.length = 0;
      try {
        heard = await transcribe(wav, sttBase(""), locale);
      } catch (thrown) {
        if (seq !== voiceSeq) return;
        console.warn("[openglance] speech failed:", thrown instanceof Error ? thrown.message : thrown);
        if (!devHeard) { voiceError("v.sttFailed"); return; }
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
  }).catch(() => false);

  const stopListening = bridge.onAppLocationChanged((location: AppLocation) => {
    if (closed) return;
    if (typeof location?.latitude !== "number" || typeof location?.longitude !== "number") return;
    position = { lat: location.latitude, lon: location.longitude };
    positionAt = Date.now();
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
    if (screen === "nav") void draw();
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
        if (!leaving || closed) return;
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
    tts.stop();
    if (tickTimer !== null) clearInterval(tickTimer);
    if (streetsTimer !== null) clearTimeout(streetsTimer);
    if (typeof stopListening === "function") stopListening();
    return bridge.stopAppLocationUpdates().then(() => undefined, () => undefined);
  }

  /** Start page: swipe moves the cursor, tap starts (or switches the travel mode), hold speaks. */
  const onListGesture = (gesture: string): void => {
    const items = listItems(data);
    switch (gesture) {
      case "scrollUp": cursor = clampCursor(data, cursor - 1); void draw(); return;
      case "scrollDown": cursor = clampCursor(data, cursor + 1); void draw(); return;
      case "click": {
        if (cursor >= items.length) {
          saveData({ ...data, mode: nextMode(data.mode) });
          void draw();
          return;
        }
        const item = items[cursor];
        if (!item) return;
        if (item.kind === "chargers") void openChargers();
        else if (item.kind === "route") startRoute(item.route);
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

  /** Navigating (also while starting and after a failure). */
  const onNavGesture = (gesture: string): void => {
    switch (gesture) {
      case "click":
        if (errorKey) { void startNavigating(); return; }
        if (nav && progressOf(nav).offRoute && position) { void computeRoute(position); return; }
        return;
      case "scrollUp":
      case "scrollDown":
        // Either direction switches between the turn arrow and the overview
        // map: with two views there is nothing to scroll through.
        saveData({ ...data, glassView: data.glassView === "overview" ? "turns" : "overview" });
        void draw();
        return;
      case "longPress":
        // Stop (or cancel a start) and go back to the destination list.
        void stopNavigating();
        return;
      default:
        return;
    }
  };

  bridge.onEvenHubEvent((event) => {
    if (closed) return;
    // System lifecycle: back in front = draw afresh; ended by the system =
    // everything off, but an active navigation stays remembered for the restart.
    const systemType = (event as { sysEvent?: { eventType?: number } } | null)?.sysEvent?.eventType;
    if (systemType === 4) { pageReady = false; lastView = null; void draw(); return; }
    if (systemType === 5) return;
    if (systemType === 6 || systemType === 7) { void shutdown(); return; }
    // PCM blocks of a recording arrive on the same channel as gestures.
    const audio = (event as { audioEvent?: { audioPcm?: unknown } } | null)?.audioEvent;
    if (audio !== undefined) {
      if (micActive) {
        const bytes = pcmBytes(audio.audioPcm);
        if (bytes !== null && bytes.length > 0) micChunks.push(bytes);
      }
      return;
    }
    const gesture = gestureFromEvent(event, { invertScroll: data.invertScroll });
    if (!gesture) return;
    if (gesture.gesture === "doubleClick") {
      // Speaking is a page on top of the list: double tap goes back. Elsewhere it closes the app.
      if (screen === "voice" || screen === "chargers") { openList(); return; }
      requestExit();
      return;
    }
    switch (screen) {
      case "list": onListGesture(gesture.gesture); return;
      case "voice": onVoiceGesture(gesture.gesture); return;
      case "chargers": onChargerGesture(gesture.gesture); return;
      default: onNavGesture(gesture.gesture);
    }
  });

  bridge.onDeviceStatusChanged((status) => {
    if (status?.connectType === "connected" && !closed) {
      pageReady = false;
      void draw();
    }
  });

  tickTimer = setInterval(() => { void draw(); }, 2000);

  // Navigation that was running when the phone ended the app (screen lock,
  // memory): picked up again at once, if it is recent and the target still exists.
  if (!DEMO && data.activeSince !== null) {
    if (Date.now() - data.activeSince < RESUME_WITHIN_MS && selectionLabel(data) !== null) void startNavigating();
    else saveData({ ...data, activeSince: null });
  }

  mountPhoneUi({
    getData: () => data,
    setData: async (next) => {
      const routeChanged = next.destinationId !== data.destinationId
        || next.mode !== data.mode
        || next.demo !== data.demo
        || next.valhallaUrl !== data.valhallaUrl;
      data = next;
      // A destination picked on the phone moves the cursor of the glasses list onto it.
      if (screen === "list") cursor = cursorFor(data);
      else cursor = clampCursor(data, cursor);
      if (!next.announce) tts.stop();
      await save(bridge, next);
      if (routeChanged && nav && position) await computeRoute(position, true);
      await draw();
    },
    getPosition: () => position,
    onVoiceActivate: () => { tts.unlock(); if (tts.available) tts.speak(locale === "de" ? "Sprachausgabe ist bereit." : "Voice is ready."); },
    getVoiceState: voiceState,
    getLocale: () => locale,
    setLocale: (next) => {
      locale = next;
      rememberLocale(bridge, next);
      void draw();
    },
    search: (query) => searchPlaces(query, { lang: locale, near: position }),
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
    chargersAlong: (line) => (usesMockRouter(data)
      ? Promise.resolve({ chargers: demoChargers(line), error: null })
      : chargerSource.along(line)),
  });
}

void boot().catch((error: unknown) => {
  console.error("[openglance] failed to start:", error);
});
