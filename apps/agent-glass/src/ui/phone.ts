import type { AgentState, Session } from "../terminal/types";
import {
  maskToken, parsePairingUrl, validateUrl, type Settings,
} from "../storage/persist";
import type { SpeechStatus, SpeechVoiceChoice } from "../speech/narrator";

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

export function mountPhoneUi(ports: PhoneUiPorts): void {
  const root = document.getElementById("app");
  if (!root) return;

  const render = (): void => {
    const settings = ports.getSettings();
    const state = ports.getState();
    const sessions = ports.getSessions();
    const speechStatus = ports.getSpeechStatus();
    const voices = ports.getSpeechVoices();
    const speechActive = speechStatus === "ready" || speechStatus === "speaking" || speechStatus === "paused";
    const voiceOptions = [
      `<option value="">System voice</option>`,
      ...voices.map((voice) => `<option value="${escapeHtml(voice.name)}"${voice.name === settings.speechVoice ? " selected" : ""}>${escapeHtml(voice.name)} · ${escapeHtml(voice.lang)}</option>`),
    ].join("");

    root.innerHTML = `
      <div class="brand"><span class="brand-mark">Quietglass</span> Agent Glass</div>

      <div class="card">
        <label for="pair">Pairing</label>
        <input id="pair" type="text" inputmode="url" spellcheck="false"
               placeholder="http://100.x.x.x:3456?token=…" />
        <button id="apply" type="button">Apply</button>
        <p class="hint">
          Paste the full address printed by <code>even-terminal</code> at
          startup. The address and token are read from it automatically.
        </p>
      </div>

      <div class="card">
        <label>Connection</label>
        <p class="hint" id="conn"></p>
        <button id="refresh" type="button">Reload sessions</button>
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
          commands and token-looking values are omitted.
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
        <p class="hint">
          The glasses reach the server from another origin, so CORS must be
          enabled:<br />
          <code>even-terminal claude --tailscale --allow-cors</code>
        </p>
      </div>

      <div class="card keys">
        <label>Controls</label>
        <p class="hint">
          <strong>Swipe up</strong> — allow tool<br />
          <strong>Swipe down</strong> — deny<br />
          <strong>Hold</strong> — interrupt, or open the session list<br />
          <strong>Double tap</strong> — leave Agent Glass
        </p>
        <p class="hint">
          Neither allow nor deny uses a plain tap, so an accidental touch can
          never approve a command.
        </p>
      </div>
    `;

    const pair = root.querySelector<HTMLInputElement>("#pair");
    const conn = root.querySelector<HTMLElement>("#conn");
    if (conn) {
      const lines = [
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
      const value = pair?.value.trim() ?? "";
      if (!value) return;

      const paired = parsePairingUrl(value);
      if (paired) {
        void ports.setSettings({ ...settings, ...paired });
        if (pair) pair.value = "";
        render();
        return;
      }

      // Not a pairing URL — accept a bare address, but only a valid one.
      const check = validateUrl(value);
      if (!check.valid) {
        pair?.setCustomValidity(check.error ?? "Invalid");
        pair?.reportValidity();
        return;
      }
      pair?.setCustomValidity("");
      void ports.setSettings({ ...settings, baseUrl: value });
      render();
    });

    root.querySelector<HTMLButtonElement>("#refresh")
      ?.addEventListener("click", () => { ports.refresh(); render(); });

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
