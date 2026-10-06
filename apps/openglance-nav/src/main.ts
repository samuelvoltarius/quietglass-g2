import {
  AppLocationAccuracy, waitForEvenAppBridge, type AppLocation, type EvenAppBridge,
} from "@evenrealities/even_hub_sdk";
import type { LatLng } from "./geo/geometry";
import {
  createMockProvider, createValhallaProvider, type Route, type RoutingProvider,
} from "./routing/provider";
import {
  needsReroute, progressOf, startNavigation, update, type NavState,
} from "./nav/navigator";
import { gestureFromEvent } from "./input/gestures";
import { buildView, type NavView } from "./glasses/view";
import { sameView } from "./glasses/diff";
import { createPage, updatePage } from "./glasses/render";
import { pixelArrowFor } from "./glasses/icons";
import {
  destinationOf, load, save, usesMockRouter, type NavData,
} from "./storage/persist";
import { mountPhoneUi } from "./ui/phone";

const DEMO = new URLSearchParams(location.search).get("demo") === "1";

async function boot(): Promise<void> {
  const bridge: EvenAppBridge = await waitForEvenAppBridge();

  let data: NavData = await load(bridge);
  if (DEMO) data = { ...data, places: [{ id: "demo", label: "Mirabellplatz", at: { lat: 47.815, lon: 13.048 } }], destinationId: "demo", valhallaUrl: "" };
  let nav: NavState | null = null;
  let position: LatLng | null = DEMO ? { lat: 47.805, lon: 13.042 } : null;
  let rerouting = false;
  let error: string | null = null;
  let lastView: NavView | null = null;
  let pageReady = false;
  let closed = false;
  let tickTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Every route request takes a number, and an answer that arrives after a
   * newer request — or after navigation was stopped — is dropped. Without it a
   * slow reroute for the old destination could land after the route to the
   * new one, or switch navigation back on after a hold had stopped it.
   */
  let routeSeq = 0;

  const router = (): RoutingProvider =>
    usesMockRouter(data)
      ? createMockProvider()
      : createValhallaProvider({ url: data.valhallaUrl });

  const currentView = (): NavView =>
    buildView(nav ? progressOf(nav) : null, {
      mode: data.mode,
      navigating: nav !== null,
      rerouting,
      error,
      mock: usesMockRouter(data),
      waitingForFix: nav !== null && position === null,
    });

  const draw = async (): Promise<void> => {
    if (closed) return;
    const view = currentView();
    if (sameView(lastView, view)) return;

    const maneuver = nav ? progressOf(nav).maneuver : null;
    const icon = pixelArrowFor(maneuver?.type);

    const result = pageReady ? await updatePage(bridge, view, icon) : await createPage(bridge, view, icon);
    if (closed) return;
    if (result.ok) { pageReady = true; lastView = view; return; }
    pageReady = false;
    console.warn("[openglance] draw failed:", result.reason);
  };

  const computeRoute = async (from: LatLng): Promise<void> => {
    const seq = ++routeSeq;
    const destination = destinationOf(data);
    if (!destination) { error = "No destination set."; await draw(); return; }

    rerouting = nav !== null;
    error = null;
    await draw();

    const outcome = await router().route({ from, to: destination.at, mode: data.mode });
    if (seq !== routeSeq) return;
    rerouting = false;

    if (!outcome.route) {
      error = outcome.error ?? "routing failed";
      nav = null;
    } else {
      error = null;
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
    if (!position) { error = "No position available."; await draw(); return; }
    await computeRoute(position);
  };

  const stopNavigating = async (): Promise<void> => {
    routeSeq++;
    nav = null;
    error = null;
    rerouting = false;
    await bridge.stopAppLocationUpdates().catch(() => undefined);
    await draw();
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
      // Rerouting is automatic: a driver cannot be expected to ask for it.
      if (needsReroute(nav) && !rerouting) void computeRoute(position);
    }
    void draw();
  });

  bridge.onEvenHubEvent((event) => {
    if (closed) return;
    const gesture = gestureFromEvent(event, { invertScroll: data.invertScroll });
    if (!gesture) return;

    switch (gesture.gesture) {
      case "click":
        if (error) { void startNavigating(); return; }
        if (!nav) { void startNavigating(); return; }
        if (progressOf(nav).offRoute && position) { void computeRoute(position); return; }
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
      const destinationChanged = next.destinationId !== data.destinationId
        || next.mode !== data.mode;
      data = next;
      await save(bridge, next);
      if (destinationChanged && nav && position) await computeRoute(position);
      await draw();
    },
    getPosition: () => position,
  });
}

void boot().catch((error: unknown) => {
  console.error("[openglance] failed to start:", error);
});
