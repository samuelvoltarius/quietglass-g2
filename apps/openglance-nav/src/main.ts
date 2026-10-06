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
import { renderRoutePng } from "./overview/draw";
import { thinPoints } from "./overview/project";
import { createGeocoder, type Geocoder } from "./geocode/photon";
import { getLocale, setLocale, tr, type Locale } from "./i18n";
import { messages } from "./messages";
import {
  destinationOf, geocoderUrlOf, load, routerUrlOf, save, usesMockRouter, type NavData,
} from "./storage/persist";
import { mountPhoneUi } from "./ui/phone";

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
  let lastOverviewKey = "";
  /** Bumped for every new route, so the overview image knows to redraw. */
  let routeVersion = 0;
  let closed = false;
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
    });

  /** Changes only when the overview image would look different. */
  const overviewKey = (): string => {
    if (!nav) return "none";
    const at = nav.position;
    return [routeVersion, nav.maneuverIndex, at ? at.lat.toFixed(4) + "," + at.lon.toFixed(4) : "-"].join("|");
  };

  const overviewPng = (): Promise<Uint8Array> => {
    if (!nav) return renderRoutePng([], null);
    const progress = progressOf(nav);
    const next = progress.maneuver ? nav.route.shape[progress.maneuver.shapeIndex] ?? null : null;
    return renderRoutePng(thinPoints(nav.route.shape), nav.position, progress.arrived ? null : next);
  };

  const drawNow = async (): Promise<void> => {
    if (closed) return;
    const layout = data.glassView;
    const view = currentView(layout);
    const samePage = pageReady && pageLayout === layout;

    if (layout === "overview") {
      const key = overviewKey();
      if (samePage && sameView(lastView, view) && key === lastOverviewKey) return;
      let png: Uint8Array | null = null;
      if (!samePage || key !== lastOverviewKey) {
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
      if (result.ok) { pageReady = true; pageLayout = layout; lastView = view; lastOverviewKey = key; return; }
      pageReady = false;
      console.warn("[openglance] draw failed:", result.reason);
      return;
    }

    if (samePage && sameView(lastView, view)) return;
    const maneuver = nav ? progressOf(nav).maneuver : null;
    const icon = pixelArrowFor(maneuver?.type);

    const result = samePage ? await updatePage(bridge, view, icon) : await createPage(bridge, view, icon);
    if (closed) return;
    if (result.ok) { pageReady = true; pageLayout = layout; lastView = view; return; }
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
        // Stop everything that could draw again first, and never leave a
        // failing shutdown as an unhandled rejection.
        closed = true;
        routeSeq++;
        nav = null;
        if (tickTimer !== null) clearInterval(tickTimer);
        if (typeof stopListening === "function") stopListening();
        void bridge.stopAppLocationUpdates()
          .catch(() => undefined)
          .then(() => bridge.shutDownPageContainer())
          .catch((thrown: unknown) => { console.warn("[openglance] shutdown failed:", thrown); });
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
