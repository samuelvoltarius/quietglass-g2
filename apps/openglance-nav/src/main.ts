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
import {
  destinationOf, load, save, usesMockRouter, type NavData,
} from "./storage/persist";
import { mountPhoneUi } from "./ui/phone";

async function boot(): Promise<void> {
  const bridge: EvenAppBridge = await waitForEvenAppBridge();

  let data: NavData = await load(bridge);
  let nav: NavState | null = null;
  let position: LatLng | null = null;
  let rerouting = false;
  let error: string | null = null;
  let lastView: NavView | null = null;
  let pageReady = false;

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
    const view = currentView();
    if (sameView(lastView, view)) return;

    const result = pageReady ? await updatePage(bridge, view) : await createPage(bridge, view);
    if (result.ok) { pageReady = true; lastView = view; return; }
    pageReady = false;
    console.warn("[openglance] draw failed:", result.reason);
  };

  const computeRoute = async (from: LatLng): Promise<void> => {
    const destination = destinationOf(data);
    if (!destination) { error = "No destination set."; await draw(); return; }

    rerouting = nav !== null;
    error = null;
    await draw();

    const outcome = await router().route({ from, to: destination.at, mode: data.mode });
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
    const fix = await bridge.getAppLocation({ accuracy: AppLocationAccuracy.High }).catch(() => null);
    if (fix) position = { lat: fix.latitude, lon: fix.longitude };
    if (!position) { error = "No position available."; await draw(); return; }
    await computeRoute(position);
  };

  const stopNavigating = async (): Promise<void> => {
    nav = null;
    error = null;
    await bridge.stopAppLocationUpdates().catch(() => undefined);
    await draw();
  };

  await draw();

  // Location updates: the distance filter keeps the callback quiet while
  // stationary, which matters for battery on a long walk.
  await bridge.startAppLocationUpdates({
    accuracy: AppLocationAccuracy.High,
    distanceFilter: 5,
  }).catch(() => false);

  bridge.onAppLocationChanged((location: AppLocation) => {
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
    const gesture = gestureFromEvent(event, { invertScroll: data.invertScroll });
    if (!gesture) return;

    switch (gesture.gesture) {
      case "click":
        if (error) { void startNavigating(); return; }
        if (!nav) { void startNavigating(); return; }
        if (progressOf(nav).offRoute && position) { void computeRoute(position); return; }
        return;
      case "doubleClick":
        void stopNavigating().then(() => bridge.shutDownPageContainer());
        return;
      case "longPress":
        void stopNavigating();
        return;
      default:
        return;
    }
  });

  bridge.onDeviceStatusChanged((status) => {
    if (status?.connectType === "connected") {
      pageReady = false;
      void draw();
    }
  });

  setInterval(() => { void draw(); }, 2000);

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
