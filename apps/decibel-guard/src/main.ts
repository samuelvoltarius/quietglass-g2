import {
  AudioInputSource, waitForEvenAppBridge, type EvenAppBridge,
} from "@evenrealities/even_hub_sdk";
import { levelFromPcm, smoothDb, toApproxSpl } from "./audio/level";
import { accumulate, createDose, resetDose, type DoseState } from "./noise/dose";
import { gestureFromEvent } from "./input/gestures";
import { buildView, type NoiseView } from "./glasses/view";
import { sameView } from "./glasses/diff";
import { createPage, sendImage, updatePage } from "./glasses/render";
import { DOSE_BAR, METER, doseKey, dosePercent, drawDoseBar, drawMeter, meterKey, meterLevel, type MeterState } from "./glasses/gauge";
import { createImageLane } from "./glasses/lane";
import { encodePng } from "./glasses/pixel";
import { effectiveOffset, isCalibrated, load, save, type NoiseData } from "./storage/persist";
import { mountPhoneUi } from "./ui/phone";
import { createExitRequest } from "./exit";
import { getLocale, setLocale, type Locale } from "./i18n";

async function boot(): Promise<void> {
  const bridge: EvenAppBridge = await waitForEvenAppBridge();

  let data: NoiseData = await load(bridge);
  let dose: DoseState = createDose();
  let listening = false;
  let smoothedDbfs: number | null = null;
  let lastBlockAt: number | null = null;
  let lastView: NoiseView | null = null;
  let pageReady = false;
  let closed = false;
  let tick: ReturnType<typeof setInterval> | undefined;
  /** Set while the microphone is being opened, so a stop or close can wait for it. */
  let opening: Promise<void> | null = null;
  let drawing: Promise<void> | null = null;
  let drawAgain = false;
  let locale: Locale = getLocale();
  /** The last attempt to open the microphone failed; the glasses say what to do. */
  let micError = false;
  /** Level as last drawn on the meter, in 3 dB steps; the hysteresis works against it. */
  let meterDb: number | null = null;
  const lane = createImageLane((target, imageData) => sendImage(bridge, target, imageData));

  const displayLevel = (): number | null =>
    smoothedDbfs === null ? null : toApproxSpl(smoothedDbfs, effectiveOffset(data));

  const currentView = (): NoiseView =>
    buildView(dose, data.dose, {
      listening,
      level: displayLevel(),
      calibrated: isCalibrated(data),
      locale,
      micError,
    });

  /**
   * Asks the lane for the meter and the dose bar. Both keys are quantised, so
   * most calls change nothing and send nothing; the lane is never awaited.
   */
  const requestImages = (): void => {
    if (!pageReady || closed) return;
    meterDb = listening ? meterLevel(meterDb, displayLevel()) : null;
    const meter: MeterState = { listening, level: meterDb, criterionDb: data.dose.criterionDb };
    lane.request(METER, meterKey(meter), () => encodePng(drawMeter(meter)));
    const percent = dosePercent(dose.fraction);
    lane.request(DOSE_BAR, doseKey(percent), () => encodePng(drawDoseBar(percent)));
  };

  const drawOnce = async (): Promise<void> => {
    if (closed) return;
    const view = currentView();
    if (!pageReady || !sameView(lastView, view)) {
      const created = !pageReady;
      const result = pageReady ? await updatePage(bridge, view) : await createPage(bridge, view);
      if (!result.ok) {
        pageReady = false;
        console.warn("[decibelguard] draw failed:", result.reason);
        return;
      }
      pageReady = true;
      lastView = view;
      // A new page starts with blank images.
      if (created) lane.invalidate();
    }
    requestImages();
  };

  /**
   * One page write at a time. Audio blocks arrive many times a second, each
   * asking for a redraw; overlapping writes interleave over BLE and pile up.
   * A request during a write redraws once after it, with the newest level.
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

  /**
   * Measurement never starts on its own. The microphone opens only in response
   * to an explicit tap, and the display says MIC for as long as it is open.
   */
  const startListening = async (): Promise<void> => {
    if (listening || opening || closed) return;
    opening = (async () => {
      const ok = await bridge.audioControl(true, AudioInputSource.Glasses).catch(() => false);
      if (!ok) {
        console.warn("[decibelguard] microphone was refused");
        micError = true;
        return;
      }
      micError = false;
      // Closed while the microphone was opening: it must not stay open.
      if (closed) {
        await bridge.audioControl(false).catch(() => undefined);
        return;
      }
      listening = true;
      lastBlockAt = null;
    })();
    try {
      await opening;
    } finally {
      opening = null;
    }
    await draw();
  };

  const stopListening = async (): Promise<void> => {
    if (opening) await opening;
    if (!listening) return;
    await bridge.audioControl(false).catch(() => undefined);
    listening = false;
    smoothedDbfs = null;
    lastBlockAt = null;
    await draw();
  };

  /** Measuring was on when the exit dialog opened; cancelling turns it back on. */
  let resumeListening = false;

  const requestExit = createExitRequest(bridge, {
    onConfirmed: () => {
      closed = true;
      resumeListening = false;
      clearInterval(tick);
      lane.close();
    },
    onStayed: async () => {
      if (!resumeListening) return;
      resumeListening = false;
      await startListening();
    },
  }, "decibelguard");

  /**
   * Double tap asks the system exit dialog. The microphone closes before it
   * appears, so nothing is measured while the user decides; the dose so far is
   * kept, and cancelling reopens the microphone.
   */
  const exitWithDialog = async (): Promise<void> => {
    if (listening || opening) {
      resumeListening = true;
      await stopListening().catch((error: unknown) => { console.warn("[decibelguard] stop failed:", error); });
    }
    await requestExit();
  };

  await draw();

  bridge.onEvenHubEvent((event) => {
    if (closed) return;
    const audio = (event as { audioEvent?: { audioPcm?: unknown } }).audioEvent;
    const pcm = audio?.audioPcm;

    if (listening && pcm instanceof Uint8Array && pcm.length > 0) {
      const reading = levelFromPcm(pcm);
      smoothedDbfs = smoothDb(smoothedDbfs, reading.dbfs, data.smoothing);

      const now = Date.now();
      // Dose is accumulated over the wall-clock gap between blocks rather than
      // over the block's own sample count, so a dropped block does not silently
      // shorten the measured exposure.
      if (lastBlockAt !== null) {
        const seconds = Math.min(5, Math.max(0, (now - lastBlockAt) / 1000));
        const level = toApproxSpl(smoothedDbfs, effectiveOffset(data));
        dose = accumulate(dose, level, seconds, data.dose, now);
      }
      lastBlockAt = now;
      void draw();
      return;
    }

    const gesture = gestureFromEvent(event, { invertScroll: data.invertScroll });
    if (!gesture) return;

    switch (gesture.gesture) {
      case "click":
        void (listening ? stopListening() : startListening());
        return;
      case "longPress":
        dose = resetDose();
        break;
      case "doubleClick":
        void exitWithDialog();
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

  tick = setInterval(() => { void draw(); }, 1000);

  mountPhoneUi({
    getData: () => data,
    setData: async (next) => {
      data = next;
      await save(bridge, next).catch((error: unknown) => {
        console.warn("[decibelguard] save failed:", error);
      });
      await draw();
    },
    getLevel: () => ({ dbfs: smoothedDbfs, listening, micError }),
    getLocale: () => locale,
    setLocale: (next) => {
      locale = next;
      setLocale(next);
      void draw();
    },
  });
}

void boot().catch((error: unknown) => {
  console.error("[decibelguard] failed to start:", error);
});
