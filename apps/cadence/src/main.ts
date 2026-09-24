import { waitForEvenAppBridge, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import {
  clampBpm, createState, msToNextBeat, reset, toggle, type MetronomeState,
} from "./metronome/engine";
import { addSession, nextSessionId, type PracticeSession } from "./practice/log";
import { gestureFromEvent } from "./input/gestures";
import { buildView, type CadenceView } from "./glasses/view";
import { sameView } from "./glasses/diff";
import { createPage, updatePage } from "./glasses/render";
import { load, save, setSettings, type CadenceData } from "./storage/persist";
import { mountPhoneUi } from "./ui/phone";

/** Tempo step for a swipe on the glasses. */
const BPM_STEP = 4;

async function boot(): Promise<void> {
  const bridge: EvenAppBridge = await waitForEvenAppBridge();

  let data: CadenceData = await load(bridge);
  let state: MetronomeState = createState();
  let sessionStartedAt: number | null = null;
  let lastView: CadenceView | null = null;
  let pageReady = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const currentView = (): CadenceView =>
    buildView(state, data.settings, {
      ...(data.activeItem ? { item: data.activeItem } : {}),
      ...(sessionStartedAt !== null
        ? { sessionSeconds: (Date.now() - sessionStartedAt) / 1000 }
        : {}),
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
    pageReady = false;
    console.warn("[cadence] draw failed:", result.reason);
  };

  /**
   * Redraws are scheduled onto the next beat boundary rather than polled at a
   * fixed rate. Polling faster than the beat wastes BLE traffic; polling slower
   * misses beats. Each redraw re-derives its position from the clock, so a late
   * timer shows up as a late frame, never as a drifting count.
   */
  const scheduleBeat = (): void => {
    clearTimeout(timer);
    if (!state.running) return;
    const delay = Math.max(20, msToNextBeat(state, data.settings, Date.now()));
    timer = setTimeout(() => {
      void draw();
      scheduleBeat();
    }, delay);
  };

  const endSession = (): void => {
    if (sessionStartedAt === null) return;
    const now = Date.now();
    // Only record something that was actually practised.
    if (data.activeItem && now - sessionStartedAt >= 10_000) {
      const session: PracticeSession = {
        id: nextSessionId(data.sessions),
        item: data.activeItem,
        bpm: data.settings.bpm,
        startedAt: sessionStartedAt,
        endedAt: now,
      };
      data = { ...data, sessions: addSession(data.sessions, session) };
      void save(bridge, data);
    }
    sessionStartedAt = null;
  };

  await draw();

  bridge.onEvenHubEvent((event) => {
    const gesture = gestureFromEvent(event, { invertScroll: data.invertScroll });
    if (!gesture) return;

    switch (gesture.gesture) {
      case "click": {
        const now = Date.now();
        state = toggle(state, data.settings, now);
        if (state.running) sessionStartedAt = sessionStartedAt ?? now;
        else endSession();
        scheduleBeat();
        break;
      }
      case "scrollUp":
        data = setSettings(data, { bpm: clampBpm(data.settings.bpm + BPM_STEP) });
        void save(bridge, data);
        scheduleBeat();
        break;
      case "scrollDown":
        data = setSettings(data, { bpm: clampBpm(data.settings.bpm - BPM_STEP) });
        void save(bridge, data);
        scheduleBeat();
        break;
      case "longPress":
        state = reset();
        break;
      case "doubleClick":
        endSession();
        clearTimeout(timer);
        void bridge.shutDownPageContainer();
        return;
      default:
        return;
    }
    void draw();
  });

  bridge.onDeviceStatusChanged((status) => {
    if (status?.connectType === "connected") {
      pageReady = false;
      void draw();
    }
  });

  // Keeps the session clock moving while paused; sameView drops idle ticks.
  setInterval(() => { void draw(); }, 1000);

  mountPhoneUi({
    getData: () => data,
    setData: async (next) => {
      data = next;
      await save(bridge, next);
      scheduleBeat();
      await draw();
    },
  });
}

void boot().catch((error: unknown) => {
  console.error("[cadence] failed to start:", error);
});
