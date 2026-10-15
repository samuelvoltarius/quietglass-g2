import type { AgentState, Session } from "../terminal/types";
import {
  defaultUrlForProvider, maskToken, normalizeAddress, type ProviderKind, type Settings,
} from "../storage/persist";
import type { SpeechStatus, SpeechVoiceChoice } from "../speech/narrator";
import type { BackendCapabilities } from "../providers/backend";
import { languageSelect, type Locale } from "../i18n";
import { localizeError, t } from "../messages";
import { ageLabel } from "../sessions/model";
import type { Transcript } from "../sessions/transcript";

/**
 * The phone side: where Even Terminal is, and the token to reach it.
 *
 * It accepts the whole pairing URL the CLI prints, because splitting that by
 * hand into an address and a token on a phone keyboard is exactly the kind of
 * chore that makes people give up before the first run.
 */

export interface PhoneUiPorts {
  getSettings(): Settings;
  setSettings(next: Settings): Promise<void>;
  getState(): AgentState;
  getSessions(): readonly Session[];
  refresh(): void;
  sendPrompt(text: string): Promise<void>;
  createSession(): Promise<void>;
  getCapabilities(): BackendCapabilities;
  getSpeechStatus(): SpeechStatus;
  getSpeechVoices(): readonly SpeechVoiceChoice[];
  activateSpeech(): Promise<boolean>;
  disableSpeech(): Promise<void>;
  toggleSpeechPause(): void;
  replaySpeech(): void;
  /** App language (glasses and phone). Missing means English. */
  getLocale?(): Locale;
  /** Called when the language is changed on this page; the caller persists it and redraws the glasses. */
  setLocale?(locale: Locale): void;
  openSession?(id: string): Promise<void>;
  /** Empty title = back to the agent's own title. */
  renameSession?(id: string, title: string): Promise<void>;
  removeSession?(id: string): Promise<void>;
  restoreHidden?(): Promise<void>;
  getHiddenCount?(): number;
  getManageMode?(): { readonly rename: "remote" | "local"; readonly remove: "remote" | "local" };
  /** The full conversation of the open session, newest last. */
  getTranscript?(): Transcript;
  /** Called on every change of the transcript (live). */
  onTranscript?(listener: () => void): void;
}

function speechStatusText(status: SpeechStatus, locale: Locale): string {
  return t(locale, `p.speech.${status}`);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character] ?? character);
}

/** Product names; not translated. */
function providerName(provider: ProviderKind): string {
  if (provider === "hermes") return "Hermes EvenHub Bridge";
  if (provider === "openclaw") return "OpenClaw Gateway";
  return "Even Terminal";
}

function providerHint(provider: ProviderKind, locale: Locale): string {
  if (provider === "hermes") return t(locale, "p.hintHermes");
  if (provider === "openclaw") return t(locale, "p.hintOpenclaw");
  return t(locale, "p.hintTerminal");
}

function setupHint(provider: ProviderKind, locale: Locale): string {
  if (provider === "hermes") return t(locale, "p.setupHermes");
  if (provider === "openclaw") return t(locale, "p.setupOpenclaw");
  return t(locale, "p.setupTerminal");
}

/** The one-line connection summary, shared by the full render and the 1 s refresh. */
function statusLine(settings: Settings, state: AgentState, sessions: readonly Session[], locale: Locale): string {
  const lines = [
    t(locale, "p.statusProvider", { name: providerName(settings.provider) }),
    t(locale, "p.statusAddress", { url: settings.baseUrl }),
    t(locale, "p.statusToken", { token: maskToken(settings.token, locale) }),
    sessions.length > 0
      ? t(locale, "p.statusSessions", { count: sessions.length, title: state.session?.title ?? t(locale, "p.statusNone") })
      : t(locale, "p.statusNoSessions"),
  ];
  if (state.error) lines.push(t(locale, "p.statusError", { error: localizeError(state.error, locale) }));
  return lines.join(" · ");
}

function enableLabel(status: SpeechStatus, active: boolean, locale: Locale): string {
  return t(locale, active ? "p.disable" : status === "needs-activation" ? "p.activate" : "p.enable");
}

/** The page is split into tabs instead of one long column (Alfred, 13.10.2026). */
const TABS: readonly { id: string; icon: string; key: string }[] = [
  { id: "agent", icon: "🎯", key: "p.tabAgent" },
  { id: "speech", icon: "🔊", key: "p.tabSpeech" },
  { id: "glasses", icon: "👓", key: "p.tabGlasses" },
  { id: "connect", icon: "🔌", key: "p.tabConnect" },
  { id: "more", icon: "⚙️", key: "p.tabMore" },
];
const TAB_KEY = "quietglass.agent-glass.tab";

function readTab(fallback: string): string {
  try { const v = localStorage.getItem(TAB_KEY); return TABS.some((tab) => tab.id === v) ? v! : fallback; } catch { return fallback; }
}

/** Shows only the active tab; the choice survives redraws and restarts. */
function applyTab(root: HTMLElement, active: string): void {
  root.querySelectorAll<HTMLElement>("[data-tab]").forEach((el) => { el.hidden = el.dataset["tab"] !== active; });
  root.querySelectorAll<HTMLButtonElement>("[data-tab-go]").forEach((button) => {
    const on = button.dataset["tabGo"] === active;
    button.classList.toggle("on", on);
    button.setAttribute("aria-selected", String(on));
  });
}

/** Keeps the phone responsive while an answer streams in token by token. */
const TRANSCRIPT_THROTTLE_MS = 150;

export function transcriptHtml(transcript: Transcript, locale: Locale): string {
  if (transcript.length === 0) return `<p class="hint">${escapeHtml(t(locale, "p.transcriptEmpty"))}</p>`;
  const role = (value: string): string => t(locale, value === "user" ? "p.roleUser"
    : value === "tool" ? "p.roleTool" : value === "error" ? "p.roleError" : "p.roleAssistant");
  return transcript.map((entry) =>
    `<div class="msg ${entry.role}${entry.open ? " open" : ""}"><span class="who">${escapeHtml(role(entry.role))}</span>`
    + `<div class="what">${escapeHtml(entry.text)}</div></div>`).join("");
}

/** The session list on the phone: open with a tap, newest first, with its age. */
export function sessionListHtml(
  sessions: readonly Session[], activeId: string | undefined, locale: Locale, now: Date, listable: boolean,
): string {
  if (sessions.length === 0) return `<p class="hint">${escapeHtml(t(locale, "p.sessionsEmpty"))}</p>`;
  return `<ul class="sessions">${sessions.map((session) => {
    const age = listable ? ageLabel(session.timestamp, now, locale) : "";
    const active = session.id === activeId;
    return `<li><button type="button" class="session-row${active ? " active" : ""}" data-open="${escapeHtml(session.id)}">`
      + `<span class="session-title">${escapeHtml(session.title)}</span>`
      + `<span class="session-meta">${active ? escapeHtml(t(locale, "p.sessionActive")) + (age ? " · " : "") : ""}${escapeHtml(age)}</span>`
      + `</button></li>`;
  }).join("")}</ul>`;
}

/** Header chip: the active session, or why there is none. */
function headerChip(state: AgentState, locale: Locale): { text: string; on: boolean } {
  if (state.error) return { text: t(locale, "p.chipOffline"), on: false };
  return { text: state.session?.title ?? t(locale, "p.chipIdle"), on: Boolean(state.session) };
}

export function mountPhoneUi(ports: PhoneUiPorts): void {
  const root = document.getElementById("app");
  if (!root) return;

  function drawTranscript(force = false): void {
    const box = root?.querySelector<HTMLElement>("#transcript");
    if (!box || !ports.getTranscript) return;
    const pinned = force || box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    box.innerHTML = transcriptHtml(ports.getTranscript(), ports.getLocale?.() ?? "en");
    if (pinned) box.scrollTop = box.scrollHeight;
  }
  // Without a token the connection tab comes first; afterwards the stored choice wins.
  let tab = readTab(ports.getSettings().token ? "agent" : "connect");

  const render = (): void => {
    const locale = ports.getLocale?.() ?? "en";
    if (document.documentElement) document.documentElement.lang = locale;
    const x = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
    const settings = ports.getSettings();
    const state = ports.getState();
    const sessions = ports.getSessions();
    const speechStatus = ports.getSpeechStatus();
    const capabilities = ports.getCapabilities();
    const voices = ports.getSpeechVoices();
    const speechActive = speechStatus === "ready" || speechStatus === "speaking" || speechStatus === "paused";
    const voiceOptions = [
      `<option value="">${x("p.systemVoice")}</option>`,
      ...voices.map((voice) => `<option value="${escapeHtml(voice.name)}"${voice.name === settings.speechVoice ? " selected" : ""}>${escapeHtml(voice.name)} · ${escapeHtml(voice.lang)}</option>`),
    ].join("");
    // Language names are written in their own language and stay as they are.
    const speechOption = (value: string, label: string): string =>
      `<option value="${value}"${settings.speechLanguage === value ? " selected" : ""}>${label}</option>`;

    const hidden = ports.getHiddenCount?.() ?? 0;
    const mode = ports.getManageMode?.();
    const manageRemote = mode?.rename === "remote" && mode.remove === "remote";
    const chipNow = headerChip(state, locale);
    root.innerHTML = `
      <div class="brand bar"><div><span class="brand-mark">Quietglass</span> Agent Glass</div><span class="chip${chipNow.on ? " on" : ""}" id="hdr-chip">${escapeHtml(chipNow.text)}</span></div>

      <div class="tab" data-tab="agent">
      <div class="card">
        <label>${x("p.liveStatus")}</label>
        <p class="hint" id="conn"></p>
      </div>

      <div class="card">
        <span class="eyebrow">${x("p.transcriptEyebrow")}</span>
        <h2>${x("p.transcriptTitle")}${state.session ? ` · ${escapeHtml(state.session.title)}` : ""}</h2>
        <div id="transcript" class="transcript" aria-live="polite"></div>
      </div>

      <div class="card">
        <span class="eyebrow">${x("p.sendEyebrow")}</span>
        <h2>${x("p.promptTitle")}</h2>
        <textarea id="prompt" rows="3" placeholder="${escapeHtml(x("p.promptPlaceholder"))}"></textarea>
        <button id="send-prompt" type="button"${state.session ? "" : " disabled"}>${x("p.send")}</button>
        <p class="hint">${x("p.promptHint")}</p>
      </div>

      <div class="card">
        <span class="eyebrow">${x("p.sessionsEyebrow")}</span>
        <h2>${x("p.sessionsTitle")}</h2>
        ${capabilities.sessions ? "" : `<p class="hint">${escapeHtml(x("p.noList"))}</p>`}
        <div id="session-list">${sessionListHtml(sessions, state.session?.id, locale, new Date(), capabilities.sessions)}</div>
        <div class="button-row">
          <button id="refresh" type="button">${x("p.reload")}</button>
          ${capabilities.createSession ? `<button id="new-session" class="secondary" type="button">${x("p.newSession")}</button>` : ""}
          ${hidden > 0 ? `<button id="restore-hidden" class="secondary" type="button">${escapeHtml(x("p.restore", { count: hidden }))}</button>` : ""}
        </div>
        ${capabilities.sessions && sessions.length > 0 && ports.renameSession ? `
        <label for="manage-session">${x("p.manage")}</label>
        <select id="manage-session">${sessions.map((session) =>
          `<option value="${escapeHtml(session.id)}"${session.id === state.session?.id ? " selected" : ""}>${escapeHtml(session.title)}</option>`).join("")}</select>
        <label for="rename-input">${x("p.renameLabel")}</label>
        <input id="rename-input" type="text" maxlength="80" placeholder="${escapeHtml(x("p.renamePlaceholder"))}" />
        <div class="button-row">
          <button id="rename-session" class="secondary" type="button">${x("p.rename")}</button>
          <button id="remove-session" class="secondary" type="button">${x("p.remove")}</button>
        </div>
        <p class="hint">${escapeHtml(x(manageRemote ? "p.manageRemote" : "p.manageLocal"))}</p>` : ""}
      </div>
      </div>

      <div class="tab" data-tab="glasses">
      <div class="card keys">
        <label>${x("p.controls")}</label>
        ${capabilities.decisions ? `
          <p class="hint">
            <strong>${x("p.tap")}</strong> — ${x("p.tapDo")}<br />
            <strong>${x("p.swipe")}</strong> — ${x("p.swipePageDo")}<br />
            <strong>${x("p.hold")}</strong> — ${x("p.holdDo")}<br />
            <strong>${x("p.double")}</strong> — ${x("p.doubleDo")}
          </p>
          <p class="hint">${x("p.safeTap")}</p>
        ` : `
          <p class="hint">
            <strong>${x("p.tap")}</strong> — ${x("p.tapDo")}<br />
            <strong>${x("p.swipe")}</strong> — ${x("p.swipePageDo")}<br />
            <strong>${x("p.hold")}</strong> — ${x("p.holdDo")}<br />
            <strong>${x("p.double")}</strong> — ${x("p.doubleDo")}
          </p>
          <p class="hint">${x("p.noDecisions")}</p>
        `}
        <label class="check"><input id="invert-scroll" type="checkbox" ${settings.invertScroll ? "checked" : ""} /> ${x("p.invert")}</label>
      </div>
      </div>

      <div class="tab" data-tab="connect">
      <div class="card">
        <span class="eyebrow">${x("p.backendEyebrow")}</span>
        <h2>${x("p.connection")}</h2>
        <label for="provider">${x("p.provider")}</label>
        <select id="provider">
          <option value="even-terminal"${settings.provider === "even-terminal" ? " selected" : ""}>Claude / Codex · Even Terminal</option>
          <option value="hermes"${settings.provider === "hermes" ? " selected" : ""}>Hermes · EvenHub Bridge</option>
          <option value="openclaw"${settings.provider === "openclaw" ? " selected" : ""}>OpenClaw · Gateway</option>
        </select>
        <label for="address">${x("p.address")}</label>
        <input id="address" type="text" inputmode="url" spellcheck="false"
               value="${escapeHtml(settings.baseUrl)}" />
        <label for="token">${x("p.token")}</label>
        <input id="token" type="password" autocomplete="off"
               placeholder="${escapeHtml(x("p.tokenKeep", { token: maskToken(settings.token, locale) }))}" />
        <button id="apply" type="button">${x("p.apply")}</button>
        <p class="hint">${escapeHtml(providerHint(settings.provider, locale))}</p>
      </div>

      <div class="card">
        <label>${x("p.startup")}</label>
        <p class="hint">${escapeHtml(setupHint(settings.provider, locale))}</p>
      </div>
      </div>

      <div class="tab" data-tab="speech">
      <div class="card speech-card">
        <div class="card-title-row">
          <div>
            <span class="eyebrow">${x("p.audioEyebrow")}</span>
            <h2>${x("p.spoken")}</h2>
          </div>
          <span class="status-chip ${speechStatus}">${speechStatusText(speechStatus, locale)}</span>
        </div>
        <p class="hint">${x("p.spokenHint")}</p>
        <div class="button-row">
          <button id="speech-enable" type="button"${speechStatus === "unavailable" ? " disabled" : ""}>
            ${enableLabel(speechStatus, speechActive, locale)}
          </button>
          <button id="speech-pause" class="secondary" type="button"${speechActive ? "" : " disabled"}>
            ${x(speechStatus === "paused" ? "p.resume" : "p.pause")}
          </button>
          <button id="speech-replay" class="secondary" type="button"${speechActive ? "" : " disabled"}>${x("p.replay")}</button>
        </div>

        <label for="speech-language">${x("p.speechLanguage")}</label>
        <select id="speech-language">
          ${speechOption("auto", x("p.speechAuto"))}
          ${speechOption("en-US", "English (US)")}
          ${speechOption("en-GB", "English (UK)")}
          ${speechOption("de-DE", "Deutsch")}
          ${speechOption("fr-FR", "Français")}
          ${speechOption("es-ES", "Español")}
          ${speechOption("it-IT", "Italiano")}
        </select>

        <label for="speech-voice">${x("p.voice")}</label>
        <select id="speech-voice">${voiceOptions}</select>

        <label for="speech-rate">${x("p.speed", { rate: settings.speechRate.toFixed(1) })}</label>
        <input id="speech-rate" type="range" min="0.7" max="1.5" step="0.1" value="${settings.speechRate}" />
        <p class="hint privacy-note">${x("p.speechNote")}</p>
      </div>
      </div>

      <div class="tab" data-tab="more">
      <div class="card">${languageSelect(locale)}</div>

      </div>
      </div>

      <nav class="tabbar" role="tablist">
        ${TABS.map(({ id, icon, key }) => `<button type="button" role="tab" data-tab-go="${id}"><span aria-hidden="true">${icon}</span>${escapeHtml(x(key))}</button>`).join("")}
      </nav>
    `;

    const conn = root.querySelector<HTMLElement>("#conn");
    if (conn) conn.textContent = statusLine(settings, state, sessions, locale);
    drawTranscript(true);

    applyTab(root, tab);
    root.querySelectorAll<HTMLButtonElement>("[data-tab-go]").forEach((button) => {
      button.addEventListener("click", () => {
        tab = button.dataset["tabGo"] ?? "agent";
        try { localStorage.setItem(TAB_KEY, tab); } catch { /* private mode */ }
        applyTab(root, tab);
        window.scrollTo({ top: 0 });
      });
    });

    root.querySelector<HTMLInputElement>("#invert-scroll")?.addEventListener("change", (event) => {
      void ports.setSettings({ ...settings, invertScroll: (event.target as HTMLInputElement).checked }).then(render);
    });

    root.querySelector<HTMLSelectElement>("#language")?.addEventListener("change", (event) => {
      const value = (event.target as HTMLSelectElement).value;
      ports.setLocale?.(value === "de" ? "de" : "en");
      render();
    });

    root.querySelector<HTMLButtonElement>("#apply")?.addEventListener("click", () => {
      const provider = root.querySelector<HTMLSelectElement>("#provider")?.value as ProviderKind;
      const address = root.querySelector<HTMLInputElement>("#address");
      const tokenField = root.querySelector<HTMLInputElement>("#token");
      const value = address?.value.trim() ?? "";
      if (!value) return;

      // One path for every provider: a pasted `?token=` is lifted into the
      // token field instead of being kept (and shown) as part of the address.
      const result = normalizeAddress(value, provider, locale);
      if (!result.ok) {
        address?.setCustomValidity(result.error);
        address?.reportValidity();
        return;
      }
      address?.setCustomValidity("");
      const token = result.token || tokenField?.value.trim() || settings.token;
      void ports.setSettings({ ...settings, provider, baseUrl: result.baseUrl, token }).then(render);
    });

    root.querySelector<HTMLSelectElement>("#provider")?.addEventListener("change", (event) => {
      const provider = (event.target as HTMLSelectElement).value as ProviderKind;
      const knownDefaults = (["even-terminal", "hermes", "openclaw"] as const)
        .map(defaultUrlForProvider);
      const baseUrl = knownDefaults.includes(settings.baseUrl)
        ? defaultUrlForProvider(provider) : settings.baseUrl;
      void ports.setSettings({ ...settings, provider, baseUrl, sessionId: "" }).then(render);
    });

    root.querySelector<HTMLButtonElement>("#refresh")
      ?.addEventListener("click", () => { ports.refresh(); render(); });
    root.querySelector<HTMLButtonElement>("#new-session")
      ?.addEventListener("click", () => { void ports.createSession().then(render); });
    // Delegated: the list is refreshed in place by the 1 s update below.
    root.querySelector<HTMLElement>("#session-list")?.addEventListener("click", (event) => {
      const target = (event.target as HTMLElement | null)?.closest?.<HTMLElement>("[data-open]");
      const id = target?.dataset["open"];
      if (id && ports.openSession) void ports.openSession(id).then(render);
    });
    root.querySelector<HTMLButtonElement>("#restore-hidden")
      ?.addEventListener("click", () => { void ports.restoreHidden?.().then(render); });
    const managed = (): string => root.querySelector<HTMLSelectElement>("#manage-session")?.value ?? "";
    root.querySelector<HTMLButtonElement>("#rename-session")?.addEventListener("click", () => {
      const id = managed();
      const name = root.querySelector<HTMLInputElement>("#rename-input")?.value ?? "";
      if (id && ports.renameSession) void ports.renameSession(id, name).then(render);
    });
    root.querySelector<HTMLButtonElement>("#remove-session")?.addEventListener("click", () => {
      const id = managed();
      if (id && ports.removeSession) void ports.removeSession(id).then(render);
    });
    root.querySelector<HTMLButtonElement>("#send-prompt")?.addEventListener("click", () => {
      const prompt = root.querySelector<HTMLTextAreaElement>("#prompt");
      const text = prompt?.value.trim() ?? "";
      if (!text) return;
      if (prompt) prompt.value = "";
      void ports.sendPrompt(text).then(render);
    });

    root.querySelector<HTMLButtonElement>("#speech-enable")?.addEventListener("click", () => {
      void (speechActive ? ports.disableSpeech() : ports.activateSpeech()).then(render);
    });
    root.querySelector<HTMLButtonElement>("#speech-pause")?.addEventListener("click", () => {
      ports.toggleSpeechPause();
      render();
    });
    root.querySelector<HTMLButtonElement>("#speech-replay")?.addEventListener("click", () => {
      ports.replaySpeech();
      render();
    });
    root.querySelector<HTMLSelectElement>("#speech-language")?.addEventListener("change", (event) => {
      const speechLanguage = (event.target as HTMLSelectElement).value;
      void ports.setSettings({ ...settings, speechLanguage }).then(render);
    });
    root.querySelector<HTMLSelectElement>("#speech-voice")?.addEventListener("change", (event) => {
      const speechVoice = (event.target as HTMLSelectElement).value;
      void ports.setSettings({ ...settings, speechVoice }).then(render);
    });
    root.querySelector<HTMLInputElement>("#speech-rate")?.addEventListener("change", (event) => {
      const speechRate = Number((event.target as HTMLInputElement).value);
      void ports.setSettings({ ...settings, speechRate }).then(render);
    });
  };

  const updateDynamicStatus = (): void => {
    const locale = ports.getLocale?.() ?? "en";
    const conn = root.querySelector<HTMLElement>("#conn");
    if (conn) conn.textContent = statusLine(ports.getSettings(), ports.getState(), ports.getSessions(), locale);
    const list = root.querySelector<HTMLElement>("#session-list");
    if (list) {
      const html = sessionListHtml(ports.getSessions(), ports.getState().session?.id, locale, new Date(), ports.getCapabilities().sessions);
      if (list.innerHTML !== html) list.innerHTML = html;
    }
    const hdr = root.querySelector<HTMLElement>("#hdr-chip");
    if (hdr) {
      const now = headerChip(ports.getState(), locale);
      hdr.className = now.on ? "chip on" : "chip";
      hdr.textContent = now.text;
    }

    const status = ports.getSpeechStatus();
    const active = status === "ready" || status === "speaking" || status === "paused";
    const chip = root.querySelector<HTMLElement>(".status-chip");
    if (chip) { chip.className = `status-chip ${status}`; chip.textContent = speechStatusText(status, locale); }
    const enable = root.querySelector<HTMLButtonElement>("#speech-enable");
    if (enable) {
      enable.disabled = status === "unavailable";
      enable.textContent = enableLabel(status, active, locale);
    }
    const pause = root.querySelector<HTMLButtonElement>("#speech-pause");
    if (pause) { pause.disabled = !active; pause.textContent = t(locale, status === "paused" ? "p.resume" : "p.pause"); }
    const replay = root.querySelector<HTMLButtonElement>("#speech-replay");
    if (replay) replay.disabled = !active;
  };

  /**
   * Redraws only the transcript box, live. It stays pinned to the newest
   * entry unless the user has scrolled up to read something older.
   */
  let transcriptTimer: ReturnType<typeof setTimeout> | null = null;
  ports.onTranscript?.(() => {
    if (transcriptTimer) return;
    transcriptTimer = setTimeout(() => { transcriptTimer = null; drawTranscript(); }, TRANSCRIPT_THROTTLE_MS);
  });

  render();
  // Update only live labels. Replacing the whole DOM on a timer would reset
  // form fields and can swallow a tap just as the user presses a control.
  setInterval(updateDynamicStatus, 1000);
}
