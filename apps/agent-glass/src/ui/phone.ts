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
        <label for="pair">Kopplung</label>
        <input id="pair" type="text" inputmode="url" spellcheck="false"
               placeholder="http://100.x.x.x:3456?token=…" />
        <button id="apply" type="button">Übernehmen</button>
        <p class="hint">
          Die vollständige Adresse einfügen, die <code>even-terminal</code> beim
          Start ausgibt — Adresse und Token werden daraus gelesen.
        </p>
      </div>

      <div class="card">
        <label>Verbindung</label>
        <p class="hint" id="conn"></p>
        <button id="refresh" type="button">Sitzungen neu laden</button>
      </div>

      <div class="card">
        <label>Serverstart</label>
        <p class="hint">
          Die Brille spricht den Server aus einer anderen Herkunft an, deshalb
          muss er CORS erlauben:<br />
          <code>even-terminal claude --tailscale --allow-cors</code>
        </p>
      </div>

      <div class="card keys">
        <label>Bedienung</label>
        <p class="hint">
          <strong>Hoch wischen</strong> — Werkzeug erlauben<br />
          <strong>Runter wischen</strong> — ablehnen<br />
          <strong>Halten</strong> — anhalten, sonst Sitzungsliste<br />
          <strong>Doppeltippen</strong> — Agent Glass verlassen
        </p>
        <p class="hint">
          Weder Erlauben noch Ablehnen liegt auf einem einfachen Tippen — eine
          Zufallsberührung darf kein Kommando freigeben.
        </p>
      </div>
    `;

    const pair = root.querySelector<HTMLInputElement>("#pair");
    const conn = root.querySelector<HTMLElement>("#conn");
    if (conn) {
      const lines = [
        `Adresse: ${settings.baseUrl}`,
        `Token: ${maskToken(settings.token)}`,
        sessions.length > 0
          ? `${sessions.length} Sitzungen · aktiv: ${state.session?.title ?? "keine"}`
          : "Keine Sitzungen geladen.",
      ];
      if (state.error) lines.push(`Fehler: ${state.error}`);
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
        pair?.setCustomValidity(check.error ?? "Ungültig");
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
