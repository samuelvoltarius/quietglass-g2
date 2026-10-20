import {
  AudioInputSource, waitForEvenAppBridge, type EvenAppBridge,
} from "@evenrealities/even_hub_sdk";
import {
  createMockStt, createWebSocketStt, type SttProvider, type SttStatus, type Transcript,
} from "./stt/provider";
import { createPassthroughTranslator, type TranslationProvider } from "./translate/provider";
import { selectTranslator, translationRequestFor } from "./translate/select";
import {
  applyTranscript, applyTranslation, clearBuffer, createBuffer, dropTranslation, type CaptionBuffer,
} from "./captions/buffer";
import { gestureFromEvent, menuItemIdFromEvent } from "./input/gestures";
import {
  buildView, BODY_ROWS, MODE_PRESETS, POPUP_WIDTH, sheetNext, summaryPageCount, type CaptionView, type MicNotice, type SummaryState, type ViewPopup,
} from "./glasses/view";
import { createThrottle } from "./glasses/throttle";
import { sameView } from "./glasses/diff";
import { COCKPIT_TILES, createCockpitPage, createPage, forgetPage, guardedTileSend, updateIcon, updatePage, type MenuSpec } from "./glasses/render";
import { talkCockpitModel, talkStats, modelKey as cockpitKey, type TalkCockpitModel } from "./cockpit/model";
import { composeCockpit } from "./cockpit/compose";
import { createTileSender } from "./screen/sender";
import { autoBackend, type TextBackend } from "./screen/text";
import { startBody, startRows, type StartRow } from "./glasses/start";
import { iconFrame, ICON_STEP_MS, type IconKind } from "./glasses/icon";
import {
  companionConfigured, load, loadConversation, loadVocab, save, saveConversation, saveVocab, translationEnabled, usesMockStt,
  type BabelData,
} from "./storage/persist";
import { mountPhoneUi, renderConversation, type ConversationState, type PhoneInsight, type VoiceUiState } from "./ui/phone";
import { annotateEntry, appendEntry, attachTranslation, type TranscriptEntry } from "./companion/transcript";
import { createCompanionLlm, createMockCompanion, type CompanionLlm } from "./companion/llm";
import { createInsightWatcher } from "./companion/insights";
import {
  conversationLanguage, findWord, resolveSpeaker, stuckReason, wordContext, wordPopupLines, WORD_TIMEOUT_MS,
} from "./companion/wordfinder";
import { addVocab, removeVocab, vocabFromResult, type VocabEntry } from "./companion/vocab";
import { createMemoryClient, memoryNotes, memoryQuery, type MemoryClient } from "./companion/memory";
import {
  createReplyWatcher, foreignLanguage, lineOwner, replyContext, suggestReply, type ReplyLanguage, type ReplySuggestion,
} from "./companion/replies";
import { isOwnLine, lastOwnLine, OWN_MARK, ownTranslationRequest, type OwnContext } from "./companion/own";
import {
  advancePopups, closePopup, dropKind, emptySlot, offerPopup, POPUP_RANK, visiblePopup, type PopupKind, type PopupSlot,
} from "./companion/popups";
import type { MemoryStatus, OverviewInput } from "./companion/overview";
import { sameLanguage } from "./text/languages";
import { customerPhoneLine, fetchCustomer, type CustomerContext } from "./companion/customer";
import { fetchCustomers, type CustomerEntry, type CustomerListState } from "./companion/customers";
import { setSessionCustomer } from "./llm/stream";
import { t } from "./messages";
import { effectiveTalkMode, modeData, replyTimingFor, talkModeKey, type TalkMode } from "./companion/talkmode";
import type { Summary } from "./companion/llm";
import { createExitRequest, settleRestore } from "./exit";
import { createCueWatcher, cueCardsOn, cueRows, cueSummaryBlock, cueTranscript, CUE_POPUP_MS, fetchCue, keepCue, type CueCard } from "./companion/cues";
import { rememberLocale, resolveLocale, type Locale } from "./i18n";
import { isFinalExit, lifecycleFromEvent } from "./lifecycle";
import { activeConfirm, CONFIRM_WINDOW_MS, type PendingConfirm } from "./input/confirm";
import { menuArmedKind, menuClickStep, SIDE_MENU, type MenuArmed } from "./input/menu-confirm";
import {
  createVoiceEnrollment, ENROLL_MS, nextPersons, othersFor, OWNER_SPEAKER, voiceCommand, type VoiceEnrollment, type VoiceReply,
} from "./stt/voice";
import { voiceSheetCancels, voiceSheetRows, type VoiceSheet } from "./companion/myvoice";

/** The microphone goes off when the speech server stays away this long. */
export const NO_SERVER_MS = 60_000;
/** And in any case after this long: nobody should be listened to by an app left running. */
export const MAX_LISTEN_MS = 90 * 60_000;

/**
 * The glasses' side menu (hold -> the system menu next to Close and Brightness) stays off (SIDE_MENU, step log
 * 15.10.2026). 1.0.0: help, overview, mode and customer are gone from it (the start screen picks the mode and the
 * customer); what is left is what the phone now does through its own buttons: voice, delete voice, people.
 */
export { SIDE_MENU };
export const MENU = { voice: 6, voiceDelete: 7, persons: 8 } as const;

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
  /** 0.9.0 "Meine Wörter": the words found so far, newest first (kept on the phone). */
  let words: VocabEntry[] = await loadVocab(bridge).catch(() => []);
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
  /** QUS v1: a finished summary opens as the cockpit picture (duration, speaker shares); a swipe turns to the text pages. */
  let summaryCockpit = true;
  /** Bumped on clear/new summary: answers for an older request are dropped. */
  let summaryRun = 0;
  let insights: PhoneInsight[] = [];
  /** One popup at a time: word finder / own sentence > reply suggestion > explanation (0.5.0). */
  let popups: PopupSlot<ViewPopup> = emptySlot();
  const popupNow = (): ViewPopup | null => visiblePopup(popups, Date.now())?.popup ?? null;
  const offer = (kind: PopupKind, popup: ViewPopup, ms: number): void => {
    popups = offerPopup(popups, kind, popup, ms, Date.now()).slot;
  };
  /** Page of the paged sheet on the glasses (1.0.0: only the "Meine Stimme" sheet is left); null = closed. */
  let help: number | null = null;
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
  /** 0.7.0: the start screen's customer list, its cursor (over the start rows), and the customer picked for this session. */
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

  // ---- Wortfinder (0.4.0): by itself when the user is stuck (0.9.0); a hold, where it arrives, asks at once ----
  const WORD_POPUP_MS = 15_000;
  const WORD_NOTE_MS = 4_000;
  let wordBusy = false;
  /** Bumped when a word popup is closed or captions stop: a late answer is dropped. */
  let wordRun = 0;
  const showWord = (lines: readonly string[], ms: number): void => {
    offer("word", { term: "", info: lines.join(" "), kind: "word", lines }, ms);
    void draw();
  };
  /** 0.9.0: when the recogniser last delivered new text, and which (see onTranscript). */
  let lastTextAt = 0;
  let lastSeenText = "";
  /** Start and text of the last lookup; popup state for the automatic trigger. */
  let lastAutoAt = 0;
  let lastWordText: string | null = null;
  let popupClosedAt = 0;
  let popupWasOpen = false;
  /** The user's speaker letter for the word finder; null = speakers off, all speech is his. */
  const wordSpeaker = (): string | null => (data.speakers ? (data.voiceEnrolled ? OWNER_SPEAKER : resolveSpeaker(log, data.mySpeaker)) : null);
  /** 1.0.0: automatic in "Englisch sprechen" whatever the phone switch says, else the switch decides. */
  const wordAutoOn = (): boolean => data.wordAuto || talkMode() === "learn";
  /** `auto`: started by `stuckReason` — no "searching" popup, and a miss stays silent. */
  const findWordNow = async (auto = false): Promise<void> => {
    if (wordBusy) return;
    const x = (key: string): string => t(locale, key);
    if (!companionConfigured(data)) {
      if (auto) return;
      // The demo (no server) shows what it would look like.
      showWord(usesMockStt(data) ? [x("g.wordDemo")] : [x("g.wordNoLlm")], usesMockStt(data) ? WORD_POPUP_MS : WORD_NOTE_MS);
      return;
    }
    const context = wordContext(log, { now: Date.now(), speaker: wordSpeaker(), pending: buffer.pending?.text ?? null });
    if (!context.trim()) { if (!auto) showWord([x("g.wordNone")], WORD_NOTE_MS); return; }
    wordBusy = true;
    const run = ++wordRun;
    if (!auto) showWord([x("g.wordSearching")], WORD_TIMEOUT_MS + 2000);
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
    if (!result.ok) { if (!auto) showWord([x("g.wordNone")], WORD_NOTE_MS); return; }
    const lines = wordPopupLines(result.value, undefined, result.value.learner ? x("g.wordMeaning") : "");
    showWord(lines, WORD_POPUP_MS);
    insights = [...insights, { term: "", info: lines.join(" "), kind: "word" as const }].slice(-50);
    // "Meine Wörter": every successful lookup is kept.
    const found = vocabFromResult(result.value, Date.now());
    if (found) {
      words = addVocab(words, found);
      void saveVocab(bridge, words).catch((error: unknown) => { console.warn("[babelglass] words not saved:", error); });
    }
    schedulePhone();
  };

  // ---- Wortfinder automatisch (0.9.0): the user is stuck ----
  const WORD_TICK_MS = 500;
  let wordTimer: ReturnType<typeof setInterval> | undefined;
  const wordTick = (): void => {
    if (!listening || closed || paused) return;
    const now = Date.now();
    const open = popupNow() !== null || help !== null;
    if (popupWasOpen && !open) popupClosedAt = now;
    popupWasOpen = open;
    if (!wordAutoOn() || !companionConfigured(data)) return;
    const stuck = stuckReason({
      now, log, pending: buffer.pending?.text ?? null, lastTextAt,
      speaker: wordSpeaker(), voiceProfile: data.voiceEnrolled && data.speakers,
      language: conversationLanguage(log, md().sourceLanguage),
      lastAutoAt, lastText: lastWordText, busy: wordBusy, popupOpen: open, popupClosedAt,
    });
    if (!stuck) return;
    lastAutoAt = now;
    lastWordText = stuck.text;
    void findWordNow(true);
  };
  const startWordTimer = (): void => {
    clearInterval(wordTimer);
    lastAutoAt = 0;
    lastWordText = null;
    popupClosedAt = 0;
    popupWasOpen = false;
    wordTimer = setInterval(wordTick, WORD_TICK_MS);
  };
  const stopWordTimer = (): void => { clearInterval(wordTimer); wordTimer = undefined; };

  const overviewInput = (): OverviewInput => ({ data, listening, sttStatus: status, memory: memoryStatus });
  /** Rows of the paged sheet now shown (1.0.0: the "Meine Stimme" sheet). */
  const sheetRowsNow = (): string[] => voiceSheetRows(voiceSheet ?? { kind: "connecting" }, locale, Date.now());
  /** Header label of the paged sheet now shown. */
  const sheetTitle = (): Record<string, string> =>
    ({ title: t(locale, "g.s.voice"), ...(voiceSheetCancels(voiceSheet) ? { tapLabel: t(locale, "g.a.cancel") } : {}) });
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
  /** The start screen's selectable rows now: the three modes, the customers under "Gespräch". */
  const startRowsNow = (): StartRow[] => startRows(customerList, new Date());
  /** Puts the cursor on the row of the customer picked, else on the mode used last (the first row without a pick). */
  const placeCursor = (): void => {
    const rows = startRowsNow();
    const picked = sessionCustomer
      ? rows.findIndex((row) => row.kind === "customer" && row.entry.id === sessionCustomer?.id)
      : -1;
    const last = data.talkMode ? rows.findIndex((row) => row.kind === "mode" && row.mode === data.talkMode) : -1;
    cursor = picked >= 0 ? picked : Math.max(0, last);
  };
  /** (Re)loads the customers shown under "Gespräch"; without a model server there are none. */
  const loadCustomers = (): void => {
    const run = ++listRun;
    if (!companionConfigured(data)) { customerList = { state: "off" }; placeCursor(); return; }
    customerList = { state: "loading" };
    placeCursor();
    void fetchCustomers({ url: data.llmUrl, ...(data.llmKey ? { apiKey: data.llmKey } : {}) }).then((found) => {
      if (run !== listRun || closed) return;
      customerList = found === null ? { state: "failed" } : { state: "ready", entries: found };
      placeCursor();
      schedulePhone();
      void draw();
    });
  };
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

  /** What the phone's "Meine Stimme" card shows: trained or not, and the step of a running enrollment or deletion. */
  const voiceUiState = (): VoiceUiState => {
    const trained = data.voiceEnrolled;
    if (voiceSheet === null) return { trained, phase: "idle" };
    switch (voiceSheet.kind) {
      case "connecting": case "reading": case "saving": case "deleting": return { trained, phase: voiceSheet.kind };
      case "noServer": case "micDenied": return { trained, phase: "error", message: t(locale, "p.voice." + voiceSheet.kind) };
      case "result": {
        const rows = voiceSheetRows(voiceSheet, locale, Date.now());
        return { trained, phase: voiceSheet.reply.ok ? "done" : "error", message: rows[0] ?? "" };
      }
    }
  };

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
    words,
    customers: customerList.state === "ready" ? customerList.entries.map((entry) => ({ id: entry.id, name: entry.name })) : [],
    customerId: sessionCustomer?.id ?? null,
    voice: voiceUiState(),
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
    summaryCockpit = true;
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
    summaryCockpit = true;
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

  /** The summary picture, only while nothing else claims the display and the conversation has numbers to show. */
  const cockpitNow = (): TalkCockpitModel | null => {
    if (listening || enrollMic || help !== null || notice || !summaryCockpit) return null;
    if (menuArmedKind(menuPending, Date.now())) return null;
    if (shownSummary()?.state !== "done") return null;
    const live = md();
    return talkCockpitModel({
      log, locale, now: Date.now(), translating: translationEnabled(live),
      sourceLanguage: live.sourceLanguage, targetLanguage: live.targetLanguage,
    });
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
      help: help === null ? null : { rows: sheetRowsNow(), page: help, ...sheetTitle() },
      start: listening ? null : { rows: startBody(startRowsNow(), cursor, new Date(), locale, POPUP_WIDTH, BODY_ROWS, !data.voiceEnrolled) },
      modeLabel: t(locale, talkModeKey(talkMode())),
      summary: shownSummary(),
      summaryPage,
      notice,
      armed: armedKind(Date.now()),
      menuArmed: menuArmedKind(menuPending, Date.now()),
    });

  let iconBusy = false;
  const drawIcon = async (): Promise<void> => {
    if (closed || !pageReady || iconBusy || installed === "cockpit") return;
    iconBusy = true;
    try { await updateIcon(bridge, iconFrame(iconKind(), Date.now())); } finally { iconBusy = false; }
  };

  // While the exit dialog may be on screen (asked, no input since) no timer, poll or stream may draw: a page call
  // could cover it. Data keeps being collected; the back signal restores the page the way of the first one.
  let exitAsked = (): boolean => false;
  /** Which kind of page the glasses carry: a change means one rebuild. */
  let installed: "text" | "cockpit" | null = null;
  let textBackend: TextBackend | null = null;
  let lastCockpitKey = "";
  let lastCockpitPush = 0;
  let lastCockpitFrame: ReturnType<typeof composeCockpit> | null = null;
  /** The cockpit is one 576 x 288 frame; only the tiles whose pixels changed cross Bluetooth. Never while the dialog may be up. */
  const tiles = createTileSender(COCKPIT_TILES, guardedTileSend(bridge, () => !exitAsked() && !closed && installed === "cockpit"));
  const drawOnce = async (): Promise<void> => {
    if (exitAsked()) return;
    if (closed || paused) return;
    popups = advancePopups(popups, Date.now());
    // After a reconnect or a return to the foreground the page is rebuilt even
    // when the text did not change: it was lost, and an unchanged view used to
    // skip the rebuild and leave the glasses blank.
    if (rebuildWanted) { rebuildWanted = false; pageReady = false; lastView = null; }
    const menu = menuSpec();
    const cockpit = cockpitNow();
    if (cockpit) {
      if (installed !== "cockpit" || (pageReady && menu.key !== pageMenuKey)) pageReady = false;
      if (!pageReady) {
        const made = await createCockpitPage(bridge, menu);
        if (closed) return;
        if (!made.ok) { pageReady = false; console.warn("[babelglass] draw failed:", made.reason); return; }
        pageReady = true;
        installed = "cockpit";
        pageMenuKey = menu.key;
        lastView = null;
        lastCockpitKey = "";
        // A new page starts with blank images.
        tiles.reset();
      }
      const key = cockpitKey(cockpit);
      const now = Date.now();
      if (key !== lastCockpitKey || lastCockpitFrame === null) {
        textBackend ??= autoBackend();
        lastCockpitFrame = composeCockpit(cockpit, textBackend);
        lastCockpitKey = key;
      } else if (now - lastCockpitPush < 5_000) {
        return;
      }
      lastCockpitPush = now;
      // Never awaited: a slow transfer must not hold up the next gesture. An unchanged frame sends nothing; a tile that failed is retried.
      void tiles.push(lastCockpitFrame);
      return;
    }
    // Leaving the cockpit: its containers are about to go, no tile may be written any more.
    if (installed === "cockpit") { installed = null; pageReady = false; }
    const view = currentView();
    // The side menu travels with the page: a different menu (mode, language) means one rebuild.
    if (pageReady && menu.key !== pageMenuKey) pageReady = false;
    if (pageReady && sameView(lastView, view)) { void drawIcon(); return; }

    const result = pageReady ? await updatePage(bridge, view) : await createPage(bridge, view, menu);
    if (result.ok) {
      if (!pageReady) pageMenuKey = menu.key;
      pageReady = true;
      installed = "text";
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

  const buildTranslator = (): TranslationProvider => selectTranslator(md());

  /** The side menu (off, see SIDE_MENU): voice, delete voice, people. */
  const menuSpec = (): MenuSpec => {
    // Step log 15.10.2026: no menu on the pages while its clicks do not arrive on the real glasses.
    if (!SIDE_MENU) return { key: "none", items: [] };
    const item = (id: number, key: string): { id: number; label: string } => ({ id, label: t(locale, key) });
    return {
      key: locale + ":" + data.persons,
      items: [
        item(MENU.voice, "g.m.voice"),
        item(MENU.voiceDelete, "g.m.voiceDelete"),
        { id: MENU.persons, label: t(locale, "g.m.persons", { n: data.persons }) },
      ],
    };
  };

  /** The user picked a mode (start screen or phone): stored, and kept from now on. */
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
    // 0.9.0: a repeated partial is no new text (the automatic word finder waits for silence).
    const seen = transcript.text.trim();
    if (seen && seen !== lastSeenText) { lastTextAt = now; lastSeenText = seen; }
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
        if (talkMode() === "learn" && entry?.speaker === OWNER_SPEAKER) {
          // "Englisch sprechen": the user's own English is not translated, only the other person.
        } else if (data.translateOwn && talkMode() !== "learn" && translationEnabled(md()) && entry && isOwnLine(entry, ownCtx())) {
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
    startWordTimer();
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
    stopWordTimer();
    sayRun++;
    sayBusy = false;
    watcher.stop();
    replies.stop();
    cueWatcher.stop();
    // A provisional line nobody will finish is dropped, not kept as history.
    if (buffer.pending) buffer = { ...buffer, pending: null };
    keepConversation();
    schedulePhone();
    // Back at the start screen: the cursor sits on the mode just used; a failed customer list is tried again.
    if (customerList.state === "failed") loadCustomers(); else placeCursor();
    if (withSummary && data.autoSummary && log.length >= 2 && companion()) {
      void summarize();
      return;
    }
    await draw();
  };

  /** 1.0.0: a tap on the start screen: a mode row starts that mode, a customer row starts "Gespräch" with that customer. */
  const startFromRow = async (row: StartRow | undefined): Promise<void> => {
    if (!row) return;
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
      await pickTalkMode(row.mode);
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
    if (voiceSheetCancels(voiceSheet)) cancelVoice();
    voiceSheet = null;
    help = null;
    schedulePhone();
  };
  const showVoice = (sheet: VoiceSheet): void => {
    voiceSheet = sheet;
    help = 0;
    schedulePhone();
  };
  const voiceConfig = (): { url: string; token?: string } => ({ url: data.sttUrl, ...(data.sttToken ? { token: data.sttToken } : {}) });
  const rememberVoice = async (enrolled: boolean): Promise<void> => {
    if (data.voiceEnrolled === enrolled) return;
    data = { ...data, voiceEnrolled: enrolled };
    await save(bridge, data).catch((error: unknown) => { console.warn("[babelglass] save failed:", error); });
    schedulePhone();
  };

  /** Phone button "Stimme lernen" (the side menu's entry, too): ~16 s of reading through the glasses mic, sent only to the user's speech server. */
  const startEnrollment = async (): Promise<void> => {
    cancelVoice();
    const run = voiceRun;
    if (usesMockStt(data)) { showVoice({ kind: "noServer" }); void draw(); return; }
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
    if (voiceSheet !== null) showVoice({ kind: "saving" });
    void draw();
    const reply: VoiceReply = await job.finish();
    if (run !== voiceRun) return;
    enrollment = null;
    if (reply.ok) await rememberVoice(true);
    if (voiceSheet !== null && help !== null) showVoice({ kind: "result", reply });
    await draw();
  };

  /** Phone button "Stimme löschen" (the side menu's entry, too): the server removes the voice print; captions use letters only again. */
  const deleteVoice = async (): Promise<void> => {
    cancelVoice();
    const run = voiceRun;
    if (usesMockStt(data)) { await rememberVoice(false); showVoice({ kind: "noServer" }); void draw(); return; }
    // A running session still holds the print in memory: it ends first.
    if (listening) await stopListening();
    showVoice({ kind: "deleting" });
    void draw();
    const reply = await voiceCommand({ ...voiceConfig(), action: "delete" });
    if (run !== voiceRun || closed) return;
    if (reply.ok) await rememberVoice(false);
    if (voiceSheet !== null && help !== null) showVoice({ kind: "result", reply });
    await draw();
  };

  /** QIS v1.2 #3: which menu items are armed first: the voice delete always, the people only while captions run. */
  const menuArmFor = (itemId: number): MenuArmed | null => {
    if (itemId === MENU.voiceDelete) return "voiceDelete";
    if (listening && itemId === MENU.persons) return "restart";
    return null;
  };
  const clearMenuArm = (): void => { menuPending = null; clearTimeout(menuTimer); };

  /** An item of the glasses' side menu. Menu clicks arrive on their own event, whatever captures input. */
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
    if (itemId !== MENU.persons && voiceSheet !== null) closeSheet();
    switch (itemId) {
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
    tiles.close();
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
   * (and the microphone) only end when the system ends the app (sysEvent 6/7). The call resolves when
   * the dialog is shown, not when the user answered, so its result never shuts anything down.
   */
  const requestExit = createExitRequest(bridge, {
    onBack: () => {
      // The dialog took the page away. On the next input put it up again the way of the first one,
      // so the glasses deliver input (and the next 2×) to the app again (store review 16.10.2026).
      if (closed) return;
      pageReady = false;
      lastView = null;
      forgetPage(bridge);
      return draw();
    },
  }, "babelglass");
  exitAsked = requestExit.asked;
  const exitWithDialog = async (): Promise<void> => { await requestExit(); };

  bridge.onEvenHubEvent((event) => {
    if (closed) return;
    // The 4/5 right after an exit call are the system dialog's own show/close, not the app entering/leaving.
    if (requestExit.onLifecycle(event) !== null) return;
    const step = lifecycleFromEvent(event);
    // Not the microphone stream: PCM keeps flowing while the dialog is open and says nothing about the user.
    if (step !== "foregroundExit" && !isFinalExit(step) && (event as { audioEvent?: unknown }).audioEvent === undefined) requestExit.back();
    if (step === "foregroundExit") {
      // Out of sight: the microphone closes (it reopens only on a tap) and
      // the conversation is stored if the user asked for that.
      paused = true;
      pending = null;
      if (voiceSheet !== null) closeSheet();
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
      case "click": {
        // A notice (mic refused, server gone) is read first: the tap only takes it away, back to the start screen.
        if (notice && !listening) { notice = null; break; }
        notice = null;
        // A tap first closes the sheet or a popup; running, it arms the stop.
        // 0.8.0: on the "Meine Stimme" sheet it cancels the recording (nothing is stored).
        if (help !== null) { closeSheet(); break; }
        if (closeShownPopup()) break;
        if (listening) { arm("stop"); break; }
        // Stopped, a summary goes first (back to the start screen); then the tap starts with the row under the cursor.
        const sheet = shownSummary();
        if (sheet) { if (sheet.state !== "working") summaryHidden = true; break; }
        void startFromRow(startRowsNow()[cursor]);
        return;
      }
      case "scrollUp": {
        const now = Date.now();
        lastScrollAt = now;
        if (help !== null) { help = Math.max(0, help - 1); break; }
        if (!listening && shownSummary()?.state === "done") {
          // Page 0 of the text: back to the cockpit picture, when the conversation has one.
          if (summaryPage === 0 && !summaryCockpit && talkStats(log)) summaryCockpit = true;
          else summaryPage = Math.max(0, summaryPage - 1);
          break;
        }
        // Stopped, a swipe only moves the cursor of the start screen.
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
        if (!listening && paged?.state === "done" && cockpitNow()) { summaryCockpit = false; summaryPage = 0; break; }
        if (!listening && paged?.state === "done") {
          summaryPage = Math.min(summaryPage + 1, summaryPageCount(paged.short, paged.long ?? []) - 1);
          break;
        }
        if (!listening) { if (!shownSummary()) cursor = Math.min(startRowsNow().length - 1, cursor + 1); break; }
        // Already at the live edge (and not the tail of the swipe that got there): translate my last sentence
        // into the conversation language. Only "Übersetzen" has that; the other modes just stay at the live edge.
        if (offset === 0 && settled) { if (talkMode() === "translate") void translateMyLast(); return; }
        offset = Math.max(0, offset - rows);
        break;
      }
      case "longPress": {
        // A hold never arrives on the real glasses (the system menu opens), so nothing depends on it.
        // Where it does arrive (simulator), during captions it is the manual Wortfinder.
        // Nothing on the glasses clears the transcript: that is only possible on the phone (0.6.1).
        if (listening) { void findWordNow(); return; }
        return;
      }
      case "doubleClick":
        // Back one level first (sheet, popup); then, running, stop and go back to the start screen (no exit);
        // only on the start screen itself it leaves (the system exit dialog).
        if (help !== null) { closeSheet(); break; }
        if (closeShownPopup()) break;
        if (listening) { notice = null; void stopListening(true); return; }
        // Stopped, a finished summary goes back to the start screen first.
        if (shownSummary() && summary?.state !== "working") { summaryHidden = true; break; }
        // Backgrounded (a genuine 5 without a dialog): come back first and ask only after the restore draw.
        if (paused) {
          paused = false;
          rebuildWanted = true;
          void settleRestore(draw()).then(exitWithDialog);
          return;
        }
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
    onLearnVoice: () => { void startEnrollment(); },
    onDeleteVoice: () => { void deleteVoice(); },
    onPickCustomer: (id) => {
      // The phone can set (or take away) the customer of the conversation that runs or is about to start.
      const entry = customerList.state === "ready" && id ? customerList.entries.find((candidate) => candidate.id === id) ?? null : null;
      sessionCustomer = entry;
      if (entry) { setSessionCustomer(entry.id); refreshCustomer(); }
      else { customer = null; customerRun++; setSessionCustomer(companionConfigured(data) ? "-" : null); }
      schedulePhone();
      void draw();
    },
    onSummarize: () => { void summarize(); },
    onClearTranscript: clearConversation,
    onDeleteWord: (word) => {
      words = removeVocab(words, word);
      void saveVocab(bridge, words).catch(() => undefined);
      schedulePhone();
    },
    onClearWords: () => {
      words = [];
      void saveVocab(bridge, words).catch(() => undefined);
      schedulePhone();
    },
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
  return a.sttUrl !== b.sttUrl || a.sttToken !== b.sttToken || a.sourceLanguage !== b.sourceLanguage || a.persons !== b.persons;
}

void boot().catch((error: unknown) => {
  console.error("[babelglass] failed to start:", error);
});
