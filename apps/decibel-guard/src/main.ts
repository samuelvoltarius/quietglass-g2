import {
  AudioInputSource, waitForEvenAppBridge, type EvenAppBridge,
} from "@evenrealities/even_hub_sdk";
import { levelFromPcm, smoothDb, toApproxSpl } from "./audio/level";
import { accumulate, createDose, resetDose, type DoseState } from "./noise/dose";
import { gestureFromEvent, menuItemIdFromEvent } from "./input/gestures";
import { cockpitModel, type CockpitModel } from "./cockpit/model";
import { composeCockpit } from "./cockpit/compose";
import { COCKPIT_TILES, createCockpitPage, forgetPage, guardedTileSend } from "./glasses/page";
import { meterLevel, quantize } from "./glasses/quant";
import { updatePeak, type Peak } from "./glasses/peak";
import { createTileSender } from "./screen/sender";
import { autoBackend, type TextBackend } from "./screen/text";
import { effectiveOffset, isCalibrated, load, loadDoseRaw, parseDose, save, saveDose, type NoiseData } from "./storage/persist";
import { lifecycleFromEvent } from "./lifecycle";
import { mountPhoneUi, type PhoneLive, type PhoneUi } from "./ui/phone";
import { createExitRequest, settleRestore } from "./exit";
import { rememberLocale, resolveLocale, type Locale } from "./i18n";

/** A hold arms "clear today's dose" and a tap arms "stop measuring"; a single tap within this window confirms (QIS v1, section 2). */
const ARM_MS = 4000;
/**
 * The glasses' side menu is off: on the real glasses its clicks never arrive (`menuItemClickEvent`) and a
 * hold opens the menu instead of reaching the app (step log 15.10.2026). The menu code stays for later.
 */
export const SIDE_MENU = false;
/** The level pictures are renewed at most this often while the level moves (audio blocks arrive many times a second). */
const COCKPIT_MIN_MS = 700;
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
  let resetTimer: ReturnType<typeof setTimeout> | undefined;
  /** Left through the system while measuring: the microphone reopens when the app comes back. */
  let resumeAfterBackground = false;
  let backgrounded = false;
  let demoTimer: ReturnType<typeof setInterval> | undefined;
  let listening = false;
  let smoothedDbfs: number | null = null;
  let lastBlockAt: number | null = null;
  let pageReady = false;
  let phone: PhoneUi | null = null;
  let textBackend: TextBackend | null = null;
  /** When the cockpit was last pushed; audio-driven draws wait COCKPIT_MIN_MS, the 1 s tick catches up. */
  let lastPushAt = 0;
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
  const displayLevel = (): number | null =>
    smoothedDbfs === null ? null : toApproxSpl(smoothedDbfs, effectiveOffset(data));

  const isArmed = (): boolean => armedKind !== null && armedUntil > Date.now();

  const currentModel = (): CockpitModel => {
    const shown = displayLevel();
    meterDb = listening ? meterLevel(meterDb, shown) : null;
    digitsDb = listening ? quantize(digitsDb, shown, 1) : null;
    peak = listening ? updatePeak(peak, shown, Date.now()) : null;
    return cockpitModel({
      dose, settings: data.dose, listening, level: digitsDb, barLevel: meterDb, peak: peak ? meterLevel(null, peak.db) : null,
      calibrated: isCalibrated(data), locale, now: Date.now(), micError, armed: isArmed() ? armedKind : null,
    });
  };

  const liveInfo = (): PhoneLive => ({
    listening, micError, dbfs: smoothedDbfs, level: displayLevel(), dose,
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

  // While the exit dialog may be on screen (asked, no input since) no timer, poll or stream may draw: a page call
  // could cover it. Data keeps being collected; the back signal restores the page the way of the first one.
  let exitAsked = (): boolean => false;
  /** The cockpit is one 576 x 288 frame; only the tiles whose pixels changed cross Bluetooth. Never while the dialog may be up. */
  const tiles = createTileSender(COCKPIT_TILES, guardedTileSend(bridge, () => !exitAsked() && !closed && !backgrounded));

  const drawOnce = async (): Promise<void> => {
    if (exitAsked()) return;
    if (closed || backgrounded) return;
    if (!pageReady) {
      const result = await createCockpitPage(bridge);
      if (closed) return;
      if (!result.ok) { console.warn("[decibelguard] draw failed:", result.reason); return; }
      pageReady = true;
      // A new page starts with blank images.
      tiles.reset();
    }
    const model = currentModel();
    textBackend ??= autoBackend();
    lastPushAt = Date.now();
    // Never awaited: a slow transfer must not hold up the next draw.
    void tiles.push(composeCockpit(model, textBackend));
  };

  /**
   * One page write at a time. Audio blocks arrive many times a second, each
   * asking for a redraw; overlapping writes interleave over BLE and pile up.
   * A request during a write redraws once after it, with the newest level.
   */
  const draw = (): Promise<void> => {
    if (exitAsked()) return Promise.resolve();
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
   * Measuring ends only when the system ends the app (sysEvent 6/7 -> shutDown, QIS v1.2 ruling 2).
   * shutDownPageContainer(1) resolves when the dialog is SHOWN, not when the user answered, so its
   * result never stops anything.
   */
  const requestExit = createExitRequest(bridge, {
    onBack: () => {
      // The dialog took the page away. On the next input put it up again the way of the first one,
      // so the glasses deliver input (and the next 2×) to the app again (store review 16.10.2026).
      if (closed) return;
      pageReady = false;
      forgetPage(bridge);
      return draw();
    },
  }, "decibelguard");
  exitAsked = requestExit.asked;

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
    tiles.close();
    persistDose();
  };

  bridge.onEvenHubEvent((event) => {
    if (closed) return;
    // The 4/5 right after an exit call are the system dialog's own show/close, not the app entering/leaving.
    if (requestExit.onLifecycle(event) !== null) return;
    const lifecycle = lifecycleFromEvent(event);
    // Not the microphone stream: PCM keeps flowing while the dialog is open and says nothing about the user.
    if (lifecycle !== "background" && lifecycle !== "exit" && (event as { audioEvent?: unknown }).audioEvent === undefined) requestExit.back();
    if (lifecycle === "foreground") { void comeBack(); return; }
    if (lifecycle === "background") { void goBackground(); return; }
    if (lifecycle === "exit") { void shutDown(); return; }
    // The glasses' side menu (off while SIDE_MENU is false): a click carries no action here.
    const menuId = menuItemIdFromEvent(event);
    if (menuId !== null) {
      if (backgrounded) void comeBack();
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
      // Audio arrives many times a second: the picture follows at most every COCKPIT_MIN_MS, the tick catches up.
      if (now - lastPushAt >= COCKPIT_MIN_MS) void draw();
      return;
    }

    const gesture = gestureFromEvent(event, { invertScroll: data.invertScroll });
    if (!gesture) return;
    // A gesture means the app is visible again, even if no "foreground" came first.
    if (backgrounded) {
      const restore = comeBack();
      if (gesture.gesture !== "doubleClick") { void restore; return; }
      // A 2x on the main screen while backgrounded comes back AND asks again, after the restore draw.
      void settleRestore(restore).then(exitWithDialog);
      return;
    }

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
        // A swipe only moves; the cockpit has nothing to move (the help lives on the phone).
        return;
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
    phone?.refreshLive();
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
      phone?.refreshLive();
    }, 500);
  }

  phone = mountPhoneUi({
    getData: () => data,
    setData: async (next) => {
      data = next;
      await save(bridge, next).catch((error: unknown) => {
        console.warn("[decibelguard] save failed:", error);
      });
      await draw();
    },
    getLive: liveInfo,
    // The phone's button is as explicit as a tap on the glasses: start, or stop straight away.
    toggle: () => { if (closed) return; if (listening) void stopListening(); else void startListening(); },
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
