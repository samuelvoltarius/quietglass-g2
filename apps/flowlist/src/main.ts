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

/** Redraw cadence for the elapsed-time readout while a run is open. */
const CLOCK_MS = 1000;

async function boot(): Promise<void> {
  const bridge: EvenAppBridge = await waitForEvenAppBridge();

  let data: FlowListData = await load(bridge);
  let list: Checklist = activeList(data) ?? EMPTY_CHECKLIST;
  let state: RunState = startRun(list);
  let showDetail = false;
  let lastView: FlowView | null = null;
  let pageReady = false;

  const currentView = (): FlowView =>
    buildView(list, state, {
      showNext: data.settings.showNext,
      showDetail,
      lineWidth: data.settings.lineWidth,
    });

  const draw = async (): Promise<void> => {
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
    console.warn("[flowlist] draw failed:", result.reason);
  };

  const restart = (): void => {
    list = activeList(data) ?? EMPTY_CHECKLIST;
    state = startRun(list);
    showDetail = false;
    lastView = null;
  };

  await draw();

  bridge.onEvenHubEvent((event) => {
    const gesture = gestureFromEvent(event, { invertScroll: data.settings.invertScroll });
    if (!gesture) return;

    const result = dispatch(list, state, gesture.gesture);
    state = result.state;

    for (const effect of result.effects) {
      if (effect.kind === "exit") {
        void bridge.shutDownPageContainer();
        return;
      }
      if (effect.kind === "showDetail") showDetail = effect.on;
    }
    void draw();
  });

  bridge.onDeviceStatusChanged((status) => {
    if (status?.connectType === "connected") {
      pageReady = false;
      void draw();
    }
  });

  // Only the elapsed-time readout changes on its own; sameView() drops the
  // redraw on the ticks where the displayed second has not advanced.
  setInterval(() => { void draw(); }, CLOCK_MS);

  mountPhoneUi({
    getData: () => data,
    setData: async (next) => {
      data = next;
      await save(bridge, next);
      restart();
      await draw();
    },
  });
}

void boot().catch((error: unknown) => {
  console.error("[flowlist] failed to start:", error);
});
