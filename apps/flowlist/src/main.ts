import { waitForEvenAppBridge, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { EMPTY_CHECKLIST, type Checklist } from "./checklist/model";
import { startRun, type RunState } from "./checklist/run";
import { dispatch } from "./input/dispatch";
import { gestureFromEvent } from "./input/gestures";
import { buildView, progressBarFor, type FlowView } from "./glasses/view";
import { sameView } from "./glasses/diff";
import { createPage, sendProgressBar, sendStepImage, updatePage } from "./glasses/render";
import { browserMeasure, layoutStep, sameLayout, type Measure, type StepLayout } from "./glasses/stepimage";
import { drawProgressBar, sameProgressBar, type ProgressBarState } from "./glasses/progressbar";
import { createImageSync } from "./glasses/image-sync";
import { activeList, load, loadRun, restoreRun, save, saveRun, type FlowListData } from "./storage/persist";
import { lifecycleFromEvent } from "./lifecycle";
import { mountPhoneUi } from "./ui/phone";
import { createExitRequest } from "./exit";
import { resolveLocale, rememberLocale, setLocale, type Locale } from "./i18n";

/** Redraw cadence for the elapsed-time readout while a run is open. */
const CLOCK_MS = 1000;

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
  let lastView: FlowView | null = null;
  let pageReady = false;
  /** Set once the user leaves; nothing may be drawn on a closed page. */
  let closed = false;
  let drawing: Promise<void> | null = null;
  let redrawQueued = false;

  let measureText: Measure | null = null;
  const measure: Measure = (text, size) => (measureText ??= browserMeasure())(text, size);
  const currentView = (): FlowView =>
    buildView(list, state, {
      showNext: data.settings.showNext,
      showDetail,
      lineWidth: data.settings.lineWidth,
      locale,
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

  const drawOnce = async (): Promise<void> => {
    const view = currentView();
    if (pageReady) { bar.request(progressBarFor(list, state)); requestStepImage(view); }
    if (sameView(lastView, view)) return;

    const created = !pageReady;
    const result = pageReady ? await updatePage(bridge, view) : await createPage(bridge, view);
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
    lastView = null;
    persistRun();
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
    clock = setInterval(() => { void draw(); }, CLOCK_MS);
  };
  const stopClock = (): void => {
    if (clock !== undefined) clearInterval(clock);
    clock = undefined;
  };

  /**
   * Double tap asks the system exit dialog. The run carries on while it is
   * open; only a confirmed exit stops the clock and the drawing.
   */
  const requestExit = createExitRequest(bridge, {
    onConfirmed: () => { persistRun(); closed = true; stopClock(); },
  }, "flowlist");
  const close = (): void => {
    if (closed) return;
    void requestExit();
  };

  bridge.onEvenHubEvent((event) => {
    if (closed) return;
    // Left or reopened through the system rather than by a double tap.
    const lifecycle = lifecycleFromEvent(event);
    if (lifecycle === "foreground") {
      pageReady = false;
      lastView = null;
      startClock();
      void draw();
      return;
    }
    if (lifecycle === "background") { persistRun(); stopClock(); return; }
    if (lifecycle === "exit") { persistRun(); stopClock(); closed = true; return; }
    if (clock === undefined) startClock();
    const gesture = gestureFromEvent(event, { invertScroll: data.settings.invertScroll });
    if (!gesture) return;

    const result = dispatch(list, state, gesture.gesture);
    if (result.state !== state) { state = result.state; persistRun(); }

    for (const effect of result.effects) {
      if (effect.kind === "exit") {
        close();
        return;
      }
      if (effect.kind === "showDetail") showDetail = effect.on;
    }
    void draw();
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
      void draw();
    },
  });
}

void boot().catch((error: unknown) => {
  console.error("[flowlist] failed to start:", error);
});
