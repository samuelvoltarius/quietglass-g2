import {
  AudioInputSource, waitForEvenAppBridge, type EvenAppBridge,
} from "@evenrealities/even_hub_sdk";
import {
  createMockStt, createWebSocketStt, type SttProvider, type SttStatus, type Transcript,
} from "./stt/provider";
import { createPassthroughTranslator, type TranslationProvider } from "./translate/provider";
import { selectTranslator, translationRequestFor } from "./translate/select";
import {
  applyTranscript, applyTranslation, clearBuffer, createBuffer, dropTranslation, wrap, type CaptionBuffer,
} from "./captions/buffer";
import { gestureFromEvent, menuItemIdFromEvent } from "./input/gestures";
import {
  buildView, BODY_ROWS, MODE_PRESETS, POPUP_WIDTH, sheetNext, summaryPageCount, type CaptionView, type MicNotice, type SummaryState, type ViewPopup,
} from "./glasses/view";
import { createThrottle } from "./glasses/throttle";
import { sameView } from "./glasses/diff";
import { createPage, updateIcon, updatePage, type MenuSpec } from "./glasses/render";
import { iconFrame, ICON_STEP_MS, type IconKind } from "./glasses/icon";
import {
  companionConfigured, load, loadConversation, save, saveConversation, translationEnabled, usesMockStt,
  type BabelData,
} from "./storage/persist";
import { mountPhoneUi, renderConversation, type ConversationState, type PhoneInsight } from "./ui/phone";
import { annotateEntry, appendEntry, attachTranslation, type TranscriptEntry } from "./companion/transcript";
import { createCompanionLlm, createMockCompanion, type CompanionLlm } from "./companion/llm";
import { createInsightWatcher } from "./companion/insights";
import {
  conversationLanguage, findWord, resolveSpeaker, wordContext, wordPopupLines, WORD_TIMEOUT_MS,
} from "./companion/wordfinder";
import { createMemoryClient, memoryNotes, memoryQuery, type MemoryClient } from "./companion/memory";
import {
  createReplyWatcher, foreignLanguage, lineOwner, replyContext, suggestReply, type ReplyLanguage, type ReplySuggestion,
} from "./companion/replies";
import { isOwnLine, lastOwnLine, OWN_MARK, ownTranslationRequest, type OwnContext } from "./companion/own";
import {
  advancePopups, closePopup, dropKind, emptySlot, offerPopup, POPUP_RANK, visiblePopup, type PopupKind, type PopupSlot,
} from "./companion/popups";
import { activeHelpers, helpLine, helperRows, type MemoryStatus, type OverviewInput } from "./companion/overview";
import { sameLanguage } from "./text/languages";
import { customerPhoneLine, customerRows, fetchCustomer, type CustomerContext } from "./companion/customer";
import {
  fetchCustomers, pickBody, pickRows, type CustomerEntry, type CustomerListState, type PickRow,
} from "./companion/customers";
import { setSessionCustomer } from "./llm/stream";
import { t } from "./messages";
import { effectiveTalkMode, modeData, replyTimingFor, talkModeKey, type TalkMode } from "./companion/talkmode";
import type { Summary } from "./companion/llm";
import { createExitRequest } from "./exit";
import { createCueWatcher, cueCardsOn, cueRows, cueSummaryBlock, cueTranscript, CUE_POPUP_MS, fetchCue, keepCue, type CueCard } from "./companion/cues";
import { rememberLocale, resolveLocale, type Locale } from "./i18n";
import { isFinalExit, lifecycleFromEvent } from "./lifecycle";
import { activeConfirm, CONFIRM_WINDOW_MS, type PendingConfirm } from "./input/confirm";
import { menuArmedKind, menuClickStep, SIDE_MENU, type MenuArmed } from "./input/menu-confirm";
import type { MenuRow } from "./companion/customers";
import {
  createVoiceEnrollment, ENROLL_MS, nextPersons, othersFor, voiceCommand, type VoiceEnrollment, type VoiceReply,
} from "./stt/voice";
import { voiceSheetCancels, voiceSheetRows, type VoiceSheet } from "./companion/myvoice";

/** The microphone goes off when the speech server stays away this long. */
export const NO_SERVER_MS = 60_000;
/** And in any case after this long: nobody should be listened to by an app left running. */
export const MAX_LISTEN_MS = 90 * 60_000;

/**
 * 0.7.0: the glasses' side menu (hold -> the system menu next to Close and
 * Brightness). Help, overview, mode and customer live here, never on swipes.
 */
export { SIDE_MENU };
export const MENU = { help: 1, overview: 2, mode: 3, pick: 4, info: 5, voice: 6, voiceDelete: 7, persons: 8 } as const;

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
  /**
   * QIS v1 arm-and-confirm: a tap that would stop the captions waits here for a second single tap within CONFIRM_WINDOW_MS. Anything else cancels it.
   */
  let pending: PendingConfirm<"stop"> | null = null;
  let confirmTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * QIS v1.2 #3: a side-menu item waiting for its second click ("Meine Stimme löschen" always;
   * "Kunde wechseln", "Modus", "Personen" while captions run, because they restart them).
   */
  let menuPending: PendingConfirm<string> | null = null;
  let menuTimer: ReturnType<typeof setTimeout> | undefined;
  /** When the microphone opened, and since when the server has been missing. */
  let listeningSince = 0;
  let serverMissingSince: number | null = null;
  let translateError: string | null = null;
  /** Set once the user confirmed the exit dialog: nothing draws or listens again. */
  let closed = false;

  // ---- Conversation companion (0.3.0) ----
  /** Every final line of this conversation (memory only). */
  let log: TranscriptEntry[] = [];
  let summary: SummaryState | null = null;
  /** 0.7.0: the summary was put aside on the glasses (tap / 2x): the list shows, the stored summary stays. */
  let summaryHidden = false;
  const shownSummary = (): SummaryState | null => (summaryHidden ? null : summary);
  /** Page of a finished summary on the glasses (swipe). */
  let summaryPage = 0;
  /** Bumped on clear/new summary: answers for an older request are dropped. */
  let summaryRun = 0;
  let insights: PhoneInsight[] = [];
  /** One popup at a time: word finder / own sentence > reply suggestion > explanation (0.5.0). */
  let popups: PopupSlot<ViewPopup> = emptySlot();
  const popupNow = (): ViewPopup | null => visiblePopup(popups, Date.now())?.popup ?? null;
  const offer = (kind: PopupKind, popup: ViewPopup, ms: number): void => {
    popups = offerPopup(popups, kind, popup, ms, Date.now()).slot;
  };
  /** Help screen ("what runs when") page on the glasses; null = closed. */
  let help: number | null = null;
  /** 0.6.2: which paged popup `help` shows: the help/overview or the Shoot Day customer ("Kunde"). */
  let helpKind: "help" | "customer" | "voice" = "help";
  /** 0.8.0 "Meine Stimme": the sheet's step, the running enrollment, its timer, and whether the mic is open for it. */
  let voiceSheet: VoiceSheet | null = null;
  let enrollment: VoiceEnrollment | null = null;
  let enrollTimer: ReturnType<typeof setTimeout> | undefined;
  let enrollMic = false;
  /** Bumped on every new voice action or cancel: late answers of an older one are dropped. */
  let voiceRun = 0;
  /** 0.6.2: the customer Shoot Day reports through the proxy; null = none, unknown or unreachable. */
  let customer: CustomerContext | null = null;
  let customerRun = 0;
  /** 0.7.0: the start screen's customer list, its cursor, and the customer picked for this session. */
  let customerList: CustomerListState = { state: "off" };
  let cursor = 0;
  let sessionCustomer: CustomerEntry | null = null;
  let listRun = 0;
  /** Key of the side menu the page on the glasses carries; a different one needs a rebuild. */
  let pageMenuKey = "";
  /** 0.6.3: the mode in force (the user's pick, else Kundengespräch when Shoot Day reports a customer). */
  const talkMode = (): TalkMode => effectiveTalkMode(data, customer !== null);
  /** The settings as captions use them: Kundengespräch = source "de", no translation. */
  const md = (): BabelData => modeData(data, customer !== null);
  /** Babel's own memory as last seen, for the overview. */
  let memoryStatus: MemoryStatus = "unknown";
  /** A popup closed by a tap while it was still being written does not come back. */
  let dismissedTerm: string | null = null;

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
      const done = summary?.state === "done" ? { short: [...summary.short], long: [...(summary.long ?? summary.short)] } : null;
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

  let memoryCache: { key: string; client: MemoryClient } | null = null;
  /**
   * Babel's OWN memory on the babel-llm-proxy (0.4.0), next to the language
   * model. Nothing else is ever read or written. null = no model server set.
   */
  const memoryClient = (): MemoryClient | null => {
    if (!companionConfigured(data)) return null;
    const key = data.llmUrl + "|" + (data.llmKey ?? "");
    if (memoryCache?.key !== key) {
      memoryCache = { key, client: createMemoryClient({ url: data.llmUrl, timeoutMs: 4000, ...(data.llmKey ? { apiKey: data.llmKey } : {}) }) };
    }
    return memoryCache.client;
  };
  /** An older proxy without /memory is not asked again for a while. */
  let memoryDownUntil = 0;
  /** The conversation already stored (count + start), so a second summary does not store it twice. */
  let rememberedKey = "";
  const remember = (value: Summary): void => {
    const client = memoryClient();
    if (!client || !data.memory || log.length === 0) return;
    const key = log.length + ":" + (log[0]?.at ?? 0);
    if (key === rememberedKey) return;
    rememberedKey = key;
    void client.add({
      type: "session",
      date: new Date(log[0]?.at ?? Date.now()).toISOString(),
      title: value.short[0] ?? value.long[0] ?? "",
      summary: value.long.join("\n"),
      agreements: value.agreements ?? [],
    }).then((result) => {
      memoryStatus = result.ok ? "ok" : result.error === "unauthorized" ? "unauthorized" : "unavailable";
      if (!result.ok) console.warn("[babelglass] memory not stored:", result.error);
      schedulePhone();
    });
  };

  /** The top memory hits for these lines ("Notizen des Nutzers"), or "". */
  const memoryHits = async (recent: readonly TranscriptEntry[]): Promise<string> => {
    const client = memoryClient();
    if (!client || !data.memory || Date.now() < memoryDownUntil) return "";
    const result = await client.search(memoryQuery(recent), 3);
    if (!result.ok) {
      memoryDownUntil = Date.now() + 5 * 60_000;
      memoryStatus = result.error === "unauthorized" ? "unauthorized" : "unavailable";
      return "";
    }
    memoryStatus = "ok";
    return memoryNotes(result.value, locale);
  };

  /** One look at the memory, so the overview can say "verbunden" before the first search. */
  const probeMemory = (): void => {
    const client = memoryClient();
    if (!client || !data.memory) return;
    void client.list(1).then((result) => {
      memoryStatus = result.ok ? "ok" : result.error === "unauthorized" ? "unauthorized" : "unavailable";
      schedulePhone();
    });
  };

  /**
   * Streamed language-model text (translation, summary, explanation) redraws
   * the glasses at most every 300 ms; the finished text draws at once.
   */
  const streamDraw = createThrottle(() => { void draw(); });

  const POPUP_MS = 15_000;
  const watcher = createInsightWatcher({
    llm: () => (data.insights ? companion() : null),
    locale: () => locale,
    onInsight: (insight) => {
      insights = [...insights, { ...insight, kind: "info" as const }].slice(-50);
      // Behind a word finder or reply suggestion it waits its turn.
      if (listening && data.insights && insight.term !== dismissedTerm) offer("info", { ...insight, kind: "info" }, POPUP_MS);
      void draw();
      schedulePhone();
    },
    onPartial: (insight) => {
      // The explanation grows on the glasses while it is written — only when nothing more important is shown.
      if (!listening || !data.insights || insight.term === dismissedTerm) return;
      const shown = visiblePopup(popups, Date.now());
      if (shown && POPUP_RANK[shown.kind] > POPUP_RANK.info) return;
      offer("info", { ...insight, kind: "info" }, POPUP_MS);
      streamDraw.request();
    },
    onPartialDropped: () => {
      popups = dropKind(popups, "info", Date.now());
      void draw();
    },
    onError: (error) => { console.warn("[babelglass] explain failed:", error); },
    // Own memory: the top 3 notes for the current topic go into the prompt.
    notes: (recent) => memoryHits(recent),
  });

  // ---- Who is who, own sentences, reply suggestions (0.5.0) ----
  /** The user's language = the translation target; the foreign one from settings or detection. */
  const ownCtx = (): OwnContext => {
    const live = md();
    return {
      speakers: live.speakers,
      mySpeaker: live.mySpeaker,
      ownLanguage: translationEnabled(live) ? live.targetLanguage : null,
      voiceEnrolled: live.voiceEnrolled,
      foreign: translationEnabled(live) ? foreignLanguage(live.sourceLanguage, live.targetLanguage, log) : null,
    };
  };

  const REPLY_POPUP_MS = 12_000;
  const replies = createReplyWatcher({
    // 0.6.3: Kundengespräch answers faster (600 ms / 8 s / 2.5 s); Übersetzen keeps the defaults.
    timing: () => replyTimingFor(talkMode()),
    enabled: () => listening && !closed && data.replySuggestions && companion() !== null,
    owner: (entry) => lineOwner(entry, ownCtx()),
    // A provisional line in the user's language (or of unknown language) may be the user talking.
    userSpeaking: () => {
      const pending = buffer.pending;
      if (!pending) return false;
      const own = ownCtx().ownLanguage;
      return !pending.language || !own || sameLanguage(pending.language, own);
    },
    suggest: async (snapshot): Promise<ReplySuggestion | null> => {
      if (!companionConfigured(data)) {
        // The demo (no server) shows what it would look like.
        const last = snapshot[snapshot.length - 1]?.text ?? "";
        return usesMockStt(data) && /\?\s*$/.test(last) && !/\b(JAZ|COP)\b/.test(last) ? { text: t(locale, "g.replyDemo") } : null;
      }
      const ctx = ownCtx();
      const language: ReplyLanguage = ctx.foreign
        ? { language: ctx.foreign, gloss: data.targetLanguage }
        : { language: conversationLanguage(snapshot, md().sourceLanguage) };
      const notes = await memoryHits(snapshot.slice(-3)).catch(() => "");
      const result = await suggestReply(
        { url: data.llmUrl, model: data.llmModel, ...(data.llmKey ? { apiKey: data.llmKey } : {}) },
        { context: replyContext(snapshot, ctx, Date.now(), locale), language, locale, notes },
      ).catch(() => ({ ok: false as const, error: "failed" }));
      return result.ok ? result.value : null;
    },
    onSuggestion: (suggestion, trigger) => {
      const lines = [suggestion.text, ...(suggestion.gloss ? ["(" + suggestion.gloss + ")"] : [])];
      offer("reply", { term: "", info: lines.join(" "), kind: "reply", lines }, REPLY_POPUP_MS);
      log = annotateEntry(log, trigger.text, { reply: lines.join(" ") }, trigger.at);
      keepConversation(true);
      schedulePhone();
      void draw();
    },
  });

  // ---- Tipp-Karten (cues): Kundengespräch only, see companion/cues ----
  let cues: CueCard[] = [];
  const cueWatcher = createCueWatcher({
    enabled: () => listening && !closed && talkMode() === "client" && cueCardsOn(data) && companionConfigured(data),
    // Never over a reply suggestion or a popup the user asked for.
    blocked: () => { const kind = visiblePopup(popups, Date.now())?.kind; return kind === "reply" || kind === "word" || kind === "say"; },
    lines: () => log.length,
    request: () => fetchCue(
      { url: data.llmUrl, model: data.llmModel, ...(data.llmKey ? { apiKey: data.llmKey } : {}), ...(sessionCustomer ? { customer: sessionCustomer.id } : {}) },
      { transcript: cueTranscript(log, Date.now()), recentTitles: cues.map((c) => c.title) },
    ),
    onCue: (card) => {
      if (!listening || closed) return;
      cues = keepCue(cues, card);
      const lines = cueRows(card);
      offer("cue", { term: card.title, info: card.text, kind: "cue", lines, plain: true }, CUE_POPUP_MS);
      schedulePhone();
      void draw();
    },
  });

  /** Own line → conversation language, shown in the captions as "→ …" (setting "Meine Sätze übersetzen"). */
  const translateOwnLine = (entry: TranscriptEntry): void => {
    const request = ownTranslationRequest(entry.text, ownCtx());
    if (!request) return;
    let partialShown = false;
    void translator.translate(request, (partial) => {
      partialShown = true;
      buffer = applyTranslation(buffer, entry.text, OWN_MARK + partial);
      streamDraw.request();
    }).then((result) => {
      if (result.error || !result.text) {
        if (partialShown) buffer = dropTranslation(buffer, entry.text);
        if (result.error) console.warn("[babelglass] own translation failed:", result.error);
        void draw();
        return;
      }
      const text = result.text.normalize("NFC");
      buffer = applyTranslation(buffer, entry.text, OWN_MARK + text);
      log = annotateEntry(log, entry.text, { own: text }, entry.at);
      keepConversation(true);
      schedulePhone();
      void draw();
    }).catch(() => undefined);
  };

  // "My last sentence" on demand: swipe towards the newest while already at the live edge.
  const SAY_MS = 20_000;
  const SAY_NOTE_MS = 4_000;
  let sayRun = 0;
  let sayBusy = false;
  const showSay = (lines: readonly string[], ms: number, plain = false): void => {
    offer("say", { term: "", info: lines.join(" "), kind: "say", lines, ...(plain ? { plain: true } : {}) }, ms);
    void draw();
  };
  const translateMyLast = async (): Promise<void> => {
    if (sayBusy) return;
    const x = (key: string): string => t(locale, key);
    if (!translationEnabled(md())) { showSay([x("g.sayNoTarget")], SAY_NOTE_MS, true); return; }
    const ctx = ownCtx();
    if (!ctx.foreign) { showSay([x("g.sayNoForeign")], SAY_NOTE_MS, true); return; }
    const entry = lastOwnLine(log, ctx, Date.now());
    if (!entry) { showSay([x("g.sayNone")], SAY_NOTE_MS, true); return; }
    if (entry.own) { showSay([entry.own], SAY_MS); return; }
    const request = ownTranslationRequest(entry.text, ctx);
    if (!request) { showSay([x("g.sayNone")], SAY_NOTE_MS, true); return; }
    sayBusy = true;
    const run = ++sayRun;
    showSay([x("g.sayWorking")], 15_000, true);
    const result = await translator.translate(request).catch(() => ({ text: "", error: "failed" }));
    sayBusy = false;
    if (run !== sayRun || !listening || closed) return;
    if (result.error || !result.text) { showSay([x("g.sayFailed")], SAY_NOTE_MS, true); return; }
    const text = result.text.normalize("NFC");
    log = annotateEntry(log, entry.text, { own: text }, entry.at);
    showSay([text], SAY_MS);
    keepConversation(true);
    schedulePhone();
  };
  /** When the last swipe arrived: one physical swipe sends several events. */
  let lastScrollAt = 0;

  // ---- Wortfinder (0.4.0): hold during captions ----
  const WORD_POPUP_MS = 15_000;
  const WORD_NOTE_MS = 4_000;
  let wordBusy = false;
  /** Bumped when a word popup is closed or captions stop: a late answer is dropped. */
  let wordRun = 0;
  const showWord = (lines: readonly string[], ms: number): void => {
    offer("word", { term: "", info: lines.join(" "), kind: "word", lines }, ms);
    void draw();
  };
  const findWordNow = async (): Promise<void> => {
    if (wordBusy) return;
    const x = (key: string): string => t(locale, key);
    if (!companionConfigured(data)) {
      // The demo (no server) shows what it would look like.
      showWord(usesMockStt(data) ? [x("g.wordDemo")] : [x("g.wordNoLlm")], usesMockStt(data) ? WORD_POPUP_MS : WORD_NOTE_MS);
      return;
    }
    const speaker = data.speakers ? resolveSpeaker(log, data.mySpeaker) : null;
    const context = wordContext(log, { now: Date.now(), speaker, pending: buffer.pending?.text ?? null });
    if (!context.trim()) { showWord([x("g.wordNone")], WORD_NOTE_MS); return; }
    wordBusy = true;
    const run = ++wordRun;
    showWord([x("g.wordSearching")], WORD_TIMEOUT_MS + 2000);
    const result = await findWord(
      { url: data.llmUrl, model: data.llmModel, ...(data.llmKey ? { apiKey: data.llmKey } : {}) },
      {
        context,
        language: conversationLanguage(log, md().sourceLanguage),
        ...(translationEnabled(md()) ? { target: data.targetLanguage } : {}),
      },
    ).catch(() => ({ ok: false as const, error: "failed" }));
    wordBusy = false;
    if (run !== wordRun || !listening || closed) return;
    if (!result.ok) { showWord([x("g.wordNone")], WORD_NOTE_MS); return; }
    const lines = wordPopupLines(result.value);
    showWord(lines, WORD_POPUP_MS);
    insights = [...insights, { term: "", info: lines.join(" "), kind: "word" as const }].slice(-50);
    schedulePhone();
  };

  const overviewInput = (): OverviewInput => ({ data, listening, sttStatus: status, memory: memoryStatus });
  /** The help screen as glasses rows: every helper, its trigger, on or off now. */
  const helpRows = (): string[] => {
    // QIS v1: the gestures first, in footer order, plus what the app needs; then every helper.
    const gestures = [1, 2, 3, 4, 5].flatMap((n) => wrap(t(locale, "g.hg." + n), POPUP_WIDTH));
    // 0.6.2: the overview ("was läuft wann") starts on a page of its own, under its own title row.
    while (gestures.length % BODY_ROWS !== 0) gestures.push("");
    return [
      ...gestures,
      t(locale, "g.overviewHead"),
      ...helperRows(overviewInput()).flatMap((row) => wrap(helpLine(row, locale), POPUP_WIDTH)),
    ];
  };
  /** Rows of the paged popup now shown (help/overview or Kunde). */
  const sheetRowsNow = (): string[] =>
    helpKind === "voice"
      ? voiceSheetRows(voiceSheet ?? { kind: "connecting" }, locale, Date.now())
      : helpKind === "customer"
      ? customer ? customerRows(customer, locale, POPUP_WIDTH) : [t(locale, "g.noCustomer")]
      : helpRows();
  /** Header label of the paged sheet now shown. */
  const sheetTitle = (): Record<string, string> =>
    helpKind === "customer" ? { title: t(locale, "g.s.cust") }
      : helpKind === "voice" ? { title: t(locale, "g.s.voice"), ...(voiceSheetCancels(voiceSheet) ? { tapLabel: t(locale, "g.a.cancel") } : {}) }
      : {};
  /** First page of the overview ("was laeuft wann") inside the help sheet. */
  const overviewPage = (): number => Math.ceil([1, 2, 3, 4, 5].flatMap((n) => wrap(t(locale, "g.hg." + n), POPUP_WIDTH)).length / BODY_ROWS);
  const openHelp = (): void => { helpKind = "help"; help = 0; };
  /**
   * 0.6.2: asks the proxy for the Shoot Day customer (3 s at most). Any failure
   * means no customer: no idle row, and the Kunde popup closes if it was open.
   */
  const refreshCustomer = (): void => {
    const run = ++customerRun;
    // 0.7.0: only the customer picked on the start screen; nothing picked = no customer context.
    if (!companionConfigured(data) || !sessionCustomer) { customer = null; return; }
    const id = sessionCustomer.id;
    void fetchCustomer({ url: data.llmUrl, customer: id, ...(data.llmKey ? { apiKey: data.llmKey } : {}) }).then((found) => {
      if (run !== customerRun || closed) return;
      customer = found;
      schedulePhone();
      void draw();
    });
  };
  /** 0.7.0: (re)loads the start screen's customer list; without a model server only "Ohne Kunde" is offered. */
  const loadCustomers = (): void => {
    const run = ++listRun;
    if (!companionConfigured(data)) { customerList = { state: "off" }; cursor = 0; return; }
    customerList = { state: "loading" };
    cursor = 0;
    void fetchCustomers({ url: data.llmUrl, ...(data.llmKey ? { apiKey: data.llmKey } : {}) }).then((found) => {
      if (run !== listRun || closed) return;
      customerList = found === null ? { state: "failed" } : { state: "ready", entries: found };
      const rows = pickRows(customerList, new Date());
      const at = sessionCustomer ? rows.findIndex((row) => row.kind === "customer" && row.entry.id === sessionCustomer?.id) : -1;
      cursor = at >= 0 ? at : 0;
      void draw();
    });
  };
  /**
   * Without the side menu (SIDE_MENU off, step log 15.10.2026) the entries only it carried live at the end of the start list:
   * Meine Stimme lernen/löschen and Personen. Help is a hold; the mode is the row picked; Kundeninfo stays on the phone.
   */
  const menuRows = (): MenuRow[] => SIDE_MENU ? [] : [
    { id: MENU.voice, label: t(locale, "g.m.voice") },
    { id: MENU.voiceDelete, label: t(locale, "g.m.voiceDelete") },
    { id: MENU.persons, label: t(locale, "g.m.persons", { n: data.persons }) },
  ];
  const pickerRows = (): PickRow[] => pickRows(customerList, new Date(), menuRows());
  /** The armed action as the screen shows it; a stop only counts while captions run. Clearing is phone-only (0.6.1). */
  const armedKind = (now: number): "stop" | null => {
    const armed = activeConfirm(pending, now);
    if (!armed) return null;
    return listening ? "stop" : null;
  };
  const arm = (kind: "stop"): void => {
    pending = { kind, until: Date.now() + CONFIRM_WINDOW_MS };
    clearTimeout(confirmTimer);
    confirmTimer = setTimeout(() => { pending = null; void draw(); }, CONFIRM_WINDOW_MS + 50);
  };
  const disarm = (): void => { pending = null; clearTimeout(confirmTimer); };

  const conversationState = (): ConversationState => ({
    log,
    pending: buffer.pending?.text ?? null,
    summary: summary === null ? null
      : summary.state === "done" ? { state: "done", long: summary.long ?? summary.short }
      : summary.state === "working" ? { state: "working", ...(summary.long?.length ? { long: summary.long } : {}) }
      : summary,
    insights,
    canSummarize: companion() !== null,
    overview: overviewInput(),
    ...(customer ? { customerLine: customerPhoneLine(customer, locale) } : {}),
    talkMode: talkMode(),
    cues,
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
    summaryHidden = false;
    summaryPage = 0;
    void draw();
    schedulePhone();
    const result = await llm.summarize(log, locale, (partial) => {
      // The summary grows on the glasses and the phone while it is written.
      if (run !== summaryRun) return;
      summary = { state: "working", short: partial.short, long: partial.long };
      streamDraw.request();
      schedulePhone();
    }, cueSummaryBlock(cues, locale)).catch(() => ({ ok: false as const, error: "failed" }));
    if (run !== summaryRun) return;
    streamDraw.cancel();
    summaryPage = 0;
    summary = result.ok
      ? { state: "done", short: result.value.short, long: result.value.long }
      : { state: "error", error: result.error };
    if (result.ok) remember(result.value);
    keepConversation();
    void draw();
    schedulePhone();
  };

  const clearConversation = (): void => {
    buffer = clearBuffer();
    offset = 0;
    log = [];
    insights = [];
    popups = emptySlot();
    summary = null;
    summaryRun++;
    watcher.reset();
    replies.reset();
    cues = [];
    cueWatcher.stop();
    sayRun++;
    pending = null;
    // The stored copy goes too, whatever the switch says now.
    clearTimeout(keepTimer);
    void saveConversation(bridge, null).catch(() => undefined);
    void draw();
    schedulePhone();
  };

  const iconKind = (): IconKind => {
    if (listening) return popupNow() ? "info" : "listening";
    if (summary?.state === "working") return "thinking";
    if (summary?.state === "done") return "done";
    return "off";
  };

  const currentView = (): CaptionView =>
    buildView(buffer, {
      mode: data.mode,
      // The microphone indicator also shows while "Meine Stimme" records.
      listening: listening || enrollMic,
      status,
      translating: translationEnabled(md()),
      offset,
      mock: usesMockStt(data),
      transliterateOriginal: data.transliterateOriginal,
      sourceLanguage: md().sourceLanguage,
      translateError,
      locale,
      speakers: data.speakers,
      now: Date.now(),
      popup: popupNow(),
      active: activeHelpers(overviewInput()),
      help: help === null ? null : { rows: sheetRowsNow(), page: help, ...sheetTitle() },
      picker: listening ? null : { rows: pickBody(pickerRows(), cursor, new Date(), locale, POPUP_WIDTH, BODY_ROWS) },
      talkModeLabel: t(locale, talkModeKey(talkMode())),
      wordFinder: companion() !== null,
      summary: shownSummary(),
      summaryPage,
      notice,
      armed: armedKind(Date.now()),
      menuArmed: menuArmedKind(menuPending, Date.now()),
    });

  let iconBusy = false;
  const drawIcon = async (): Promise<void> => {
    if (closed || !pageReady || iconBusy) return;
    iconBusy = true;
    try { await updateIcon(bridge, iconFrame(iconKind(), Date.now())); } finally { iconBusy = false; }
  };

  const drawOnce = async (): Promise<void> => {
    if (closed || paused) return;
    popups = advancePopups(popups, Date.now());
    // After a reconnect or a return to the foreground the page is rebuilt even
    // when the text did not change: it was lost, and an unchanged view used to
    // skip the rebuild and leave the glasses blank.
    if (rebuildWanted) { rebuildWanted = false; pageReady = false; lastView = null; }
    const view = currentView();
    const menu = menuSpec();
    // The side menu travels with the page: a different menu (mode, language) means one rebuild.
    if (pageReady && menu.key !== pageMenuKey) pageReady = false;
    if (pageReady && sameView(lastView, view)) { void drawIcon(); return; }

    const result = pageReady ? await updatePage(bridge, view) : await createPage(bridge, view, menu);
    if (result.ok) {
      if (!pageReady) pageMenuKey = menu.key;
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

  const buildTranslator = (): TranslationProvider => selectTranslator(md());

  /** 0.7.0: the side menu: Hilfe, Uebersicht, Modus (names the mode in force; picking it toggles), Kunde wechseln, Kundeninfo. */
  const menuSpec = (): MenuSpec => {
    const mode = talkMode();
    // Step log 15.10.2026: no menu on the pages while its clicks do not arrive on the real glasses.
    if (!SIDE_MENU) return { key: "none", items: [] };
    const item = (id: number, key: string): { id: number; label: string } => ({ id, label: t(locale, key) });
    return {
      key: locale + ":" + mode + ":" + data.persons,
      items: [
        item(MENU.help, "g.m.help"),
        item(MENU.overview, "g.m.overview"),
        item(MENU.mode, mode === "client" ? "g.m.modeClient" : "g.m.modeTranslate"),
        item(MENU.pick, "g.m.pick"),
        item(MENU.info, "g.m.info"),
        // 0.8.0: the user's voice (ME = "Ich:") and how many people talk.
        item(MENU.voice, "g.m.voice"),
        item(MENU.voiceDelete, "g.m.voiceDelete"),
        { id: MENU.persons, label: t(locale, "g.m.persons", { n: data.persons }) },
      ],
    };
  };

  /** 0.6.3: the user picked a mode on the glasses: stored, and kept from now on. */
  const pickTalkMode = async (mode: TalkMode): Promise<void> => {
    data = { ...data, talkMode: mode };
    translator = buildTranslator();
    translateError = null;
    await save(bridge, data).catch((error: unknown) => { console.warn("[babelglass] save failed:", error); });
    schedulePhone();
    void draw();
  };

  const translateLine = (text: string, detected: string | undefined): void => {
    const live = md();
    if (!translationEnabled(live)) return;
    const request = translationRequestFor(live, translator, text, detected);
    // Already in the target language: nothing to translate, show as is.
    if (!request) return;
    let partialShown = false;
    void translator.translate(request, (partial) => {
      // The translation replaces the line's translation step by step.
      partialShown = true;
      buffer = applyTranslation(buffer, text, partial);
      streamDraw.request();
    }).then((result) => {
      if (result.error) {
        // A half translation is not left standing as if it were the whole one.
        if (partialShown) buffer = dropTranslation(buffer, text);
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
        replies.onFinal(log);
        keepConversation(true);
        const entry = log[log.length - 1];
        if (data.translateOwn && translationEnabled(md()) && entry && isOwnLine(entry, ownCtx())) {
          // The user's own line goes the other way: into the conversation language.
          translateOwnLine(entry);
        } else {
          translateLine(text, transcript.language);
        }
      } else {
        translateLine(text, transcript.language);
      }
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
          // 0.6.3: Kundengespräch always sends "de" (never "auto").
          language: md().sourceLanguage,
          // Partial lines + speaker labels; servers without it ignore the flag.
          stream: true,
          // 0.8.0: everyone in the conversation, and the others among them (the user is "ME" once the voice is known).
          persons: data.persons,
          speakers: othersFor(data.persons, data.voiceEnrolled),
          onTranscript,
          onStatus: (s) => { status = s; void draw(); schedulePhone(); },
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
    cueWatcher.start(listeningSince);
    help = null;
    schedulePhone();
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
    popups = emptySlot();
    wordRun++;
    sayRun++;
    sayBusy = false;
    watcher.stop();
    replies.stop();
    cueWatcher.stop();
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

  /** 0.7.0: a tap on the start screen: a customer -> Kundengespraech with them, the last row -> Uebersetzen. */
  const startFromRow = async (row: PickRow | undefined): Promise<void> => {
    if (!row || row.kind === "loading" || row.kind === "menu") return;
    if (row.kind === "retry") { loadCustomers(); await draw(); return; }
    if (row.kind === "customer") {
      sessionCustomer = row.entry;
      setSessionCustomer(row.entry.id);
      refreshCustomer();
      await pickTalkMode("client");
    } else {
      sessionCustomer = null;
      customer = null;
      customerRun++;
      // "-" tells the proxy: no customer context at all (not Shoot Day's active one).
      setSessionCustomer(companionConfigured(data) ? "-" : null);
      await pickTalkMode("translate");
    }
    await startListening();
  };

  // ---- 0.8.0 "Meine Stimme": enrollment and deletion on the speech server ----
  /** Stops whatever "Meine Stimme" is doing: timer, socket (the server then stores nothing), microphone. */
  const cancelVoice = (): void => {
    voiceRun++;
    clearTimeout(enrollTimer);
    enrollTimer = undefined;
    enrollment?.cancel();
    enrollment = null;
    if (enrollMic) {
      enrollMic = false;
      void bridge.audioControl(false).catch(() => undefined);
    }
  };
  /** Closes the paged sheet; a running enrollment is cancelled with it. */
  const closeSheet = (): void => {
    if (helpKind === "voice") { if (voiceSheetCancels(voiceSheet)) cancelVoice(); voiceSheet = null; }
    help = null;
    helpKind = "help";
  };
  const showVoice = (sheet: VoiceSheet): void => {
    voiceSheet = sheet;
    helpKind = "voice";
    help = 0;
  };
  const voiceConfig = (): { url: string; token?: string } => ({ url: data.sttUrl, ...(data.sttToken ? { token: data.sttToken } : {}) });
  const rememberVoice = async (enrolled: boolean): Promise<void> => {
    if (data.voiceEnrolled === enrolled) return;
    data = { ...data, voiceEnrolled: enrolled };
    await save(bridge, data).catch((error: unknown) => { console.warn("[babelglass] save failed:", error); });
    schedulePhone();
  };

  /** Side menu "Meine Stimme lernen": ~16 s of reading through the glasses mic, sent only to the user's speech server. */
  const startEnrollment = async (): Promise<void> => {
    cancelVoice();
    const run = voiceRun;
    if (usesMockStt(data)) { showVoice({ kind: "noServer" }); return; }
    if (listening) await stopListening();
    showVoice({ kind: "connecting" });
    void draw();
    const job = createVoiceEnrollment(voiceConfig());
    enrollment = job;
    const ok = await job.ready;
    if (run !== voiceRun || closed) { job.cancel(); return; }
    if (!ok) {
      enrollment = null;
      showVoice({ kind: "result", reply: await job.finish() });
      await draw();
      return;
    }
    const mic = await bridge.audioControl(true, AudioInputSource.Glasses).catch(() => false);
    if (run !== voiceRun || closed || paused) {
      if (mic) await bridge.audioControl(false).catch(() => undefined);
      job.cancel();
      return;
    }
    if (!mic) {
      job.cancel();
      enrollment = null;
      showVoice({ kind: "micDenied" });
      await draw();
      return;
    }
    enrollMic = true;
    showVoice({ kind: "reading", until: Date.now() + ENROLL_MS });
    enrollTimer = setTimeout(() => { void finishEnrollment(run); }, ENROLL_MS);
    await draw();
  };

  const finishEnrollment = async (run: number): Promise<void> => {
    const job = enrollment;
    if (run !== voiceRun || !job) return;
    enrollTimer = undefined;
    enrollMic = false;
    await bridge.audioControl(false).catch(() => undefined);
    if (helpKind === "voice") voiceSheet = { kind: "saving" };
    void draw();
    const reply: VoiceReply = await job.finish();
    if (run !== voiceRun) return;
    enrollment = null;
    if (reply.ok) await rememberVoice(true);
    if (helpKind === "voice" && help !== null) voiceSheet = { kind: "result", reply };
    await draw();
  };

  /** Side menu "Meine Stimme löschen": the server removes the voice print; captions use letters only again. */
  const deleteVoice = async (): Promise<void> => {
    cancelVoice();
    const run = voiceRun;
    if (usesMockStt(data)) { await rememberVoice(false); showVoice({ kind: "noServer" }); return; }
    // A running session still holds the print in memory: it ends first.
    if (listening) await stopListening();
    showVoice({ kind: "deleting" });
    void draw();
    const reply = await voiceCommand({ ...voiceConfig(), action: "delete" });
    if (run !== voiceRun || closed) return;
    if (reply.ok) await rememberVoice(false);
    if (helpKind === "voice" && help !== null) voiceSheet = { kind: "result", reply };
    await draw();
  };

  /** QIS v1.2 #3: which menu items are armed first: the voice delete always, the restarting ones only while captions run. */
  const menuArmFor = (itemId: number): MenuArmed | null => {
    if (itemId === MENU.voiceDelete) return "voiceDelete";
    if (listening && (itemId === MENU.pick || itemId === MENU.mode || itemId === MENU.persons)) return "restart";
    return null;
  };
  const clearMenuArm = (): void => { menuPending = null; clearTimeout(menuTimer); };

  /** 0.7.0: an item of the glasses' side menu. Menu clicks arrive on their own event, whatever captures input. */
  const onMenu = async (itemId: number): Promise<void> => {
    disarm();
    // QIS v1.2 #3: deleting the voice print, and anything that would restart running captions, waits for a second click.
    const step = menuClickStep(menuPending, itemId, menuArmFor(itemId), Date.now());
    clearMenuArm();
    if (!step.run) {
      menuPending = step.pending;
      menuTimer = setTimeout(() => { menuPending = null; void draw(); }, CONFIRM_WINDOW_MS + 50);
      await draw();
      return;
    }
    notice = null;
    // Any other menu item ends a running "Meine Stimme" recording first.
    if (itemId !== MENU.persons && helpKind === "voice") closeSheet();
    switch (itemId) {
      case MENU.help: helpKind = "help"; help = 0; break;
      case MENU.overview: helpKind = "help"; help = overviewPage(); break;
      case MENU.info: helpKind = "customer"; help = 0; refreshCustomer(); break;
      case MENU.voice: await startEnrollment(); break;
      case MENU.voiceDelete: await deleteVoice(); break;
      case MENU.persons: {
        // 0.8.0: Personen 2 -> 3 -> 4 -> 5 -> 2, stored; the recogniser gets it in the start frame, so a running one restarts.
        data = { ...data, persons: nextPersons(data.persons) };
        await save(bridge, data).catch((error: unknown) => { console.warn("[babelglass] save failed:", error); });
        schedulePhone();
        if (listening) {
          await stopListening();
          await startListening();
        }
        break;
      }
      case MENU.mode: {
        const before = modeData(data, customer !== null);
        await pickTalkMode(talkMode() === "client" ? "translate" : "client");
        // The recogniser takes its language once, at the start: a changed one needs a fresh connection.
        if (listening && sttSettingsChanged(before, modeData(data, customer !== null))) {
          await stopListening();
          await startListening();
        }
        break;
      }
      case MENU.pick:
        help = null;
        if (listening) await stopListening();
        if (summary?.state !== "working") summaryHidden = true;
        loadCustomers();
        break;
      default:
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
    clearTimeout(confirmTimer);
    clearMenuArm();
    cancelVoice();
    if (listening || stt) {
      listening = false;
      void bridge.audioControl(false).catch(() => undefined);
      void stt?.stop().catch(() => undefined);
      stt = null;
    }
    watcher.stop();
    replies.stop();
    keepConversation();
  };

  /**
   * QIS v1.2 #2: 2x at the root opens the system exit dialog without stopping
   * anything first. Running captions keep running while the user decides; they
   * (and the microphone) only end when the exit is confirmed. Cancel changes nothing.
   */
  const requestExit = createExitRequest(bridge, {
    onConfirmed: () => { shutDown(); },
  }, "babelglass");
  const exitWithDialog = async (): Promise<void> => { await requestExit(); };

  bridge.onEvenHubEvent((event) => {
    if (closed) return;
    const step = lifecycleFromEvent(event);
    if (step === "foregroundExit") {
      // Out of sight: the microphone closes (it reopens only on a tap) and
      // the conversation is stored if the user asked for that.
      paused = true;
      pending = null;
      if (helpKind === "voice") closeSheet();
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
    const menuId = menuItemIdFromEvent(event);
    if (menuId !== null) { void onMenu(menuId); return; }
    const audio = (event as { audioEvent?: { audioPcm?: unknown } }).audioEvent;
    const pcm = audio?.audioPcm;
    const bytes = listening || enrollMic ? toBytes(pcm) : null;
    if (bytes && bytes.length > 0) {
      // 0.8.0: while "Meine Stimme" records, the audio goes only to the enrollment.
      if (enrollMic) enrollment?.send(bytes);
      else stt?.send(bytes);
      return;
    }

    const gesture = gestureFromEvent(event, { invertScroll: data.invertScroll });
    if (!gesture) return;

    const rows = MODE_PRESETS[data.mode].rows;
    // The release that follows a hold is not a gesture of its own.
    if (gesture.gesture === "longPressRelease") return;

    // Without the side menu the confirming step is a tap on the same list row (the armed row of the start list).
    if (!SIDE_MENU && gesture.gesture === "click" && !listening && help === null && menuArmedKind(menuPending, Date.now()) !== null) {
      const row = pickerRows()[cursor];
      if (row?.kind === "menu") { void onMenu(row.id); return; }
    }

    // QIS v1.2 #3: an armed side-menu item. A tap, a swipe or 2x cancel it and do nothing else;
    // a hold does not (it is how the side menu opens again for the confirming second click).
    if ((!SIDE_MENU || gesture.gesture !== "longPress") && menuArmedKind(menuPending, Date.now()) !== null) {
      clearMenuArm();
      void draw();
      return;
    }

    // An armed action: only the confirming single tap carries it out; a swipe, a hold or 2x
    // cancel it (a swipe never scrolls, a hold never searches, 2x never exits from here).
    const armed = armedKind(Date.now());
    if (armed) {
      disarm();
      if (gesture.gesture === "click") {
        notice = null;
        void stopListening(true);
        return;
      }
      void draw();
      return;
    }
    pending = null;

    /** Closes the shown popup, remembering that it was dismissed. */
    const closeShownPopup = (): boolean => {
      const shown = popupNow();
      if (!shown) return false;
      if (shown.kind === "word") wordRun++;
      else if (shown.kind === "say") sayRun++;
      else if ((shown.kind ?? "info") === "info") dismissedTerm = shown.term;
      popups = closePopup(popups, Date.now());
      return true;
    };

    switch (gesture.gesture) {
      case "click":
        notice = null;
        // A tap first closes the help screen or a popup; running, it arms the stop.
        // 0.8.0: on the "Meine Stimme" sheet it cancels the recording (nothing is stored).
        if (help !== null) { closeSheet(); break; }
        if (closeShownPopup()) break;
        if (listening) { arm("stop"); break; }
        // 0.7.0: stopped, a summary goes first (back to the list); then the tap starts with the row under the cursor.
        const sheet = shownSummary();
        if (sheet) { if (sheet.state !== "working") summaryHidden = true; break; }
        {
          const row = pickerRows()[cursor];
          if (row?.kind === "menu") { void onMenu(row.id); return; }
          void startFromRow(row);
        }
        return;
      case "scrollUp": {
        const now = Date.now();
        lastScrollAt = now;
        if (help !== null) { help = Math.max(0, help - 1); break; }
        if (!listening && shownSummary()?.state === "done") { summaryPage = Math.max(0, summaryPage - 1); break; }
        // 0.7.0: stopped, a swipe only moves the cursor of the customer list (never help or Kunde).
        if (!listening) { if (!shownSummary()) cursor = Math.max(0, cursor - 1); break; }
        offset = Math.min(offset + rows, 200);
        break;
      }
      case "scrollDown": {
        const now = Date.now();
        const settled = now - lastScrollAt > 1200;
        lastScrollAt = now;
        // 0.6.2: past the last page the popup closes (back to the main screen) instead of hanging there.
        if (help !== null) {
          const next = sheetNext(help, sheetRowsNow(), locale);
          if (next === null) closeSheet();
          else help = next;
          break;
        }
        const paged = shownSummary();
        if (!listening && paged?.state === "done") {
          summaryPage = Math.min(summaryPage + 1, summaryPageCount(paged.short, paged.long ?? []) - 1);
          break;
        }
        if (!listening) { if (!shownSummary()) cursor = Math.min(pickerRows().length - 1, cursor + 1); break; }
        // Already at the live edge (and not the tail of the swipe that got there):
        // translate my last sentence into the conversation language.
        if (offset === 0 && settled) { void translateMyLast(); return; }
        offset = Math.max(0, offset - rows);
        break;
      }
      case "longPress": {
        // During captions a hold is the Wortfinder. 0.7.0: stopped, nothing (help lives in the side menu).
        // Nothing on the glasses clears the transcript: that is only possible on the phone (0.6.1).
        if (listening) { void findWordNow(); return; }
        // Without the side menu the hold opens the help again (as before 0.7.0; it holds the overview on its later pages).
        if (!SIDE_MENU) { if (help === null) openHelp(); break; }
        return;
      }
      case "doubleClick":
        // Back one level first (help, popup); only on the main screen it leaves.
        if (help !== null) { closeSheet(); break; }
        if (closeShownPopup()) break;
        // 0.7.0: stopped, a finished summary goes back to the customer list first.
        if (!listening && shownSummary() && summary?.state !== "working") { summaryHidden = true; break; }
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
    cueWatcher.tick(Date.now());
    void draw();
  }, ICON_STEP_MS);

  // The first page only now, with the gestures wired.
  loadCustomers();
  void draw();
  probeMemory();

  mountPhoneUi({
    getConversation: conversationState,
    getMemory: memoryClient,
    onShowHelp: () => { openHelp(); void draw(); },
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
      if (previous.llmUrl !== next.llmUrl || previous.llmKey !== next.llmKey || (!previous.memory && next.memory)) {
        memoryStatus = "unknown";
        memoryDownUntil = 0;
        probeMemory();
      }
      if (previous.llmUrl !== next.llmUrl || previous.llmKey !== next.llmKey || previous.llmModel !== next.llmModel) {
        refreshCustomer();
        if (!listening) loadCustomers();
      }
      schedulePhone();
      // The recogniser receives its language once, in the start frame, so a
      // changed server or language only takes effect on a fresh connection.
      if (listening && sttSettingsChanged(modeData(previous, customer !== null), modeData(next, customer !== null))) {
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
