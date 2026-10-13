import { waitForEvenAppBridge, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import {
  clampBpm, createState, msPerBeat, msToNextBeat, restartCount, retime, toggle, type MetronomeState,
} from "./metronome/engine";
import { addSession, nextSessionId, type PracticeSession } from "./practice/log";
import { gestureFromEvent } from "./input/gestures";
import { buildView, type CadenceView } from "./glasses/view";
import { sameView } from "./glasses/diff";
import { createPage, updatePage, ICON_HEIGHT, ICON_WIDTH } from "./glasses/render";
import { PENDULUM_MIDSWING_MAX_BPM, bpmFrame, pendulumFrame, pendulumSwing } from "./glasses/charts";
import { bitmapKey, iconBitmap } from "./glasses/gfx";
import { load, loadRunRaw, parseRun, RUN_RESUME_MS, save, saveRun, setSettings, type CadenceData } from "./storage/persist";
import { lifecycleFromEvent } from "./lifecycle";
import { mountPhoneUi } from "./ui/phone";
import { rememberLocale, resolveLocale, type Locale } from "./i18n";
import { createExitRequest } from "./exit";

const METRONOME_SIGN = ["....##....", "...####...", "...####...", "...#..#...", "..##..##..", "..#.#..#..", ".##.#..##.", ".########.", "##########"] as const;

/** Tempo step for a swipe on the glasses. */
const BPM_STEP = 4;
/** While the beat runs, its state is written this often, so a restart knows when it was last alive. */
const HEARTBEAT_MS = 30_000;

async function boot(): Promise<void> {
  const bridge: EvenAppBridge = await waitForEvenAppBridge();

  let data: CadenceData = await load(bridge);
  let state: MetronomeState = createState();
  let sessionStartedAt: number | null = null;
  let lastView: CadenceView | null = null;
  let lastFrames = "";
  let pageReady = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let midTimer: ReturnType<typeof setTimeout> | undefined;
  let tick: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  /** In the background (left through the system): no drawing, no timers; the beat itself is time-based and carries on. */
  let paused = false;
  let lastHeartbeat = 0;
  let drawing: Promise<void> | null = null;
  let drawAgain = false;
  let locale: Locale = await resolveLocale(bridge);

  const currentView = (): CadenceView =>
    buildView(state, data.settings, {
      locale,
      ...(data.activeItem ? { item: data.activeItem } : {}),
      ...(sessionStartedAt !== null
        ? { sessionSeconds: (Date.now() - sessionStartedAt) / 1000 }
        : {}),
    });

  const drawOnce = async (): Promise<void> => {
    if (closed || paused) return;
    const view = currentView();
    // Pictures are pure in (tempo) and (state, now); they are only sent when they differ from what is shown.
    const frames = {
      icon: iconBitmap(METRONOME_SIGN, ICON_WIDTH, ICON_HEIGHT),
      bpm: bpmFrame(data.settings.bpm),
      pendulum: pendulumFrame(pendulumSwing(state, data.settings, Date.now())),
    };
    const key = [frames.icon, frames.bpm, frames.pendulum].map(bitmapKey).join("|");
    if (pageReady && sameView(lastView, view) && key === lastFrames) return;

    const result = pageReady ? await updatePage(bridge, view, frames, lastView) : await createPage(bridge, view, frames);
    if (result.ok) {
      pageReady = true;
      lastView = view;
      lastFrames = key;
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
    clearTimeout(midTimer);
    if (!state.running || closed || paused) return;
    const delay = Math.max(20, msToNextBeat(state, data.settings, Date.now()));
    timer = setTimeout(() => {
      void draw();
      // A slow beat leaves room for a second picture: the pendulum passing the middle.
      if (data.settings.bpm <= PENDULUM_MIDSWING_MAX_BPM) {
        midTimer = setTimeout(() => { void draw(); }, msPerBeat(data.settings.bpm) / 2);
      }
      scheduleBeat();
    }, delay);
  };

  const endSession = (now = Date.now()): void => {
    if (sessionStartedAt === null) return;
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

  /** Writes the beat and the open session; a restart after a locked phone continues from here. */
  const persistRun = (): void => {
    lastHeartbeat = Date.now();
    void saveRun(bridge, { ...state, sessionStartedAt, savedAt: lastHeartbeat })
      .catch((error: unknown) => { console.warn("[cadence] saving the beat failed:", error); });
  };

  // Pick up the beat and the session from before a restart. Away too long:
  // the session is logged up to the last sign of life and the beat waits.
  const saved = parseRun(await loadRunRaw(bridge));
  if (saved) {
    const now = Date.now();
    if (now - saved.savedAt <= RUN_RESUME_MS && saved.savedAt <= now + 60_000) {
      state = { running: saved.running, startedAt: saved.startedAt, beatsBefore: saved.beatsBefore };
      sessionStartedAt = saved.sessionStartedAt;
    } else if (saved.sessionStartedAt !== null) {
      sessionStartedAt = saved.sessionStartedAt;
      endSession(saved.savedAt);
      persistRun();
    }
  }

  const stopTimers = (): void => {
    clearTimeout(timer);
    clearTimeout(midTimer);
    clearInterval(tick);
    tick = undefined;
  };
  const startTick = (): void => {
    if (tick !== undefined || closed || paused) return;
    // Keeps the session clock moving while paused; sameView drops idle ticks.
    tick = setInterval(() => {
      if (state.running && Date.now() - lastHeartbeat >= HEARTBEAT_MS) persistRun();
      void draw();
    }, 1000);
  };
  const resume = (): void => {
    if (!paused || closed) return;
    paused = false;
    pageReady = false;
    lastView = null;
    lastFrames = "";
    startTick();
    scheduleBeat();
    void draw();
  };

  const requestExit = createExitRequest(bridge, {
    onConfirmed: () => {
      endSession();
      state = createState();
      persistRun();
      closed = true;
      clearTimeout(timer);
      clearTimeout(midTimer);
      clearInterval(tick);
    },
  }, "cadence");

  await draw();

  bridge.onEvenHubEvent((event) => {
    if (closed) return;
    const lifecycle = lifecycleFromEvent(event);
    if (lifecycle === "foreground") { paused = true; resume(); return; }
    if (lifecycle === "background") { persistRun(); paused = true; stopTimers(); return; }
    if (lifecycle === "exit") { persistRun(); closed = true; stopTimers(); return; }
    // A gesture means the app is on the glasses again, even if no "foreground" came.
    resume();
    const gesture = gestureFromEvent(event, { invertScroll: data.invertScroll });
    if (!gesture) return;

    switch (gesture.gesture) {
      case "click": {
        const now = Date.now();
        state = toggle(state, data.settings, now);
        if (state.running) sessionStartedAt = sessionStartedAt ?? now;
        else endSession();
        persistRun();
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
        // From the top: bar 1 again, a running beat keeps running.
        state = restartCount(state, Date.now());
        persistRun();
        scheduleBeat();
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

  startTick();
  scheduleBeat();

  mountPhoneUi({
    getLocale: () => locale,
    setLocale: (next) => {
      locale = next;
      rememberLocale(bridge, next);
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
