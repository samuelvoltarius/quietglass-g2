import {
  AudioInputSource, waitForEvenAppBridge, type EvenAppBridge,
} from "@evenrealities/even_hub_sdk";
import {
  createMockStt, createWebSocketStt, type SttProvider, type SttStatus, type Transcript,
} from "./stt/provider";
import { createPassthroughTranslator, type TranslationProvider } from "./translate/provider";
import { selectTranslator, translationRequestFor } from "./translate/select";
import {
  applyTranscript, applyTranslation, clearBuffer, createBuffer, type CaptionBuffer,
} from "./captions/buffer";
import { gestureFromEvent } from "./input/gestures";
import { buildView, MODE_PRESETS, type CaptionView, type MicNotice, type SummaryState } from "./glasses/view";
import { sameView } from "./glasses/diff";
import { createPage, updateIcon, updatePage } from "./glasses/render";
import { iconFrame, ICON_STEP_MS, type IconKind } from "./glasses/icon";
import {
  companionConfigured, load, loadConversation, save, saveConversation, translationEnabled, usesMockStt,
  type BabelData,
} from "./storage/persist";
import { mountPhoneUi, renderConversation, type ConversationState } from "./ui/phone";
import { appendEntry, attachTranslation, type TranscriptEntry } from "./companion/transcript";
import { createCompanionLlm, createMockCompanion, type CompanionLlm, type Insight } from "./companion/llm";
import { createInsightWatcher } from "./companion/insights";
import { createExitRequest } from "./exit";
import { rememberLocale, resolveLocale, type Locale } from "./i18n";
import { isFinalExit, lifecycleFromEvent } from "./lifecycle";
import { activeConfirm, CONFIRM_WINDOW_MS, confirmStep, type PendingConfirm } from "./input/confirm";

/** The microphone goes off when the speech server stays away this long. */
export const NO_SERVER_MS = 60_000;
/** And in any case after this long: nobody should be listened to by an app left running. */
export const MAX_LISTEN_MS = 90 * 60_000;

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


  let data: BabelData = await load(bridge);
  /** UI language of glasses and phone; independent of the caption languages. */
  let locale: Locale = await resolveLocale(bridge);
  let buffer: CaptionBuffer = createBuffer();
  let stt: SttProvider | null = null;
  let translator: TranslationProvider = createPassthroughTranslator();
  let status: SttStatus = "idle";
  let listening = false;
  let offset = 0;
  let lastView: CaptionView | null = null;
  let pageReady = false;
  /** Set by a reconnect or a return to the foreground: the next draw rebuilds the page. */
  let rebuildWanted = false;
  /** In the background: the microphone is off and nothing is drawn. */
  let paused = false;
  let drawing: Promise<void> | null = null;
  let drawAgain = false;
  /** Why the microphone is off although it was wanted on; cleared by the next tap. */
  let notice: MicNotice | null = null;
  /** A hold that would clear the transcript waits here for its second hold. */
  let pendingClear: PendingConfirm<"clear"> | null = null;
  let confirmTimer: ReturnType<typeof setTimeout> | undefined;
  /** When the microphone opened, and since when the server has been missing. */
  let listeningSince = 0;
  let serverMissingSince: number | null = null;
  let translateError: string | null = null;
  /** Set once the user confirmed the exit dialog: nothing draws or listens again. */
  let closed = false;
  /** Captions were running when the exit dialog opened; cancel turns them back on. */
  let resumeListening = false;

  // ---- Conversation companion (0.3.0) ----
  /** Every final line of this conversation (memory only). */
  let log: TranscriptEntry[] = [];
  let summary: (SummaryState & { readonly long?: readonly string[] }) | null = null;
  /** Bumped on clear/new summary: answers for an older request are dropped. */
  let summaryRun = 0;
  let insights: Insight[] = [];
  let popup: (Insight & { readonly until: number }) | null = null;

  // "Keep the last transcript" (opt-in): what was said survives the phone lock.
  if (data.keepTranscript) {
    const kept = await loadConversation(bridge).catch(() => null);
    if (kept) {
      log = [...kept.log];
      if (kept.summary) summary = { state: "done", short: kept.summary.short, long: kept.summary.long };
    }
  }
  let keepTimer: ReturnType<typeof setTimeout> | undefined;
  /** Stores the conversation now (opt-in only); `soon` collects a burst of lines into one write. */
  const keepConversation = (soon = false): void => {
    clearTimeout(keepTimer);
    if (!data.keepTranscript) return;
    const write = (): void => {
      keepTimer = undefined;
      const done = summary?.state === "done" ? { short: summary.short, long: summary.long ?? summary.short } : null;
      void saveConversation(bridge, { log, summary: done }).catch((error: unknown) => { console.warn("[babelglass] keep failed:", error); });
    };
    if (soon) keepTimer = setTimeout(write, 5000);
    else write();
  };

  let companionCache: { key: string; llm: CompanionLlm } | null = null;
  /** The language model for summary and popups; the demo one only next to the demo recogniser. */
  const companion = (): CompanionLlm | null => {
    if (companionConfigured(data)) {
      const key = data.llmUrl + "|" + data.llmModel + "|" + (data.llmKey ?? "");
      if (companionCache?.key !== key) {
        companionCache = {
          key,
          llm: createCompanionLlm({ url: data.llmUrl, model: data.llmModel, ...(data.llmKey ? { apiKey: data.llmKey } : {}) }),
        };
      }
      return companionCache.llm;
    }
    return usesMockStt(data) ? createMockCompanion() : null;
  };

  const POPUP_MS = 15_000;
  const watcher = createInsightWatcher({
    llm: () => (data.insights ? companion() : null),
    locale: () => locale,
    onInsight: (insight) => {
      insights = [...insights, insight].slice(-50);
      if (listening && data.insights) popup = { ...insight, until: Date.now() + POPUP_MS };
      void draw();
      schedulePhone();
    },
    onError: (error) => { console.warn("[babelglass] explain failed:", error); },
  });

  const conversationState = (): ConversationState => ({
    log,
    pending: buffer.pending?.text ?? null,
    summary: summary === null ? null
      : summary.state === "done" ? { state: "done", long: summary.long ?? summary.short }
      : summary,
    insights,
    canSummarize: companion() !== null,
  });

  let phoneTimer: ReturnType<typeof setTimeout> | undefined;
  /** The phone page follows the conversation at most every 250 ms. */
  const schedulePhone = (): void => {
    if (phoneTimer !== undefined) return;
    phoneTimer = setTimeout(() => {
      phoneTimer = undefined;
      const root = globalThis.document?.getElementById?.("app");
      if (root) renderConversation(root, conversationState(), locale);
    }, 250);
  };

  const summarize = async (): Promise<void> => {
    const llm = companion();
    if (!llm || log.length === 0) return;
    const run = ++summaryRun;
    summary = { state: "working" };
    void draw();
    schedulePhone();
    const result = await llm.summarize(log, locale).catch(() => ({ ok: false as const, error: "failed" }));
    if (run !== summaryRun) return;
    summary = result.ok
      ? { state: "done", short: result.value.short, long: result.value.long }
      : { state: "error", error: result.error };
    keepConversation();
    void draw();
    schedulePhone();
  };

  const clearConversation = (): void => {
    buffer = clearBuffer();
    offset = 0;
    log = [];
    insights = [];
    popup = null;
    summary = null;
    summaryRun++;
    watcher.reset();
    pendingClear = null;
    // The stored copy goes too, whatever the switch says now.
    clearTimeout(keepTimer);
    void saveConversation(bridge, null).catch(() => undefined);
    void draw();
    schedulePhone();
  };

  const iconKind = (): IconKind => {
    if (listening) return popup ? "info" : "listening";
    if (summary?.state === "working") return "thinking";
    if (summary?.state === "done") return "done";
    return "off";
  };

  const currentView = (): CaptionView =>
    buildView(buffer, {
      mode: data.mode,
      listening,
      status,
      translating: translationEnabled(data),
      offset,
      mock: usesMockStt(data),
      transliterateOriginal: data.transliterateOriginal,
      sourceLanguage: data.sourceLanguage,
      translateError,
      locale,
      speakers: data.speakers,
      now: Date.now(),
      popup: popup && popup.until > Date.now() ? popup : null,
      summary: summary && summary.state === "done" ? { state: "done", short: summary.short } : summary,
      notice,
      confirmClear: activeConfirm(pendingClear, Date.now()) !== null,
    });

  let iconBusy = false;
  const drawIcon = async (): Promise<void> => {
    if (closed || !pageReady || iconBusy) return;
    iconBusy = true;
    try { await updateIcon(bridge, iconFrame(iconKind(), Date.now())); } finally { iconBusy = false; }
  };

  const drawOnce = async (): Promise<void> => {
    if (closed || paused) return;
    if (popup && popup.until <= Date.now()) popup = null;
    // After a reconnect or a return to the foreground the page is rebuilt even
    // when the text did not change: it was lost, and an unchanged view used to
    // skip the rebuild and leave the glasses blank.
    if (rebuildWanted) { rebuildWanted = false; pageReady = false; lastView = null; }
    const view = currentView();
    if (pageReady && sameView(lastView, view)) { void drawIcon(); return; }

    const result = pageReady ? await updatePage(bridge, view) : await createPage(bridge, view);
    if (result.ok) {
      pageReady = true;
      lastView = view;
      void drawIcon();
      return;
    }
    pageReady = false;
    console.warn("[babelglass] draw failed:", result.reason);
  };

  /**
   * One page write at a time: the ticker, captions, gestures and the phone
   * all ask for redraws, and two overlapping first draws would create the
   * start-up page twice (which leaves real glasses deaf).
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

  const buildTranslator = (): TranslationProvider => selectTranslator(data);

  const translateLine = (text: string, detected: string | undefined): void => {
    if (!translationEnabled(data)) return;
    const request = translationRequestFor(data, translator, text, detected);
    // Already in the target language: nothing to translate, show as is.
    if (!request) return;
    void translator.translate(request).then((result) => {
      if (result.error) {
        translateError = result.error;
        console.warn("[babelglass] translation failed:", result.error);
        void draw();
        return;
      }
      translateError = null;
      if (result.text) {
        buffer = applyTranslation(buffer, text, result.text);
        log = attachTranslation(log, text, result.text.normalize("NFC"));
        schedulePhone();
      }
      void draw();
    });
  };

  const onTranscript = (transcript: Transcript): void => {
    const now = Date.now();
    buffer = applyTranscript(buffer, transcript, now);
    // New speech pulls the view back to the live edge; reading history while
    // someone is talking is not what the user meant to do.
    if (transcript.final) {
      offset = 0;
      const text = transcript.text.trim();
      if (text) {
        log = appendEntry(log, {
          text, at: now,
          ...(transcript.language ? { language: transcript.language } : {}),
          ...(data.speakers && transcript.speaker ? { speaker: transcript.speaker } : {}),
        });
        if (data.insights) watcher.onFinal(log);
        keepConversation(true);
      }
      translateLine(text, transcript.language);
    }
    schedulePhone();
    void draw();
  };

  /**
   * Captioning never starts on its own: the microphone opens only after an
   * explicit tap, and MIC stays on screen for as long as it is open.
   */
  const startListening = async (): Promise<void> => {
    if (listening || closed) return;

    translator = buildTranslator();
    translateError = null;
    stt = usesMockStt(data)
      ? createMockStt({ onTranscript, onStatus: (s) => { status = s; void draw(); }, locale: () => locale })
      : createWebSocketStt({
          url: data.sttUrl,
          ...(data.sttToken ? { token: data.sttToken } : {}),
          language: data.sourceLanguage,
          // Partial lines + speaker labels; servers without it ignore the flag.
          stream: true,
          onTranscript,
          onStatus: (s) => { status = s; void draw(); },
        });

    // The microphone must not wait for the server: a recogniser that is slow or
    // unreachable used to keep the mic closed (looking like "no microphone").
    // The connection comes up in the background and shows its own status.
    const opening = stt.start().catch((error: unknown) => { console.warn("[babelglass] stt start failed:", error); });

    const ok = await bridge.audioControl(true, AudioInputSource.Glasses).catch(() => false);
    if (!ok) {
      console.warn("[babelglass] microphone was refused");
      await stt.stop().catch(() => undefined);
      await opening;
      stt = null;
      // Said on the glasses: a refused microphone used to look like an ignored tap.
      notice = { kind: "micDenied" };
      await draw();
      return;
    }
    if (closed || paused) {
      // Left while the microphone was opening: close it again at once.
      await bridge.audioControl(false).catch(() => undefined);
      await stt.stop().catch(() => undefined);
      stt = null;
      return;
    }
    listening = true;
    listeningSince = Date.now();
    serverMissingSince = null;
    await draw();
  };

  /** `withSummary`: the user stopped on purpose (tap), so the conversation may be summarised. */
  const stopListening = async (withSummary = false): Promise<void> => {
    if (!listening) return;
    // Off first and for sure: a recogniser that throws on stop must not leave
    // the app believing it still listens.
    listening = false;
    await bridge.audioControl(false).catch(() => undefined);
    const closing = stt;
    stt = null;
    await closing?.stop().catch((error: unknown) => { console.warn("[babelglass] stt stop failed:", error); });
    status = "idle";
    popup = null;
    watcher.stop();
    // A provisional line nobody will finish is dropped, not kept as history.
    if (buffer.pending) buffer = { ...buffer, pending: null };
    keepConversation();
    schedulePhone();
    if (withSummary && data.autoSummary && log.length >= 2 && companion()) {
      void summarize();
      return;
    }
    await draw();
  };

  /**
   * Watches the open microphone: off after a minute without a server (the
   * recogniser would otherwise retry for ever with the mic open) and in any
   * case after MAX_LISTEN_MS. The glasses say why.
   */
  const guardMicrophone = (now: number): void => {
    if (!listening || closed) return;
    if (status === "ready") serverMissingSince = null;
    else if (serverMissingSince === null) serverMissingSince = now;
    const reason: MicNotice | null = serverMissingSince !== null && now - serverMissingSince >= NO_SERVER_MS
      ? { kind: "noServer" }
      : now - listeningSince >= MAX_LISTEN_MS ? { kind: "micLimit", minutes: Math.round(MAX_LISTEN_MS / 60_000) } : null;
    if (reason === null) return;
    void stopListening().then(() => { notice = reason; return draw(); });
  };

  /** Everything off for good: after the exit dialog, a system exit or a crash. */
  const shutDown = (): void => {
    closed = true;
    resumeListening = false;
    clearTimeout(confirmTimer);
    if (listening || stt) {
      listening = false;
      void bridge.audioControl(false).catch(() => undefined);
      void stt?.stop().catch(() => undefined);
      stt = null;
    }
    watcher.stop();
    keepConversation();
  };

  const requestExit = createExitRequest(bridge, {
    onConfirmed: () => { shutDown(); },
    onStayed: async () => {
      if (!resumeListening) return;
      resumeListening = false;
      await startListening();
    },
  }, "babelglass");

  /**
   * The microphone closes before the system exit dialog appears, so nobody is
   * listened to while the user decides. Cancelling reopens it.
   */
  const exitWithDialog = async (): Promise<void> => {
    if (listening) {
      resumeListening = true;
      await stopListening().catch((error: unknown) => { console.warn("[babelglass] stop failed:", error); });
    }
    await requestExit();
  };

  bridge.onEvenHubEvent((event) => {
    if (closed) return;
    const step = lifecycleFromEvent(event);
    if (step === "foregroundExit") {
      // Out of sight: the microphone closes (it reopens only on a tap) and
      // the conversation is stored if the user asked for that.
      paused = true;
      pendingClear = null;
      void stopListening().catch(() => undefined);
      keepConversation();
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
    const pcm = audio?.audioPcm;
    const bytes = listening ? toBytes(pcm) : null;
    if (bytes && bytes.length > 0) {
      stt?.send(bytes);
      return;
    }

    const gesture = gestureFromEvent(event, { invertScroll: data.invertScroll });
    if (!gesture) return;

    const rows = MODE_PRESETS[data.mode].rows;

    switch (gesture.gesture) {
      case "click":
        pendingClear = null;
        notice = null;
        // A tap first closes an explanation; otherwise it starts/stops listening.
        if (popup) { popup = null; break; }
        if (listening) { void stopListening(true); return; }
        if (summary?.state !== "working") summary = null;
        void startListening();
        return;
      case "scrollUp":
        offset = Math.min(offset + rows, 200);
        break;
      case "scrollDown":
        offset = Math.max(0, offset - rows);
        break;
      case "longPress": {
        // Clearing the transcript takes a second hold within a few seconds.
        const confirmClear = confirmStep(pendingClear, "clear", Date.now());
        pendingClear = confirmClear.pending;
        clearTimeout(confirmTimer);
        if (confirmClear.confirmed) { clearConversation(); return; }
        confirmTimer = setTimeout(() => { pendingClear = null; void draw(); }, CONFIRM_WINDOW_MS + 50);
        break;
      }
      case "doubleClick":
        void exitWithDialog();
        return;
      default:
        return;
    }
    void draw();
  });

  bridge.onDeviceStatusChanged((deviceStatus) => {
    if (deviceStatus?.connectType === "connected" && !closed) {
      rebuildWanted = true;
      void draw();
    }
  });

  // Header clock, ear animation, popup timeout and the microphone guard.
  const ticker = setInterval(() => {
    if (closed) { clearInterval(ticker); return; }
    guardMicrophone(Date.now());
    void draw();
  }, ICON_STEP_MS);

  // The first page only now, with the gestures wired.
  void draw();

  mountPhoneUi({
    getConversation: conversationState,
    onSummarize: () => { void summarize(); },
    onClearTranscript: clearConversation,
    getLocale: () => locale,
    setLocale: (next) => {
      locale = next;
      rememberLocale(bridge, next);
      // The glasses follow at once, not with the next caption.
      void draw();
    },
    getData: () => data,
    setData: async (next) => {
      const previous = data;
      data = next;
      await save(bridge, next);
      // Switched off: the stored copy goes; switched on: the current one is kept.
      if (previous.keepTranscript && !next.keepTranscript) void saveConversation(bridge, null).catch(() => undefined);
      if (!previous.keepTranscript && next.keepTranscript) keepConversation();
      translator = buildTranslator();
      translateError = null;
      // The recogniser receives its language once, in the start frame, so a
      // changed server or language only takes effect on a fresh connection.
      if (listening && sttSettingsChanged(previous, next)) {
        await stopListening();
        await startListening();
        return;
      }
      await draw();
    },
  });
}

function sttSettingsChanged(a: BabelData, b: BabelData): boolean {
  return a.sttUrl !== b.sttUrl || a.sttToken !== b.sttToken || a.sourceLanguage !== b.sourceLanguage;
}

void boot().catch((error: unknown) => {
  console.error("[babelglass] failed to start:", error);
});
