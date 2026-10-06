import { AudioInputSource, waitForEvenAppBridge, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { createClient, toApiError, type ShootDayApi } from "./api/client";
import { createDemoApi } from "./api/demo";
import type { CallSheet, EquipmentItem, Shot, Take, TakeStatus } from "./api/types";
import { getLocale, type Locale } from "./i18n";
import { gestureFromEvent, type Gesture } from "./input/gestures";
import { takeNotes, t } from "./messages";
import { sameView } from "./glasses/diff";
import { createPage, updatePage } from "./glasses/render";
import { MAX_BODY_ROWS, wrap, type ScreenView } from "./glasses/screen";
import {
  buildView, errorText, MENU, TAKE_ACTIONS, type LastTake, type LoadStatus, type Mode, type TakeScreen, type ViewState,
} from "./glasses/views";
import {
  loadOutbox, loadSettings, saveOutbox, saveSettings, type PendingTake, type Settings,
} from "./storage/persist";
import { mountPhoneUi, type ConnectionState } from "./ui/phone";
import { parsePackCommand } from "./voice/pack-voice";
import { parseTakeCommand } from "./voice/take-voice";
import { concat, pcmToWav, toPcm } from "./voice/wav";

const DEMO = new URLSearchParams(globalThis.location?.search ?? "").get("demo") === "1";

/** Teleprompter step; the view only changes when a new line comes up. */
const PROMPTER_TICK_MS = 200;
/** The schedule's "now / next" lines depend on the clock. */
const CLOCK_TICK_MS = 30_000;
/** A feedback line stays this long. */
const MESSAGE_MS = 6_000;
/** Voice commands are short; the microphone never stays on longer than this. */
const MAX_RECORD_MS = 15_000;
/** 16 kHz × 2 bytes × 16 s — anything beyond is dropped, never buffered. */
const MAX_PCM_BYTES = 16_000 * 2 * 16;
/** Shorter than this is a slip of the finger, not a sentence. */
const MIN_PCM_BYTES = 16_000 * 2 / 5;

type Module = Exclude<Mode, "menu">;
type LoadKind = Mode;

interface Recording {
  readonly id: number;
  readonly target: "takes" | "pack";
  readonly via: "tap" | "hold";
  phase: "opening" | "listening" | "transcribing";
  stopRequested: boolean;
  chunks: Uint8Array[];
  bytes: number;
  timer?: ReturnType<typeof setTimeout>;
}

async function boot(): Promise<void> {
  const bridge: EvenAppBridge = await waitForEvenAppBridge();

  let settings: Settings = await loadSettings(bridge);
  let outbox: PendingTake[] = await loadOutbox(bridge);
  let locale: Locale = getLocale();

  const makeApi = (): ShootDayApi | null => {
    if (DEMO) return createDemoApi(locale);
    if (!settings.serverUrl) return null;
    return createClient({ baseUrl: settings.serverUrl, ...(settings.token ? { token: settings.token } : {}) });
  };
  let api = makeApi();

  // ---- state -------------------------------------------------------------
  let closed = false;
  /** Bumped on every module change and settings change: replies from before are dropped. */
  let generation = 0;
  let mode: Mode = "menu";
  let menuCursor = 0;
  const load = new Map<LoadKind, LoadStatus>();
  /** Last failure talking to the server; localised only when shown. */
  let connectionError: { readonly code: string; readonly status?: number } | null = null;
  let connected = false;
  let message = "";
  let messageTimer: ReturnType<typeof setTimeout> | undefined;

  let project = "";
  let shots: Shot[] = [];
  let serverTakes: Take[] = [];
  let shotCursor = 0;
  let takeScreen: TakeScreen = "card";
  let actionCursor = 0;
  let noteCursor = 0;

  let prompterLines: string[] = [];
  let prompterPos = 0;
  let prompterSpeed = 0.4;
  let playing = false;
  let prompterTimer: ReturnType<typeof setInterval> | undefined;

  let sheet: CallSheet = { date: "", call: "", location: "", contact: "", notes: "", schedule: [] };
  let scheduleScroll = 0;

  let equipment: EquipmentItem[] = [];
  let packCursor = 0;
  let showMissing = false;

  let rec: Recording | null = null;
  let recIds = 0;

  const needed = (): EquipmentItem[] => equipment.filter((item) => item.need);
  const notes = (): string[] => takeNotes(locale);

  // ---- background work never leaves a rejection unhandled ----------------
  const background = (task: Promise<unknown>, what: string): void => {
    task.catch((error: unknown) => { console.warn("[shootday] " + what + " failed:", error); });
  };

  /** Writes run one after another, in the order they were made. */
  let writes: Promise<void> = Promise.resolve();
  const queueWrite = (task: () => Promise<void>, what: string): Promise<void> => {
    const next = writes.then(task).catch((error: unknown) => { console.warn("[shootday] " + what + " failed:", error); });
    writes = next;
    return next;
  };

  const say = (text: string): void => {
    message = text;
    clearTimeout(messageTimer);
    if (text) messageTimer = setTimeout(() => { message = ""; void draw(); }, MESSAGE_MS);
  };

  // ---- takes -------------------------------------------------------------
  const takeKey = (scene: string, shot: string): string => scene + "\u0000" + shot;
  const takesFor = (shot: Shot | undefined): Array<LastTake & { readonly id?: string }> => {
    if (!shot) return [];
    const key = takeKey(shot.scene, shot.shot);
    const synced = serverTakes
      .filter((take) => takeKey(take.scene, take.shot) === key)
      .map((take) => ({ n: take.n, status: take.status, note: take.note, ts: take.ts, pending: false }));
    const waiting = outbox
      .filter((take) => take.project === project && takeKey(take.scene, take.shot) === key)
      .map((take, index) => ({ id: take.id, n: synced.length + index + 1, status: take.status, note: take.note, ts: take.ts, pending: true }));
    return [...synced, ...waiting];
  };

  // ---- view --------------------------------------------------------------
  const currentLoad = (): LoadStatus => load.get(mode) ?? { kind: "idle" };

  const viewState = (): ViewState => {
    const shot = shots[shotCursor];
    const all = takesFor(shot);
    const last = all.reduce<LastTake | null>((latest, take) => (!latest || take.ts >= latest.ts ? take : latest), null);
    return {
      locale,
      demo: DEMO,
      configured: api !== null,
      now: new Date(),
      mode,
      menuCursor,
      project,
      pendingCount: outbox.length,
      load: mode === "menu" ? load.get("menu") ?? { kind: "idle" } : currentLoad(),
      message,
      rec: rec ? { target: rec.target, via: rec.via, busy: rec.phase === "transcribing" } : null,
      takes: {
        shots,
        cursor: shotCursor,
        screen: takeScreen,
        actionCursor,
        noteCursor,
        ok: all.filter((take) => take.status === "OK").length,
        ng: all.filter((take) => take.status === "NG").length,
        last,
        nextN: all.length + 1,
        notes: notes(),
      },
      prompter: { lines: prompterLines, pos: prompterPos, speed: prompterSpeed, playing },
      schedule: { sheet, scroll: scheduleScroll },
      pack: { items: needed(), cursor: packCursor, missing: showMissing },
    };
  };

  let lastView: ScreenView | null = null;
  let pageReady = false;
  let drawing: Promise<void> | null = null;
  let redrawQueued = false;

  const drawOnce = async (): Promise<void> => {
    const view = buildView(viewState());
    if (sameView(lastView, view)) return;
    const result = pageReady ? await updatePage(bridge, view) : await createPage(bridge, view);
    if (result.ok) { pageReady = true; lastView = view; return; }
    pageReady = false;
    lastView = null;
    console.warn("[shootday] draw failed:", result.reason);
  };

  /** One draw at a time; requests made meanwhile collapse into one redraw. */
  const draw = (): Promise<void> => {
    if (closed) return Promise.resolve();
    if (drawing) { redrawQueued = true; return drawing; }
    drawing = (async () => {
      try {
        do {
          redrawQueued = false;
          await drawOnce();
        } while (redrawQueued && !closed);
      } catch (error) {
        console.warn("[shootday] draw failed:", error);
      } finally {
        drawing = null;
      }
    })();
    return drawing;
  };

  let refreshPhone: () => void = () => undefined;

  // ---- loading: one request per kind, stale replies dropped --------------
  const inflight = new Map<LoadKind, Promise<void>>();
  const reloadWanted = new Set<LoadKind>();

  const fail = (kind: LoadKind, error: unknown): void => {
    const problem = toApiError(error);
    load.set(kind, { kind: "error", code: problem.code, ...(problem.status ? { status: problem.status } : {}) });
    if (kind === "menu" || kind === "takes") {
      connectionError = { code: problem.code, ...(problem.status ? { status: problem.status } : {}) };
      connected = false;
    }
  };

  const fetchers: Record<LoadKind, (client: ShootDayApi, stillCurrent: () => boolean) => Promise<void>> = {
    menu: async (client, stillCurrent) => {
      const list = await client.shotList();
      if (!stillCurrent()) return;
      project = list.project;
      shots = [...list.shots];
      shotCursor = Math.min(shotCursor, Math.max(0, shots.length - 1));
    },
    takes: async (client, stillCurrent) => {
      const list = await client.shotList();
      const taken = await client.takes();
      if (!stillCurrent()) return;
      if (list.project !== project) shotCursor = 0;
      project = list.project;
      shots = [...list.shots];
      serverTakes = taken;
      shotCursor = Math.min(shotCursor, Math.max(0, shots.length - 1));
    },
    prompter: async (client, stillCurrent) => {
      const text = await client.prompter();
      if (!stillCurrent()) return;
      prompterLines = text.trim() ? wrap(text) : [];
      prompterPos = 0;
      playing = false;
    },
    schedule: async (client, stillCurrent) => {
      const next = await client.callSheet();
      if (!stillCurrent()) return;
      sheet = next;
      scheduleScroll = 0;
    },
    pack: async (client, stillCurrent) => {
      const next = await client.equipment();
      if (!stillCurrent()) return;
      equipment = [...next.items];
      packCursor = Math.min(packCursor, Math.max(0, needed().length - 1));
    },
  };

  const requestLoad = (kind: LoadKind): void => {
    const client = api;
    if (closed || !client) return;
    if (inflight.has(kind)) { reloadWanted.add(kind); return; }
    const startedIn = generation;
    const stillCurrent = (): boolean => !closed && generation === startedIn && api === client;
    if (load.get(kind)?.kind !== "ready") load.set(kind, { kind: "loading" });
    void draw();
    const run = (async () => {
      try {
        await fetchers[kind](client, stillCurrent);
        if (!stillCurrent()) return;
        load.set(kind, { kind: "ready" });
        if (kind === "menu" || kind === "takes") { connectionError = null; connected = true; }
        if (kind === "takes" || kind === "menu") flushOutbox();
      } catch (error) {
        if (!stillCurrent()) return;
        fail(kind, error);
      }
      refreshPhone();
      await draw();
    })().catch((error: unknown) => { console.warn("[shootday] load failed:", error); }).finally(() => {
      inflight.delete(kind);
      // Left and came back while this was running: its answer was dropped, so load again.
      if (reloadWanted.delete(kind) && !closed && (mode === kind || kind === "menu")) requestLoad(kind);
    });
    inflight.set(kind, run);
  };

  // ---- the take outbox ---------------------------------------------------
  let flushing = false;
  const persistOutbox = (): void => { background(saveOutbox(bridge, outbox), "saving the outbox"); };

  const flushOutbox = (): void => {
    const client = api;
    if (flushing || !client || closed) return;
    const ready = outbox.filter((take) => take.project === project);
    if (ready.length === 0) return;
    flushing = true;
    void queueWrite(async () => {
      try {
        for (const pending of ready) {
          if (api !== client || closed) return;
          const saved = await client.addTake({ scene: pending.scene, shot: pending.shot, status: pending.status, note: pending.note });
          outbox = outbox.filter((take) => take.id !== pending.id);
          serverTakes = [...serverTakes, saved];
          persistOutbox();
        }
      } catch {
        // Still offline: they stay queued for the next successful contact.
      } finally {
        flushing = false;
        refreshPhone();
        void draw();
      }
    }, "sending queued takes");
  };

  const addTake = (status: TakeStatus, note = ""): void => {
    const shot = shots[shotCursor];
    const client = api;
    if (!shot || !client) return;
    const pending: PendingTake = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      project, scene: shot.scene, shot: shot.shot, status, note, ts: Date.now(),
    };
    // Into the outbox first: should the app close mid-request, the take is not lost.
    outbox = [...outbox, pending];
    persistOutbox();
    const label = `${shot.scene}${shot.shot} T${takesFor(shot).length} ${status}${note ? " " + note : ""}`;
    void queueWrite(async () => {
      try {
        const saved = await client.addTake({ scene: shot.scene, shot: shot.shot, status, note });
        outbox = outbox.filter((take) => take.id !== pending.id);
        if (api === client) serverTakes = [...serverTakes, saved];
        persistOutbox();
        say(t(locale, "g.msg.saved", { what: label }));
      } catch {
        say(t(locale, "g.msg.queued"));
      }
      refreshPhone();
      await draw();
    }, "logging a take");
  };

  const setLastNote = (picked: string): void => {
    const shot = shots[shotCursor];
    const all = takesFor(shot);
    const last = all.reduce<(typeof all)[number] | null>((latest, take) => (!latest || take.ts >= latest.ts ? take : latest), null);
    if (!shot || !last) return;
    const note = picked.startsWith("(") ? "" : picked;
    say(t(locale, "g.msg.note", { note: note || "–" }));
    if (last.pending) {
      outbox = outbox.map((take) => (take.id === last.id ? { ...take, note } : take));
      persistOutbox();
      return;
    }
    serverTakes = serverTakes.map((take) =>
      take.scene === shot.scene && take.shot === shot.shot && take.n === last.n ? { ...take, note } : take);
    const client = api;
    if (!client) return;
    void queueWrite(async () => {
      try {
        await client.setTakeNote(shot.scene, shot.shot, last.n, note);
      } catch (error) {
        const problem = toApiError(error);
        say(t(locale, "g.msg.notSaved", { reason: t(locale, "g.err." + problem.code, { status: problem.status }) }));
        await draw();
      }
    }, "saving a note");
  };

  // ---- packing list ------------------------------------------------------
  const setPacked = (name: string, packed: boolean, announce: boolean): Promise<void> => {
    const client = api;
    equipment = equipment.map((item) => (item.name === name ? { ...item, packed } : item));
    if (announce) say(t(locale, packed ? "g.pack.ticked" : "g.pack.unticked", { name }));
    void draw();
    if (!client) return Promise.resolve();
    return queueWrite(async () => {
      try {
        await client.setPacked(name, packed);
      } catch (error) {
        // Show what is true: the tick did not reach the server, so take it back.
        if (api === client) equipment = equipment.map((item) => (item.name === name && item.packed === packed ? { ...item, packed: !packed } : item));
        const problem = toApiError(error);
        say(t(locale, "g.msg.notSaved", { reason: t(locale, "g.err." + problem.code, { status: problem.status }) }));
        await draw();
      }
    }, "saving the packing list");
  };

  const applyPackCommand = (text: string): void => {
    const items = needed();
    const command = parsePackCommand(text, items.map((item) => item.name));
    switch (command.kind) {
      case "missing":
        showMissing = true;
        say("");
        break;
      case "all":
        for (const item of items) if (item.packed !== command.packed) void setPacked(item.name, command.packed, false);
        say(t(locale, command.packed ? "g.pack.all" : "g.pack.reset"));
        break;
      case "item": {
        const item = items[command.index];
        if (!item) break;
        packCursor = command.index;
        void setPacked(item.name, command.packed, true);
        break;
      }
      case "unknown":
        say(t(locale, "g.msg.unknown", { text: text.slice(0, 24) }));
        break;
    }
  };

  const applyTakeCommand = (text: string): void => {
    const command = parseTakeCommand(text, shots, shotCursor, notes());
    if (command.index !== null) shotCursor = command.index;
    const shot = shots[shotCursor];
    takeScreen = "card";
    if (command.status) { addTake(command.status, command.note); return; }
    if (command.index !== null && shot) { say(t(locale, "g.msg.moved", { scene: shot.scene, shot: shot.shot })); return; }
    say(t(locale, "g.msg.unknown", { text: text.slice(0, 24) }));
  };

  // ---- microphone --------------------------------------------------------
  const micOff = (): Promise<void> => bridge.audioControl(false).then(() => undefined, () => undefined);

  const startRec = async (target: "takes" | "pack", via: "tap" | "hold"): Promise<void> => {
    if (rec || closed || !api) return;
    const current: Recording = { id: ++recIds, target, via, phase: "opening", stopRequested: false, chunks: [], bytes: 0 };
    rec = current;
    say("");
    await draw();
    const ok = await bridge.audioControl(true, AudioInputSource.Glasses).catch(() => false);
    if (rec !== current || closed) {
      // Cancelled or closed while the microphone was opening: it must not stay on.
      if (ok) await micOff();
      return;
    }
    if (!ok) {
      rec = null;
      say(t(locale, "g.msg.micOff"));
      await draw();
      return;
    }
    current.phase = "listening";
    current.timer = setTimeout(() => { background(stopRec(), "stopping the microphone"); }, MAX_RECORD_MS);
    if (current.stopRequested) await stopRec();
  };

  const stopRec = async (): Promise<void> => {
    const current = rec;
    if (!current) return;
    if (current.phase === "opening") { current.stopRequested = true; return; }
    if (current.phase !== "listening") return;
    current.phase = "transcribing";
    clearTimeout(current.timer);
    await micOff();
    await draw();
    const pcm = concat(current.chunks);
    current.chunks = [];
    const client = api;
    if (pcm.length < MIN_PCM_BYTES || !client) {
      if (rec === current) { rec = null; say(t(locale, "g.msg.nothing")); }
      await draw();
      return;
    }
    let text = "";
    let failed = "";
    try {
      text = (await client.transcribe(pcmToWav(pcm), locale)).trim();
    } catch (error) {
      const problem = toApiError(error);
      failed = t(locale, "g.err." + problem.code, { status: problem.status });
    }
    // Cancelled, closed or left the module while the server was listening.
    if (rec !== current || closed) return;
    rec = null;
    if (failed) say(t(locale, "g.msg.sttFail", { reason: failed }));
    else if (!text) say(t(locale, "g.msg.nothing"));
    else if (current.target === "pack") applyPackCommand(text);
    else applyTakeCommand(text);
    await draw();
  };

  const cancelRec = (announce: boolean): void => {
    const current = rec;
    if (!current) return;
    rec = null;
    clearTimeout(current.timer);
    current.chunks = [];
    if (current.phase !== "transcribing") background(micOff(), "stopping the microphone");
    if (announce) say(t(locale, "g.msg.cancelled"));
  };

  // ---- navigation --------------------------------------------------------
  const stopPrompter = (): void => {
    playing = false;
    clearInterval(prompterTimer);
    prompterTimer = undefined;
  };

  const prompterTick = (): void => {
    if (!playing) return;
    const last = Math.max(0, prompterLines.length - 1);
    prompterPos = Math.min(last, prompterPos + prompterSpeed * (PROMPTER_TICK_MS / 1000));
    if (prompterPos >= last) stopPrompter();
    void draw();
  };

  const enter = (next: Module): void => {
    generation++;
    mode = next;
    say("");
    if (next === "takes") { takeScreen = "card"; actionCursor = 0; }
    if (next === "pack") showMissing = false;
    load.delete(next);
    requestLoad(next);
  };

  const toMenu = (): void => {
    cancelRec(false);
    stopPrompter();
    generation++;
    mode = "menu";
    showMissing = false;
    say("");
    requestLoad("menu");
  };

  /**
   * Leaving from the menu asks the system first (exit mode 1). Until the
   * system confirms, the app keeps running: the user may still cancel.
   */
  const requestExit = (): void => {
    bridge.shutDownPageContainer(1).then(
      (left) => { if (left === true) shutDown(); },
      (error: unknown) => { console.warn("[shootday] exit failed:", error); },
    );
  };

  let clock: ReturnType<typeof setInterval> | undefined;
  const shutDown = (): void => {
    if (closed) return;
    cancelRec(false);
    closed = true;
    stopPrompter();
    clearInterval(clock);
    clearTimeout(messageTimer);
  };

  // ---- gestures ----------------------------------------------------------
  const step = (gesture: Gesture): number => (gesture === "scrollDown" ? 1 : -1);
  const wrapIndex = (index: number, count: number): number => (count <= 0 ? 0 : (index + count) % count);

  const onRecGesture = (gesture: Gesture): void => {
    const current = rec;
    if (!current) return;
    if (gesture === "doubleClick") { cancelRec(true); return; }
    if (current.phase === "transcribing") return;
    if (gesture === "click" || gesture === "longPressRelease") background(stopRec(), "stopping the microphone");
  };

  const onMenu = (gesture: Gesture): void => {
    switch (gesture) {
      case "scrollUp":
      case "scrollDown":
        menuCursor = wrapIndex(menuCursor + step(gesture), MENU.length);
        break;
      case "click": {
        const next = MENU[menuCursor];
        if (!next) break;
        if (!api) { requestLoad("menu"); break; }
        enter(next);
        return;
      }
      case "doubleClick":
        requestExit();
        return;
      default:
        return;
    }
    void draw();
  };

  const onTakes = (gesture: Gesture): void => {
    if (currentLoad().kind !== "ready" || shots.length === 0) {
      if (gesture === "click" && currentLoad().kind === "error") { enter("takes"); return; }
      if (gesture === "doubleClick") toMenu();
      return;
    }
    if (takeScreen === "actions") {
      if (gesture === "scrollUp" || gesture === "scrollDown") actionCursor = wrapIndex(actionCursor + step(gesture), TAKE_ACTIONS.length);
      else if (gesture === "doubleClick") takeScreen = "card";
      else if (gesture === "click") {
        const action = TAKE_ACTIONS[actionCursor];
        takeScreen = "card";
        if (action === "ok") addTake("OK");
        else if (action === "ng") addTake("NG");
        else if (action === "note") { takeScreen = "notes"; noteCursor = 0; }
        else if (action === "voice") { background(startRec("takes", "tap"), "starting the microphone"); return; }
      } else return;
      void draw();
      return;
    }
    if (takeScreen === "notes") {
      const count = notes().length;
      if (gesture === "scrollUp" || gesture === "scrollDown") noteCursor = wrapIndex(noteCursor + step(gesture), count);
      else if (gesture === "doubleClick") takeScreen = "card";
      else if (gesture === "click") { setLastNote(notes()[noteCursor] ?? ""); takeScreen = "card"; }
      else return;
      void draw();
      return;
    }
    switch (gesture) {
      case "scrollUp":
      case "scrollDown":
        shotCursor = wrapIndex(shotCursor + step(gesture), shots.length);
        say("");
        break;
      case "click":
        takeScreen = "actions";
        actionCursor = 0;
        break;
      case "longPress":
        background(startRec("takes", "hold"), "starting the microphone");
        return;
      case "doubleClick":
        toMenu();
        return;
      default:
        return;
    }
    void draw();
  };

  const onPrompter = (gesture: Gesture): void => {
    if (currentLoad().kind !== "ready") {
      if (gesture === "click" && currentLoad().kind === "error") { enter("prompter"); return; }
      if (gesture === "doubleClick") toMenu();
      return;
    }
    switch (gesture) {
      case "scrollDown":
        prompterSpeed = Math.min(3, Math.round((prompterSpeed + 0.1) * 10) / 10);
        break;
      case "scrollUp":
        prompterSpeed = Math.max(0.1, Math.round((prompterSpeed - 0.1) * 10) / 10);
        break;
      case "click":
        if (prompterLines.length === 0) { enter("prompter"); return; }
        if (playing) stopPrompter();
        else {
          if (prompterPos >= prompterLines.length - 1) prompterPos = 0;
          playing = true;
          clearInterval(prompterTimer);
          prompterTimer = setInterval(prompterTick, PROMPTER_TICK_MS);
        }
        break;
      case "doubleClick":
        toMenu();
        return;
      default:
        return;
    }
    void draw();
  };

  const onSchedule = (gesture: Gesture): void => {
    if (gesture === "doubleClick") { toMenu(); return; }
    if (gesture === "click") { requestLoad("schedule"); return; }
    if (currentLoad().kind !== "ready") return;
    if (gesture === "scrollUp" || gesture === "scrollDown") {
      const rows = Math.max(1, MAX_BODY_ROWS - 4);
      scheduleScroll = Math.max(0, Math.min(Math.max(0, sheet.schedule.length - rows), scheduleScroll + step(gesture)));
      void draw();
    }
  };

  const onPack = (gesture: Gesture): void => {
    if (currentLoad().kind !== "ready") {
      if (gesture === "click" && currentLoad().kind === "error") { enter("pack"); return; }
      if (gesture === "doubleClick") toMenu();
      return;
    }
    if (showMissing) {
      if (gesture === "click" || gesture === "doubleClick") { showMissing = false; void draw(); }
      return;
    }
    const items = needed();
    switch (gesture) {
      case "scrollUp":
      case "scrollDown":
        packCursor = Math.max(0, Math.min(items.length - 1, packCursor + step(gesture)));
        break;
      case "click": {
        const item = items[packCursor];
        if (!item) { requestLoad("pack"); return; }
        void setPacked(item.name, !item.packed, false);
        return;
      }
      case "longPress":
        background(startRec("pack", "hold"), "starting the microphone");
        return;
      case "doubleClick":
        toMenu();
        return;
      default:
        return;
    }
    void draw();
  };

  await draw();
  if (api) requestLoad("menu");

  bridge.onEvenHubEvent((event) => {
    if (closed) return;
    const audio = (event as { audioEvent?: { audioPcm?: unknown } }).audioEvent;
    if (audio) {
      const current = rec;
      if (!current || current.phase !== "listening") return;
      const pcm = toPcm(audio.audioPcm);
      if (pcm.length === 0) return;
      if (current.bytes + pcm.length > MAX_PCM_BYTES) { background(stopRec(), "stopping the microphone"); return; }
      current.chunks.push(pcm);
      current.bytes += pcm.length;
      return;
    }

    const parsed = gestureFromEvent(event, { invertScroll: settings.invertScroll });
    if (!parsed) return;
    const gesture = parsed.gesture;
    if (rec) { onRecGesture(gesture); void draw(); return; }
    switch (mode) {
      case "menu": onMenu(gesture); return;
      case "takes": onTakes(gesture); return;
      case "prompter": onPrompter(gesture); return;
      case "schedule": onSchedule(gesture); return;
      case "pack": onPack(gesture); return;
    }
  });

  // The page does not survive a disconnect; the last view is forgotten too,
  // or an unchanged view would skip the rebuild and leave the display blank.
  bridge.onDeviceStatusChanged((status) => {
    if (status?.connectType === "connected" && !closed) {
      pageReady = false;
      lastView = null;
      void draw();
    }
  });

  clock = setInterval(() => { if (mode === "schedule") void draw(); }, CLOCK_TICK_MS);

  const phone = mountPhoneUi({
    getSettings: () => settings,
    saveSettings: async (next) => {
      await saveSettings(bridge, next);
      const serverChanged = next.serverUrl !== settings.serverUrl || next.token !== settings.token;
      settings = next;
      if (serverChanged) {
        api = makeApi();
        project = "";
        shots = [];
        serverTakes = [];
        load.clear();
        connectionError = null;
        connected = false;
        toMenu();
      }
      await draw();
    },
    connection: (): ConnectionState => {
      if (DEMO) return { kind: "demo" };
      if (!api) return { kind: "none" };
      if (connectionError) return { kind: "error", reason: errorText(locale, connectionError.code, connectionError.status) };
      return connected ? { kind: "ok", project } : { kind: "loading" };
    },
    pendingCount: () => outbox.length,
    locale: () => locale,
    onLocaleChange: (next) => {
      locale = next;
      void draw();
    },
  });
  refreshPhone = phone.refresh;
}

void boot().catch((error: unknown) => {
  console.error("[shootday] failed to start:", error);
});
