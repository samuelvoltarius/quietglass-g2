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
import { buildView, MODE_PRESETS, type CaptionView, type SummaryState } from "./glasses/view";
import { sameView } from "./glasses/diff";
import { createPage, updateIcon, updatePage } from "./glasses/render";
import { iconFrame, ICON_STEP_MS, type IconKind } from "./glasses/icon";
import {
  companionConfigured, load, save, translationEnabled, usesMockStt, type BabelData,
} from "./storage/persist";
import { mountPhoneUi, renderConversation, type ConversationState } from "./ui/phone";
import { appendEntry, attachTranslation, type TranscriptEntry } from "./companion/transcript";
import { createCompanionLlm, createMockCompanion, type CompanionLlm, type Insight } from "./companion/llm";
import { createInsightWatcher } from "./companion/insights";
import { createExitRequest } from "./exit";
import { rememberLocale, resolveLocale, type Locale } from "./i18n";

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
    });

  let iconBusy = false;
  const drawIcon = async (): Promise<void> => {
    if (closed || !pageReady || iconBusy) return;
    iconBusy = true;
    try { await updateIcon(bridge, iconFrame(iconKind(), Date.now())); } finally { iconBusy = false; }
  };

  const draw = async (): Promise<void> => {
    if (closed) return;
    if (popup && popup.until <= Date.now()) popup = null;
    const view = currentView();
    if (sameView(lastView, view)) { void drawIcon(); return; }

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
      await stt.stop();
      await opening;
      stt = null;
      return;
    }
    listening = true;
    await draw();
  };

  /** `withSummary`: the user stopped on purpose (tap), so the conversation may be summarised. */
  const stopListening = async (withSummary = false): Promise<void> => {
    if (!listening) return;
    await bridge.audioControl(false).catch(() => undefined);
    await stt?.stop();
    stt = null;
    listening = false;
    status = "idle";
    popup = null;
    watcher.stop();
    // A provisional line nobody will finish is dropped, not kept as history.
    if (buffer.pending) buffer = { ...buffer, pending: null };
    schedulePhone();
    if (withSummary && data.autoSummary && log.length >= 2 && companion()) {
      void summarize();
      return;
    }
    await draw();
  };

  const requestExit = createExitRequest(bridge, {
    onConfirmed: () => { closed = true; resumeListening = false; },
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

  await draw();

  bridge.onEvenHubEvent((event) => {
    if (closed) return;
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
      case "longPress":
        clearConversation();
        return;
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
      pageReady = false;
      void draw();
    }
  });

  // Header clock, ear animation and popup timeout.
  const ticker = setInterval(() => {
    if (closed) { clearInterval(ticker); return; }
    void draw();
  }, ICON_STEP_MS);

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
