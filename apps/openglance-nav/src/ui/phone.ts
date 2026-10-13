import {
  addPlace, destinationOf, nextPlaceId, parseCoordinates, removePlace,
  usesMockRouter, validateRouterUrl, type NavData,
} from "../storage/persist";
import type { LatLng } from "../geo/geometry";
import { DEFAULT_ROUTER_URL, type RouteOutcome, type TravelMode } from "../routing/provider";
import { addRoute, makeSavedRoute, removeRoute, renameRoute, type RoutePoint } from "../trip/saved";
import { chargersAlong, type ChargerOutcome } from "../chargers/chargers";
import { chargerErrorKey, emptyPlan, insertStop, planOf, plannerTemplate, withPoints, type PlanState } from "./planner";
import { DEFAULT_GEOCODER_URL, type FoundPlace, type SearchOutcome } from "../geocode/photon";
import type { GlassLayout } from "../glasses/view";
import { escapeHtml, languageSelect, tr, type Locale } from "../i18n";
import { messages } from "../messages";

/**
 * The phone companion, written for someone who has never set up navigation
 * before: search a place, pick how you travel, tap the glasses. Server
 * addresses, the demo route and the coordinate field sit under "Advanced".
 */

export interface PhoneUiPorts {
  readonly getData: () => NavData;
  readonly setData: (data: NavData) => Promise<void>;
  readonly getPosition: () => LatLng | null;
  readonly getLocale?: () => Locale;
  readonly setLocale?: (locale: Locale) => void;
  /** Called from the tap on "Activate voice": browsers only play audio after a gesture. */
  readonly onVoiceActivate?: () => void;
  /** "needs-tap" | "server" | "browser" | "off" - which voice spoke last or is waiting. */
  readonly getVoiceState?: () => "needs-tap" | "server" | "browser" | "off";
  /** Place search; absent means the search box is not offered. */
  readonly search?: (query: string) => Promise<SearchOutcome>;
  /** Routes through the points in order (start, stops, destination); absent means no planner preview. */
  readonly planRoute?: (points: readonly LatLng[], mode: TravelMode) => Promise<RouteOutcome>;
  /** Charging stations along a route line. */
  readonly chargersAlong?: (line: readonly LatLng[]) => Promise<ChargerOutcome>;
}

const MODES: readonly { mode: TravelMode; icon: string; key: string }[] = [
  { mode: "walking", icon: "🚶", key: "p.walking" },
  { mode: "cycling", icon: "🚲", key: "p.cycling" },
  { mode: "driving", icon: "🚗", key: "p.driving" },
];

const VIEWS: readonly { view: GlassLayout; key: string }[] = [
  { view: "turns", key: "p.viewTurns" },
  { view: "overview", key: "p.viewOverview" },
];

/** Text inputs whose unsaved contents are carried across a redraw. */
const DRAFT_FIELDS = ["url", "geocoder", "label", "coords", "query", "plan-query", "plan-name", "rename"] as const;

interface SearchState {
  readonly busy: boolean;
  readonly results: readonly FoundPlace[];
  readonly errorKey: string | null;
}

export function mountPhoneUi(ports: PhoneUiPorts): void {
  const root = document.getElementById("app");
  if (!root) return;

  let notice = "";
  let search: SearchState = { busy: false, results: [], errorKey: null };
  let plan: PlanState = emptyPlan(ports.getData().mode);
  const locale = (): Locale => ports.getLocale?.() ?? "en";

  const render = (): void => {
    const data = ports.getData();
    // Whatever is half typed survives a redraw caused by another control.
    const typed = DRAFT_FIELDS.map((id) => root.querySelector<HTMLInputElement>("#" + id)?.value);
    root.innerHTML = template(data, notice, ports.getPosition(), locale(), search, Boolean(ports.search), ports.getVoiceState?.() ?? null)
      .replace("<!--planner-->", plannerTemplate(plan, data.routes, locale(), { canSearch: Boolean(ports.search), canRoute: Boolean(ports.planRoute), chargers: data.chargers && Boolean(ports.chargersAlong) }));
    DRAFT_FIELDS.forEach((id, index) => {
      const field = root.querySelector<HTMLInputElement>("#" + id);
      const value = typed[index];
      if (field && value !== undefined) field.value = value;
    });
    notice = "";
    wire(root, ports, data, locale(), {
      notify: (message) => { notice = message; render(); },
      rerender: render,
      setSearch: (next) => { search = next; render(); },
      getSearch: () => search,
      setPlan: (next) => { plan = next; render(); },
      getPlan: () => plan,
    });
  };
  render();
}

function template(
  data: NavData,
  notice: string,
  position: LatLng | null,
  locale: Locale,
  search: SearchState,
  canSearch: boolean,
  voice: "needs-tap" | "server" | "browser" | "off" | null,
): string {
  const t = (key: string, vars: Record<string, string | number> = {}): string => tr(messages, locale, key, vars);
  const destination = destinationOf(data);
  const routerHost = hostOf(data.valhallaUrl);
  const routerName = routerHost ? t("p.ownServer", { host: routerHost }) : "FOSSGIS e.V. · Valhalla";
  const searchHost = hostOf(data.geocoderUrl);
  const searchName = searchHost ? t("p.ownServer", { host: searchHost }) : "Photon by komoot";

  return `
  <header class="brand">
    <span class="brand-mark">Quietglass</span>
    <h1>OpenGlance</h1>
  </header>

  ${notice ? '<p class="notice">' + escapeHtml(notice) + "</p>" : ""}

  ${usesMockRouter(data) ? `<p class="notice warn">${escapeHtml(t("p.demoActive"))}</p>` : ""}

  ${destination
    ? `<section class="card ready"><p>${escapeHtml(t("p.ready", { place: destination.label }))}</p></section>`
    : `<section class="card">
    <h2>${t("p.howTitle")}</h2>
    <ol class="steps">
      <li>${escapeHtml(t("p.how1"))}</li>
      <li>${escapeHtml(t("p.how2"))}</li>
      <li>${escapeHtml(t("p.how3"))}</li>
    </ol>
  </section>`}

  <section class="card">
    <h2>${t("p.destination")}</h2>
    ${canSearch ? `
    <label for="query">${t("p.searchLabel")}</label>
    <input id="query" type="search" enterkeyhint="search" autocomplete="off" placeholder="${escapeHtml(t("p.searchPlaceholder"))}" />
    <button id="search" type="button"${search.busy ? " disabled" : ""}>${search.busy ? t("p.searching") : t("p.search")}</button>
    ${search.errorKey ? '<p class="hint error">' + escapeHtml(t(search.errorKey)) + "</p>" : ""}
    ${search.results.length ? `<ul class="scripts results">
      ${search.results.map((place, index) => `
        <li>
          <span>${escapeHtml(place.label)}<br /><small>${escapeHtml(place.detail)}</small></span>
          <button type="button" class="pick" data-index="${index}">${t("p.useResult")}</button>
        </li>`).join("")}
    </ul>` : ""}` : ""}

    <h3>${t("p.saved")}</h3>
    <p class="hint">${destination
      ? escapeHtml(t("p.selected", { place: destination.label }))
      : escapeHtml(data.places.length ? t("p.noneSelected") : t("p.noPlaces"))}</p>
    <ul class="scripts">
      ${data.places.map((place) => `
        <li>
          <label>
            <input type="radio" name="dest" value="${escapeHtml(place.id)}"
              ${place.id === data.destinationId ? "checked" : ""} />
            <span>${escapeHtml(place.label)}<br />
              <small>${place.at.lat.toFixed(5)}, ${place.at.lon.toFixed(5)}</small></span>
          </label>
          <button type="button" class="remove" data-id="${escapeHtml(place.id)}">${t("p.remove")}</button>
        </li>`).join("")}
    </ul>
    ${position ? `<button id="here" type="button" class="secondary">${t("p.saveHere")}</button>` : ""}

    <details>
      <summary>${t("p.coordsTitle")}</summary>
      <label for="label">${t("p.placeName")}</label>
      <input id="label" type="text" placeholder="${escapeHtml(t("p.placeNamePlaceholder"))}" />
      <label for="coords">${t("p.coords")}</label>
      <input id="coords" type="text" inputmode="decimal" placeholder="52.52000, 13.40500" />
      <button id="add" type="button">${t("p.addPlace")}</button>
    </details>
  </section>

  <!--planner-->

  <section class="card">
    <h2>${t("p.chargers")}</h2>
    <label class="check"><input id="chargers" type="checkbox"${data.chargers ? " checked" : ""} /> ${t("p.chargersOn")}</label>
    <p class="hint">${escapeHtml(t("p.chargersHint"))}</p>
  </section>

  <section class="card">
    <h2>${t("p.travel")}</h2>
    <div class="choices">
      ${MODES.map(({ mode, icon, key }) => `
        <label class="choice">
          <input type="radio" name="mode" value="${mode}"${mode === data.mode ? " checked" : ""} />
          <span class="icon" aria-hidden="true">${icon}</span>
          <span>${t(key)}</span>
        </label>`).join("")}
    </div>
    ${data.mode === "driving" ? `<p class="hint">${escapeHtml(t("p.drivingHint"))}</p>` : ""}
  </section>

  <section class="card">
    <h2>${t("p.glassView")}</h2>
    ${VIEWS.map(({ view, key }) => `
      <label class="check">
        <input type="radio" name="glass-view" value="${view}"${view === data.glassView ? " checked" : ""} />
        <span>${t(key)}</span>
      </label>`).join("")}
    <p class="hint">${escapeHtml(t("p.viewHint"))}</p>
  </section>

  ${voice === null ? "" : `<section class="card">
    <h2>${t("p.announce")}</h2>
    <label class="check"><input id="announce" type="checkbox"${data.announce ? " checked" : ""} /> ${t("p.announce")}</label>
    ${data.announce ? `<button id="voice-on" type="button">${t("p.announceOn")}</button>
    <p class="hint">${escapeHtml(t("p.announceState", { state: t(voice === "server" ? "p.voiceServer" : voice === "browser" ? "p.voiceBrowser" : voice === "needs-tap" ? "p.voiceNeedsTap" : "p.voiceOff") }))}</p>` : ""}
    <p class="hint">${escapeHtml(t("p.announceHint"))}</p>
  </section>`}

  <section class="card">
    <h2>${t("p.controls")}</h2>
    <table class="keys">
      <tr><td>${t("p.tap")}</td><td>${t("p.tapDoes")}</td></tr>
      <tr><td>${t("p.swipe")}</td><td>${t("p.swipeDoes")}</td></tr>
      <tr><td>${t("p.hold")}</td><td>${t("p.holdDoes")}</td></tr>
      <tr><td>${t("p.doubleTap")}</td><td>${t("p.doubleTapDoes")}</td></tr>
    </table>
  </section>

  <details class="card">
    <summary>${t("p.advanced")}</summary>
    <label for="url">${t("p.routerUrl")}</label>
    <input id="url" type="text" inputmode="url" value="${escapeHtml(data.valhallaUrl)}" placeholder="${DEFAULT_ROUTER_URL}" />
    <p class="hint">${escapeHtml(t("p.routerHint"))}</p>
    <label for="geocoder">${t("p.geocoderUrl")}</label>
    <input id="geocoder" type="text" inputmode="url" value="${escapeHtml(data.geocoderUrl)}" placeholder="${DEFAULT_GEOCODER_URL}" />
    <p class="hint">${escapeHtml(t("p.geocoderHint"))}</p>
    <button id="save-url" type="button">${t("p.saveServers")}</button>
    <label class="check"><input id="demo" type="checkbox"${data.demo ? " checked" : ""} /> ${t("p.demo")}</label>
    <label class="check"><input id="invert" type="checkbox"${data.invertScroll ? " checked" : ""} /> ${t("p.invertSwipe")}</label>
    <label class="check"><input id="streets" type="checkbox"${data.streets ? " checked" : ""} /> ${t("p.streets")}</label>
    <p class="hint">${escapeHtml(t("p.streetsHint"))}</p>
    ${languageSelect(locale)}
  </details>

  <footer class="hint">
    <p>${t("p.attribution")}</p>
    <p>${escapeHtml(t("p.routedBy", { provider: routerName }))} · ${escapeHtml(t("p.searchBy", { provider: searchName }))}</p>
    ${data.streets && !usesMockRouter(data) ? `<p>${escapeHtml(t("p.streetsBy"))}</p>` : ""}
    ${data.chargers ? `<p>${escapeHtml(t("p.chargersBy"))}</p>` : ""}
    <p>${escapeHtml(t("p.privacy"))}</p>
    <p>${escapeHtml(t("p.privacyRoutes"))}</p>
  </footer>`;
}

interface WireHooks {
  readonly notify: (message: string) => void;
  readonly rerender: () => void;
  readonly setSearch: (state: SearchState) => void;
  readonly getSearch: () => SearchState;
  readonly setPlan: (state: PlanState) => void;
  readonly getPlan: () => PlanState;
}

function wire(root: HTMLElement, ports: PhoneUiPorts, data: NavData, locale: Locale, hooks: WireHooks): void {
  const t = (key: string): string => tr(messages, locale, key);
  const byId = <T extends HTMLElement>(id: string): T | null => root.querySelector<T>("#" + id);
  // The page is redrawn from the stored data after every change. It used to
  // stay as first drawn, so the handlers kept the data from that moment: a
  // second place added replaced the first, and a new place never appeared.
  const commit = (next: NavData): void => {
    const saving = ports.setData(next);
    hooks.rerender();
    void saving.catch((thrown: unknown) => {
      hooks.notify(tr(messages, locale, "p.couldNotSave", { error: thrown instanceof Error ? thrown.message : String(thrown) }));
    });
  };

  byId<HTMLButtonElement>("save-url")?.addEventListener("click", () => {
    const url = byId<HTMLInputElement>("url")?.value.trim() ?? "";
    const geocoder = byId<HTMLInputElement>("geocoder")?.value.trim() ?? "";
    if (!validateRouterUrl(url).valid || !validateRouterUrl(geocoder).valid) { hooks.notify(t("p.urlInvalid")); return; }
    commit({ ...data, valhallaUrl: url, geocoderUrl: geocoder });
  });

  byId<HTMLInputElement>("demo")?.addEventListener("change", (event) => {
    commit({ ...data, demo: Boolean((event.target as HTMLInputElement).checked) });
  });

  byId<HTMLInputElement>("invert")?.addEventListener("change", (event) => {
    commit({ ...data, invertScroll: Boolean((event.target as HTMLInputElement).checked) });
  });

  byId<HTMLInputElement>("announce")?.addEventListener("change", (event) => {
    commit({ ...data, announce: Boolean((event.target as HTMLInputElement).checked) });
  });

  byId<HTMLButtonElement>("voice-on")?.addEventListener("click", () => {
    ports.onVoiceActivate?.();
    hooks.rerender();
  });

  byId<HTMLInputElement>("chargers")?.addEventListener("change", (event) => {
    commit({ ...data, chargers: Boolean((event.target as HTMLInputElement).checked) });
  });

  wirePlanner(root, ports, data, locale, hooks, commit);

  byId<HTMLInputElement>("streets")?.addEventListener("change", (event) => {
    commit({ ...data, streets: Boolean((event.target as HTMLInputElement).checked) });
  });

  byId<HTMLSelectElement>("language")?.addEventListener("change", (event) => {
    const next = (event.target as HTMLSelectElement).value;
    if (next === "de" || next === "en") { ports.setLocale?.(next); hooks.rerender(); }
  });

  root.querySelectorAll<HTMLInputElement>('input[name="mode"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      if (radio.checked) commit({ ...data, mode: radio.value as TravelMode });
    });
  });

  root.querySelectorAll<HTMLInputElement>('input[name="glass-view"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      if (radio.checked) commit({ ...data, glassView: radio.value === "overview" ? "overview" : "turns" });
    });
  });

  root.querySelectorAll<HTMLInputElement>('input[name="dest"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      if (radio.checked) commit({ ...data, destinationId: radio.value });
    });
  });

  root.querySelectorAll<HTMLButtonElement>(".remove").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset["id"];
      if (id) commit(removePlace(data, id));
    });
  });

  // Searching only on an explicit press: the public servers ask for fair use,
  // and a search on every keystroke would be dozens of requests per place.
  const runSearch = async (): Promise<void> => {
    if (!ports.search || hooks.getSearch().busy) return;
    const query = byId<HTMLInputElement>("query")?.value ?? "";
    hooks.setSearch({ busy: true, results: [], errorKey: null });
    const outcome = await ports.search(query).catch((): SearchOutcome => ({ places: [], error: "server" }));
    hooks.setSearch({ busy: false, results: outcome.places, errorKey: searchErrorKey(outcome.error) });
  };
  byId<HTMLButtonElement>("search")?.addEventListener("click", () => { void runSearch(); });
  byId<HTMLInputElement>("query")?.addEventListener("keydown", (event) => {
    if ((event as KeyboardEvent).key === "Enter") void runSearch();
  });

  root.querySelectorAll<HTMLButtonElement>(".pick").forEach((button) => {
    button.addEventListener("click", () => {
      const place = hooks.getSearch().results[Number(button.dataset["index"])];
      if (!place) return;
      const id = nextPlaceId(data);
      const query = byId<HTMLInputElement>("query");
      if (query) query.value = "";
      hooks.setSearch({ busy: false, results: [], errorKey: null });
      // Picking a result saves it and makes it the destination in one step.
      commit({ ...addPlace(data, { id, label: place.label, at: place.at }), destinationId: id });
    });
  });

  const addWith = (at: LatLng): void => {
    const label = byId<HTMLInputElement>("label")?.value.trim() ?? "";
    if (!label) { hooks.notify(t("p.nameNeeded")); return; }
    // Emptied before the redraw, so the next place starts from blank fields.
    for (const id of ["label", "coords"]) {
      const field = byId<HTMLInputElement>(id);
      if (field) field.value = "";
    }
    commit(addPlace(data, { id: nextPlaceId(data), label, at }));
  };

  byId<HTMLButtonElement>("add")?.addEventListener("click", () => {
    const text = byId<HTMLInputElement>("coords")?.value ?? "";
    const at = parseCoordinates(text);
    if (!at) { hooks.notify(t("p.coordsInvalid")); return; }
    addWith(at);
  });

  byId<HTMLButtonElement>("here")?.addEventListener("click", () => {
    const at = ports.getPosition();
    if (!at) { hooks.notify(t("p.noPosition")); return; }
    const label = byId<HTMLInputElement>("label");
    if (label && !label.value.trim()) label.value = locale === "de" ? "Hier" : "Here";
    addWith(at);
  });
}

/** The route planner and the saved routes: every control redraws from the plan state. */
function wirePlanner(
  root: HTMLElement,
  ports: PhoneUiPorts,
  data: NavData,
  locale: Locale,
  hooks: WireHooks,
  commit: (next: NavData) => void,
): void {
  const byId = <T extends HTMLElement>(id: string): T | null => root.querySelector<T>("#" + id);
  const plan = (): PlanState => hooks.getPlan();
  const set = (next: PlanState): void => hooks.setPlan(next);

  const runSearch = async (): Promise<void> => {
    if (!ports.search || plan().search.busy) return;
    const query = byId<HTMLInputElement>("plan-query")?.value ?? "";
    set({ ...plan(), search: { busy: true, results: [], errorKey: null } });
    const outcome = await ports.search(query).catch((): SearchOutcome => ({ places: [], error: "server" }));
    set({ ...plan(), search: { busy: false, results: outcome.places, errorKey: searchErrorKey(outcome.error) } });
  };
  byId<HTMLButtonElement>("plan-search")?.addEventListener("click", () => { void runSearch(); });
  byId<HTMLInputElement>("plan-query")?.addEventListener("keydown", (event) => {
    if ((event as KeyboardEvent).key === "Enter") void runSearch();
  });

  root.querySelectorAll<HTMLButtonElement>("[data-plan-as]").forEach((button) => {
    button.addEventListener("click", () => {
      const current = plan();
      const place = current.search.results[Number(button.dataset["index"])];
      if (!place) return;
      const point: RoutePoint = { label: place.label, at: place.at };
      const query = byId<HTMLInputElement>("plan-query");
      if (query) query.value = "";
      const cleared = { ...current, search: { busy: false, results: [], errorKey: null } };
      const role = button.dataset["planAs"];
      if (role === "start") set(withPoints(cleared, { start: point }));
      else if (role === "to") set(withPoints(cleared, { to: point }));
      else {
        const stops = insertStop(current.stops, point, null);
        if (!stops) { hooks.notify(tr(messages, locale, "r.full")); return; }
        set(withPoints(cleared, { stops }));
      }
    });
  });

  root.querySelectorAll<HTMLButtonElement>("[data-plan-remove]").forEach((button) => {
    button.addEventListener("click", () => {
      const current = plan();
      const what = button.dataset["planRemove"];
      if (what === "start") set(withPoints(current, { start: null }));
      else if (what === "to") set(withPoints(current, { to: null }));
      else set(withPoints(current, { stops: current.stops.filter((_, i) => i !== Number(button.dataset["index"])) }));
    });
  });

  byId<HTMLButtonElement>("plan-here")?.addEventListener("click", () => { set(withPoints(plan(), { start: null })); });

  root.querySelectorAll<HTMLInputElement>('input[name="plan-mode"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      if (radio.checked) set({ ...withPoints(plan(), {}), mode: radio.value as TravelMode });
    });
  });

  const calculate = async (): Promise<void> => {
    const current = plan();
    if (!ports.planRoute || current.busy) return;
    if (!current.to) { set({ ...current, errorKey: "r.needTo" }); return; }
    const from = current.start?.at ?? ports.getPosition();
    if (!from) { set({ ...current, errorKey: "r.noPosition" }); return; }
    set({ ...current, busy: true, errorKey: null });
    const outcome = await ports.planRoute([from, ...current.stops.map((stop) => stop.at), current.to.at], current.mode)
      .catch((): RouteOutcome => ({ route: null, error: "failed", code: "server" }));
    const after = plan();
    if (outcome.route) set({ ...after, busy: false, route: outcome.route, errorKey: null });
    else set({ ...after, busy: false, route: null, errorKey: routeErrorKey(outcome.code) });
  };
  byId<HTMLButtonElement>("plan-route")?.addEventListener("click", () => { void calculate(); });

  byId<HTMLButtonElement>("plan-chargers")?.addEventListener("click", () => {
    const current = plan();
    const line = current.route?.shape;
    if (!ports.chargersAlong || !line || current.chargers.busy) return;
    set({ ...current, chargers: { busy: true, list: null, errorKey: null } });
    void ports.chargersAlong(line)
      .catch((): ChargerOutcome => ({ chargers: [], error: "server" }))
      .then((outcome) => {
        const after = plan();
        if (after.route?.shape !== line) return;
        set({
          ...after,
          chargers: outcome.error
            ? { busy: false, list: null, errorKey: chargerErrorKey(outcome.error), ...(outcome.waitS !== undefined ? { waitS: outcome.waitS } : {}) }
            : { busy: false, list: chargersAlong(line, outcome.chargers), errorKey: null },
        });
      });
  });

  root.querySelectorAll<HTMLButtonElement>("[data-charger]").forEach((button) => {
    button.addEventListener("click", () => {
      const current = plan();
      const hit = current.chargers.list?.[Number(button.dataset["charger"])];
      if (!hit) return;
      const stop: RoutePoint = { label: hit.charger.name || tr(messages, locale, "c.noName"), at: hit.charger.at };
      const stops = insertStop(current.stops, stop, current.route?.shape ?? null);
      if (!stops) { hooks.notify(tr(messages, locale, "r.full")); return; }
      set(withPoints(current, { stops }));
      // The route through the new stop is calculated straight away.
      void calculate();
    });
  });

  byId<HTMLButtonElement>("plan-save")?.addEventListener("click", () => {
    const current = plan();
    if (!current.to) { hooks.notify(tr(messages, locale, "r.needTo")); return; }
    if (!current.route) { hooks.notify(tr(messages, locale, "r.needRoute")); return; }
    const nameField = byId<HTMLInputElement>("plan-name");
    const saved = makeSavedRoute(data.routes, {
      name: nameField?.value ?? "", mode: current.mode, start: current.start, stops: current.stops, to: current.to,
    }, current.route);
    if (nameField) nameField.value = "";
    hooks.setPlan(emptyPlan(current.mode));
    commit({ ...data, routes: addRoute(data.routes, saved) });
    hooks.notify(tr(messages, locale, "r.saved", { name: saved.name }));
  });

  root.querySelectorAll<HTMLButtonElement>("[data-route-edit]").forEach((button) => {
    button.addEventListener("click", () => {
      const route = data.routes.find((r) => r.id === button.dataset["routeEdit"]);
      if (route) set(planOf(route));
    });
  });
  root.querySelectorAll<HTMLButtonElement>("[data-route-rename]").forEach((button) => {
    button.addEventListener("click", () => { set({ ...plan(), renaming: button.dataset["routeRename"] ?? null }); });
  });
  root.querySelectorAll<HTMLButtonElement>("[data-route-rename-ok]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset["routeRenameOk"] ?? "";
      const field = byId<HTMLInputElement>("rename");
      const name = field?.value ?? "";
      if (field) field.value = "";
      hooks.setPlan({ ...plan(), renaming: null });
      commit({ ...data, routes: renameRoute(data.routes, id, name) });
    });
  });
  root.querySelectorAll<HTMLButtonElement>("[data-route-delete]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset["routeDelete"] ?? "";
      commit({ ...data, routes: removeRoute(data.routes, id), destinationId: data.destinationId === id ? null : data.destinationId });
    });
  });
}

/** A route that could not be had, as the sentence under the button. */
export function routeErrorKey(code: RouteOutcome["code"]): string {
  switch (code) {
    case "offline": return "err.routeUnreachable";
    case "timeout": return "err.routeTimeout";
    case "busy": return "err.busy";
    case "noRoute": return "err.noRoute";
    case "tooFar": return "err.tooFar";
    default: return "err.server";
  }
}

/** Maps a search failure to the sentence shown under the search box. */
export function searchErrorKey(error: SearchOutcome["error"]): string | null {
  switch (error) {
    case null: return null;
    case "short": return "err.searchShort";
    case "empty": return "err.searchEmpty";
    case "offline": return "err.offline";
    case "timeout": return "err.timeout";
    case "busy": return "err.busy";
    default: return "err.server";
  }
}

function hostOf(url: string): string {
  if (!url.trim()) return "";
  try { return new URL(url.trim()).host; } catch { return url.trim(); }
}
