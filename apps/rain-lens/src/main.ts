import { appStore } from "./storage/kv";
import { AppLocationAccuracy, waitForEvenAppBridge, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { createImageLane } from "./glasses/lane";
import { footer as qisFooter } from "./glasses/footer";
import { createBitmap } from "./glasses/bitmap";
import { createExitRequest, isBackSignal, settleRestore } from "./exit";
import { encodePng } from "./glasses/pixel";
import { COCKPIT_TILES, createCockpitPage, createRadarPage, createTextPage, forgetPage, sendImage, setPageMenu, updateRadarText, updateTextPage, type MenuSpec, type RadarView, type TextView } from "./glasses/text";
import { cockpitModel, playFrame } from "./cockpit/model";
import { composeCockpit } from "./cockpit/compose";
import { fetchWarnings, topWarning, type WarningsResult } from "./cockpit/warnings";
import { createTileSender } from "./screen/sender";
import { autoBackend, type TextBackend } from "./screen/text";
import type { RadarSession } from "./radar/session";
import { languageSelect, rememberLocale, resolveLocale, setLocale, tr, type Locale } from "./i18n";
import { gestureFromEvent, menuItemIdFromEvent } from "./input/gestures";
import { lifecycleFromEvent } from "./lifecycle";
import { messages } from "./messages";
import { fetchForecast, parseCoordinates } from "./rain/api";
import { searchPlaces, usableQuery, type Place } from "./rain/geocode";
import { KEYS, errorKey, noticeKey, resolveLocation, storedMode, storedSources, type ResolvedLocation, type Status } from "./rain/location";
import { CHART_ROWS, SIDE_WIDTH, clock, dayName, demoWeather, escapeHtml, fit, glassesBody, weatherKind, windCompass, type WeatherForecast } from "./rain/model";
import { CHART, chartData, chartKey, chartSummary, drawChart } from "./weather/chart";
import { ICONS, drawWeatherIcons, iconKey } from "./weather/icons";

const round = (value: number): string => `${Math.round(value)}°`;
/** The phone page is split into tabs instead of one long column. */
const TABS = [
  { id: "weather", icon: "🌦️", key: "tabWeather" },
  { id: "place", icon: "📍", key: "tabPlace" },
  { id: "glasses", icon: "👓", key: "tabGlasses" },
  { id: "more", icon: "⚙️", key: "tabMore" },
] as const;
const TAB_KEY = "quietglass.rainlens.tab";
const readTab = (): string | null => { try { const v = localStorage.getItem(TAB_KEY); return TABS.some((tab) => tab.id === v) ? v : null; } catch { return null; } };
/** Shows only the active tab; the choice survives redraws and restarts. */
const applyTab = (root: ParentNode, active: string): void => {
  root.querySelectorAll<HTMLElement>("[data-tab]").forEach((el) => { el.hidden = el.dataset.tab !== active; });
  root.querySelectorAll<HTMLButtonElement>("[data-tab-go]").forEach((button) => { const on = button.dataset.tabGo === active; button.classList.toggle("on", on); button.setAttribute("aria-selected", String(on)); });
};
/**
 * The radar page exists only in the private build (`VITE_RADAR=1`): RainViewer's
 * terms allow private and educational use only. Written out literally so the
 * public build drops the radar code altogether.
 */
const RADAR = import.meta.env.VITE_RADAR === "1";
/** ?demo=1: a fixed place when the phone has no location, so the app can be tried in the simulator. */
const DEMO = typeof location !== "undefined" && new URLSearchParams(location.search).get("demo") === "1";
const DEMO_PLACE = { latitude: 47.8095, longitude: 13.055 };
/** Header and footer span the full 576 px, unlike the body next to the icons. */
const FULL_WIDTH = 56;
/** Longest wait for the phone's position before the app carries on without it. */
const LOCATION_TIMEOUT_MS = 10_000;
/** A forecast older than this is fetched again on its own (and on return to the app). */
const REFRESH_MS = 15 * 60_000;
/** The page on the glasses (now / hours / days / radar) survives a restart of the app. */
const PAGE_KEY = "rainlens.page";
/** Phone setting "gust alert from X km/h"; empty = off. */
const GUST_KEY = "rainlens.gustAlert";
/** Phone setting "Brille": swipes arrive inverted on some hardware ("1" = invert). */
const INVERT_KEY = "rainlens.invertScroll";
/** QIS v1.2: ids of the glasses' side menu (Hold opens it). */
export const MENU = { help: 1, refresh: 2, swipe: 3 } as const;
/** The glasses' side menu (QIS v1.2). Off: its clicks never arrive and a hold opens it instead of reaching the app (step log from the real glasses, 15.10.2026). */
export const SIDE_MENU = false;
const GUST_CHOICES = [30, 40, 50, 60, 70, 80, 90, 100] as const;
/** The cockpit's clock: checked this often (an unchanged frame sends nothing). */
const COCKPIT_TICK_MS = 15_000;
/** One radar loop step on the cockpit. */
const COCKPIT_STEP_MS = 700;

/** "14:05" in local time. */
function hhmm(time: number): string {
  const d = new Date(time);
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timed out")), ms); })]).finally(() => clearTimeout(timer));
}

async function boot(): Promise<void> {
  const bridge: EvenAppBridge = await waitForEvenAppBridge();
  await appStore.init(bridge, ["quietglass.locale", PAGE_KEY, GUST_KEY, INVERT_KEY, ...Object.values(KEYS)]);
  /** Storage view for the helpers in rain/location.ts (sync reads from the KV mirror). */
  const store: Pick<Storage, "getItem"> = { getItem: (key: string) => appStore.get(key) };
  let locale = await resolveLocale(bridge); setLocale(locale); let forecast: WeatherForecast = demoWeather(); let loading = false; let failure: ReturnType<typeof errorKey> | null = null; let pageReady = false; let last = ""; let page = 0;
  /** Set once the user confirms the exit dialog: nothing draws on the closed page. */
  let closed = false;
  /** QIS v1 help page (hold): read-only, 2x goes back to the view it came from. */
  let helpOpen = false;
  let status: Status = "loading"; let where: ResolvedLocation | null = null;
  /** Phone-only state of the place search; never stored. */
  let query = ""; let results: Place[] = []; let searchNote = ""; let coordNote = ""; let tab = readTab();
  /** What the glasses show now, so a refresh only rewrites the containers that changed. */
  let shown: TextView | null = null;
  const lane = createImageLane((target, imageData) => (exitAsked() ? Promise.resolve(false) : sendImage(bridge, target, imageData)));
  /** The radar's four tiles go through their own lane: at most one write per tile every 700 ms. */
  const radarLane = createImageLane((target, imageData) => (exitAsked() ? Promise.resolve(false) : sendImage(bridge, target, imageData)), 700);
  const t = (key: string, vars: Record<string, string | number> = {}): string => tr(messages, locale, key, vars);
  /** Which layout is on the glasses: switching between them is a page rebuild. */
  let installed: "weather" | "radar" | "cockpit" | null = null;
  /** The cockpit is drawn as one 576 x 288 frame; only its changed tiles cross Bluetooth. */
  const cockpitSender = createTileSender(COCKPIT_TILES, (slot, png) => (exitAsked() ? Promise.resolve(false) : sendImage(bridge, slot, png)));
  let textBackend: TextBackend | null = null;
  /** Official warnings for the place (Austria only); null until asked or when the service failed. */
  let warnings: WarningsResult | null = null;
  /** Step of the radar loop a tap started on the cockpit, or null for the still picture. */
  let playStep: number | null = null;
  let playTimer: ReturnType<typeof setInterval> | undefined;
  let cockpitTimer: ReturnType<typeof setInterval> | undefined;
  let cockpitMod: typeof import("./radar/cockpit-map") | null = null;
  let shownRadar: RadarView | null = null;
  let radar: RadarSession | null = null;
  if (RADAR) {
    const { createRadarSession } = await import("./radar/session");
    radar = createRadarSession({
      position: () => where?.position ?? null, t, locale: () => locale, redraw: () => { void draw(); }, demo: DEMO,
      locating: () => loading && !where, imagesIdle: () => radarLane.idle?.() ?? true,
    });
    cockpitMod = await import("./radar/cockpit-map");
  }
  /** Now, hours, days, (radar,) cockpit. */
  const pageCount = radar ? 5 : 4;
  const cockpitPage = pageCount - 1;
  { const saved = Number(appStore.get(PAGE_KEY) ?? "0"); page = Number.isInteger(saved) && saved >= 0 && saved < pageCount ? saved : 0; }
  /** When the forecast on screen was fetched; 0 = never. */
  let fetchedAt = 0;
  /** In the background (left through the system): no drawing, no radar loop, no refresh timer. */
  let backgrounded = false;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  const onRadar = (): boolean => radar !== null && page === 3;
  const onCockpit = (): boolean => page === cockpitPage;
  const condition = (code: number): string => t(weatherKind(code));
  const errorText = (): string => failure ? t(failure.key, { status: failure.status ?? "" }) : "";
  /** QIS v1.2: the glasses never show a status code; the phone keeps the detail. */
  const glassesErrorText = (): string => failure ? t(failure.key === "errorServer" ? "errorServerGlasses" : failure.key) : "";
  /** QIS v1.2: Hold opens the side menu: Hilfe, Aktualisieren and the swipe direction (its label names the state, so a change rebuilds the page once). */
  const menuSpec = (): MenuSpec => !SIDE_MENU ? { key: "none", items: [] } : ({ key: `${locale}:${invertScroll() ? 1 : 0}`, items: [{ id: MENU.help, label: t("mHelp") }, { id: MENU.refresh, label: t("mRefresh") }, { id: MENU.swipe, label: t(invertScroll() ? "mSwipeInverted" : "mSwipeNormal") }] });
  /** Key of the side menu the page on the glasses carries; a different one needs a rebuild. */
  let pageMenuKey = "";
  /** Called before any page is drawn: the menu travels with the page. */
  const syncMenu = (): void => { const menu = menuSpec(); setPageMenu(menu); if (pageReady && menu.key !== pageMenuKey) { pageReady = false; last = ""; } if (!pageReady) pageMenuKey = menu.key; };
  const placeName = (): string => where?.label ?? (where?.kind === "manual" ? `${where.position.latitude.toFixed(2)}, ${where.position.longitude.toFixed(2)}` : t("here"));
  const currentLines = (): string[] => {
    const current = forecast.current; const today = forecast.daily[0];
    // Four rows: the chart below already shows rain and the temperature curve; sun times live on the days view.
    return [`${condition(current.weatherCode).toUpperCase()}  ${round(current.temperature)}`, `${t("feels")} ${round(current.feelsLike)}   ${t("humidity")} ${Math.round(current.humidity)}%`, `${t("wind")} ${windCompass(current.windDirection)} ${Math.round(current.windSpeed)} km/h   ${t("gusts")} ${Math.round(current.windGusts)}`, today ? `${t("highLow")} ${round(today.maximum)} / ${round(today.minimum)}` : `${t("precipitation")} ${current.precipitation.toFixed(1)} mm`];
  };
  /** Every third hour, lining up with the chart's ticks. */
  const hourlyLines = (): string[] => forecast.hourly.slice(0, 12).filter((_, index) => index % 3 === 0).map((hour) => `${clock(hour.time, locale)}  ${round(hour.temperature).padEnd(4)} ${condition(hour.weatherCode).padEnd(10)} ${Math.round(hour.precipitationProbability)}%`);
  const dailyLines = (): string[] => { const today = forecast.daily[0]; return [...forecast.daily.slice(0, 3).map((day) => `${dayName(day.date, locale).toUpperCase().padEnd(4)} ${round(day.maximum)} / ${round(day.minimum)}  ${condition(day.weatherCode).padEnd(10)} ${Math.round(day.precipitationProbability)}%`), ...(today ? [`${t("sun")} ${clock(today.sunrise, locale)} - ${clock(today.sunset, locale)}`] : [])]; };
  /** The numbers beside the chart: rain label, wettest hour, temperature range. Empty until there is a real forecast. */
  const sideLines = (): string[] => { const summary = notice() ? null : chartSummary(forecast.hourly); return summary ? [t("chance"), `${summary.rain}% ${clock(summary.time, locale)}`, `${summary.high}° / ${summary.low}°`].map((line) => fit(line, SIDE_WIDTH)) : []; };
  /** Without a real forecast the glasses say what to do next instead of showing sample numbers that look real. */
  const notice = (): string | null => { const key = noticeKey(status, forecast.source); return key ? t(key) : null; };
  /** QIS v1 footer (Tippen / Wischen / Halten / 2x); a real forecast puts its age in front. */
  const footerLine = (): string => {
    const lead = forecast.source === "live" && fetchedAt !== 0 && !notice() ? t("asOf", { time: hhmm(fetchedAt) }) : "";
    return qisFooter(locale, { tap: t(notice() ? "fRetry" : "fRefresh"), swipe: t("fView"), hold: t("fHelp") }, "exit", lead);
  };
  /** The state word beside the app name while there is no forecast to show. */
  const stateWord = (): string => { const key = noticeKey(status, forecast.source); return t(key === "glassNoLocation" ? "stNoLocation" : key === "glassOffline" ? "stOffline" : "stLoading"); };
  const view = (): TextView => {
    const text = notice(); const tag = loading ? t("updating") : forecast.source === "live" ? (where?.label ?? "LIVE").toUpperCase() : t("sampleTag");
    return { header: fit(text ? `RAINLENS · ${stateWord()}` : `RAINLENS · ${[t("now"), t("hourly"), t("days")][page]} · ${tag}`, FULL_WIDTH), body: text ? glassesBody(text.split("\n"), "", CHART_ROWS) : glassesBody(page === 0 ? currentLines() : page === 1 ? hourlyLines() : dailyLines(), glassesErrorText(), CHART_ROWS), side: sideLines(), footer: footerLine() };
  };
  /** The help page: the gestures, what the app needs, 2x = back. Same layout as the weather views. */
  const helpView = (): TextView => ({ header: fit(`RAINLENS · ${t("helpTitle")}`, FULL_WIDTH), body: [t("help1"), t("help2"), t("help3"), t("help4")].map((line) => fit(line)), side: [], footer: qisFooter(locale, {}, "back") });
  /**
   * Images go through the lane and are never awaited: the icon column changes
   * with the view, the chart with the forecast. Sample data gets no chart.
   */
  const requestImages = (): void => {
    if (!pageReady) return;
    const iconPage = helpOpen || notice() ? -1 : page;
    lane.request(ICONS, iconKey(forecast, iconPage), () => encodePng(drawWeatherIcons(forecast, iconPage)));
    // The help page has no chart: whatever picture the chart container held is cleared.
    if (helpOpen) lane.request(CHART, "blank", () => encodePng(createBitmap(CHART.width, CHART.height)));
    if (iconPage < 0) return;
    const data = chartData(forecast.hourly, t("now"));
    lane.request(CHART, chartKey(data), () => encodePng(drawChart(data)));
  };
  const drawRadar = async (): Promise<void> => {
    if (!radar) return;
    syncMenu();
    if (installed !== "radar") pageReady = false;
    const text = radar.text();
    if (!pageReady) {
      const result = await createRadarPage(bridge, text);
      if (!result.ok) { pageReady = false; return; }
      pageReady = true; installed = "radar"; shownRadar = text;
      // A new page starts with blank images.
      radarLane.invalidate();
    } else if (JSON.stringify(text) !== JSON.stringify(shownRadar)) {
      const result = await updateRadarText(bridge, text, shownRadar ?? undefined);
      if (!result.ok) { pageReady = false; return; }
      shownRadar = text;
    }
    radar.requestImages(radarLane);
  };
  const invertScroll = (): boolean => appStore.get(INVERT_KEY) === "1";
  const gustLimit = (): number | null => { const value = Number(appStore.get(GUST_KEY) ?? ""); return Number.isFinite(value) && value > 0 ? value : null; };
  /** The cockpit as one frame: the model decides the words, compose.ts the pixels. */
  const cockpitFrame = (): ReturnType<typeof composeCockpit> => {
    textBackend ??= autoBackend();
    const now = Date.now();
    const position = where?.position ?? null;
    const data = radar?.data() ?? null;
    const frames = data?.frames ?? [];
    const shown = frames.length ? (playStep !== null ? playFrame(playStep, frames.length) : null) ?? frames.length - 1 : null;
    const map = cockpitMod && position ? cockpitMod.cockpitMap(position, data, shown, locale) : null;
    const place = where?.label?.split(",")[0]?.trim() || warnings?.place || (cockpitMod && position ? cockpitMod.cockpitPlace(position, locale) : null) || "";
    const model = cockpitModel({
      forecast, now, t, locale, notice: noticeKey(status, forecast.source),
      warning: warnings?.status === "ok" ? topWarning(warnings.warnings, now) : undefined,
      gustLimit: gustLimit(), place, map,
      ring: cockpitMod && position && map ? cockpitMod.cockpitRing(position) : null,
      frameTimes: frames.map((frame) => frame.time * 1000), shownFrame: shown,
    });
    return composeCockpit(model, textBackend);
  };
  const drawCockpit = async (): Promise<void> => {
    syncMenu();
    if (installed !== "cockpit") pageReady = false;
    if (!pageReady) {
      const result = await createCockpitPage(bridge);
      if (!result.ok) { pageReady = false; return; }
      pageReady = true; installed = "cockpit";
      // A new page starts with blank images.
      cockpitSender.reset();
    }
    // Never awaited: a slow transfer must not hold up the next gesture.
    void cockpitSender.push(cockpitFrame());
  };
  const stopPlaying = (): void => { clearInterval(playTimer); playTimer = undefined; playStep = null; };
  /** A tap on the cockpit: the radar loop once, oldest to newest, then the still picture again. */
  const playLoop = (): void => {
    const count = radar?.data()?.frames.length ?? 0;
    if (count === 0) return;
    stopPlaying();
    playStep = 0; void draw();
    playTimer = setInterval(() => {
      // Bluetooth first: the next frame only once the last one is on the glasses.
      if (!cockpitSender.idle()) return;
      const next = (playStep ?? 0) + 1;
      if (playFrame(next, count) === null) { stopPlaying(); void draw(); return; }
      playStep = next; void draw();
    }, COCKPIT_STEP_MS);
  };
  const enterCockpit = (): void => {
    clearInterval(cockpitTimer);
    cockpitTimer = setInterval(() => { if (!closed && !backgrounded && onCockpit() && playStep === null) void draw(); }, COCKPIT_TICK_MS);
    radar?.prepare();
  };
  const leaveCockpit = (): void => { clearInterval(cockpitTimer); cockpitTimer = undefined; stopPlaying(); };
  /** Official warnings for the place; quietly "–" when the service is not reachable. */
  const refreshWarnings = async (): Promise<void> => {
    const position = where?.position;
    if (!position) return;
    try { warnings = await fetchWarnings(position.latitude, position.longitude, locale); } catch { warnings = null; }
    if (onCockpit()) void draw();
  };
  // While the exit dialog may be on screen (asked, no input since) no timer, poll or stream may draw: a page call
  // could cover it. Data keeps being collected; the back signal restores the page the way of the first one.
  let exitAsked = (): boolean => false;
  const drawNow = async (): Promise<void> => {
    if (exitAsked()) return;
    if (closed || backgrounded) return;
    if (!helpOpen && onCockpit()) { await drawCockpit(); return; }
    if (!helpOpen && onRadar()) { await drawRadar(); return; }
    syncMenu();
    if (installed !== "weather") { pageReady = false; last = ""; }
    const text = helpOpen ? helpView() : view(); const signature = JSON.stringify(text);
    if (signature !== last || !pageReady) {
      const created = !pageReady;
      const result = pageReady ? await updateTextPage(bridge, text, shown ?? undefined) : await createTextPage(bridge, text);
      if (!result.ok) { pageReady = false; return; }
      pageReady = true; installed = "weather"; last = signature; shown = text;
      // A new page starts with blank images.
      if (created) lane.invalidate();
    }
    requestImages();
  };
  /** One draw at a time: the radar loop, taps and refreshes all ask for one, and two page creations must never overlap. */
  let drawing: Promise<void> | null = null; let drawAgain = false;
  const draw = (): Promise<void> => {
    if (exitAsked()) return Promise.resolve();
    if (drawing) { drawAgain = true; return drawing; }
    drawing = (async () => { try { do { drawAgain = false; await drawNow(); } while (drawAgain && !closed); } finally { drawing = null; } })();
    return drawing;
  };
  /**
   * The phone's position. The SDK's `timeoutMs` is only a hint: a pending
   * permission prompt or a cold GPS can leave the call open for good, so it is
   * capped here as well.
   */
  const phoneFix = async (): Promise<{ latitude: number; longitude: number } | null> => (await withTimeout(Promise.resolve(bridge.getAppLocation({ accuracy: AppLocationAccuracy.Medium, timeoutMs: 8000 })), LOCATION_TIMEOUT_MS).catch(() => null)) ?? (DEMO ? DEMO_PLACE : null);
  const refresh = async (): Promise<void> => {
    if (loading) return; loading = true; failure = null; if (forecast.source === "demo") status = "loading"; await draw(); renderPhone();
    where = await resolveLocation(storedSources(store, phoneFix));
    if (!where) status = "noLocation";
    else {
      try { forecast = await fetchForecast(where.position); status = "live"; fetchedAt = Date.now(); void refreshWarnings(); }
      catch (cause) { failure = errorKey(cause); if (forecast.source === "demo") status = "offline"; }
    }
    loading = false; last = ""; await draw(); renderPhone();
    // A radar page that was waiting for a place can load now.
    if (onRadar() && radar && radar.status() !== "ready") radar.reload();
    if (onCockpit() && radar && radar.status() !== "ready") radar.prepare();
  };
  const nextStep = (): string => loading && forecast.source === "demo" ? t("nextLoading") : status === "noLocation" ? t("nextNoLocation") : status === "offline" || failure ? t("nextOffline") : status === "live" ? t("nextLive", { place: placeName() }) : t("nextLoading");
  const currentSetting = (): string => { const mode = storedMode(store); const source = storedSources(store, async () => null); if (mode === "place" && source.place) return t("using", { place: source.place.label }); if (mode === "manual" && source.manual) return t("using", { place: `${source.manual.latitude}, ${source.manual.longitude}` }); return mode === "phone" ? t("usingPhone") : t("usingNone"); };
  /** Phone card for the cockpit's own gust alert (off by default). */
  const cockpitCard = (): string => {
    const current = gustLimit();
    const options = [`<option value=""${current === null ? " selected" : ""}>${escapeHtml(t("gustAlertOff"))}</option>`, ...GUST_CHOICES.map((speed) => `<option value="${speed}"${current === speed ? " selected" : ""}>${speed} km/h</option>`)];
    return `<section class="card compact"><h2>${escapeHtml(t("cockpit"))}</h2><label>${escapeHtml(t("gustAlert"))}<select id="gust">${options.join("")}</select></label><p class="hint">${escapeHtml(t("gustAlertHint"))}</p></section>`;
  };
  /** Phone tab "Brille": what the gestures do and the scroll direction. */
  const glassesCard = (): string => `<section class="card compact"><h2>${escapeHtml(t("controlsTitle"))}</h2><p class="hint">${[t("help1"), t("help2"), t("help3"), t("help2x")].map(escapeHtml).join("<br>")}</p><label class="check"><input id="invert" type="checkbox"${invertScroll() ? " checked" : ""}>${escapeHtml(t("invert"))}</label></section>`;
  const renderPhone = (): void => {
    const app = document.querySelector<HTMLDivElement>("#app"); if (!app) return; const mode = storedMode(store); const current = forecast.current; const today = forecast.daily[0];
    const weather = `<section class="card weather-card"><div class="status-row"><span class="status-dot ${forecast.source === "demo" ? "warn" : ""}"></span><strong>${t(forecast.source === "live" ? "live" : "demo")}</strong><time>${clock(current.time, locale)}</time></div><div class="weather-hero"><div><span>${condition(current.weatherCode)}</span><strong>${round(current.temperature)}</strong></div><p>${t("feels")} ${round(current.feelsLike)}</p></div><div class="weather-grid"><div><span>${t("humidity")}</span><b>${Math.round(current.humidity)}%</b></div><div><span>${t("wind")}</span><b>${windCompass(current.windDirection)} ${Math.round(current.windSpeed)}</b><small>km/h</small></div><div><span>${t("precipitation")}</span><b>${current.precipitation.toFixed(1)}</b><small>mm</small></div><div><span>${t("clouds")}</span><b>${Math.round(current.cloudCover)}%</b></div></div>${failure ? `<p class="error">${escapeHtml(errorText())}</p>` : ""}<button id="refresh">${t("refresh")}</button></section>`;
    const location = `<section class="card"><h2>${t("settings")}</h2><p class="hint">${escapeHtml(currentSetting())}</p><label class="check"><input id="automatic" type="checkbox"${mode === "phone" ? " checked" : ""}>${t("automatic")}</label><label>${t("place")}<input id="place" type="text" autocomplete="off" placeholder="${escapeHtml(t("placeHint"))}" value="${escapeHtml(query)}"></label><button id="search">${t("search")}</button>${searchNote ? `<p class="hint">${escapeHtml(searchNote)}</p>` : ""}${results.length ? `<div class="place-list">${results.map((place, index) => `<button class="place" data-index="${index}">${escapeHtml(place.label)}</button>`).join("")}</div>` : ""}</section>`;
    const advanced = `<section class="card advanced"><h2>${t("advanced")}</h2><label>${t("latitude")}<input id="lat" type="text" inputmode="decimal" value="${escapeHtml(appStore.get(KEYS.lat) ?? "")}"></label><label>${t("longitude")}<input id="lon" type="text" inputmode="decimal" value="${escapeHtml(appStore.get(KEYS.lon) ?? "")}"></label><button id="coords">${t("useCoords")}</button>${coordNote ? `<p class="error">${escapeHtml(coordNote)}</p>` : ""}<p class="hint">${t("help")}</p></section>`;
    const active = tab ?? (status === "noLocation" ? "place" : "weather");
    const chip = status === "noLocation" ? t("usingNone") : forecast.source === "demo" ? t("demo") : placeName();
    const hourly = `<section class="card"><div class="section-title"><h2>${t("hourly")}</h2><span>${t("chance")}</span></div><div class="hourly-strip">${forecast.hourly.slice(0, 8).map((hour) => `<div><time>${clock(hour.time, locale)}</time><b>${round(hour.temperature)}</b><span>${condition(hour.weatherCode)}</span><em>${Math.round(hour.precipitationProbability)}%</em></div>`).join("")}</div></section>`;
    const days = `<section class="card"><h2>${t("days")}</h2><div class="forecast-list">${forecast.daily.map((day) => `<div><b>${dayName(day.date, locale)}</b><span>${condition(day.weatherCode)}</span><em>${round(day.maximum)} / ${round(day.minimum)}</em><small>${Math.round(day.precipitationProbability)}%</small></div>`).join("")}</div>${today ? `<div class="sun-row"><span>${t("sun")}</span><b>${clock(today.sunrise, locale)} → ${clock(today.sunset, locale)}</b></div>` : ""}</section>`;
    app.innerHTML = `<header class="brand bar"><div><div class="brand-mark">QUIETGLASS / WEATHER</div><h1>RainLens</h1></div><span class="chip${status === "live" ? " on" : ""}">${escapeHtml(chip)}</span></header><p class="next">${escapeHtml(nextStep())}</p><div class="tab" data-tab="weather">${weather}${hourly}${days}</div><div class="tab" data-tab="place">${location}</div><div class="tab" data-tab="glasses">${glassesCard()}${cockpitCard()}</div><div class="tab" data-tab="more"><p class="hint lede">${t("lede")}</p><section class="card compact">${languageSelect(locale)}</section>${advanced}<p class="credits">${t("credits")} · ${t("creditsWarnings")}${RADAR ? ` · ${t("creditsRadar")}` : ""}</p></div><nav class="tabbar" role="tablist">${TABS.map(({ id, icon, key }) => `<button type="button" role="tab" data-tab-go="${id}"><span aria-hidden="true">${icon}</span>${escapeHtml(t(key))}</button>`).join("")}</nav>`;
    applyTab(app, active);
    app.querySelectorAll<HTMLButtonElement>("[data-tab-go]").forEach((button) => button.addEventListener("click", () => {
      tab = button.dataset.tabGo ?? "weather";
      try { localStorage.setItem(TAB_KEY, tab); } catch { /* private mode */ }
      applyTab(app, tab); window.scrollTo({ top: 0 });
    }));
    document.querySelector("#language")?.addEventListener("change", (event) => { locale = (event.target as HTMLSelectElement).value as Locale; rememberLocale(bridge, locale); last = ""; void draw(); renderPhone(); });
    document.querySelector("#refresh")?.addEventListener("click", () => { void refresh(); });
    document.querySelector("#invert")?.addEventListener("change", (event) => { appStore.set(INVERT_KEY, (event.target as HTMLInputElement).checked ? "1" : "0"); void draw(); });
    document.querySelector("#gust")?.addEventListener("change", (event) => { const value = (event.target as HTMLSelectElement).value; if (value) appStore.set(GUST_KEY, value); else appStore.remove(GUST_KEY); if (onCockpit()) void draw(); });
    document.querySelector("#automatic")?.addEventListener("change", (event) => { const checked = (event.target as HTMLInputElement).checked; const fallback = storedSources(store, async () => null).place ? "place" : "manual"; appStore.set(KEYS.mode, checked ? "phone" : fallback); void refresh(); });
    const search = async (): Promise<void> => {
      query = document.querySelector<HTMLInputElement>("#place")?.value ?? ""; results = [];
      if (!usableQuery(query)) { searchNote = t("tooShort"); renderPhone(); return; }
      searchNote = t("searching"); renderPhone();
      try { results = await searchPlaces(query, locale); searchNote = results.length ? t("pick") : t("noResults"); } catch { searchNote = t("geoError"); }
      renderPhone();
    };
    document.querySelector("#search")?.addEventListener("click", () => { void search(); });
    document.querySelector("#place")?.addEventListener("keydown", (event) => { if ((event as KeyboardEvent).key === "Enter") { event.preventDefault(); void search(); } });
    document.querySelectorAll<HTMLButtonElement>("button.place").forEach((button) => button.addEventListener("click", () => {
      const place = results[Number(button.dataset.index)]; if (!place) return;
      appStore.set(KEYS.place, JSON.stringify(place)); appStore.set(KEYS.mode, "place"); results = []; searchNote = ""; query = ""; void refresh();
    }));
    document.querySelector("#coords")?.addEventListener("click", () => {
      const lat = document.querySelector<HTMLInputElement>("#lat")?.value ?? ""; const lon = document.querySelector<HTMLInputElement>("#lon")?.value ?? "";
      if (!parseCoordinates(lat, lon)) { coordNote = t("badCoords"); renderPhone(); return; }
      coordNote = "";
      appStore.set(KEYS.lat, lat); appStore.set(KEYS.lon, lon); appStore.set(KEYS.mode, "manual"); void refresh();
    });
  };
  // Double tap opens the system exit dialog; the app keeps running. The call resolves when the dialog is SHOWN,
  // not when the user answered: its result never closes anything. A confirmed exit arrives as sysEvent 6/7 (onLifecycle).
  const requestExit = createExitRequest(bridge, {
    // The dialog took the page away: put it up again the way of the first one,
    // so the glasses deliver input (and the next 2x) to the app again.
    onBack: () => { if (closed) return; pageReady = false; last = ""; installed = null; forgetPage(bridge); return draw(); },
  }, "rainlens");
  exitAsked = requestExit.asked;
  const stale = (): boolean => Date.now() - fetchedAt >= REFRESH_MS;
  const startRefreshTimer = (): void => {
    clearInterval(refreshTimer);
    // Checked every minute, so a phone that slept through the 15 minutes catches up soon after.
    refreshTimer = setInterval(() => { if (!closed && !backgrounded && !loading && stale()) void refresh(); }, 60_000);
  };
  const goBackground = (): void => {
    backgrounded = true;
    helpOpen = false;
    clearInterval(refreshTimer);
    refreshTimer = undefined;
    radar?.stop();
    leaveCockpit();
  };
  const comeBack = (): Promise<void> => {
    backgrounded = false;
    pageReady = false; last = ""; installed = null;
    startRefreshTimer();
    if (onRadar()) radar?.start();
    if (onCockpit()) enterCockpit();
    const restore = draw();
    if (stale() && !loading) void refresh();
    return restore;
  };
  const onLifecycle = (step: ReturnType<typeof lifecycleFromEvent>): boolean => {
    if (step === null) return false;
    if (step === "foreground") comeBack();
    else if (step === "background") goBackground();
    else { goBackground(); closed = true; lane.close(); radarLane.close(); cockpitSender.close(); }
    return true;
  };
  /** Tap: the radar page reloads; the cockpit plays its loop (or reloads when there is none yet); elsewhere a refresh. */
  const onTap = (): void => {
    if (onRadar() && radar) { radar.reload(); return; }
    if (onCockpit()) {
      if (radar?.data()) { playLoop(); return; }
      if (radar && where) { radar.reload(); return; }
    }
    void refresh();
  };
  // Gestures first: nothing native (page creation, location) may delay them, or the glasses stay deaf.
  /** Side menu "Hilfe": the help page over whatever view is up (the cockpit's loop stops). */
  const openHelp = (): void => { stopPlaying(); helpOpen = true; void draw(); };
  const closeHelp = (): void => { helpOpen = false; last = ""; void draw(); };
  bridge.onEvenHubEvent((event) => {
    if (closed) return;
    // The 4/5 right after an exit call are the system dialog's own show/close, not the app entering/leaving.
    if (requestExit.onLifecycle(event) !== null) return;
    if (isBackSignal(event)) requestExit.back();
    if (onLifecycle(lifecycleFromEvent(event))) return;
    // QIS v1.2: help, refresh and the swipe setting come from the glasses' side menu, never from a gesture.
    const menuId = menuItemIdFromEvent(event);
    if (menuId !== null) {
      if (backgrounded) { comeBack(); return; }
      if (menuId === MENU.help) openHelp();
      else if (menuId === MENU.refresh) void refresh();
      else if (menuId === MENU.swipe) { appStore.set(INVERT_KEY, invertScroll() ? "0" : "1"); last = ""; void draw(); renderPhone(); }
      return;
    }
    const gesture = gestureFromEvent(event, { invertScroll: invertScroll() });
    if (!gesture) return;
    if (backgrounded) {
      const restore = comeBack();
      // A double tap while in the background means the app is on the glasses again: come back, then ask the dialog
      // (it waits for exactly this restore draw) instead of swallowing the tap.
      if (gesture.gesture === "doubleClick") void settleRestore(restore).then(() => requestExit());
      return;
    }
    // The help page is read-only: 2x is the only gesture there, and it goes back.
    if (helpOpen) { if (gesture.gesture === "doubleClick") closeHelp(); return; }
    // With the side menu on, a hold opens the system menu and the app does nothing on it. Without it (SIDE_MENU), a hold opens the help again.
    if (gesture.gesture === "longPress" || gesture.gesture === "longPressRelease") { if (!SIDE_MENU && gesture.gesture === "longPress") openHelp(); return; }
    if (gesture.gesture === "doubleClick") { void requestExit(); return; }
    if (gesture.gesture === "click") { onTap(); return; }
    if (gesture.gesture.startsWith("scroll")) {
      const was = onRadar(); const wasCockpit = onCockpit();
      page = gesture.gesture === "scrollDown" ? (page + 1) % pageCount : (page + pageCount - 1) % pageCount;
      last = ""; appStore.set(PAGE_KEY, String(page));
      if (was && !onRadar()) radar?.stop();
      if (!was && onRadar()) radar?.start();
      if (wasCockpit && !onCockpit()) leaveCockpit();
      if (!wasCockpit && onCockpit()) enterCockpit();
      void draw();
    }
  });
  bridge.onDeviceStatusChanged((status) => { if (status?.connectType === "connected" && !closed) { pageReady = false; last = ""; void draw(); } });
  // Back on the radar page after a restart: its loop starts like after a swipe.
  if (onRadar()) radar?.start();
  if (onCockpit()) enterCockpit();
  startRefreshTimer();
  await draw(); renderPhone(); void refresh();
}
void boot().catch((error: unknown) => console.error("[rainlens]", error));
