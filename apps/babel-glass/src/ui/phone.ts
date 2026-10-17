import {
  companionConfigured, isPlainHttp, maskSecret, translationEnabled, usesMockStt, validateHttpUrl,
  validateWsUrl, type BabelData, type TranslateProvider,
} from "../storage/persist";
import { MODE_PRESETS, type CaptionMode } from "../glasses/view";
import {
  AUTO, CUSTOM, LANGUAGES, readLanguageChoice, selectValueFor,
} from "../text/languages";
import { languageSelect, type Locale } from "../i18n";
import { t } from "../messages";
import { clockLabel, type TranscriptEntry } from "../companion/transcript";
import type { Insight } from "../companion/llm";
import { memoryDate, memoryExport, type MemoryClient, type MemoryEntry } from "../companion/memory";
import type { SpeakerChoice } from "../companion/wordfinder";
import type { VocabEntry } from "../companion/vocab";
import type { HelperToggle, OverviewInput } from "../companion/overview";
import type { PopupKind } from "../companion/popups";
import { cuesHtml, type CueCard } from "../companion/cues";

/** A popup as kept for the phone: labelled like on the glasses. */
export type PhoneInsight = Insight & { readonly kind?: PopupKind };

/** What the conversation card shows; owned by main.ts, read on every redraw. */
export interface ConversationState {
  readonly log: readonly TranscriptEntry[];
  /** The provisional line, if the recogniser is still revising one. */
  readonly pending: string | null;
  readonly summary:
    /** `long`: the detailed summary so far, while it is being written. */
    | { readonly state: "working"; readonly long?: readonly string[] }
    | { readonly state: "done"; readonly long: readonly string[] }
    | { readonly state: "error"; readonly error: string }
    | null;
  readonly insights: readonly PhoneInsight[];
  /** A summary can be asked for (language model configured or demo). */
  readonly canSummarize: boolean;
  /** 0.5.0: settings and live state for the overview table. */
  readonly overview?: OverviewInput;
  /** 0.6.2: "Kunde (Shoot Day): <name> – n Ideen, m Storyboards" when the proxy reports one. */
  readonly customerLine?: string;
  /** The mode in force (Übersetzen / Englisch sprechen / Gespräch), shown as three buttons. */
  readonly talkMode?: "client" | "translate" | "learn";
  /** Tipp-Karten shown on the glasses in this conversation (oldest first). */
  readonly cues?: readonly CueCard[];
  /** 0.9.0: "Meine Wörter", newest first. */
  readonly words?: readonly VocabEntry[];
  /** 1.0.0: the customers of the start screen's list and the one picked, for the picker under "Gespräch". */
  readonly customers?: readonly { readonly id: string; readonly name: string }[];
  readonly customerId?: string | null;
  /** 1.0.0: the "Meine Stimme" card. */
  readonly voice?: VoiceUiState;
}

/** The "Meine Stimme" card: trained or not, and the step of a running enrollment or deletion. */
export interface VoiceUiState {
  readonly trained: boolean;
  readonly phase: "idle" | "connecting" | "reading" | "saving" | "deleting" | "done" | "error";
  /** Result or problem of the last action (already in the UI language). */
  readonly message?: string;
}

/**
 * The phone companion: UI language, caption languages, mode and — under
 * "Advanced" — the servers.
 *
 * Credentials are write-only here — once saved, the field reports only that a
 * secret is set and how long it is.
 */

export interface PhoneUiPorts {
  readonly getData: () => BabelData;
  readonly setData: (data: BabelData) => Promise<void>;
  /** UI language; English when the host does not provide one. */
  readonly getLocale?: () => Locale;
  /** The user picked another UI language: the host persists it and redraws the glasses. */
  readonly setLocale?: (locale: Locale) => void;
  /** Conversation companion: transcript, summary, explanations. */
  readonly getConversation?: () => ConversationState;
  readonly onSummarize?: () => void;
  readonly onClearTranscript?: () => void;
  /** 0.9.0 "Meine Wörter": delete one word / all of them. */
  readonly onDeleteWord?: (word: string) => void;
  readonly onClearWords?: () => void;
  /** Babel's own memory on the babel-llm-proxy; null = no language-model server set. */
  readonly getMemory?: () => MemoryClient | null;
  /** 1.0.0 "Meine Stimme": start the voice recording on the glasses / delete the voice print on the server. */
  readonly onLearnVoice?: () => void;
  readonly onDeleteVoice?: () => void;
  /** 1.0.0: the customer for "Gespräch" picked on the phone; null = none. */
  readonly onPickCustomer?: (id: string | null) => void;
}

/** What the "Gedächtnis" tab shows; loaded from the proxy, kept across redraws. */
export interface MemoryViewState {
  readonly status: "loading" | "ready" | "unavailable" | "unauthorized" | "none";
  readonly entries: readonly MemoryEntry[];
  /** Enabled in the settings (when off, stored entries can still be seen and deleted). */
  readonly enabled: boolean;
  /** "Delete everything" was tapped once and waits for the second tap. */
  readonly confirmClear?: boolean;
  /** The export text, once asked for. */
  readonly exportText?: string;
  /** A short message after an action (saved, failed …). */
  readonly message?: string;
}

const PROVIDERS: readonly TranslateProvider[] = ["libretranslate", "openai"];

/** Minimal DOM surface the UI needs; lets tests drive it without a browser. */
export interface UiRoot {
  innerHTML: string;
  querySelector<T extends Element>(selector: string): T | null;
  /** Optional: the tab bar needs it; test stand-ins without it simply show everything. */
  querySelectorAll?<T extends Element>(selector: string): ArrayLike<T>;
}

/** Three tabs only (1.0.0): what runs now, the words found, and everything that is set up once. */
const TABS: readonly { id: string; icon: string; key: string }[] = [
  { id: "now", icon: "💬", key: "p.tabNow" },
  { id: "words", icon: "📖", key: "p.tabWords" },
  { id: "settings", icon: "⚙️", key: "p.tabSettings" },
];
const TAB_KEY = "quietglass.babel-glass.tab";

/** Nothing set up yet (no speech server, no voice): Einstellungen opens with the 3-step checklist. */
export function isFirstRun(data: BabelData): boolean {
  return usesMockStt(data) && !companionConfigured(data) && !data.voiceEnrolled;
}

function readTab(firstRun: boolean): string {
  try {
    const v = localStorage.getItem(TAB_KEY);
    if (TABS.some((tab) => tab.id === v)) return v!;
  } catch { /* no storage */ }
  return firstRun ? "settings" : "now";
}

/** Shows only the active tab; the choice survives redraws and restarts. */
function applyTab(root: UiRoot, active: string): void {
  Array.from(root.querySelectorAll?.<HTMLElement>("[data-tab]") ?? []).forEach((el) => { el.hidden = el.dataset["tab"] !== active; });
  Array.from(root.querySelectorAll?.<HTMLButtonElement>("[data-tab-go]") ?? []).forEach((button) => {
    const on = button.dataset["tabGo"] === active;
    button.classList.toggle("on", on);
    button.setAttribute("aria-selected", String(on));
  });
}

export function mountPhoneUi(ports: PhoneUiPorts): void {
  const root = document.getElementById("app");
  if (root) mountPhoneUiInto(root, ports);
}

export function mountPhoneUiInto(root: UiRoot, ports: PhoneUiPorts): void {
  let tab = readTab(isFirstRun(ports.getData()));
  const memory = createMemoryTab(root, ports);
  const render = (notice = ""): void => {
    const locale = ports.getLocale?.() ?? "en";
    try {
      const html = globalThis.document?.documentElement;
      if (html) html.lang = locale;
    } catch { /* no document outside the WebView */ }
    root.innerHTML = template(ports.getData(), notice, locale, ports.getConversation?.() ?? null);
    applyTab(root, tab);
    Array.from(root.querySelectorAll?.<HTMLButtonElement>("[data-tab-go]") ?? []).forEach((button) => {
      button.addEventListener("click", () => {
        tab = button.dataset["tabGo"] ?? "now";
        try { localStorage.setItem(TAB_KEY, tab); } catch { /* private mode */ }
        applyTab(root, tab);
        // The memory is read fresh whenever the settings are opened.
        if (tab === "settings") void memory.load();
        try { window.scrollTo({ top: 0 }); } catch { /* no window outside the WebView */ }
      });
    });
    wire(root, ports, render);
    memory.attach();
  };
  render();
  if (ports.getMemory) void memory.load();
}

/**
 * Redraws only the conversation card (called for every new line), so the
 * settings form below is never rebuilt while someone types in it.
 */
export function renderConversation(root: UiRoot, state: ConversationState, locale: Locale): void {
  const paint = (selector: string, html: string): void => {
    const el = root.querySelector<HTMLElement>(selector);
    // Controls (the mode buttons, the pickers) are only rebuilt when they changed, so an open picker is not closed by a new line.
    if (el && lastPainted.get(el) !== html) { el.innerHTML = html; lastPainted.set(el, html); }
  };
  if (state.words) paint("#words-body", wordsInner(state.words, locale));
  paint("#now-body", nowInner(state, locale));
  if (state.voice) paint("#voice-body", voiceInner(state.voice, locale));
  const body = root.querySelector<HTMLElement>("#conv-body");
  if (!body) return;
  body.innerHTML = conversationInner(state, locale);
  const lines = root.querySelector<HTMLElement>("#conv-lines");
  if (lines && typeof lines.scrollHeight === "number") lines.scrollTop = lines.scrollHeight;
}

/** What each redrawn control block showed last, to skip identical redraws. */
const lastPainted = new WeakMap<object, string>();

const SPEAKER_CLASSES = "ABCDEFGH";

export function conversationInner(state: ConversationState, locale: Locale): string {
  const x = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  const shown = state.log.slice(-300);
  const lines = shown.map((entry) => {
    // 0.8.0: the user's own voice ("ME") is named "Ich"/"Me" in a colour of its own.
    const who = entry.speaker === "ME"
      ? `<b class="spk spk-me">${escapeHtml(x("g.me"))}</b> `
      : entry.speaker
      ? `<b class="spk spk-${Math.max(0, SPEAKER_CLASSES.indexOf(entry.speaker)) % 4}">${escapeHtml(entry.speaker)}</b> `
      : "";
    const translated = entry.translated ? `<br><small>${escapeHtml(entry.translated)}</small>` : "";
    // 0.5.0: own sentence translated to read out, and the reply idea after the other's line.
    const own = entry.own
      ? `<br><small class="own"><b>${escapeHtml(x("g.lab.say").trim())}</b> ${escapeHtml(entry.own)} <em>${x("p.ownMark")}</em></small>`
      : "";
    const reply = entry.reply ? `<br><small class="reply"><b>${escapeHtml(x("g.lab.reply"))}</b> ${escapeHtml(entry.reply)}</small>` : "";
    return `<p class="line">${who}<span class="time">${clockLabel(entry.at)}</span> ${escapeHtml(entry.text)}${translated}${own}${reply}</p>`;
  });
  if (state.pending) {
    lines.push(`<p class="line pending">… ${escapeHtml(state.pending)} <em>${x("p.convLive")}</em></p>`);
  }
  const customer = state.customerLine ? `<p class="hint customer">${escapeHtml(state.customerLine)}</p>` : "";
  const transcript = customer + (lines.length
    ? `<div id="conv-lines" class="transcript">${lines.join("")}</div>`
    : `<p class="hint">${x("p.convEmpty")}</p>`);

  let summary = "";
  if (state.summary?.state === "working") {
    const sofar = state.summary.long?.length
      ? `<ul class="summary">${state.summary.long.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>`
      : "";
    summary = `<h3>${x("p.summaryTitle")}</h3>${sofar}<p class="hint">${x("p.summaryWorking")}</p>`;
  } else if (state.summary?.state === "error") {
    summary = `<h3>${x("p.summaryTitle")}</h3><p class="hint"><small class="warn">${escapeHtml(x("p.summaryError", { error: state.summary.error }))}</small></p>`;
  } else if (state.summary?.state === "done") {
    summary = `<h3>${x("p.summaryTitle")}</h3><ul class="summary">${state.summary.long.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>`;
  }

  // Every popup carries its kind, like on the glasses ("Info:", "Wort:", "Antwort:", "→").
  const insights = state.insights.length
    ? `<h3>${x("p.insightsTitle")}</h3><ul class="insights">${state.insights.map((i) => {
        const label = escapeHtml(x("g.lab." + (i.kind ?? "info")).trim());
        return i.term
          ? `<li><b>${label} ${escapeHtml(i.term)}</b> — ${escapeHtml(i.info)}</li>`
          : `<li><b>${label}</b> ${escapeHtml(i.info)}</li>`;
      }).join("")}</ul>`
    : "";

  const count = state.log.length ? `<p class="hint">${x("p.lines", { count: state.log.length })}</p>` : "";
  const buttons = state.log.length
    ? `<div class="buttons">
        ${state.canSummarize ? `<button id="summarize" type="button"${state.summary?.state === "working" ? " disabled" : ""}>${x("p.summarize")}</button>` : ""}
        <button id="clear-log" type="button" class="secondary">${x("p.clear")}</button>
      </div>`
    : "";
  return transcript + count + buttons + summary + insights + cuesHtml(state.cues ?? [], locale);
}

/** The mode buttons, the customer picker for "Gespräch" and the state of the glasses (1.0.0). Pure, so tests can read it. */
export function nowInner(state: ConversationState, locale: Locale): string {
  const x = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  const listening = state.overview?.listening ?? false;
  const demo = state.overview ? usesMockStt(state.overview.data) : false;
  const status = `<p class="state ${listening ? "live" : "idle"}"><span class="dot" aria-hidden="true"></span><b>${x(listening ? "p.nowLive" : "p.nowReady")}</b>`
    + `${demo ? ` <span class="tag">${escapeHtml(x("g.mock"))}</span>` : ""}</p>`;
  const modeButton = (mode: "translate" | "learn" | "client"): string =>
    `<button type="button" id="talk-mode-${mode}" data-talk-mode="${mode}" class="${state.talkMode === mode ? "" : "secondary"}" aria-pressed="${state.talkMode === mode}">${escapeHtml(x("g.mode." + mode))}</button>`;
  const modes = state.talkMode
    ? `<div class="modes" role="group" aria-label="${escapeHtml(x("p.nowModeTitle"))}">${modeButton("translate")}${modeButton("learn")}${modeButton("client")}</div>`
    : "";
  const customers = state.talkMode === "client" && state.customers?.length
    ? `<label for="customer-pick">${x("p.nowCustomer")}</label><select id="customer-pick"><option value="">${escapeHtml(x("p.nowNoCustomer"))}</option>`
      + state.customers.map((c) => `<option value="${escapeHtml(c.id)}"${c.id === state.customerId ? " selected" : ""}>${escapeHtml(c.name)}</option>`).join("")
      + "</select>"
    : "";
  return status + modes + customers + `<p class="hint">${x("p.glassesHow")}</p>`;
}

/** The "Meine Stimme" card's inside: status, the how-to and the two buttons (1.0.0). Pure, so tests can read it. */
export function voiceInner(voice: VoiceUiState, locale: Locale): string {
  const x = (key: string): string => t(locale, key);
  const busy = voice.phase === "connecting" || voice.phase === "reading" || voice.phase === "saving" || voice.phase === "deleting";
  const status = `<p class="state ${voice.trained ? "live" : "idle"}"><span class="dot" aria-hidden="true"></span><b>${x(voice.trained ? "p.voiceTrained" : "p.voiceNot")}</b></p>`;
  const progress = busy ? `<p class="progress">${escapeHtml(x("p.voice." + voice.phase))}</p>` : "";
  const result = !busy && voice.message
    ? `<p class="${voice.phase === "error" ? "warn" : "ok"}">${escapeHtml(voice.message)}</p>`
    : "";
  const how = busy ? "" : `<p class="hint">${x("p.voiceHow")}</p>`;
  return status + progress + result + how
    + `<button type="button" id="voice-learn" class="big"${busy ? " disabled" : ""}>${x(voice.trained ? "p.voiceRelearn" : "p.voiceLearn")}</button>`
    + (voice.trained ? `<button type="button" id="voice-delete" class="secondary"${busy ? " disabled" : ""}>${x("p.voiceDelete")}</button>` : "");
}

/** First-run checklist (1.0.0): Server, then voice, then done. Pure, so tests can read it. */
export function setupInner(data: BabelData, locale: Locale): string {
  const x = (key: string): string => t(locale, key);
  const step = (n: number, done: boolean, key: string): string =>
    `<li class="${done ? "done" : ""}"><span class="num" aria-hidden="true">${done ? "✓" : n}</span><span>${x(key)}</span></li>`;
  const server = !usesMockStt(data);
  return `<ol class="steps">${step(1, server, "p.setup1")}${step(2, data.voiceEnrolled, "p.setup2")}${step(3, server && data.voiceEnrolled, "p.setup3")}</ol>`
    + (server ? "" : `<p class="hint">${x("p.setupDemo")}</p>`);
}

/** "Meine Wörter" (0.9.0): word → German meaning, alternatives below, one delete button each. Pure, so tests can read it. */
export function wordsInner(words: readonly VocabEntry[], locale: Locale): string {
  const x = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  if (words.length === 0) return `<p class="hint">${x("p.wordsEmpty")}</p>`;
  const items = words.map((entry) => {
    const meaning = entry.meaning ? ` → ${escapeHtml(entry.meaning)}` : "";
    const more = entry.alternatives.length ? `<br><small>${entry.alternatives.map(escapeHtml).join(" · ")}</small>` : "";
    return `<li><b>${escapeHtml(entry.word)}</b>${meaning}${more}`
      + ` <button type="button" class="secondary small" data-word-del="${escapeHtml(entry.word)}">${x("p.wordsDelete")}</button></li>`;
  });
  return `<p class="count">${x("p.wordsCount", { count: words.length })}</p><ul class="memory">${items.join("")}</ul>`
    + `<div class="buttons"><button id="words-clear" type="button" class="secondary">${x("p.wordsClear")}</button></div>`;
}

/** The inside of the "Gedächtnis" card (pure, so tests can read it). */
export function memoryInner(state: MemoryViewState, locale: Locale): string {
  const x = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  const message = state.message ? `<p class="hint"><small>${escapeHtml(state.message)}</small></p>` : "";
  if (state.status === "none") return `<p class="hint">${x("p.memNoLlm")}</p>`;
  if (state.status === "unavailable") return `<p class="hint">${x("p.memUnavailable")}</p>${reloadButton(x)}`;
  if (state.status === "unauthorized") return `<p class="hint"><small class="warn">${x("p.memUnauthorized")}</small></p>${reloadButton(x)}`;
  if (state.status === "loading") return `<p class="hint">${x("p.memLoading")}</p>`;
  const off = state.enabled ? "" : `<p class="hint">${x("p.memOff")}</p>`;
  const list = state.entries.length
    ? `<p class="hint">${x("p.memCount", { count: state.entries.length })}</p><ul class="memory">${state.entries.map((entry) => {
        const kind = entry.type === "note" ? x("p.memNote") : x("p.memSession");
        const agreements = entry.agreements.length
          ? `<br><small>${x("p.memAgreements")}: ${entry.agreements.map(escapeHtml).join(" · ")}</small>`
          : "";
        return `<li><span class="time">${escapeHtml(memoryDate(entry.date, locale))} · ${kind}</span> <b>${escapeHtml(entry.title)}</b>`
          + `<br><small>${escapeHtml(entry.summary)}</small>${agreements}`
          + ` <button type="button" class="secondary small" data-mem-del="${escapeHtml(entry.id)}">${x("p.memDelete")}</button></li>`;
      }).join("")}</ul>`
    : `<p class="hint">${x("p.memEmpty")}</p>`;
  const exported = state.exportText !== undefined
    ? `<p class="hint">${x("p.memExportHint")}</p><textarea id="mem-export-text" readonly rows="8">${escapeHtml(state.exportText)}</textarea>`
    : "";
  return off + message + `
    <label for="mem-note">${x("p.memNoteLabel")}</label>
    <textarea id="mem-note" rows="3" placeholder="${escapeHtml(x("p.memNotePlaceholder"))}"></textarea>
    <div class="buttons"><button id="mem-add" type="button">${x("p.memAddNote")}</button></div>
    ${list}
    <div class="buttons">
      ${state.entries.length ? `<button id="mem-export" type="button" class="secondary">${x("p.memExport")}</button>` : ""}
      ${state.entries.length ? `<button id="mem-clear" type="button" class="secondary">${state.confirmClear ? x("p.memClearConfirm") : x("p.memClearAll")}</button>` : ""}
      <button id="mem-reload" type="button" class="secondary">${x("p.memReload")}</button>
    </div>
    ${exported}`;
}

function reloadButton(x: (key: string) => string): string {
  return `<div class="buttons"><button id="mem-reload" type="button" class="secondary">${x("p.memReload")}</button></div>`;
}

/**
 * Loads and changes the memory behind the "Gedächtnis" tab. Every failure
 * becomes a status ("nicht verfügbar"), never an exception.
 */
function createMemoryTab(root: UiRoot, ports: PhoneUiPorts) {
  let state: MemoryViewState = { status: "loading", entries: [], enabled: ports.getData().memory };
  let busy = false;
  const locale = (): Locale => ports.getLocale?.() ?? "en";
  const paint = (): void => {
    const body = root.querySelector<HTMLElement>("#mem-body");
    if (body) body.innerHTML = memoryInner({ ...state, enabled: ports.getData().memory }, locale());
  };
  const statusOf = (error: string): MemoryViewState["status"] => (error === "unauthorized" ? "unauthorized" : "unavailable");
  const load = async (message?: string): Promise<void> => {
    const client = ports.getMemory?.() ?? null;
    if (!client) { state = { ...state, status: "none", entries: [] }; paint(); return; }
    if (state.status !== "ready") { state = { ...state, status: "loading" }; paint(); }
    const result = await client.list(500);
    state = result.ok
      ? { status: "ready", entries: result.value, enabled: ports.getData().memory, ...(message ? { message } : {}) }
      : { status: statusOf(result.error), entries: [], enabled: ports.getData().memory };
    paint();
  };
  const act = async (run: (client: MemoryClient) => Promise<{ ok: boolean; error?: string }>, done?: string): Promise<void> => {
    const client = ports.getMemory?.() ?? null;
    if (!client || busy) return;
    busy = true;
    try {
      const result = await run(client);
      if (!result.ok) {
        state = { ...state, message: t(locale(), "p.memFailed", { error: result.error ?? "?" }) };
        paint();
        return;
      }
      await load(done);
    } finally {
      busy = false;
    }
  };
  const onClick = (event: Event): void => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    const del = target.dataset?.["memDel"];
    if (del) { void act((client) => client.remove(del)); return; }
    switch (target.id) {
      case "mem-reload": void load(); return;
      case "mem-add": {
        const field = root.querySelector<HTMLTextAreaElement>("#mem-note");
        const text = field?.value.trim() ?? "";
        if (!text) return;
        const title = (text.split("\n")[0] ?? text).slice(0, 80);
        void act((client) => client.add({ type: "note", date: new Date().toISOString(), title, summary: text }), t(locale(), "p.memSaved"));
        return;
      }
      case "mem-export":
        state = { ...state, exportText: memoryExport(state.entries, locale()) };
        paint();
        return;
      case "mem-clear":
        if (!state.confirmClear) { state = { ...state, confirmClear: true }; paint(); return; }
        state = { ...state, confirmClear: false };
        void act((client) => client.clear());
        return;
      default:
    }
  };
  return {
    /** After a full redraw of the page: paint the kept state and listen again. */
    attach(): void {
      paint();
      root.querySelector<HTMLElement>("#mem")?.addEventListener("click", onClick);
    },
    load,
  };
}

function conversationCard(state: ConversationState | null, locale: Locale): string {
  if (!state) return "";
  return `
  <section class="card" id="conv">
    <h2>${t(locale, "p.convTitle")}</h2>
    <div id="conv-body">${conversationInner(state, locale)}</div>
  </section>`;
}

/** A language as listed in the pickers: its name in the UI language, plus its own name. */
function languageLabel(code: string, native: string, locale: Locale): string {
  const name = t(locale, "l." + code);
  return name === native ? name : name + " — " + native;
}

export function languageOptions(selected: string, allowAuto: boolean, locale: Locale = "en"): string {
  const value = selectValueFor(selected, allowAuto);
  const options = [
    ...(allowAuto ? [{ code: AUTO, label: t(locale, "p.auto") }] : []),
    ...LANGUAGES.map((l) => ({ code: l.code, label: languageLabel(l.code, l.native, locale) })),
    { code: CUSTOM, label: t(locale, "p.custom") },
  ];
  return options.map((o) =>
    '<option value="' + escapeHtml(o.code) + '"' + (o.code === value ? " selected" : "") + ">" +
    escapeHtml(o.label) + "</option>").join("");
}

function languageField(
  id: string, label: string, code: string, allowAuto: boolean, hint: string, locale: Locale,
): string {
  const isCustom = selectValueFor(code, allowAuto) === CUSTOM;
  return `
    <label for="${id}">${label}</label>
    <select id="${id}">${languageOptions(code, allowAuto, locale)}</select>
    <input id="${id}-custom" type="text" ${isCustom ? "" : "hidden"}
      value="${isCustom ? escapeHtml(code) : ""}" placeholder="${escapeHtml(hint)}" aria-label="${escapeHtml(t(locale, "p.codeLabel", { label }))}" />`;
}

function template(data: BabelData, notice: string, locale: Locale, conversation: ConversationState | null = null): string {
  const x = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  const secret = (value: string | undefined): string => escapeHtml(maskSecret(value, locale));
  const openai = data.translateProvider === "openai";
  const chipOn = translationEnabled(data);
  const code = (value: string): string => (value === AUTO ? "auto" : value.toUpperCase());
  const chipText = chipOn ? `${code(data.sourceLanguage)} → ${code(data.targetLanguage)}` : x("p.chipCaptions");
  const serverReady = !usesMockStt(data);
  const voice: VoiceUiState = conversation?.voice ?? { trained: data.voiceEnrolled, phase: "idle" };
  const check = (id: string, checked: boolean, key: string): string =>
    `<label class="check"><input id="${id}" type="checkbox" ${checked ? "checked" : ""} /> ${x(key)}</label>`;
  return `
  <header class="brand bar">
    <div>
      <span class="brand-mark">Quietglass</span>
      <h1>Babel Glass</h1>
    </div>
    <span class="chip${chipOn ? " on" : ""}">${escapeHtml(chipText)}</span>
  </header>

  <p id="notice" class="notice" ${notice ? "" : "hidden"}>${escapeHtml(notice)}</p>

  <div class="tab" data-tab="now">
  ${conversation ? `<section class="card" id="now"><div id="now-body">${nowInner(conversation, locale)}</div></section>` : ""}
  ${conversationCard(conversation, locale)}
  </div>

  <div class="tab" data-tab="words">
  <section class="card" id="words">
    <h2>${x("p.wordsTitle")}</h2>
    <div id="words-body">${wordsInner(conversation?.words ?? [], locale)}</div>
  </section>
  </div>

  <div class="tab" data-tab="settings">
  ${serverReady ? "" : `<section class="card setup" id="setup"><h2>${x("p.setupTitle")}</h2>${setupInner(data, locale)}</section>`}

  <section class="card" id="voice">
    <h2>${x("p.voiceTitle")}</h2>
    <div id="voice-body">${voiceInner(voice, locale)}</div>
  </section>

  <section class="card">
    <h2>${x("p.langTitle")}</h2>
    ${languageField("source", x("p.source"), data.sourceLanguage, true, x("p.codeHintSource"), locale)}
    <p class="hint">${x("p.sourceHint")}</p>
    ${languageField("target", x("p.target"), data.targetLanguage, false, x("p.codeHintTarget"), locale)}
    ${check("learn-translate", data.learnTranslate, "p.learnTranslate")}
    ${check("translit", data.transliterateOriginal, "p.translit")}
    <button id="save" type="button">${x("p.save")}</button>
  </section>

  <section class="card">
    <h2>${x("p.personsTitle")}</h2>
    <select id="persons" aria-label="${escapeHtml(x("p.personsTitle"))}">
      ${[2, 3, 4, 5].map((n) => `<option value="${n}"${n === data.persons ? " selected" : ""}>${escapeHtml(x("p.persons", { n }))}</option>`).join("")}
    </select>
    <p class="hint">${x("p.personsHint")}</p>
  </section>

  <section class="card">
    <h2>${x("p.wordFinderTitle")}</h2>
    ${check("word-auto", data.wordAuto, "p.wordAuto")}
    <p class="hint">${x("p.wordAutoHint")} ${x("p.wordAutoLearn")}</p>
  </section>

  <details class="card fold" id="server"${serverReady ? "" : " open"}>
    <summary><b>${x("p.serverTitle")}</b> <span class="tag">${x(serverReady ? "p.serverReady" : "p.serverMissing")}</span></summary>
    <label for="stt">${x("p.sttServer")}</label>
    <input id="stt" type="text" value="${escapeHtml(data.sttUrl)}" placeholder="wss://your-host:9000/asr" />
    <p class="hint">${x("p.sttServerHint")}</p>
    ${isPlainHttp(data.sttUrl) ? `<p class="hint"><small class="warn">${x("p.warnWs")}</small></p>` : ""}

    <label for="stt-token">${x("p.sttToken")} — <em>${secret(data.sttToken)}</em></label>
    <input id="stt-token" type="password" placeholder="${escapeHtml(x("p.sttTokenPlaceholder"))}" />

    <label for="provider">${x("p.trServer")}</label>
    <select id="provider">
      ${PROVIDERS.map((p) =>
        '<option value="' + p + '"' + (p === data.translateProvider ? " selected" : "") + ">" +
        escapeHtml(x("p.provider." + p)) + "</option>").join("")}
    </select>

    <div id="libre-fields" ${openai ? "hidden" : ""}>
      <label for="translate">${x("p.endpoint")}</label>
      <input id="translate" type="text" value="${escapeHtml(data.translateUrl)}" placeholder="https://your-host:5000/translate" />
      <p class="hint">${x("p.endpointHint")}</p>
      ${isPlainHttp(data.translateUrl) ? `<p class="hint"><small class="warn">${x("p.warnHttp")}</small></p>` : ""}
      <label for="translate-key">${x("p.apiKey")} — <em>${secret(data.translateKey)}</em></label>
      <input id="translate-key" type="password" placeholder="${escapeHtml(x("p.apiKeyPlaceholder"))}" />
    </div>

    <div id="llm-fields" ${openai ? "" : "hidden"}>
      <label for="llm-url">${x("p.llmUrl")}</label>
      <input id="llm-url" type="text" value="${escapeHtml(data.llmUrl)}" placeholder="http://your-host:11434/v1" />
      <label for="llm-model">${x("p.llmModel")}</label>
      <input id="llm-model" type="text" value="${escapeHtml(data.llmModel)}" placeholder="qwen2.5:7b-instruct" />
      ${isPlainHttp(data.llmUrl) ? `<p class="hint"><small class="warn">${x("p.warnHttp")}</small></p>` : ""}
      <label for="llm-key">${x("p.llmKey")} — <em>${secret(data.llmKey)}</em></label>
      <input id="llm-key" type="password" placeholder="${escapeHtml(x("p.llmKeyPlaceholder"))}" />
    </div>
    <button id="save-servers" type="button">${x("p.save")}</button>
  </details>

  <details class="card fold" id="mem">
    <summary><b>${x("p.memTitle")}</b></summary>
    <p class="hint">${x("p.memHint")}</p>
    <div id="mem-body"></div>
  </details>

  <details class="card fold">
    <summary><b>${x("p.moreTitle")}</b></summary>
    ${check("speakers", data.speakers, "p.speakers")}
    ${check("insights", data.insights, "p.insights")}
    ${check("reply-suggestions", data.replySuggestions, "p.replies")}
    ${check("cue-cards", data.cueCards !== false, "p.cues")}
    ${check("translate-own", data.translateOwn, "p.translateOwn")}
    <p class="hint">${x("p.translateOwnHint")}</p>
    ${check("auto-summary", data.autoSummary, "p.autoSummary")}
    ${check("keep-transcript", data.keepTranscript, "p.keepTranscript")}
    <p class="hint">${x("p.keepTranscriptHint")}</p>
    ${check("memory", data.memory, "p.memoryToggle")}
    <p class="hint">${x("p.memoryToggleHint")}</p>
    <label for="my-speaker">${x("p.mySpeaker")}</label>
    <select id="my-speaker">
      ${(["auto", "A", "B"] as const).map((choice) =>
        '<option value="' + choice + '"' + (choice === data.mySpeaker ? " selected" : "") + ">" +
        escapeHtml(choice === "auto" ? x("p.mySpeakerAuto") : choice) + "</option>").join("")}
    </select>
  </details>

  <details class="card fold">
    <summary><b>${x("p.displayTitle")}</b></summary>
    <select id="mode" aria-label="${escapeHtml(x("p.modeTitle"))}">
      ${(Object.keys(MODE_PRESETS) as CaptionMode[]).map((mode) =>
        '<option value="' + mode + '"' + (mode === data.mode ? " selected" : "") + ">" +
        escapeHtml(x("p.mode." + mode)) + "</option>").join("")}
    </select>
    ${check("invert", data.invertScroll, "p.invert")}
    ${languageSelect(locale)}
  </details>

  <footer class="card hint">${x("p.footer")}</footer>
  </div>

  <nav class="tabbar" role="tablist">
    ${TABS.map(({ id, icon, key }) => `<button type="button" role="tab" data-tab-go="${id}"><span aria-hidden="true">${icon}</span>${escapeHtml(x(key))}</button>`).join("")}
  </nav>`;
}

/** Raw field values as read from the form. */
export interface FormValues {
  readonly sttUrl: string;
  readonly sttToken: string;
  readonly source: string;
  readonly sourceCustom: string;
  readonly provider: string;
  readonly translateUrl: string;
  readonly translateKey: string;
  readonly llmUrl: string;
  readonly llmModel: string;
  readonly llmKey: string;
  readonly target: string;
  readonly targetCustom: string;
  readonly transliterate: boolean;
}

export type FormResult =
  | { readonly ok: true; readonly data: BabelData }
  | { readonly ok: false; readonly errors: readonly string[] };

/** Validates the form and merges it into the stored settings. Pure; errors come in `locale`. */
export function applyForm(current: BabelData, form: FormValues, locale: Locale = "en"): FormResult {
  const sttUrl = form.sttUrl.trim();
  const translateUrl = form.translateUrl.trim();
  const llmUrl = form.llmUrl.trim();
  const llmModel = form.llmModel.trim();
  const translateProvider: TranslateProvider = form.provider === "openai" ? "openai" : "libretranslate";

  const errors = [
    ...validateWsUrl(sttUrl).errors,
    ...validateHttpUrl(translateUrl).errors,
    ...validateHttpUrl(llmUrl, "llm").errors,
  ];
  if (translateProvider === "openai" && llmUrl && !llmModel) {
    errors.push("e.model");
  }
  if (errors.length > 0) return { ok: false, errors: errors.map((key) => t(locale, key)) };

  const keep = <K extends "sttToken" | "translateKey" | "llmKey">(key: K, typed: string) =>
    // An empty field means "leave the stored secret alone", not "clear it".
    typed ? { [key]: typed } : current[key] ? { [key]: current[key] } : {};

  return {
    ok: true,
    data: {
      ...current,
      sttUrl,
      translateProvider,
      translateUrl,
      llmUrl,
      llmModel,
      ...keep("sttToken", form.sttToken),
      ...keep("translateKey", form.translateKey),
      ...keep("llmKey", form.llmKey),
      sourceLanguage: readLanguageChoice(form.source, form.sourceCustom, current.sourceLanguage, true),
      targetLanguage: readLanguageChoice(form.target, form.targetCustom, current.targetLanguage, false),
      transliterateOriginal: form.transliterate,
    },
  };
}

function wire(root: UiRoot, ports: PhoneUiPorts, render: (notice?: string) => void): void {
  const byId = <T extends Element>(id: string): T | null => root.querySelector<T>("#" + id);
  const value = (id: string): string => byId<HTMLInputElement>(id)?.value ?? "";
  // Always merge into the *current* settings: the page is not re-rendered on
  // these immediate changes, so a value captured at render time would be
  // stale and silently undo the previous change.
  const commit = (change: Partial<BabelData>): void => {
    void ports.setData({ ...ports.getData(), ...change });
  };

  byId<HTMLSelectElement>("language")?.addEventListener("change", (event) => {
    const value = (event.target as HTMLSelectElement).value;
    ports.setLocale?.(value === "de" ? "de" : "en");
    render();
  });

  byId<HTMLSelectElement>("mode")?.addEventListener("change", (event) => {
    commit({ mode: (event.target as HTMLSelectElement).value as CaptionMode });
  });

  byId<HTMLInputElement>("invert")?.addEventListener("change", (event) => {
    commit({ invertScroll: (event.target as HTMLInputElement).checked });
  });

  byId<HTMLInputElement>("cue-cards")?.addEventListener("change", (event) => {
    commit({ cueCards: (event.target as HTMLInputElement).checked });
  });

  byId<HTMLSelectElement>("my-speaker")?.addEventListener("change", (event) => {
    const value = (event.target as HTMLSelectElement).value;
    commit({ mySpeaker: (value === "A" || value === "B" ? value : "auto") as SpeakerChoice });
  });

  const settingIds: ReadonlyArray<readonly [string, HelperToggle]> = [
    ["speakers", "speakers"], ["insights", "insights"], ["reply-suggestions", "replySuggestions"], ["translate-own", "translateOwn"],
    ["auto-summary", "autoSummary"], ["keep-transcript", "keepTranscript"], ["memory", "memory"],
    ["word-auto", "wordAuto"],
  ];
  for (const [id, key] of settingIds) {
    byId<HTMLInputElement>(id)?.addEventListener("change", (event) => {
      const checked = (event.target as HTMLInputElement).checked;
      commit({ [key]: checked } as Partial<BabelData>);
    });
  }

  byId<HTMLSelectElement>("persons")?.addEventListener("change", (event) => {
    commit({ persons: Number((event.target as HTMLSelectElement).value) });
  });
  byId<HTMLInputElement>("learn-translate")?.addEventListener("change", (event) => {
    commit({ learnTranslate: (event.target as HTMLInputElement).checked });
  });

  // The mode buttons and the customer picker are redrawn with the conversation, so listen on the card.
  byId<HTMLElement>("now")?.addEventListener("click", (event) => {
    const mode = (event.target as HTMLElement | null)?.dataset?.["talkMode"];
    if (mode === "client" || mode === "translate" || mode === "learn") commit({ talkMode: mode });
  });
  byId<HTMLElement>("now")?.addEventListener("change", (event) => {
    const target = event.target as HTMLSelectElement | null;
    if (target?.id === "customer-pick") ports.onPickCustomer?.(target.value || null);
  });

  // "Meine Stimme" (1.0.0): record on the glasses / delete on the server; its card is redrawn, so listen on the card.
  byId<HTMLElement>("voice")?.addEventListener("click", (event) => {
    const id = (event.target as HTMLElement | null)?.id;
    if (id === "voice-learn") ports.onLearnVoice?.();
    if (id === "voice-delete" && window.confirm(t(ports.getLocale?.() ?? "en", "p.voiceDeleteConfirm"))) ports.onDeleteVoice?.();
  });

  // "Meine Wörter" (0.9.0): its list is redrawn with the conversation, so listen on the card.
  byId<HTMLElement>("words")?.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null;
    const word = target?.dataset?.["wordDel"];
    if (word) ports.onDeleteWord?.(word);
    if (target?.id === "words-clear" && window.confirm(t(ports.getLocale?.() ?? "en", "p.wordsClearConfirm"))) ports.onClearWords?.();
  });

  // The conversation card is redrawn on its own; listen on the card, not the buttons.
  byId<HTMLElement>("conv")?.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null;
    const id = target?.id ?? "";
    if (id === "summarize") ports.onSummarize?.();
    if (id === "clear-log" && window.confirm(t(ports.getLocale?.() ?? "en", "p.clearConfirm"))) ports.onClearTranscript?.();
  });

  byId<HTMLSelectElement>("provider")?.addEventListener("change", (event) => {
    const openai = (event.target as HTMLSelectElement).value === "openai";
    const libre = byId<HTMLElement>("libre-fields");
    const llm = byId<HTMLElement>("llm-fields");
    if (libre) libre.hidden = openai;
    if (llm) llm.hidden = !openai;
  });

  for (const id of ["source", "target"]) {
    byId<HTMLSelectElement>(id)?.addEventListener("change", (event) => {
      const custom = byId<HTMLInputElement>(id + "-custom");
      if (custom) custom.hidden = (event.target as HTMLSelectElement).value !== CUSTOM;
    });
  }

  const save = (): void => {
    const locale = ports.getLocale?.() ?? "en";
    const result = applyForm(ports.getData(), {
      sttUrl: value("stt"),
      sttToken: value("stt-token"),
      source: value("source"),
      sourceCustom: value("source-custom"),
      provider: value("provider"),
      translateUrl: value("translate"),
      translateKey: value("translate-key"),
      llmUrl: value("llm-url"),
      llmModel: value("llm-model"),
      llmKey: value("llm-key"),
      target: value("target"),
      targetCustom: value("target-custom"),
      transliterate: byId<HTMLInputElement>("translit")?.checked ?? false,
    }, locale);
    if (!result.ok) {
      // Report in place: re-rendering would throw away what was typed.
      const notice = byId<HTMLElement>("notice");
      if (notice) { notice.textContent = result.errors.join(" "); notice.hidden = false; }
      try { window.scrollTo({ top: 0 }); } catch { /* no window outside the WebView */ }
      return;
    }
    void ports.setData(result.data).then(() => render(t(locale, "p.saved")));
  };
  byId<HTMLButtonElement>("save")?.addEventListener("click", save);
  byId<HTMLButtonElement>("save-servers")?.addEventListener("click", save);
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}
