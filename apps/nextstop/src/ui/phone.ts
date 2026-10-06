import type { Stop } from "../transit/types";
import type { Position } from "../ride/tracker";
import { DEFAULT_SETTINGS, validateUrl, type Settings } from "../storage/persist";
import { nextStep } from "../text";

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

  const statusText = (): string => {
    const position = ports.getPosition();
    const stops = ports.getStops();
    const where = !position
      ? "Noch kein Standort – erlaube den Standort in der Even-App."
      : ports.isSeeded()
        ? "Teststandort aus der Adresse (?at=), nicht gemessen."
        : `Standort gefunden${typeof position.accuracy === "number" ? ` (± ${Math.round(position.accuracy)} m)` : ""}.`;
    const found = stops.length === 0
      ? "Noch keine Haltestelle gefunden."
      : `Nächste Haltestelle: ${stops[0]?.name ?? "?"} (${stops.length} in der Nähe).`;
    return `${where} ${found}`;
  };

  /** Only the status lines are live; they are updated in place. */
  const updateStatus = (): void => {
    const status = root.querySelector<HTMLElement>("#status");
    if (status) status.textContent = statusText();
    const next = root.querySelector<HTMLElement>("#next");
    if (next) next.textContent = nextStep(ports.getPosition() !== null, ports.getStops().length);
  };

  const render = (): void => {
    const settings = ports.getSettings();

    root.innerHTML = `
      <div class="brand"><span class="brand-mark">Quietglass</span> NextStop</div>
      <p class="next" id="next"></p>

      <div class="card">
        <label for="backend">Woher kommen die Abfahrten?</label>
        <select id="backend">
          <option value="motis">Überall – Fahrplan (funktioniert sofort)</option>
          <option value="oebb">ÖBB – Echtzeit in Österreich (Zusatzprogramm nötig)</option>
        </select>
        <p class="hint" id="backend-hint"></p>
      </div>

      <div class="card">
        <label>Status</label>
        <p class="hint" id="status"></p>
        <button id="refresh-now" type="button">Haltestellen neu suchen</button>
      </div>

      <div class="card keys">
        <label>Bedienung auf der Brille</label>
        <p class="hint">
          <strong>Wischen</strong> — Abfahrt auswählen<br />
          <strong>Tippen</strong> — mitfahren und den nächsten Halt sehen, nochmal tippen = zurück<br />
          <strong>Halten</strong> — nächste Haltestelle in der Nähe<br />
          <strong>Doppeltippen</strong> — NextStop beenden<br />
          <strong>●</strong> = Echtzeit, <strong>~</strong> = nur Fahrplan, <strong>+3</strong> = 3 Minuten später
        </p>
      </div>

      <details class="card advanced" id="advanced">
        <summary>Erweitert</summary>

        <div id="oebb-card">
          <label for="oebb-url">Adresse des ÖBB-Zusatzprogramms</label>
          <input id="oebb-url" type="url" inputmode="url" spellcheck="false" />
          <p class="hint">
            Die ÖBB-Schnittstelle schickt keine CORS-Header, deshalb verwirft die
            App ihre Antworten. Ein kleiner Proxy auf einem Computer im selben
            Netz reicht sie durch: <code>node examples/oebb-cors-proxy.mjs</code>
            (README, Abschnitt „ÖBB-Echtzeit“).
          </p>
        </div>

        <div id="motis-card">
          <label for="motis-url">Fahrplan-Server (MOTIS)</label>
          <input id="motis-url" type="url" inputmode="url" spellcheck="false" />
          <p class="hint">
            Voreingestellt ist die öffentliche Transitous-Instanz. Nur ändern,
            wenn du MOTIS selbst betreibst — dann verlässt keine Anfrage das Haus.
          </p>
        </div>

        <label for="refresh">Abfahrten neu laden alle <span id="refresh-value"></span> s</label>
        <input id="refresh" type="range" min="10" max="120" step="5" />
        <p class="hint">
          Gilt nur für die Abfahrtstafel. Während der Fahrt bleibt die
          Haltestellenfolge stehen — sie ändert sich nicht.
        </p>
      </details>

      <p class="credits">
        Fahrplandaten: <a href="https://transitous.org/sources/" target="_blank" rel="noopener">Transitous und seine Quellen</a>
        (u. a. OpenStreetMap) · Echtzeit Österreich: ÖBB
      </p>
    `;

    const backend = root.querySelector<HTMLSelectElement>("#backend");
    const oebbUrl = root.querySelector<HTMLInputElement>("#oebb-url");
    const motisUrl = root.querySelector<HTMLInputElement>("#motis-url");
    const refresh = root.querySelector<HTMLInputElement>("#refresh");
    const refreshValue = root.querySelector<HTMLElement>("#refresh-value");
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
    // Choosing ÖBB is only half the job until the add-on's address is set, so
    // the drawer holding it opens by itself.
    const advanced = root.querySelector<HTMLDetailsElement>("#advanced");
    if (advanced) advanced.open = settings.backend === "oebb";

    if (backendHint) {
      backendHint.textContent = settings.backend === "oebb"
        ? "Zeigt Verspätungen in ganz Österreich, bis zum Stadtbus. Braucht ein kleines "
          + "Zusatzprogramm auf einem Computer im selben WLAN – siehe „Erweitert“ unten."
        : "Funktioniert sofort, in vielen Ländern. Meist reine Fahrplanzeiten (~); "
          + "Verspätungen nur dort, wo der Verkehrsbetrieb sie meldet.";
    }

    updateStatus();

    // Each edit starts from the settings as they are now, not as they were when
    // the page was built: otherwise saving the refresh interval after changing
    // the address put the old address back.
    const commit = (change: Partial<Settings>): void => {
      void ports.setSettings({ ...ports.getSettings(), ...change });
    };

    backend.addEventListener("change", () => {
      commit({ backend: backend.value === "motis" ? "motis" : "oebb" });
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
          field.value = ports.getSettings()[key];
          return;
        }
        field.setCustomValidity("");
        commit({ [key]: field.value.trim() });
      });
    }

    refresh.addEventListener("input", () => {
      if (refreshValue) refreshValue.textContent = refresh.value;
    });
    refresh.addEventListener("change", () => {
      commit({ refreshSeconds: Number(refresh.value) || DEFAULT_SETTINGS.refreshSeconds });
    });

    root.querySelector<HTMLButtonElement>("#refresh-now")
      ?.addEventListener("click", () => { ports.refresh(); render(); });
  };

  render();
  // The status line is the only live part, so a slow beat is enough. It must
  // not rebuild the page: that wiped a proxy address half typed into its field
  // every five seconds, and took the open backend menu with it.
  setInterval(updateStatus, 5000);
}
