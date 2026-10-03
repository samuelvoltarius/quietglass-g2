import type { Stop } from "../transit/types";
import type { Position } from "../ride/tracker";
import { DEFAULT_SETTINGS, validateUrl, type Settings } from "../storage/persist";

/**
 * The phone side: which service to ask, and where it lives.
 *
 * Everything that matters happens on the glasses, so this stays a settings
 * page. It does carry one thing the glasses cannot: an explanation of why
 * there are two backends at all, because a user who picks the wrong one for
 * their country simply sees an empty screen and no reason for it.
 */

export interface PhoneUiPorts {
  getSettings(): Settings;
  setSettings(next: Settings): Promise<void>;
  getPosition(): Position | null;
  /** True while the position came from the ?at= parameter rather than GPS. */
  isSeeded(): boolean;
  getStops(): readonly Stop[];
  refresh(): void;
}

export function mountPhoneUi(ports: PhoneUiPorts): void {
  const root = document.getElementById("app");
  if (!root) return;

  const render = (): void => {
    const settings = ports.getSettings();
    const position = ports.getPosition();
    const stops = ports.getStops();

    root.innerHTML = `
      <div class="brand"><span class="brand-mark">Quietglass</span> NextStop</div>

      <div class="card">
        <label for="backend">Datenquelle</label>
        <select id="backend">
          <option value="oebb">ÖBB — Österreich, mit Echtzeit</option>
          <option value="motis">Transitous — weltweit, Fahrplan</option>
        </select>
        <p class="hint" id="backend-hint"></p>
      </div>

      <div class="card" id="oebb-card">
        <label for="oebb-url">ÖBB-Proxy</label>
        <input id="oebb-url" type="url" inputmode="url" spellcheck="false" />
        <p class="hint">
          Die ÖBB schickt keine CORS-Header, deshalb geht die Anfrage über einen
          kleinen Proxy. Starten mit
          <code>node examples/oebb-cors-proxy.mjs</code>.
        </p>
      </div>

      <div class="card" id="motis-card">
        <label for="motis-url">MOTIS-Adresse</label>
        <input id="motis-url" type="url" inputmode="url" spellcheck="false" />
        <p class="hint">
          Voreingestellt ist die öffentliche Transitous-Instanz. Wer MOTIS selbst
          betreibt, trägt hier die eigene Adresse ein — dann verlässt keine
          Anfrage das Haus.
        </p>
      </div>

      <div class="card">
        <label for="refresh">Aktualisieren alle <span id="refresh-value"></span> s</label>
        <input id="refresh" type="range" min="10" max="120" step="5" />
        <p class="hint">
          Gilt nur für die Abfahrtstafel. Während der Fahrt bleibt die
          Haltestellenfolge stehen — sie ändert sich nicht.
        </p>
      </div>

      <div class="card">
        <label>Status</label>
        <p class="hint" id="status"></p>
        <button id="refresh-now" type="button">Haltestellen neu suchen</button>
      </div>

      <div class="card keys">
        <label>Bedienung</label>
        <p class="hint">
          <strong>Wischen</strong> — Abfahrt auswählen<br />
          <strong>Tippen</strong> — Fahrt verfolgen, und zurück<br />
          <strong>Halten</strong> — nächste Haltestelle in der Nähe<br />
          <strong>Doppeltippen</strong> — NextStop verlassen
        </p>
      </div>
    `;

    const backend = root.querySelector<HTMLSelectElement>("#backend");
    const oebbUrl = root.querySelector<HTMLInputElement>("#oebb-url");
    const motisUrl = root.querySelector<HTMLInputElement>("#motis-url");
    const refresh = root.querySelector<HTMLInputElement>("#refresh");
    const refreshValue = root.querySelector<HTMLElement>("#refresh-value");
    const status = root.querySelector<HTMLElement>("#status");
    const backendHint = root.querySelector<HTMLElement>("#backend-hint");
    const oebbCard = root.querySelector<HTMLElement>("#oebb-card");
    const motisCard = root.querySelector<HTMLElement>("#motis-card");
    if (!backend || !oebbUrl || !motisUrl || !refresh) return;

    backend.value = settings.backend;
    oebbUrl.value = settings.oebbUrl;
    motisUrl.value = settings.motisUrl;
    refresh.value = String(settings.refreshSeconds);
    if (refreshValue) refreshValue.textContent = String(settings.refreshSeconds);

    // Only the relevant address is shown; two URL fields at once invites
    // editing the one that is not in use and wondering why nothing changed.
    if (oebbCard) oebbCard.hidden = settings.backend !== "oebb";
    if (motisCard) motisCard.hidden = settings.backend !== "motis";

    if (backendHint) {
      backendHint.textContent = settings.backend === "oebb"
        ? "Führt Verspätungen, bis hinunter zum Salzburger O-Bus. Kennt nur Österreich."
        : "Deckt viele Länder ab, aber Echtzeit nur dort, wo Feeds eingespeist "
          + "werden — in Österreich derzeit fast nirgends.";
    }

    if (status) {
      const where = position
        ? `Position: ${position.lat.toFixed(4)}, ${position.lon.toFixed(4)}`
          + (ports.isSeeded() ? " (aus ?at=, nicht gemessen)" : "")
        : "Noch keine Position — GPS braucht draußen einen Moment.";
      const found = stops.length === 0
        ? "Keine Haltestelle gefunden."
        : `${stops.length} Haltestellen in der Nähe, nächste: ${stops[0]?.name ?? "?"}`;
      status.textContent = `${where} · ${found}`;
    }

    const commit = (next: Settings): void => { void ports.setSettings(next); };

    backend.addEventListener("change", () => {
      commit({ ...settings, backend: backend.value === "motis" ? "motis" : "oebb" });
      render();
    });

    for (const [field, key] of [[oebbUrl, "oebbUrl"], [motisUrl, "motisUrl"]] as const) {
      field.addEventListener("change", () => {
        const check = validateUrl(field.value);
        if (!check.valid) {
          field.setCustomValidity(check.error ?? "Ungültig");
          field.reportValidity();
          // Refuse the edit rather than silently storing an address that can
          // never answer; the old one at least worked.
          field.value = settings[key];
          return;
        }
        field.setCustomValidity("");
        commit({ ...settings, [key]: field.value.trim() });
      });
    }

    refresh.addEventListener("input", () => {
      if (refreshValue) refreshValue.textContent = refresh.value;
    });
    refresh.addEventListener("change", () => {
      commit({ ...settings, refreshSeconds: Number(refresh.value) || DEFAULT_SETTINGS.refreshSeconds });
    });

    root.querySelector<HTMLButtonElement>("#refresh-now")
      ?.addEventListener("click", () => { ports.refresh(); render(); });
  };

  render();
  // The status line is the only live part, so a slow beat is enough.
  setInterval(render, 5000);
}
