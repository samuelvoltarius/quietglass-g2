import {
  addPlace, destinationOf, nextPlaceId, parseCoordinates, removePlace,
  usesMockRouter, validateRouterUrl, type NavData,
} from "../storage/persist";
import type { LatLng } from "../geo/geometry";
import { DEFAULT_ROUTER_URL, type TravelMode } from "../routing/provider";
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
  /** Place search; absent means the search box is not offered. */
  readonly search?: (query: string) => Promise<SearchOutcome>;
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
const DRAFT_FIELDS = ["url", "geocoder", "label", "coords", "query"] as const;

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
  const locale = (): Locale => ports.getLocale?.() ?? "en";

  const render = (): void => {
    const data = ports.getData();
    // Whatever is half typed survives a redraw caused by another control.
    const typed = DRAFT_FIELDS.map((id) => root.querySelector<HTMLInputElement>("#" + id)?.value);
    root.innerHTML = template(data, notice, ports.getPosition(), locale(), search, Boolean(ports.search));
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
    ${languageSelect(locale)}
  </details>

  <footer class="hint">
    <p>${t("p.attribution")}</p>
    <p>${escapeHtml(t("p.routedBy", { provider: routerName }))} · ${escapeHtml(t("p.searchBy", { provider: searchName }))}</p>
    <p>${escapeHtml(t("p.privacy"))}</p>
  </footer>`;
}

interface WireHooks {
  readonly notify: (message: string) => void;
  readonly rerender: () => void;
  readonly setSearch: (state: SearchState) => void;
  readonly getSearch: () => SearchState;
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
