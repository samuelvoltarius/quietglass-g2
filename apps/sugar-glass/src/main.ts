import { waitForEvenAppBridge, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { settleRestore } from "./exit";
import { createClient, toApiError, type SugarApi } from "./ns/client";
import { createDemo, DEMO_SCENES, type DemoScene } from "./ns/demo";
import { EMPTY_TREATMENTS, type PumpStatus, type Reading, type Treatments } from "./ns/model";
import { rememberLocale, resolveLocale, getLocale, type Locale } from "./i18n";
import { gestureFromEvent, menuItemIdFromEvent, type Gesture } from "./input/gestures";
import { COCKPIT_TILES, createCockpitPage, createTextPage, forgetPage, guardedTileSend, updateTextPage, type TextView } from "./glasses/page";
import { PAGES, errorReason, startRows, startView, type Connection, type Page, type ViewState } from "./glasses/views";
import { cockpitModel } from "./cockpit/model";
import { composeCockpit, type CockpitModel } from "./cockpit/compose";
import { createTileSender } from "./screen/sender";
import { autoBackend, type TextBackend } from "./screen/text";
import { EMPTY_SETTINGS, effectiveUrl, loadSettings, saveSettings, type Settings } from "./storage/persist";
import { mountPhoneUi, type PhoneConnection } from "./ui/phone";

/** Shown in the phone page footer and logs; keep in step with app.json. */
export const BUILD = "0.4.0";

const params = new URLSearchParams(globalThis.location?.search ?? "");
const DEMO = params.get("demo") === "1";
const SCENE: DemoScene = DEMO_SCENES.includes(params.get("scene") as DemoScene) ? (params.get("scene") as DemoScene) : "normal";
/** `?page=2` opens the pump cockpit, `?page=1` the glucose cockpit (simulator screenshots); without it the start page. */
const START_PAGE = params.get("page") === null ? null : Math.max(0, Math.min(PAGES.length - 1, Number(params.get("page")) - 1)) || 0;

/** A sensor reports every 5 minutes; asking once a minute catches a new value within a minute. */
export const POLL_MS = 60_000;
/** Treatments (meals, boluses) change rarely. */
const TREATMENTS_MS = 5 * 60_000;
/** The cockpit is redrawn this often: the clock and the age stay current; an unchanged frame sends nothing. */
const TICK_MS = 15_000;
/** Four hours of readings (the curve shows three). */
const READINGS = 48;

async function boot(): Promise<void> {
  const bridge: EvenAppBridge = await waitForEvenAppBridge();

  // State first, with safe defaults: the gesture handler is registered before any
  // other native call is awaited, so the glasses can always be left (double tap).
  let settings: Settings = EMPTY_SETTINGS;
  let locale: Locale = getLocale();
  let api: SugarApi | null = null;
  let closed = false;
  let connection: Connection = { kind: "loading" };
  let readings: Reading[] | null = null;
  let pump: PumpStatus | null = null;
  let treatments: Treatments = EMPTY_TREATMENTS;
  let treatmentsAt = 0;
  /** What is on the glasses: the start page or the cockpit of `page`. */
  let screen: "start" | "cockpit" = START_PAGE === null ? "start" : "cockpit";
  let page: Page = PAGES[START_PAGE ?? 0] ?? "glucose";
  let startCursor = 0;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let tickTimer: ReturnType<typeof setInterval> | undefined;
  let polling = false;
  let generation = 0;
  let ready = false;
  /** First start without a server address: the values are a demo and the glasses say how to set up the real thing. */
  let demoStart = false;

  const viewState = (): ViewState => ({
    locale, demo: DEMO, connection,
    data: readings ? { readings, pump, treatments } : null,
    page, unit: settings.unit, limits: settings.limits,
    now: Date.now(),
    ...(demoStart ? { demoHint: true } : {}),
  });

  let lastView: TextView | null = null;
  let pageReady = false;
  /** Which kind of page the glasses carry: a change means one rebuild. */
  let installed: "text" | "cockpit" | null = null;
  let textBackend: TextBackend | null = null;
  let drawing: Promise<void> | null = null;
  let redrawQueued = false;

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
  /** The cockpit is one 576 x 288 frame; only the tiles whose pixels changed cross Bluetooth. Never while the dialog may be up. */
  const tiles = createTileSender(COCKPIT_TILES, guardedTileSend(bridge, () => !exitDialogAsked && !closed && installed === "cockpit"));

  const sameView = (a: TextView | null, b: TextView): boolean => a !== null && a.header === b.header && a.footer === b.footer && a.body.join("|") === b.body.join("|");

  const drawOnce = async (): Promise<void> => {
    if (exitDialogAsked) return;
    const state = viewState();
    if (screen === "cockpit") {
      const model: CockpitModel = cockpitModel(state);
      if (installed !== "cockpit") pageReady = false;
      if (!pageReady) {
        const result = await createCockpitPage(bridge);
        if (closed) return;
        if (!result.ok) { pageReady = false; console.warn("[sugarglass] draw failed:", result.reason); return; }
        pageReady = true; installed = "cockpit"; lastView = null;
        // A new page starts with blank images.
        tiles.reset();
      }
      textBackend ??= autoBackend();
      // Never awaited: a slow transfer must not hold up the next gesture.
      void tiles.push(composeCockpit(model, textBackend));
      return;
    }
    const view = startView(state, startCursor);
    // Leaving the cockpit: its containers are about to go, no tile may be written any more.
    if (installed === "cockpit") { installed = null; pageReady = false; }
    if (pageReady && sameView(lastView, view)) return;
    const result = pageReady ? await updateTextPage(bridge, view, lastView) : await createTextPage(bridge, view);
    if (closed) return;
    if (result.ok) { pageReady = true; installed = "text"; lastView = view; return; }
    pageReady = false;
    lastView = null;
    console.warn("[sugarglass] draw failed:", result.reason);
  };

  /** One draw at a time; requests meanwhile collapse into one redraw. */
  const draw = (): Promise<void> => {
    if (exitDialogAsked) return Promise.resolve();
    if (closed || !ready) return Promise.resolve();
    if (drawing) { redrawQueued = true; return drawing; }
    drawing = (async () => {
      try {
        do { redrawQueued = false; await drawOnce(); } while (redrawQueued && !closed);
      } catch (error) {
        console.warn("[sugarglass] draw failed:", error);
      } finally {
        drawing = null;
      }
    })();
    return drawing;
  };

  let refreshPhone: () => void = () => undefined;
  let phoneSignature = "";
  const updatePhone = (force = false): void => {
    const signature = JSON.stringify([phoneConnection(), readings?.[0]?.at ?? null, Math.floor(Date.now() / 60_000), locale, settings.unit, settings.invertScroll, pump?.at ?? null]);
    if (!force && signature === phoneSignature) return;
    const active = (globalThis.document as Document | undefined)?.activeElement as HTMLElement | null | undefined;
    if (!force && active?.matches?.("#app input, #app select")) return;
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

  const poll = async (): Promise<void> => {
    const client = api;
    if (polling || closed || !client) return;
    polling = true;
    const startedIn = generation;
    try {
      const next = await client.readings(READINGS);
      if (closed || generation !== startedIn) return;
      readings = next;
      connection = { kind: "ok" };
      // Pump and treatments are extras: their failure never hides the glucose value.
      try {
        pump = await client.pump();
      } catch (error) {
        console.warn("[sugarglass] devicestatus failed:", toApiError(error).code);
      }
      if (Date.now() - treatmentsAt >= TREATMENTS_MS) {
        try {
          treatments = await client.treatments(Date.now() - 24 * 3_600_000);
          treatmentsAt = Date.now();
        } catch (error) {
          console.warn("[sugarglass] treatments failed:", toApiError(error).code);
        }
      }
    } catch (error) {
      if (closed || generation !== startedIn) return;
      const problem = toApiError(error);
      connection = { kind: "error", code: problem.code, ...(problem.status ? { status: problem.status } : {}) };
    } finally {
      polling = false;
    }
    updatePhone();
    await draw();
  };

  const makeApi = (): SugarApi | null => {
    demoStart = false;
    if (DEMO) return createDemo(Date.now, SCENE);
    const url = effectiveUrl(settings);
    // QIS v1.2 no. 7: without an address the app starts in demo mode instead of an empty setup page.
    if (!url) { demoStart = true; return createDemo(Date.now, SCENE); }
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
        console.warn("[sugarglass] exit failed:", error);
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
    tiles.close();
  };

  /** Opens the row under the cursor of the start page. */
  const openStartRow = (): void => {
    const row = startRows()[startCursor];
    if (!row) return;
    screen = "cockpit";
    page = row.kind;
  };

  const onGesture = (gesture: Gesture): void => {
    // 2× only goes back (on the start page: the exit dialog); swipes only move; Hold has no function; nothing here changes data.
    if (screen === "start") {
      switch (gesture) {
        case "click": openStartRow(); break;
        case "scrollDown": startCursor = Math.min(startRows().length - 1, startCursor + 1); break;
        case "scrollUp": startCursor = Math.max(0, startCursor - 1); break;
        case "doubleClick": requestExit(); return;
        default: return;
      }
      void draw();
      return;
    }
    switch (gesture) {
      case "scrollDown":
      case "scrollUp": {
        const index = (PAGES.indexOf(page) + (gesture === "scrollDown" ? 1 : -1) + PAGES.length) % PAGES.length;
        page = PAGES[index] ?? "glucose";
        void draw();
        return;
      }
      case "click":
        treatmentsAt = 0;
        void poll();
        return;
      case "doubleClick":
        screen = "start";
        void draw();
        return;
      default:
        return;
    }
  };

  bridge.onEvenHubEvent((event) => {
    if (closed) return;
    const systemType = (event as { sysEvent?: { eventType?: number } }).sysEvent?.eventType;
    if (systemType === 6 || systemType === 7) { shutDown(); return; }
    if (systemType === 4 && dialogPending) {
      // The exit dialog came up: stay still, it is on screen now.
      dialogPending = false;
      dialogShown = true;
      exitDialogAsked = true;
      return;
    }
    if (systemType === 5 && dialogShown) {
      // "No": the dialog went away. The app never left - page up again the way of the first one, polling goes on.
      dialogShown = false;
      exitDialogAsked = true;
      exitBack();
      return;
    }
    // Audio events and sysEvent 8 are no user input: they leave the dialog state alone.
    if (systemType !== 8 && (event as { audioEvent?: unknown }).audioEvent === undefined) {
      dialogPending = false;
      dialogShown = false;
    }
    if (systemType !== 5) exitBack();
    // The glasses' side menu is off (SIDE_MENU): a menu click never runs anything.
    if (menuItemIdFromEvent(event) !== null) return;
    const parsed = gestureFromEvent(event, { invertScroll: settings.invertScroll });
    if (!parsed) return;
    // Before the first page exists only "leave" means anything.
    if (!ready) { if (parsed.gesture === "doubleClick") requestExit(); return; }
    onGesture(parsed.gesture);
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
  api = makeApi();
  connection = api ? { kind: "loading" } : { kind: "setup" };
  ready = true;

  await draw();
  startPolling();
  // Keeps the clock and the age of the value current; drawOnce writes only what changed.
  tickTimer = setInterval(() => { void draw(); updatePhone(); }, TICK_MS);

  const phone = mountPhoneUi({
    getSettings: () => settings,
    saveSettings: async (next) => {
      await saveSettings(bridge, next);
      const changed = next.url !== settings.url || next.token !== settings.token;
      settings = next;
      if (changed) {
        generation++;
        api = makeApi();
        readings = null;
        pump = null;
        treatments = EMPTY_TREATMENTS;
        treatmentsAt = 0;
        connection = api ? { kind: "loading" } : { kind: "setup" };
        startPolling();
      }
      updatePhone(true);
      await draw();
    },
    connection: phoneConnection,
    state: viewState,
    refresh: () => { treatmentsAt = 0; void poll(); },
    locale: () => locale,
    onLocaleChange: (next) => {
      locale = next;
      rememberLocale(bridge, next);
      void draw();
    },
    build: BUILD,
  });
  refreshPhone = phone.refresh;
  console.info("[sugarglass] " + BUILD + (DEMO ? " demo " + SCENE : ""));
}

void boot().catch((error: unknown) => {
  console.error("[sugarglass] failed to start:", error);
});
