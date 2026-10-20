import { AppLocationAccuracy, waitForEvenAppBridge, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { settleRestore } from "./exit";
import { createClient, toApiError, type StarApi } from "./nina/client";
import { createDemoNina, type DemoScene } from "./nina/demo";
import type { Command, StarStatus } from "./nina/status";
import { rememberLocale, resolveLocale, getLocale, type Locale } from "./i18n";
import { gestureFromEvent, menuItemIdFromEvent, type Gesture } from "./input/gestures";
import { lifecycleFromEvent } from "./lifecycle";
import { t } from "./messages";
import { COCKPIT_TILES, createCockpitPage, createTextPage, forgetPage, guardedTileSend, updateTextPage, type MenuSpec } from "./glasses/render";
import { sceneFor } from "./glasses/scene";
import { decodePreview } from "./glasses/preview";
import { composeCockpit } from "./cockpit/compose";
import { createTileSender } from "./screen/sender";
import { autoBackend, type TextBackend } from "./screen/text";
import type { Frame } from "./screen/frame";
import {
  MODES, MODE_PAGES, PAGES, SIDE_MENU, controlRows, errorReason, modeOf,
  type Connection, type Page, type PageView, type Screen, type ViewState, type WeatherLocation, type WeatherView,
} from "./glasses/views";
import { EMPTY_SETTINGS, effectiveUrl, loadSettings, saveSettings, type Settings } from "./storage/persist";
import { mountPhoneUi, type PhoneConnection } from "./ui/phone";
import { fetchForecast, samePlace, validCoordinates, type Coordinates, type Forecast } from "./weather/forecast";
import { demoForecast } from "./weather/demo";
import { EMPTY_TRACKER, evaluateWeather, trackWarnings, type WeatherWarning } from "./weather/warnings";

/** Shown in the phone page footer and logs; keep in step with app.json. */
export const BUILD = "0.5.0";

const NL = String.fromCharCode(10);

/** QIS v1.2: ids of the glasses' side menu (Hold opens it). */
export const MENU = { refresh: 1, swipe: 2 } as const;

const params = new URLSearchParams(globalThis.location?.search ?? "");
const DEMO = params.get("demo") === "1";
const SCENES: readonly DemoScene[] = ["run", "flip", "lost", "warm", "done"];
const SCENE: DemoScene = SCENES.includes(params.get("scene") as DemoScene) ? (params.get("scene") as DemoScene) : "run";
/** `?page=3` opens the cockpit on that page (simulator screenshots); without it the start page. */
const START_PAGE: number | null = params.get("page") === null ? null : Math.max(0, Math.min(PAGES.length - 1, Number(params.get("page")) - 1)) || 0;

/** How often the bridge is asked; the exposure is counted down locally in between. */
const POLL_MS = 4_000;
/** QIS v1: a second single tap within this long carries out the armed command. */
const ARM_MS = 4_000;
const MESSAGE_MS = 5_000;
/** Where the user was on the glasses survives a restart of the app (phone locked, app unloaded). */
const UI_KEY = "quietglass.starglass.ui.v2";
/** The cockpit is redrawn this often: the clock and the countdown stay current; an unchanged frame sends nothing. */
const TICK_MS = 1_000;
/** The forecast is renewed this often; a failed fetch is retried after RETRY. */
const WEATHER_REFRESH_MS = 15 * 60_000;
const WEATHER_RETRY_MS = 2 * 60_000;
/** Warnings are re-checked this often even without a bridge. */
const WEATHER_TICK_MS = 60_000;
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
  let page: Page = PAGES[START_PAGE ?? 0] ?? "overview";
  let screen: Screen = START_PAGE === null ? "start" : "run";
  let startCursor = 0;
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
  /** The newest camera frame as grey levels, with the bridge's key for it. */
  let preview: { readonly key: string; readonly frame: Frame | null } | null = null;
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
    screen, page, startCursor, cursor, armed, sending, message,
    hasPreview: preview?.frame != null,
    now: Date.now(),
    weather: weatherView(),
    ...(demoStart ? { demoHint: true } : {}),
  });

  const weatherView = (): WeatherView => ({
    enabled: settings.weather.enabled,
    forecast,
    warnings,
    location: weatherLocation,
    error: weatherError,
    thresholds: settings.weather.thresholds,
  });

  /** Warnings from the forecast and N.I.N.A.'s station; the headline and the start page show the first. */
  const evaluateNow = (): void => {
    const now = Date.now();
    const station = status?.online && !demoStart ? status.weather : null;
    warnings = settings.weather.enabled
      ? evaluateWeather({ now, forecast, station, thresholds: settings.weather.thresholds }, tracker.active)
      : [];
    tracker = trackWarnings(tracker, warnings, now).tracker;
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
  /** Which kind of page the glasses carry: a change means one rebuild. */
  let installed: "text" | "cockpit" | null = null;
  /** Key of the side menu the page on the glasses carries; a different one needs a rebuild. */
  let pageMenuKey = "";
  let pageReady = false;
  let drawing: Promise<void> | null = null;
  let redrawQueued = false;
  let textBackend: TextBackend | null = null;

  /** Off while its clicks do not arrive on the real glasses (SIDE_MENU, step log 15.10.2026): the pages carry no menu. Hold would open the side menu: Neu laden and the swipe direction (its label names the state, so a change rebuilds the page once). */
  const menuSpec = (): MenuSpec => SIDE_MENU ? ({
    key: `${locale}:${settings.invertScroll ? 1 : 0}`,
    items: [
      { id: MENU.refresh, label: t(locale, "m.refresh") },
      { id: MENU.swipe, label: t(locale, settings.invertScroll ? "m.swipeInverted" : "m.swipeNormal") },
    ],
  }) : { key: "none", items: [] };

  // While the exit dialog may be on screen (asked, no input since) no timer, poll or stream may draw: a page call
  // could cover it. Data keeps being collected; the back signal restores the page the way of the first one.
  let exitDialogAsked = false;
  /**
   * The system dialog's own lifecycle (step log, Klipper 0.5.11): right after shutDownPageContainer(1) the glasses
   * send FOREGROUND_ENTER (4) when the dialog comes up and FOREGROUND_EXIT (5) when it goes away after "No" - not
   * the app entering or leaving. Between the call and the 5 nothing is drawn; the 5 puts the page up again.
   */
  let dialogPending = false;
  let dialogShown = false;

  /**
   * The cockpit is one 576 x 288 frame; only the tiles whose pixels changed cross Bluetooth. Never while the
   * dialog may be up (asked, or the call is out and the dialog not yet announced), never after the cockpit page
   * was left (its containers are gone), never in the background.
   */
  const tiles = createTileSender(COCKPIT_TILES, guardedTileSend(bridge, () => !exitDialogAsked && !dialogPending && !closed && !backgrounded && installed === "cockpit"));

  const drawOnce = async (): Promise<void> => {
    if (exitDialogAsked) return;
    const scene = sceneFor(viewState());
    const menu = menuSpec();
    if (scene.kind === "cockpit") {
      if (installed !== "cockpit" || (pageReady && menu.key !== pageMenuKey)) pageReady = false;
      if (!pageReady) {
        const result = await createCockpitPage(bridge, menu);
        if (closed) return;
        if (!result.ok) { pageReady = false; lastView = null; console.warn("[starglass] draw failed:", result.reason); return; }
        pageReady = true;
        installed = "cockpit";
        pageMenuKey = menu.key;
        lastView = null;
        // A new page starts with blank images.
        tiles.reset();
      }
      textBackend ??= autoBackend();
      const shown = scene.model.graphic.kind === "preview" && preview?.frame ? preview.frame : null;
      // Never awaited: a slow transfer must not hold up the next gesture.
      void tiles.push(composeCockpit(scene.model, textBackend, { preview: shown }));
      return;
    }
    // Leaving the cockpit: its containers are about to go, no tile may be written any more.
    if (installed === "cockpit") { installed = null; pageReady = false; }
    if (pageReady && menu.key !== pageMenuKey) pageReady = false;
    const view = scene.view;
    const same = lastView !== null && view.header === lastView.header && view.footer === lastView.footer && view.body.join(NL) === lastView.body.join(NL);
    if (pageReady && same) return;
    const result = pageReady ? await updateTextPage(bridge, view, lastView) : await createTextPage(bridge, view, menu);
    if (closed) return;
    if (result.ok) { pageReady = true; installed = "text"; pageMenuKey = menu.key; lastView = view; return; }
    pageReady = false;
    lastView = null;
    console.warn("[starglass] draw failed:", result.reason);
  };

  /** One draw at a time; requests meanwhile collapse into one redraw. */
  const draw = (): Promise<void> => {
    if (exitDialogAsked) return Promise.resolve();
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
  let refreshPhoneLive: () => void = () => undefined;
  let phoneSignature = "";
  /** The phone: the live parts (status, hero, strips) follow every answer; the whole page only redraws when settings-relevant state changed. */
  const updatePhone = (): void => {
    refreshPhoneLive();
    const signature = JSON.stringify([phoneConnection(), status?.online ? status.controllable : status, locale, settings.invertScroll, weatherLocation, forecast?.fetchedAt ?? 0, weatherError]);
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
    if (!client || !key || page !== "image" || screen !== "run" || preview?.key === key || fetchingPreview === key) return;
    fetchingPreview = key;
    const startedIn = generation;
    try {
      const bytes = await client.preview(key);
      if (closed || generation !== startedIn) return;
      const frame = await decodePreview(bytes);
      if (closed || generation !== startedIn) return;
      preview = { key, frame };
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
    screen = "run";
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

  // shutDownPageContainer(1) resolves when the dialog is SHOWN (hardware: ~58 ms after the double tap), not when
  // the user answered, so the result never tears the app down. If the user confirms, the system ends the app
  // (sysEvent 6/7 below). After "No" the app has to be alive: on the next signal that it is back (any input,
  // FOREGROUND_ENTER) the page is put up again the way of the first one, then the event is handled normally.
  /** The restore started by the last exitBack(), while it is still running. */
  let restoring: Promise<void> | null = null;
  const exitBack = (): void => {
    if (!exitDialogAsked) return;
    exitDialogAsked = false;
    if (closed) return;
    pageReady = false;
    lastView = null;
    installed = null;
    forgetPage(bridge);
    const run = draw().catch(() => undefined);
    restoring = run;
    void run.then(() => { if (restoring === run) restoring = null; });
  };
  const requestExit = (): void => {
    // A second double tap before any restore: put the page back first, then ask again.
    exitBack();
    // The first double tap after "No" is the back signal itself: a dialog call issued while the page is still being
    // created is lost (hardware, Klipper 0.5.8). So it waits for the restore and a short settle delay.
    const restore = restoring;
    const ask = async (): Promise<void> => {
      dialogPending = true;
      try {
        await bridge.shutDownPageContainer(1);
      } catch (error: unknown) {
        console.warn("[starglass] exit failed:", error);
      }
      exitDialogAsked = true;
    };
    // Without a restore in flight the host is called at once, in this very event.
    if (restore) void settleRestore(restore).then(ask);
    else void ask();
  };
  const shutDown = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(pollTimer);
    clearInterval(tickTimer);
    clearInterval(weatherTimer);
    clearTimeout(armTimer);
    clearTimeout(messageTimer);
    tiles.close();
  };

  /** Where the user is on the glasses is remembered; a restart after a locked phone comes back there. */
  let savedUi = "";
  const saveUi = (): void => {
    if (DEMO) return;
    const json = JSON.stringify({ screen: screen === "start" ? "start" : "run", page, startCursor });
    if (json === savedUi) return;
    savedUi = json;
    void bridge.setLocalStorage(UI_KEY, json).catch(() => false);
  };

  /** A swipe walks through the pages of the open mode. */
  const turn = (delta: number): void => {
    const pages = MODE_PAGES[modeOf(page)];
    page = pages[Math.max(0, Math.min(pages.length - 1, pages.indexOf(page) + delta))] ?? page;
    void loadPreview();
  };

  /** The start page: at most three entries; tap opens, 2× leaves the app. */
  const onStart = (gesture: Gesture): void => {
    switch (gesture) {
      case "scrollDown": startCursor = Math.min(MODES.length - 1, startCursor + 1); break;
      case "scrollUp": startCursor = Math.max(0, startCursor - 1); break;
      case "click": {
        const mode = MODES[Math.min(startCursor, MODES.length - 1)] ?? "capture";
        page = MODE_PAGES[mode][0] ?? "overview";
        screen = "run";
        void loadPreview();
        break;
      }
      case "doubleClick":
        requestExit();
        return;
      default:
        return;
    }
    saveUi();
    void draw();
  };

  /** A cockpit page: swipe = page, tap = control (imaging, if allowed) or refresh, 2× = back to the start page. */
  const onRun = (gesture: Gesture): void => {
    switch (gesture) {
      case "scrollDown": turn(1); break;
      case "scrollUp": turn(-1); break;
      case "click":
        if (modeOf(page) === "capture" && connection.kind === "ok" && controlRows(status).length > 1) { screen = "control"; cursor = 0; disarm(); break; }
        void poll();
        if (page === "weather") void weatherTick();
        return;
      case "doubleClick":
        disarm();
        screen = "start";
        break;
      default:
        return;
    }
    saveUi();
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
        if (row === "back") { disarm(); screen = "run"; break; }
        if (armed === row) { void send(row); return; }
        armed = row;
        clearTimeout(armTimer);
        armTimer = setTimeout(() => { armed = null; void draw(); }, ARM_MS);
        break;
      }
      case "doubleClick":
        // Armed: 2× only cancels (the armed footer says so); otherwise it goes back.
        if (armed) { disarm(); break; }
        screen = "run";
        break;
      default:
        return;
    }
    void draw();
  };

  const startTick = (): void => {
    clearInterval(tickTimer);
    // The clock and the countdown move; drawOnce sends only the tiles whose pixels changed.
    tickTimer = setInterval(() => { void draw(); }, TICK_MS);
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
    if (screen === "control") screen = "run";
    saveUi();
  };
  const comeBack = (): void => {
    backgrounded = false;
    if (!ready) return;
    pageReady = false;
    lastView = null;
    installed = null;
    startTick();
    void draw();
    startPolling();
    startWeather();
  };

  /** An item of the glasses' side menu (off while SIDE_MENU is false): refresh and the swipe direction. */
  const onMenu = (itemId: number): void => {
    switch (itemId) {
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
    if (lifecycle === "foreground" && dialogPending) {
      // The exit dialog came up: stay still, it is on screen now.
      dialogPending = false;
      dialogShown = true;
      exitDialogAsked = true;
      return;
    }
    if (lifecycle === "background" && dialogShown) {
      // "No": the dialog went away. The app never left - page up again the way of the first one, timers go on.
      dialogShown = false;
      exitDialogAsked = true;
      exitBack();
      return;
    }
    dialogPending = false;
    dialogShown = false;
    if (lifecycle !== "background" && lifecycle !== "exit") exitBack();
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
    // A 2x on the root page still asks to leave: swallowing it after "No" left the dialog closed (store review).
    if (backgrounded) { comeBack(); if (!(parsed.gesture === "doubleClick" && screen === "start")) return; }
    // Before the first page exists only "leave" means anything.
    if (!ready) { if (parsed.gesture === "doubleClick") requestExit(); return; }
    if (screen === "control") onControl(parsed.gesture);
    else if (screen === "run") onRun(parsed.gesture);
    else onStart(parsed.gesture);
  });

  bridge.onDeviceStatusChanged((device) => {
    if (device?.connectType === "connected" && !closed) {
      pageReady = false;
      lastView = null;
      installed = null;
      void draw();
    }
  });

  settings = await loadSettings(bridge);
  locale = await resolveLocale(bridge);
  if (!DEMO && params.get("page") === null) {
    // Back where the user was before a restart: the start page, or the cockpit page they were on. The control list is never restored.
    try {
      const saved = JSON.parse(await bridge.getLocalStorage(UI_KEY).catch(() => "") || "{}") as Record<string, unknown>;
      if (typeof saved["startCursor"] === "number" && saved["startCursor"] >= 0 && saved["startCursor"] < MODES.length) startCursor = Math.floor(saved["startCursor"]);
      if (saved["screen"] === "run" && PAGES.includes(saved["page"] as Page)) { page = saved["page"] as Page; screen = "run"; }
    } catch { /* a damaged value: the start page */ }
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
        if (!next.weather.enabled) forecast = null;
        void weatherTick();
      }
      if (changed) {
        generation++;
        api = makeApi();
        status = null;
        receivedAt = 0;
        preview = null;
        if (screen === "control") screen = "run";
        disarm();
        connection = api ? { kind: "loading" } : { kind: "setup" };
        startPolling();
      }
      await draw();
    },
    connection: phoneConnection,
    status: () => status,
    locale: () => locale,
    weather: () => ({ location: weatherLocation, fetchedAt: forecast?.fetchedAt ?? null, error: weatherError, forecast, warnings }),
    refresh: () => { void poll(); void weatherTick(); },
    version: BUILD,
    onLocaleChange: (next) => {
      locale = next;
      rememberLocale(bridge, next);
      void draw();
    },
  });
  refreshPhone = phone.refresh;
  refreshPhoneLive = phone.refreshLive;
  console.info("[starglass] " + BUILD + (DEMO ? " demo " + SCENE : ""));
}

void boot().catch((error: unknown) => {
  console.error("[starglass] failed to start:", error);
});
