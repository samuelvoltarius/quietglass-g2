import { waitForEvenAppBridge, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { EMPTY_CHECKLIST, type Checklist } from "./checklist/model";
import { startRun, type RunState } from "./checklist/run";
import { dispatch } from "./input/dispatch";
import { gestureFromEvent } from "./input/gestures";
import { buildView, type FlowView } from "./glasses/view";
import { sameView } from "./glasses/diff";
import { createPage, updatePage } from "./glasses/render";
import { activeList, load, save, type FlowListData } from "./storage/persist";
import { mountPhoneUi } from "./ui/phone";
import { getLocale, type Locale } from "./i18n";

/** Redraw cadence for the elapsed-time readout while a run is open. */
const CLOCK_MS = 1000;

async function boot(): Promise<void> {
  const bridge: EvenAppBridge = await waitForEvenAppBridge();

  let locale: Locale = getLocale();
  let data: FlowListData = await load(bridge, locale);
  let list: Checklist = activeList(data) ?? EMPTY_CHECKLIST;
  let state: RunState = startRun(list);
  let showDetail = false;
  let lastView: FlowView | null = null;
  let pageReady = false;
  /** Set once the user leaves; nothing may be drawn on a closed page. */
  let closed = false;
  let drawing: Promise<void> | null = null;
  let redrawQueued = false;

  const currentView = (): FlowView =>
    buildView(list, state, {
      showNext: data.settings.showNext,
      showDetail,
      lineWidth: data.settings.lineWidth,
      locale,
    });

  const drawOnce = async (): Promise<void> => {
    const view = currentView();
    if (sameView(lastView, view)) return;

    const result = pageReady ? await updatePage(bridge, view) : await createPage(bridge, view);
    if (result.ok) {
      pageReady = true;
      lastView = view;
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

  const restart = (): void => {
    list = activeList(data) ?? EMPTY_CHECKLIST;
    state = startRun(list);
    showDetail = false;
    lastView = null;
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

  const close = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(clock);
    bridge.shutDownPageContainer().catch((error: unknown) => {
      console.warn("[flowlist] shutdown failed:", error);
    });
  };

  bridge.onEvenHubEvent((event) => {
    if (closed) return;
    const gesture = gestureFromEvent(event, { invertScroll: data.settings.invertScroll });
    if (!gesture) return;

    const result = dispatch(list, state, gesture.gesture);
    state = result.state;

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

  // Only the elapsed-time readout changes on its own; sameView() drops the
  // redraw on the ticks where the displayed second has not advanced.
  clock = setInterval(() => { void draw(); }, CLOCK_MS);

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
      void draw();
    },
  });
}

void boot().catch((error: unknown) => {
  console.error("[flowlist] failed to start:", error);
});
