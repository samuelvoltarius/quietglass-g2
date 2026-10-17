import { AudioInputSource, waitForEvenAppBridge, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { settleRestore } from "./exit";
import { ApiError, askUnsupported, createClient, type XaventraApi } from "./api/client";
import { createDemoApi } from "./api/demo";
import type { HudCard, HudFeed, VoiceResult } from "./api/types";
import { rememberLocale, resolveLocale, type Locale } from "./i18n";
import { gestureFromEvent, menuItemIdFromEvent, type Gesture } from "./input/gestures";
import { errorDetail, errorText } from "./hud/errors";
import { t } from "./messages";
import { sameView } from "./glasses/diff";
import { createPage, faceKey, forgetPage, updatePage, type MenuSpec } from "./glasses/render";
import { MASCOT_STEP_MS, headerIcon } from "./glasses/face";
import type { ScreenView } from "./glasses/screen";
import {
  CONFIRM_MS, EMPTY_MODEL, SIDE_MENU, buildView, currentCard, decide, spokenAnswer, type HudAction, type HudGesture, type HudModel,
} from "./hud/model";
import type { Answer } from "./api/types";
import { loadSettings, saveSettings, type Settings } from "./storage/persist";
import { isFinalExit, lifecycleFromEvent } from "./lifecycle";
import { mountPhoneUi, type ConnectionState } from "./ui/phone";
import { concat, pcmToWav, toPcm } from "./voice/wav";
import { MAX_COMMAND_MS, liveSttUrl, openLiveStt, type LiveSession } from "./voice/live-stt";

const DEMO = new URLSearchParams(globalThis.location?.search ?? "").get("demo") === "1";

/** A guard against a lost release event: the microphone never stays on longer than this. */
const MAX_RECORD_MS = MAX_COMMAND_MS;
/** 16 kHz × 2 bytes × 121 s — anything beyond is dropped, never buffered. */
const MAX_PCM_BYTES = 16_000 * 2 * (MAX_RECORD_MS / 1000 + 1);
/** Live text on the glasses is redrawn at most this often. */
const LIVE_REDRAW_MS = 300;
/** Private builds name their live speech recogniser here; public builds leave it empty. */
const LIVE_STT_DEFAULT = (import.meta.env.VITE_LIVE_STT_URL as string | undefined) ?? "";
/** Shorter than this is a slip of the finger, not a sentence. */
const MIN_PCM_BYTES = 16_000 * 2 / 2;
/** A feedback line stays this long. */
const MESSAGE_MS = 6_000;
/** A voice reply closes by itself after this. */
const VOICE_PANEL_MS = 30_000;
const RETRY_MS = 5_000;
const RETRY_AUTH_MS = 10_000;

/** QIS v1.2 #1: the glasses' side menu. Help lives here, not in the answer list. */
export const MENU = { help: 1 } as const;

interface Recording {
  readonly id: number;
  phase: "opening" | "listening" | "sending";
  stopRequested: boolean;
  chunks: Uint8Array[];
  bytes: number;
  timer?: ReturnType<typeof setTimeout>;
  /** Live transcription while speaking; null without a live recogniser. */
  live: LiveSession | null;
}

async function boot(): Promise<void> {
  const bridge: EvenAppBridge = await waitForEvenAppBridge();

  let settings: Settings = await loadSettings(bridge);
  let locale: Locale = await resolveLocale(bridge);
  let closed = false;

  const makeApi = (): XaventraApi | null => {
    if (DEMO) return createDemoApi(locale, new URLSearchParams(globalThis.location?.search ?? "").get("scene"));
    if (!settings.serverUrl) return null;
    return createClient({ baseUrl: settings.serverUrl, ...(settings.token ? { token: settings.token } : {}) });
  };
  let api: XaventraApi | null = makeApi();

  let model: HudModel = { ...EMPTY_MODEL, configured: api !== null };
  /** Technical detail of the last feed problem (HTTP status), for the phone only. */
  let problemDetail = "";
  const patch = (change: Partial<HudModel>): void => { model = { ...model, ...change }; };

  const background = (task: Promise<unknown>, what: string): void => {
    task.catch((error: unknown) => { console.warn("[xaventrahud] " + what + " failed:", error); });
  };

  // ---- drawing -----------------------------------------------------------
  let lastView: ScreenView | null = null;
  let lastFace = "";
  let pageReady = false;
  /** The side menu travels with the page: another label (language) means one rebuild. */
  let pageMenuKey = "";
  // Off while its clicks do not arrive on the real glasses (SIDE_MENU, step log 15.10.2026): the page carries no menu.
  const menuSpec = (): MenuSpec => SIDE_MENU ? { key: locale, items: [{ id: MENU.help, label: t(locale, "g.m.help") }] } : { key: "none", items: [] };
  /** Set by a reconnect or a return to the foreground: the next draw rebuilds the page. */
  let rebuildWanted = false;
  /** In the background: no feed poll, no drawing. */
  let paused = false;
  let drawing: Promise<void> | null = null;
  let redrawQueued = false;
  let refreshPhone: () => void = () => undefined;

  // While the exit dialog may be on screen (asked, no input since) no timer, poll or stream may draw: a page call
  // could cover it. Data keeps being collected; the back signal restores the page the way of the first one.
  let exitDialogAsked = false;
  /**
   * The system dialog's own lifecycle (step log, Klipper 0.5.11): right after shutDownPageContainer(1) the glasses
   * send FOREGROUND_ENTER (4) when the dialog comes up and FOREGROUND_EXIT (5) when it goes away after "No" - not
   * the app entering or leaving. Between the call and the 5 nothing is drawn; the 5 puts the page up again.
   */
  let dialogPending = false;
  let dialogShown = false;
  const drawOnce = async (): Promise<void> => {
    if (exitDialogAsked) return;
    if (paused) return;
    // A page lost with the link (or while in the background) is rebuilt even
    // when nothing changed; the flag is read here so a reconnect during a
    // running draw is not undone by that draw's success.
    if (rebuildWanted) { rebuildWanted = false; pageReady = false; lastView = null; }
    const now = new Date();
    const view = buildView(model, locale, now);
    const face = headerIcon(model, now.getTime());
    const key = faceKey(face);
    const menu = menuSpec();
    if (pageReady && menu.key !== pageMenuKey) { pageReady = false; lastView = null; }
    if (pageReady && sameView(lastView, view) && key === lastFace) return;
    const result = pageReady ? await updatePage(bridge, view, face, lastView) : await createPage(bridge, view, face, menu);
    if (result.ok) {
      if (!pageReady) pageMenuKey = menu.key;
      pageReady = true; lastView = view; lastFace = key; return;
    }
    pageReady = false;
    lastView = null;
    console.warn("[xaventrahud] draw failed:", result.reason);
  };

  /** One draw at a time; requests made meanwhile collapse into one redraw. */
  const draw = (): Promise<void> => {
    refreshPhone();
    if (exitDialogAsked) return Promise.resolve();
    if (closed) return Promise.resolve();
    if (drawing) { redrawQueued = true; return drawing; }
    drawing = (async () => {
      try {
        do {
          redrawQueued = false;
          await drawOnce();
        } while (redrawQueued && !closed);
      } catch (error) {
        console.warn("[xaventrahud] draw failed:", error);
      } finally {
        drawing = null;
      }
    })();
    return drawing;
  };

  // ---- transient state ---------------------------------------------------
  let messageTimer: ReturnType<typeof setTimeout> | undefined;
  let confirmTimer: ReturnType<typeof setTimeout> | undefined;
  let voiceTimer: ReturnType<typeof setTimeout> | undefined;

  const say = (text: string): void => {
    clearTimeout(messageTimer);
    patch({ message: text });
    if (text) messageTimer = setTimeout(() => { patch({ message: "" }); void draw(); }, MESSAGE_MS);
  };
  const disarm = (): void => { clearTimeout(confirmTimer); patch({ confirm: null }); };
  const arm = (cardId: string): void => {
    clearTimeout(confirmTimer);
    patch({ confirm: cardId });
    confirmTimer = setTimeout(() => { patch({ confirm: null }); void draw(); }, CONFIRM_MS);
  };
  const closeVoice = (): void => { clearTimeout(voiceTimer); patch({ voice: null }); };

  const withoutCard = (feed: HudFeed | null, cardId: string): HudFeed | null =>
    feed ? { ...feed, cards: feed.cards.filter((card) => card.id !== cardId) } : feed;

  // ---- the feed: one long poll at a time ---------------------------------
  let pollGeneration = 0;
  let pollAbort: AbortController | null = null;

  const pause = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });

  const stopPoll = (): void => {
    pollGeneration++;
    pollAbort?.abort();
    pollAbort = null;
  };

  const startPoll = (): void => {
    stopPoll();
    const client = api;
    if (!client) return;
    const generation = pollGeneration;
    const abort = new AbortController();
    pollAbort = abort;
    background((async () => {
      while (generation === pollGeneration && !closed) {
        try {
          const feed = await client.feed(model.feed?.version ?? "", abort.signal);
          if (generation !== pollGeneration || closed) return;
          const cards = feed.cards;
          const confirmGone = model.confirm !== null && !cards.some((card) => card.id === model.confirm);
          // A "Nein" choice belongs to its card: gone with the card, it never moves to another.
          const neinGone = model.nein !== null && !cards.some((card) => card.id === model.nein);
          problemDetail = "";
          patch({
            feed, online: true, problem: "", fault: false,
            index: Math.min(model.index, Math.max(0, cards.length - 1)),
            ...(confirmGone ? { confirm: null } : {}),
            ...(neinGone ? { nein: null } : {}),
          });
          await draw();
        } catch (error) {
          if (generation !== pollGeneration || closed) return;
          problemDetail = errorDetail(error);
          patch({
            online: false, problem: errorText(locale, error),
            fault: error instanceof ApiError && (error.code === "auth" || error.code === "http" || error.code === "bad-reply"),
          });
          await draw();
          await pause(error instanceof ApiError && error.code === "auth" ? RETRY_AUTH_MS : RETRY_MS, abort.signal);
        }
      }
    })(), "feed");
  };

  // ---- answering a card --------------------------------------------------
  let answering = false;

  const answerCard = async (card: HudCard, answer: "ja" | "nein"): Promise<void> => {
    const client = api;
    if (!client || answering) return;
    answering = true;
    disarm();
    say(t(locale, answer === "ja" ? "g.msg.sendYes" : "g.msg.sendNo"));
    await draw();
    try {
      const result = await client.answer(card.id, answer);
      if (closed) return;
      patch({ feed: withoutCard(model.feed, card.id), index: 0, nein: null });
      say(result.message || t(locale, "g.msg.done"));
    } catch (error) {
      if (closed) return;
      // The card is gone on the server (answered, expired, unknown): drop it here too.
      if (error instanceof ApiError && [404, 409, 410].includes(error.status)) patch({ feed: withoutCard(model.feed, card.id), index: 0, nein: null });
      say(t(locale, "g.msg.answerFail", { reason: errorText(locale, error) }));
    } finally {
      answering = false;
    }
    await draw();
  };

  // ---- microphone --------------------------------------------------------
  let rec: Recording | null = null;
  let recIds = 0;
  const MIC_DRAIN_MS = 150;
  const micOff = async (): Promise<void> => {
    await bridge.audioControl(false).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, MIC_DRAIN_MS));
  };

  /** Recognised text on screen, waiting for the wearer's tap (send) or 2x (discard), with its audio as fallback. */
  let draft: { readonly text: string; readonly pcm: Uint8Array } | null = null;

  /** Whether this server has `POST /hud/ask`; learnt on the first try, per session. */
  let askAvailable = true;
  let liveDrawAt = 0;
  let liveDrawTimer: ReturnType<typeof setTimeout> | undefined;
  /** Live text redraws at most every LIVE_REDRAW_MS. */
  const drawLive = (): void => {
    if (liveDrawTimer) return;
    const wait = Math.max(0, liveDrawAt + LIVE_REDRAW_MS - Date.now());
    liveDrawTimer = setTimeout(() => { liveDrawTimer = undefined; liveDrawAt = Date.now(); void draw(); }, wait);
  };

  const startLive = (current: Recording): LiveSession | null => {
    const url = DEMO ? "" : liveSttUrl(undefined, LIVE_STT_DEFAULT);
    if (!url) return null;
    return openLiveStt({
      url,
      language: locale,
      onText: (text) => {
        if (rec !== current || current.phase !== "listening" || closed) return;
        if (text === model.live) return;
        patch({ live: text });
        drawLive();
      },
    });
  };

  const startRec = async (): Promise<void> => {
    if (rec || closed || answering || draft) return;
    if (!api) { say(t(locale, "g.setup1")); await draw(); return; }
    const current: Recording = { id: ++recIds, phase: "opening", stopRequested: false, chunks: [], bytes: 0, live: null };
    rec = current;
    clearTimeout(voiceTimer);
    patch({ rec: "opening", voice: null, message: "", live: "", recSince: 0 });
    disarm();
    await draw();
    const ok = await bridge.audioControl(true, AudioInputSource.Glasses).catch(() => false);
    if (rec !== current || closed) {
      // Cancelled or closed while the microphone was opening: it must not stay on.
      if (ok) await micOff();
      return;
    }
    if (!ok) {
      rec = null;
      patch({ rec: "off" });
      say(t(locale, "g.msg.micOff"));
      await draw();
      return;
    }
    current.phase = "listening";
    patch({ rec: "listening", recSince: Date.now() });
    current.live = startLive(current);
    current.timer = setTimeout(() => { background(stopRec(), "stopping the microphone"); }, MAX_RECORD_MS);
    await draw();
    if (current.stopRequested) await stopRec();
  };

  /**
   * QIS v1.2 #4: a spoken yes/no never answers by itself. It selects that entry
   * on its card and arms it; the confirming tap within CONFIRM_MS sends it.
   */
  const proposeAnswer = (cardId: string, answer: Answer): void => {
    const card = model.feed?.cards.find((entry) => entry.id === cardId) ?? null;
    if (!card || !model.feed) { say(t(locale, "g.msg.noCard")); return; }
    patch({ index: model.feed.cards.indexOf(card), nein: answer === "nein" ? card.id : null, helpStop: false, help: false });
    arm(card.id);
    say(t(locale, answer === "nein" ? "g.msg.heardNo" : "g.msg.heardYes"));
  };

  const applyVoice = (result: VoiceResult): void => {
    switch (result.action) {
      case "answered_ja":
      case "needs_confirm":
        proposeAnswer(result.cardId, "ja");
        return;
      case "answered_nein":
        proposeAnswer(result.cardId, "nein");
        return;
      case "message":
        if (!result.reply && !result.transcript) { say(t(locale, "g.msg.nothing")); return; }
        patch({ voice: { transcript: result.transcript, reply: result.reply } });
        voiceTimer = setTimeout(() => { closeVoice(); void draw(); }, VOICE_PANEL_MS);
        return;
      case "none":
        say(t(locale, result.transcript ? "g.msg.unclear" : "g.msg.nothing"));
        return;
    }
  };

  /** Sends what was said (live text via /hud/ask, else the WAV) and shows the result. */
  const deliver = async (current: Recording, heard: string | null, pcm: Uint8Array): Promise<void> => {
    const client = api;
    if (!client) {
      if (rec === current) { rec = null; patch({ rec: "off", live: "", recSince: 0 }); }
      await draw();
      return;
    }
    const cardId = currentCard(model)?.id;
    let result: VoiceResult | null = null;
    let failed = "";
    let sent = false;
    if (heard && askAvailable) {
      try {
        result = await client.ask(heard, cardId);
        sent = true;
      } catch (error) {
        // No text endpoint on this server: never processed, so the WAV may go instead.
        if (askUnsupported(error)) askAvailable = false;
        else { failed = errorText(locale, error); sent = true; }
      }
    }
    if (!sent && rec === current && !closed) {
      try {
        result = await client.voice(pcmToWav(pcm), cardId);
      } catch (error) {
        failed = errorText(locale, error);
      }
    }
    // Cancelled or closed while the server was listening.
    if (rec !== current || closed) return;
    rec = null;
    patch({ rec: "off", live: "", recSince: 0 });
    if (failed) say(t(locale, "g.msg.voiceFail", { reason: failed }));
    else if (result) applyVoice(result);
    await draw();
  };

  /** The tap on recognised text: now it goes out. */
  const sendDraft = (): void => {
    const waiting = draft;
    if (!waiting || rec || closed) return;
    draft = null;
    const current: Recording = { id: ++recIds, phase: "sending", stopRequested: false, chunks: [], bytes: 0, live: null };
    rec = current;
    patch({ draft: "", rec: "sending", live: waiting.text, recSince: 0, message: "" });
    void draw();
    background(deliver(current, waiting.text, waiting.pcm), "sending");
  };

  const discardDraft = (): void => {
    if (!draft) return;
    draft = null;
    patch({ draft: "" });
    say(t(locale, "g.msg.discarded"));
  };

  const stopRec = async (): Promise<void> => {
    const current = rec;
    if (!current) return;
    if (current.phase === "opening") { current.stopRequested = true; return; }
    if (current.phase !== "listening") return;
    current.phase = "sending";
    clearTimeout(current.timer);
    patch({ rec: "sending" });
    await micOff();
    await draw();
    const pcm = concat(current.chunks);
    current.chunks = [];
    const client = api;
    if (pcm.length < MIN_PCM_BYTES || !client) {
      current.live?.cancel();
      if (rec === current) { rec = null; patch({ rec: "off", live: "" }); say(t(locale, "g.msg.nothing")); }
      await draw();
      return;
    }
    // The live recogniser commits its last words; null = it failed, the WAV goes.
    const heard = current.live ? await current.live.finish() : null;
    if (rec !== current || closed) return;
    if (heard) {
      // QIS v1.2: the recognised text is shown first. A bare yes/no selects and arms that
      // answer (v1.2 #4); anything else waits as a draft: tap sends it, 2x discards it.
      rec = null;
      patch({ rec: "off", live: "", recSince: 0 });
      const answer = spokenAnswer(heard);
      const card = currentCard(model);
      if (answer && card) proposeAnswer(card.id, answer);
      else { draft = { text: heard, pcm }; patch({ draft: heard }); }
      await draw();
      return;
    }
    // No live text (public builds, or the recogniser failed): the recording goes as before.
    await deliver(current, null, pcm);
  };

  const cancelRec = (announce: boolean): void => {
    const current = rec;
    if (!current) return;
    rec = null;
    clearTimeout(current.timer);
    current.chunks = [];
    current.live?.cancel();
    patch({ rec: "off", live: "", recSince: 0 });
    if (current.phase !== "sending") background(micOff(), "stopping the microphone");
    if (announce) say(t(locale, "g.msg.cancelled"));
  };

  // ---- leaving -----------------------------------------------------------
  /**
   * Leaving asks the system first (exit mode 1). Until the system confirms,
   * the app keeps running: the user may still cancel.
   */
  // shutDownPageContainer(1) resolves when the dialog is SHOWN (hardware: ~58 ms after the double tap), not when
  // the user answered, so the result never tears the app down. If the user confirms, the system ends the app
  // (sysEvent 6/7 below). After "No" the app has to be alive: on the next signal that it is back (any input,
  // FOREGROUND_ENTER) the page is put up again the way of the first one, then the event is handled normally.
  /** The restore started by the last exitBack(), while it is still running. */
  let restoring: Promise<void> | null = null;
  const exitBack = (): void => {
    if (!exitDialogAsked) return;
    exitDialogAsked = false;
    if (closed) return;
    pageReady = false;
    lastView = null;
    forgetPage(bridge);
    const run = draw().catch(() => undefined);
    restoring = run;
    void run.then(() => { if (restoring === run) restoring = null; });
  };
  const requestExit = (): void => {
    // A second double tap before any restore: put the page back first, then ask again.
    exitBack();
    // The first double tap after "No" is the back signal itself: a dialog call issued while the page is still being
    // created is lost (hardware, Klipper 0.5.8). So it waits for the restore and a short settle delay.
    const restore = restoring;
    const ask = async (): Promise<void> => {
      dialogPending = true;
      try {
        await bridge.shutDownPageContainer(1);
      } catch (error: unknown) {
        console.warn("[xaventrahud] exit failed:", error);
      }
      exitDialogAsked = true;
    };
    // Without a restore in flight the host is called at once, in this very event.
    if (restore) void settleRestore(restore).then(ask);
    else void ask();
  };

  const shutDown = (): void => {
    if (closed) return;
    cancelRec(false);
    closed = true;
    stopPoll();
    clearTimeout(messageTimer);
    clearTimeout(confirmTimer);
    clearTimeout(voiceTimer);
    clearTimeout(liveDrawTimer);
  };

  // ---- gestures ----------------------------------------------------------
  const perform = (action: HudAction): void => {
    switch (action.kind) {
      case "answer": {
        const card = model.feed?.cards.find((entry) => entry.id === action.cardId);
        if (card) background(answerCard(card, action.answer), "answering");
        return;
      }
      case "confirm":
        arm(action.cardId);
        void draw();
        return;
      case "move":
        disarm();
        patch({ index: action.index, nein: action.nein, helpStop: action.helpStop });
        void draw();
        return;
      case "disarm":
        disarm();
        void draw();
        return;
      case "help":
        disarm();
        patch({ help: action.open });
        void draw();
        return;
      case "dismiss":
        closeVoice();
        void draw();
        return;
      case "sendDraft":
        sendDraft();
        return;
      case "discardDraft":
        discardDraft();
        void draw();
        return;
      case "exit":
        requestExit();
        return;
      case "none":
        return;
    }
  };

  const hudGesture = (gesture: Gesture): HudGesture | null =>
    gesture === "click" || gesture === "doubleClick" || gesture === "scrollUp" || gesture === "scrollDown" ? gesture : null;

  // Gestures first; the page and the feed follow in the background, so a
  // slow page creation can never swallow the double tap.
  bridge.onEvenHubEvent((event) => {
    if (closed) return;
    const step = lifecycleFromEvent(event);
    if (step === "foregroundEnter" && dialogPending) {
      // The exit dialog came up: stay still, it is on screen now.
      dialogPending = false;
      dialogShown = true;
      exitDialogAsked = true;
      return;
    }
    if (step === "foregroundExit" && dialogShown) {
      // "No": the dialog went away. The app never left - page up again the way of the first one, nothing is paused.
      dialogShown = false;
      exitDialogAsked = true;
      exitBack();
      return;
    }
    // Not the microphone stream: PCM keeps flowing while the dialog is open and says nothing about the user.
    const isAudio = (event as { audioEvent?: unknown }).audioEvent !== undefined;
    const sysType = (event as { sysEvent?: { eventType?: number } }).sysEvent?.eventType;
    if (!isAudio && sysType !== 8) { dialogPending = false; dialogShown = false; }
    if (step !== "foregroundExit" && !isFinalExit(step) && !isAudio) exitBack();
    if (step === "foregroundExit") {
      // Out of sight: no microphone, no long poll; the cards stay as they are.
      paused = true;
      cancelRec(false);
      disarm();
      stopPoll();
      return;
    }
    if (step === "foregroundEnter") {
      paused = false;
      rebuildWanted = true;
      void draw();
      startPoll();
      return;
    }
    if (isFinalExit(step)) { shutDown(); return; }
    const menuId = menuItemIdFromEvent(event);
    if (menuId !== null) {
      // QIS v1.2 #1: Hilfe from the side menu; it lies on top of whatever is shown (a running recording goes on).
      if (menuId === MENU.help && !rec) {
        disarm();
        patch({ help: true });
        void draw();
      }
      return;
    }
    const audio = (event as { audioEvent?: { audioPcm?: unknown } }).audioEvent;
    if (audio) {
      const current = rec;
      if (!current || current.phase !== "listening") return;
      const pcm = toPcm(audio.audioPcm);
      if (pcm.length === 0) return;
      if (current.bytes + pcm.length > MAX_PCM_BYTES) { background(stopRec(), "stopping the microphone"); return; }
      current.chunks.push(pcm);
      current.bytes += pcm.length;
      current.live?.send(pcm);
      return;
    }

    const parsed = gestureFromEvent(event, { invertScroll: settings.invertScroll });
    if (!parsed) return;
    const gesture = parsed.gesture;

    // A gesture means the app is on the glasses again, even if no "foreground" came first. A 2x still asks to leave:
    // swallowing it after "No" left the dialog closed (store review); the ask waits for this restore draw.
    if (paused) {
      paused = false;
      rebuildWanted = true;
      const run = draw().catch(() => undefined);
      restoring = run;
      void run.then(() => { if (restoring === run) restoring = null; });
      startPoll();
      if (gesture !== "doubleClick") return;
    }

    if (rec) {
      if (gesture === "doubleClick") cancelRec(true);
      else if (rec.phase !== "sending" && (gesture === "click" || gesture === "longPressRelease")) background(stopRec(), "stopping the microphone");
      void draw();
      return;
    }
    // With recognised text waiting, a hold does nothing: it is sent (tap) or discarded (2x) first.
    if (gesture === "longPress") { if (!draft) background(startRec(), "starting the microphone"); return; }
    const mapped = hudGesture(gesture);
    if (mapped) perform(decide(model, mapped));
  });

  // The page does not survive a disconnect; the last view is forgotten too,
  // or an unchanged view would skip the rebuild and leave the display blank.
  bridge.onDeviceStatusChanged((status) => {
    if (status?.connectType === "connected" && !closed) {
      rebuildWanted = true;
      void draw();
    }
  });

  void draw();
  startPoll();

  // The clock in the header and the face (blinks, writes, listens): redraw twice a
  // second. An unchanged view and an unchanged face cost nothing (see drawOnce).
  const clockTimer = setInterval(() => { if (!closed) void draw(); else clearInterval(clockTimer); }, MASCOT_STEP_MS);

  const phone = mountPhoneUi({
    getSettings: () => settings,
    saveSettings: async (next) => {
      await saveSettings(bridge, next);
      const changed = next.serverUrl !== settings.serverUrl || next.token !== settings.token;
      settings = next;
      if (changed) {
        cancelRec(false);
        api = makeApi();
        closeVoice();
        disarm();
        draft = null;
        problemDetail = "";
        model = { ...EMPTY_MODEL, configured: api !== null };
        startPoll();
      }
      await draw();
    },
    connection: (): ConnectionState => {
      if (DEMO) return { kind: "demo" };
      if (!api) return { kind: "none" };
      // The phone may show the technical detail (HTTP status); the glasses never do (QIS v1.2 #8).
      if (model.problem) return { kind: "error", reason: problemDetail ? `${model.problem} (${problemDetail})` : model.problem };
      return model.feed ? { kind: "ok" } : { kind: "loading" };
    },
    locale: () => locale,
    onLocaleChange: (next) => {
      locale = next;
      rememberLocale(bridge, next);
      void draw();
    },
  });
  refreshPhone = phone.refresh;
}

void boot().catch((error: unknown) => {
  console.error("[xaventrahud] failed to start:", error);
});
