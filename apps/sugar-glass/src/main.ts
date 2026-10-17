import { waitForEvenAppBridge, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { settleRestore } from "./exit";
import { createClient, toApiError, type SugarApi } from "./ns/client";
import { createDemo, DEMO_SCENES, type DemoScene } from "./ns/demo";
import { EMPTY_TREATMENTS, type PumpStatus, type Reading, type Treatments } from "./ns/model";
import { rememberLocale, resolveLocale, getLocale, type Locale } from "./i18n";
import { t } from "./messages";
import { gestureFromEvent, menuItemIdFromEvent, type Gesture } from "./input/gestures";
import { forgetPage, installPage, setPageMenu, updatePage, type MenuSpec } from "./glasses/render";
import { bitmapKey } from "./glasses/gfx";
import { ICON_STEP_MS } from "./glasses/charts";
import { PAGES, SIDE_MENU, buildFrames, buildView, errorReason, type Connection, type Frames, type Layout, type Page, type PageView, type ViewState } from "./glasses/views";
import { EMPTY_SETTINGS, effectiveUrl, loadSettings, saveSettings, type Settings } from "./storage/persist";
import { mountPhoneUi, type PhoneConnection } from "./ui/phone";

/** Shown in the phone page footer and logs; keep in step with app.json. */
export const BUILD = "0.3.6";

/** QIS v1.2: ids of the glasses side menu (Hold opens it). */
export const MENU = { help: 1, refresh: 2, swipe: 3 } as const;

const params = new URLSearchParams(globalThis.location?.search ?? "");
const DEMO = params.get("demo") === "1";
const SCENE: DemoScene = DEMO_SCENES.includes(params.get("scene") as DemoScene) ? (params.get("scene") as DemoScene) : "normal";
/** `?page=2` opens on the pump page (simulator screenshots). */
const START_PAGE = Math.max(0, Math.min(PAGES.length - 1, Number(params.get("page") ?? 1) - 1)) || 0;

/** A sensor reports every 5 minutes; asking once a minute catches a new value within a minute. */
export const POLL_MS = 60_000;
/** Treatments (meals, boluses) change rarely. */
const TREATMENTS_MS = 5 * 60_000;
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
  let page: Page = PAGES[START_PAGE] ?? "glucose";
  /** The help page is open (side menu); only 2× does anything there (back). */
  let helpOpen = false;
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
    page, help: helpOpen, unit: settings.unit, limits: settings.limits,
    now: Date.now(),
    ...(demoStart ? { demoHint: true } : {}),
  });

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

  const frameKey = (f: Frames): string => [f.icon, f.value, f.curve].map((b) => (b ? bitmapKey(b) : "-")).join("|");

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
  const drawOnce = async (): Promise<void> => {
    if (exitDialogAsked) return;
    const state = viewState();
    const view = buildView(state);
    const frames = buildFrames(state, view.layout);
    const key = frameKey(frames);
    const same = lastView && view.layout === lastView.layout && view.header === lastView.header && view.footer === lastView.footer
      && view.body.join("\n") === lastView.body.join("\n");
    const menu = menuSpec();
    if (pageReady && same && key === lastKey && menu.key === pageMenuKey) return;
    setPageMenu(menu);
    const result = !pageReady || view.layout !== lastLayout || menu.key !== pageMenuKey
      ? await installPage(bridge, view, frames)
      : await updatePage(bridge, view, frames, lastView);
    if (result.ok) { pageReady = true; lastView = view; lastLayout = view.layout; lastKey = key; pageMenuKey = menu.key; return; }
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
    const signature = JSON.stringify([phoneConnection(), readings?.[0]?.at ?? null, Math.floor(Date.now() / 60_000), locale, settings.unit, settings.invertScroll]);
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
  };

  const onGesture = (gesture: Gesture): void => {
    // QIS v1: the help page is read-only; 2× goes back to the page it came from.
    if (helpOpen) {
      if (gesture === "doubleClick") { helpOpen = false; void draw(); }
      return;
    }
    switch (gesture) {
      // Without a working side menu (SIDE_MENU): a hold opens the help.
      case "longPress":
        if (SIDE_MENU) return;
        helpOpen = true;
        void draw();
        return;
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
        requestExit();
        return;
      default:
        return;
    }
  };

  /** An item of the glasses side menu: help, refresh and the swipe direction never ride on a gesture. */
  const onMenu = (itemId: number): void => {
    switch (itemId) {
      case MENU.help: helpOpen = true; void draw(); break;
      case MENU.refresh: treatmentsAt = 0; void poll(); break;
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
    const menuId = menuItemIdFromEvent(event);
    if (menuId !== null) { if (ready) onMenu(menuId); return; }
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
  // The drop animates and alerts pulse; drawOnce writes only what changed.
  tickTimer = setInterval(() => { void draw(); updatePhone(); }, ICON_STEP_MS);

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
    newest: () => readings?.[0] ?? null,
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
