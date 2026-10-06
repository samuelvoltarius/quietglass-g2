import { isLoopback, isPlainHttp, validateBridgeUrl } from "../printer/client";
import type { PrinterStatus } from "../printer/status";
import { getLocale, languageSelect, setLocale, type Locale } from "../i18n";
import { t } from "../messages";
import { maskToken, type Settings } from "../storage/persist";
import { escapeHtml } from "./html";

/**
 * The phone companion: where the bridge lives, an optional token, and what
 * the printer is doing right now.
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
  readonly status: () => PrinterStatus | null;
  readonly locale?: () => Locale;
  readonly onLocaleChange?: (locale: Locale) => void;
}

export interface PhoneUi {
  readonly refresh: () => void;
}

const DRAFT_FIELDS = ["url", "token"] as const;

export function mountPhoneUi(ports: PhoneUiPorts): PhoneUi {
  const root = document.getElementById("app");
  if (!root) return { refresh: () => undefined };

  let notice = "";
  let locale: Locale = ports.locale?.() ?? getLocale();

  const render = (): void => {
    const typed = DRAFT_FIELDS.map((id) => root.querySelector<HTMLInputElement>("#" + id)?.value);
    root.innerHTML = template(ports.getSettings(), ports.connection(), ports.status(), locale, notice);
    notice = "";
    DRAFT_FIELDS.forEach((id, index) => {
      const field = root.querySelector<HTMLInputElement>("#" + id);
      const value = typed[index];
      if (field && value !== undefined) field.value = value;
    });
    wire();
  };

  const notify = (message: string): void => { notice = message; render(); };

  const commit = (next: Settings): void => {
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
      const check = validateBridgeUrl(url);
      if (!check.valid) { notify(check.errors.map((key) => t(locale, key)).join(" ")); return; }
      const tokenField = byId<HTMLInputElement>("token");
      const current = ports.getSettings();
      // The token field is write-only: left empty, the stored token is kept.
      const token = (tokenField?.value ?? "") || current.token;
      if (tokenField) tokenField.value = "";
      commit({ bridgeUrl: url.replace(/\/+$/, ""), invertScroll: current.invertScroll, ...(token ? { token } : {}) });
    });

    byId<HTMLButtonElement>("clear-token")?.addEventListener("click", () => {
      const current = ports.getSettings();
      commit({ bridgeUrl: current.bridgeUrl, invertScroll: current.invertScroll });
    });

    byId<HTMLInputElement>("invert")?.addEventListener("change", (event) => {
      commit({ ...ports.getSettings(), invertScroll: (event.target as HTMLInputElement).checked });
    });
  };

  render();
  return { refresh: render };
}

function template(settings: Settings, connection: PhoneConnection, status: PrinterStatus | null, locale: Locale, notice: string): string {
  const L = (key: string, vars: Record<string, string | number> = {}): string => escapeHtml(t(locale, key, vars));
  const url = settings.bridgeUrl;
  const line = (() => {
    if (connection.kind === "none") return L("p.status.none");
    if (connection.kind === "error") return L("p.status.error", { reason: connection.reason });
    if (!status) return connection.kind === "demo" ? L("p.status.demo") : L("p.status.loading");
    if (!status.online) return L("p.status.offline");
    return L("p.status.online", { state: t(locale, "g.state." + status.state), progress: status.progress, file: status.file || "–" });
  })();
  const control = status ? `<p class="hint">${L(status.controllable ? "p.control.on" : "p.control.off")}</p>` : "";
  const warnHttp = url && isPlainHttp(url) && !isLoopback(url);

  return `
  <header class="brand">
    <span class="brand-mark">Quietglass</span>
    <h1>Klipper Glance</h1>
    <p class="hint">${L("p.lede")}</p>
  </header>

  ${notice ? `<p class="notice">${escapeHtml(notice)}</p>` : ""}

  <section class="card">
    ${languageSelect(locale)}
  </section>

  <section class="card">
    <h2>${L("p.status")}</h2>
    <p id="status">${line}</p>
    ${connection.kind === "demo" ? `<p class="hint">${L("p.status.demo")}</p>` : ""}
    ${control}
  </section>

  <section class="card">
    <h2>${L("p.bridge")}</h2>
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
      <tr><td>${L("p.c.double")}</td><td>${L("p.c.double.d")}</td></tr>
    </table>
  </section>

  <footer class="hint">${L("p.privacy")}</footer>`;
}
