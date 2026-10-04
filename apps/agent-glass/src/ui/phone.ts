import type { AgentState, Session } from "../terminal/types";
import {
  maskToken, parsePairingUrl, validateUrl, type Settings,
} from "../storage/persist";

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
}

export function mountPhoneUi(ports: PhoneUiPorts): void {
  const root = document.getElementById("app");
  if (!root) return;

  const render = (): void => {
    const settings = ports.getSettings();
    const state = ports.getState();
    const sessions = ports.getSessions();

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
  };

  render();
  setInterval(render, 3000);
}
