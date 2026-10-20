import { waitForEvenAppBridge, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { EMPTY_CHECKLIST, indexOfStep, type Checklist } from "./checklist/model";
import { startRun, type RunState } from "./checklist/run";
import { dispatch, dispatchMenu, MENU, type Armed, type DispatchResult } from "./input/dispatch";
import { gestureFromEvent, menuItemIdFromEvent } from "./input/gestures";
import { buildView, progressBarFor, type FlowView } from "./glasses/view";
import { sameView } from "./glasses/diff";
import {
  COCKPIT_TILES, createCockpitPage, createPage, createTextPage, forgetPage, guardedTileSend, sendProgressBar, sendStepImage, updatePage, type MenuSpec,
} from "./glasses/render";
import { startRows, startView, tasksView } from "./glasses/screens";
import { cockpitModel, modelKey, type CockpitModel } from "./cockpit/model";
import { composeCockpit } from "./cockpit/compose";
import { createTileSender } from "./screen/sender";
import { autoBackend, pixelBackend, type TextBackend } from "./screen/text";
import { browserMeasure, layoutStep, sameLayout, type Measure, type StepLayout } from "./glasses/stepimage";
import { drawProgressBar, sameProgressBar, type ProgressBarState } from "./glasses/progressbar";
import { createImageSync } from "./glasses/image-sync";
import { activeList, load, loadRun, restoreRun, save, saveRun, type FlowListData } from "./storage/persist";
import { lifecycleFromEvent } from "./lifecycle";
import { mountPhoneUi, type PhoneUi } from "./ui/phone";
import { createExitRequest, isBackSignal } from "./exit";
import { resolveLocale, rememberLocale, setLocale, type Locale } from "./i18n";
import { t } from "./messages";
import { parseUi, UI_KEY, type SavedUi, type Screen } from "./ui-state";

/**
 * The glasses' side menu (QIS v1.2). Off: its clicks never reach the app on the real glasses, and while a page
 * carries a menu the hold opens it instead of reaching the app (step log of 15.10.2026). Without it a swipe
 * arms "step back" / "skip" and the hold shows the step info or opens the help.
 */
const SIDE_MENU = false;

/** An unchanged cockpit is pushed again at most this often, so a tile that failed gets another try. */
const COCKPIT_RETRY_MS = 15_000;

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

  let screen: Screen = "start";
  let startCursor = 0;
  let taskCursor = 0;
  {
    const ui = parseUi((await bridge.getLocalStorage(UI_KEY).catch(() => "")) ?? "");
    startCursor = ui.startCursor ?? 0;
    if (ui.screen !== undefined && list.steps.length > 0) screen = ui.screen;
  }
  let savedUi = "";
  const saveUi = (): void => {
    const json = JSON.stringify({ screen, startCursor } satisfies SavedUi);
    if (json === savedUi) return;
    savedUi = json;
    void Promise.resolve(bridge.setLocalStorage(UI_KEY, json)).catch(() => false);
  };

  /** Skip or start-over waits for a second tap; a pending critical confirmation counts the same way. */
  let armed: Armed | null = null;
  let armedAt = 0;
  let helpOpen = false;
  let helpOpenedAt = 0;
  let lastView: FlowView | null = null;
  let pageReady = false;
  /** Which kind of page the glasses carry: a change means one rebuild. */
  let installed: "text" | "run" | "cockpit" | null = null;
  let textBackend: TextBackend | null = null;
  let cockpitKey = "";
  let cockpitPushedAt = 0;
  /** Set once the user leaves; nothing may be drawn on a closed page. */
  let closed = false;
  let drawing: Promise<void> | null = null;
  let redrawQueued = false;
  /** The phone page; it follows the run. */
  let phone: PhoneUi | null = null;

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
      // The run hangs under the start page: 2× goes one level up, only the start page asks the exit dialog.
      end: "back",
      help: helpOpen,
      headlineFits: (text) => !layoutStep(measure, text).truncated,
    });

  // While the exit dialog may be on screen (asked, no input since) no timer, poll or stream may draw: a page call
  // could cover it. Data keeps being collected; the back signal restores the page the way of the first one.
  let exitAsked = (): boolean => false;

  /** The step as a big picture; sent on its own lane, and only when the layout changes. */
  const stepImage = createImageSync<StepLayout>(sameLayout, async (next) => {
    if (closed || installed !== "run" || exitAsked()) return false;
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
    if (closed || installed !== "run" || exitAsked()) return false;
    const result = await sendProgressBar(bridge, drawProgressBar(next));
    if (!result.ok) console.warn("[flowlist] progress bar failed:", result.reason);
    return result.ok;
  });

  /** The cockpit is one 576 x 288 frame; only the tiles whose pixels changed cross Bluetooth. Never while the dialog may be up. */
  const tiles = createTileSender(COCKPIT_TILES, guardedTileSend(bridge, () => !exitAsked() && !closed && installed === "cockpit"));

  type Scene =
    | { readonly kind: "text" | "run"; readonly view: FlowView }
    | { readonly kind: "cockpit"; readonly model: CockpitModel };

  /** Everything on the glasses for one moment. */
  const currentScene = (now: number): Scene => {
    if (list.steps.length === 0) screen = "start";
    if (screen === "cockpit") return { kind: "cockpit", model: cockpitModel({ list, state, now, locale }) };
    if (screen === "tasks") {
      taskCursor = Math.min(taskCursor, Math.max(0, list.steps.length - 1));
      return { kind: "text", view: tasksView(list, state, taskCursor, locale) };
    }
    if (screen === "run") return { kind: "run", view: currentView() };
    startCursor = Math.min(startCursor, Math.max(0, startRows(list).length - 1));
    return { kind: "text", view: startView(list, state, startCursor, locale) };
  };

  /** The page on the glasses is gone or unknown: the next draw builds it the way of the first one. */
  const forgetDrawn = (): void => {
    pageReady = false;
    lastView = null;
    installed = null;
  };

  const drawOnce = async (): Promise<void> => {
    if (exitAsked()) return;
    const scene = currentScene(Date.now());

    if (scene.kind === "cockpit") {
      if (installed !== "cockpit") pageReady = false;
      if (!pageReady) {
        const result = await createCockpitPage(bridge);
        if (closed) return;
        if (!result.ok) { forgetDrawn(); console.warn("[flowlist] draw failed:", result.reason); return; }
        pageReady = true;
        installed = "cockpit";
        lastView = null;
        cockpitKey = "";
        // A new page starts with blank images.
        tiles.reset();
      }
      const key = modelKey(scene.model);
      const now = Date.now();
      if (key === cockpitKey && now - cockpitPushedAt < COCKPIT_RETRY_MS) return;
      cockpitKey = key;
      cockpitPushedAt = now;
      textBackend ??= autoBackend();
      let frame;
      try {
        frame = composeCockpit(scene.model, textBackend);
      } catch (error) {
        // A canvas that fails mid-way must not leave the glasses blank: the built-in pixel font always works.
        console.warn("[flowlist] cockpit text failed, using the pixel font:", error);
        textBackend = pixelBackend();
        frame = composeCockpit(scene.model, textBackend);
      }
      // Never awaited: a slow transfer must not hold up the next gesture.
      void tiles.push(frame);
      return;
    }

    // Leaving the cockpit: its containers are about to go, no tile may be written any more.
    if (installed === "cockpit") { installed = null; pageReady = false; }
    if (installed !== scene.kind) pageReady = false;
    const view = scene.view;
    if (pageReady && scene.kind === "run") { bar.request(progressBarFor(list, state)); requestStepImage(view); }
    if (sameView(lastView, view)) return;

    const created = !pageReady;
    const result = pageReady
      ? await updatePage(bridge, view)
      : scene.kind === "run" ? await createPage(bridge, view, menu()) : await createTextPage(bridge, view);
    if (closed) return;
    if (result.ok) {
      pageReady = true;
      installed = scene.kind;
      lastView = view;
      if (scene.kind === "run") {
        // A new page starts with an empty image container.
        if (created) { bar.reset(); bar.request(progressBarFor(list, state)); stepImage.reset(); requestStepImage(view); }
        else requestStepImage(view);
      }
      return;
    }
    // Usually means the page is gone (relaunch, reconnect). Rebuild next time
    // rather than leaving a stale screen up.
    forgetDrawn();
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
    if (nextList.steps.length === 0) screen = "start";
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
   * Double tap on the start page asks the system exit dialog. The run carries on while it is
   * open; the system ends the app on a confirmed exit (sysEvent 6/7). The call resolves when the dialog is
   * SHOWN, not when the user answered, so its result never stops the clock.
   */
  const requestExit = createExitRequest(bridge, {
    onBack: () => {
      // The dialog took the page away. On the next input put it up again the way of the
      // first one (create), so the glasses deliver input - and the next 2x - to the app again.
      if (closed) return;
      forgetDrawn();
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
    forgetDrawn();
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

  /** Moves to another screen on the glasses and remembers it. */
  const go = (next: Screen): void => {
    screen = next;
    if (next !== "run") { helpOpen = false; showDetail = false; }
    saveUi();
    phone?.refreshLive();
  };
  const enterRun = (): void => {
    helpOpen = false;
    showDetail = false;
    go("run");
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
        // 2× in the run: one level up to the start page (only there the exit dialog is asked).
        disarm();
        go("start");
        void draw();
        return;
      }
      if (effect.kind === "showDetail") showDetail = effect.on;
      if (effect.kind === "arm") { armed = effect.action; armedAt = now; }
      if (effect.kind === "help") { helpOpen = true; helpOpenedAt = now; }
    }
    if (changed) phone?.refreshLive();
    void draw();
  };

  /** The start page: tap opens the entry under the dot, swipe moves, 2× asks the exit dialog. */
  const onStart = (gesture: string): void => {
    const rows = startRows(list);
    switch (gesture) {
      case "click": {
        const row = rows[startCursor];
        if (!row) return;
        if (row.kind === "run") enterRun();
        else if (row.kind === "cockpit") go("cockpit");
        else {
          taskCursor = Math.max(0, indexOfStep(list, state.currentId ?? ""));
          go("tasks");
        }
        break;
      }
      case "scrollUp":
        startCursor = Math.max(0, startCursor - 1);
        break;
      case "scrollDown":
        startCursor = Math.min(Math.max(0, rows.length - 1), startCursor + 1);
        break;
      case "doubleClick":
        close();
        return;
      default:
        return;
    }
    saveUi();
    void draw();
  };

  /** The overview image: tap goes on to the run, 2× back to the start page; nothing else does anything. */
  const onCockpit = (gesture: string): void => {
    if (gesture === "click") enterRun();
    else if (gesture === "doubleClick") go("start");
    else return;
    void draw();
  };

  /** The task list: swipe moves the dot (nothing changes), tap goes on to the run, 2× back. */
  const onTasks = (gesture: string): void => {
    switch (gesture) {
      case "click":
        enterRun();
        break;
      case "scrollUp":
        taskCursor = Math.max(0, taskCursor - 1);
        break;
      case "scrollDown":
        taskCursor = Math.min(Math.max(0, list.steps.length - 1), taskCursor + 1);
        break;
      case "doubleClick":
        go("start");
        break;
      default:
        return;
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
      forgetDrawn();
      startClock();
      void draw();
      return;
    }
    if (lifecycle === "background") { backgrounded = true; persistRun(); saveUi(); stopClock(); return; }
    if (lifecycle === "exit") { persistRun(); saveUi(); stopClock(); closed = true; tiles.close(); return; }
    if (clock === undefined) startClock();
    if (list.steps.length === 0) screen = "start";

    // QIS v1.2: a click in the side menu (run only). Stepping back and skipping are armed first.
    const menuId = menuItemIdFromEvent(event);
    if (menuId !== null) {
      comeBack();
      if (screen !== "run") return;
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

    if (screen === "start") { onStart(gesture.gesture); return; }
    if (screen === "cockpit") { onCockpit(gesture.gesture); return; }
    if (screen === "tasks") { onTasks(gesture.gesture); return; }

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
      forgetDrawn();
      void draw();
    }
  });

  // sameView() drops the redraw on the ticks where the displayed second has not advanced.
  startClock();

  phone = mountPhoneUi({
    getData: () => data,
    setData: async (next) => {
      data = next;
      applyData(next);
      await save(bridge, next);
      await draw();
      phone?.refreshLive();
    },
    getRun: () => ({ list, state }),
    restartRun: () => {
      restart();
      void draw();
      phone?.refreshLive();
    },
    locale: () => locale,
    onLocaleChange: (next) => {
      locale = next;
      rememberLocale(bridge, next);
      // The side menu carries the language: the page is rebuilt with it.
      if (SIDE_MENU) forgetDrawn();
      void draw();
    },
  });
}

void boot().catch((error: unknown) => {
  console.error("[flowlist] failed to start:", error);
});
