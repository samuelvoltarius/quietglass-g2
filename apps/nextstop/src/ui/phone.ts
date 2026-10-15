import type { Stop } from "../transit/types";
import type { Position } from "../ride/tracker";
import { DEFAULT_SETTINGS, validateUrl, type Settings } from "../storage/persist";
import { nextStep } from "../text";
import { languageSelect, type Locale } from "../i18n";
import { t } from "../messages";
import type { GeoResult } from "../route/geocode";
import { addFavorite, MAX_FAVORITES, moveFavorite, removeFavorite, renameFavorite, setNow, type Places } from "../route/places";
import { favoritesHtml, fullText, nowHtml, resultsHtml } from "./places-ui";

/**
 * The phone side: which service to ask, and where it lives.
 *
 * Everything that matters happens on the glasses, so this stays a settings
 * page. It does carry one thing the glasses cannot: an explanation of why
 * there are two backends at all, because a user who picks the wrong one for
 * their country simply sees an empty screen and no reason for it.
 */

export interface PhoneUiPorts {
  getSettings(): Settings;
  setSettings(next: Settings): Promise<void>;
  getPosition(): Position | null;
  /** True while the position came from the ?at= parameter rather than GPS. */
  isSeeded(): boolean;
  getStops(): readonly Stop[];
  refresh(): void;
  /** The language of the phone page and the glasses; English when absent. */
  getLocale?(): Locale;
  /** Called when the language is changed on this page; must redraw the glasses. */
  setLocale?(locale: Locale): void;
  /** Destinations; the whole "Ziele" section is left out when a port is missing. */
  getPlaces?(): Places;
  setPlaces?(next: Places): Promise<void>;
  /** Looks a place up by name; rejects when the service cannot be reached. */
  searchPlaces?(text: string): Promise<readonly GeoResult[]>;
  /** From the tap on "Activate voice": browsers only play audio after a gesture. */
  onVoiceActivate?(): void;
  /** Which voice is in use; the voice card is left out when absent. */
  getVoiceState?(): "needs-tap" | "server" | "browser" | "off";
  /** True in demo mode: the destinations are examples and nothing is saved. */
  isDemo?(): boolean;
}

/** The page is split into tabs instead of one long column. */
const TAB_KEY = "quietglass.nextstop.tab";

function readTab(ids: readonly string[]): string {
  try { const v = localStorage.getItem(TAB_KEY); return ids.includes(v ?? "") ? v! : "stops"; } catch { return "stops"; }
}

/** Shows only the active tab; the choice survives redraws and restarts. */
function applyTab(root: HTMLElement, active: string): void {
  root.querySelectorAll<HTMLElement>("[data-tab]").forEach((el) => { el.hidden = el.dataset["tab"] !== active; });
  root.querySelectorAll<HTMLButtonElement>("[data-tab-go]").forEach((button) => {
    const on = button.dataset["tabGo"] === active;
    button.classList.toggle("on", on);
    button.setAttribute("aria-selected", String(on));
  });
}

export function mountPhoneUi(ports: PhoneUiPorts): void {
  const root = document.getElementById("app");
  if (!root) return;

  const locale = (): Locale => ports.getLocale?.() ?? "en";

  // Search state outlives a rebuild of the page (a language switch, say).
  let query = "";
  let results: readonly GeoResult[] = [];
  let searchNote = "";
  let tab = "";

  const statusText = (): string => {
    const lang = locale();
    const position = ports.getPosition();
    const stops = ports.getStops();
    const where = !position
      ? t(lang, "p.noPosition")
      : ports.isSeeded()
        ? t(lang, "p.seeded")
        : typeof position.accuracy === "number"
          ? t(lang, "p.positionFoundAccuracy", { metres: Math.round(position.accuracy) })
          : t(lang, "p.positionFound");
    const found = stops.length === 0
      ? t(lang, "p.noStopsYet")
      : t(lang, "p.nearestStop", { count: stops.length, stop: stops[0]?.name ?? "?" });
    return `${where} ${found}`;
  };

  /** Only the status lines are live; they are updated in place. */
  const updateStatus = (): void => {
    const status = root.querySelector<HTMLElement>("#status");
    if (status) status.textContent = statusText();
    const next = root.querySelector<HTMLElement>("#next");
    if (next) next.textContent = nextStep(ports.getPosition() !== null, ports.getStops().length, locale());
    const voiceState = root.querySelector<HTMLElement>("#voice-state");
    const voice = ports.getVoiceState?.();
    if (voiceState && voice) {
      voiceState.textContent = t(locale(), voice === "server" ? "p.voiceServer" : voice === "browser" ? "p.voiceBrowser" : voice === "needs-tap" ? "p.voiceNeedsTap" : "p.voiceOff");
    }
  };

  const placesCard = (lang: Locale): string => `
      <div class="card" id="places-card">
        <h2>${t(lang, "p.goals")}</h2>
        <p class="hint">${t(lang, "p.goalsHint")}</p>
        ${ports.isDemo?.() ? `<p class="hint demo">${t(lang, "p.demo")}</p>` : ""}
        <label for="place-q">${t(lang, "p.searchLabel")}</label>
        <div class="search-row">
          <input id="place-q" type="text" enterkeyhint="search" autocomplete="off" spellcheck="false" />
          <button id="place-go" type="button">${t(lang, "p.search")}</button>
        </div>
        <p class="hint" id="place-note"></p>
        <ul class="places" id="place-results"></ul>
        <label>${t(lang, "p.favoritesTitle")}</label>
        <ul class="places" id="place-favs"></ul>
        <label>${t(lang, "p.nowTitle")}</label>
        <p class="now-line" id="place-now"></p>
        <p class="hint">${t(lang, "p.placesPrivacy")}</p>
      </div>`;

  /**
   * Wires the destination section. Only the lists are redrawn on a change, never
   * the search field, so a name half typed is not lost when a favourite is saved.
   */
  const bindPlaces = (lang: Locale): void => {
    if (!ports.getPlaces || !ports.setPlaces || !ports.searchPlaces) return;
    const card = root.querySelector<HTMLElement>("#places-card");
    const input = root.querySelector<HTMLInputElement>("#place-q");
    const go = root.querySelector<HTMLButtonElement>("#place-go");
    const note = root.querySelector<HTMLElement>("#place-note");
    const list = root.querySelector<HTMLElement>("#place-results");
    const favs = root.querySelector<HTMLElement>("#place-favs");
    const now = root.querySelector<HTMLElement>("#place-now");
    if (!card || !input || !go || !note || !list || !favs || !now) return;
    const getPlaces = ports.getPlaces.bind(ports);
    const setPlaces = ports.setPlaces.bind(ports);
    const searchPlaces = ports.searchPlaces.bind(ports);

    const drawLists = (): void => {
      list.innerHTML = resultsHtml(results, lang);
      favs.innerHTML = favoritesHtml(getPlaces(), lang);
      now.innerHTML = nowHtml(getPlaces(), lang);
      note.textContent = searchNote;
    };
    const commit = async (next: Places): Promise<void> => {
      await setPlaces(next);
      drawLists();
    };

    input.value = query;
    drawLists();

    const run = async (): Promise<void> => {
      query = input.value.trim();
      if (query.length < 2) return;
      searchNote = t(lang, "p.searching");
      results = [];
      drawLists();
      try {
        results = await searchPlaces(query);
        searchNote = results.length === 0 ? t(lang, "p.noResults") : "";
      } catch {
        searchNote = t(lang, "p.searchFailed");
      }
      drawLists();
    };
    go.addEventListener("click", () => { void run(); });
    input.addEventListener("keydown", (event: Event) => {
      if ((event as KeyboardEvent).key === "Enter") { event.preventDefault(); void run(); }
    });

    card.addEventListener("click", (event: Event) => {
      const target = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-act]");
      if (!target) return;
      const act = target.dataset["act"];
      const id = target.dataset["id"] ?? "";
      const result = results[Number(target.dataset["i"] ?? -1)];
      const current = getPlaces();
      if (act === "save" && result) {
        const next = addFavorite(current, result);
        if (next === current && current.favorites.length >= MAX_FAVORITES) {
          searchNote = fullText(lang);
          drawLists();
          return;
        }
        searchNote = "";
        void commit(next);
      } else if (act === "now" && result) {
        void commit(setNow(current, result));
      } else if (act === "clear-now") {
        void commit(setNow(current, null));
      } else if (act === "remove") {
        void commit(removeFavorite(current, id));
      } else if (act === "up" || act === "down") {
        void commit(moveFavorite(current, id, act === "up" ? -1 : 1));
      }
    });
    card.addEventListener("change", (event: Event) => {
      const field = event.target as HTMLInputElement | null;
      if (!field?.classList.contains("fav-name")) return;
      void commit(renameFavorite(getPlaces(), field.dataset["id"] ?? "", field.value));
    });
  };

  const render = (): void => {
    const settings = ports.getSettings();

    const lang = locale();
    const x = (key: string, vars: Record<string, string | number> = {}): string => t(lang, key, vars);
    if (document.documentElement) document.documentElement.lang = lang;

    const hasPlaces = Boolean(ports.getPlaces && ports.setPlaces);
    const tabs = [
      { id: "stops", icon: "🚏", key: "p.tabStops" },
      ...(hasPlaces ? [{ id: "goals", icon: "🎯", key: "p.tabGoals" }] : []),
      { id: "glasses", icon: "👓", key: "p.tabGlasses" },
      { id: "connection", icon: "🔌", key: "p.tabConnection" },
      { id: "more", icon: "⚙️", key: "p.tabMore" },
    ];
    const ids = tabs.map((entry) => entry.id);
    if (!ids.includes(tab)) tab = readTab(ids);

    root.innerHTML = `
      <header class="brand bar">
        <div><span class="brand-mark">Quietglass</span><h1>NextStop</h1></div>
        <span class="chip on">${x(settings.backend === "oebb" ? "p.chipOebb" : "p.chipMotis")}</span>
      </header>

      <div class="tab" data-tab="stops">
      <p class="next" id="next"></p>

      <div class="card">
        <label>${x("p.status")}</label>
        <p class="hint" id="status"></p>
        <button id="refresh-now" type="button">${x("p.refreshNow")}</button>
      </div>
      </div>

      ${hasPlaces ? `<div class="tab" data-tab="goals">${placesCard(lang)}</div>` : ""}

      <div class="tab" data-tab="glasses">
      <div class="card compact">
        ${languageSelect(lang)}
        <label class="check"><input id="invert" type="checkbox" /> ${x("p.invert")}</label>
        <p class="hint">${x("p.invertHint")}</p>
      </div>

      ${ports.getVoiceState ? `<div class="card">
        <label class="check"><input id="announce" type="checkbox" /> ${x("p.announce")}</label>
        <button id="voice-on" type="button">${x("p.announceOn")}</button>
        <p class="hint" id="voice-state"></p>
        <p class="hint">${x("p.announceHint")}</p>
      </div>` : ""}

      <div class="card keys">
        <label>${x("p.controls")}</label>
        <p class="hint">
          <strong>${x("p.swipe")}</strong> — ${x("p.swipeDoes")}<br />
          <strong>${x("p.tap")}</strong> — ${x("p.tapDoes")}<br />
          <strong>${x("p.hold")}</strong> — ${x("p.holdDoes")}<br />
          <strong>${x("p.doubleTap")}</strong> — ${x("p.doubleTapDoes")}<br />
          ${x("p.legend")}<br />
          ${x("p.routeHowTo")}
        </p>
      </div>
      </div>

      <div class="tab" data-tab="connection">
      <div class="card">
        <label for="backend">${x("p.sourceLabel")}</label>
        <select id="backend">
          <option value="motis">${x("p.sourceMotis")}</option>
          <option value="oebb">${x("p.sourceOebb")}</option>
        </select>
        <p class="hint" id="backend-hint"></p>
      </div>

      <div class="card advanced" id="advanced">
        <h2>${x("p.advanced")}</h2>

        <div id="oebb-card">
          <label for="oebb-url">${x("p.oebbUrl")}</label>
          <input id="oebb-url" type="url" inputmode="url" spellcheck="false" />
          <p class="hint">
            ${x("p.oebbUrlHint")}
          </p>
        </div>

        <div id="motis-card">
          <label for="motis-url">${x("p.motisUrl")}</label>
          <input id="motis-url" type="url" inputmode="url" spellcheck="false" />
          <p class="hint">
            ${x("p.motisUrlHint")}
          </p>
        </div>

        <div id="stt-card">
          <label for="stt-url">${x("p.sttUrl")}</label>
          <input id="stt-url" type="url" inputmode="url" spellcheck="false" placeholder="https://" />
          <p class="hint">${x("p.sttUrlHint")}</p>
        </div>

        <label for="refresh">${x("p.refreshEvery", { value: '<span id="refresh-value"></span>' })}</label>
        <input id="refresh" type="range" min="10" max="120" step="5" />
        <p class="hint">
          ${x("p.refreshHint")}
        </p>
      </div>

      </div>

      <div class="tab" data-tab="more">
      <p class="credits">
        ${x("p.credits", { link: `<a href="https://transitous.org/sources/" target="_blank" rel="noopener">${x("p.creditsLink")}</a>` })}
      </p>
      </div>

      <nav class="tabbar" role="tablist">
        ${tabs.map(({ id, icon, key }) => `<button type="button" role="tab" data-tab-go="${id}"><span aria-hidden="true">${icon}</span>${x(key)}</button>`).join("")}
      </nav>
    `;
    applyTab(root, tab);
    root.querySelectorAll<HTMLButtonElement>("[data-tab-go]").forEach((button) => {
      button.addEventListener("click", () => {
        tab = button.dataset["tabGo"] ?? "stops";
        try { localStorage.setItem(TAB_KEY, tab); } catch { /* private mode */ }
        applyTab(root, tab);
        window.scrollTo({ top: 0 });
      });
    });

    const backend = root.querySelector<HTMLSelectElement>("#backend");
    const oebbUrl = root.querySelector<HTMLInputElement>("#oebb-url");
    const motisUrl = root.querySelector<HTMLInputElement>("#motis-url");
    const refresh = root.querySelector<HTMLInputElement>("#refresh");
    const sttUrl = root.querySelector<HTMLInputElement>("#stt-url");
    const refreshValue = root.querySelector<HTMLElement>("#refresh-value");
    const backendHint = root.querySelector<HTMLElement>("#backend-hint");
    const oebbCard = root.querySelector<HTMLElement>("#oebb-card");
    const motisCard = root.querySelector<HTMLElement>("#motis-card");
    if (!backend || !oebbUrl || !motisUrl || !refresh) return;

    backend.value = settings.backend;
    oebbUrl.value = settings.oebbUrl;
    motisUrl.value = settings.motisUrl;
    refresh.value = String(settings.refreshSeconds);
    if (sttUrl) sttUrl.value = settings.sttUrl;
    if (refreshValue) refreshValue.textContent = String(settings.refreshSeconds);

    // Only the relevant address is shown; two URL fields at once invites
    // editing the one that is not in use and wondering why nothing changed.
    if (oebbCard) oebbCard.hidden = settings.backend !== "oebb";
    if (motisCard) motisCard.hidden = settings.backend !== "motis";

    if (backendHint) {
      backendHint.textContent = x(settings.backend === "oebb" ? "p.sourceHintOebb" : "p.sourceHintMotis");
    }

    updateStatus();
    bindPlaces(lang);

    const invert = root.querySelector<HTMLInputElement>("#invert");
    if (invert) {
      invert.checked = settings.invertScroll;
      invert.addEventListener("change", () => { void ports.setSettings({ ...ports.getSettings(), invertScroll: invert.checked }); });
    }

    const announce = root.querySelector<HTMLInputElement>("#announce");
    if (announce) {
      announce.checked = settings.announce;
      announce.addEventListener("change", () => { void ports.setSettings({ ...ports.getSettings(), announce: announce.checked }); });
    }
    root.querySelector<HTMLButtonElement>("#voice-on")?.addEventListener("click", () => {
      ports.onVoiceActivate?.();
      updateStatus();
    });

    // Each edit starts from the settings as they are now, not as they were when
    // the page was built: otherwise saving the refresh interval after changing
    // the address put the old address back.
    const commit = (change: Partial<Settings>): void => {
      void ports.setSettings({ ...ports.getSettings(), ...change });
    };

    backend.addEventListener("change", () => {
      commit({ backend: backend.value === "motis" ? "motis" : "oebb" });
      render();
    });

    for (const [field, key] of [[oebbUrl, "oebbUrl"], [motisUrl, "motisUrl"]] as const) {
      field.addEventListener("change", () => {
        // An empty ÖBB field means the build's default, like the Whisper field.
        if (key === "oebbUrl" && field.value.trim() === "") {
          field.setCustomValidity("");
          commit({ oebbUrl: DEFAULT_SETTINGS.oebbUrl });
          field.value = DEFAULT_SETTINGS.oebbUrl;
          return;
        }
        const check = validateUrl(field.value, lang);
        if (!check.valid) {
          field.setCustomValidity(check.error ?? x("p.invalid"));
          field.reportValidity();
          // Refuse the edit rather than silently storing an address that can
          // never answer; the old one at least worked.
          field.value = ports.getSettings()[key];
          return;
        }
        field.setCustomValidity("");
        commit({ [key]: field.value.trim() });
      });
    }

    // Empty is allowed here: it means "the app's default", which a public build leaves unset.
    sttUrl?.addEventListener("change", () => {
      const text = sttUrl.value.trim();
      if (text !== "") {
        const check = validateUrl(text, lang);
        if (!check.valid) {
          sttUrl.setCustomValidity(check.error ?? x("p.invalid"));
          sttUrl.reportValidity();
          sttUrl.value = ports.getSettings().sttUrl;
          return;
        }
      }
      sttUrl.setCustomValidity("");
      commit({ sttUrl: text });
    });

    // The language applies to the glasses too: the port redraws them at once.
    const language = root.querySelector<HTMLSelectElement>("#language");
    language?.addEventListener("change", () => {
      ports.setLocale?.(language.value === "de" ? "de" : "en");
      render();
    });

    refresh.addEventListener("input", () => {
      if (refreshValue) refreshValue.textContent = refresh.value;
    });
    refresh.addEventListener("change", () => {
      commit({ refreshSeconds: Number(refresh.value) || DEFAULT_SETTINGS.refreshSeconds });
    });

    root.querySelector<HTMLButtonElement>("#refresh-now")
      ?.addEventListener("click", () => { ports.refresh(); render(); });
  };

  render();
  // The status line is the only live part, so a slow beat is enough. It must
  // not rebuild the page: that wiped a proxy address half typed into its field
  // every five seconds, and took the open backend menu with it.
  setInterval(updateStatus, 5000);
}
