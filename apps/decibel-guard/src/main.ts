import {
  AudioInputSource, waitForEvenAppBridge, type EvenAppBridge,
} from "@evenrealities/even_hub_sdk";
import { levelFromPcm, smoothDb, toApproxSpl } from "./audio/level";
import { accumulate, createDose, resetDose, type DoseState } from "./noise/dose";
import { gestureFromEvent, menuItemIdFromEvent } from "./input/gestures";
import { buildView, HELP_PAGES, type NoiseView } from "./glasses/view";
import { sameView } from "./glasses/diff";
import { createPage, sendImage, updatePage, type MenuSpec } from "./glasses/render";
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
import { t } from "./messages";

/** A hold arms "clear today's dose" and a tap arms "stop measuring"; a single tap within this window confirms (QIS v1, section 2). */
const ARM_MS = 4000;
/**
 * The glasses' side menu is off: on the real glasses its clicks never arrive (`menuItemClickEvent`) and a
 * hold opens the menu instead of reaching the app (step log 15.10.2026). The menu code stays for later.
 */
const SIDE_MENU = false;
/** Side-menu item ids (QIS v1.2: the help lives in the glasses' side menu). */
const MENU_HELP = 1;
/** Taps right after the arming are ignored, so the release of the hold cannot confirm by accident. */
const RESET_SETTLE_MS = 400;
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
  /** Which risky action waits for its confirming tap, until when, and since when. */
  let armedKind: "reset" | "stop" | null = null;
  let armedUntil = 0;
  let armedAt = 0;
  /** Key of the side menu the page on the glasses carries; a different one needs a rebuild. */
  let pageMenuKey = "";
  /** Zero-based page of the help, null while it is closed. */
  let helpPage: number | null = null;
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

  const isArmed = (): boolean => armedKind !== null && armedUntil > Date.now();

  /** QIS v1.2: the side menu holds the help (and nothing the wearer could trigger by accident). */
  const menuSpec = (): MenuSpec => ({
    key: SIDE_MENU ? `help:${locale}` : "none",
    items: SIDE_MENU ? [{ id: MENU_HELP, label: t(locale, "g.menu.help") }] : [],
  });

  const currentView = (): NoiseView =>
    buildView(dose, data.dose, {
      listening,
      level: displayLevel(),
      calibrated: isCalibrated(data),
      locale,
      micError,
      armed: isArmed() ? armedKind : null,
      helpPage,
    });

  const persistDose = (): void => {
    lastDoseSave = Date.now();
    void saveDose(bridge, dose).catch((error: unknown) => { console.warn("[decibelguard] saving the dose failed:", error); });
  };

  const disarmReset = (): void => {
    armedKind = null;
    armedUntil = 0;
    clearTimeout(resetTimer);
    resetTimer = undefined;
  };

  const arm = (kind: "reset" | "stop"): void => {
    armedKind = kind;
    armedAt = Date.now();
    armedUntil = armedAt + ARM_MS;
    clearTimeout(resetTimer);
    resetTimer = setTimeout(() => { disarmReset(); void draw(); }, ARM_MS + 20);
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
    const menu = menuSpec();
    // The side menu travels with the page: a different one (language) means one rebuild.
    if (pageReady && menu.key !== pageMenuKey) pageReady = false;
    if (!pageReady || !sameView(lastView, view)) {
      const created = !pageReady;
      const result = pageReady ? await updatePage(bridge, view) : await createPage(bridge, view, menu);
      if (!result.ok) {
        pageReady = false;
        console.warn("[decibelguard] draw failed:", result.reason);
        return;
      }
      pageReady = true;
      if (created) pageMenuKey = menu.key;
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

  /**
   * The exit is confirmed: only now measuring ends (QIS v1.2 ruling 2). `closed` goes first, so a
   * microphone that is still opening closes itself again.
   */
  const requestExit = createExitRequest(bridge, {
    onConfirmed: async () => {
      persistDose();
      closed = true;
      clearInterval(tick);
      clearInterval(demoTimer);
      disarmReset();
      lane.close();
      if (opening) await opening.catch(() => undefined);
      if (listening) {
        listening = false;
        await bridge.audioControl(false).catch(() => undefined);
      }
    },
  }, "decibelguard");

  /**
   * Double tap asks the system exit dialog. Measuring goes on while the user decides, so cancelling
   * changes nothing; the microphone closes only if the exit is confirmed (the indicator stays on
   * the screen the whole time).
   */
  const exitWithDialog = async (): Promise<void> => {
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
    const menuId = menuItemIdFromEvent(event);
    if (menuId !== null) {
      if (backgrounded) { void comeBack(); return; }
      if (menuId === MENU_HELP) {
        disarmReset();
        helpPage = 0;
        void draw();
      }
      return;
    }
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

    // Risky actions take two steps (QIS v1 section 2): a hold asks to clear today's dose, a tap asks to
    // stop measuring; ONE single tap within 4 s confirms. Anything else (a second hold, a swipe, 2×) or
    // the timeout cancels, and a plain tap never clears.
    if (isArmed()) {
      if (gesture.gesture === "longPressRelease") return;
      if (gesture.gesture === "click") {
        // The tail of the hold itself is not a confirmation.
        if (armedKind === "reset" && Date.now() - armedAt < RESET_SETTLE_MS) return;
        const kind = armedKind;
        disarmReset();
        if (kind === "reset") {
          dose = resetDose();
          persistDose();
          void draw();
        } else {
          void stopListening();
        }
        return;
      }
      disarmReset();
      void draw();
      return;
    }

    // The help page: swipes turn its pages, the double tap goes back; nothing else does anything.
    if (helpPage !== null) {
      if (gesture.gesture === "doubleClick") helpPage = null;
      else if (gesture.gesture === "scrollDown") helpPage = Math.min(HELP_PAGES - 1, helpPage + 1);
      else if (gesture.gesture === "scrollUp") helpPage = Math.max(0, helpPage - 1);
      else return;
      void draw();
      return;
    }

    switch (gesture.gesture) {
      case "click":
        // Stopping is armed first (QIS v1.2): one tap asks, a second one within 4 s stops.
        if (listening) arm("stop");
        else { void startListening(); return; }
        break;
      case "longPress":
        arm("reset");
        break;
      case "scrollUp":
      case "scrollDown":
        // Without the side menu a swipe on the main screen opens the help again.
        if (SIDE_MENU) return;
        helpPage = 0;
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
