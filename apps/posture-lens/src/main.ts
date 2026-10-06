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
import { encodePng } from "./glasses/pixel";
import { load, save, type PostureData } from "./storage/persist";
import { mountPhoneUi } from "./ui/phone";
import { createExitRequest } from "./exit";
import { getLocale, setLocale, type Locale } from "./i18n";

/**
 * IMU sampling rate. 500 ms is plenty for posture, which changes over minutes,
 * and keeps the BLE link and battery quiet compared with the 100 ms option.
 */
const IMU_PACE = ImuReportPace.P500;

/** Redraw cadence for the countdown; sameView() drops the no-op ticks. */
const TICK_MS = 1000;

/** How long the "saved" confirmation stays after a calibration. */
const CONFIRM_MS = 8000;

async function boot(): Promise<void> {
  const bridge: EvenAppBridge = await waitForEvenAppBridge();

  let data: PostureData = await load(bridge);
  let monitor: PostureMonitor = createMonitor();
  let lastSample: Vec3 | null = null;
  let lastView: PostureView | null = null;
  let pageReady = false;
  let closed = false;
  let tick: ReturnType<typeof setInterval> | undefined;
  let drawing: Promise<void> | null = null;
  let drawAgain = false;
  let locale: Locale = getLocale();
  let sensorOff = false;
  /** A tap that arrived before the first IMU sample; it calibrates on that sample. */
  let calibratePending = false;
  let calibratedAt: number | null = null;
  /** Angle as last drawn on the gauge, in 2° steps; the hysteresis works against it. */
  let gaugeDeg: number | null = null;
  const lane = createImageLane((target, imageData) => sendImage(bridge, target, imageData));

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
  };

  const drawOnce = async (): Promise<void> => {
    if (closed) return;
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

  await draw();

  // audioControl and imuControl both require a page to exist first.
  const imuOk = await bridge.imuControl(true, IMU_PACE).catch(() => false);
  if (!imuOk) {
    console.warn("[posturelens] IMU reporting was refused; posture cannot be measured.");
    sensorOff = true;
    await draw();
  }

  const requestExit = createExitRequest(bridge, {
    onConfirmed: async () => {
      closed = true;
      clearInterval(tick);
      lane.close();
      await bridge.imuControl(false).catch(() => undefined);
    },
  }, "posturelens");

  bridge.onEvenHubEvent((event) => {
    if (closed) return;
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
        // Tap always means "this is upright now" — the one thing the user
        // needs on the glasses, whether calibrating or correcting a drift.
        // Before the first sample arrives the tap is remembered, not lost.
        if (lastSample) calibrateTo(lastSample);
        else calibratePending = true;
        break;
      case "scrollUp":
      case "scrollDown":
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
    if (status?.connectType === "connected" && !closed) {
      pageReady = false;
      // IMU reporting does not survive a reconnect.
      void bridge.imuControl(true, IMU_PACE).catch(() => undefined);
      void draw();
    }
  });

  tick = setInterval(() => { void draw(); }, TICK_MS);

  mountPhoneUi({
    getLocale: () => locale,
    setLocale: (next) => {
      locale = next;
      setLocale(next);
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
