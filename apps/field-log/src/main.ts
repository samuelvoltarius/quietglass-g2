import {
  AudioInputSource, waitForEvenAppBridge, type EvenAppBridge,
} from "@evenrealities/even_hub_sdk";
import {
  batchRange, MAX_DICTATION_BYTES, MAX_DICTATION_MS, MIN_DICTATION_BYTES, mockTranscript, pcmBytes, sliceChunks, transcribe,
  type SttStatus,
} from "./stt/provider";
import { createLiveStt, liveSttUrl, LiveTranscript, redrawDelay, type LiveStt } from "./stt/live";
import { buildWav } from "./audio/wav";
import { addEntry, attachToLatest, startInspection, type Inspection, type Severity } from "./log/entries";
import { gestureFromEvent, menuItemIdFromEvent } from "./input/gestures";
import { buildView, type FieldNotice, type LiveView, type LogView, type Phase, type ReviewChoice } from "./glasses/view";
import { sameView } from "./glasses/diff";
import { createPage, updatePage, type MenuSpec } from "./glasses/render";
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

/**
 * The glasses' side menu (QIS v1.2). Off: its clicks never reach the app on the real glasses, and while a page
 * carries a menu the hold opens it instead of reaching the app (step log of 15.10.2026). Without it the swipe
 * picks the type of the next entry (and the Help stop), the hold takes a photo (no inspection: opens the help).
 */
const SIDE_MENU = false;
const SEVERITIES: readonly Severity[] = ["note", "minor", "major"];
/** Side menu (QIS v1.2): item ids. Hold opens the menu; a menu click is an explicit choice. */
const MENU_HELP = 1;
const MENU_NOTE = 2;
const MENU_MINOR = 3;
const MENU_MAJOR = 4;
const MENU_PHOTO = 5;
const MENU_SEVERITY: Readonly<Record<number, Severity>> = { [MENU_NOTE]: "note", [MENU_MINOR]: "minor", [MENU_MAJOR]: "major" };
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
  /** Live text of the running dictation (private builds with `VITE_LIVE_STT_URL`). */
  let live: LiveStt | null = null;
  let liveView: LiveView = "off";
  let heard = new LiveTranscript();
  /** Recorded bytes when the last non-empty final arrived: where a batch fallback picks up. */
  let lastFinalAt = 0;
  let recordStartedAt = 0;
  /** Redraws the recording screen once a second (clock) while the microphone is on. */
  let ticker: ReturnType<typeof setInterval> | undefined;
  let liveDrawTimer: ReturnType<typeof setTimeout> | undefined;
  let lastLiveDraw = 0;
  /** The text under review covers only the last part of a long recording. */
  let truncated = false;
  /** Review: 0 = keep, 1 = keep and photo, 2 = discard. A swipe only moves between them. */
  let reviewChoice: ReviewChoice = 0;
  /** The help page is open (from the glasses' side menu). */
  let helpOpen = false;
  /** Without a side menu: the type selector on the resting screen stands on its last stop, "Help". */
  let helpSelected = false;
  /** Tapping "Discard" under review waits here for its second tap (QIS v1). */
  let pendingDiscard: PendingConfirm<"discard"> | null = null;
  let confirmTimer: ReturnType<typeof setTimeout> | undefined;

  const inspection = (): Inspection | null => activeInspection(data);
  /**
   * Dictation needs a speech server (the phone setting or the private build's
   * default). Without one, a tap offers quick notes instead — the app is fully
   * usable with no server at all. `?demo=1` dictates labelled mock text.
   */
  const voice = (): boolean => hasSpeechServer(data) || liveSttUrl() !== "" || DEMO;
  const notes = (): string[] => quickNotes(locale, data.quickNotes);
  /** The side menu: help, type of the next entry, photo. Supplied again on every page (re)build. */
  const menu = (): MenuSpec => ({
    items: !SIDE_MENU ? [] : [
      { id: MENU_HELP, label: t(locale, "m.help") },
      { id: MENU_NOTE, label: t(locale, "m.note") },
      { id: MENU_MINOR, label: t(locale, "m.minor") },
      { id: MENU_MAJOR, label: t(locale, "m.major") },
      { id: MENU_PHOTO, label: t(locale, "m.photo") },
    ],
  });

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
      reviewChoice,
      confirmDiscard: activeConfirm(pendingDiscard, Date.now()) !== null,
      help: helpOpen,
      sideMenu: SIDE_MENU,
      helpSelected,
      live: liveView,
      liveText: heard.text(),
      ...(phase === "recording" ? { elapsedMs: Date.now() - recordStartedAt } : {}),
      truncated,
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

    const result = pageReady ? await updatePage(bridge, view) : await createPage(bridge, view, menu());
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

  /** Stops the per-recording timers (clock, throttled live redraw). */
  const stopRecordingTimers = (): void => {
    clearTimeout(recordTimer);
    clearInterval(ticker);
    clearTimeout(liveDrawTimer);
    liveDrawTimer = undefined;
  };

  /** Drops the recording without sending it anywhere. */
  const abandonRecording = (): void => {
    stopRecordingTimers();
    dictation += 1;
    chunks = [];
    recordedBytes = 0;
    live?.abort();
    live = null;
    liveView = "off";
    heard = new LiveTranscript();
    lastFinalAt = 0;
  };

  /** Live text redraws at most every 300 ms, and only when the text changed. */
  const scheduleLiveDraw = (): void => {
    if (liveDrawTimer !== undefined) return;
    liveDrawTimer = setTimeout(() => {
      liveDrawTimer = undefined;
      lastLiveDraw = Date.now();
      void draw();
    }, redrawDelay(lastLiveDraw, Date.now()));
  };

  /**
   * Opens the live preview for this dictation, if the build has a live server.
   * Every PCM block is kept on the phone regardless: the live text is a
   * preview, the kept audio is the fallback.
   */
  const startLive = (mine: number): void => {
    const url = liveSttUrl();
    if (!url || (DEMO && usesMockStt(data))) { liveView = "off"; return; }
    liveView = "connecting";
    live = createLiveStt({
      url,
      language: data.language && data.language !== "auto" ? data.language : locale,
      ...(data.sttToken ? { token: data.sttToken } : {}),
      onTranscript: (transcript) => {
        if (dictation !== mine) return;
        if (liveView === "connecting") liveView = "live";
        if (transcript.final && transcript.text.trim()) lastFinalAt = recordedBytes;
        if (heard.apply(transcript) && phase === "recording") scheduleLiveDraw();
      },
      onLost: () => {
        if (dictation !== mine || phase !== "recording") return;
        console.warn("[fieldlog] live speech server lost; the recording goes as a file at the end");
        liveView = "lost";
        void draw();
      },
    });
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
      truncated = false;
      recordStartedAt = Date.now();
      const mine = dictation;
      startLive(mine);
      // A safety cap against a lost stop tap, not a length limit for a note.
      recordTimer = setTimeout(() => {
        if (phase === "recording" && dictation === mine) background(endRecording(), "stopping the microphone");
      }, MAX_DICTATION_MS);
      ticker = setInterval(() => { if (phase === "recording" && dictation === mine) void draw(); }, 1_000);
    } finally {
      starting = false;
      await draw();
    }
  };

  /**
   * Stop tapped (or the safety cap reached): the microphone goes off and the
   * text comes back for review — an inspection report is a document someone
   * acts on. When the live text held to the end, it is the text. Otherwise
   * the kept audio goes as one WAV to the Whisper server: all of it, or after
   * a drop only what the live finals did not cover, and never more than the
   * upload cap (then the last part, and the review header says so).
   */
  const endRecording = async (): Promise<void> => {
    if (phase !== "recording") return;
    stopRecordingTimers();
    phase = "transcribing";
    status = "connecting";
    const mine = dictation;
    void draw();
    await micOff();
    const recorded = chunks;
    const bytes = recordedBytes;
    chunks = [];
    recordedBytes = 0;
    const session = live;
    live = null;
    const transcript = heard;
    const finalAt = lastFinalAt;
    truncated = false;

    let text = "";
    let failed = false;
    if (DEMO && usesMockStt(data)) {
      text = mockTranscript(mockCount++);
    } else {
      const complete = session ? await session.finish() : false;
      if (dictation !== mine || closed) return;
      liveView = "off";
      if (complete && transcript.text()) {
        text = transcript.text();
      } else if (bytes >= MIN_DICTATION_BYTES) {
        // Words the live server committed before it dropped are kept as they are.
        const before = session && !complete ? transcript.committed() : "";
        const range = batchRange(bytes, before ? finalAt : 0);
        const base = speechServer(data);
        let after = "";
        if (base && bytes - range.start >= MIN_DICTATION_BYTES) {
          try {
            after = await transcribe(buildWav([sliceChunks(recorded, range.start)]), base, {
              language: data.language,
              ...(data.sttToken ? { token: data.sttToken } : {}),
            });
            truncated = range.truncated;
          } catch (error) {
            if (dictation !== mine || closed) return;
            console.warn("[fieldlog] speech server unavailable:", error);
            failed = true;
          }
        } else if (!base && !before) {
          // Live only, and it was lost: there is no file server to fall back to.
          failed = true;
        }
        text = [before, after].filter(Boolean).join(" ");
      }
    }
    if (dictation !== mine || closed || phase !== "transcribing") return;
    heard = new LiveTranscript();
    lastFinalAt = 0;
    if (failed && !text) {
      status = "error";
      phase = "idle";
      await draw();
      return;
    }
    status = "idle";
    if (!text) {
      notice = "heardNothing";
      phase = "idle";
    } else {
      pending = text;
      reviewChoice = 0;
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
    truncated = false;
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

  /**
   * Side-menu choices. Nothing in the menu touches a running dictation; the entry type applies to
   * the next entry (and to the text under review), the photo is taken through the phone camera
   * whose shutter is the confirmation.
   */
  const onMenu = (id: number): void => {
    if (closed || paused || helpOpen) return;
    if (phase === "recording" || phase === "transcribing") return;
    if (pendingDiscard !== null) { pendingDiscard = null; clearTimeout(confirmTimer); }
    notice = null;
    if (id === MENU_HELP) { helpOpen = true; void draw(); return; }
    const severity = MENU_SEVERITY[id];
    if (severity) {
      data = { ...data, severity };
      background(save(bridge, data), "saving the severity");
      void draw();
      return;
    }
    if (id === MENU_PHOTO && inspection()) {
      // Under review the photo belongs to the text on screen: the list row "Keep + photo" says so; here only the cursor moves.
      if (phase === "review") { reviewChoice = 1; void draw(); return; }
      background(attachPhoto(), "attaching a photo");
    }
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

    // QIS v1.2: the side menu (hold). A click is an explicit choice, never a slip; it also cancels an armed discard.
    const menuId = menuItemIdFromEvent(event);
    if (menuId !== null) { if (SIDE_MENU) onMenu(menuId); return; }

    const audio = (event as { audioEvent?: { audioPcm?: unknown } }).audioEvent;
    if (audio !== undefined) {
      if (phase !== "recording" || micPausedForExit) return;
      const bytes = pcmBytes(audio.audioPcm);
      if (!bytes || bytes.length === 0) return;
      // Over the cap: stop and send what there is, never buffer more.
      if (recordedBytes + bytes.length > MAX_DICTATION_BYTES) { background(endRecording(), "stopping the microphone"); return; }
      // Kept on the phone in every case: the fallback if the live text drops.
      chunks.push(bytes);
      recordedBytes += bytes.length;
      live?.send(bytes);
      return;
    }

    const gesture = gestureFromEvent(event, { invertScroll: data.invertScroll });
    if (!gesture) return;
    // Anything but a tap cancels an armed discard: swipe, hold and 2× never carry it out (QIS v1).
    if (gesture.gesture !== "click") {
      const wasArmed = pendingDiscard !== null;
      pendingDiscard = null;
      clearTimeout(confirmTimer);
      if (wasArmed) void draw();
    }

    // The help page is a subpage: 2× goes back, nothing else does anything.
    if (helpOpen) {
      if (gesture.gesture !== "doubleClick") return;
      helpOpen = false;
      void draw();
      return;
    }

    switch (gesture.gesture) {
      case "click":
        notice = null;
        if (!inspection()) { background(startNew(), "starting an inspection"); return; }
        if (phase === "pick") { background(pickNote(), "saving the note"); return; }
        if (!SIDE_MENU && phase === "idle" && helpSelected) { helpOpen = true; break; }
        if (phase === "idle" && !voice()) { phase = "pick"; pickIndex = 0; break; }
        if (phase === "idle") { background(startMic(), "starting dictation"); return; }
        if (phase === "recording") { background(endRecording(), "stopping the microphone"); return; }
        if (phase === "review") {
          if (reviewChoice === 0) { background(keepPending(), "saving the entry"); return; }
          // "Keep + photo" is chosen from the list; the camera shutter is the last confirmation.
          if (reviewChoice === 1) { background(keepPending().then(attachPhoto), "attaching a photo"); return; }
          // Discarding takes two single taps on "Discard" within a few seconds; anything else cancels.
          const step = confirmStep(pendingDiscard, "discard", Date.now());
          pendingDiscard = step.pending;
          clearTimeout(confirmTimer);
          if (step.confirmed) {
            pending = null;
            truncated = false;
            reviewChoice = 0;
            phase = "idle";
          } else {
            confirmTimer = setTimeout(() => { pendingDiscard = null; void draw(); }, CONFIRM_WINDOW_MS + 50);
          }
        }
        break;

      case "scrollUp":
      case "scrollDown":
        if (phase === "pick") {
          const count = notes().length + 1;
          pickIndex = (pickIndex + (gesture.gesture === "scrollDown" ? 1 : -1) + count) % count;
          break;
        }
        if (phase === "review") {
          // A swipe only moves between "Keep", "Keep + photo" and "Discard"; it never saves or discards anything.
          reviewChoice = ((reviewChoice + (gesture.gesture === "scrollDown" ? 1 : 2)) % 3) as ReviewChoice;
          break;
        }
        // With a side menu (QIS v1.2) a swipe on the resting screen only moves; the entry type is a click
        // in the menu. Without one the swipe moves through the type of the next entry (shown on screen);
        // with an inspection open "Help" is the last stop.
        if (SIDE_MENU || phase !== "idle") break;
        {
          const stops = SEVERITIES.length + (inspection() ? 1 : 0);
          const index = helpSelected ? SEVERITIES.length : SEVERITIES.indexOf(data.severity);
          const delta = gesture.gesture === "scrollDown" ? 1 : -1;
          const nextIndex = (index + delta + stops) % stops;
          helpSelected = nextIndex === SEVERITIES.length;
          const next = SEVERITIES[nextIndex];
          if (next) {
            data = { ...data, severity: next };
            background(save(bridge, data), "saving the severity");
          }
        }
        break;

      case "longPress":
        // With a side menu the hold belongs to it; nothing happens in the app.
        if (SIDE_MENU) break;
        // With no inspection open there is nothing to photograph: hold opens the help.
        if (phase === "idle" && !inspection()) { helpOpen = true; break; }
        if (phase === "idle") { background(attachPhoto(), "attaching a photo"); return; }
        // Under review the hold only moves the cursor to "Keep + photo"; a tap there keeps and takes the photo.
        if (phase === "review") { reviewChoice = 1; break; }
        break;

      case "doubleClick":
        // 2x is "back one level": out of the quick-note list. It never stops a recording or
        // throws away a transcript, so those phases ignore it; only the resting screen leaves.
        if (phase === "pick") { phase = "idle"; pickIndex = 0; break; }
        if (phase === "recording" || phase === "transcribing" || phase === "review") return;
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
      // The side menu carries the language: the page is rebuilt with it.
      if (SIDE_MENU) rebuildWanted = true;
      void draw();
    },
    takePhoto: () => attachPhoto(),
  });
  refreshPhone = phone.refresh;
}

void boot().catch((error: unknown) => {
  console.error("[fieldlog] failed to start:", error);
});
