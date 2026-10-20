import { isLoopback, isPlainHttp, validateBridgeUrl } from "../printer/client";
import { findPrinter, isMoonrakerUrl, normalizeAddress } from "../printer/moonraker";
import type { PrinterStatus } from "../printer/status";
import { getLocale, languageSelect, setLocale, type Locale } from "../i18n";
import { t } from "../messages";
import { BUILD_URL, maskToken, type Settings } from "../storage/persist";
import { VERSION } from "../version";
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

/** The page is split into tabs instead of one long column. */
const TABS: readonly { id: string; icon: string; key: string }[] = [
  { id: "printer", icon: "🖨️", key: "p.tabPrinter" },
  { id: "glasses", icon: "👓", key: "p.tabGlasses" },
  { id: "bridge", icon: "🔌", key: "p.tabBridge" },
  { id: "more", icon: "⚙️", key: "p.tabMore" },
];
const TAB_KEY = "quietglass.klipper-glance.tab";

function readTab(): string {
  try { const v = localStorage.getItem(TAB_KEY); return TABS.some((tab) => tab.id === v) ? v! : "printer"; } catch { return "printer"; }
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
    root.innerHTML = template(ports.getSettings(), ports.connection(), ports.status(), locale, notice);
    notice = "";
    applyTab(root, tab);
    root.querySelectorAll<HTMLButtonElement>("[data-tab-go]").forEach((button) => {
      button.addEventListener("click", () => {
        tab = button.dataset["tabGo"] ?? "printer";
        try { localStorage.setItem(TAB_KEY, tab); } catch { /* private mode */ }
        applyTab(root, tab);
        window.scrollTo({ top: 0 });
      });
    });
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
      const url = normalizeAddress(byId<HTMLInputElement>("url")?.value ?? "");
      // Empty is fine when the build carries its own address.
      const check = url === "" && BUILD_URL ? { valid: true, errors: [] } : validateBridgeUrl(url);
      if (!check.valid) { notify(check.errors.map((key) => t(locale, key)).join(" ")); return; }
      const tokenField = byId<HTMLInputElement>("token");
      const current = ports.getSettings();
      // The token field is write-only: left empty, the stored token is kept.
      const token = (tokenField?.value ?? "") || current.token;
      if (tokenField) tokenField.value = "";
      const direct = byId<HTMLInputElement>("direct-control")?.checked === true;
      commit({ bridgeUrl: url.replace(/\/+$/, ""), invertScroll: current.invertScroll, ...(token ? { token } : {}), ...(direct ? { directControl: true } : {}) });
    });

    byId<HTMLButtonElement>("clear-token")?.addEventListener("click", () => {
      const current = ports.getSettings();
      commit({ bridgeUrl: current.bridgeUrl, invertScroll: current.invertScroll, ...(current.directControl ? { directControl: true } : {}) });
    });

    // 0.6.0: search the usual home networks for Moonraker and put the hit into the field.
    byId<HTMLButtonElement>("find")?.addEventListener("click", () => {
      const button = byId<HTMLButtonElement>("find");
      if (button) button.disabled = true;
      notify(t(locale, "p.finding", { net: "…" }));
      void findPrinter(fetch, undefined, (net) => notify(t(locale, "p.finding", { net: net + ".x" }))).then((found) => {
        if (button) button.disabled = false;
        if (!found) { notify(t(locale, "p.notFound")); return; }
        const field = byId<HTMLInputElement>("url");
        if (field) field.value = found;
        notify(t(locale, "p.found", { url: found }));
      });
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
  const shown = url || BUILD_URL;
  const line = (() => {
    if (connection.kind === "none") return L("p.status.none");
    if (connection.kind === "error") return L("p.status.error", { reason: connection.reason });
    if (!status) return connection.kind === "demo" ? L("p.status.demo") : L("p.status.loading");
    if (!status.online) return L("p.status.offline");
    return L("p.status.online", { state: t(locale, "g.state." + status.state), progress: status.progress, file: status.file || "–" });
  })();
  const control = status ? `<p class="hint">${L(status.controllable ? "p.control.on" : "p.control.off")}</p>` : "";
  // Direct mode talks plain http to the printer in the home network on purpose; only a bridge should be https.
  const direct = Boolean(shown) && isMoonrakerUrl(shown);
  const warnHttp = shown && !direct && isPlainHttp(shown) && !isLoopback(shown);

  return `
  <header class="brand bar">
    <div>
      <span class="brand-mark">Quietglass</span>
      <h1>Klipper Glance</h1>
    </div>
    <span class="chip${connection.kind === "ok" ? " on" : ""}">${L("p.chip." + connection.kind)}</span>
  </header>

  ${notice ? `<p class="notice">${escapeHtml(notice)}</p>` : ""}

  <div class="tab" data-tab="printer">
  <section class="card">
    <h2>${L("p.status")}</h2>
    <p class="hint">${L("p.lede")}</p>
    <p id="status">${line}</p>
    ${connection.kind === "demo" ? `<p class="hint">${L("p.status.demo")}</p>` : ""}
    ${control}
  </section>
  </div>

  <div class="tab" data-tab="glasses">
  <section class="card">
    <label class="check"><input id="invert" type="checkbox" ${settings.invertScroll ? "checked" : ""} /> ${L("p.invert")}</label>
  </section>

  <section class="card">
    ${languageSelect(locale)}
  </section>
  </div>

  <div class="tab" data-tab="bridge">
  <section class="card">
    <h2>${L("p.bridge")}</h2>
    ${shown ? "" : `<p class="hint">${L("p.firstRun")}</p>`}
    <label for="url">${L("p.url")}</label>
    <input id="url" type="text" inputmode="url" autocomplete="off" value="${escapeHtml(url)}" placeholder="${BUILD_URL ? escapeHtml(BUILD_URL) : L("p.urlPlaceholder")}" />
    <button id="find" type="button" class="secondary">${L("p.find")}</button>
    <p class="hint">${L("p.directHint")}</p>
    ${BUILD_URL ? `<p class="hint">${L("p.urlBuild")}</p>` : ""}
    ${warnHttp ? `<p class="hint"><small class="warn">${L("p.httpWarn")}</small></p>` : ""}
    <label for="token">${L("p.token")}</label>
    <input id="token" type="password" autocomplete="off" placeholder="${L("p.tokenPlaceholder")}" />
    <p class="hint">${L("p.tokenNow", { state: maskToken(settings.token, locale) })}</p>
    ${direct ? `<label class="check"><input id="direct-control" type="checkbox" ${settings.directControl ? "checked" : ""} /> ${L("p.directControl")}</label>` : ""}
    <button id="save" type="button">${L("p.save")}</button>
    ${settings.token ? `<button id="clear-token" type="button" class="secondary">${L("p.tokenClear")}</button>` : ""}
  </section>
  </div>

  <div class="tab" data-tab="more">
  <section class="card">
    <h2>${L("p.controls")}</h2>
    <table class="keys">
      <tr><td>${L("p.c.tap")}</td><td>${L("p.c.tap.d")}</td></tr>
      <tr><td>${L("p.c.swipe")}</td><td>${L("p.c.swipe.d")}</td></tr>
      <tr><td>${L("p.c.hold")}</td><td>${L("p.c.hold.d")}</td></tr>
      <tr><td>${L("p.c.double")}</td><td>${L("p.c.double.d")}</td></tr>
    </table>
  </section>

  <section class="card">
    <p><strong>Klipper Glance</strong> · ${L("p.moreVersion")} ${VERSION}</p>
    <p class="hint">${L("p.privacy")}</p>
  </section>
  </div>

  <nav class="tabbar" role="tablist">
    ${TABS.map(({ id, icon, key }) => `<button type="button" role="tab" data-tab-go="${id}"><span aria-hidden="true">${icon}</span>${L(key)}</button>`).join("")}
  </nav>`;
}
