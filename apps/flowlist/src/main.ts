import { waitForEvenAppBridge, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { EMPTY_CHECKLIST, type Checklist } from "./checklist/model";
import { startRun, type RunState } from "./checklist/run";
import { dispatch, dispatchMenu, MENU, type Armed, type DispatchResult } from "./input/dispatch";
import { gestureFromEvent, menuItemIdFromEvent } from "./input/gestures";
import { buildView, progressBarFor, type FlowView } from "./glasses/view";
import { sameView } from "./glasses/diff";
import { createPage, forgetPage, sendProgressBar, sendStepImage, updatePage, type MenuSpec } from "./glasses/render";
import { browserMeasure, layoutStep, sameLayout, type Measure, type StepLayout } from "./glasses/stepimage";
import { drawProgressBar, sameProgressBar, type ProgressBarState } from "./glasses/progressbar";
import { createImageSync } from "./glasses/image-sync";
import { activeList, load, loadRun, restoreRun, save, saveRun, type FlowListData } from "./storage/persist";
import { lifecycleFromEvent } from "./lifecycle";
import { mountPhoneUi } from "./ui/phone";
import { createExitRequest, isBackSignal } from "./exit";
import { resolveLocale, rememberLocale, setLocale, type Locale } from "./i18n";
import { t } from "./messages";

/**
 * The glasses' side menu (QIS v1.2). Off: its clicks never reach the app on the real glasses, and while a page
 * carries a menu the hold opens it instead of reaching the app (step log of 15.10.2026). Without it a swipe
 * arms "step back" / "skip" and the hold shows the step info or opens the help.
 */
const SIDE_MENU = false;

/** Redraw cadence for the elapsed-time readout while a run is open. */
const CLOCK_MS = 1000;
/** An armed action (skip, start over, confirm) is cancelled after this long without input (QIS v1, section 2). */
export const ARM_MS = 4000;
/** A tap this soon after the help opened is the end of the hold itself and does not close it. */
const HELP_GUARD_MS = 400;

async function boot(): Promise<void> {
  const bridge: EvenAppBridge = await waitForEvenAppBridge();

  let locale: Locale = await resolveLocale(bridge);
  setLocale(locale);
  let data: FlowListData = await load(bridge, locale);
  let list: Checklist = activeList(data) ?? EMPTY_CHECKLIST;
  // After the phone was locked for a while the Even app starts FlowList anew;
  // the run continues at the step where it was left.
  let state: RunState = restoreRun(await loadRun(bridge), list) ?? startRun(list);
  let showDetail = false;
  /** Skip or start-over waits for a second tap; a pending critical confirmation counts the same way. */
  let armed: Armed | null = null;
  let armedAt = 0;
  let helpOpen = false;
  let helpOpenedAt = 0;
  let lastView: FlowView | null = null;
  let pageReady = false;
  /** Set once the user leaves; nothing may be drawn on a closed page. */
  let closed = false;
  let drawing: Promise<void> | null = null;
  let redrawQueued = false;

  /** QIS v1.2: the side menu. Supplied again on every page (re)build, in the current language. */
  const menu = (): MenuSpec => ({
    items: !SIDE_MENU ? [] : [
      { id: MENU.help, label: t(locale, "m.help") },
      { id: MENU.info, label: t(locale, "m.info") },
      { id: MENU.back, label: t(locale, "m.back") },
      { id: MENU.skip, label: t(locale, "m.skip") },
    ],
  });

  let measureText: Measure | null = null;
  const measure: Measure = (text, size) => (measureText ??= browserMeasure())(text, size);
  const currentView = (): FlowView =>
    buildView(list, state, {
      showNext: data.settings.showNext,
      showDetail,
      lineWidth: data.settings.lineWidth,
      locale,
      armed,
      sideMenu: SIDE_MENU,
      help: helpOpen,
      headlineFits: (text) => !layoutStep(measure, text).truncated,
    });

  /** The step as a big picture; sent on its own lane, and only when the layout changes. */
  const stepImage = createImageSync<StepLayout>(sameLayout, async (next) => {
    if (closed) return false;
    const result = await sendStepImage(bridge, next.lines.length > 0 ? next : null);
    if (!result.ok) console.warn("[flowlist] step image failed:", result.reason);
    return result.ok;
  });
  const requestStepImage = (view: FlowView): void => {
    stepImage.request(layoutStep(measure, view.headline));
  };

  /**
   * The progress bar runs on its own lane: an image is a slow BLE transfer
   * and must never hold up the step text. It changes only when a step is done
   * or undone, so it is sent rarely.
   */
  const bar = createImageSync<ProgressBarState>(sameProgressBar, async (next) => {
    if (closed) return false;
    const result = await sendProgressBar(bridge, drawProgressBar(next));
    if (!result.ok) console.warn("[flowlist] progress bar failed:", result.reason);
    return result.ok;
  });

  // While the exit dialog may be on screen (asked, no input since) no timer, poll or stream may draw: a page call
  // could cover it. Data keeps being collected; the back signal restores the page the way of the first one.
  let exitAsked = (): boolean => false;
  const drawOnce = async (): Promise<void> => {
    if (exitAsked()) return;
    const view = currentView();
    if (pageReady) { bar.request(progressBarFor(list, state)); requestStepImage(view); }
    if (sameView(lastView, view)) return;

    const created = !pageReady;
    const result = pageReady ? await updatePage(bridge, view) : await createPage(bridge, view, menu());
    if (result.ok) {
      pageReady = true;
      lastView = view;
      // A new page starts with an empty image container.
      if (created) { bar.reset(); bar.request(progressBarFor(list, state)); stepImage.reset(); requestStepImage(view); }
      else requestStepImage(view);
      return;
    }
    // Usually means the page is gone (relaunch, reconnect). Rebuild next time
    // rather than leaving a stale screen up.
    pageReady = false;
    lastView = null;
    console.warn("[flowlist] draw failed:", result.reason);
  };

  /**
   * One draw at a time. The clock, gestures and the phone all request
   * redraws; interleaving them would race two page creations or let an older
   * view land after a newer one. Requests made meanwhile collapse into one.
   */
  const draw = (): Promise<void> => {
    if (exitAsked()) return Promise.resolve();
    if (closed) return Promise.resolve();
    if (drawing) { redrawQueued = true; return drawing; }
    drawing = (async () => {
      try {
        do {
          redrawQueued = false;
          await drawOnce();
        } while (redrawQueued && !closed);
      } finally {
        drawing = null;
      }
    })();
    return drawing;
  };

  /** Writes the run so a restart (phone locked, app unloaded) continues where it was. */
  const persistRun = (): void => {
    void saveRun(bridge, state).catch((error: unknown) => console.warn("[flowlist] saving the run failed:", error));
  };

  const restart = (): void => {
    list = activeList(data) ?? EMPTY_CHECKLIST;
    state = startRun(list);
    showDetail = false;
    armed = null;
    lastView = null;
    persistRun();
  };

  /** Nothing waits for a second tap any more: the armed action and a pending confirmation are dropped. */
  const disarm = (): void => {
    armed = null;
    if (state.awaitingConfirm) state = { ...state, awaitingConfirm: false };
  };
  /** Cancels whatever was armed more than ARM_MS ago. Returns true when the screen changed. */
  const expireArm = (now = Date.now()): boolean => {
    if (armed === null && !state.awaitingConfirm) return false;
    if (now - armedAt < ARM_MS) return false;
    disarm();
    return true;
  };

  /**
   * Applies data saved on the phone. Only a different checklist starts a new
   * run: toggling a display setting mid-task must not throw away the steps
   * already done.
   */
  const applyData = (next: FlowListData): void => {
    const nextList = activeList(next) ?? EMPTY_CHECKLIST;
    if (nextList === list) { lastView = null; return; }
    restart();
  };

  await draw();

  let clock: ReturnType<typeof setInterval> | undefined;
  /** Only the elapsed-time readout changes on its own; it pauses while the app is in the background. */
  const startClock = (): void => {
    if (clock !== undefined || closed) return;
    clock = setInterval(() => { if (expireArm()) persistRun(); void draw(); }, CLOCK_MS);
  };
  const stopClock = (): void => {
    if (clock !== undefined) clearInterval(clock);
    clock = undefined;
  };

  /**
   * Double tap asks the system exit dialog. The run carries on while it is
   * open; the system ends the app on a confirmed exit (sysEvent 6/7). The call resolves when the dialog is
   * SHOWN, not when the user answered, so its result never stops the clock.
   */
  const requestExit = createExitRequest(bridge, {
    onBack: () => {
      // The dialog took the page away. On the next input put it up again the way of the
      // first one (create), so the glasses deliver input - and the next 2x - to the app again.
      if (closed) return;
      pageReady = false;
      lastView = null;
      forgetPage(bridge);
      return draw();
    },
  }, "flowlist");
  exitAsked = requestExit.asked;
  /** True after a real FOREGROUND_EXIT (5 without the exit dialog): the page and the clock are not running. */
  let backgrounded = false;
  /** The page rebuild started by the first input after a real background. */
  let comingBack: Promise<void> | null = null;
  const comeBack = (): void => {
    if (!backgrounded) return;
    backgrounded = false;
    pageReady = false;
    lastView = null;
    startClock();
    comingBack = draw();
  };
  const close = (): void => {
    if (closed) return;
    void (async () => {
      // Coming back from the background: the page must be up before the dialog is asked (a call during creation is lost).
      if (comingBack) { await comingBack.catch(() => undefined); comingBack = null; if (closed) return; }
      await requestExit();
    })();
  };

  /** Applies what a gesture or a menu click decided. */
  const applyResult = (result: DispatchResult, now: number, clearDetail: boolean): void => {
    const wasConfirming = state.awaitingConfirm;
    const changed = result.state !== state;
    if (changed) { state = result.state; persistRun(); }
    if (state.awaitingConfirm && !wasConfirming) armedAt = now;
    if (clearDetail && changed) showDetail = false;

    for (const effect of result.effects) {
      if (effect.kind === "exit") {
        close();
        return;
      }
      if (effect.kind === "showDetail") showDetail = effect.on;
      if (effect.kind === "arm") { armed = effect.action; armedAt = now; }
      if (effect.kind === "help") { helpOpen = true; helpOpenedAt = now; }
    }
    void draw();
  };

  bridge.onEvenHubEvent((event) => {
    if (closed) return;
    // The 4/5 right after an exit call are the system dialog's own show/close, not the app entering/leaving.
    if (requestExit.onLifecycle(event) !== null) return;
    // Left or reopened through the system rather than by a double tap.
    const lifecycle = lifecycleFromEvent(event);
    if (isBackSignal(event)) requestExit.back();
    if (lifecycle === "foreground") {
      backgrounded = false;
      pageReady = false;
      lastView = null;
      startClock();
      void draw();
      return;
    }
    if (lifecycle === "background") { backgrounded = true; persistRun(); stopClock(); return; }
    if (lifecycle === "exit") { persistRun(); stopClock(); closed = true; return; }
    if (clock === undefined) startClock();

    // QIS v1.2: a click in the side menu. Stepping back and skipping are armed first.
    const menuId = menuItemIdFromEvent(event);
    if (menuId !== null) {
      comeBack();
      const now = Date.now();
      expireArm(now);
      if (helpOpen) return;
      applyResult(dispatchMenu(list, state, menuId, armed), now, menuId !== MENU.info);
      return;
    }

    const gesture = gestureFromEvent(event, { invertScroll: data.settings.invertScroll });
    if (!gesture) return;
    comeBack();

    const now = Date.now();
    expireArm(now);

    // The help page is a subpage: tap, hold or 2× go back; swipes change nothing there.
    if (helpOpen) {
      const justOpened = now - helpOpenedAt < HELP_GUARD_MS;
      if (gesture.gesture === "doubleClick" || gesture.gesture === "longPress" || (gesture.gesture === "click" && !justOpened)) {
        helpOpen = false;
        void draw();
      }
      return;
    }

    // The info pinned from the menu goes with the next gesture; a hold shows it by itself.
    if (gesture.gesture !== "longPress" && gesture.gesture !== "longPressRelease") showDetail = false;
    applyResult(dispatch(list, state, gesture.gesture, armed, SIDE_MENU), now, true);
  });

  // The page does not survive a disconnect. The last view is forgotten too,
  // or an unchanged view would skip the rebuild and leave the display blank.
  bridge.onDeviceStatusChanged((status) => {
    if (status?.connectType === "connected") {
      pageReady = false;
      lastView = null;
      void draw();
    }
  });

  // sameView() drops the redraw on the ticks where the displayed second has not advanced.
  startClock();

  mountPhoneUi({
    getData: () => data,
    setData: async (next) => {
      data = next;
      applyData(next);
      await save(bridge, next);
      await draw();
    },
    locale: () => locale,
    onLocaleChange: (next) => {
      locale = next;
      rememberLocale(bridge, next);
      // The side menu carries the language: the page is rebuilt with it.
      if (SIDE_MENU) { pageReady = false; lastView = null; }
      void draw();
    },
  });
}

void boot().catch((error: unknown) => {
  console.error("[flowlist] failed to start:", error);
});
