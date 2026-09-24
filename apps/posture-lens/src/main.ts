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
import { createPage, updatePage } from "./glasses/render";
import { load, save, type PostureData } from "./storage/persist";
import { mountPhoneUi } from "./ui/phone";

/**
 * IMU sampling rate. 500 ms is plenty for posture, which changes over minutes,
 * and keeps the BLE link and battery quiet compared with the 100 ms option.
 */
const IMU_PACE = ImuReportPace.P500;

/** Redraw cadence for the countdown; sameView() drops the no-op ticks. */
const TICK_MS = 1000;

async function boot(): Promise<void> {
  const bridge: EvenAppBridge = await waitForEvenAppBridge();

  let data: PostureData = await load(bridge);
  let monitor: PostureMonitor = createMonitor();
  let lastSample: Vec3 | null = null;
  let lastView: PostureView | null = null;
  let pageReady = false;

  // A stored calibration makes the app usable immediately after a restart.
  if (data.reference) {
    monitor = { ...monitor, reference: data.reference, state: "good" };
  }

  const currentView = (): PostureView =>
    buildView(monitor, data.settings, { showAngleWhenGood: data.showAngleWhenGood });

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
    console.warn("[posturelens] draw failed:", result.reason);
  };

  await draw();

  // audioControl and imuControl both require a page to exist first.
  const imuOk = await bridge.imuControl(true, IMU_PACE).catch(() => false);
  if (!imuOk) {
    console.warn("[posturelens] IMU reporting was refused; posture cannot be measured.");
  }

  bridge.onEvenHubEvent((event) => {
    const sys = (event as { sysEvent?: { eventType?: number; imuData?: unknown } }).sysEvent;

    if (sys?.eventType === OsEventTypeList.IMU_DATA_REPORT) {
      const sample = sampleFrom(sys.imuData);
      if (!sample) return;
      lastSample = sample;
      monitor = addSample(monitor, sample, data.settings, Date.now());
      void draw();
      return;
    }

    const gesture = gestureFromEvent(event, { invertScroll: data.invertScroll });
    if (!gesture) return;

    switch (gesture.gesture) {
      case "click":
        // Tap always means "this is upright now" — the one thing the user
        // needs on the glasses, whether calibrating or correcting a drift.
        if (lastSample) {
          monitor = calibrate(monitor, lastSample, Date.now());
          data = { ...data, reference: monitor.reference };
          void save(bridge, data);
        }
        break;
      case "scrollUp":
      case "scrollDown":
        monitor = reset(monitor);
        break;
      case "doubleClick":
        void bridge.imuControl(false).catch(() => undefined);
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
      // IMU reporting does not survive a reconnect.
      void bridge.imuControl(true, IMU_PACE).catch(() => undefined);
      void draw();
    }
  });

  setInterval(() => { void draw(); }, TICK_MS);

  mountPhoneUi({
    getData: () => data,
    setData: async (next) => {
      data = next;
      await save(bridge, next);
      if (!next.reference) monitor = createMonitor();
      await draw();
    },
  });
}

void boot().catch((error: unknown) => {
  console.error("[posturelens] failed to start:", error);
});
