import { AppLocationAccuracy, waitForEvenAppBridge, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { createClient, toApiError, type StarApi } from "./nina/client";
import { createDemoNina, type DemoScene } from "./nina/demo";
import type { Command, StarStatus } from "./nina/status";
import { rememberLocale, resolveLocale, getLocale, type Locale } from "./i18n";
import { gestureFromEvent, menuItemIdFromEvent, type Gesture } from "./input/gestures";
import { lifecycleFromEvent } from "./lifecycle";
import { t } from "./messages";
import { installPage, setPageMenu, updatePage, type MenuSpec, type Preview } from "./glasses/render";
import { bitmapKey } from "./glasses/gfx";
import { ICON_STEP_MS } from "./glasses/charts";
import {
  PAGES, SIDE_MENU, buildFrames, buildView, controlRows, errorReason, type Connection, type Frames, type Layout, type Page, type PageView, type ViewState,
  type WeatherLocation, type WeatherView,
} from "./glasses/views";
import { EMPTY_SETTINGS, effectiveUrl, loadSettings, saveSettings, type Settings } from "./storage/persist";
import { mountPhoneUi, type PhoneConnection } from "./ui/phone";
import { fetchForecast, samePlace, validCoordinates, type Coordinates, type Forecast } from "./weather/forecast";
import { demoForecast } from "./weather/demo";
import { EMPTY_TRACKER, evaluateWeather, trackWarnings, type WeatherWarning } from "./weather/warnings";

/** Shown in the phone page footer and logs; keep in step with app.json. */
export const BUILD = "0.4.2";

/** QIS v1.2: ids of the glasses' side menu (Hold opens it). */
export const MENU = { help: 1, refresh: 2, swipe: 3 } as const;

const params = new URLSearchParams(globalThis.location?.search ?? "");
const DEMO = params.get("demo") === "1";
const SCENES: readonly DemoScene[] = ["run", "flip", "lost", "warm", "done"];
const SCENE: DemoScene = SCENES.includes(params.get("scene") as DemoScene) ? (params.get("scene") as DemoScene) : "run";
/** `?page=3` opens on that page (simulator screenshots). */
const START_PAGE = Math.max(0, Math.min(PAGES.length - 1, Number(params.get("page") ?? 1) - 1)) || 0;

/** How often the bridge is asked; the exposure is counted down locally in between. */
const POLL_MS = 4_000;
/** QIS v1: a second single tap within this long carries out the armed command. */
const ARM_MS = 4_000;
const MESSAGE_MS = 5_000;
/** The page on the glasses survives a restart of the app (phone locked, app unloaded). */
const PAGE_KEY = "quietglass.starglass.page.v1";
/** The forecast is renewed this often; a failed fetch is retried after RETRY. */
const WEATHER_REFRESH_MS = 15 * 60_000;
const WEATHER_RETRY_MS = 2 * 60_000;
/** Warnings are re-checked this often even without a bridge. */
const WEATHER_TICK_MS = 60_000;
/** A new weather warning stays in the header this long. */
const POPUP_MS = 15_000;
/** The phone's position is asked once per app start, never longer than this. */
const LOCATION_TIMEOUT_MS = 10_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(null); });
  });
}

async function boot(): Promise<void> {
  const bridge: EvenAppBridge = await waitForEvenAppBridge();

  // State first, with safe defaults: the gesture handler is registered before any
  // other native call is awaited, so the glasses can always be left (double tap).
  let settings: Settings = EMPTY_SETTINGS;
  let locale: Locale = getLocale();
  let api: StarApi | null = null;
  let closed = false;
  let connection: Connection = { kind: "loading" };
  let status: StarStatus | null = null;
  let receivedAt = 0;
  let page: Page = PAGES[START_PAGE] ?? "overview";
  let screen: "pages" | "control" | "help" = "pages";
  let cursor = 0;
  let armed: Command | null = null;
  let armTimer: ReturnType<typeof setTimeout> | undefined;
  let sending = false;
  let message = "";
  let messageTimer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let tickTimer: ReturnType<typeof setInterval> | undefined;
  let polling = false;
  let generation = 0;
  let preview: Preview | null = null;
  let fetchingPreview = "";
  let ready = false;
  /** First start without a bridge address: the night is a demo and the glasses say how to set up the real one. */
  let demoStart = false;
  /** Left through the system: no polling, no ticking, no drawing until the app is back. */
  let backgrounded = false;
  // Weather: forecast, where it is for, the warnings and the one popping up now.
  let forecast: Forecast | null = null;
  let weatherError: string | null = null;
  let weatherLocation: WeatherLocation = "pending";
  let phoneFix: Coordinates | null = null;
  let phoneAsked = false;
  let fetchingWeather = false;
  let lastWeatherTry = 0;
  let tracker = EMPTY_TRACKER;
  let warnings: WeatherWarning[] = [];
  let popup: WeatherWarning | null = null;
  let popupTimer: ReturnType<typeof setTimeout> | undefined;
  let weatherTimer: ReturnType<typeof setInterval> | undefined;

  const say = (text: string): void => {
    message = text;
    clearTimeout(messageTimer);
    if (text) messageTimer = setTimeout(() => { message = ""; void draw(); }, MESSAGE_MS);
  };
  const disarm = (): void => { armed = null; clearTimeout(armTimer); };

  const viewState = (): ViewState => ({
    locale, demo: DEMO, connection, status,
    ageSeconds: receivedAt ? (Date.now() - receivedAt) / 1000 : 0,
    page, screen, cursor, armed, sending, message,
    hasPreview: preview !== null,
    now: Date.now(),
    weather: weatherView(),
    ...(demoStart ? { demoHint: true } : {}),
  });

  const weatherView = (): WeatherView => ({
    enabled: settings.weather.enabled,
    forecast,
    warnings,
    popup,
    location: weatherLocation,
    error: weatherError,
    thresholds: settings.weather.thresholds,
  });

  /** Warnings from the forecast and N.I.N.A.'s station; a new one pops up in the header. */
  const evaluateNow = (): void => {
    const now = Date.now();
    const station = status?.online && !demoStart ? status.weather : null;
    warnings = settings.weather.enabled
      ? evaluateWeather({ now, forecast, station, thresholds: settings.weather.thresholds }, tracker.active)
      : [];
    const step = trackWarnings(tracker, warnings, now);
    tracker = step.tracker;
    const next = step.popups[0];
    if (next) {
      popup = next;
      clearTimeout(popupTimer);
      popupTimer = setTimeout(() => { popup = null; void draw(); }, POPUP_MS);
    } else if (popup && !warnings.some((w) => w.kind === popup?.kind)) {
      popup = null;
      clearTimeout(popupTimer);
    }
  };

  /** The phone's position, asked once, never blocking anything. */
  const askPhone = async (): Promise<Coordinates | null> => {
    if (phoneAsked) return phoneFix;
    phoneAsked = true;
    const ask = (bridge as Partial<Pick<EvenAppBridge, "getAppLocation">>).getAppLocation;
    if (typeof ask !== "function") return null;
    const fix = await withTimeout(Promise.resolve(ask.call(bridge, { accuracy: AppLocationAccuracy.Medium, timeoutMs: 8000 })), LOCATION_TIMEOUT_MS);
    const position = fix ? { latitude: fix.latitude, longitude: fix.longitude } : null;
    phoneFix = validCoordinates(position) ? position : null;
    return phoneFix;
  };

  /** N.I.N.A.'s site first, then coordinates typed on the phone, then the phone's position. */
  const resolvePosition = async (): Promise<{ position: Coordinates; source: WeatherLocation } | null> => {
    const site = status?.online && !demoStart ? status.site : null;
    if (site) return { position: site, source: "nina" };
    const typed = { latitude: settings.weather.latitude, longitude: settings.weather.longitude };
    if (validCoordinates(typed)) return { position: typed, source: "manual" };
    const fix = await askPhone();
    return fix ? { position: fix, source: "phone" } : null;
  };

  const maybeWeather = async (): Promise<void> => {
    if (closed || backgrounded || fetchingWeather) return;
    if (!settings.weather.enabled) { forecast = null; weatherError = null; return; }
    // Wait for the bridge's first answer: it may bring the site.
    if (api && !api.demo && status === null && connection.kind === "loading") return;
    const now = Date.now();
    if (DEMO) {
      if (!forecast || now - forecast.fetchedAt >= WEATHER_REFRESH_MS) forecast = demoForecast(now);
      weatherLocation = "nina";
      return;
    }
    fetchingWeather = true;
    try {
      const where = await resolvePosition();
      if (closed) return;
      if (!where) { weatherLocation = "none"; return; }
      weatherLocation = where.source;
      const due = !forecast || !samePlace(forecast.position, where.position) || now - forecast.fetchedAt >= WEATHER_REFRESH_MS;
      if (!due || (weatherError && now - lastWeatherTry < WEATHER_RETRY_MS)) return;
      lastWeatherTry = now;
      try {
        forecast = await fetchForecast(where.position);
        weatherError = null;
      } catch (error) {
        weatherError = error instanceof Error ? error.message : "unreachable";
        console.warn("[starglass] forecast failed:", weatherError);
      }
    } finally {
      fetchingWeather = false;
    }
  };

  const weatherTick = async (): Promise<void> => {
    await maybeWeather();
    if (closed || backgrounded) return;
    evaluateNow();
    updatePhone();
    await draw();
  };

  const startWeather = (): void => {
    clearInterval(weatherTimer);
    void weatherTick();
    weatherTimer = setInterval(() => { void weatherTick(); }, WEATHER_TICK_MS);
  };

  let lastView: PageView | null = null;
  let lastLayout: Layout | null = null;
  let lastKey = "";
  /** Key of the side menu the page on the glasses carries; a different one needs a rebuild. */
  let pageMenuKey = "";
  let pageReady = false;
  let drawing: Promise<void> | null = null;
  let redrawQueued = false;

  /** Off while its clicks do not arrive on the real glasses (SIDE_MENU, step log 15.10.2026): the pages carry no menu. QIS v1.2: Hold opens the side menu: Hilfe, Neu laden and the swipe direction (its label names the state, so a change rebuilds the page once). */
  const menuSpec = (): MenuSpec => SIDE_MENU ? ({
    key: `${locale}:${settings.invertScroll ? 1 : 0}`,
    items: [
      { id: MENU.help, label: t(locale, "m.help") },
      { id: MENU.refresh, label: t(locale, "m.refresh") },
      { id: MENU.swipe, label: t(locale, settings.invertScroll ? "m.swipeInverted" : "m.swipeNormal") },
    ],
  }) : { key: "none", items: [] };

  const frameKey = (f: Frames): string =>
    [f.icon, f.ring, f.panelA, f.panelB, f.chart].map((b) => (b ? bitmapKey(b) : "-")).join("|") + "|" + (preview?.key ?? "");

  const drawOnce = async (): Promise<void> => {
    const state = viewState();
    const view = buildView(state);
    const frames = buildFrames(state, view.layout);
    const key = frameKey(frames);
    const same = lastView && view.layout === lastView.layout && view.header === lastView.header && view.footer === lastView.footer
      && view.body.join("\n") === lastView.body.join("\n");
    const menu = menuSpec();
    if (pageReady && same && key === lastKey && menu.key === pageMenuKey) return;
    setPageMenu(menu);
    const shownPreview = view.layout === "image" ? preview : null;
    const result = !pageReady || view.layout !== lastLayout || menu.key !== pageMenuKey
      ? await installPage(bridge, view, frames, shownPreview)
      : await updatePage(bridge, view, frames, shownPreview, lastView);
    if (result.ok) { pageReady = true; lastView = view; lastLayout = view.layout; lastKey = key; pageMenuKey = menu.key; return; }
    pageReady = false;
    lastView = null;
    console.warn("[starglass] draw failed:", result.reason);
  };

  /** One draw at a time; requests meanwhile collapse into one redraw. */
  const draw = (): Promise<void> => {
    if (closed || !ready || backgrounded) return Promise.resolve();
    if (drawing) { redrawQueued = true; return drawing; }
    drawing = (async () => {
      try {
        do { redrawQueued = false; await drawOnce(); } while (redrawQueued && !closed);
      } catch (error) {
        console.warn("[starglass] draw failed:", error);
      } finally {
        drawing = null;
      }
    })();
    return drawing;
  };

  let refreshPhone: () => void = () => undefined;
  let phoneSignature = "";
  const updatePhone = (): void => {
    const signature = JSON.stringify([phoneConnection(), status?.online ? [status.sequence, status.controllable] : status, locale, settings.invertScroll, weatherLocation, forecast?.fetchedAt ?? 0, weatherError]);
    if (signature === phoneSignature) return;
    const active = (globalThis.document as Document | undefined)?.activeElement as HTMLElement | null | undefined;
    if (active?.matches?.("#app input, #app select")) return;
    phoneSignature = signature;
    refreshPhone();
  };
  const phoneConnection = (): PhoneConnection => {
    if (DEMO || demoStart) return { kind: "demo" };
    switch (connection.kind) {
      case "setup": return { kind: "none" };
      case "loading": return { kind: "loading" };
      case "ok": return { kind: "ok" };
      case "error": return { kind: "error", reason: errorReason(locale, connection.code, connection.status, true) };
    }
  };

  const reconcile = (): void => {
    const rows = controlRows(status);
    if (armed && !rows.includes(armed)) disarm();
    cursor = Math.min(cursor, rows.length - 1);
  };

  /** The newest frame is fetched only for the image page, and only when its key changed. */
  const loadPreview = async (): Promise<void> => {
    const client = api;
    const key = status?.online ? status.preview : null;
    if (!client || !key || page !== "image" || screen !== "pages" || preview?.key === key || fetchingPreview === key) return;
    fetchingPreview = key;
    const startedIn = generation;
    try {
      const bytes = await client.preview(key);
      if (closed || generation !== startedIn) return;
      preview = { key, bytes };
    } catch (error) {
      console.warn("[starglass] preview failed:", toApiError(error).code);
    } finally {
      fetchingPreview = "";
    }
    await draw();
  };

  const poll = async (): Promise<void> => {
    const client = api;
    if (polling || closed || backgrounded || !client) return;
    polling = true;
    const startedIn = generation;
    try {
      const next = await client.status();
      if (closed || generation !== startedIn) return;
      status = next;
      receivedAt = Date.now();
      connection = { kind: "ok" };
    } catch (error) {
      if (closed || generation !== startedIn) return;
      const problem = toApiError(error);
      connection = { kind: "error", code: problem.code, ...(problem.status ? { status: problem.status } : {}) };
    } finally {
      polling = false;
    }
    reconcile();
    evaluateNow();
    updatePhone();
    await draw();
    void loadPreview();
    // The first answer may bring N.I.N.A.'s site; a forecast that is due is fetched in the background.
    if (!forecast || (status?.online && status.site && !samePlace(forecast.position, status.site))) void weatherTick();
  };

  const send = async (command: Command): Promise<void> => {
    const client = api;
    if (!client || sending) return;
    disarm();
    sending = true;
    await draw();
    try {
      await client.command(command);
      if (closed) return;
      say(t(locale, "g.sent." + command));
    } catch (error) {
      if (closed) return;
      const problem = toApiError(error);
      // Without an answer the command may well have run: say so, and look at N.I.N.A. at once.
      say(problem.code === "timeout"
        ? t(locale, "g.unknownResult")
        : t(locale, "g.notSent", { reason: errorReason(locale, problem.code, problem.status) }));
    } finally {
      sending = false;
    }
    screen = "pages";
    await draw();
    await poll();
  };

  const makeApi = (): StarApi | null => {
    demoStart = false;
    if (DEMO) return createDemoNina(Date.now, SCENE);
    const url = effectiveUrl(settings);
    // QIS v1.2 no. 7: without an address the app starts in demo mode instead of an empty setup page.
    if (!url) { demoStart = true; return createDemoNina(Date.now, SCENE); }
    return createClient({ baseUrl: url, ...(settings.token ? { token: settings.token } : {}) });
  };

  const startPolling = (): void => {
    clearInterval(pollTimer);
    if (!api) return;
    void poll();
    pollTimer = setInterval(() => { void poll(); }, POLL_MS);
  };

  const requestExit = (): void => {
    bridge.shutDownPageContainer(1).then(
      (left) => { if (left === true) shutDown(); },
      (error: unknown) => { console.warn("[starglass] exit failed:", error); },
    );
  };
  const shutDown = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(pollTimer);
    clearInterval(tickTimer);
    clearInterval(weatherTimer);
    clearTimeout(armTimer);
    clearTimeout(messageTimer);
    clearTimeout(popupTimer);
  };

  const turn = (delta: number): void => {
    const index = (PAGES.indexOf(page) + delta + PAGES.length) % PAGES.length;
    page = PAGES[index] ?? "overview";
    if (!DEMO) void bridge.setLocalStorage(PAGE_KEY, page).catch(() => false);
    void loadPreview();
  };

  const onPages = (gesture: Gesture): void => {
    switch (gesture) {
      case "scrollDown": turn(1); break;
      case "scrollUp": turn(-1); break;
      case "click":
        if (controlRows(status).length > 1 && connection.kind === "ok") { screen = "control"; cursor = 0; disarm(); break; }
        void poll();
        return;
      // Without a working side menu (SIDE_MENU): a hold opens the help.
      case "longPress":
        if (SIDE_MENU) return;
        disarm();
        screen = "help";
        break;
      case "doubleClick":
        requestExit();
        return;
      default:
        return;
    }
    void draw();
  };

  /** The help page is read-only: 2× is the only gesture, and it goes back. */
  const onHelp = (gesture: Gesture): void => {
    if (gesture !== "doubleClick") return;
    screen = "pages";
    void draw();
  };

  const onControl = (gesture: Gesture): void => {
    const rows = controlRows(status);
    switch (gesture) {
      case "scrollUp":
      case "scrollDown":
        disarm();
        cursor = Math.max(0, Math.min(rows.length - 1, cursor + (gesture === "scrollDown" ? 1 : -1)));
        break;
      case "click": {
        if (sending) return;
        const row = rows[cursor];
        if (!row) return;
        if (row === "back") { disarm(); screen = "pages"; break; }
        if (armed === row) { void send(row); return; }
        armed = row;
        clearTimeout(armTimer);
        armTimer = setTimeout(() => { armed = null; void draw(); }, ARM_MS);
        break;
      }
      case "doubleClick":
        // Armed: 2× only cancels (the armed footer says so); otherwise it goes back.
        if (armed) { disarm(); break; }
        screen = "pages";
        break;
      default:
        return;
    }
    void draw();
  };

  const startTick = (): void => {
    clearInterval(tickTimer);
    // The sign animates and the exposure counts down; drawOnce writes only what changed.
    tickTimer = setInterval(() => { void draw(); }, ICON_STEP_MS);
  };
  const goBackground = (): void => {
    backgrounded = true;
    clearInterval(pollTimer);
    clearInterval(tickTimer);
    clearInterval(weatherTimer);
    pollTimer = undefined;
    tickTimer = undefined;
    weatherTimer = undefined;
    disarm();
    screen = "pages";
  };
  const comeBack = (): void => {
    backgrounded = false;
    if (!ready) return;
    pageReady = false;
    lastView = null;
    startTick();
    void draw();
    startPolling();
    startWeather();
  };

  /** An item of the glasses' side menu: help, refresh and the swipe direction never ride on a gesture. */
  const onMenu = (itemId: number): void => {
    switch (itemId) {
      case MENU.help: disarm(); screen = "help"; void draw(); break;
      case MENU.refresh: void poll(); void weatherTick(); break;
      case MENU.swipe: {
        const next = { ...settings, invertScroll: !settings.invertScroll };
        settings = next;
        void saveSettings(bridge, next).catch(() => undefined);
        updatePhone();
        void draw();
        break;
      }
      default: break;
    }
  };

  bridge.onEvenHubEvent((event) => {
    if (closed) return;
    const lifecycle = lifecycleFromEvent(event);
    if (lifecycle === "foreground") { comeBack(); return; }
    if (lifecycle === "background") { goBackground(); return; }
    if (lifecycle === "exit") { goBackground(); shutDown(); return; }
    const menuId = menuItemIdFromEvent(event);
    if (menuId !== null) {
      if (backgrounded) { comeBack(); return; }
      if (ready) onMenu(menuId);
      return;
    }
    const parsed = gestureFromEvent(event, { invertScroll: settings.invertScroll });
    if (!parsed) return;
    // A gesture means the app is on the glasses again, even if no "foreground" came first.
    if (backgrounded) { comeBack(); return; }
    // Before the first page exists only "leave" means anything.
    if (!ready) { if (parsed.gesture === "doubleClick") requestExit(); return; }
    if (screen === "control") onControl(parsed.gesture);
    else if (screen === "help") onHelp(parsed.gesture);
    else onPages(parsed.gesture);
  });

  bridge.onDeviceStatusChanged((device) => {
    if (device?.connectType === "connected" && !closed) {
      pageReady = false;
      lastView = null;
      void draw();
    }
  });

  settings = await loadSettings(bridge);
  locale = await resolveLocale(bridge);
  if (!DEMO && params.get("page") === null) {
    const saved = await bridge.getLocalStorage(PAGE_KEY).catch(() => "");
    if (PAGES.includes(saved as Page)) page = saved as Page;
  }
  api = makeApi();
  connection = api ? { kind: "loading" } : { kind: "setup" };
  ready = true;

  await draw();
  if (!backgrounded) { startPolling(); startTick(); startWeather(); }

  const phone = mountPhoneUi({
    getSettings: () => settings,
    saveSettings: async (next) => {
      await saveSettings(bridge, next);
      const changed = next.bridgeUrl !== settings.bridgeUrl || next.token !== settings.token;
      const weatherChanged = JSON.stringify(next.weather) !== JSON.stringify(settings.weather);
      settings = next;
      if (weatherChanged) {
        weatherError = null;
        lastWeatherTry = 0;
        if (!next.weather.enabled) { forecast = null; popup = null; }
        void weatherTick();
      }
      if (changed) {
        generation++;
        api = makeApi();
        status = null;
        receivedAt = 0;
        preview = null;
        screen = "pages";
        disarm();
        connection = api ? { kind: "loading" } : { kind: "setup" };
        startPolling();
      }
      await draw();
    },
    connection: phoneConnection,
    status: () => status,
    locale: () => locale,
    weather: () => ({ location: weatherLocation, fetchedAt: forecast?.fetchedAt ?? null, error: weatherError }),
    onLocaleChange: (next) => {
      locale = next;
      rememberLocale(bridge, next);
      void draw();
    },
  });
  refreshPhone = phone.refresh;
  console.info("[starglass] " + BUILD + (DEMO ? " demo " + SCENE : ""));
}

void boot().catch((error: unknown) => {
  console.error("[starglass] failed to start:", error);
});
