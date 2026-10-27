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
import { gestureFromCode, gestureFromEvent, menuItemIdFromEvent } from "./input/gestures";
import {
  itemView, notesView, pickView, readPageCount, readView, reviewView, roomsView, startRows, startView,
  type ChecklistRow, type FieldNotice, type LiveView, type LogView, type Phase, type ReviewChoice,
} from "./glasses/view";
import { checklistProgress, findItem, firstOpenItem, firstOpenRoom, setCheck, type CheckRoom } from "./checklist/checklist";
import { afterAnswer, tapOk, walkStart, walkSwipe, type OkKind, type WalkCursor } from "./checklist/walk";
import { sameView } from "./glasses/diff";
import {
  COCKPIT_TILES, createCockpitPage, createTextPage, forgetPage, guardedTileSend, updateTextPage, type MenuSpec,
} from "./glasses/render";
import { cockpitModel, pcmLevel, pushLevel, type CockpitModel } from "./cockpit/model";
import { composeCockpit } from "./cockpit/compose";
import { createTileSender } from "./screen/sender";
import { autoBackend, type TextBackend } from "./screen/text";
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
 * works from lists (QUS v1): the type of the next entry is a row of the start list, the photo is a choice under review.
 */
const SIDE_MENU = false;
const SEVERITIES: readonly Severity[] = ["note", "minor", "major"];
/** Side menu (QIS v1.2): item ids. Hold opens the menu; a menu click is an explicit choice. */
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
  /** Where the glasses are while no dictation, quick-note list or review is running (QUS v1). */
  type Screen = "start" | "recorder" | "notes" | "read" | "rooms" | "item";
  let screen: Screen = "start";
  /** Checklist (0.10): the highlighted room of the overview, and where the walk through that room stands. */
  let roomCursor = 0;
  let walk: WalkCursor = walkStart();
  /** OK on a critical item waits here for its second tap (FlowList pattern). */
  let pendingOk: PendingConfirm<OkKind> | null = null;
  let okTimer: ReturnType<typeof setTimeout> | undefined;
  /** The quick-note list records a defect of this checklist item (null: an ordinary quick note). */
  let pickFor: string | null = null;
  let startCursor = 0;
  /** Index into the notes, newest first. */
  let notesCursor = 0;
  let readPage = 0;
  /** Microphone level history for the recording screen, and the loudest block since the last second. */
  let levels: number[] = [];
  let levelPeak = 0;
  let lastLengthMs: number | null = null;
  /** Tapping "Discard" under review waits here for its second tap (QIS v1). */
  let pendingDiscard: PendingConfirm<"discard"> | null = null;
  let confirmTimer: ReturnType<typeof setTimeout> | undefined;

  const inspection = (): Inspection | null => activeInspection(data);
  /** The start list's checklist row: only for a walk that has a checklist. */
  const checklistRow = (): ChecklistRow | null => {
    const current = inspection();
    if (!current?.checklist) return null;
    const progress = checklistProgress(current);
    return { done: progress.done, total: progress.total };
  };
  const currentRoom = (): CheckRoom | null => inspection()?.checklist?.rooms[roomCursor] ?? null;
  /** Drops an armed OK (a swipe, 2x, the timeout or leaving the item). */
  const disarmOk = (): boolean => {
    const was = pendingOk !== null;
    pendingOk = null;
    clearTimeout(okTimer);
    return was;
  };
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
      { id: MENU_NOTE, label: t(locale, "m.note") },
      { id: MENU_MINOR, label: t(locale, "m.minor") },
      { id: MENU_MAJOR, label: t(locale, "m.major") },
      { id: MENU_PHOTO, label: t(locale, "m.photo") },
    ],
  });

  type Scene =
    | { readonly kind: "text"; readonly view: LogView }
    | { readonly kind: "cockpit"; readonly model: CockpitModel };

  /** Everything on the glasses for one moment. */
  const currentScene = (now: number): Scene => {
    const current = inspection();
    const count = current?.entries.length ?? 0;
    // The phone may have removed what the glasses were looking at.
    if ((screen === "notes" || screen === "read") && count === 0) screen = "start";
    if (screen === "read" && notesCursor >= count) screen = "notes";
    notesCursor = Math.min(notesCursor, Math.max(0, count - 1));
    // The phone may have removed or edited the checklist under the walk.
    const rooms = current?.checklist?.rooms ?? [];
    if ((screen === "rooms" || screen === "item") && rooms.length === 0) screen = "start";
    roomCursor = Math.min(roomCursor, Math.max(0, rooms.length - 1));
    const room = rooms[roomCursor];
    if (room) walk = { item: Math.min(walk.item, Math.max(0, room.items.length - 1)), choice: walk.choice };
    if (phase === "pick") {
      const target = pickFor !== null && current?.checklist ? findItem(current.checklist, pickFor) : null;
      return { kind: "text", view: pickView({
        locale, severity: data.severity, quickNotes: notes(), pickIndex, ...(target ? { forItem: target.item.text } : {}),
      }) };
    }
    if (phase === "review") {
      return { kind: "text", view: reviewView({
        locale, severity: data.severity, pending, reviewChoice, truncated,
        confirmDiscard: activeConfirm(pendingDiscard, Date.now()) !== null,
      }) };
    }
    if (phase === "recording" || phase === "transcribing" || (screen === "recorder" && current)) {
      return { kind: "cockpit", model: cockpitModel({
        phase, inspections: data.inspections, active: current, now, locale, severity: data.severity,
        voice: voice(), demo: DEMO, status, live: liveView, notice,
        elapsedMs: phase === "recording" ? now - recordStartedAt : 0, lastLengthMs, levels,
      }) };
    }
    if (current && screen === "notes") return { kind: "text", view: notesView(current, notesCursor, locale, voice(), DEMO) };
    if (current && screen === "read") {
      readPage = Math.min(readPage, readPageCount(current, notesCursor, locale) - 1);
      return { kind: "text", view: readView(current, notesCursor, readPage, locale) };
    }
    if (current && room && screen === "rooms") return { kind: "text", view: roomsView(current, roomCursor, locale) };
    if (current && room && screen === "item") {
      return { kind: "text", view: itemView(current, room, walk, activeConfirm(pendingOk, Date.now()) !== null, locale) };
    }
    screen = "start";
    const rows = startRows(count, checklistRow());
    startCursor = Math.min(startCursor, rows.length - 1);
    return { kind: "text", view: startView(startCursor, {
      locale, voice: voice(), demo: DEMO, severity: data.severity, entryCount: count, checklist: checklistRow(),
    }) };
  };

  /** Set once the phone page is mounted; redraws it after a change made on the glasses. */
  let refreshPhone: () => void = () => undefined;

  // While the exit dialog may be on screen (asked, no input since) no timer, poll or stream may draw: a page call
  // could cover it. Data keeps being collected; the back signal restores the page the way of the first one.
  let exitAsked = (): boolean => false;
  /** The page rebuild started by the first input after a real background (5 without a dialog). */
  let comingBack: Promise<void> | null = null;
  /** A gesture or menu click, read without touching the gesture de-duplication that gestureFromEvent keeps. */
  const isUserInput = (event: unknown): boolean => {
    if (menuItemIdFromEvent(event) !== null) return true;
    const record = (event && typeof event === "object" ? event : {}) as Record<string, unknown>;
    return ["textEvent", "listEvent", "sysEvent"].some((key) => {
      const payload = record[key];
      if (!payload || typeof payload !== "object") return false;
      const part = payload as Record<string, unknown>;
      const raw = part["eventType"] ?? part["event_type"] ?? part["type"];
      return gestureFromCode(typeof raw === "number" ? raw : raw === undefined ? 0 : NaN) !== null;
    });
  };
  /** Which kind of page the glasses carry: a change means one rebuild. */
  let installed: "text" | "cockpit" | null = null;
  let textBackend: TextBackend | null = null;
  /** The cockpit is one 576 x 288 frame; only the tiles whose pixels changed cross Bluetooth. Never while the dialog may be up. */
  const tileSender = createTileSender(COCKPIT_TILES, guardedTileSend(bridge, () => !exitAsked() && !closed && !paused && installed === "cockpit"));

  const drawOnce = async (): Promise<void> => {
    if (exitAsked()) return;
    if (paused) return;
    // A page lost with the link (or in the background) is rebuilt even when
    // nothing changed; read here, so a draw already running cannot undo it.
    if (rebuildWanted) { rebuildWanted = false; pageReady = false; lastView = null; }
    const scene = currentScene(Date.now());

    if (scene.kind === "cockpit") {
      if (installed !== "cockpit") pageReady = false;
      if (!pageReady) {
        const result = await createCockpitPage(bridge, menu());
        if (closed) return;
        if (!result.ok) { pageReady = false; installed = null; lastView = null; console.warn("[fieldlog] draw failed:", result.reason); return; }
        pageReady = true;
        installed = "cockpit";
        lastView = null;
        // A new page starts with blank images.
        tileSender.reset();
      }
      textBackend ??= autoBackend();
      // Never awaited: a slow transfer must not hold up the next gesture.
      void tileSender.push(composeCockpit(scene.model, textBackend));
      return;
    }

    // Leaving the cockpit: its containers are about to go, no tile may be written any more.
    if (installed === "cockpit") { installed = null; pageReady = false; }
    const view = scene.view;
    if (pageReady && sameView(lastView, view)) return;

    const result = pageReady ? await updateTextPage(bridge, view, lastView) : await createTextPage(bridge, view, menu());
    if (closed) return;
    if (result.ok) { pageReady = true; installed = "text"; lastView = view; return; }
    pageReady = false;
    installed = null;
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
    if (exitAsked()) return Promise.resolve();
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

  /** Recording with no inspection open starts one, named after the date and time. */
  const startNew = async (): Promise<void> => {
    const id = nextInspectionId(data);
    const now = Date.now();
    data = { ...upsertInspection(data, startInspection(id, autoTitle(locale, now), now)), activeId: id };
    refreshPhone();
    await save(bridge, data);
  };

  /** The "Record" row of the start list: with a speech server the recorder opens and the microphone starts; without one the quick notes. */
  const openRecord = async (): Promise<void> => {
    if (!inspection()) await startNew();
    if (voice()) {
      screen = "recorder";
      await startMic();
      return;
    }
    phase = "pick";
    pickIndex = 0;
    pickFor = null;
    await draw();
  };

  /** Files the highlighted quick note, or leaves the list on "Cancel". */
  const pickNote = async (): Promise<void> => {
    const current = inspection();
    const note = notes()[pickIndex];
    const forItem = pickFor;
    phase = "idle";
    pickIndex = 0;
    pickFor = null;
    if (forItem !== null) {
      // A defect of a checklist item: filed under its room and item, the item is answered and the walk moves on.
      // "Cancel" goes back to the item unchanged.
      screen = "item";
      const target = current?.checklist ? findItem(current.checklist, forItem) : null;
      if (current && target && note) {
        const now = Date.now();
        const filed = addEntry(current, target.item.text + ": " + note, target.item.critical ? "major" : "minor", now,
          { section: target.room.name, itemId: target.item.id });
        await persist(setCheck(filed, target.item.id, "defect", now));
        advanceWalk();
      }
      await draw();
      return;
    }
    screen = "start";
    if (current && note) await persist(addEntry(current, note, data.severity, Date.now()));
    await draw();
  };

  /** After an item was answered: the next item of the room, or the overview at the end of it (cursor on the next room). */
  const advanceWalk = (): void => {
    const room = currentRoom();
    const next = room ? afterAnswer(room, walk) : null;
    if (next) { walk = next; return; }
    const rooms = inspection()?.checklist?.rooms.length ?? 0;
    if (rooms > 0) roomCursor = Math.min(roomCursor + 1, rooms - 1);
    walk = walkStart();
    screen = "rooms";
  };

  /** Opens a room of the checklist where there is something left to do. */
  const openRoom = (): void => {
    const current = inspection();
    const room = currentRoom();
    if (!current || !room) return;
    walk = walkStart(firstOpenItem(current, room));
    screen = "item";
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
    levels = [];
    levelPeak = 0;
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
      levels = [];
      levelPeak = 0;
      ticker = setInterval(() => {
        if (phase !== "recording" || dictation !== mine) return;
        levels = pushLevel(levels, levelPeak);
        levelPeak = 0;
        void draw();
      }, 1_000);
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
    lastLengthMs = Date.now() - recordStartedAt;
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
  const attachPhoto = async (itemId?: string): Promise<void> => {
    if (!inspection()) return;
    if (itemId !== undefined) { await attachItemPhoto(itemId); return; }
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

  /**
   * A photo for one checklist item, taken from the phone page: it becomes an entry of that item
   * ("Fenster und Rahmen: Foto"), filed under its room, which is what a photo-required item waits for.
   */
  const attachItemPhoto = async (itemId: string): Promise<void> => {
    const asset = await bridge.captureImageFromCamera().catch(() => null);
    const current = inspection();
    const target = current?.checklist ? findItem(current.checklist, itemId) : null;
    if (!current || !target) return;
    if (!asset?.base64) { notice = "noPhoto"; await draw(); return; }
    notice = null;
    const filed = addEntry(current, target.item.text + ": " + t(locale, "photoOnly"), "note", Date.now(),
      { section: target.room.name, itemId: target.item.id });
    await persist(attachToLatest(filed, {
      dataUri: "data:" + (asset.mimeType || "image/jpeg") + ";base64," + asset.base64,
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
    tileSender.close();
    micPausedForExit = false;
    clearInterval(clock);
    clearTimeout(confirmTimer);
    clearTimeout(okTimer);
    const wasRecording = phase === "recording" || starting;
    abandonRecording();
    if (wasRecording && micMayBeOn) void bridge.audioControl(false).catch(() => undefined);
  };

  // shutDownPageContainer(1) resolves when the dialog is SHOWN, not when the user answered: the result never
  // shuts anything down. A confirmed exit arrives as sysEvent 6/7 (shutDown below). The paused microphone
  // comes back on the next input, which is the signal that the user stayed.
  const requestExit = createExitRequest(bridge, {
    onBack: async () => {
      // The dialog took the page away. Put it up again the way of the first one (create),
      // so the glasses deliver input - and the next 2x - to the app again.
      if (!closed) {
        pageReady = false;
        lastView = null;
        forgetPage(bridge);
        await draw();
      }
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
  exitAsked = requestExit.asked;

  /**
   * Double tap asks the system exit dialog. The microphone goes off before
   * the dialog appears, so nothing is heard while the user decides; cancelling
   * turns it back on and the dictation carries on.
   */
  const close = async (): Promise<void> => {
    if (closed) return;
    // Coming back from the background: the page must be up before the dialog is asked (a call during creation is lost).
    if (comingBack) { await comingBack.catch(() => undefined); comingBack = null; if (closed) return; }
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
    if (closed || paused) return;
    if (phase === "recording" || phase === "transcribing") return;
    if (pendingDiscard !== null) { pendingDiscard = null; clearTimeout(confirmTimer); }
    notice = null;
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
    // The 4/5 right after an exit call are the system dialog's own show/close, not the app entering/leaving.
    if (requestExit.onLifecycle(event) !== null) return;
    const step = lifecycleFromEvent(event);
    // A real input while the app thinks it is in the background (a genuine 5 without a dialog): it is back. Draws
    // were silent while paused, so the page is rebuilt before the input is handled (a root 2x then restores and asks).
    if (paused && step === null && (event as { audioEvent?: unknown }).audioEvent === undefined
      && isUserInput(event)) {
      paused = false;
      rebuildWanted = true;
      comingBack = draw();
    }
    // Not the microphone stream: PCM keeps flowing while the dialog is open and says nothing about the user.
    if (step !== "foregroundExit" && !isFinalExit(step) && (event as { audioEvent?: unknown }).audioEvent === undefined) requestExit.back();
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
      levelPeak = Math.max(levelPeak, pcmLevel(bytes));
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
      // An armed OK of a critical item: a swipe or 2x only cancels it (the footer says so), nothing else happens.
      if (activeConfirm(pendingOk, Date.now()) !== null) { disarmOk(); void draw(); return; }
      disarmOk();
    }

    switch (gesture.gesture) {
      case "click":
        notice = null;
        if (phase === "pick") { background(pickNote(), "saving the note"); return; }
        if (phase === "recording") { background(endRecording(), "stopping the microphone"); return; }
        if (phase === "review") {
          if (reviewChoice === 0) { background(keepPending(), "saving the entry"); return; }
          // "Keep + photo" is chosen from the list; the camera shutter is the last confirmation.
          if (reviewChoice === 1) { background(keepPending().then(() => attachPhoto()), "attaching a photo"); return; }
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
          break;
        }
        if (phase !== "idle") return;
        if (screen === "recorder") { background(startMic(), "starting dictation"); return; }
        if (screen === "rooms") { openRoom(); break; }
        if (screen === "item") {
          const current = inspection();
          const room = currentRoom();
          const item = room?.items[walk.item];
          if (!current || !room || !item) break;
          if (walk.choice === 1) {
            // "Defect": the quick notes, filed under this item.
            disarmOk();
            pickFor = item.id;
            pickIndex = 0;
            phase = "pick";
            break;
          }
          const tap = tapOk(item, activeConfirm(pendingOk, Date.now()), Date.now());
          pendingOk = tap.pending;
          clearTimeout(okTimer);
          if (!tap.confirmed) {
            // First tap on a critical item: armed; it runs out after the window.
            okTimer = setTimeout(() => { pendingOk = null; void draw(); }, CONFIRM_WINDOW_MS + 50);
            break;
          }
          background(persist(setCheck(current, item.id, "ok", Date.now())), "saving the check");
          advanceWalk();
          break;
        }
        if (screen === "notes") { readPage = 0; screen = "read"; break; }
        if (screen === "read") {
          const count = inspection()?.entries.length ?? 0;
          if (count > 0) notesCursor = (notesCursor + 1) % count;
          readPage = 0;
          break;
        }
        {
          // The start list: record / notes / type of the next entry (a tap sets the next type).
          const rows = startRows(inspection()?.entries.length ?? 0, checklistRow());
          const row = rows[Math.min(startCursor, rows.length - 1)];
          if (row?.kind === "checklist") {
            const current = inspection();
            roomCursor = current ? firstOpenRoom(current) : 0;
            screen = "rooms";
            break;
          }
          if (row?.kind === "record") { background(openRecord(), "starting dictation"); return; }
          if (row?.kind === "notes") { notesCursor = 0; screen = "notes"; break; }
          if (row?.kind === "type") {
            const next = SEVERITIES[(SEVERITIES.indexOf(data.severity) + 1) % SEVERITIES.length];
            if (next) {
              data = { ...data, severity: next };
              background(save(bridge, data), "saving the severity");
            }
          }
        }
        break;

      case "scrollUp":
      case "scrollDown": {
        const delta = gesture.gesture === "scrollDown" ? 1 : -1;
        if (phase === "pick") {
          const count = notes().length + 1;
          pickIndex = (pickIndex + delta + count) % count;
          break;
        }
        if (phase === "review") {
          // A swipe only moves between "Keep", "Keep + photo" and "Discard"; it never saves or discards anything.
          reviewChoice = ((reviewChoice + (delta === 1 ? 1 : 2)) % 3) as ReviewChoice;
          break;
        }
        if (phase !== "idle") break;
        const current = inspection();
        const count = current?.entries.length ?? 0;
        const rooms = current?.checklist?.rooms ?? [];
        if (screen === "start") {
          const rows = startRows(count, checklistRow()).length;
          startCursor = (Math.min(startCursor, rows - 1) + delta + rows) % rows;
        } else if (screen === "rooms" && rooms.length > 0) {
          roomCursor = (Math.min(roomCursor, rooms.length - 1) + delta + rooms.length) % rooms.length;
        } else if (screen === "item") {
          // Only moves: OK -> Defect -> next item, and back. Never records anything.
          const room = currentRoom();
          if (room) walk = walkSwipe(room, walk, delta);
        } else if (screen === "notes" && count > 0) {
          notesCursor = (notesCursor + delta + count) % count;
        } else if (screen === "read" && current) {
          // Pages of a long note; a swipe never leaves the note.
          const pages = readPageCount(current, notesCursor, locale);
          readPage = Math.min(Math.max(0, readPage + delta), pages - 1);
        }
        break;
      }

      // The hold never reaches the app on the real glasses (QUS v1); nothing depends on it.
      case "longPress":
        return;

      case "doubleClick":
        // 2x is "back one level". It never stops a recording or throws away a transcript, so those
        // phases ignore it; the quick-note list, the notes and the recorder go back, only the start leaves.
        if (phase === "pick") { phase = "idle"; screen = pickFor !== null ? "item" : "start"; pickFor = null; pickIndex = 0; break; }
        if (phase === "recording" || phase === "transcribing" || phase === "review") return;
        if (screen === "read") { screen = "notes"; break; }
        if (screen === "item") { screen = "rooms"; break; }
        if (screen === "rooms") { screen = "start"; break; }
        if (screen === "notes" || screen === "recorder") { screen = "start"; break; }
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
      // (A defect being picked for a checklist item uses quick notes in every case.)
      if (phase === "pick" && voice() && pickFor === null) phase = "idle";
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
    takePhoto: (itemId?: string) => attachPhoto(itemId),
  });
  refreshPhone = phone.refresh;
}

void boot().catch((error: unknown) => {
  console.error("[fieldlog] failed to start:", error);
});
