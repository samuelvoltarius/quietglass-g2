import {
  AppLocationAccuracy, waitForEvenAppBridge, type AppLocation, type EvenAppBridge,
} from "@evenrealities/even_hub_sdk";
import type { LatLng } from "./geo/geometry";
import {
  clientIdFor, createMockProvider, createValhallaProvider, type Route, type RoutingProvider,
} from "./routing/provider";
import { createRequestGate, mayAutoReroute } from "./routing/throttle";
import {
  needsReroute, progressOf, startNavigation, update, type NavState,
} from "./nav/navigator";
import { gestureFromEvent } from "./input/gestures";
import { buildView, type GlassLayout, type NavView } from "./glasses/view";
import { sameView } from "./glasses/diff";
import {
  createOverviewPage, createPage, updateOverviewPage, updatePage,
} from "./glasses/render";
import { pixelArrowFor } from "./glasses/icons";
import { approachSteps, cardKey, type TurnCard } from "./glasses/turncard";
import { renderRoutePng } from "./overview/draw";
import { markerPixel, overviewProjector, OVERVIEW_HEIGHT, OVERVIEW_WIDTH } from "./overview/layout";
import { thinPoints } from "./overview/project";
import { needsOverviewImage, type OverviewFrame } from "./overview/refresh";
import { createStreetSource, streetsForRoute, type StreetSegment } from "./overview/streets";
import { createGeocoder, type Geocoder } from "./geocode/photon";
import { getLocale, setLocale, tr, type Locale } from "./i18n";
import { messages } from "./messages";
import {
  destinationOf, geocoderUrlOf, load, routerUrlOf, save, usesMockRouter, type NavData,
} from "./storage/persist";
import { mountPhoneUi } from "./ui/phone";

/** While the distance only counts down, the turn card is resent at most this often. */
const CARD_MIN_INTERVAL_MS = 2_000;
/** The overview must stay up this long before its streets are fetched. */
const STREETS_DWELL_MS = 1_500;
/** `shutDownPageContainer` mode that shows the system's exit confirmation. */
const EXIT_WITH_CONFIRMATION = 1;

const DEMO = new URLSearchParams(location.search).get("demo") === "1";

async function boot(): Promise<void> {
  const bridge: EvenAppBridge = await waitForEvenAppBridge();

  let locale: Locale = getLocale();
  let data: NavData = await load(bridge);
  if (DEMO) data = { ...data, places: [{ id: "demo", label: "Mirabellplatz", at: { lat: 47.815, lon: 13.048 } }], destinationId: "demo", demo: true };
  let nav: NavState | null = null;
  let position: LatLng | null = DEMO ? { lat: 47.805, lon: 13.042 } : null;
  let rerouting = false;
  /** Message key of the error shown, translated at draw time. */
  let errorKey: string | null = null;
  let lastView: NavView | null = null;
  let pageReady = false;
  let pageLayout: GlassLayout | null = null;
  /** The overview picture last sent; a new one goes out only when it would look different. */
  let sentOverview: OverviewFrame | null = null;
  /** What the turn images last sent showed, and when the card went out. */
  let sentIconKey = "";
  let sentCardKey = "";
  let sentCardAt = 0;
  /** Bumped for every new route, so the overview image knows to redraw. */
  let routeVersion = 0;
  /**
   * Real streets for the overview, fetched once per route - lazily, the first
   * time the overview is shown - and never waited for: the route is drawn at
   * once and the streets join it when (if) they arrive.
   */
  const streetSource = createStreetSource();
  let streets: { route: number; segments: readonly StreetSegment[] } = { route: -1, segments: [] };
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

  const currentView = (layout: GlassLayout): NavView =>
    buildView(nav ? progressOf(nav) : null, {
      mode: data.mode,
      navigating: nav !== null,
      rerouting,
      error: errorKey ? tr(messages, locale, errorKey) : null,
      mock: usesMockRouter(data),
      waitingForFix: nav !== null && position === null,
      locale,
      destination: destinationOf(data)?.label ?? null,
      layout,
      bigDistance: layout === "turns",
    });

  /** The thinned route the overview draws, computed once per route. */
  let thinned: { route: number; points: readonly LatLng[] } = { route: -1, points: [] };
  const overviewPoints = (): readonly LatLng[] => {
    if (!nav) return [];
    if (thinned.route !== routeVersion) thinned = { route: routeVersion, points: thinPoints(nav.route.shape) };
    return thinned.points;
  };

  /** What the overview would show now; compared with what was sent. */
  const overviewFrame = (): OverviewFrame => ({
    route: nav ? routeVersion : -1,
    // Switching streets off must redraw without them, so the setting is part of the picture.
    streets: data.streets ? streetsVersion : -1,
    maneuver: nav ? nav.maneuverIndex : -1,
    marker: nav ? markerPixel(overviewPoints(), nav.position) : null,
    at: Date.now(),
  });

  /**
   * Starts the street fetch for the current route if it has not been asked
   * for yet — once the overview has stayed up for STREETS_DWELL_MS, so a swipe
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
    void streetsForRoute(streetSource, overviewProjector(points), data.mode, OVERVIEW_WIDTH, OVERVIEW_HEIGHT).then((result) => {
      if (closed || forRoute !== routeVersion) return;
      if (result.error) console.warn("[openglance] streets unavailable:", result.error);
      if (!result.segments.length) return;
      streets = { route: forRoute, segments: result.segments };
      streetsVersion++;
      void draw();
    });
  };

  const overviewPng = (): Promise<Uint8Array> => {
    if (!nav) return renderRoutePng([], null);
    const progress = progressOf(nav);
    const next = progress.maneuver ? nav.route.shape[progress.maneuver.shapeIndex] ?? null : null;
    const segments = data.streets && streets.route === routeVersion ? streets.segments : [];
    return renderRoutePng(overviewPoints(), nav.position, progress.arrived ? null : next, OVERVIEW_WIDTH, OVERVIEW_HEIGHT, segments);
  };

  /** The turn card for a view: its big distance and how full the approach bar is. */
  const turnCardFor = (view: NavView): TurnCard | null => {
    if (view.big === undefined || !nav) return null;
    const leg = nav.route.maneuvers[nav.maneuverIndex]?.length ?? 0;
    return { label: view.big, steps: approachSteps(progressOf(nav).distanceToManeuver, leg, data.mode) };
  };

  const drawNow = async (): Promise<void> => {
    if (closed) return;
    const layout = data.glassView;
    const view = currentView(layout);
    const samePage = pageReady && pageLayout === layout;

    if (layout === "overview") {
      ensureStreets();
      const frame = overviewFrame();
      const needImage = !samePage || needsOverviewImage(sentOverview, frame);
      if (samePage && sameView(lastView, view) && !needImage) return;
      let png: Uint8Array | null = null;
      if (needImage) {
        try { png = await overviewPng(); } catch (thrown) {
          console.warn("[openglance] overview image failed:", thrown);
          return;
        }
      }
      if (closed) return;
      const result = samePage || !png
        ? await updateOverviewPage(bridge, view, png)
        : await createOverviewPage(bridge, view, png);
      if (closed) return;
      if (result.ok) { pageReady = true; pageLayout = layout; lastView = view; if (png) sentOverview = frame; return; }
      pageReady = false;
      console.warn("[openglance] draw failed:", result.reason);
      return;
    }

    const maneuver = nav ? progressOf(nav).maneuver : null;
    const icon = pixelArrowFor(maneuver?.type);
    const iconKey = icon.join("");
    const card = turnCardFor(view);
    const nextCardKey = cardKey(card);
    const now = Date.now();
    // The arrow goes out only when the manoeuvre changes; the card when its
    // digits or bar change, and while it only counts down no more often than
    // CARD_MIN_INTERVAL_MS. Each image crosses Bluetooth.
    const sendIcon = iconKey !== sentIconKey;
    const sendCard = nextCardKey !== sentCardKey && (sendIcon || card === null || now - sentCardAt >= CARD_MIN_INTERVAL_MS);
    if (samePage && sameView(lastView, view) && !sendIcon && !sendCard) return;

    const result = samePage
      ? await updatePage(bridge, view, { ...(sendIcon ? { icon } : {}), ...(sendCard ? { card } : {}) })
      : await createPage(bridge, view, icon, card);
    if (closed) return;
    if (result.ok) {
      pageReady = true; pageLayout = layout; lastView = view;
      if (!samePage || sendIcon) sentIconKey = iconKey;
      if (!samePage || sendCard) { sentCardKey = nextCardKey; sentCardAt = now; }
      return;
    }
    pageReady = false;
    console.warn("[openglance] draw failed:", result.reason);
  };

  // Draws run one after another: a layout switch must not race a text update
  // into a page that is being replaced.
  let drawing: Promise<void> = Promise.resolve();
  const draw = (): Promise<void> => {
    drawing = drawing.then(drawNow).catch((thrown: unknown) => { console.warn("[openglance] draw failed:", thrown); });
    return drawing;
  };

  const computeRoute = async (from: LatLng): Promise<void> => {
    const seq = ++routeSeq;
    const destination = destinationOf(data);
    if (!destination) { errorKey = "err.noDestination"; await draw(); return; }

    rerouting = nav !== null;
    errorKey = null;
    await draw();

    if (!usesMockRouter(data) && globalThis.navigator?.onLine === false) {
      if (seq !== routeSeq) return;
      rerouting = false;
      errorKey = "err.offline";
      nav = null;
      await draw();
      return;
    }

    await routeGate.ready();
    if (seq !== routeSeq) return;
    lastRouteAt = Date.now();
    const outcome = await router().route({ from, to: destination.at, mode: data.mode });
    if (seq !== routeSeq) return;
    rerouting = false;

    if (!outcome.route) {
      errorKey = "err." + (outcome.code ?? "server");
      nav = null;
    } else {
      errorKey = null;
      routeVersion++;
      nav = startNavigation(outcome.route as Route);
      if (position) nav = update(nav, position);
    }
    await draw();
  };

  const startNavigating = async (): Promise<void> => {
    // A route needs a starting point; ask for one fix before routing rather
    // than routing from a stale or invented position.
    const seq = ++routeSeq;
    // A hold stops location updates to save battery; navigating again needs
    // them back, or the arrow froze on the first fix for the whole trip.
    await bridge.startAppLocationUpdates({
      accuracy: AppLocationAccuracy.High,
      distanceFilter: 5,
    }).catch(() => false);
    const fix = await bridge.getAppLocation({ accuracy: AppLocationAccuracy.High }).catch(() => null);
    if (seq !== routeSeq) return;
    if (fix) position = { lat: fix.latitude, lon: fix.longitude };
    if (!position) { errorKey = "err.noGps"; await draw(); return; }
    await computeRoute(position);
  };

  const stopNavigating = async (): Promise<void> => {
    routeSeq++;
    nav = null;
    errorKey = null;
    rerouting = false;
    await bridge.stopAppLocationUpdates().catch(() => undefined);
    await draw();
  };

  const saveData = (next: NavData): void => {
    data = next;
    void save(bridge, next).catch((thrown: unknown) => { console.warn("[openglance] save failed:", thrown); });
  };

  if (DEMO && position) await computeRoute(position); else await draw();

  // Location updates: the distance filter keeps the callback quiet while
  // stationary, which matters for battery on a long walk.
  await bridge.startAppLocationUpdates({
    accuracy: AppLocationAccuracy.High,
    distanceFilter: 5,
  }).catch(() => false);

  const stopListening = bridge.onAppLocationChanged((location: AppLocation) => {
    if (closed) return;
    if (typeof location?.latitude !== "number" || typeof location?.longitude !== "number") return;
    position = { lat: location.latitude, lon: location.longitude };

    if (nav) {
      nav = update(nav, position);
      // Rerouting is automatic: a driver cannot be expected to ask for it. It
      // is spaced out, though, so someone lingering beside the route does not
      // hammer a free public server; a tap still reroutes at once.
      if (needsReroute(nav) && !rerouting && mayAutoReroute(lastRouteAt, Date.now())) {
        void computeRoute(position);
      }
    }
    void draw();
  });

  bridge.onEvenHubEvent((event) => {
    if (closed) return;
    const gesture = gestureFromEvent(event, { invertScroll: data.invertScroll });
    if (!gesture) return;

    switch (gesture.gesture) {
      case "click":
        if (errorKey) { void startNavigating(); return; }
        if (!nav) { void startNavigating(); return; }
        if (progressOf(nav).offRoute && position) { void computeRoute(position); return; }
        return;
      case "scrollUp":
      case "scrollDown":
        // Either direction switches between the turn arrow and the overview
        // map: with two views there is nothing to scroll through.
        saveData({ ...data, glassView: data.glassView === "overview" ? "turns" : "overview" });
        void draw();
        return;
      case "doubleClick":
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
            // Stop everything that could draw or listen again.
            closed = true;
            routeSeq++;
            nav = null;
            if (tickTimer !== null) clearInterval(tickTimer);
            if (streetsTimer !== null) clearTimeout(streetsTimer);
            if (typeof stopListening === "function") stopListening();
            return bridge.stopAppLocationUpdates().then(() => undefined, () => undefined);
          });
        return;
      case "longPress":
        void stopNavigating();
        return;
      default:
        return;
    }
  });

  bridge.onDeviceStatusChanged((status) => {
    if (status?.connectType === "connected" && !closed) {
      pageReady = false;
      void draw();
    }
  });

  tickTimer = setInterval(() => { void draw(); }, 2000);

  mountPhoneUi({
    getData: () => data,
    setData: async (next) => {
      const routeChanged = next.destinationId !== data.destinationId
        || next.mode !== data.mode
        || next.demo !== data.demo
        || next.valhallaUrl !== data.valhallaUrl;
      data = next;
      await save(bridge, next);
      if (routeChanged && nav && position) await computeRoute(position);
      await draw();
    },
    getPosition: () => position,
    getLocale: () => locale,
    setLocale: (next) => {
      locale = next;
      setLocale(next);
      void draw();
    },
    search: (query) => searchPlaces(query, { lang: locale, near: position }),
  });
}

void boot().catch((error: unknown) => {
  console.error("[openglance] failed to start:", error);
});
