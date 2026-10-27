import { waitForEvenAppBridge, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { settleRestore } from "./exit";
import { LONG_POLL_S, createClient, toApiError, type CarApi } from "./car/client";
import { createDemo, DEMO_SCENES, type DemoScene } from "./car/demo";
import { sortWarnings, warningKey, type CarState, type CarWarning } from "./car/model";
import { rememberLocale, resolveLocale, getLocale, type Locale } from "./i18n";
import { gestureFromEvent, menuItemIdFromEvent, type Gesture } from "./input/gestures";
import { COCKPIT_TILES, forgetPage, guardedTileSend, installPage, updatePage, type MenuSpec } from "./glasses/render";
import { t } from "./messages";
import { SIDE_MENU } from "./side-menu";
import { ICON_STEP_MS, buildView, errorReason, type Connection, type Layout, type PageView, type ViewState } from "./glasses/views";
import { cockpitModel } from "./cockpit/model";
import { composeCockpit } from "./cockpit/compose";
import { createTileSender } from "./screen/sender";
import { autoBackend, type TextBackend } from "./screen/text";
import {
  CONFIRM_WINDOW_MS, INITIAL_CONTROL, PAGES, cancelControl, controlBusy, controlItems, expireControl, followMode, itemAction, moveCursor,
  openArm, startPageFor, stepPage, tapControl, type ControlItem, type ControlState, type Page,
} from "./pages";
import { EMPTY_SETTINGS, effectiveUrl, loadSettings, saveSettings, type Settings } from "./storage/persist";
import { mountPhoneUi, type PhoneConnection } from "./ui/phone";

/** Shown in the phone page footer and logs; keep in step with app.json. */
export const BUILD = "0.7.0";

/** Side menu id (QIS v1.2): Hilfe. The app has no settings of its own on the glasses. */
export const MENU_HELP = 1;
export function sideMenu(locale: Locale): MenuSpec {
  if (!SIDE_MENU) return { items: [] };
  return { items: [{ id: MENU_HELP, label: t(locale, "g.menu.help") }] };
}

const params = new URLSearchParams(globalThis.location?.search ?? "");
const FORCE_DEMO = params.get("demo") === "1";
const SCENE: DemoScene = DEMO_SCENES.includes(params.get("scene") as DemoScene) ? (params.get("scene") as DemoScene) : "tour";
/** `?page=charge` opens on that page and keeps it (simulator screenshots). */
const FORCED_PAGE: Page | null = PAGES.includes(params.get("page") as Page) ? (params.get("page") as Page) : null;

/** A warning overlay stays this long unless tapped away. */
export const OVERLAY_MS = 8_000;
/** Demo values change every second. */
const DEMO_STEP_MS = 1_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function boot(): Promise<void> {
  const bridge: EvenAppBridge = await waitForEvenAppBridge();

  // State first, with safe defaults: the gesture handler is registered before any
  // other native call is awaited, so the glasses can always be left (double tap).
  let settings: Settings = EMPTY_SETTINGS;
  let locale: Locale = getLocale();
  let api: CarApi | null = null;
  let closed = false;
  let connection: Connection = { kind: "loading" };
  let car: CarState | null = null;
  let page: Page = FORCED_PAGE ?? "status";
  /** The control page: cursor, open question (second tap), result line. */
  let control: ControlState = INITIAL_CONTROL;
  let overlay: CarWarning[] | null = null;
  let overlayUntil = 0;
  let seen = new Set<string>();
  /** The help page is open (ring hold; never offered in a footer). */
  let helpOpen = false;
  let generation = 0;
  let ready = false;
  let tickTimer: ReturnType<typeof setInterval> | undefined;

  const viewState = (): ViewState => ({
    locale, demo: api?.demo ?? false, connection, car, page, overlay, help: helpOpen, control, now: Date.now(),
  });

  let lastView: PageView | null = null;
  let lastLayout: Layout | null = null;
  let pageReady = false;
  let drawing: Promise<void> | null = null;
  let redrawQueued = false;

  // While the exit dialog may be on screen (asked, no input since) no timer, poll or stream may draw: a page call
  // could cover it. Data keeps being collected; the back signal restores the page the way of the first one.
  let exitDialogAsked = false;
  // The system dialog's own lifecycle (step log, Klipper 0.5.11): right after shutDownPageContainer(1) the glasses
  // send FOREGROUND_ENTER (4) when the dialog comes up and FOREGROUND_EXIT (5) when it goes away after "No".
  let dialogPending = false;
  let dialogShown = false;
  /** True while the car cockpit is the page on the glasses: only then may a tile be written. */
  let cockpitPage = false;
  let textBackend: TextBackend | null = null;
  /**
   * The cockpit is one 576 x 288 frame; only the tiles whose pixels changed cross Bluetooth. The write is refused
   * while the exit dialog may be on screen (asked, pending or shown), after the app closed and whenever the page
   * is not the cockpit - a tile write could cover the dialog or land on containers that are gone.
   */
  const tileSender = createTileSender(COCKPIT_TILES, guardedTileSend(bridge, () => !exitDialogAsked && !dialogPending && !dialogShown && !closed && cockpitPage && pageReady));
  const drawOnce = async (): Promise<void> => {
    if (exitDialogAsked) return;
    const state = viewState();
    const view = buildView(state);
    if (view.layout === "cockpit") {
      if (!pageReady || lastLayout !== "cockpit") {
        cockpitPage = false;
        const installed = await installPage(bridge, view, sideMenu(locale));
        if (!installed.ok) {
          pageReady = false;
          lastView = null;
          console.warn("[bydglass] draw failed:", installed.reason);
          return;
        }
        pageReady = true; lastView = view; lastLayout = "cockpit";
        cockpitPage = true;
        // A new page starts with blank images.
        tileSender.reset();
      }
      textBackend ??= autoBackend();
      // Never awaited: a slow transfer must not hold up the next gesture.
      void tileSender.push(composeCockpit(cockpitModel(state), textBackend));
      return;
    }
    cockpitPage = false;
    const same = lastView && view.layout === lastView.layout && view.header === lastView.header && view.footer === lastView.footer
      && view.body.join("\n") === lastView.body.join("\n");
    if (pageReady && same) return;
    const result = !pageReady || view.layout !== lastLayout
      ? await installPage(bridge, view, sideMenu(locale))
      : await updatePage(bridge, view, lastView);
    if (result.ok) { pageReady = true; lastView = view; lastLayout = view.layout; return; }
    pageReady = false;
    lastView = null;
    console.warn("[bydglass] draw failed:", result.reason);
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
        console.warn("[bydglass] draw failed:", error);
      } finally {
        drawing = null;
      }
    })();
    return drawing;
  };

  let refreshPhone: () => void = () => undefined;
  let phoneSignature = "";
  const phoneConnection = (): PhoneConnection => {
    if (api?.demo) return { kind: "demo" };
    if (connection.kind === "error") return { kind: "error", reason: errorReason(locale, connection.code, connection.status, true) };
    return car ? { kind: "ok" } : { kind: "loading" };
  };
  const updatePhone = (force = false): void => {
    const signature = JSON.stringify([phoneConnection(), car?.mode, car?.battery.soc, car?.battery.rangeKm, car?.stale,
      car?.warnings.map(warningKey), car?.control, car?.command, Math.floor(Date.now() / 60_000), locale]);
    if (!force && signature === phoneSignature) return;
    const active = (globalThis.document as Document | undefined)?.activeElement as HTMLElement | null | undefined;
    if (!force && active?.matches?.("#app input, #app select")) return;
    phoneSignature = signature;
    refreshPhone();
  };

  /** New car state: follow the mode to its page, pop up new warnings. */
  const apply = (next: CarState): void => {
    const previous = car?.mode ?? null;
    const now = Date.now();
    car = next;
    connection = { kind: "ok" };
    if (!FORCED_PAGE) page = followMode(previous, next.mode, page, controlBusy(control, now));
    // The bridge switched control off: the page goes away and nothing stays armed.
    if (!next.control.enabled && (page === "control" || control !== INITIAL_CONTROL)) {
      if (page === "control") page = startPageFor(next.mode);
      control = INITIAL_CONTROL;
    }
    const keys = new Set(next.warnings.map(warningKey));
    const fresh = next.warnings.filter((w) => !seen.has(warningKey(w)));
    seen = keys;
    if (fresh.length > 0) {
      overlay = sortWarnings(next.warnings);
      overlayUntil = now + OVERLAY_MS;
    } else if (overlay) {
      // Keep showing only what is still true.
      overlay = overlay.filter((w) => keys.has(warningKey(w)));
      if (overlay.length === 0) overlay = null;
    }
  };

  const loop = async (gen: number): Promise<void> => {
    let backoff = 2_000;
    while (!closed && gen === generation && api) {
      const client = api;
      try {
        const next = await client.state(client.demo ? null : car?.rev ?? null, LONG_POLL_S);
        if (closed || gen !== generation) return;
        apply(next);
        backoff = 2_000;
        updatePhone();
        await draw();
        if (client.demo) await sleep(DEMO_STEP_MS);
      } catch (error) {
        if (closed || gen !== generation) return;
        const problem = toApiError(error);
        connection = { kind: "error", code: problem.code, ...(problem.status ? { status: problem.status } : {}) };
        updatePhone();
        await draw();
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  };

  const makeApi = (): CarApi => {
    const url = effectiveUrl(settings);
    if (FORCE_DEMO || !url) return createDemo(Date.now, SCENE);
    return createClient({ baseUrl: url });
  };

  const start = (): void => {
    generation += 1;
    api = makeApi();
    car = null;
    seen = new Set();
    overlay = null;
    control = INITIAL_CONTROL;
    connection = { kind: "loading" };
    void loop(generation);
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
        console.warn("[bydglass] exit failed:", error);
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
    tileSender.close();
    generation += 1;
    clearInterval(tickTimer);
  };

  /** First tap: the bridge checks every guard and sends nothing; a yes opens the 4 s window for the second tap. */
  const runArm = async (item: ControlItem): Promise<void> => {
    const client = api;
    const gen = generation;
    if (!client) return;
    const { action, minutes } = itemAction(item);
    control = { ...control, busy: { item, step: "arm" }, armed: null, result: null, touchedAt: Date.now() };
    void draw();
    try {
      const reply = await client.arm(action, minutes);
      if (gen !== generation || closed) return;
      const now = Date.now();
      control = reply.ok && reply.armed
        ? { ...control, busy: null, armed: { item, token: reply.armed, until: now + CONFIRM_WINDOW_MS }, touchedAt: now }
        : { ...control, busy: null, result: { item, kind: "refused", code: reply.error ?? "other", message: reply.message, at: now }, touchedAt: now };
    } catch (error) {
      if (gen !== generation || closed) return;
      control = { ...control, busy: null, result: { item, kind: "failed", reason: toApiError(error).code === "auth" ? "auth" : "unreachable", at: Date.now() } };
    }
    void draw();
  };

  /** Second tap in time: the bridge checks everything again, then sends. Only its `command` says confirmed. */
  const runConfirm = async (item: ControlItem, token: string): Promise<void> => {
    const client = api;
    const gen = generation;
    if (!client) return;
    const { action, minutes } = itemAction(item);
    const at = Date.now();
    control = { ...control, busy: { item, step: "confirm" }, armed: null, result: null, touchedAt: at };
    void draw();
    try {
      const reply = await client.confirm(action, minutes, token);
      if (gen !== generation || closed) return;
      const now = Date.now();
      control = reply.ok
        ? { ...control, busy: null, result: { item, kind: "sent", id: reply.id, at: now }, touchedAt: now }
        : { ...control, busy: null, result: { item, kind: "refused", code: reply.error ?? "other", message: reply.message, at: now }, touchedAt: now };
    } catch (error) {
      if (gen !== generation || closed) return;
      // No answer: it may have gone out. Never "sent", never "not sent" - the bridge's record decides.
      control = toApiError(error).code === "auth"
        ? { ...control, busy: null, result: { item, kind: "failed", reason: "auth", at } }
        : { ...control, busy: null, result: { item, kind: "unknown", at } };
    }
    void draw();
  };

  const onGesture = (gesture: Gesture): void => {
    const now = Date.now();
    if (overlay) {
      // 2x is back: it closes the warnings and never leaves the app from here.
      if (gesture === "click" || gesture === "doubleClick" || gesture === "scrollUp" || gesture === "scrollDown") { overlay = null; void draw(); }
      return;
    }
    // The help page: only 2x does something (back).
    if (helpOpen) {
      if (gesture === "doubleClick") { helpOpen = false; void draw(); }
      return;
    }
    const withControl = car?.control.enabled === true && !(api?.demo ?? false);
    if (page === "control" && withControl && car) {
      const items = controlItems(car.control);
      switch (gesture) {
        case "scrollDown":
        case "scrollUp": {
          const moved = moveCursor(control, gesture === "scrollDown" ? 1 : -1, items.length, now);
          control = moved.state;
          if (moved.leave !== 0) page = stepPage(page, moved.leave, true);
          void draw();
          return;
        }
        case "click": {
          const decision = tapControl(control, now, items);
          if (decision.kind === "arm") void runArm(decision.item);
          else if (decision.kind === "confirm") void runConfirm(decision.item, decision.token);
          return;
        }
        case "doubleClick": {
          const cancelled = cancelControl(control, now);
          if (cancelled) { control = cancelled; void draw(); } else requestExit();
          return;
        }
        case "longPress":
          // Ring only. An open question lapses first; nothing may stay armed behind the help page.
          if (openArm(control, now)) { control = cancelControl(control, now) ?? control; void draw(); return; }
          if (SIDE_MENU) return;
          helpOpen = true;
          void draw();
          return;
        default:
          return;
      }
    }
    switch (gesture) {
      case "scrollDown":
      case "scrollUp":
        page = stepPage(page, gesture === "scrollDown" ? 1 : -1, withControl);
        // Entering the control list from above starts at its first entry, from below at its last.
        if (page === "control" && car) {
          const count = controlItems(car.control).length;
          control = { ...control, armed: null, cursor: gesture === "scrollDown" ? 0 : Math.max(0, count - 1) };
        }
        void draw();
        return;
      case "click":
        if (car && car.warnings.length > 0) { overlay = sortWarnings(car.warnings); overlayUntil = now + OVERLAY_MS; void draw(); }
        return;
      case "longPress":
        // Only the R1 ring delivers a hold; the help is an extra and is never offered in a footer.
        if (SIDE_MENU) return;
        helpOpen = true;
        void draw();
        return;
      case "doubleClick":
        requestExit();
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
      // "No": the dialog went away. The app never left - page up again the way of the first one.
      dialogShown = false;
      exitDialogAsked = true;
      exitBack();
      return;
    }
    dialogPending = false;
    dialogShown = false;
    if (systemType !== 5) exitBack();
    const menuId = menuItemIdFromEvent(event);
    if (menuId !== null) {
      if (menuId === MENU_HELP && ready) {
        // Help covers a warning; an open question lapses so nothing stays armed behind it.
        overlay = null;
        control = cancelControl(control, Date.now()) ?? control;
        helpOpen = true;
        void draw();
      }
      return;
    }
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
  ready = true;
  start();
  await draw();

  // The clock moves, the warning header pulses, overlays time out; drawOnce writes only what changed.
  tickTimer = setInterval(() => {
    const now = Date.now();
    if (overlay && now > overlayUntil) overlay = null;
    control = expireControl(control, now);
    void draw();
    updatePhone();
  }, ICON_STEP_MS);

  const phone = mountPhoneUi({
    getSettings: () => settings,
    saveSettings: async (next) => {
      await saveSettings(bridge, next);
      const changed = next.url !== settings.url;
      settings = next;
      if (changed) start();
      updatePhone(true);
      await draw();
    },
    connection: phoneConnection,
    car: () => car,
    locale: () => locale,
    onLocaleChange: (next) => {
      locale = next;
      rememberLocale(bridge, next);
      // The menu label follows the language: one rebuild.
      pageReady = false;
      lastView = null;
      void draw();
    },
    build: BUILD,
  });
  refreshPhone = phone.refresh;
  console.info("[bydglass] " + BUILD + ((api as CarApi | null)?.demo ? " demo " + SCENE : ""));
}

void boot().catch((error: unknown) => {
  console.error("[bydglass] failed to start:", error);
});
