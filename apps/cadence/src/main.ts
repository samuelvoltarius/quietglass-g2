import { waitForEvenAppBridge, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import {
  clampBpm, createState, msPerBeat, msToNextBeat, positionAt, restartCount, retime, toggle, type MetronomeState,
} from "./metronome/engine";
import { addSession, bestTempoByItem, nextSessionId, sessionsToday, totalSeconds, type PracticeSession } from "./practice/log";
import { gestureFromEvent, menuItemIdFromEvent } from "./input/gestures";
import { ARM_MS, cockpitModel, type CockpitModel } from "./cockpit/model";
import { composeCockpit } from "./cockpit/compose";
import { COCKPIT_TILES, createCockpitPage, forgetPage, guardedTileSend } from "./glasses/page";
import { PENDULUM_MIDSWING_MAX_BPM } from "./glasses/charts";
import { createTileSender } from "./screen/sender";
import { autoBackend, type TextBackend } from "./screen/text";
import { load, loadRunRaw, parseRun, RUN_RESUME_MS, save, saveRun, setSettings, type CadenceData } from "./storage/persist";
import { lifecycleFromEvent } from "./lifecycle";
import { mountPhoneUi, type PhoneLive, type PhoneUi } from "./ui/phone";
import { rememberLocale, resolveLocale, type Locale } from "./i18n";
import { createExitRequest, settleRestore } from "./exit";
import { diag, diagCount, diagOn, diagSkip, startDiag } from "./diag/diag";
import { traceBridge } from "./diag/bridge";
import { VERSION } from "./version";

/** The glasses' side menu (QIS v1.2). Off: its clicks do not arrive on current firmware and a hold opens it instead of reaching the app (step log 15.10.2026). */
export const SIDE_MENU = false;

/** Tempo step for a swipe on the glasses. */
const BPM_STEP = 4;
/** While the beat runs, its state is written this often, so a restart knows when it was last alive. */
const HEARTBEAT_MS = 30_000;

async function boot(): Promise<void> {
  // Private step log (VITE_TRAFFIC_URL, tailnet only): calls, results and events. Store builds: off, no URL in the bundle.
  startDiag((import.meta as { env?: Record<string, string | undefined> }).env?.["VITE_TRAFFIC_URL"] ?? "", VERSION);
  const bridge: EvenAppBridge = traceBridge(await waitForEvenAppBridge());

  let data: CadenceData = await load(bridge);
  let state: MetronomeState = createState();
  let sessionStartedAt: number | null = null;
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
  /** A pause is waiting for its confirming tap (QIS v1: arm, then confirm within ARM_MS). */
  let armedUntil = 0;
  let armTimer: ReturnType<typeof setTimeout> | undefined;
  let phone: PhoneUi | null = null;
  let textBackend: TextBackend | null = null;
  let locale: Locale = await resolveLocale(bridge);

  const isArmed = (): boolean => armedUntil > Date.now() && state.running;
  const disarm = (): void => { armedUntil = 0; clearTimeout(armTimer); armTimer = undefined; };

  const sessionSecondsNow = (): number | undefined =>
    sessionStartedAt !== null ? (Date.now() - sessionStartedAt) / 1000 : undefined;

  const currentModel = (): CockpitModel => {
    const now = Date.now();
    const today = sessionsToday(data.sessions, now);
    const best = data.activeItem ? bestTempoByItem(data.sessions).find((entry) => entry.item === data.activeItem)?.bpm ?? null : null;
    const seconds = sessionSecondsNow();
    return cockpitModel({
      state, settings: data.settings, now, locale, armed: isArmed(),
      todaySeconds: totalSeconds(today), todayCount: today.length, best,
      ...(data.activeItem ? { item: data.activeItem } : {}),
      ...(seconds !== undefined ? { sessionSeconds: seconds } : {}),
    });
  };

  const liveInfo = (): PhoneLive => ({
    running: state.running,
    paused: !state.running && state.beatsBefore > 0,
    bar: positionAt(state, data.settings, Date.now()).bar,
    sessionSeconds: sessionSecondsNow() ?? 0,
  });

  // While the exit dialog may be on screen (asked, no input since) no timer, poll or stream may draw: a page call
  // could cover it. Data keeps being collected; the back signal restores the page the way of the first one.
  let exitAsked = (): boolean => false;
  /** The cockpit is one 576 x 288 frame; only the tiles whose pixels changed cross Bluetooth. Never while the dialog may be up. */
  const tiles = createTileSender(COCKPIT_TILES, guardedTileSend(bridge, () => {
    const allowed = !exitAsked() && !closed && !paused;
    if (!allowed) diagCount("tileRefused:" + (exitAsked() ? "exitAsked" : closed ? "closed" : "paused"));
    return allowed;
  }));
  /** The flags that decide whether anything is drawn, for the step log. */
  const flags = (): Record<string, boolean> => ({ pageReady, paused, closed, exitAsked: exitAsked() });

  const drawOnce = async (): Promise<void> => {
    if (exitAsked()) { diagSkip("exitAsked"); return; }
    if (closed || paused) { diagSkip(closed ? "closed" : "paused"); return; }
    diagSkip(null);
    const model = currentModel();
    if (!pageReady) {
      const result = await createCockpitPage(bridge);
      diag("createCockpitPage", { ok: result.ok, reason: result.reason ?? null, ...flags() });
      if (closed) { diagSkip("closed", { after: "createCockpitPage" }); return; }
      if (!result.ok) { console.warn("[cadence] draw failed:", result.reason); return; }
      pageReady = true;
      // A new page starts with blank images.
      tiles.reset();
    }
    textBackend ??= autoBackend();
    // Never awaited: a slow transfer must not hold up the next beat.
    void tiles.push(composeCockpit(model, textBackend));
  };

  /**
   * One page write at a time. Beat timer, the 1 s tick and gestures all ask for
   * redraws; overlapping writes interleave over BLE and can leave an older frame
   * recorded as the last one shown. A request during a write redraws once after.
   */
  const draw = (): Promise<void> => {
    if (exitAsked()) { diagSkip("exitAsked", { in: "draw" }); return Promise.resolve(); }
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
      phone?.refreshLive();
    }, 1000);
  };
  const resume = (): void => {
    if (!paused || closed) return;
    paused = false;
    pageReady = false;
    startTick();
    scheduleBeat();
    void draw();
  };

  // shutDownPageContainer(1) resolves when the dialog is SHOWN, not when the user answered: its result never
  // ends the session. If the user confirms, the system ends the app (sysEvent 6/7, handled below).
  const requestExit = createExitRequest(bridge, {
    onBack: () => {
      // The dialog took the page away. On the next input put it up again the way of the first one,
      // so the glasses deliver input (and the next 2×) to the app again (store review 16.10.2026).
      diag("onBack", { phase: "start", ...flags() });
      if (closed) return;
      pageReady = false;
      forgetPage(bridge);
      const restored = draw();
      if (diagOn()) {
        restored.then(
          () => diag("onBack", { phase: "end", ...flags() }),
          (error: unknown) => diag("onBack", { phase: "fail", error: String(error), ...flags() }),
        );
      }
      return restored;
    },
  }, "cadence");
  exitAsked = requestExit.asked;
  /** Every ask for the exit dialog goes through here, so the step log sees it. */
  const askExit = (via: string): Promise<void> => {
    diag("exitAsk", { via, ...flags() });
    const asked = requestExit();
    if (diagOn()) void asked.then(() => diag("exitAskDone", { via, ...flags() }));
    return asked;
  };

  await draw();

  /**
   * Starts or stops the beat (glasses tap after the arm step, or the phone's button).
   * Starting after a pause begins at bar 1 again ("from the top"): that used to need a hold,
   * which the temple pad never delivers (step log 21.10.2026, only the optional R1 ring does).
   */
  const togglePlay = (now: number): void => {
    state = state.running ? toggle(state, data.settings, now) : toggle(restartCount(state, now), data.settings, now);
    if (state.running) sessionStartedAt = sessionStartedAt ?? now;
    else endSession();
    persistRun();
    scheduleBeat();
  };

  bridge.onEvenHubEvent((event) => {
    if (closed) return;
    // The 4/5 right after an exit call are the system dialog's own show/close, not the app entering/leaving.
    const dialog = requestExit.onLifecycle(event);
    if (dialog !== null) { diag(dialog, flags()); return; }
    const lifecycle = lifecycleFromEvent(event);
    if (lifecycle !== null) diag("lifecycle", { step: lifecycle, ...flags() });
    if (lifecycle !== "background" && lifecycle !== "exit") requestExit.back();
    if (lifecycle === "foreground") { paused = true; resume(); return; }
    if (lifecycle === "background") { persistRun(); paused = true; disarm(); stopTimers(); return; }
    if (lifecycle === "exit") {
      // The system ends the app (the user confirmed the exit dialog): close the session like the dialog used to.
      endSession();
      state = createState();
      persistRun();
      closed = true;
      tiles.close();
      stopTimers();
      disarm();
      return;
    }
    // A gesture means the app is on the glasses again, even if no "foreground" came.
    const wasPaused = paused;
    resume();
    // The glasses' side menu (off while SIDE_MENU is false). A menu click only cancels a pending pause; the beat keeps running.
    const menuId = menuItemIdFromEvent(event);
    if (menuId !== null) {
      disarm();
      void draw();
      return;
    }
    const gesture = gestureFromEvent(event, { invertScroll: data.invertScroll });
    if (!gesture) return;

    // Anything but the confirming tap cancels a pending pause: a swipe never changes
    // the tempo then, a ring hold never restarts the count, and a double tap goes back, not out.
    if (gesture.gesture !== "click" && isArmed()) {
      disarm();
      void draw();
      return;
    }

    switch (gesture.gesture) {
      case "click": {
        const now = Date.now();
        if (state.running) {
          if (!isArmed()) {
            // First tap: arm. The timer restores the footer when the time runs out.
            armedUntil = now + ARM_MS;
            clearTimeout(armTimer);
            armTimer = setTimeout(() => { disarm(); void draw(); }, ARM_MS);
            break;
          }
          disarm();
        }
        togglePlay(now);
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
        // Only the optional R1 ring delivers a hold (the temple pad opens the system menu instead), so this
        // is an extra, never the only way: the same "from the top" happens on every start after a pause.
        // Stopped: nothing. Running: bar 1 again, the beat keeps running.
        if (!state.running) return;
        state = restartCount(state, Date.now());
        persistRun();
        scheduleBeat();
        break;
      case "doubleClick":
        // Back one level; on the main screen it leaves: system exit dialog, the beat keeps running until the user confirms. It never pauses.
        // Coming back from the background with this very 2x: ask only after the restore draw (a dialog call while the page is being created is lost).
        if (wasPaused) void settleRestore(draw()).then(() => askExit("doubleClickPaused"));
        else void askExit("doubleClick");
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

  phone = mountPhoneUi({
    getLocale: () => locale,
    setLocale: (next) => {
      locale = next;
      rememberLocale(bridge, next);
      void draw();
    },
    getData: () => data,
    getLive: liveInfo,
    toggle: () => {
      if (closed) return;
      disarm();
      togglePlay(Date.now());
      void draw();
      phone?.refreshLive();
    },
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
