import {
  AudioInputSource, waitForEvenAppBridge, type EvenAppBridge,
} from "@evenrealities/even_hub_sdk";
import { levelFromPcm, smoothDb, toApproxSpl } from "./audio/level";
import { accumulate, createDose, resetDose, type DoseState } from "./noise/dose";
import { gestureFromEvent } from "./input/gestures";
import { buildView, type NoiseView } from "./glasses/view";
import { sameView } from "./glasses/diff";
import { createPage, sendImage, updatePage } from "./glasses/render";
import { quantize } from "./glasses/bitmap";
import { DOSE_BAR, METER, doseKey, dosePercent, drawDoseBar, drawMeter, meterKey, meterLevel, type MeterState } from "./glasses/gauge";
import { createImageLane } from "./glasses/lane";
import { LEVEL_IMAGE, drawLevel, levelKey, type LevelState } from "./glasses/digits";
import { updatePeak, type Peak } from "./glasses/peak";
import { encodePng } from "./glasses/pixel";
import { effectiveOffset, isCalibrated, load, loadDoseRaw, parseDose, save, saveDose, type NoiseData } from "./storage/persist";
import { lifecycleFromEvent } from "./lifecycle";
import { mountPhoneUi } from "./ui/phone";
import { createExitRequest } from "./exit";
import { rememberLocale, resolveLocale, type Locale } from "./i18n";

/** A hold arms "clear today's dose"; a second hold or a tap within this window confirms. */
const RESET_CONFIRM_MS = 4000;
/** While measuring, today's dose is written this often (one number, see persist.ts). */
const DOSE_SAVE_MS = 30_000;

async function boot(): Promise<void> {
  const bridge: EvenAppBridge = await waitForEvenAppBridge();
  /** audioPcm arrives as Uint8Array, number[] or base64 depending on the host
   * bridge; normalize it or every chunk is silently dropped (empty recording). */
  const toBytes = (pcm: unknown): Uint8Array | null => {
    if (pcm instanceof Uint8Array) return pcm;
    if (Array.isArray(pcm)) return Uint8Array.from(pcm.filter((n): n is number => typeof n === "number"));
    if (typeof pcm === "string") {
      try {
        const bin = atob(pcm);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
        return out;
      } catch { return null; }
    }
    return null;
  };


  let data: NoiseData = await load(bridge);
  // Today's dose survives a restart (the phone was locked and the Even app unloaded us).
  let dose: DoseState = parseDose(await loadDoseRaw(bridge)) ?? createDose();
  let lastDoseSave = Date.now();
  /** Until when a second hold (or a tap) clears today's dose; 0 = not asked. */
  let resetArmedUntil = 0;
  let resetTimer: ReturnType<typeof setTimeout> | undefined;
  /** Left through the system while measuring: the microphone reopens when the app comes back. */
  let resumeAfterBackground = false;
  let backgrounded = false;
  let demoTimer: ReturnType<typeof setInterval> | undefined;
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
  let locale: Locale = await resolveLocale(bridge);
  /** The last attempt to open the microphone failed; the glasses say what to do. */
  let micError = false;
  /** Level as last drawn on the meter, in 3 dB steps; the hysteresis works against it. */
  let meterDb: number | null = null;
  /** Level as last drawn in the big digits, in whole dB; the hysteresis works against it. */
  let digitsDb: number | null = null;
  let peak: Peak | null = null;
  /** Images are written at most every 700 ms and only when their picture changes. */
  const lane = createImageLane((target, imageData) => sendImage(bridge, target, imageData), 700);

  const displayLevel = (): number | null =>
    smoothedDbfs === null ? null : toApproxSpl(smoothedDbfs, effectiveOffset(data));

  const currentView = (): NoiseView =>
    buildView(dose, data.dose, {
      listening,
      level: displayLevel(),
      calibrated: isCalibrated(data),
      locale,
      micError,
      confirmReset: resetArmedUntil > Date.now(),
    });

  const persistDose = (): void => {
    lastDoseSave = Date.now();
    void saveDose(bridge, dose).catch((error: unknown) => { console.warn("[decibelguard] saving the dose failed:", error); });
  };

  const disarmReset = (): void => {
    resetArmedUntil = 0;
    clearTimeout(resetTimer);
    resetTimer = undefined;
  };

  /**
   * Asks the lane for the meter and the dose bar. Both keys are quantised, so
   * most calls change nothing and send nothing; the lane is never awaited.
   */
  const requestImages = (): void => {
    if (!pageReady || closed) return;
    const shown = displayLevel();
    meterDb = listening ? meterLevel(meterDb, shown) : null;
    digitsDb = listening ? quantize(digitsDb, shown, 1) : null;
    peak = listening ? updatePeak(peak, shown, Date.now()) : null;
    const meter: MeterState = { listening, level: meterDb, criterionDb: data.dose.criterionDb, peak: peak ? meterLevel(null, peak.db) : null };
    lane.request(METER, meterKey(meter), () => encodePng(drawMeter(meter)));
    const digits: LevelState = { listening, db: digitsDb, calibrated: isCalibrated(data) };
    lane.request(LEVEL_IMAGE, levelKey(digits), () => encodePng(drawLevel(digits)));
    const percent = dosePercent(dose.fraction);
    lane.request(DOSE_BAR, doseKey(percent), () => encodePng(drawDoseBar(percent)));
  };

  const drawOnce = async (): Promise<void> => {
    if (closed || backgrounded) return;
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
      persistDose();
      closed = true;
      resumeListening = false;
      clearInterval(tick);
      clearInterval(demoTimer);
      disarmReset();
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

  /** Left through the system: microphone off, dose saved, nothing drawn until the app is back. */
  const goBackground = async (): Promise<void> => {
    if (backgrounded) return;
    backgrounded = true;
    disarmReset();
    clearInterval(tick);
    tick = undefined;
    if (listening || opening) {
      resumeAfterBackground = true;
      await stopListening().catch((error: unknown) => { console.warn("[decibelguard] stop failed:", error); });
    }
    persistDose();
  };

  const comeBack = async (): Promise<void> => {
    backgrounded = false;
    pageReady = false;
    lastView = null;
    if (tick === undefined) tick = setInterval(onTick, 1000);
    await draw();
    if (resumeAfterBackground) {
      resumeAfterBackground = false;
      await startListening();
    }
  };

  const shutDown = async (): Promise<void> => {
    disarmReset();
    clearInterval(tick);
    clearInterval(demoTimer);
    resumeAfterBackground = false;
    if (opening) await opening.catch(() => undefined);
    // closed first: a microphone that is still opening closes itself again.
    closed = true;
    if (listening) await bridge.audioControl(false).catch(() => undefined);
    listening = false;
    lane.close();
    persistDose();
  };

  bridge.onEvenHubEvent((event) => {
    if (closed) return;
    const lifecycle = lifecycleFromEvent(event);
    if (lifecycle === "foreground") { void comeBack(); return; }
    if (lifecycle === "background") { void goBackground(); return; }
    if (lifecycle === "exit") { void shutDown(); return; }
    const audio = (event as { audioEvent?: { audioPcm?: unknown } }).audioEvent;
    const pcm = audio?.audioPcm;

    const bytes = listening && !backgrounded ? toBytes(pcm) : null;
    if (bytes && bytes.length > 0) {
      const reading = levelFromPcm(bytes);
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
    // A gesture means the app is visible again, even if no "foreground" came first.
    if (backgrounded) { void comeBack(); return; }

    // Clearing today's dose takes two steps: hold asks, a second hold or a tap within 4 s confirms.
    const armed = resetArmedUntil > Date.now();
    if (armed && (gesture.gesture === "longPress" || gesture.gesture === "click")) {
      disarmReset();
      dose = resetDose();
      persistDose();
      void draw();
      return;
    }
    if (armed && gesture.gesture !== "longPressRelease") disarmReset();

    switch (gesture.gesture) {
      case "click":
        void (listening ? stopListening() : startListening());
        return;
      case "longPress":
        resetArmedUntil = Date.now() + RESET_CONFIRM_MS;
        clearTimeout(resetTimer);
        resetTimer = setTimeout(() => { disarmReset(); void draw(); }, RESET_CONFIRM_MS + 20);
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

  function onTick(): void {
    if (listening && Date.now() - lastDoseSave >= DOSE_SAVE_MS) persistDose();
    void draw();
  }
  tick = setInterval(onTick, 1000);

  // ?demo=1 (simulator, screenshots): a made-up level that swells and fades, no microphone.
  if (typeof location !== "undefined" && new URLSearchParams(location.search).get("demo") === "1") {
    listening = true;
    const started = Date.now();
    demoTimer = setInterval(() => {
      if (closed) return;
      const seconds = (Date.now() - started) / 1000;
      smoothedDbfs = -60 + 14 * Math.sin(seconds / 4) + 4 * Math.sin(seconds * 1.7);
      void draw();
    }, 500);
  }

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
      rememberLocale(bridge, next);
      void draw();
    },
  });
}

void boot().catch((error: unknown) => {
  console.error("[decibelguard] failed to start:", error);
});
