import { isPlainHttp, validateUrl } from "../ns/client";
import { normaliseLimits, type Limits } from "../ns/alerts";
import type { Reading } from "../ns/model";
import { glucose, parseGlucose, unitLabel, type Unit } from "../ns/units";
import { getLocale, languageSelect, setLocale, type Locale } from "../i18n";
import { t } from "../messages";
import { arrowText, ageText } from "../glasses/views";
import { BUILD_URL, maskToken, type Settings } from "../storage/persist";
import { escapeHtml } from "./html";

/**
 * The phone companion: where Nightscout (or the bridge) lives, an optional
 * token, unit, target range and alert limits, and the current value.
 */

export type PhoneConnection =
  | { readonly kind: "none" }
  | { readonly kind: "demo" }
  | { readonly kind: "loading" }
  | { readonly kind: "ok" }
  | { readonly kind: "error"; readonly reason: string };

export interface PhoneUiPorts {
  readonly getSettings: () => Settings;
  readonly saveSettings: (next: Settings) => Promise<void>;
  readonly connection: () => PhoneConnection;
  readonly newest: () => Reading | null;
  readonly locale?: () => Locale;
  readonly onLocaleChange?: (locale: Locale) => void;
  readonly build?: string;
}

export interface PhoneUi {
  readonly refresh: () => void;
}

const DRAFT_FIELDS = ["url", "token", "targetLow", "targetHigh", "urgentLow", "low", "high", "stale"] as const;
const LIMIT_FIELDS = ["targetLow", "targetHigh", "urgentLow", "low", "high"] as const;

export function mountPhoneUi(ports: PhoneUiPorts): PhoneUi {
  const root = document.getElementById("app");
  if (!root) return { refresh: () => undefined };

  let notice = "";
  let locale: Locale = ports.locale?.() ?? getLocale();

  const render = (): void => {
    const typed = DRAFT_FIELDS.map((id) => root.querySelector<HTMLInputElement>("#" + id)?.value);
    root.innerHTML = template(ports.getSettings(), ports.connection(), ports.newest(), locale, notice, ports.build ?? "");
    notice = "";
    DRAFT_FIELDS.forEach((id, index) => {
      const field = root.querySelector<HTMLInputElement>("#" + id);
      const value = typed[index];
      if (field && value !== undefined && value !== "") field.value = value;
    });
    wire();
  };

  const notify = (message: string): void => { notice = message; render(); };

  const commit = (next: Settings, clearDrafts = false): void => {
    if (clearDrafts) for (const id of DRAFT_FIELDS) { const f = root.querySelector<HTMLInputElement>("#" + id); if (f) f.value = ""; }
    ports.saveSettings(next).then(
      () => notify(t(locale, "p.saved")),
      (thrown: unknown) => notify(t(locale, "p.saveFailed", { reason: thrown instanceof Error ? thrown.message : String(thrown) })),
    );
  };

  const wire = (): void => {
    const byId = <T extends HTMLElement>(id: string): T | null => root.querySelector<T>("#" + id);

    byId<HTMLSelectElement>("language")?.addEventListener("change", (event) => {
      const value = (event.target as HTMLSelectElement).value;
      if (value !== "de" && value !== "en") return;
      locale = value;
      setLocale(locale);
      ports.onLocaleChange?.(locale);
      render();
    });

    byId<HTMLButtonElement>("save")?.addEventListener("click", () => {
      const url = byId<HTMLInputElement>("url")?.value.trim() ?? "";
      const current = ports.getSettings();
      // Empty is fine when the build carries its own address.
      const check = url === "" && BUILD_URL ? { valid: true, errors: [] } : validateUrl(url || current.url);
      if (!check.valid) { notify(check.errors.map((key) => t(locale, key)).join(" ")); return; }
      const tokenField = byId<HTMLInputElement>("token");
      // The token field is write-only: left empty, the stored token is kept.
      const token = (tokenField?.value ?? "") || current.token;
      if (tokenField) tokenField.value = "";
      const nextUrl = (url || current.url).replace(/\/+$/, "");
      commit({ ...current, url: nextUrl, ...(token ? { token } : {}) });
    });

    byId<HTMLButtonElement>("clear-token")?.addEventListener("click", () => {
      const { token: _drop, ...rest } = ports.getSettings();
      commit(rest);
    });

    byId<HTMLSelectElement>("unit")?.addEventListener("change", (event) => {
      const value = (event.target as HTMLSelectElement).value === "mmol" ? "mmol" : "mgdl";
      commit({ ...ports.getSettings(), unit: value }, true);
    });

    byId<HTMLButtonElement>("save-limits")?.addEventListener("click", () => {
      const current = ports.getSettings();
      const next: Record<string, number> = { ...current.limits };
      for (const id of LIMIT_FIELDS) {
        const raw = byId<HTMLInputElement>(id)?.value ?? "";
        if (raw.trim() === "") continue;
        const mgdl = parseGlucose(raw, current.unit);
        if (mgdl === null) { notify(t(locale, "p.limitsBad")); return; }
        next[id] = mgdl;
      }
      const staleRaw = byId<HTMLInputElement>("stale")?.value ?? "";
      if (staleRaw.trim() !== "") {
        const minutes = Number(staleRaw);
        if (!Number.isFinite(minutes) || minutes < 6 || minutes > 60) { notify(t(locale, "p.limitsBad")); return; }
        next["staleMinutes"] = minutes;
      }
      commit({ ...current, limits: normaliseLimits(next as Partial<Limits>) }, true);
    });

    byId<HTMLInputElement>("invert")?.addEventListener("change", (event) => {
      commit({ ...ports.getSettings(), invertScroll: (event.target as HTMLInputElement).checked });
    });
  };

  render();
  return { refresh: render };
}

function limitInput(id: string, label: string, mgdl: number, unit: Unit, locale: Locale): string {
  return `<label for="${id}">${label} (${unitLabel(unit)})</label><input id="${id}" type="text" inputmode="decimal" autocomplete="off" placeholder="${escapeHtml(glucose(mgdl, unit, locale))}" />`;
}

function template(settings: Settings, connection: PhoneConnection, newest: Reading | null, locale: Locale, notice: string, build: string): string {
  const L = (key: string, vars: Record<string, string | number> = {}): string => escapeHtml(t(locale, key, vars));
  const url = settings.url;
  const shown = url || BUILD_URL;
  const unit = settings.unit;
  const line = (() => {
    if (connection.kind === "none") return L("p.status.none");
    if (connection.kind === "error") return L("p.status.error", { reason: connection.reason });
    if (!newest) return connection.kind === "loading" ? L("p.status.loading") : connection.kind === "demo" ? L("p.status.demo") : L("p.status.noData");
    return L("p.status.value", { value: glucose(newest.mgdl, unit, locale), unit: unitLabel(unit), arrow: arrowText(newest.direction), age: ageText(locale, Date.now() - newest.at) });
  })();
  const warnHttp = url && isPlainHttp(url);
  const limits = settings.limits;

  return `
  <header class="brand">
    <span class="brand-mark">Quietglass</span>
    <h1>Sugar Glass</h1>
    <p class="hint">${L("p.lede")}</p>
  </header>

  ${notice ? `<p class="notice">${escapeHtml(notice)}</p>` : ""}

  <section class="card warn-card">
    <p>${L("p.notice")}</p>
  </section>

  <section class="card">
    <h2>${L("p.status")}</h2>
    <p id="status" class="big">${line}</p>
    ${connection.kind === "demo" ? `<p class="hint">${L("p.status.demo")}</p>` : ""}
  </section>

  <section class="card">
    ${languageSelect(locale)}
  </section>

  <section class="card">
    <h2>${L("p.display")}</h2>
    <label for="unit">${L("p.unit")}</label>
    <select id="unit"><option value="mgdl"${unit === "mgdl" ? " selected" : ""}>mg/dL</option><option value="mmol"${unit === "mmol" ? " selected" : ""}>mmol/L</option></select>
    ${limitInput("targetLow", L("p.targetLow"), limits.targetLow, unit, locale)}
    ${limitInput("targetHigh", L("p.targetHigh"), limits.targetHigh, unit, locale)}
    ${limitInput("urgentLow", L("p.urgentLow"), limits.urgentLow, unit, locale)}
    ${limitInput("low", L("p.low"), limits.low, unit, locale)}
    ${limitInput("high", L("p.high"), limits.high, unit, locale)}
    <label for="stale">${L("p.stale")}</label>
    <input id="stale" type="text" inputmode="numeric" autocomplete="off" placeholder="${limits.staleMinutes}" />
    <button id="save-limits" type="button">${L("p.limitsSave")}</button>
  </section>

  <section class="card">
    <h2>${L("p.server")}</h2>
    ${shown ? "" : `<p class="hint">${L("p.firstRun")}</p>`}
    <label for="url">${L("p.url")}</label>
    <input id="url" type="text" inputmode="url" autocomplete="off" value="${escapeHtml(url)}" placeholder="${BUILD_URL ? escapeHtml(BUILD_URL) : L("p.urlPlaceholder")}" />
    ${BUILD_URL ? `<p class="hint">${L("p.urlBuild")}</p>` : ""}
    ${warnHttp ? `<p class="hint"><small class="warn">${L("p.httpWarn")}</small></p>` : ""}
    <label for="token">${L("p.token")}</label>
    <input id="token" type="password" autocomplete="off" placeholder="${L("p.tokenPlaceholder")}" />
    <p class="hint">${L("p.tokenNow", { state: maskToken(settings.token, locale) })}</p>
    <button id="save" type="button">${L("p.save")}</button>
    ${settings.token ? `<button id="clear-token" type="button" class="secondary">${L("p.tokenClear")}</button>` : ""}
    <label class="check"><input id="invert" type="checkbox" ${settings.invertScroll ? "checked" : ""} /> ${L("p.invert")}</label>
  </section>

  <section class="card">
    <h2>${L("p.controls")}</h2>
    <table class="keys">
      <tr><td>${L("p.c.swipe")}</td><td>${L("p.c.swipe.d")}</td></tr>
      <tr><td>${L("p.c.tap")}</td><td>${L("p.c.tap.d")}</td></tr>
      <tr><td>${L("p.c.double")}</td><td>${L("p.c.double.d")}</td></tr>
    </table>
  </section>

  <footer class="hint">${L("p.privacy")}${build ? " · " + escapeHtml(build) : ""}</footer>`;
}
