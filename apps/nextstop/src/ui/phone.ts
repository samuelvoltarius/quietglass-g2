import type { Stop } from "../transit/types";
import type { Position } from "../ride/tracker";
import { DEFAULT_SETTINGS, validateUrl, type Settings } from "../storage/persist";
import { nextStep } from "../text";
import { languageSelect, type Locale } from "../i18n";
import { t } from "../messages";
import type { GeoResult } from "../route/geocode";
import { addFavorite, MAX_FAVORITES, moveFavorite, removeFavorite, renameFavorite, setNow, type Places } from "../route/places";
import { escapeHtml, favoritesHtml, fullText, nowHtml, resultsHtml } from "./places-ui";

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
  /** The board of the stop in use, for the "Jetzt" tab; null while there is none (the tab then shows a sample). */
  getBoard?(): PhoneBoard | null;
}

/** One departure as the phone shows it. */
export interface PhoneDeparture {
  readonly line: string;
  readonly headsign: string;
  /** Minutes until it leaves (0 or less = now). */
  readonly minutes: number;
  /** Minutes late; null when the time is only the timetable. */
  readonly delay: number | null;
  readonly cancelled: boolean;
  readonly track: string;
  /** Epoch ms of the expected departure. */
  readonly clock: number;
}

export interface PhoneBoard {
  readonly stop: string;
  readonly metres: number | null;
  readonly departures: readonly PhoneDeparture[];
}

/** The three tabs (QUS v1). */
export const TABS: readonly { id: string; icon: string; key: string }[] = [
  { id: "now", icon: "🚏", key: "p.tabNow" },
  { id: "trips", icon: "🎯", key: "p.tabTrips" },
  { id: "settings", icon: "⚙️", key: "p.tabSettings" },
];

/** Nothing found yet: Einstellungen opens first, with the three-step checklist. */
export function isFirstRun(position: Position | null, stops: readonly Stop[]): boolean {
  return position === null && stops.length === 0;
}

/** Sample departures for the first start, so the page shows what it will look like. */
export function sampleBoard(now: number): PhoneBoard {
  const at = (minutes: number): number => now + minutes * 60_000;
  return {
    stop: "Mirabellplatz",
    metres: 120,
    departures: [
      { line: "3", headsign: "Salzburg Hbf", minutes: 4, delay: 2, cancelled: false, track: "B", clock: at(4) },
      { line: "6", headsign: "Obus Itzling", minutes: 9, delay: 0, cancelled: false, track: "A", clock: at(9) },
      { line: "5", headsign: "Hallein Bahnhof", minutes: 14, delay: null, cancelled: false, track: "C", clock: at(14) },
      { line: "25", headsign: "Salzburg Süd", minutes: 21, delay: 0, cancelled: false, track: "B", clock: at(21) },
    ],
  };
}

const clockText = (ms: number): string => {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
};

/** "+3 min", "pünktlich", "Fahrplan" (nothing confirmed), "fällt aus". */
export function delayText(departure: PhoneDeparture, locale: Locale): string {
  if (departure.cancelled) return t(locale, "p.cancelled");
  if (departure.delay === null) return t(locale, "p.planned");
  return departure.delay > 0 ? t(locale, "p.delayed", { minutes: departure.delay }) : t(locale, "p.onTime");
}

const minutesText = (minutes: number, locale: Locale): string =>
  minutes <= 0 ? t(locale, "p.heroNow") : t(locale, "p.heroMinutes", { minutes });

const toneOf = (departure: PhoneDeparture): "ok" | "warn" | "offline" =>
  departure.cancelled ? "offline" : (departure.delay ?? 0) > 0 ? "warn" : "ok";

/** The status pill: live once there is a location and stops, the state as a word otherwise. */
export function pillOf(position: Position | null, stops: readonly Stop[], locale: Locale): { text: string; on: boolean } {
  return position !== null && stops.length > 0
    ? { text: t(locale, "p.pillLive"), on: true }
    : { text: t(locale, "p.pillWaiting"), on: false };
}

/** "Jetzt": hero card (the next departure, one big value), 2 x 2 key figures, the one button, a card strip of the rest. */
export function nowInner(board: PhoneBoard | null, now: number, locale: Locale): string {
  const sample = board === null || board.departures.length === 0;
  const shown = board !== null && board.departures.length > 0 ? board : sampleBoard(now);
  const first = shown.departures[0]!;
  const x = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  const stat = (label: string, value: string, unit: string, alert = false): string =>
    `<div${alert ? ' class="alert"' : ""}><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b><small>${escapeHtml(unit)}</small></div>`;
  const cards = shown.departures.slice(1).map((departure) =>
    `<div class="host tone-${toneOf(departure)}"><b>${escapeHtml(departure.line)}</b><em>${escapeHtml(minutesText(departure.minutes, locale))}</em><span>${escapeHtml(departure.headsign)}</span><span><i>${escapeHtml(delayText(departure, locale))}</i></span></div>`);
  return `
    <section class="card hero-card">
      <div class="hero">
        <div><span>${escapeHtml(x("p.heroLabel"))} · ${escapeHtml(first.line)}</span><strong>${escapeHtml(first.cancelled ? x("p.cancelled") : minutesText(first.minutes, locale))}</strong></div>
        <p>${escapeHtml(shown.stop)}</p>
      </div>
      <div class="stats">
        ${stat(x("p.statTrack"), first.track || "–", x("p.unitTrack"))}
        ${stat(x("p.statDelay"), delayText(first, locale), x("p.unitMinutes"), first.cancelled || (first.delay ?? 0) > 0)}
        ${stat(x("p.statWalk"), shown.metres === null ? "–" : `${shown.metres} m`, x("p.unitMetres"))}
        ${stat(x("p.statLeaves"), first.cancelled ? "–" : clockText(first.clock), x("p.unitClock"))}
      </div>
      <button id="refresh-now" type="button" class="big">${escapeHtml(x("p.refresh"))}</button>
      ${sample ? `<p class="hint">${escapeHtml(x("p.sampleNote"))}</p>` : ""}
    </section>
    ${cards.length > 0 ? `<h2 class="strip-title">${escapeHtml(x("p.stripTitle"))}</h2><div class="strip">${cards.join("")}</div>` : ""}`;
}

/** First-run checklist: pure, so tests can read it. */
export function setupInner(position: Position | null, stops: readonly Stop[], places: Places | null, locale: Locale): string {
  const step = (n: number, done: boolean, key: string): string =>
    `<li class="${done ? "done" : ""}"><span class="num" aria-hidden="true">${done ? "✓" : n}</span><span>${escapeHtml(t(locale, key))}</span></li>`;
  const located = position !== null;
  const found = located && stops.length > 0;
  const saved = places !== null && places.favorites.length > 0;
  return `<ol class="steps">${step(1, located, "p.setup1")}${step(2, found, "p.setup2")}${step(3, saved, "p.setup3")}</ol>`
    + (found ? "" : `<p class="hint">${escapeHtml(t(locale, "p.setupDemo"))}</p>`);
}

/** The page is split into exactly three tabs. */
const TAB_KEY = "quietglass.nextstop.tab.v2";

function readTab(firstRun: boolean): string {
  try { const v = localStorage.getItem(TAB_KEY); if (TABS.some((tab) => tab.id === v)) return v!; } catch { /* no storage */ }
  return firstRun ? "settings" : "now";
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
    const live = root.querySelector<HTMLElement>("#now-live");
    if (live) live.innerHTML = nowInner(ports.getBoard?.() ?? null, Date.now(), locale());
    const pill = root.querySelector<HTMLElement>("#pill");
    if (pill) {
      const state = pillOf(ports.getPosition(), ports.getStops(), locale());
      pill.textContent = state.text;
      pill.className = state.on ? "chip on" : "chip";
    }
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
    const firstRun = isFirstRun(ports.getPosition(), ports.getStops());
    const ids = TABS.map((entry) => entry.id);
    if (!ids.includes(tab)) tab = readTab(firstRun);
    const pill = pillOf(ports.getPosition(), ports.getStops(), lang);

    root.innerHTML = `
      <header class="brand bar">
        <div><span class="brand-mark">${x("p.kicker")}</span><h1>NextStop</h1></div>
        <span class="chip${pill.on ? " on" : ""}" id="pill">${pill.text}</span>
      </header>

      <div class="tab" data-tab="now">
        <p class="banner tone-none" id="next"></p>
        <div id="now-live">${nowInner(ports.getBoard?.() ?? null, Date.now(), lang)}</div>
        <p class="hint" id="status"></p>
      </div>

      <div class="tab" data-tab="trips">
        ${hasPlaces ? placesCard(lang) : ""}
      </div>

      <div class="tab" data-tab="settings">
      ${firstRun ? `<section class="card setup"><h2>${x("p.setupTitle")}</h2>${setupInner(ports.getPosition(), ports.getStops(), ports.getPlaces?.() ?? null, lang)}</section>` : ""}

      <details class="card fold" id="glasses-card" ${firstRun ? "open" : ""}>
        <summary>${x("p.cardGlasses")}</summary>
        ${languageSelect(lang)}
        <label class="check"><input id="invert" type="checkbox" /> ${x("p.invert")}</label>
        <p class="hint">${x("p.invertHint")}</p>
        ${ports.getVoiceState ? `
        <label class="check"><input id="announce" type="checkbox" /> ${x("p.announce")}</label>
        <button id="voice-on" type="button">${x("p.announceOn")}</button>
        <p class="hint" id="voice-state"></p>
        <p class="hint">${x("p.announceHint")}</p>` : ""}
      </details>

      <details class="card fold" id="source-card" ${firstRun ? "open" : ""}>
        <summary>${x("p.cardSource")}</summary>
        <label for="backend">${x("p.sourceLabel")}</label>
        <select id="backend">
          <option value="motis">${x("p.sourceMotis")}</option>
          <option value="oebb">${x("p.sourceOebb")}</option>
        </select>
        <p class="hint" id="backend-hint"></p>

        <div id="advanced">
          <h3>${x("p.advanced")}</h3>

          <div id="oebb-card">
            <label for="oebb-url">${x("p.oebbUrl")}</label>
            <input id="oebb-url" type="url" inputmode="url" spellcheck="false" />
            <p class="hint">${x("p.oebbUrlHint")}</p>
          </div>

          <div id="motis-card">
            <label for="motis-url">${x("p.motisUrl")}</label>
            <input id="motis-url" type="url" inputmode="url" spellcheck="false" />
            <p class="hint">${x("p.motisUrlHint")}</p>
          </div>

          <div id="stt-card">
            <label for="stt-url">${x("p.sttUrl")}</label>
            <input id="stt-url" type="url" inputmode="url" spellcheck="false" placeholder="Whisper-Server (Adresse:Port)" />
            <p class="hint">${x("p.sttUrlHint")}</p>
          </div>

          <label for="refresh">${x("p.refreshEvery", { value: '<span id="refresh-value"></span>' })}</label>
          <input id="refresh" type="range" min="10" max="120" step="5" />
          <p class="hint">${x("p.refreshHint")}</p>
        </div>
      </details>

      <details class="card fold" id="keys-card">
        <summary>${x("p.cardKeys")}</summary>
        <p class="hint">
          <strong>${x("p.swipe")}</strong> — ${x("p.swipeDoes")}<br />
          <strong>${x("p.tap")}</strong> — ${x("p.tapDoes")}<br />
          <strong>${x("p.doubleTap")}</strong> — ${x("p.doubleTapDoes")}<br />
          <strong>${x("p.voiceEntry")}</strong> — ${x("p.voiceEntryDoes")}<br />
          <strong>${x("p.hold")}</strong> — ${x("p.holdDoes")}<br />
          ${x("p.legend")}<br />
          ${x("p.routeHowTo")}
        </p>
      </details>

      <p class="credits">
        ${x("p.credits", { link: `${x("p.creditsLink")} (transitous.org/sources)` })}
      </p>
      </div>

      <nav class="tabbar" role="tablist">
        ${TABS.map(({ id, icon, key }) => `<button type="button" role="tab" data-tab-go="${id}"><span aria-hidden="true">${icon}</span>${x(key)}</button>`).join("")}
      </nav>
    `;
    applyTab(root, tab);
    root.querySelectorAll<HTMLButtonElement>("[data-tab-go]").forEach((button) => {
      button.addEventListener("click", () => {
        tab = button.dataset["tabGo"] ?? "now";
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

    // The Jetzt card is redrawn in place on every beat, so its button is wired once on the container.
    root.querySelector<HTMLElement>("#now-live")?.addEventListener("click", (event: Event) => {
      if ((event.target as HTMLElement | null)?.closest("#refresh-now")) { ports.refresh(); updateStatus(); }
    });
  };

  render();
  // The status line is the only live part, so a slow beat is enough. It must
  // not rebuild the page: that wiped a proxy address half typed into its field
  // every five seconds, and took the open backend menu with it.
  setInterval(updateStatus, 5000);
}
