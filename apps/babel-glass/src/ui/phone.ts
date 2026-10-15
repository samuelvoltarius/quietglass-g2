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
import { helperRows, type HelperToggle, type OverviewInput } from "../companion/overview";
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
  /** 0.6.3: the mode in force (Kundengespräch / Übersetzen), shown as a two-button toggle. */
  readonly talkMode?: "client" | "translate";
  /** Tipp-Karten shown on the glasses in this conversation (oldest first). */
  readonly cues?: readonly CueCard[];
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
  /** Babel's own memory on the babel-llm-proxy; null = no language-model server set. */
  readonly getMemory?: () => MemoryClient | null;
  /** 0.5.0: show the help screen ("what runs when") on the glasses. */
  readonly onShowHelp?: () => void;
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

/** The page is split into tabs instead of one long column (Alfred, 13.10.2026). */
const TABS: readonly { id: string; icon: string; key: string }[] = [
  { id: "talk", icon: "💬", key: "p.tabTalk" },
  { id: "languages", icon: "🌐", key: "p.tabLanguages" },
  { id: "memory", icon: "🧠", key: "p.tabMemory" },
  { id: "glasses", icon: "👓", key: "p.tabGlasses" },
  { id: "connection", icon: "📡", key: "p.tabConn" },
  { id: "more", icon: "⚙️", key: "p.tabMore" },
];
const TAB_KEY = "quietglass.babel-glass.tab";

function readTab(): string {
  try { const v = localStorage.getItem(TAB_KEY); return TABS.some((tab) => tab.id === v) ? v! : "talk"; } catch { return "talk"; }
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
  let tab = readTab();
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
        tab = button.dataset["tabGo"] ?? "talk";
        try { localStorage.setItem(TAB_KEY, tab); } catch { /* private mode */ }
        applyTab(root, tab);
        // The memory is read fresh whenever its tab is opened.
        if (tab === "memory") void memory.load();
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
  const overview = root.querySelector<HTMLElement>("#ov-body");
  if (overview && state.overview) overview.innerHTML = overviewInner(state.overview, locale);
  const body = root.querySelector<HTMLElement>("#conv-body");
  if (!body) return;
  body.innerHTML = conversationInner(state, locale);
  const lines = root.querySelector<HTMLElement>("#conv-lines");
  if (lines && typeof lines.scrollHeight === "number") lines.scrollTop = lines.scrollHeight;
}

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
  const modeButton = (mode: "client" | "translate", key: string): string =>
    `<button type="button" id="talk-mode-${mode}" data-talk-mode="${mode}" class="${state.talkMode === mode ? "" : "secondary"}" aria-pressed="${state.talkMode === mode}">${x(key)}</button>`;
  const modeToggle = state.talkMode
    ? `<div class="talk-mode"><strong>${x("p.talkModeTitle")}:</strong> <span class="buttons">${modeButton("client", "p.mode.clientBtn")}${modeButton("translate", "p.mode.translateBtn")}</span><p class="hint">${x("p.modeHint")}</p></div>`
    : "";
  const transcript = modeToggle + customer + (lines.length
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

/**
 * The overview table (0.5.0): every helper, its trigger, its state now and,
 * where it has one, its switch. Pure, so tests can read it.
 */
export function overviewInner(input: OverviewInput, locale: Locale): string {
  const x = (key: string, vars: Record<string, string> = {}): string => t(locale, key, vars);
  const rows = helperRows(input).map((row) => {
    const toggle = row.toggle
      ? `<input type="checkbox" data-ov-toggle="${row.toggle}" aria-label="${escapeHtml(x("g.hlp." + row.id))}"${input.data[row.toggle] ? " checked" : ""} />`
      : "";
    return `<tr class="${row.on ? "on" : "off"}" data-helper="${row.id}"><td>${toggle}</td><td><b>${escapeHtml(x("g.hlp." + row.id))}</b><br><small>${escapeHtml(x("g.trg." + row.id))}</small></td>`
      + `<td class="state">${escapeHtml(x(row.status, row.vars ?? {}))}</td></tr>`;
  });
  return `<table class="keys overview"><thead><tr><th>${x("p.ovSwitch")}</th><th>${x("p.ovHelper")} · ${x("p.ovTrigger")}</th><th>${x("p.ovStatus")}</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

function overviewCard(state: ConversationState | null, locale: Locale): string {
  if (!state?.overview) return "";
  return `
  <section class="card" id="ov">
    <h2>${t(locale, "p.ovTitle")}</h2>
    <div id="ov-body">${overviewInner(state.overview, locale)}</div>
    <p class="hint">${t(locale, "p.ovHint")}</p>
    <div class="buttons"><button id="ov-help" type="button" class="secondary">${t(locale, "p.ovHelpGlasses")}</button></div>
  </section>`;
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
  return `
  <header class="brand bar">
    <div>
      <span class="brand-mark">Quietglass</span>
      <h1>Babel Glass</h1>
    </div>
    <span class="chip${chipOn ? " on" : ""}">${escapeHtml(chipText)}</span>
  </header>

  <p id="notice" class="notice" ${notice ? "" : "hidden"}>${escapeHtml(notice)}</p>

  <div class="tab" data-tab="talk">
  ${overviewCard(conversation, locale)}
  ${conversationCard(conversation, locale)}

  ${usesMockStt(data) ? `
  <section class="card">
    <h2>${x("p.mockTitle")}</h2>
    <p class="hint">${x("p.mockBody", { mock: x("g.mock") })}</p>
  </section>` : ""}

  <section class="card">
    <h2>${x("p.companionTitle")}</h2>
    <label class="check"><input id="speakers" type="checkbox" ${data.speakers ? "checked" : ""} /> ${x("p.speakers")}</label>
    <p class="hint">${x("p.speakersHint")}</p>
    <label class="check"><input id="insights" type="checkbox" ${data.insights ? "checked" : ""} /> ${x("p.insights")}</label>
    <label class="check"><input id="reply-suggestions" type="checkbox" ${data.replySuggestions ? "checked" : ""} /> ${x("p.replies")}</label>
    <p class="hint">${x("p.repliesHint")}</p>
    <label class="check"><input id="cue-cards" type="checkbox" ${data.cueCards !== false ? "checked" : ""} /> ${x("p.cues")}</label>
    <p class="hint">${x("p.cuesHint")}</p>
    <label class="check"><input id="translate-own" type="checkbox" ${data.translateOwn ? "checked" : ""} /> ${x("p.translateOwn")}</label>
    <p class="hint">${x("p.translateOwnHint")}</p>
    <label class="check"><input id="auto-summary" type="checkbox" ${data.autoSummary ? "checked" : ""} /> ${x("p.autoSummary")}</label>
    <label class="check"><input id="keep-transcript" type="checkbox" ${data.keepTranscript ? "checked" : ""} /> ${x("p.keepTranscript")}</label>
    <p class="hint">${x("p.keepTranscriptHint")}</p>
    <label for="my-speaker">${x("p.mySpeaker")}</label>
    <select id="my-speaker">
      ${(["auto", "A", "B"] as const).map((choice) =>
        '<option value="' + choice + '"' + (choice === data.mySpeaker ? " selected" : "") + ">" +
        escapeHtml(choice === "auto" ? x("p.mySpeakerAuto") : choice) + "</option>").join("")}
    </select>
    <p class="hint">${x("p.mySpeakerHint")}</p>
    <label class="check"><input id="memory" type="checkbox" ${data.memory ? "checked" : ""} /> ${x("p.memoryToggle")}</label>
    <p class="hint">${x("p.memoryToggleHint")}</p>
    <p class="hint">${companionConfigured(data) ? x("p.companionLlm") : x("p.companionNoLlm")}</p>
  </section>
  </div>

  <div class="tab" data-tab="languages">
  <section class="card">
    <h2>${x("p.sttTitle")}</h2>
    ${languageField("source", x("p.source"), data.sourceLanguage, true, x("p.codeHintSource"), locale)}
    <p class="hint">${x("p.sourceHint")}</p>
  </section>

  <section class="card">
    <h2>${x("p.trTitle")}</h2>
    ${languageField("target", x("p.target"), data.targetLanguage, false, x("p.codeHintTarget"), locale)}
    <p class="hint">${x("p.directionHint")}</p>

    <label class="check"><input id="translit" type="checkbox" ${data.transliterateOriginal ? "checked" : ""} /> ${x("p.translit")}</label>
    <p class="hint">${x("p.translitHint")}</p>

    <p class="hint">${x("p.trState", { state: translationEnabled(data) ? x("p.on") : x("p.off") })}</p>
    <button id="save" type="button">${x("p.save")}</button>
  </section>
  </div>

  <div class="tab" data-tab="glasses">
  <section class="card">
    <h2>${x("p.modeTitle")}</h2>
    <select id="mode">
      ${(Object.keys(MODE_PRESETS) as CaptionMode[]).map((mode) =>
        '<option value="' + mode + '"' + (mode === data.mode ? " selected" : "") + ">" +
        escapeHtml(x("p.mode." + mode)) + "</option>").join("")}
    </select>
    <label class="check"><input id="invert" type="checkbox" ${data.invertScroll ? "checked" : ""} /> ${x("p.invert")}</label>
  </section>

  <section class="card">
    <h2>${x("p.controlsTitle")}</h2>
    <table class="keys">
      <tr><td>${x("p.tap")}</td><td>${x("p.tapDo")}</td></tr>
      <tr><td>${x("p.swipe")}</td><td>${x("p.swipeDo")}</td></tr>
      <tr><td>${x("p.hold")}</td><td>${x("p.holdDo")}</td></tr>
      <tr><td>${x("p.double")}</td><td>${x("p.doubleDo")}</td></tr>
    </table>
    <p class="hint">${x("p.controlsHint", { mic: x("g.mic") })}</p>
  </section>
  </div>

  <div class="tab" data-tab="memory">
  <section class="card" id="mem">
    <h2>${x("p.memTitle")}</h2>
    <p class="hint">${x("p.memHint")}</p>
    <div id="mem-body"></div>
  </section>
  </div>

  <div class="tab" data-tab="connection">
  <section class="card">
    <h2>${x("p.serverSttTitle")}</h2>
    <label for="stt">${x("p.sttServer")}</label>
    <input id="stt" type="text" value="${escapeHtml(data.sttUrl)}" placeholder="wss://your-host:9000/asr" />
    <p class="hint">${x("p.sttServerHint")}</p>
    ${isPlainHttp(data.sttUrl) ? `<p class="hint"><small class="warn">${x("p.warnWs")}</small></p>` : ""}

    <label for="stt-token">${x("p.sttToken")} — <em>${secret(data.sttToken)}</em></label>
    <input id="stt-token" type="password" placeholder="${escapeHtml(x("p.sttTokenPlaceholder"))}" />
  </section>

  <section class="card">
    <h2>${x("p.serverTrTitle")}</h2>
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
  </section>
  </div>

  <div class="tab" data-tab="more">
  <section class="card compact">${languageSelect(locale)}</section>

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
  ];
  for (const [id, key] of settingIds) {
    byId<HTMLInputElement>(id)?.addEventListener("change", (event) => {
      const checked = (event.target as HTMLInputElement).checked;
      commit({ [key]: checked } as Partial<BabelData>);
      // The overview switch shows the same setting.
      const twin = root.querySelector<HTMLInputElement>(`[data-ov-toggle="${key}"]`);
      if (twin) twin.checked = checked;
    });
  }

  // Overview switches: one listener on the card (its table is redrawn with the conversation).
  byId<HTMLElement>("ov")?.addEventListener("change", (event) => {
    const target = event.target as HTMLInputElement | null;
    const key = target?.dataset?.["ovToggle"] as HelperToggle | undefined;
    if (!target || !key) return;
    commit({ [key]: target.checked } as Partial<BabelData>);
    const twin = byId<HTMLInputElement>(settingIds.find(([, k]) => k === key)?.[0] ?? "");
    if (twin) twin.checked = target.checked;
  });
  byId<HTMLElement>("ov")?.addEventListener("click", (event) => {
    if ((event.target as HTMLElement | null)?.id === "ov-help") ports.onShowHelp?.();
  });

  // The conversation card is redrawn on its own; listen on the card, not the buttons.
  byId<HTMLElement>("conv")?.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null;
    const id = target?.id ?? "";
    if (id === "summarize") ports.onSummarize?.();
    const mode = target?.dataset?.["talkMode"];
    if (mode === "client" || mode === "translate") commit({ talkMode: mode });
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
