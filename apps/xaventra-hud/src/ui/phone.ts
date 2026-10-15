import { isLoopback, isPlainHttp, validateServerUrl } from "../api/client";
import { getLocale, languageSelect, setLocale, type Locale } from "../i18n";
import { t } from "../messages";
import { maskToken, type Settings } from "../storage/persist";
import { escapeHtml } from "./html";

/**
 * The phone companion: where the Xaventra endpoint lives, the token, and how
 * the glasses are operated. Everything else is done in Xaventra itself.
 */

export type ConnectionState =
  | { readonly kind: "none" }
  | { readonly kind: "demo" }
  | { readonly kind: "loading" }
  | { readonly kind: "ok" }
  | { readonly kind: "error"; readonly reason: string };

export interface PhoneUiPorts {
  readonly getSettings: () => Settings;
  /** Persists and applies; rejects when storage refused it. */
  readonly saveSettings: (next: Settings) => Promise<void>;
  readonly connection: () => ConnectionState;
  readonly locale?: () => Locale;
  readonly onLocaleChange?: (locale: Locale) => void;
}

export interface PhoneUi {
  /** Redraws the page after a change made elsewhere (connection, glasses). */
  readonly refresh: () => void;
}

/** Text inputs whose unsaved contents survive a redraw. */
const DRAFT_FIELDS = ["url", "token"] as const;

/** The page is split into tabs instead of one long column. */
const TABS: readonly { id: string; icon: string; key: string }[] = [
  { id: "xaventra", icon: "🤖", key: "p.tabXaventra" },
  { id: "glasses", icon: "👓", key: "p.tabGlasses" },
  { id: "server", icon: "🔌", key: "p.tabServer" },
  { id: "more", icon: "⋯", key: "p.tabMore" },
];
const TAB_KEY = "quietglass.xaventra-hud.tab";

function readTab(): string {
  try { const v = localStorage.getItem(TAB_KEY); return TABS.some((tab) => tab.id === v) ? v! : "xaventra"; } catch { return "xaventra"; }
}

/** Shows only the active tab; the choice survives redraws and restarts. */
function applyTab(root: HTMLElement, active: string): void {
  root.querySelectorAll<HTMLElement>("[data-tab]").forEach((el) => { el.hidden = el.dataset["tab"] !== active; });
  root.querySelectorAll<HTMLButtonElement>("[data-tab-go]").forEach((button) => {
    const on = button.dataset["tabGo"] === active;
    button.classList.toggle("on", on);
    button.setAttribute("aria-selected", String(on));
  });
}

export function mountPhoneUi(ports: PhoneUiPorts): PhoneUi {
  const root = document.getElementById("app");
  if (!root) return { refresh: () => undefined };

  let notice = "";
  let locale: Locale = ports.locale?.() ?? getLocale();
  let tab = readTab();

  const render = (): void => {
    const typed = DRAFT_FIELDS.map((id) => root.querySelector<HTMLInputElement>("#" + id)?.value);
    root.innerHTML = template(ports.getSettings(), ports.connection(), locale, notice);
    notice = "";
    applyTab(root, tab);
    root.querySelectorAll<HTMLButtonElement>("[data-tab-go]").forEach((button) => {
      button.addEventListener("click", () => {
        tab = button.dataset["tabGo"] ?? "xaventra";
        try { localStorage.setItem(TAB_KEY, tab); } catch { /* private mode */ }
        applyTab(root, tab);
        window.scrollTo({ top: 0 });
      });
    });
    DRAFT_FIELDS.forEach((id, index) => {
      // The token field is write-only and is never refilled after a redraw.
      if (id === "token") return;
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
      const typedToken = tokenField?.value.trim() ?? "";
      // The token field is write-only: left empty, the stored token is kept.
      const current = ports.getSettings();
      const token = typedToken || current.token;
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

function template(settings: Settings, connection: ConnectionState, locale: Locale, notice: string): string {
  const L = (key: string, vars: Record<string, string | number> = {}): string => escapeHtml(t(locale, key, vars));
  const url = settings.serverUrl;
  const status = (() => {
    switch (connection.kind) {
      case "none": return L("p.status.none");
      case "demo": return L("p.status.demo");
      case "loading": return L("p.status.loading");
      case "ok": return L("p.status.ok");
      case "error": return L("p.status.error", { reason: connection.reason });
    }
  })();
  const warnHttp = url && isPlainHttp(url) && !isLoopback(url);

  return `
  <header class="brand bar">
    <div>
      <span class="brand-mark">Quietglass</span>
      <h1>Xaventra HUD</h1>
    </div>
    <span class="chip${connection.kind === "ok" ? " on" : ""}">${L("p.chip." + connection.kind)}</span>
  </header>

  ${notice ? `<p class="notice">${escapeHtml(notice)}</p>` : ""}

  <div class="tab" data-tab="xaventra">
  <section class="card">
    <h2>${L("p.status")}</h2>
    <p class="hint">${L("p.lede")}</p>
    <p id="status">${status}</p>
  </section>
  </div>

  <div class="tab" data-tab="glasses">
  <section class="card">
    <h2>${L("p.controls")}</h2>
    <table class="keys">
      <tr><td>${L("p.c.tap")}</td><td>${L("p.c.tap.d")}</td></tr>
      <tr><td>${L("p.c.double")}</td><td>${L("p.c.double.d")}</td></tr>
      <tr><td>${L("p.c.swipe")}</td><td>${L("p.c.swipe.d")}</td></tr>
      <tr><td>${L("p.c.hold")}</td><td>${L("p.c.hold.d")}</td></tr>
    </table>
    <label class="check"><input id="invert" type="checkbox" ${settings.invertScroll ? "checked" : ""} /> ${L("p.invert")}</label>
  </section>
  </div>

  <div class="tab" data-tab="server">
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
    <p class="hint">${L("p.https")}</p>
  </section>

  </div>

  <div class="tab" data-tab="more">
  <section class="card">
    ${languageSelect(locale)}
  </section>

  <footer class="hint">${L("p.privacy")}</footer>
  </div>

  <nav class="tabbar" role="tablist">
    ${TABS.map(({ id, icon, key }) => `<button type="button" role="tab" data-tab-go="${id}"><span aria-hidden="true">${icon}</span>${L(key)}</button>`).join("")}
  </nav>`;
}
