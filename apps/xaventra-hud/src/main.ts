import { AudioInputSource, waitForEvenAppBridge, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { ApiError, createClient, type XaventraApi } from "./api/client";
import { createDemoApi } from "./api/demo";
import type { HudCard, HudFeed, VoiceResult } from "./api/types";
import { getLocale, type Locale } from "./i18n";
import { gestureFromEvent, type Gesture } from "./input/gestures";
import { errorText } from "./hud/errors";
import { t } from "./messages";
import { sameView } from "./glasses/diff";
import { createPage, updatePage } from "./glasses/render";
import type { ScreenView } from "./glasses/screen";
import { CONFIRM_MS, EMPTY_MODEL, buildView, currentCard, decide, type HudAction, type HudGesture, type HudModel } from "./hud/model";
import { loadSettings, saveSettings, type Settings } from "./storage/persist";
import { mountPhoneUi, type ConnectionState } from "./ui/phone";
import { concat, pcmToWav, toPcm } from "./voice/wav";

const DEMO = new URLSearchParams(globalThis.location?.search ?? "").get("demo") === "1";

/** Voice is short; the microphone never stays on longer than this. */
const MAX_RECORD_MS = 15_000;
/** 16 kHz × 2 bytes × 16 s — anything beyond is dropped, never buffered. */
const MAX_PCM_BYTES = 16_000 * 2 * 16;
/** Shorter than this is a slip of the finger, not a sentence. */
const MIN_PCM_BYTES = 16_000 * 2 / 2;
/** A feedback line stays this long. */
const MESSAGE_MS = 6_000;
/** A voice reply closes by itself after this. */
const VOICE_PANEL_MS = 30_000;
const RETRY_MS = 5_000;
const RETRY_AUTH_MS = 10_000;

interface Recording {
  readonly id: number;
  phase: "opening" | "listening" | "sending";
  stopRequested: boolean;
  chunks: Uint8Array[];
  bytes: number;
  timer?: ReturnType<typeof setTimeout>;
}

async function boot(): Promise<void> {
  const bridge: EvenAppBridge = await waitForEvenAppBridge();

  let settings: Settings = await loadSettings(bridge);
  let locale: Locale = getLocale();
  let closed = false;

  const makeApi = (): XaventraApi | null => {
    if (DEMO) return createDemoApi(locale);
    if (!settings.serverUrl) return null;
    return createClient({ baseUrl: settings.serverUrl, ...(settings.token ? { token: settings.token } : {}) });
  };
  let api: XaventraApi | null = makeApi();

  let model: HudModel = { ...EMPTY_MODEL, configured: api !== null };
  const patch = (change: Partial<HudModel>): void => { model = { ...model, ...change }; };

  const background = (task: Promise<unknown>, what: string): void => {
    task.catch((error: unknown) => { console.warn("[xaventrahud] " + what + " failed:", error); });
  };

  // ---- drawing -----------------------------------------------------------
  let lastView: ScreenView | null = null;
  let pageReady = false;
  let drawing: Promise<void> | null = null;
  let redrawQueued = false;
  let refreshPhone: () => void = () => undefined;

  const drawOnce = async (): Promise<void> => {
    const view = buildView(model, locale, new Date());
    if (sameView(lastView, view)) return;
    const result = pageReady ? await updatePage(bridge, view) : await createPage(bridge, view);
    if (result.ok) { pageReady = true; lastView = view; return; }
    pageReady = false;
    lastView = null;
    console.warn("[xaventrahud] draw failed:", result.reason);
  };

  /** One draw at a time; requests made meanwhile collapse into one redraw. */
  const draw = (): Promise<void> => {
    refreshPhone();
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
          patch({
            feed, online: true, problem: "",
            index: Math.min(model.index, Math.max(0, cards.length - 1)),
            ...(confirmGone ? { confirm: null } : {}),
          });
          await draw();
        } catch (error) {
          if (generation !== pollGeneration || closed) return;
          patch({ online: false, problem: errorText(locale, error) });
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
      patch({ feed: withoutCard(model.feed, card.id), index: 0 });
      say(result.message || t(locale, "g.msg.done"));
    } catch (error) {
      if (closed) return;
      // The card is gone on the server (answered, expired, unknown): drop it here too.
      if (error instanceof ApiError && [404, 409, 410].includes(error.status)) patch({ feed: withoutCard(model.feed, card.id), index: 0 });
      say(t(locale, "g.msg.answerFail", { reason: errorText(locale, error) }));
    } finally {
      answering = false;
    }
    await draw();
  };

  // ---- microphone --------------------------------------------------------
  let rec: Recording | null = null;
  let recIds = 0;
  const micOff = (): Promise<void> => bridge.audioControl(false).then(() => undefined, () => undefined);

  const startRec = async (): Promise<void> => {
    if (rec || closed || answering) return;
    if (!api) { say(t(locale, "g.setup1")); await draw(); return; }
    const current: Recording = { id: ++recIds, phase: "opening", stopRequested: false, chunks: [], bytes: 0 };
    rec = current;
    clearTimeout(voiceTimer);
    patch({ rec: "opening", voice: null, message: "" });
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
    patch({ rec: "listening" });
    current.timer = setTimeout(() => { background(stopRec(), "stopping the microphone"); }, MAX_RECORD_MS);
    await draw();
    if (current.stopRequested) await stopRec();
  };

  const applyVoice = (result: VoiceResult): void => {
    const card = model.feed?.cards.find((entry) => entry.id === result.cardId) ?? null;
    switch (result.action) {
      case "answered_ja":
      case "answered_nein":
        patch({ feed: withoutCard(model.feed, result.cardId), index: 0 });
        say(result.reply || t(locale, "g.msg.done"));
        return;
      case "needs_confirm":
        // Speech never confirms an action that acts outside: the explicit tap does.
        if (!card || !model.feed) { say(t(locale, "g.msg.unclear")); return; }
        patch({ index: model.feed.cards.indexOf(card) });
        arm(card.id);
        say(t(locale, "g.msg.heardYes"));
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
      if (rec === current) { rec = null; patch({ rec: "off" }); say(t(locale, "g.msg.nothing")); }
      await draw();
      return;
    }
    let result: VoiceResult | null = null;
    let failed = "";
    try {
      result = await client.voice(pcmToWav(pcm), currentCard(model)?.id);
    } catch (error) {
      failed = errorText(locale, error);
    }
    // Cancelled or closed while the server was listening.
    if (rec !== current || closed) return;
    rec = null;
    patch({ rec: "off" });
    if (failed) say(t(locale, "g.msg.voiceFail", { reason: failed }));
    else if (result) applyVoice(result);
    await draw();
  };

  const cancelRec = (announce: boolean): void => {
    const current = rec;
    if (!current) return;
    rec = null;
    clearTimeout(current.timer);
    current.chunks = [];
    patch({ rec: "off" });
    if (current.phase !== "sending") background(micOff(), "stopping the microphone");
    if (announce) say(t(locale, "g.msg.cancelled"));
  };

  // ---- leaving -----------------------------------------------------------
  /**
   * Leaving asks the system first (exit mode 1). Until the system confirms,
   * the app keeps running: the user may still cancel.
   */
  const requestExit = (): void => {
    bridge.shutDownPageContainer(1).then(
      (left) => { if (left === true) shutDown(); },
      (error: unknown) => { console.warn("[xaventrahud] exit failed:", error); },
    );
  };

  const shutDown = (): void => {
    if (closed) return;
    cancelRec(false);
    closed = true;
    stopPoll();
    clearTimeout(messageTimer);
    clearTimeout(confirmTimer);
    clearTimeout(voiceTimer);
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
        patch({ index: action.index });
        void draw();
        return;
      case "dismiss":
        closeVoice();
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

  await draw();
  startPoll();

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

    if (rec) {
      if (gesture === "doubleClick") cancelRec(true);
      else if (rec.phase !== "sending" && (gesture === "click" || gesture === "longPressRelease")) background(stopRec(), "stopping the microphone");
      void draw();
      return;
    }
    if (gesture === "longPress") { background(startRec(), "starting the microphone"); return; }
    const mapped = hudGesture(gesture);
    if (mapped) perform(decide(model, mapped));
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

  // The clock in the header: redraw once a minute (an unchanged view is skipped).
  const clockTimer = setInterval(() => { if (!closed) void draw(); else clearInterval(clockTimer); }, 30_000);

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
        model = { ...EMPTY_MODEL, configured: api !== null };
        startPoll();
      }
      await draw();
    },
    connection: (): ConnectionState => {
      if (DEMO) return { kind: "demo" };
      if (!api) return { kind: "none" };
      if (model.problem) return { kind: "error", reason: model.problem };
      return model.feed ? { kind: "ok" } : { kind: "loading" };
    },
    locale: () => locale,
    onLocaleChange: (next) => {
      locale = next;
      void draw();
    },
  });
  refreshPhone = phone.refresh;
}

void boot().catch((error: unknown) => {
  console.error("[xaventrahud] failed to start:", error);
});
