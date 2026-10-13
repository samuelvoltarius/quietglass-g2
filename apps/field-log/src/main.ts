import {
  AudioInputSource, waitForEvenAppBridge, type EvenAppBridge,
} from "@evenrealities/even_hub_sdk";
import {
  MAX_DICTATION_BYTES, MAX_DICTATION_MS, MIN_DICTATION_BYTES, mockTranscript, pcmBytes, transcribe, type SttStatus,
} from "./stt/provider";
import { buildWav } from "./audio/wav";
import { addEntry, attachToLatest, startInspection, type Inspection, type Severity } from "./log/entries";
import { gestureFromEvent } from "./input/gestures";
import { buildView, type FieldNotice, type LogView, type Phase } from "./glasses/view";
import { sameView } from "./glasses/diff";
import { createPage, updatePage } from "./glasses/render";
import {
  activeInspection, hasSpeechServer, load, nextInspectionId, save, speechServer, upsertInspection, usesMockStt,
  type FieldLogData,
} from "./storage/persist";
import { mountPhoneUi } from "./ui/phone";
import { createExitRequest } from "./exit";
import { resolveLocale, rememberLocale, setLocale, type Locale } from "./i18n";
import { autoTitle, quickNotes, t } from "./messages";
import { isFinalExit, lifecycleFromEvent } from "./lifecycle";
import { activeConfirm, CONFIRM_WINDOW_MS, confirmStep, type PendingConfirm } from "./input/confirm";

const SEVERITIES: readonly Severity[] = ["note", "minor", "major"];
const DEMO = new URLSearchParams(location.search).get("demo") === "1";
/** A native microphone call that does not answer must not hold anything up. */
const MIC_TIMEOUT_MS = 5_000;

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<{ value: T; timedOut: boolean }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ value: fallback, timedOut: true }), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve({ value, timedOut: false }); },
      () => { clearTimeout(timer); resolve({ value: fallback, timedOut: false }); },
    );
  });
}

async function boot(): Promise<void> {
  const bridge: EvenAppBridge = await waitForEvenAppBridge();
  const MIC_DRAIN_MS = 150;

  let data: FieldLogData = await load(bridge);
  if (DEMO) {
    const now = Date.now(); let sample: Inspection = { ...startInspection("demo", "Hotel inspection", now - 1_380_000), section: "Room 204" };
    sample = addEntry(sample, "Window seal is damaged", "major", now - 480_000); sample = addEntry(sample, "Lamp flickers above desk", "minor", now - 180_000); sample = addEntry(sample, "Smoke detector tested", "note", now - 30_000);
    data = { ...data, inspections: [sample], activeId: sample.id };
  }
  let locale: Locale = await resolveLocale(bridge);
  setLocale(locale);
  let phase: Phase = "idle";
  /** Highlighted quick note; the row after the last note is "Cancel". */
  let pickIndex = 0;
  let pending: string | null = null;
  let status: SttStatus = "idle";
  let notice: FieldNotice | null = null;
  let lastView: LogView | null = null;
  let pageReady = false;
  /** Set by a reconnect or a return to the foreground: the next draw rebuilds the page. */
  let rebuildWanted = false;
  /** In the background: no microphone, no drawing. */
  let paused = false;
  /** Set once the user confirms the exit dialog; nothing may be drawn on a closed page. */
  let closed = false;
  /** True while the microphone is being opened. */
  let starting = false;
  let drawing: Promise<void> | null = null;
  let redrawQueued = false;
  /** The dictation being recorded: raw PCM blocks, collected on the phone. */
  let chunks: Uint8Array[] = [];
  let recordedBytes = 0;
  let recordTimer: ReturnType<typeof setTimeout> | undefined;
  /** Bumped per dictation: an answer for an abandoned one is dropped. */
  let dictation = 0;
  let mockCount = 0;
  /** A swipe in review that would discard the text waits here for its second swipe. */
  let pendingDiscard: PendingConfirm<"discard"> | null = null;
  let confirmTimer: ReturnType<typeof setTimeout> | undefined;

  const inspection = (): Inspection | null => activeInspection(data);
  /**
   * Dictation needs a speech server (the phone setting or the private build's
   * default). Without one, a tap offers quick notes instead — the app is fully
   * usable with no server at all. `?demo=1` dictates labelled mock text.
   */
  const voice = (): boolean => hasSpeechServer(data) || DEMO;
  const notes = (): string[] => quickNotes(locale, data.quickNotes);

  const currentView = (): LogView =>
    buildView(inspection(), {
      phase,
      severity: data.severity,
      pending,
      status,
      mock: usesMockStt(data),
      locale,
      voice: voice(),
      quickNotes: notes(),
      pickIndex,
      notice,
      confirmDiscard: activeConfirm(pendingDiscard, Date.now()) !== null,
    });

  /** Set once the phone page is mounted; redraws it after a change made on the glasses. */
  let refreshPhone: () => void = () => undefined;

  const drawOnce = async (): Promise<void> => {
    if (paused) return;
    // A page lost with the link (or in the background) is rebuilt even when
    // nothing changed; read here, so a draw already running cannot undo it.
    if (rebuildWanted) { rebuildWanted = false; pageReady = false; lastView = null; }
    const view = currentView();
    if (pageReady && sameView(lastView, view)) return;

    const result = pageReady ? await updatePage(bridge, view) : await createPage(bridge, view);
    if (result.ok) { pageReady = true; lastView = view; return; }
    pageReady = false;
    lastView = null;
    console.warn("[fieldlog] draw failed:", result.reason);
  };

  /**
   * One draw at a time. The clock, gestures, the speech status and the phone
   * all request redraws; interleaving them would race two page creations or
   * let an older view land after a newer one. Requests made meanwhile
   * collapse into one redraw.
   */
  const draw = (): Promise<void> => {
    if (closed) return Promise.resolve();
    if (drawing) { redrawQueued = true; return drawing; }
    drawing = (async () => {
      try {
        do {
          redrawQueued = false;
          await drawOnce();
        } while (redrawQueued && !closed);
      } finally {
        drawing = null;
      }
    })();
    return drawing;
  };

  /** Logs a failed background task instead of leaving an unhandled rejection. */
  const background = (task: Promise<unknown>, what: string): void => {
    task.catch((error: unknown) => { console.warn("[fieldlog] " + what + " failed:", error); });
  };

  const persist = async (next: Inspection): Promise<void> => {
    data = upsertInspection(data, next);
    refreshPhone();
    await save(bridge, data);
  };

  /** A tap with no inspection open starts one, named after the date and time. */
  const startNew = async (): Promise<void> => {
    const id = nextInspectionId(data);
    const now = Date.now();
    data = { ...upsertInspection(data, startInspection(id, autoTitle(locale, now), now)), activeId: id };
    refreshPhone();
    await draw();
    await save(bridge, data);
  };

  /** Files the highlighted quick note, or leaves the list on "Cancel". */
  const pickNote = async (): Promise<void> => {
    const current = inspection();
    const note = notes()[pickIndex];
    phase = "idle";
    pickIndex = 0;
    if (current && note) await persist(addEntry(current, note, data.severity, Date.now()));
    await draw();
  };

  // Let in-flight PCM blocks land before closing the capture (drain rule).
  const micOff = async (): Promise<void> => {
    await bridge.audioControl(false).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, MIC_DRAIN_MS));
  };

  /** Drops the recording without sending it anywhere. */
  const abandonRecording = (): void => {
    clearTimeout(recordTimer);
    dictation += 1;
    chunks = [];
    recordedBytes = 0;
  };

  const startMic = async (): Promise<void> => {
    const current = inspection();
    // `starting` keeps a second tap during a slow open from opening a second
    // microphone session.
    if (!current || phase !== "idle" || starting || closed || paused) return;
    starting = true;
    notice = null;
    status = "idle";
    try {
      const { value: ok, timedOut } = await withTimeout(bridge.audioControl(true, AudioInputSource.Glasses), MIC_TIMEOUT_MS, false);
      if (timedOut) {
        // A late "yes" must not leave the microphone on.
        void bridge.audioControl(false).catch(() => undefined);
      }
      if (closed || paused) {
        if (ok) await micOff();
        return;
      }
      if (!ok) {
        // Said on the glasses: a refused microphone used to look like an ignored tap.
        console.warn("[fieldlog] microphone was refused");
        notice = "micDenied";
        return;
      }
      abandonRecording();
      phase = "recording";
      const mine = dictation;
      recordTimer = setTimeout(() => {
        if (phase === "recording" && dictation === mine) background(endRecording(), "stopping the microphone");
      }, MAX_DICTATION_MS);
    } finally {
      starting = false;
      await draw();
    }
  };

  /**
   * Stop tapped (or the time limit reached): the microphone goes off, the
   * recording goes as one WAV to the Whisper server, and the text comes back
   * for review — an inspection report is a document someone acts on.
   */
  const endRecording = async (): Promise<void> => {
    if (phase !== "recording") return;
    clearTimeout(recordTimer);
    phase = "transcribing";
    status = "connecting";
    const mine = dictation;
    void draw();
    await micOff();
    const recorded = chunks;
    const bytes = recordedBytes;
    chunks = [];
    recordedBytes = 0;

    let text = "";
    if (DEMO && usesMockStt(data)) {
      text = mockTranscript(mockCount++);
    } else if (bytes >= MIN_DICTATION_BYTES) {
      try {
        text = await transcribe(buildWav(recorded), speechServer(data), {
          language: data.language,
          ...(data.sttToken ? { token: data.sttToken } : {}),
        });
      } catch (error) {
        if (dictation !== mine || closed) return;
        console.warn("[fieldlog] speech server unavailable:", error);
        status = "error";
        phase = "idle";
        await draw();
        return;
      }
    }
    if (dictation !== mine || closed || phase !== "transcribing") return;
    status = "idle";
    if (!text) {
      notice = "heardNothing";
      phase = "idle";
    } else {
      pending = text;
      phase = "review";
    }
    await draw();
  };

  const keepPending = async (): Promise<void> => {
    const current = inspection();
    if (!current || pending === null) return;
    pendingDiscard = null;
    await persist(addEntry(current, pending, data.severity, Date.now()));
    pending = null;
    phase = "idle";
    await draw();
  };

  /**
   * Photos come from the phone camera, which the SDK exposes as a
   * user-initiated picker. The glasses have no camera.
   */
  const attachPhoto = async (): Promise<void> => {
    if (!inspection()) return;
    const asset = await bridge.captureImageFromCamera().catch(() => null);
    // Read again: an entry may have been filed while the camera was open.
    let current = inspection();
    if (!current) return;
    if (!asset?.base64) {
      // Cancelled or refused: said on the glasses instead of nothing at all.
      notice = "noPhoto";
      await draw();
      return;
    }
    notice = null;

    // With nothing to attach it to, the photo becomes an entry of its own.
    if (current.entries.length === 0) current = addEntry(current, t(locale, "photoOnly"), data.severity, Date.now());
    const dataUri = "data:" + (asset.mimeType || "image/jpeg") + ";base64," + asset.base64;
    await persist(attachToLatest(current, {
      dataUri,
      mimeType: asset.mimeType || "image/jpeg",
      size: asset.size || Math.round(asset.base64.length * 0.75),
    }));
    await draw();
  };

  let clock: ReturnType<typeof setInterval> | undefined;

  /** The microphone was paused for the exit dialog and comes back if the user stays. */
  let micPausedForExit = false;

  /** Everything off for good: after the exit dialog, a system exit or a crash. */
  const shutDown = (micMayBeOn = true): void => {
    closed = true;
    micPausedForExit = false;
    clearInterval(clock);
    clearTimeout(confirmTimer);
    const wasRecording = phase === "recording" || starting;
    abandonRecording();
    if (wasRecording && micMayBeOn) void bridge.audioControl(false).catch(() => undefined);
  };

  const requestExit = createExitRequest(bridge, {
    onConfirmed: () => {
      // A recording was already paused (microphone off) before the dialog opened.
      shutDown(false);
    },
    onStayed: async () => {
      if (!micPausedForExit) return;
      micPausedForExit = false;
      if (phase !== "recording") return;
      // The recording so far is kept, so the dictation simply continues.
      const ok = await bridge.audioControl(true, AudioInputSource.Glasses).catch(() => false);
      if (!ok) {
        console.warn("[fieldlog] microphone was refused");
        await endRecording();
      }
    },
  }, "fieldlog");

  /**
   * Double tap asks the system exit dialog. The microphone goes off before
   * the dialog appears, so nothing is heard while the user decides; cancelling
   * turns it back on and the dictation carries on.
   */
  const close = async (): Promise<void> => {
    if (closed) return;
    if (phase === "recording" && !micPausedForExit) {
      micPausedForExit = true;
      await micOff();
    }
    await requestExit();
  };

  // Gestures first: the first page and everything native come after this.
  bridge.onEvenHubEvent((event) => {
    if (closed) return;
    const step = lifecycleFromEvent(event);
    if (step === "foregroundExit") {
      // Out of sight: a dictation in progress is dropped and the microphone
      // closes; a text under review stays for when the user comes back.
      paused = true;
      if (phase === "recording" || phase === "transcribing") {
        const wasRecording = phase === "recording";
        abandonRecording();
        phase = "idle";
        status = "idle";
        if (wasRecording) void bridge.audioControl(false).catch(() => undefined);
      }
      return;
    }
    if (step === "foregroundEnter") {
      paused = false;
      rebuildWanted = true;
      void draw();
      return;
    }
    if (isFinalExit(step)) { shutDown(); return; }

    const audio = (event as { audioEvent?: { audioPcm?: unknown } }).audioEvent;
    if (audio !== undefined) {
      if (phase !== "recording" || micPausedForExit) return;
      const bytes = pcmBytes(audio.audioPcm);
      if (!bytes || bytes.length === 0) return;
      // Over the cap: stop and send what there is, never buffer more.
      if (recordedBytes + bytes.length > MAX_DICTATION_BYTES) { background(endRecording(), "stopping the microphone"); return; }
      chunks.push(bytes);
      recordedBytes += bytes.length;
      return;
    }

    const gesture = gestureFromEvent(event, { invertScroll: data.invertScroll });
    if (!gesture) return;
    if (gesture.gesture !== "scrollUp" && gesture.gesture !== "scrollDown") pendingDiscard = null;

    switch (gesture.gesture) {
      case "click":
        notice = null;
        if (!inspection()) { background(startNew(), "starting an inspection"); return; }
        if (phase === "pick") { background(pickNote(), "saving the note"); return; }
        if (phase === "idle" && !voice()) { phase = "pick"; pickIndex = 0; break; }
        if (phase === "idle") { background(startMic(), "starting dictation"); return; }
        if (phase === "recording") { background(endRecording(), "stopping the microphone"); return; }
        if (phase === "review") { background(keepPending(), "saving the entry"); return; }
        break;

      case "scrollUp":
      case "scrollDown":
        if (phase === "pick") {
          const count = notes().length + 1;
          pickIndex = (pickIndex + (gesture.gesture === "scrollDown" ? 1 : -1) + count) % count;
          break;
        }
        if (phase === "review") {
          // Discarding a transcript takes a second swipe within a few seconds:
          // one stray swipe used to throw the text away for good.
          const step = confirmStep(pendingDiscard, "discard", Date.now());
          pendingDiscard = step.pending;
          clearTimeout(confirmTimer);
          if (step.confirmed) {
            pending = null;
            phase = "idle";
          } else {
            confirmTimer = setTimeout(() => { pendingDiscard = null; void draw(); }, CONFIRM_WINDOW_MS + 50);
          }
          break;
        }
        if (phase !== "idle") break;
        // Otherwise cycle the severity applied to the next entry (shown on screen).
        {
          const index = SEVERITIES.indexOf(data.severity);
          const delta = gesture.gesture === "scrollDown" ? 1 : -1;
          const next = SEVERITIES[(index + delta + SEVERITIES.length) % SEVERITIES.length];
          if (next) {
            data = { ...data, severity: next };
            background(save(bridge, data), "saving the severity");
          }
        }
        break;

      case "longPress":
        if (phase === "idle") { background(attachPhoto(), "attaching a photo"); return; }
        // Under review the photo belongs to the text on screen: keep it first.
        if (phase === "review") {
          background(keepPending().then(attachPhoto), "attaching a photo");
          return;
        }
        break;

      case "doubleClick":
        void close();
        return;

      default:
        return;
    }
    void draw();
  });

  // The page does not survive a disconnect. The last view is forgotten too,
  // or an unchanged view would skip the rebuild and leave the display blank.
  bridge.onDeviceStatusChanged((deviceStatus) => {
    if (deviceStatus?.connectType === "connected" && !closed) {
      rebuildWanted = true;
      void draw();
    }
  });

  clock = setInterval(() => { void draw(); }, 10_000);
  void draw();

  const phone = mountPhoneUi({
    getData: () => data,
    setData: async (next) => {
      data = next;
      // Quick notes or the server may have changed under an open list.
      if (phase === "pick" && voice()) phase = "idle";
      pickIndex = Math.min(pickIndex, notes().length);
      status = "idle";
      await save(bridge, next);
      await draw();
    },
    locale: () => locale,
    onLocaleChange: (next) => {
      locale = next;
      rememberLocale(bridge, next);
      void draw();
    },
    takePhoto: () => attachPhoto(),
  });
  refreshPhone = phone.refresh;
}

void boot().catch((error: unknown) => {
  console.error("[fieldlog] failed to start:", error);
});
