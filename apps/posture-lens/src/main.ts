import {
  ImuReportPace, OsEventTypeList, waitForEvenAppBridge, type EvenAppBridge,
} from "@evenrealities/even_hub_sdk";
import { sampleFrom, type Vec3 } from "./imu/vector";
import {
  addSample, calibrate, createMonitor, reset, type PostureMonitor,
} from "./posture/monitor";
import { gestureFromEvent, menuItemIdFromEvent } from "./input/gestures";
import { sameView } from "./glasses/diff";
import {
  COCKPIT_TILES, createCockpitPage, createTextPage, forgetPage, guardedTileSend, updateTextPage, type MenuSpec, type TextView,
} from "./glasses/page";
import { gaugeAngle, quantize } from "./glasses/quant";
import { cockpitModel, type CockpitModel } from "./cockpit/model";
import { composeCockpit } from "./cockpit/compose";
import { createTileSender } from "./screen/sender";
import { autoBackend, type TextBackend } from "./screen/text";
import { load, save, type PostureData } from "./storage/persist";
import { mountPhoneUi, type PhoneLive, type PhoneUi } from "./ui/phone";
import { EMPTY_BUCKETS, updateBuckets, type BucketState } from "./posture/buckets";
import { addToStats, createStats, record, recordingDone, startRecording, type Recording, type SensorStats } from "./imu/diagnostics";
import { buildSensorView } from "./glasses/sensor-view";
import { buildMenuView, MENU_ENTRIES } from "./glasses/menu-view";
import { createExitRequest, settleRestore } from "./exit";
import { resolveLocale, rememberLocale, setLocale, type Locale } from "./i18n";
import { t } from "./messages";
import { isFinalExit, lifecycleFromEvent } from "./lifecycle";
import { activeConfirm, CONFIRM_WINDOW_MS, confirmStep, type PendingConfirm } from "./input/confirm";
import { diag, diagCount, diagOn, diagSkip, startDiag } from "./diag/diag";
import { traceBridge } from "./diag/bridge";
import { VERSION } from "./version";

/**
 * IMU sampling rate. 500 ms is plenty for posture, which changes over minutes,
 * and keeps the BLE link and battery quiet compared with the 100 ms option.
 */
const IMU_PACE = ImuReportPace.P500;

/** Redraw cadence for the countdown; sameView() drops the no-op ticks. */
const TICK_MS = 1000;

/** Sensor test: the glasses text is refreshed at most five times a second. */
const SENSOR_REFRESH_MS = 200;

/** Side-menu item ids (QIS v1.2: help, sensor test and the tally live in the glasses' side menu). */
const MENU_SENSOR = 1;
const MENU_RESET = 2;

/**
 * The glasses' side menu (QIS v1.2). Off: its clicks never reach the app and, while a page carries it, a hold
 * opens it instead of reaching the app (step log from the real glasses, 15.10.2026). Off means: the pages carry
 * no menu and a swipe on the posture screen opens the app's own list (sensor test, clear tally). A hold from the
 * temple pad never reaches the app at all (only the optional R1 ring delivers one, step log 21.10.2026).
 */
export const SIDE_MENU = false;

/** How long the "saved" confirmation stays after a calibration. */
const CONFIRM_MS = 8000;

/** A native call that does not answer must not hold anything up. */
const IMU_TIMEOUT_MS = 5000;

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(fallback); },
    );
  });
}

async function boot(): Promise<void> {
  // Private step log (VITE_TRAFFIC_URL, tailnet only): calls, results and events. Store builds: off, no URL in the bundle.
  startDiag((import.meta as { env?: Record<string, string | undefined> }).env?.["VITE_TRAFFIC_URL"] ?? "", VERSION);
  const bridge: EvenAppBridge = traceBridge(await waitForEvenAppBridge());

  let data: PostureData = await load(bridge);
  let monitor: PostureMonitor = createMonitor();
  let lastSample: Vec3 | null = null;
  let lastView: TextView | null = null;
  let pageReady = false;
  /** Which kind of page the glasses carry: a change means one rebuild. */
  let installed: "text" | "cockpit" | null = null;
  let textBackend: TextBackend | null = null;
  /** Set by a reconnect or a return to the foreground: the next draw rebuilds the page. */
  let rebuildWanted = false;
  /** In the background: the IMU is off and nothing is drawn. */
  let paused = false;
  /**
   * A tap that would overwrite the calibration waits for a second tap; the side-menu entry that clears
   * today's tally waits for the same entry again (QIS v1 / v1.2 ruling 3), both within 4 s.
   */
  let pending: PendingConfirm<"calibrate" | "reset"> | null = null;
  let confirmTimer: ReturnType<typeof setTimeout> | undefined;
  /** The app's own list (swipe on the posture screen); "none" is the posture screen. */
  let menuScreen: "none" | "menu" = "none";
  let menuCursor = 0;
  /** Shown in the own menu's header until the next gesture ("Tally cleared"), only without the side menu. */
  let menuNote: string | null = null;
  /** Key of the side menu the page on the glasses carries; a different one (language) needs a rebuild. */
  let pageMenuKey = "";
  let demoTimer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let tick: ReturnType<typeof setInterval> | undefined;
  let drawing: Promise<void> | null = null;
  let drawAgain = false;
  let locale: Locale = await resolveLocale(bridge);
  setLocale(locale);
  let sensorOff = false;
  /** A tap that arrived before the first IMU sample; it calibrates on that sample. */
  let calibratePending = false;
  let calibratedAt: number | null = null;
  /** Angle as last drawn on the gauge, in 2° steps; the hysteresis works against it. */
  let gaugeDeg: number | null = null;
  /** Angle as last drawn in the big digits, in whole degrees. */
  let digitsDeg: number | null = null;
  /** Sensor test (long press, or the phone's "More" tab): raw values instead of the posture screen. */
  let sensorMode = false;
  /** The pace the sensor test asks for; the posture screen always uses IMU_PACE. */
  let diagPace: ImuReportPace = IMU_PACE;
  let diagStats: SensorStats = createStats();
  let diagRec: Recording | null = null;
  let diagRecReported = false;
  let diagTimer: ReturnType<typeof setInterval> | undefined;
  let phone: PhoneUi | null = null;
  /** The tally in slices of ten minutes, for the phone only (memory, never written). */
  let buckets: BucketState = EMPTY_BUCKETS;

  // A stored calibration makes the app usable immediately after a restart.
  if (data.reference) {
    monitor = { ...monitor, reference: data.reference, state: "good" };
  }

  type Scene =
    | { readonly kind: "text"; readonly view: TextView }
    | { readonly kind: "cockpit"; readonly model: CockpitModel };

  /** Everything on the glasses for one moment: the sensor test and the list are text, the posture screen is the cockpit image. */
  const currentScene = (): Scene => {
    if (sensorMode) return { kind: "text", view: buildSensorView(diagStats, { locale, pace: diagPace, recording: diagRec, sensorOff }) };
    if (menuScreen === "menu") {
      return { kind: "text", view: buildMenuView({ locale, cursor: menuCursor, resetArmed: activeConfirm(pending, Date.now())?.kind === "reset", note: menuNote }) };
    }
    const now = Date.now();
    const calibrated = monitor.reference !== null && !sensorOff;
    const alert = monitor.state === "leaning" || monitor.state === "warned";
    // The needle moves in 2 degree steps and the number in whole degrees, both with hysteresis (a tile is only sent when they change).
    gaugeDeg = calibrated ? gaugeAngle(gaugeDeg, monitor.angle) : null;
    digitsDeg = calibrated && (alert || (data.showAngleWhenGood && monitor.angle !== null)) ? quantize(digitsDeg, monitor.angle, 1) : null;
    return {
      kind: "cockpit",
      model: cockpitModel({
        monitor, settings: data.settings, locale, now, showAngleWhenGood: data.showAngleWhenGood, sensorOff,
        justCalibrated: calibratedAt !== null && now - calibratedAt < CONFIRM_MS,
        confirm: activeConfirm(pending, now)?.kind === "calibrate" ? "calibrate" : null,
        digitsAngle: digitsDeg, gaugeAngle: gaugeDeg,
      }),
    };
  };

  const menuSpec = (): MenuSpec => !SIDE_MENU ? { key: "none", items: [] } : ({
    key: `menu:${locale}`,
    items: [
      { id: MENU_SENSOR, label: t(locale, "g.m.sensor") },
      { id: MENU_RESET, label: t(locale, "g.m.reset") },
    ],
  });

  const calibrateTo = (sample: Vec3): void => {
    const now = Date.now();
    const next = calibrate(monitor, sample, now);
    // A zero vector carries no direction; keep the tap and use the next usable sample.
    if (next === monitor) { calibratePending = true; return; }
    monitor = next;
    calibratePending = false;
    calibratedAt = now;
    data = { ...data, reference: monitor.reference };
    void persist(data);
  };

  // While the exit dialog may be on screen (asked, no input since) no timer, poll or stream may draw: a page call
  // could cover it. Data keeps being collected; the back signal restores the page the way of the first one.
  let exitAsked = (): boolean => false;
  /** The cockpit is one 576 x 288 frame; only the tiles whose pixels changed cross Bluetooth. Never while the dialog may be up or after the cockpit was left. */
  const tiles = createTileSender(COCKPIT_TILES, guardedTileSend(bridge, () => {
    const allowed = !exitAsked() && !closed && !paused && installed === "cockpit";
    if (!allowed) diagCount("tileRefused:" + (exitAsked() ? "exitAsked" : closed ? "closed" : paused ? "paused" : "installed"));
    return allowed;
  }));
  /** The flags that decide whether anything is drawn, for the step log. */
  const flags = (): Record<string, string | boolean> => ({ pageReady, paused, closed, installed: installed ?? "none", rebuildWanted, exitAsked: exitAsked() });

  const drawOnce = async (): Promise<void> => {
    if (exitAsked()) { diagSkip("exitAsked"); return; }
    if (closed || paused) { diagSkip(closed ? "closed" : "paused"); return; }
    if (rebuildWanted) { rebuildWanted = false; pageReady = false; }
    const scene = currentScene();
    const menu = menuSpec();
    if (scene.kind === "cockpit") {
      if (installed !== "cockpit" || (pageReady && menu.key !== pageMenuKey)) pageReady = false;
      if (!pageReady) {
        diagSkip(null);
        const result = await createCockpitPage(bridge, menu);
        diag("createCockpitPage", { ok: result.ok, reason: result.reason ?? null, ...flags() });
        if (closed) { diagSkip("closed", { after: "createCockpitPage" }); return; }
        if (!result.ok) { pageReady = false; console.warn("[posturelens] draw failed:", result.reason); return; }
        pageReady = true;
        installed = "cockpit";
        pageMenuKey = menu.key;
        lastView = null;
        // A new page starts with blank images.
        tiles.reset();
      }
      diagSkip(null);
      textBackend ??= autoBackend();
      // Never awaited: a slow transfer must not hold up the next sample.
      void tiles.push(composeCockpit(scene.model, textBackend));
      return;
    }
    // Leaving the cockpit: its containers are about to go, no tile may be written any more.
    if (installed === "cockpit") { diag("installed", { from: "cockpit", to: "text" }); installed = null; pageReady = false; }
    // The side menu travels with the page: a different one (language) means one rebuild.
    if (pageReady && menu.key !== pageMenuKey) pageReady = false;
    if (pageReady && sameView(lastView, scene.view)) { diagSkip("sameView"); return; }
    diagSkip(null);
    const wasReady = pageReady;
    const result = pageReady ? await updateTextPage(bridge, scene.view, lastView) : await createTextPage(bridge, scene.view, menu);
    if (!wasReady) diag("createTextPage", { ok: result.ok, reason: result.reason ?? null, ...flags() });
    if (closed) { diagSkip("closed", { after: wasReady ? "updateTextPage" : "createTextPage" }); return; }
    if (!result.ok) { pageReady = false; console.warn("[posturelens] draw failed:", result.reason); return; }
    pageReady = true;
    installed = "text";
    pageMenuKey = menu.key;
    lastView = scene.view;
  };

  /** One page write at a time; a request during a write redraws once after it. */
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

  const persist = (next: PostureData): Promise<void> =>
    save(bridge, next).catch((error: unknown) => { console.warn("[posturelens] save failed:", error); });

  /** Turns IMU reporting on; a refusal or a call that never answers shows "no sensor". */
  const startImu = async (): Promise<void> => {
    const imuOk = await withTimeout(bridge.imuControl(true, sensorMode ? diagPace : IMU_PACE), IMU_TIMEOUT_MS, false);
    if (closed || paused) return;
    if (!imuOk) {
      console.warn("[posturelens] IMU reporting was refused; posture cannot be measured.");
      sensorOff = true;
      void draw();
    }
  };

  const stopImu = (): void => { void bridge.imuControl(false).catch(() => undefined); };

  /** Everything off for good: after the exit dialog, a system exit or a crash. */
  const shutDown = (): void => {
    closed = true;
    clearInterval(diagTimer);
    clearInterval(tick);
    clearInterval(demoTimer);
    clearTimeout(confirmTimer);
    tiles.close();
  };

  /** Every IMU sample, from the glasses or the demo. */
  const onSample = (sample: Vec3, now: number, settings = data.settings): void => {
    lastSample = sample;
    sensorOff = false;
    monitor = addSample(monitor, sample, settings, now);
    if (calibratePending) calibrateTo(sample);
    if (sensorMode) {
      diagStats = addToStats(diagStats, sample, now);
      if (diagRec) diagRec = record(diagRec, sample, now);
      // The sensor screen is drawn by its own timer, never once per sample.
      return;
    }
    void draw();
  };

  /** Runs while the sensor test is on: redraw (text only) and notice a finished recording. */
  const sensorTick = (): void => {
    if (closed || paused) return;
    if (diagRec && !diagRecReported && recordingDone(diagRec, Date.now())) {
      diagRecReported = true;
      phone?.refresh();
    }
    void draw();
  };

  const setSensorMode = (on: boolean): void => {
    if (on === sensorMode || closed) return;
    sensorMode = on;
    pending = null;
    clearInterval(diagTimer);
    diagTimer = undefined;
    if (on) {
      diagStats = createStats();
      diagTimer = setInterval(sensorTick, SENSOR_REFRESH_MS);
    } else {
      diagRec = null;
    }
    // Back to the posture pace (or on to the chosen one) only when they differ.
    if (diagPace !== IMU_PACE && !paused) void startImu();
    void draw();
    phone?.refresh();
  };

  const setDiagPace = (pace: number): void => {
    diagPace = pace as ImuReportPace;
    // The old rate no longer applies; min/max stay.
    diagStats = { ...diagStats, recent: [] };
    if (sensorMode && !paused) void startImu();
  };

  // shutDownPageContainer(1) resolves when the dialog is SHOWN, not when the user answered: the result never
  // tears the app down (the system ends it: sysEvent 6/7). On the next input the page comes back as a first page.
  const requestExit = createExitRequest(bridge, {
    // The dialog took the page away: put it up again the way of the first one,
    // so the glasses deliver input (and the next 2x) to the app again.
    onBack: () => {
      diag("onBack", { phase: "start", ...flags() });
      if (closed) return;
      pageReady = false;
      lastView = null;
      installed = null;
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
  }, "posturelens");
  exitAsked = requestExit.asked;
  /** Every ask for the exit dialog goes through here, so the step log sees it. */
  const askExit = (via: string): Promise<void> => {
    diag("exitAsk", { via, ...flags() });
    const asked = requestExit();
    if (diagOn()) void asked.then(() => diag("exitAskDone", { via, ...flags() }));
    return asked;
  };

  /**
   * Arms a gesture that overwrites something; the same gesture again within
   * a few seconds carries it out. Returns true when it is confirmed now.
   */
  const disarm = (): void => {
    pending = null;
    clearTimeout(confirmTimer);
  };

  const confirmed = (kind: "calibrate" | "reset"): boolean => {
    const step = confirmStep(pending, kind, Date.now());
    pending = step.pending;
    clearTimeout(confirmTimer);
    if (!step.confirmed) confirmTimer = setTimeout(() => { pending = null; void draw(); }, CONFIRM_WINDOW_MS + 50);
    return step.confirmed;
  };

  /** An item of the glasses' side menu. */
  const onMenu = (itemId: number): void => {
    if (paused) return;
    if (itemId === MENU_SENSOR) {
      disarm();
      menuScreen = "none";
      setSensorMode(true);
    } else if (itemId === MENU_RESET) {
      // Not while the sensor test or the help is in front: the wearer should see what is armed.
      if (sensorMode || menuScreen !== "none") return;
      if (!confirmed("reset")) { void draw(); return; }
      pending = null;
      monitor = reset(monitor);
    } else {
      return;
    }
    void draw();
  };

  // Gestures first: the IMU call below may never answer, and before this the
  // app reacted to nothing at all while it waited — not even the double tap.
  bridge.onEvenHubEvent((event) => {
    if (closed) return;
    // The 4/5 right after an exit call are the system dialog's own show/close, not the app entering/leaving.
    const dialog = requestExit.onLifecycle(event);
    if (dialog !== null) { diag(dialog, flags()); return; }
    const step = lifecycleFromEvent(event);
    if (step !== null) diag("lifecycle", { step, ...flags() });
    if (step === "foregroundExit") {
      // Out of sight: no IMU (battery, BLE), no drawing. The calibration and the tally stay.
      paused = true;
      stopImu();
      return;
    }
    if (step === "foregroundEnter") {
      requestExit.back();
      paused = false;
      rebuildWanted = true;
      void draw().then(startImu);
      return;
    }
    if (isFinalExit(step)) {
      shutDown();
      stopImu();
      return;
    }
    const sys = (event as { sysEvent?: { eventType?: number; imuData?: unknown } }).sysEvent;

    if (sys?.eventType === OsEventTypeList.IMU_DATA_REPORT) {
      const sample = sampleFrom(sys.imuData);
      if (!sample) return;
      onSample(sample, Date.now());
      return;
    }
    // Not the IMU stream: it keeps flowing while the dialog is open and says nothing about the user.
    requestExit.back();

    // QIS v1.2: the glasses' side menu. A menu click never changes data on its own,
    // except "clear tally", which is armed first and needs the same entry again within 4 s.
    const menuId = menuItemIdFromEvent(event);
    if (menuId !== null) {
      onMenu(menuId);
      return;
    }

    const gesture = gestureFromEvent(event, { invertScroll: data.invertScroll });
    if (!gesture) return;

    // Anything but a tap cancels what is armed (swipe, 2x, hold) - QIS v1. The exception is the tally
    // armed from the side menu: holding is how the wearer gets back into that menu to confirm, so a hold
    // or a swipe never cancels it; a tap or 2× does (and so does the time running out).
    const armedKind = activeConfirm(pending, Date.now())?.kind ?? null;
    menuNote = null;
    if (SIDE_MENU && armedKind === "reset") {
      if (gesture.gesture === "click" || gesture.gesture === "doubleClick") { disarm(); void draw(); return; }
      return;
    }
    if (gesture.gesture !== "click") {
      const wasArmed = pending !== null;
      disarm();
      if (wasArmed) void draw();
      // A swipe that cancels an armed re-calibration only cancels; it does not open the list as well.
      if (wasArmed && menuScreen === "none" && !sensorMode && (gesture.gesture === "scrollUp" || gesture.gesture === "scrollDown")) return;
    }

    if (sensorMode) {
      // In the test a tap restarts min/max and 2x goes back one level; hold and swipes do nothing.
      if (gesture.gesture === "click") { diagStats = createStats(); void draw(); }
      else if (gesture.gesture === "doubleClick") setSensorMode(false);
      return;
    }

    if (menuScreen === "menu") {
      switch (gesture.gesture) {
        case "scrollUp":
          menuCursor = Math.max(0, menuCursor - 1);
          break;
        case "scrollDown":
          menuCursor = Math.min(MENU_ENTRIES.length - 1, menuCursor + 1);
          break;
        case "click": {
          const entry = MENU_ENTRIES[menuCursor];
          if (entry === "reset") {
            // Clearing today's tally takes two single taps within 4 s; anything else cancels.
            if (!confirmed("reset")) break;
            pending = null;
            monitor = reset(monitor);
            menuNote = t(locale, "g.m.cleared");
            break;
          }
          disarm();
          if (entry === "sensor") setSensorMode(true);
          break;
        }
        case "doubleClick":
          menuScreen = "none";
          break;
        default:
          // Hold does nothing in the menu.
          return;
      }
      void draw();
      return;
    }

    switch (gesture.gesture) {
      case "click":
        // Tap means "this is upright now". The first calibration takes one
        // tap; overwriting a saved one takes a second tap within a few
        // seconds, so a stray touch cannot replace it.
        if (monitor.reference !== null && !confirmed("calibrate")) break;
        pending = null;
        // Before the first sample arrives the tap is remembered, not lost.
        if (lastSample) calibrateTo(lastSample);
        else calibratePending = true;
        break;
      case "scrollUp":
      case "scrollDown":
      case "longPress":
        // Without the side menu (SIDE_MENU): a swipe (either way) opens the app's own list: sensor test,
        // clearing the tally. The posture screen has nothing else to move. A hold does the same, but only
        // the optional R1 ring delivers one, so the glasses never advertise it.
        if (SIDE_MENU) return;
        menuScreen = "menu";
        menuCursor = 0;
        break;
      case "doubleClick":
        // System exit dialog; monitoring (and the IMU) carry on until the user confirms.
        // A double tap while the app thinks it is in the background (a 5 without dialog) means it is on the
        // glasses again: come back first (page up the way of the first one, IMU on), then ask once the page is there.
        if (paused) {
          paused = false;
          rebuildWanted = true;
          const restore = draw();
          void startImu();
          void settleRestore(restore).then(() => askExit("doubleClickPaused"));
          return;
        }
        void askExit("doubleClick");
        return;
      default:
        return;
    }
    void draw();
  });

  bridge.onDeviceStatusChanged((status) => {
    if (status?.connectType === "connected" && !closed && !paused) {
      rebuildWanted = true;
      // IMU reporting does not survive a reconnect; it needs the page first.
      void draw().then(startImu);
    }
  });

  tick = setInterval(() => {
    buckets = updateBuckets(buckets, monitor.goodSeconds, monitor.leaningSeconds, Date.now());
    void draw();
    phone?.refreshLive();
  }, TICK_MS);

  // The page first (imuControl needs one), then the IMU — both in the
  // background, so neither can hold up the gestures above.
  void draw().then(startImu);

  // ?demo=1 (simulator, screenshots): a head that nods forward and back, no sensor needed.
  if (typeof location !== "undefined" && new URLSearchParams(location.search).get("demo") === "1") {
    monitor = calibrate(monitor, { x: 0, y: 0, z: 1 }, Date.now());
    const started = Date.now();
    demoTimer = setInterval(() => {
      if (closed || paused) return;
      const seconds = (Date.now() - started) / 1000;
      const radians = (Math.max(0, 24 + 24 * Math.sin(seconds / 4)) * Math.PI) / 180;
      const sample = { x: Math.sin(radians), y: 0, z: Math.cos(radians) };
      onSample(sample, Date.now(), { ...data.settings, smoothing: 0.5 });
    }, 500);
  }

  phone = mountPhoneUi({
    getLocale: () => locale,
    setLocale: (next) => {
      locale = next;
      rememberLocale(bridge, next);
      void draw();
    },
    getSensorOff: () => sensorOff,
    getLive: (): PhoneLive => ({ monitor, sensorOff, buckets: buckets.buckets }),
    // The phone's button is as deliberate as a tap on the glasses (the page asks before it overwrites a saved posture).
    calibrate: () => {
      if (closed) return;
      pending = null;
      if (lastSample) calibrateTo(lastSample); else calibratePending = true;
      void draw();
      phone?.refresh();
    },
    getData: () => data,
    setData: async (next) => {
      data = next;
      await persist(next);
      if (!next.reference) monitor = createMonitor();
      await draw();
    },
    sensor: {
      isOn: () => sensorMode,
      setOn: setSensorMode,
      getPace: () => diagPace,
      setPace: setDiagPace,
      resetStats: () => { diagStats = createStats(); },
      startRecording: () => {
        setSensorMode(true);
        diagRec = startRecording(Date.now());
        diagRecReported = false;
      },
      getStats: () => diagStats,
      getRecording: () => diagRec,
    },
  });
}

void boot().catch((error: unknown) => {
  console.error("[posturelens] failed to start:", error);
});
