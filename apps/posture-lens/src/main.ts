import {
  ImuReportPace, OsEventTypeList, waitForEvenAppBridge, type EvenAppBridge,
} from "@evenrealities/even_hub_sdk";
import { sampleFrom, type Vec3 } from "./imu/vector";
import {
  addSample, calibrate, createMonitor, reset, type PostureMonitor,
} from "./posture/monitor";
import { gestureFromEvent } from "./input/gestures";
import { buildView, type PostureView } from "./glasses/view";
import { sameView } from "./glasses/diff";
import { createPage, sendImage, updatePage } from "./glasses/render";
import { GAUGE, drawGauge, gaugeAngle, gaugeKey, type GaugeState } from "./glasses/gauge";
import { createImageLane } from "./glasses/lane";
import { angleKey, drawAngle, ANGLE_IMAGE, type AngleState } from "./glasses/digits";
import { FIGURE_IMAGE, drawFigure, figureKey, nextStage, type FigureStage, type FigureState } from "./glasses/figure";
import { quantize } from "./glasses/bitmap";
import { encodePng } from "./glasses/pixel";
import { load, save, type PostureData } from "./storage/persist";
import { mountPhoneUi } from "./ui/phone";
import { createExitRequest } from "./exit";
import { resolveLocale, rememberLocale, setLocale, type Locale } from "./i18n";
import { isFinalExit, lifecycleFromEvent } from "./lifecycle";
import { activeConfirm, CONFIRM_WINDOW_MS, confirmStep, type PendingConfirm } from "./input/confirm";

/**
 * IMU sampling rate. 500 ms is plenty for posture, which changes over minutes,
 * and keeps the BLE link and battery quiet compared with the 100 ms option.
 */
const IMU_PACE = ImuReportPace.P500;

/** Redraw cadence for the countdown; sameView() drops the no-op ticks. */
const TICK_MS = 1000;

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
  const bridge: EvenAppBridge = await waitForEvenAppBridge();

  let data: PostureData = await load(bridge);
  let monitor: PostureMonitor = createMonitor();
  let lastSample: Vec3 | null = null;
  let lastView: PostureView | null = null;
  let pageReady = false;
  /** Set by a reconnect or a return to the foreground: the next draw rebuilds the page. */
  let rebuildWanted = false;
  /** In the background: the IMU is off and nothing is drawn. */
  let paused = false;
  /** A tap that would overwrite the calibration, or a swipe that clears today's tally, waits for its second. */
  let pending: PendingConfirm<"calibrate" | "reset"> | null = null;
  let confirmTimer: ReturnType<typeof setTimeout> | undefined;
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
  let figure: FigureStage | null = null;
  /** Images are written at most every 700 ms and only when their picture changes. */
  const lane = createImageLane((target, imageData) => sendImage(bridge, target, imageData), 700);

  // A stored calibration makes the app usable immediately after a restart.
  if (data.reference) {
    monitor = { ...monitor, reference: data.reference, state: "good" };
  }

  const currentView = (): PostureView =>
    buildView(monitor, data.settings, {
      showAngleWhenGood: data.showAngleWhenGood,
      locale,
      sensorOff,
      justCalibrated: calibratedAt !== null && Date.now() - calibratedAt < CONFIRM_MS,
      confirm: activeConfirm(pending, Date.now())?.kind ?? null,
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

  /**
   * Asks the lane for the head gauge. The key is quantised, so most calls
   * change nothing and send nothing; the lane is never awaited.
   */
  const requestGauge = (): void => {
    if (!pageReady || closed) return;
    const calibrated = monitor.reference !== null && !sensorOff;
    gaugeDeg = calibrated ? gaugeAngle(gaugeDeg, monitor.angle) : null;
    const state: GaugeState = { calibrated, angle: gaugeDeg, warnAngle: data.settings.warnAngle, alert: monitor.state === "leaning" || monitor.state === "warned" };
    lane.request(GAUGE, gaugeKey(state), () => encodePng(drawGauge(state)));
    const alert = state.alert;
    // The figure straightens or slumps in four steps; it is sent only when the step changes.
    figure = nextStage(figure, calibrated ? monitor.angle : null, data.settings.warnAngle);
    const fig: FigureState = { stage: figure, alert };
    lane.request(FIGURE_IMAGE, figureKey(fig), () => encodePng(drawFigure(fig)));
    // The lean as big digits: only while it matters (leaning, warned, or if the user asked to see it).
    const show = calibrated && (alert || (data.showAngleWhenGood && monitor.angle !== null));
    digitsDeg = show ? quantize(digitsDeg, monitor.angle, 1) : null;
    const angle: AngleState = { show, deg: digitsDeg, alert };
    lane.request(ANGLE_IMAGE, angleKey(angle), () => encodePng(drawAngle(angle)));
  };

  const drawOnce = async (): Promise<void> => {
    if (closed || paused) return;
    if (rebuildWanted) { rebuildWanted = false; pageReady = false; }
    const view = currentView();
    if (!pageReady || !sameView(lastView, view)) {
      const created = !pageReady;
      const result = pageReady ? await updatePage(bridge, view) : await createPage(bridge, view);
      if (!result.ok) {
        pageReady = false;
        console.warn("[posturelens] draw failed:", result.reason);
        return;
      }
      pageReady = true;
      lastView = view;
      // A new page starts with a blank image.
      if (created) lane.invalidate();
    }
    requestGauge();
  };

  /** One page write at a time; a request during a write redraws once after it. */
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

  const persist = (next: PostureData): Promise<void> =>
    save(bridge, next).catch((error: unknown) => { console.warn("[posturelens] save failed:", error); });

  /** Turns IMU reporting on; a refusal or a call that never answers shows "no sensor". */
  const startImu = async (): Promise<void> => {
    const imuOk = await withTimeout(bridge.imuControl(true, IMU_PACE), IMU_TIMEOUT_MS, false);
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
    clearInterval(tick);
    clearInterval(demoTimer);
    clearTimeout(confirmTimer);
    lane.close();
  };

  const requestExit = createExitRequest(bridge, {
    onConfirmed: async () => {
      shutDown();
      await bridge.imuControl(false).catch(() => undefined);
    },
  }, "posturelens");

  /**
   * Arms a gesture that overwrites something; the same gesture again within
   * a few seconds carries it out. Returns true when it is confirmed now.
   */
  const confirmed = (kind: "calibrate" | "reset"): boolean => {
    const step = confirmStep(pending, kind, Date.now());
    pending = step.pending;
    clearTimeout(confirmTimer);
    if (!step.confirmed) confirmTimer = setTimeout(() => { pending = null; void draw(); }, CONFIRM_WINDOW_MS + 50);
    return step.confirmed;
  };

  // Gestures first: the IMU call below may never answer, and before this the
  // app reacted to nothing at all while it waited — not even the double tap.
  bridge.onEvenHubEvent((event) => {
    if (closed) return;
    const step = lifecycleFromEvent(event);
    if (step === "foregroundExit") {
      // Out of sight: no IMU (battery, BLE), no drawing. The calibration and the tally stay.
      paused = true;
      stopImu();
      return;
    }
    if (step === "foregroundEnter") {
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
      lastSample = sample;
      sensorOff = false;
      monitor = addSample(monitor, sample, data.settings, Date.now());
      if (calibratePending) calibrateTo(sample);
      void draw();
      return;
    }

    const gesture = gestureFromEvent(event, { invertScroll: data.invertScroll });
    if (!gesture) return;

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
        // Clears today's tally: only on a second swipe within a few seconds.
        if (!confirmed("reset")) break;
        pending = null;
        monitor = reset(monitor);
        break;
      case "doubleClick":
        // System exit dialog; monitoring (and the IMU) carry on until the user confirms.
        void requestExit();
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

  tick = setInterval(() => { void draw(); }, TICK_MS);

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
      lastSample = sample;
      sensorOff = false;
      monitor = addSample(monitor, sample, { ...data.settings, smoothing: 0.5 }, Date.now());
      void draw();
    }, 500);
  }

  mountPhoneUi({
    getLocale: () => locale,
    setLocale: (next) => {
      locale = next;
      rememberLocale(bridge, next);
      void draw();
    },
    getSensorOff: () => sensorOff,
    getData: () => data,
    setData: async (next) => {
      data = next;
      await persist(next);
      if (!next.reference) monitor = createMonitor();
      await draw();
    },
  });
}

void boot().catch((error: unknown) => {
  console.error("[posturelens] failed to start:", error);
});
