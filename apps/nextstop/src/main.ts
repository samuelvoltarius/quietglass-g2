import {
  AppLocationAccuracy, waitForEvenAppBridge, type AppLocation, type EvenAppBridge,
} from "@evenrealities/even_hub_sdk";
import { HafasBackend } from "./transit/hafas";
import { MotisBackend } from "./transit/motis";
import type { Departure, Ride, Stop, TransitBackend } from "./transit/types";
import { metresBetween } from "./transit/types";
import { trackRide, type Position } from "./ride/tracker";
import { gestureFromEvent } from "./input/gestures";
import {
  departureBoard, errorView, loadingView, ridingView, type StopView,
} from "./glasses/view";
import { sameView } from "./glasses/diff";
import { createPage, updatePage } from "./glasses/render";
import { load, save, type Settings } from "./storage/persist";
import { mountPhoneUi } from "./ui/phone";

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
 * seen saying "Warte auf GPS" and the actual board never appears on a desk.
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

async function boot(): Promise<void> {
  const bridge: EvenAppBridge = await waitForEvenAppBridge();

  let settings: Settings = await load(bridge);
  const seeded = positionFromUrl(globalThis.location?.search ?? "");
  let position: Position | null = seeded;

  let stops: readonly Stop[] = [];
  let stopIndex = 0;
  let departures: readonly Departure[] = [];
  let selected = 0;

  let ride: Ride | null = null;
  let error: string | null = null;
  let hint = "";
  let busy = "Haltestelle suchen …";

  let lastView: StopView | null = null;
  let pageReady = false;
  let refreshTimer: ReturnType<typeof setInterval> | null = null;

  const backend = (): TransitBackend => settings.backend === "motis"
    ? new MotisBackend({ baseUrl: settings.motisUrl })
    : new HafasBackend({ baseUrl: settings.oebbUrl });

  const currentStop = (): Stop | undefined => stops[stopIndex];

  const currentView = (): StopView => {
    if (error) return errorView(error, hint);

    if (ride) {
      const progress = trackRide(ride, new Date(), position);
      if (progress) return ridingView(progress, new Date(), ride.line, ride.headsign);
    }

    const stop = currentStop();
    if (!stop) return loadingView(busy);

    const away = position
      ? metresBetween(position.lat, position.lon, stop.lat, stop.lon)
      : null;
    return departureBoard(stop, departures, away, selected);
  };

  const draw = async (): Promise<void> => {
    const view = currentView();
    if (sameView(lastView, view)) return;

    const result = pageReady ? await updatePage(bridge, view) : await createPage(bridge, view);
    if (result.ok) { pageReady = true; lastView = view; return; }
    pageReady = false;
    console.warn("[nextstop] draw failed:", result.reason);
  };

  /** Turns a thrown failure into something a passenger can act on. */
  const explain = (thrown: unknown): void => {
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    if (settings.backend === "oebb" && /fetch|network|failed/i.test(message)) {
      error = "ÖBB nicht erreichbar";
      hint = "Läuft der Proxy? Siehe examples/oebb-cors-proxy.mjs";
    } else if (/403/.test(message)) {
      error = "Vom Dienst abgewiesen";
      hint = "Transitous verlangt einen erkennbaren Client.";
    } else {
      error = "Abfrage fehlgeschlagen";
      hint = message.slice(0, 80);
    }
  };

  const loadDepartures = async (): Promise<void> => {
    const stop = currentStop();
    if (!stop) return;
    try {
      departures = await backend().departures(stop.id, 12);
      selected = Math.min(selected, Math.max(0, departures.length - 1));
      error = null;
    } catch (thrown) {
      explain(thrown);
    }
    await draw();
  };

  const findStops = async (): Promise<void> => {
    if (!position) {
      busy = "Warte auf GPS …";
      await draw();
      return;
    }
    busy = "Haltestelle suchen …";
    await draw();
    try {
      stops = await backend().nearbyStops(position.lat, position.lon, 5);
      stopIndex = 0;
      selected = 0;
      error = stops.length === 0 ? "Keine Haltestelle in der Nähe" : null;
      hint = stops.length === 0
        ? "Das gewählte Backend kennt diese Gegend nicht. In der Handy-App umschalten."
        : "";
    } catch (thrown) {
      explain(thrown);
    }
    await loadDepartures();
  };

  const startTracking = async (): Promise<void> => {
    const departure = departures[selected];
    if (!departure) return;
    busy = "Fahrt laden …";
    await draw();
    try {
      ride = await backend().ride(departure.tripId);
      error = ride ? null : "Fahrtverlauf nicht verfügbar";
      hint = ride ? "" : "Diese Fahrt liefert keine Haltestellenfolge.";
    } catch (thrown) {
      explain(thrown);
    }
    await draw();
  };

  const stopTracking = async (): Promise<void> => {
    ride = null;
    error = null;
    await loadDepartures();
  };

  /**
   * Refresh only matters on the board. While riding, the stop list does not
   * change, and re-fetching it every half minute would spend battery and a
   * volunteer-run service's capacity on an answer already held.
   */
  const scheduleRefresh = (): void => {
    if (refreshTimer !== null) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
      if (!ride) void loadDepartures();
      // The ride screen still redraws, because its countdown moves with the
      // clock even when no new data has arrived.
      void draw();
    }, settings.refreshSeconds * 1000);
  };

  await draw();

  await bridge.startAppLocationUpdates({
    accuracy: AppLocationAccuracy.High,
    distanceFilter: 10,
  }).catch(() => false);

  const firstFix = await bridge.getAppLocation({ accuracy: AppLocationAccuracy.High })
    .catch(() => null);
  if (firstFix && typeof firstFix.latitude === "number") {
    // A real fix always wins over the URL parameter.
    position = { lat: firstFix.latitude, lon: firstFix.longitude };
  }
  await findStops();
  scheduleRefresh();

  bridge.onAppLocationChanged((location: AppLocation) => {
    if (typeof location?.latitude !== "number" || typeof location?.longitude !== "number") return;
    const previous = position;
    position = {
      lat: location.latitude,
      lon: location.longitude,
      ...(typeof location.accuracy === "number" ? { accuracy: location.accuracy } : {}),
    };

    // The first fix after starting cold is what finally makes a stop findable.
    if (!previous && !ride) { void findStops(); return; }
    void draw();
  });

  bridge.onEvenHubEvent((event) => {
    const gesture = gestureFromEvent(event, { invertScroll: false });
    if (!gesture) return;

    switch (gesture.gesture) {
      case "click":
        if (error) { void (ride ? stopTracking() : findStops()); return; }
        if (ride) { void stopTracking(); return; }
        void startTracking();
        return;
      case "longPress":
        // Cycle through the other stops within reach — useful at a junction
        // where the stop you want is not the one you are standing closest to.
        if (ride || stops.length < 2) return;
        stopIndex = (stopIndex + 1) % stops.length;
        selected = 0;
        void loadDepartures();
        return;
      case "scrollUp":
        if (ride || departures.length === 0) return;
        selected = Math.max(0, selected - 1);
        void draw();
        return;
      case "scrollDown":
        if (ride || departures.length === 0) return;
        selected = Math.min(departures.length - 1, selected + 1);
        void draw();
        return;
      case "doubleClick":
        void bridge.stopAppLocationUpdates()
          .catch(() => undefined)
          .then(() => bridge.shutDownPageContainer());
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

  // A second beat so the countdown stays honest between data refreshes.
  setInterval(() => { void draw(); }, 2000);

  mountPhoneUi({
    getSettings: () => settings,
    setSettings: async (next) => {
      const backendChanged = next.backend !== settings.backend
        || next.oebbUrl !== settings.oebbUrl
        || next.motisUrl !== settings.motisUrl;
      settings = next;
      await save(bridge, next);
      scheduleRefresh();
      if (backendChanged) { ride = null; await findStops(); }
      await draw();
    },
    getPosition: () => position,
    isSeeded: () => position === seeded && seeded !== null,
    getStops: () => stops,
    refresh: () => { void findStops(); },
  });
}

void boot().catch((error: unknown) => {
  console.error("[nextstop] failed to start:", error);
});
