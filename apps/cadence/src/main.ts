import { waitForEvenAppBridge, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import {
  clampBpm, createState, msToNextBeat, reset, retime, toggle, type MetronomeState,
} from "./metronome/engine";
import { addSession, nextSessionId, type PracticeSession } from "./practice/log";
import { gestureFromEvent } from "./input/gestures";
import { buildView, type CadenceView } from "./glasses/view";
import { sameView } from "./glasses/diff";
import { createPage, updatePage } from "./glasses/render";
import { load, save, setSettings, type CadenceData } from "./storage/persist";
import { mountPhoneUi } from "./ui/phone";
import { getLocale, setLocale, type Locale } from "./i18n";
import { createExitRequest } from "./exit";

const PIXEL_ICON = ["....##....", "...####...", "....##....", "...####...", "...#..#...", "..##..##..", "..#.#..#..", ".##.#..##.", ".########.", "##########"] as const;

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
  let tick: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let drawing: Promise<void> | null = null;
  let drawAgain = false;
  let locale: Locale = getLocale();

  const currentView = (): CadenceView =>
    buildView(state, data.settings, {
      locale,
      ...(data.activeItem ? { item: data.activeItem } : {}),
      ...(sessionStartedAt !== null
        ? { sessionSeconds: (Date.now() - sessionStartedAt) / 1000 }
        : {}),
    });

  const drawOnce = async (): Promise<void> => {
    if (closed) return;
    const view = currentView();
    if (sameView(lastView, view)) return;

    const result = pageReady ? await updatePage(bridge, view, PIXEL_ICON) : await createPage(bridge, view, PIXEL_ICON);
    if (result.ok) {
      pageReady = true;
      lastView = view;
      return;
    }
    pageReady = false;
    console.warn("[cadence] draw failed:", result.reason);
  };

  /**
   * One page write at a time. Beat timer, the 1 s tick and gestures all ask for
   * redraws; overlapping writes interleave over BLE and can leave an older frame
   * recorded as the last one shown. A request during a write redraws once after.
   */
  const draw = (): Promise<void> => {
    if (drawing) { drawAgain = true; return drawing; }
    drawing = (async () => {
      try {
        do { drawAgain = false; await drawOnce(); } while (drawAgain && !closed);
      } finally {
        drawing = null;
      }
    })();
    return drawing;
  };

  const persist = (next: CadenceData): Promise<void> =>
    save(bridge, next).catch((error: unknown) => { console.warn("[cadence] save failed:", error); });

  /** Applies new settings; a tempo change mid-run must not re-count the beats already played. */
  const applySettings = (next: CadenceData): void => {
    if (next.settings.bpm !== data.settings.bpm) state = retime(state, data.settings, Date.now());
    data = next;
  };

  /**
   * Redraws are scheduled onto the next beat boundary rather than polled at a
   * fixed rate. Polling faster than the beat wastes BLE traffic; polling slower
   * misses beats. Each redraw re-derives its position from the clock, so a late
   * timer shows up as a late frame, never as a drifting count.
   */
  const scheduleBeat = (): void => {
    clearTimeout(timer);
    if (!state.running || closed) return;
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
      void persist(data);
    }
    sessionStartedAt = null;
  };

  const requestExit = createExitRequest(bridge, {
    onConfirmed: () => {
      endSession();
      closed = true;
      clearTimeout(timer);
      clearInterval(tick);
    },
  }, "cadence");

  await draw();

  bridge.onEvenHubEvent((event) => {
    if (closed) return;
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
        applySettings(setSettings(data, { bpm: clampBpm(data.settings.bpm + BPM_STEP) }));
        void persist(data);
        scheduleBeat();
        break;
      case "scrollDown":
        applySettings(setSettings(data, { bpm: clampBpm(data.settings.bpm - BPM_STEP) }));
        void persist(data);
        scheduleBeat();
        break;
      case "longPress":
        state = reset();
        break;
      case "doubleClick":
        // System exit dialog; the beat keeps running until the user confirms.
        void requestExit();
        return;
      default:
        return;
    }
    void draw();
  });

  bridge.onDeviceStatusChanged((status) => {
    if (status?.connectType === "connected" && !closed) {
      pageReady = false;
      void draw();
    }
  });

  // Keeps the session clock moving while paused; sameView drops idle ticks.
  tick = setInterval(() => { void draw(); }, 1000);

  mountPhoneUi({
    getLocale: () => locale,
    setLocale: (next) => {
      locale = next;
      setLocale(next);
      void draw();
    },
    getData: () => data,
    setData: async (next) => {
      applySettings(next);
      await persist(next);
      scheduleBeat();
      await draw();
    },
  });
}

void boot().catch((error: unknown) => {
  console.error("[cadence] failed to start:", error);
});
