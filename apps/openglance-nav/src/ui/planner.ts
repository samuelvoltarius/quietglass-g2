import { formatDistance, formatDuration, projectOntoPath, cumulativeMeters, distanceMeters, type LatLng } from "../geo/geometry";
import { MAX_STOPS, type Route, type TravelMode } from "../routing/provider";
import type { FoundPlace } from "../geocode/photon";
import { googleMapsDirUrl } from "../geocode/gmaps";
import type { RoutePoint, SavedRoute } from "../trip/saved";
import { powerText, priceText, socketsText, speedOf, type ChargerError, type RouteCharger } from "../chargers/chargers";
import { escapeHtml, tr, type Locale } from "../i18n";
import { messages } from "../messages";

/**
 * The phone's route planner: start (a place, or wherever one is when the
 * route is started), up to three stops, destination, way of travel; a preview
 * with distance, time and a line drawn from the route itself (no map tiles,
 * no further servers); charging stations along it; saving under a name; the
 * list of saved routes.
 */

export interface PlanState {
  /** Null: from the position at the moment the route is started. */
  readonly start: RoutePoint | null;
  readonly stops: readonly RoutePoint[];
  readonly to: RoutePoint | null;
  readonly mode: TravelMode;
  readonly busy: boolean;
  readonly route: Pick<Route, "shape" | "distance" | "duration"> | null;
  readonly errorKey: string | null;
  readonly search: { readonly busy: boolean; readonly results: readonly FoundPlace[]; readonly errorKey: string | null };
  readonly chargers: { readonly busy: boolean; readonly list: readonly RouteCharger[] | null; readonly errorKey: string | null; readonly waitS?: number };
  /** Id of the saved route whose name is being edited. */
  readonly renaming: string | null;
}

export function emptyPlan(mode: TravelMode): PlanState {
  return {
    start: null, stops: [], to: null, mode, busy: false, route: null, errorKey: null,
    search: { busy: false, results: [], errorKey: null },
    chargers: { busy: false, list: null, errorKey: null },
    renaming: null,
  };
}

/** A plan loaded from a saved route, for editing. */
export function planOf(route: SavedRoute): PlanState {
  return { ...emptyPlan(route.mode), start: route.start, stops: route.stops, to: route.to };
}

/** Any change to the points makes the preview and the stations stale. */
export function withPoints(plan: PlanState, points: Partial<Pick<PlanState, "start" | "stops" | "to">>): PlanState {
  return { ...plan, ...points, route: null, errorKey: null, chargers: { busy: false, list: null, errorKey: null } };
}

/**
 * Puts a stop where it belongs on the way: after the stops (and the start)
 * that come before it along the route line, so a charger picked "after 42 km"
 * is visited in that order. Without a line it goes last. Null when the plan
 * already has MAX_STOPS stops.
 */
export function insertStop(stops: readonly RoutePoint[], stop: RoutePoint, line: readonly LatLng[] | null): RoutePoint[] | null {
  if (stops.length >= MAX_STOPS) return null;
  if (!line || line.length < 2) return [...stops, stop];
  const along = cumulativeMeters(line);
  const at = (p: LatLng): number => {
    const projection = projectOntoPath(p, line);
    if (!projection) return Number.POSITIVE_INFINITY;
    return (along[projection.index] ?? 0) + distanceMeters(line[projection.index]!, projection.point);
  };
  const where = at(stop.at);
  const index = stops.findIndex((existing) => at(existing.at) > where);
  return index < 0 ? [...stops, stop] : [...stops.slice(0, index), stop, ...stops.slice(index)];
}

/**
 * The route as a line drawing (SVG), north up, scaled to fit: start as a ring,
 * stops numbered, the destination a square, charging stations as small
 * diamonds. Drawn from the route's own points only.
 */
export function routeSvg(
  shape: readonly LatLng[],
  marks: { readonly start: LatLng | null; readonly stops: readonly LatLng[]; readonly to: LatLng | null; readonly chargers?: readonly LatLng[] },
  width = 320,
  height = 200,
): string {
  const all = [...shape, ...(marks.start ? [marks.start] : []), ...marks.stops, ...(marks.to ? [marks.to] : []), ...(marks.chargers ?? [])];
  if (all.length === 0) return "";
  const pad = 14;
  let south = Infinity, north = -Infinity, west = Infinity, east = -Infinity;
  for (const p of all) { south = Math.min(south, p.lat); north = Math.max(north, p.lat); west = Math.min(west, p.lon); east = Math.max(east, p.lon); }
  const kx = Math.cos(((south + north) / 2) * Math.PI / 180);
  const spanX = Math.max((east - west) * kx, 1e-6);
  const spanY = Math.max(north - south, 1e-6);
  const scale = Math.min((width - 2 * pad) / spanX, (height - 2 * pad) / spanY);
  const offX = (width - spanX * scale) / 2;
  const offY = (height - spanY * scale) / 2;
  const xy = (p: LatLng): [number, number] => [
    Math.round((offX + (p.lon - west) * kx * scale) * 10) / 10,
    Math.round((offY + (north - p.lat) * scale) * 10) / 10,
  ];
  const step = Math.max(1, Math.ceil(shape.length / 400));
  const points = shape.filter((_, i) => i % step === 0 || i === shape.length - 1).map((p) => xy(p).join(",")).join(" ");
  const parts: string[] = [];
  parts.push(`<svg class="route-svg" viewBox="0 0 ${width} ${height}" role="img" xmlns="http://www.w3.org/2000/svg">`);
  if (points) parts.push(`<polyline class="route-line" points="${points}" />`);
  for (const c of marks.chargers ?? []) {
    const [x, y] = xy(c);
    parts.push(`<rect class="route-charger" x="${x - 4}" y="${y - 4}" width="8" height="8" transform="rotate(45 ${x} ${y})" />`);
  }
  if (marks.start) { const [x, y] = xy(marks.start); parts.push(`<circle class="route-start" cx="${x}" cy="${y}" r="6" />`); }
  marks.stops.forEach((stop, i) => {
    const [x, y] = xy(stop);
    parts.push(`<circle class="route-stop" cx="${x}" cy="${y}" r="8" /><text class="route-stop-n" x="${x}" y="${y + 4}" text-anchor="middle">${i + 1}</text>`);
  });
  if (marks.to) { const [x, y] = xy(marks.to); parts.push(`<rect class="route-end" x="${x - 6}" y="${y - 6}" width="12" height="12" />`); }
  parts.push("</svg>");
  return parts.join("");
}

export function chargerErrorKey(error: ChargerError | null): string | null {
  if (!error) return null;
  if (error === "invalid" || error === "oversized") return "r.err.server";
  return "r.err." + error;
}

/** The planner card and the saved-routes card. */
export function plannerTemplate(
  plan: PlanState,
  routes: readonly SavedRoute[],
  locale: Locale,
  options: { readonly canSearch: boolean; readonly canRoute: boolean; readonly chargers: boolean },
): string {
  const t = (key: string, vars: Record<string, string | number> = {}): string => escapeHtml(tr(messages, locale, key, vars));
  const modes: readonly { mode: TravelMode; icon: string; key: string }[] = [
    { mode: "driving", icon: "🚗", key: "p.driving" },
    { mode: "cycling", icon: "🚲", key: "p.cycling" },
    { mode: "walking", icon: "🚶", key: "p.walking" },
  ];
  const pointRow = (label: string, text: string, removeAttr: string): string => `
      <li><span><small>${label}</small><br />${text}</span>${removeAttr ? `<button type="button" class="remove" ${removeAttr}>${t("p.remove")}</button>` : ""}</li>`;
  const route = plan.route;
  const chargers = plan.chargers;
  const svg = route
    ? routeSvg(route.shape, {
      start: plan.start?.at ?? route.shape[0] ?? null,
      stops: plan.stops.map((s) => s.at),
      to: plan.to?.at ?? null,
      chargers: (chargers.list ?? []).map((c) => c.charger.at),
    })
    : "";
  const full = plan.stops.length >= MAX_STOPS;

  return `
  <section class="card" id="planner">
    <h2>${t("r.title")}</h2>
    <p class="hint">${t("r.intro")}</p>
    <ul class="scripts plan">
      ${pointRow(t("r.start"), plan.start ? escapeHtml(plan.start.label) : t("r.here"), plan.start ? 'data-plan-remove="start"' : "")}
      ${plan.stops.map((stop, i) => pointRow(t("r.stop", { n: i + 1 }), escapeHtml(stop.label), `data-plan-remove="stop" data-index="${i}"`)).join("")}
      ${pointRow(t("r.to"), plan.to ? escapeHtml(plan.to.label) : `<small>${t("r.noTo")}</small>`, plan.to ? 'data-plan-remove="to"' : "")}
    </ul>
    ${options.canSearch ? `
    <label for="plan-query">${t("r.searchLabel")}</label>
    <input id="plan-query" type="search" enterkeyhint="search" autocomplete="off" placeholder="${t("p.searchPlaceholder")}" />
    <button id="plan-search" type="button"${plan.search.busy ? " disabled" : ""}>${plan.search.busy ? t("p.searching") : t("p.search")}</button>
    <p class="hint">${t("p.searchMapsHint")}</p>
    ${plan.search.errorKey ? `<p class="hint error">${t(plan.search.errorKey)}</p>` : ""}
    ${plan.search.results.length ? `<ul class="scripts results">
      ${plan.search.results.map((place, index) => `
        <li>
          <span>${escapeHtml(place.label)}<br /><small>${escapeHtml(place.detail)}</small></span>
          <span class="actions">
            <button type="button" class="pick" data-plan-as="start" data-index="${index}">${t("r.asStart")}</button>
            <button type="button" class="pick" data-plan-as="stop" data-index="${index}"${full ? " disabled" : ""}>${t("r.asStop")}</button>
            <button type="button" class="pick" data-plan-as="to" data-index="${index}">${t("r.asTo")}</button>
          </span>
        </li>`).join("")}
    </ul>` : ""}` : ""}
    ${plan.start ? `<button id="plan-here" type="button" class="secondary">${t("r.useHere")}</button>` : ""}

    <div class="choices plan-modes">
      ${modes.map(({ mode, icon, key }) => `
        <label class="choice">
          <input type="radio" name="plan-mode" value="${mode}"${mode === plan.mode ? " checked" : ""} />
          <span class="icon" aria-hidden="true">${icon}</span>
          <span>${t(key)}</span>
        </label>`).join("")}
    </div>

    ${options.canRoute ? `<button id="plan-route" type="button"${plan.busy || !plan.to ? " disabled" : ""}>${plan.busy ? t("r.calculating") : t("r.calculate")}</button>` : ""}
    ${plan.errorKey ? `<p class="hint error">${t(plan.errorKey)}</p>` : ""}
    ${plan.to ? `<p><a class="gmaps" id="plan-google" href="${escapeHtml(googleUrlOf(plan.start, plan.stops, plan.to, plan.mode))}" target="_blank" rel="noopener noreferrer">${t("p.openGoogle")}</a></p>` : ""}

    ${route ? `
    <div class="preview">
      <p class="summary"><strong>${escapeHtml(tr(messages, locale, "r.summary", { distance: formatDistance(route.distance, locale), duration: formatDuration(route.duration) }))}</strong></p>
      ${svg}
    </div>
    ${options.chargers ? `
    <button id="plan-chargers" type="button" class="secondary"${chargers.busy ? " disabled" : ""}>${chargers.busy ? t("r.chargersLoading") : t("r.chargersAlong")}</button>
    ${chargers.errorKey ? `<p class="hint error">${t(chargers.errorKey, { s: chargers.waitS ?? 30 })}</p>` : ""}
    ${chargers.list && chargers.list.length === 0 ? `<p class="hint">${t("r.chargersNone")}</p>` : ""}
    ${chargers.list && chargers.list.length ? `<ul class="scripts chargers">
      ${chargers.list.slice(0, 25).map((c, index) => {
        const power = powerText(c.charger);
        const sockets = socketsText(c.charger, locale);
        const price = priceText(c.charger, locale);
        const fast = speedOf(c.charger) === "fast";
        return `
        <li>
          <span>${fast ? "⚡ " : ""}${escapeHtml(c.charger.name || tr(messages, locale, "c.noName"))}<br />
            <small>${t("r.chargerAt", { d: formatDistance(c.along, locale) })}${power ? " · " + escapeHtml(power) : ""}${price ? " · " + escapeHtml(price) : ""}${sockets ? " · " + escapeHtml(sockets) : ""}${c.charger.capacity ? " · " + t("c.places", { n: c.charger.capacity }) : ""} · ${c.off < 50 ? t("r.chargerOnRoute") : t("r.chargerOff", { d: formatDistance(c.off, locale) })}</small></span>
          <button type="button" class="pick" data-charger="${index}"${full ? " disabled" : ""}>${t("r.addStop")}</button>
        </li>`;
      }).join("")}
    </ul>` : ""}` : ""}
    <label for="plan-name">${t("r.name")}</label>
    <input id="plan-name" type="text" placeholder="${t("r.namePlaceholder")}" />
    <button id="plan-save" type="button">${t("r.save")}</button>` : ""}
  </section>

  <section class="card" id="saved-routes">
    <h2>${t("r.list")}</h2>
    ${routes.length === 0 ? `<p class="hint">${t("r.none")}</p>` : `<ul class="scripts">
      ${routes.map((r) => `
        <li>
          ${plan.renaming === r.id
            ? `<span class="grow"><input id="rename" type="text" value="${escapeHtml(r.name)}" /></span>
          <button type="button" class="pick" data-route-rename-ok="${escapeHtml(r.id)}">${t("r.renameOk")}</button>`
            : `<span>${escapeHtml(r.name)}<br /><small>${escapeHtml(routeLine(r, locale))}</small></span>
          <span class="actions">
            <a class="gmaps button-link" href="${escapeHtml(googleUrlOf(r.start, r.stops, r.to, r.mode))}" target="_blank" rel="noopener noreferrer">Google Maps</a>
            <button type="button" class="remove" data-route-edit="${escapeHtml(r.id)}">${t("r.edit")}</button>
            <button type="button" class="remove" data-route-rename="${escapeHtml(r.id)}">${t("r.rename")}</button>
            <button type="button" class="remove" data-route-delete="${escapeHtml(r.id)}">${t("r.delete")}</button>
          </span>`}
        </li>`).join("")}
    </ul>`}
  </section>`;
}

/** The Google Maps link of a plan or saved route: no start = from where the phone is. */
export function googleUrlOf(start: RoutePoint | null, stops: readonly RoutePoint[], to: RoutePoint, mode: TravelMode): string {
  return googleMapsDirUrl({ origin: start?.at ?? null, destination: to.at, waypoints: stops.map((s) => s.at), mode });
}

/** "Mein Standort → Stopp → Ziel · 45 km · 38 min · Auto" */
export function routeLine(route: SavedRoute, locale: Locale): string {
  const t = (key: string, vars: Record<string, string | number> = {}): string => tr(messages, locale, key, vars);
  const names = [route.start?.label ?? t("r.here"), ...route.stops.map((s) => s.label), route.to.label];
  const mode = t(route.mode === "driving" ? "p.driving" : route.mode === "cycling" ? "p.cycling" : "p.walking");
  const facts = [route.distance ? formatDistance(route.distance, locale) : "", route.duration ? formatDuration(route.duration) : "", mode].filter(Boolean);
  return `${names.join(" → ")} · ${facts.join(" · ")}`;
}
