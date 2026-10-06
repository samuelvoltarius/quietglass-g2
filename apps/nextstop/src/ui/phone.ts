import type { Stop } from "../transit/types";
import type { Position } from "../ride/tracker";
import { DEFAULT_SETTINGS, validateUrl, type Settings } from "../storage/persist";
import { nextStep } from "../text";
import { languageSelect, type Locale } from "../i18n";
import { t } from "../messages";

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
  /** The language of the phone page and the glasses; English when absent. */
  getLocale?(): Locale;
  /** Called when the language is changed on this page; must redraw the glasses. */
  setLocale?(locale: Locale): void;
}

export function mountPhoneUi(ports: PhoneUiPorts): void {
  const root = document.getElementById("app");
  if (!root) return;

  const locale = (): Locale => ports.getLocale?.() ?? "en";

  const statusText = (): string => {
    const lang = locale();
    const position = ports.getPosition();
    const stops = ports.getStops();
    const where = !position
      ? t(lang, "p.noPosition")
      : ports.isSeeded()
        ? t(lang, "p.seeded")
        : typeof position.accuracy === "number"
          ? t(lang, "p.positionFoundAccuracy", { metres: Math.round(position.accuracy) })
          : t(lang, "p.positionFound");
    const found = stops.length === 0
      ? t(lang, "p.noStopsYet")
      : t(lang, "p.nearestStop", { count: stops.length, stop: stops[0]?.name ?? "?" });
    return `${where} ${found}`;
  };

  /** Only the status lines are live; they are updated in place. */
  const updateStatus = (): void => {
    const status = root.querySelector<HTMLElement>("#status");
    if (status) status.textContent = statusText();
    const next = root.querySelector<HTMLElement>("#next");
    if (next) next.textContent = nextStep(ports.getPosition() !== null, ports.getStops().length, locale());
  };

  const render = (): void => {
    const settings = ports.getSettings();

    const lang = locale();
    const x = (key: string, vars: Record<string, string | number> = {}): string => t(lang, key, vars);
    if (document.documentElement) document.documentElement.lang = lang;

    root.innerHTML = `
      <div class="brand"><span class="brand-mark">Quietglass</span> NextStop</div>
      <div class="card compact">${languageSelect(lang)}</div>
      <p class="next" id="next"></p>

      <div class="card">
        <label for="backend">${x("p.sourceLabel")}</label>
        <select id="backend">
          <option value="motis">${x("p.sourceMotis")}</option>
          <option value="oebb">${x("p.sourceOebb")}</option>
        </select>
        <p class="hint" id="backend-hint"></p>
      </div>

      <div class="card">
        <label>${x("p.status")}</label>
        <p class="hint" id="status"></p>
        <button id="refresh-now" type="button">${x("p.refreshNow")}</button>
      </div>

      <div class="card keys">
        <label>${x("p.controls")}</label>
        <p class="hint">
          <strong>${x("p.swipe")}</strong> — ${x("p.swipeDoes")}<br />
          <strong>${x("p.tap")}</strong> — ${x("p.tapDoes")}<br />
          <strong>${x("p.hold")}</strong> — ${x("p.holdDoes")}<br />
          <strong>${x("p.doubleTap")}</strong> — ${x("p.doubleTapDoes")}<br />
          ${x("p.legend")}
        </p>
      </div>

      <details class="card advanced" id="advanced">
        <summary>${x("p.advanced")}</summary>

        <div id="oebb-card">
          <label for="oebb-url">${x("p.oebbUrl")}</label>
          <input id="oebb-url" type="url" inputmode="url" spellcheck="false" />
          <p class="hint">
            ${x("p.oebbUrlHint")}
          </p>
        </div>

        <div id="motis-card">
          <label for="motis-url">${x("p.motisUrl")}</label>
          <input id="motis-url" type="url" inputmode="url" spellcheck="false" />
          <p class="hint">
            ${x("p.motisUrlHint")}
          </p>
        </div>

        <label for="refresh">${x("p.refreshEvery", { value: '<span id="refresh-value"></span>' })}</label>
        <input id="refresh" type="range" min="10" max="120" step="5" />
        <p class="hint">
          ${x("p.refreshHint")}
        </p>
      </details>

      <p class="credits">
        ${x("p.credits", { link: `<a href="https://transitous.org/sources/" target="_blank" rel="noopener">${x("p.creditsLink")}</a>` })}
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
      backendHint.textContent = x(settings.backend === "oebb" ? "p.sourceHintOebb" : "p.sourceHintMotis");
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
        const check = validateUrl(field.value, lang);
        if (!check.valid) {
          field.setCustomValidity(check.error ?? x("p.invalid"));
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

    // The language applies to the glasses too: the port redraws them at once.
    const language = root.querySelector<HTMLSelectElement>("#language");
    language?.addEventListener("change", () => {
      ports.setLocale?.(language.value === "de" ? "de" : "en");
      render();
    });

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
