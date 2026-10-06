import { isLoopback, isPlainHttp, validateServerUrl } from "../api/client";
import { getLocale, languageSelect, setLocale, type Locale } from "../i18n";
import { t } from "../messages";
import { maskToken, type Settings } from "../storage/persist";
import { escapeHtml } from "./html";

/**
 * The phone companion: where the server lives, an optional token, and how the
 * glasses are operated. Projects, shots, script, schedule and packing list are
 * edited in the server's own web terminal — a laptop screen is the better
 * place for that than the Even app.
 */

export type ConnectionState =
  | { readonly kind: "none" }
  | { readonly kind: "demo" }
  | { readonly kind: "loading" }
  | { readonly kind: "ok"; readonly project: string }
  | { readonly kind: "error"; readonly reason: string };

export interface PhoneUiPorts {
  readonly getSettings: () => Settings;
  /** Persists and applies; rejects when storage refused it. */
  readonly saveSettings: (next: Settings) => Promise<void>;
  readonly connection: () => ConnectionState;
  readonly pendingCount: () => number;
  readonly locale?: () => Locale;
  readonly onLocaleChange?: (locale: Locale) => void;
}

export interface PhoneUi {
  /** Redraws the page after a change made elsewhere (connection, glasses). */
  readonly refresh: () => void;
}

/** Text inputs whose unsaved contents survive a redraw. */
const DRAFT_FIELDS = ["url", "token"] as const;

export function mountPhoneUi(ports: PhoneUiPorts): PhoneUi {
  const root = document.getElementById("app");
  if (!root) return { refresh: () => undefined };

  let notice = "";
  let locale: Locale = ports.locale?.() ?? getLocale();

  const render = (): void => {
    const typed = DRAFT_FIELDS.map((id) => root.querySelector<HTMLInputElement>("#" + id)?.value);
    root.innerHTML = template(ports.getSettings(), ports.connection(), ports.pendingCount(), locale, notice);
    notice = "";
    DRAFT_FIELDS.forEach((id, index) => {
      const field = root.querySelector<HTMLInputElement>("#" + id);
      const value = typed[index];
      if (field && value !== undefined) field.value = value;
    });
    wire();
  };

  const notify = (message: string): void => { notice = message; render(); };

  const commit = (next: Settings, okNotice: string): void => {
    ports.saveSettings(next).then(
      () => notify(okNotice),
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
      const urlField = byId<HTMLInputElement>("url");
      const tokenField = byId<HTMLInputElement>("token");
      const url = urlField?.value.trim() ?? "";
      const check = validateServerUrl(url);
      if (!check.valid) { notify(check.errors.map((key) => t(locale, key)).join(" ")); return; }
      const typedToken = tokenField?.value ?? "";
      // The token field is write-only: left empty, the stored token is kept.
      const current = ports.getSettings();
      const token = typedToken || current.token;
      // The token should not linger in the field; the address stays visible.
      if (tokenField) tokenField.value = "";
      const next: Settings = { serverUrl: url.replace(/\/+$/, ""), invertScroll: current.invertScroll, ...(token ? { token } : {}) };
      commit(next, t(locale, "p.saved"));
    });

    byId<HTMLButtonElement>("clear-token")?.addEventListener("click", () => {
      const current = ports.getSettings();
      commit({ serverUrl: current.serverUrl, invertScroll: current.invertScroll }, t(locale, "p.saved"));
    });

    byId<HTMLInputElement>("invert")?.addEventListener("change", (event) => {
      const current = ports.getSettings();
      commit({ ...current, invertScroll: (event.target as HTMLInputElement).checked }, t(locale, "p.saved"));
    });
  };

  render();
  return { refresh: render };
}

function template(settings: Settings, connection: ConnectionState, pending: number, locale: Locale, notice: string): string {
  const L = (key: string, vars: Record<string, string | number> = {}): string => escapeHtml(t(locale, key, vars));
  const url = settings.serverUrl;
  const status = (() => {
    switch (connection.kind) {
      case "none": return L("p.status.none");
      case "demo": return L("p.status.demo");
      case "loading": return L("p.status.loading");
      case "ok": return L("p.status.ok", { project: connection.project || "–" });
      case "error": return L("p.status.error", { reason: connection.reason });
    }
  })();
  const warnHttp = url && isPlainHttp(url) && !isLoopback(url);

  return `
  <header class="brand">
    <span class="brand-mark">Quietglass</span>
    <h1>Shoot Day</h1>
    <p class="hint">${L("p.lede")}</p>
  </header>

  ${notice ? `<p class="notice">${escapeHtml(notice)}</p>` : ""}

  <section class="card">
    ${languageSelect(locale)}
  </section>

  <section class="card">
    <h2>${L("p.status")}</h2>
    <p id="status">${status}</p>
    ${pending > 0 ? `<p class="hint">${L("p.status.pending", { count: pending })}</p>` : ""}
    ${url ? `<p class="hint">${L("p.terminal", { url: url + "/" })}</p>` : ""}
  </section>

  <section class="card">
    <h2>${L("p.server")}</h2>
    ${url ? "" : `<p class="hint">${L("p.firstRun")}</p>`}
    <label for="url">${L("p.url")}</label>
    <input id="url" type="text" inputmode="url" autocomplete="off" value="${escapeHtml(url)}" placeholder="${L("p.urlPlaceholder")}" />
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
      <tr><td>${L("p.c.tap")}</td><td>${L("p.c.tap.d")}</td></tr>
      <tr><td>${L("p.c.swipe")}</td><td>${L("p.c.swipe.d")}</td></tr>
      <tr><td>${L("p.c.hold")}</td><td>${L("p.c.hold.d")}</td></tr>
      <tr><td>${L("p.c.double")}</td><td>${L("p.c.double.d")}</td></tr>
    </table>
  </section>

  <footer class="hint">${L("p.privacy")}</footer>`;
}
