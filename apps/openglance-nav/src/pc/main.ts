import "leaflet/dist/leaflet.css";
import L from "leaflet";
import "../ui/phone.css";
import "./pc.css";
import { decodePolyline, type LatLng } from "../geo/geometry";
import { DEFAULT_ROUTER_URL, createValhallaProvider, type RouteOutcome, type TravelMode } from "../routing/provider";
import { createGeocoder, DEFAULT_GEOCODER_URL } from "../geocode/photon";
import { withMapsLinks } from "../geocode/gmaps";
import { createChargerSource } from "../chargers/chargers";
import { EMPTY_DATA, type NavData } from "../storage/persist";
import { setLocale, type Locale } from "../i18n";
import { emptyPlan, plannerTemplate, type PlanState } from "../ui/planner";
import { wirePlanner, type SearchState } from "../ui/phone";
import { createRouteSync, sameRoutes, type RouteSyncError } from "../trip/sync";
import type { SavedRoute } from "../trip/saved";

/**
 * The route planner on the PC: the same planner as on the phone page of
 * OpenGlance (start, up to three stops, destination, way of travel, charging
 * stations with prices), on a real map, wider. Saved routes go to the route
 * store this page is served from; OpenGlance on the phone syncs with it, so
 * a route planned here is in the destination list of the glasses.
 *
 * Private page: served by the route store, reachable only in the tailnet,
 * signed in by Tailscale. Routing and charging stations come from the same
 * own servers as the private glasses build (VITE_ROUTER_URL, VITE_CHARGERS_URL).
 */

const locale: Locale = navigator.language.toLowerCase().startsWith("de") ? "de" : "en";
setLocale(locale);
document.documentElement.lang = locale;

const TEXT = {
  de: {
    title: "Routen planen",
    loading: "Lade gespeicherte Routen …",
    synced: (n: number) => `${n} Route${n === 1 ? "" : "n"} · gleich wie auf der Brille`,
    saving: "Speichere …",
    saved: "Gespeichert – auf der Brille beim nächsten Öffnen der Zielliste",
    error: { offline: "Routen-Speicher nicht erreichbar", timeout: "Routen-Speicher antwortet nicht", auth: "Nicht angemeldet (Tailscale)", server: "Routen-Speicher meldet einen Fehler" },
    mapPlan: "Karte: aktuelle Planung",
    mapSaved: (n: number) => n ? `Karte: ${n} gespeicherte Route${n === 1 ? "" : "n"} (nur Ziele bei Routen „ab Standort“)` : "Noch keine gespeicherten Routen",
    here: "Dein Standort (Browser)",
    retry: "Erneut versuchen",
  },
  en: {
    title: "Plan routes",
    loading: "Loading saved routes …",
    synced: (n: number) => `${n} route${n === 1 ? "" : "s"} · same as on the glasses`,
    saving: "Saving …",
    saved: "Saved – on the glasses next time the destination list opens",
    error: { offline: "Route store not reachable", timeout: "Route store does not answer", auth: "Not signed in (Tailscale)", server: "Route store reports an error" },
    mapPlan: "Map: current plan",
    mapSaved: (n: number) => n ? `Map: ${n} saved route${n === 1 ? "" : "s"} (destinations only for routes from "my position")` : "No saved routes yet",
    here: "Your position (browser)",
    retry: "Try again",
  },
}[locale];
document.title = `OpenGlance – ${TEXT.title}`;
const heading = document.querySelector(".pc-head h1");
if (heading) heading.textContent = TEXT.title;

const root = document.getElementById("app")!;
const syncState = document.getElementById("sync-state")!;
const caption = document.getElementById("map-caption")!;

// ---------------------------------------------------------------- state
let data: NavData = { ...EMPTY_DATA, mode: "driving", chargers: true };
let plan: PlanState = emptyPlan("driving");
let search: SearchState = { busy: false, results: [], errorKey: null };
let position: LatLng | null = null;

// A "from my position" route needs a position for its preview; the browser's, if allowed.
navigator.geolocation?.getCurrentPosition(
  (p) => { position = { lat: p.coords.latitude, lon: p.coords.longitude }; drawMap(); },
  () => undefined,
  { maximumAge: 10 * 60_000, timeout: 15_000 },
);

// ---------------------------------------------------------------- services
const store = createRouteSync({ url: location.origin + location.pathname.replace(/\/[^/]*$/, "") });
const geocoder = createGeocoder({ url: DEFAULT_GEOCODER_URL });
const router = createValhallaProvider({ url: DEFAULT_ROUTER_URL, language: locale === "de" ? "de-DE" : "en-US" });
const chargerSource = createChargerSource();

const showSync = (text: string, kind: "ok" | "busy" | "error", retry = false): void => {
  syncState.className = `sync-state ${kind}`;
  syncState.textContent = text;
  if (retry) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary";
    button.textContent = TEXT.retry;
    button.addEventListener("click", () => { void sync(false); });
    syncState.append(" ", button);
  }
};

let syncing: Promise<void> | null = null;
let again = false;
async function sync(afterChange: boolean): Promise<void> {
  if (!store) return;
  if (syncing) { again = true; return syncing; }
  showSync(afterChange ? TEXT.saving : TEXT.loading, "busy");
  syncing = (async () => {
    const sent = { routes: data.routes, deleted: data.deletedRoutes };
    const outcome = await store.sync(sent);
    if (!outcome.result) {
      showSync(TEXT.error[outcome.error as RouteSyncError] ?? TEXT.error.server, "error", true);
      return;
    }
    const merged = outcome.result;
    if (!sameRoutes({ routes: data.routes, deleted: data.deletedRoutes }, merged)) {
      data = { ...data, routes: merged.routes, deletedRoutes: merged.deleted };
      render();
    }
    showSync(afterChange ? TEXT.saved : TEXT.synced(data.routes.length), "ok");
  })().finally(() => {
    syncing = null;
    if (again) { again = false; void sync(true); }
  });
  return syncing;
}

// ---------------------------------------------------------------- page
const ports = {
  getData: () => data,
  setData: async (next: NavData) => { data = next; render(); },
  getPosition: () => position,
  getLocale: () => locale,
  search: withMapsLinks((query: string) => geocoder.search(query, { lang: locale, near: position })),
  planRoute: async (points: readonly LatLng[], mode: TravelMode): Promise<RouteOutcome> => {
    const from = points[0];
    const to = points[points.length - 1];
    if (!from || !to || points.length < 2) return { route: null, error: "no points", code: "noRoute" };
    const via = points.slice(1, -1);
    return router.route({ from, to, mode, ...(via.length ? { via } : {}) });
  },
  chargersAlong: (line: readonly LatLng[]) => chargerSource.along(line),
};

function render(): void {
  const typed = ["plan-query", "plan-name", "rename"].map((id) => root.querySelector<HTMLInputElement>("#" + id)?.value);
  root.innerHTML = `<p class="notice" id="pc-notice" hidden></p>` + plannerTemplate(plan, data.routes, locale, { canSearch: true, canRoute: true, chargers: true });
  ["plan-query", "plan-name", "rename"].forEach((id, index) => {
    const field = root.querySelector<HTMLInputElement>("#" + id);
    const value = typed[index];
    if (field && value !== undefined) field.value = value;
  });
  decorateSavedRoutes();
  wirePlanner(root, ports, data, locale, {
    notify: (message) => {
      const notice = root.querySelector<HTMLElement>("#pc-notice");
      if (notice) { notice.textContent = message; notice.hidden = false; }
    },
    rerender: render,
    setSearch: (next) => { search = next; render(); },
    getSearch: () => search,
    setPlan: (next) => { plan = next; render(); },
    getPlan: () => plan,
  }, (next) => {
    const routesChanged = next.routes !== data.routes || next.deletedRoutes !== data.deletedRoutes;
    data = next;
    render();
    if (routesChanged) void sync(true);
  });
  drawMap();
}

/** Hovering a saved route shows it alone on the map. */
let focused: string | null = null;
function decorateSavedRoutes(): void {
  root.querySelectorAll<HTMLLIElement>("#saved-routes li").forEach((item, index) => {
    const route = data.routes[index];
    if (!route) return;
    item.addEventListener("mouseenter", () => { focused = route.id; drawMap(); });
    item.addEventListener("mouseleave", () => { focused = null; drawMap(); });
  });
}

// ---------------------------------------------------------------- map
const map = L.map("map", { zoomControl: true, attributionControl: true }).setView([47.8, 13.05], 8);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);
const layer = L.layerGroup().addTo(map);

const dot = (at: LatLng, cls: string, text = ""): L.Marker =>
  L.marker([at.lat, at.lon], {
    icon: L.divIcon({ className: "", html: `<span class="pin ${cls}">${text}</span>`, iconSize: [26, 26], iconAnchor: [13, 13] }),
    keyboard: false,
  });

let lastFit = "";
function drawMap(): void {
  layer.clearLayers();
  const bounds: L.LatLngExpression[] = [];
  const add = (marker: L.Layer, at: LatLng): void => { marker.addTo(layer); bounds.push([at.lat, at.lon]); };

  const planning = plan.route || plan.to || plan.start || plan.stops.length;
  if (planning) {
    caption.textContent = TEXT.mapPlan;
    if (plan.route) {
      const line = plan.route.shape.map((p) => [p.lat, p.lon] as [number, number]);
      L.polyline(line, { className: "map-route-casing", weight: 9 }).addTo(layer);
      L.polyline(line, { className: "map-route", weight: 5 }).addTo(layer);
      line.forEach((p) => bounds.push(p));
    }
    for (const hit of plan.chargers.list ?? []) {
      add(dot(hit.charger.at, "charger", "⚡").bindTooltip(hit.charger.name || "Ladestation"), hit.charger.at);
    }
    const start = plan.start?.at ?? (plan.route ? plan.route.shape[0] : null) ?? position;
    if (start) add(dot(start, "start").bindTooltip(plan.start?.label ?? TEXT.here), start);
    plan.stops.forEach((stop, i) => add(dot(stop.at, "stop", String(i + 1)).bindTooltip(stop.label), stop.at));
    if (plan.to) add(dot(plan.to.at, "end", "◼").bindTooltip(plan.to.label), plan.to.at);
  } else {
    const shown = focused ? data.routes.filter((r) => r.id === focused) : data.routes;
    caption.textContent = TEXT.mapSaved(data.routes.length);
    shown.forEach((route: SavedRoute) => {
      if (route.line) {
        const line = decodePolyline(route.line, 5).map((p) => [p.lat, p.lon] as [number, number]);
        L.polyline(line, { className: focused ? "map-route" : "map-route saved", weight: focused ? 5 : 3 }).bindTooltip(route.name).addTo(layer);
        line.forEach((p) => bounds.push(p));
      }
      if (route.start) add(dot(route.start.at, "start").bindTooltip(route.start.label), route.start.at);
      route.stops.forEach((stop, i) => add(dot(stop.at, "stop", String(i + 1)).bindTooltip(stop.label), stop.at));
      add(dot(route.to.at, "end", "◼").bindTooltip(`${route.name}: ${route.to.label}`), route.to.at);
    });
    if (!shown.length && position) add(dot(position, "start").bindTooltip(TEXT.here), position);
  }

  // The view moves only when what is shown changed, not on every redraw.
  const key = JSON.stringify(bounds.length ? [bounds[0], bounds[bounds.length - 1], bounds.length] : null);
  if (key !== lastFit && bounds.length) {
    lastFit = key;
    if (bounds.length === 1) map.setView(bounds[0] as L.LatLngExpression, 13, { animate: true });
    else map.flyToBounds(L.latLngBounds(bounds as L.LatLngTuple[]), { padding: [36, 36], maxZoom: 15, duration: 0.6 });
  }
}

render();
setTimeout(() => map.invalidateSize(), 0);
if (store) void sync(false);
else showSync(TEXT.error.offline, "error");
