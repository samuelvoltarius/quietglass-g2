import type { AgentState, Session } from "../terminal/types";
import {
  defaultUrlForProvider, maskToken, normalizeAddress, type ProviderKind, type Settings,
} from "../storage/persist";
import type { SpeechStatus, SpeechVoiceChoice } from "../speech/narrator";
import type { BackendCapabilities } from "../providers/backend";

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
}

const SPEECH_STATUS: Readonly<Record<SpeechStatus, string>> = {
  off: "Off",
  "needs-activation": "Tap once to activate",
  ready: "Ready for AirPods / headphones",
  speaking: "Speaking",
  paused: "Paused",
  unavailable: "Not available in this phone WebView",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character] ?? character);
}

function providerName(provider: ProviderKind): string {
  if (provider === "hermes") return "Hermes EvenHub Bridge";
  if (provider === "openclaw") return "OpenClaw Gateway";
  return "Even Terminal";
}

function providerHint(provider: ProviderKind): string {
  if (provider === "hermes") {
    return "Use the existing hermes-evenhub-bridge WebSocket address and EVENHUB_BRIDGE_TOKEN.";
  }
  if (provider === "openclaw") {
    return "Use the existing OpenClaw gateway root (normally port 18789) and its gateway token.";
  }
  return "Paste the complete Even Terminal pairing URL, or enter its HTTP address and token separately.";
}

function setupHint(provider: ProviderKind): string {
  if (provider === "hermes") return "Expose hermes-evenhub-bridge as ws:// or wss://. Tailscale Serve is recommended.";
  if (provider === "openclaw") return "Enable OpenClaw's chatCompletions endpoint and allow the Even App origin at the gateway or reverse proxy.";
  return "Start Even Terminal with: even-terminal start --tailscale --allow-cors";
}

export function mountPhoneUi(ports: PhoneUiPorts): void {
  const root = document.getElementById("app");
  if (!root) return;

  const render = (): void => {
    const settings = ports.getSettings();
    const state = ports.getState();
    const sessions = ports.getSessions();
    const speechStatus = ports.getSpeechStatus();
    const capabilities = ports.getCapabilities();
    const voices = ports.getSpeechVoices();
    const speechActive = speechStatus === "ready" || speechStatus === "speaking" || speechStatus === "paused";
    const voiceOptions = [
      `<option value="">System voice</option>`,
      ...voices.map((voice) => `<option value="${escapeHtml(voice.name)}"${voice.name === settings.speechVoice ? " selected" : ""}>${escapeHtml(voice.name)} · ${escapeHtml(voice.lang)}</option>`),
    ].join("");

    root.innerHTML = `
      <div class="brand"><span class="brand-mark">Quietglass</span> Agent Glass</div>

      <div class="card">
        <span class="eyebrow">AGENT BACKEND</span>
        <h2>Connection</h2>
        <label for="provider">Provider</label>
        <select id="provider">
          <option value="even-terminal"${settings.provider === "even-terminal" ? " selected" : ""}>Claude / Codex · Even Terminal</option>
          <option value="hermes"${settings.provider === "hermes" ? " selected" : ""}>Hermes · EvenHub Bridge</option>
          <option value="openclaw"${settings.provider === "openclaw" ? " selected" : ""}>OpenClaw · Gateway</option>
        </select>
        <label for="address">Server address</label>
        <input id="address" type="text" inputmode="url" spellcheck="false"
               value="${escapeHtml(settings.baseUrl)}" />
        <label for="token">Bearer / bridge token</label>
        <input id="token" type="password" autocomplete="off"
               placeholder="Leave empty to keep ${escapeHtml(maskToken(settings.token))}" />
        <button id="apply" type="button">Save and connect</button>
        <p class="hint">${providerHint(settings.provider)}</p>
      </div>

      <div class="card">
        <label>Live status</label>
        <p class="hint" id="conn"></p>
        <div class="button-row">
          <button id="refresh" type="button">Reload sessions</button>
          ${capabilities.createSession ? '<button id="new-session" class="secondary" type="button">New Hermes session</button>' : ""}
        </div>
      </div>

      <div class="card">
        <span class="eyebrow">SEND TO ACTIVE SESSION</span>
        <h2>Prompt agent</h2>
        <textarea id="prompt" rows="3" placeholder="Ask the active agent…"></textarea>
        <button id="send-prompt" type="button"${state.session ? "" : " disabled"}>Send prompt</button>
        <p class="hint">
          Hermes and OpenClaw use the gateways already present in your G2 setup.
          Tool approvals only appear when the selected backend exposes a real permission event.
        </p>
      </div>

      <div class="card speech-card">
        <div class="card-title-row">
          <div>
            <span class="eyebrow">PHONE AUDIO</span>
            <h2>Spoken output</h2>
          </div>
          <span class="status-chip ${speechStatus}">${SPEECH_STATUS[speechStatus]}</span>
        </div>
        <p class="hint">
          Reads completed agent sentences through the phone's current audio
          route — including AirPods and Bluetooth headphones. Code, links,
          permission commands and token-looking values are omitted.
        </p>
        <div class="button-row">
          <button id="speech-enable" type="button"${speechStatus === "unavailable" ? " disabled" : ""}>
            ${speechActive ? "Disable" : speechStatus === "needs-activation" ? "Activate audio" : "Enable spoken output"}
          </button>
          <button id="speech-pause" class="secondary" type="button"${speechActive ? "" : " disabled"}>
            ${speechStatus === "paused" ? "Resume" : "Pause"}
          </button>
          <button id="speech-replay" class="secondary" type="button"${speechActive ? "" : " disabled"}>Replay</button>
        </div>

        <label for="speech-language">Language</label>
        <select id="speech-language">
          <option value="auto"${settings.speechLanguage === "auto" ? " selected" : ""}>Automatic</option>
          <option value="en-US"${settings.speechLanguage === "en-US" ? " selected" : ""}>English (US)</option>
          <option value="en-GB"${settings.speechLanguage === "en-GB" ? " selected" : ""}>English (UK)</option>
          <option value="de-DE"${settings.speechLanguage === "de-DE" ? " selected" : ""}>Deutsch</option>
          <option value="fr-FR"${settings.speechLanguage === "fr-FR" ? " selected" : ""}>Français</option>
          <option value="es-ES"${settings.speechLanguage === "es-ES" ? " selected" : ""}>Español</option>
          <option value="it-IT"${settings.speechLanguage === "it-IT" ? " selected" : ""}>Italiano</option>
        </select>

        <label for="speech-voice">Voice</label>
        <select id="speech-voice">${voiceOptions}</select>

        <label for="speech-rate">Speed · ${settings.speechRate.toFixed(1)}×</label>
        <input id="speech-rate" type="range" min="0.7" max="1.5" step="0.1" value="${settings.speechRate}" />
        <p class="hint privacy-note">
          Uses the phone's system speech engine. Spoken output must be activated
          once after opening the app. Background playback while the phone is
          locked depends on the Even App and is not yet guaranteed.
        </p>
      </div>

      <div class="card">
        <label>Server startup</label>
        <p class="hint">${escapeHtml(setupHint(settings.provider))}</p>
      </div>

      <div class="card keys">
        <label>Controls</label>
        ${capabilities.decisions ? `
          <p class="hint">
            <strong>Swipe up</strong> — allow tool<br />
            <strong>Swipe down</strong> — deny<br />
            <strong>Hold</strong> — interrupt, or open the session list<br />
            <strong>Double tap</strong> — leave Agent Glass
          </p>
          <p class="hint">Neither allow nor deny uses a plain tap, so an accidental touch can never approve a command.</p>
        ` : `
          <p class="hint">
            <strong>Tap</strong> — replay the latest spoken answer<br />
            <strong>Hold</strong> — interrupt, or open the session list<br />
            <strong>Double tap</strong> — leave Agent Glass
          </p>
          <p class="hint">This backend does not expose remote permission decisions, so Agent Glass never invents an approval control.</p>
        `}
      </div>
    `;

    const conn = root.querySelector<HTMLElement>("#conn");
    if (conn) {
      const lines = [
        `Provider: ${providerName(settings.provider)}`,
        `Address: ${settings.baseUrl}`,
        `Token: ${maskToken(settings.token)}`,
        sessions.length > 0
          ? `${sessions.length} sessions · active: ${state.session?.title ?? "none"}`
          : "No sessions loaded.",
      ];
      if (state.error) lines.push(`Error: ${state.error}`);
      conn.textContent = lines.join(" · ");
    }

    root.querySelector<HTMLButtonElement>("#apply")?.addEventListener("click", () => {
      const provider = root.querySelector<HTMLSelectElement>("#provider")?.value as ProviderKind;
      const address = root.querySelector<HTMLInputElement>("#address");
      const tokenField = root.querySelector<HTMLInputElement>("#token");
      const value = address?.value.trim() ?? "";
      if (!value) return;

      // One path for every provider: a pasted `?token=` is lifted into the
      // token field instead of being kept (and shown) as part of the address.
      const result = normalizeAddress(value, provider);
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
    const settings = ports.getSettings();
    const state = ports.getState();
    const sessions = ports.getSessions();
    const conn = root.querySelector<HTMLElement>("#conn");
    if (conn) {
      const lines = [
        `Provider: ${providerName(settings.provider)}`,
        `Address: ${settings.baseUrl}`,
        `Token: ${maskToken(settings.token)}`,
        sessions.length > 0
          ? `${sessions.length} sessions · active: ${state.session?.title ?? "none"}`
          : "No sessions loaded.",
      ];
      if (state.error) lines.push(`Error: ${state.error}`);
      conn.textContent = lines.join(" · ");
    }

    const status = ports.getSpeechStatus();
    const active = status === "ready" || status === "speaking" || status === "paused";
    const chip = root.querySelector<HTMLElement>(".status-chip");
    if (chip) { chip.className = `status-chip ${status}`; chip.textContent = SPEECH_STATUS[status]; }
    const enable = root.querySelector<HTMLButtonElement>("#speech-enable");
    if (enable) {
      enable.disabled = status === "unavailable";
      enable.textContent = active ? "Disable" : status === "needs-activation" ? "Activate audio" : "Enable spoken output";
    }
    const pause = root.querySelector<HTMLButtonElement>("#speech-pause");
    if (pause) { pause.disabled = !active; pause.textContent = status === "paused" ? "Resume" : "Pause"; }
    const replay = root.querySelector<HTMLButtonElement>("#speech-replay");
    if (replay) replay.disabled = !active;
  };

  render();
  // Update only live labels. Replacing the whole DOM on a timer would reset
  // form fields and can swallow a tap just as the user presses a control.
  setInterval(updateDynamicStatus, 1000);
}
