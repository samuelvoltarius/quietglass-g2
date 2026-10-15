import { isLoopback, isPlainHttp, validateServerUrl } from "../api/client";
import { getLocale, languageSelect, setLocale, type Locale } from "../i18n";
import { t } from "../messages";
import { BUILD_URL, maskToken, type Settings } from "../storage/persist";
import { VERSION } from "../version";
import { escapeHtml } from "./html";
import type { Place, Phase } from "../sun/light";
import type { LightModel, PlaceSource } from "../sun/model";

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

/** What the Licht tab shows: the same model the glasses draw, for now. */
export interface LightPhone {
  readonly model: LightModel;
  readonly place: Place | null;
  readonly source: PlaceSource | null;
  readonly phase: Phase | null;
}

export interface PhoneUiPorts {
  readonly getSettings: () => Settings;
  /** Persists and applies; rejects when storage refused it. */
  readonly saveSettings: (next: Settings) => Promise<void>;
  readonly connection: () => ConnectionState;
  readonly pendingCount: () => number;
  readonly light?: () => LightPhone;
  readonly onLocate?: () => void;
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
  { id: "day", icon: "🎬", key: "p.tabDay" },
  { id: "light", icon: "☀️", key: "p.tabLight" },
  { id: "glasses", icon: "👓", key: "p.tabGlasses" },
  { id: "connection", icon: "🔌", key: "p.tabServer" },
  { id: "more", icon: "⚙️", key: "p.tabMore" },
];
const TAB_KEY = "quietglass.shoot-day.tab";

function readTab(): string {
  try { const v = localStorage.getItem(TAB_KEY); return TABS.some((tab) => tab.id === v) ? v! : "day"; } catch { return "day"; }
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
    root.innerHTML = template(ports.getSettings(), ports.connection(), ports.pendingCount(), locale, notice, ports.light?.() ?? null);
    notice = "";
    applyTab(root, tab);
    root.querySelectorAll<HTMLButtonElement>("[data-tab-go]").forEach((button) => {
      button.addEventListener("click", () => {
        tab = button.dataset["tabGo"] ?? "day";
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
      // Empty is fine when the build carries its own address.
      const check = url === "" && BUILD_URL ? { valid: true, errors: [] } : validateServerUrl(url);
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

    byId<HTMLButtonElement>("locate")?.addEventListener("click", () => ports.onLocate?.());

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
  // The Licht tab follows the clock; nothing else changes on its own. Never while typing.
  const ticker = setInterval(() => {
    if (tab !== "light" || !ports.light) return;
    const active = globalThis.document?.activeElement;
    if (active && (active.tagName === "INPUT" || active.tagName === "SELECT")) return;
    render();
  }, 60_000);
  // In node (tests) the timer must not keep the process alive.
  (ticker as unknown as { unref?: () => void }).unref?.();
  return { refresh: render };
}

/** The Licht tab: headline, sun now, facts, the schedule in its light and today's timeline. */
export function lightSection(light: LightPhone | null, locale: Locale, now = Date.now()): string {
  const L = (key: string, vars: Record<string, string | number> = {}): string => escapeHtml(t(locale, key, vars));
  if (!light) return "";
  const { model, place, source, phase } = light;
  const where = place && source
    ? `<p class="hint">${L("p.light.source." + source, { lat: place.latitude.toFixed(2), lon: place.longitude.toFixed(2) })}</p>`
    : "";
  const locate = `<button id="locate" type="button" class="secondary">${L("p.light.locate")}</button>`;
  if (!model.ok) {
    return `<section class="card"><h2>${L("p.light.title")}</h2><p class="hint">${L("p.light.none")}</p>${locate}</section>`;
  }
  const facts = model.facts.map((fact) => `<p class="hint">${escapeHtml(fact)}</p>`).join("");
  const shoots = model.shoots.length
    ? `<section class="card"><h2>${L("p.light.shoots")}</h2><ul class="light-list">${model.shoots.map((shoot) =>
      `<li${shoot.at < now ? ' class="past"' : ""}><b>${escapeHtml(shoot.what || shoot.time)}</b><br>${escapeHtml(shoot.line)}</li>`).join("")}</ul></section>`
    : "";
  const rows = model.timeline.map((entry) =>
    `<tr class="${entry.kind}${entry.at < now ? " past" : ""}"><td>${escapeHtml(entry.time)}</td><td>${escapeHtml(entry.label)}</td></tr>`).join("");
  return `
  <section class="card">
    <h2>${L("p.light.title")}</h2>
    <p class="light-headline">${escapeHtml(model.headline)}</p>
    <p>${L("p.light.sunNow", { sun: model.sunWords, phase: phase ? t(locale, "p.light.phase." + phase) : "–" })}</p>
    ${facts}
    <p class="hint">${escapeHtml(model.moon)}</p>
    ${where}
    ${locate}
  </section>
  ${shoots}
  <section class="card">
    <h2>${L("p.light.today")}</h2>
    <table class="keys timeline">${rows}</table>
    <p class="hint">${L("p.light.offline")}</p>
  </section>`;
}

function template(settings: Settings, connection: ConnectionState, pending: number, locale: Locale, notice: string, light: LightPhone | null): string {
  const L = (key: string, vars: Record<string, string | number> = {}): string => escapeHtml(t(locale, key, vars));
  const url = settings.serverUrl;
  const shown = url || BUILD_URL;
  const status = (() => {
    switch (connection.kind) {
      case "none": return L("p.status.none");
      case "demo": return L("p.status.demo");
      case "loading": return L("p.status.loading");
      case "ok": return L("p.status.ok", { project: connection.project || "–" });
      case "error": return L("p.status.error", { reason: connection.reason });
    }
  })();
  const warnHttp = shown && isPlainHttp(shown) && !isLoopback(shown);

  return `
  <header class="brand bar">
    <div>
      <span class="brand-mark">Quietglass</span>
      <h1>Shoot Day</h1>
    </div>
    <span class="chip${connection.kind === "ok" ? " on" : ""}">${connection.kind === "ok" && connection.project ? escapeHtml(connection.project) : L("p.chip." + connection.kind)}</span>
  </header>

  ${notice ? `<p class="notice">${escapeHtml(notice)}</p>` : ""}

  <div class="tab" data-tab="day">
  <section class="card">
    <h2>${L("p.status")}</h2>
    <p class="hint">${L("p.lede")}</p>
    <p id="status">${status}</p>
    ${pending > 0 ? `<p class="hint">${L("p.status.pending", { count: pending })}</p>` : ""}
    ${shown ? `<p class="hint">${L("p.terminal", { url: shown + "/" })}</p>` : ""}
  </section>
  </div>

  <div class="tab" data-tab="light">
  ${light ? lightSection(light, locale) : `<section class="card"><p class="hint">${L("p.light.none")}</p></section>`}
  </div>

  <div class="tab" data-tab="glasses">
  <section class="card">
    <h2>${L("p.controls")}</h2>
    <table class="keys">
      <tr><td>${L("p.c.tap")}</td><td>${L("p.c.tap.d")}</td></tr>
      <tr><td>${L("p.c.swipe")}</td><td>${L("p.c.swipe.d")}</td></tr>
      <tr><td>${L("p.c.hold")}</td><td>${L("p.c.hold.d")}</td></tr>
      <tr><td>${L("p.c.double")}</td><td>${L("p.c.double.d")}</td></tr>
      <tr><td>${L("p.c.light")}</td><td>${L("p.c.light.d")}</td></tr>
      <tr><td>${L("p.c.customers")}</td><td>${L("p.c.customers.d")}</td></tr>
    </table>
    <label class="check"><input id="invert" type="checkbox" ${settings.invertScroll ? "checked" : ""} /> ${L("p.invert")}</label>
  </section>
  </div>

  <div class="tab" data-tab="connection">
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
  </section>
  </div>

  <div class="tab" data-tab="more">
  <section class="card">
    <h2>Shoot Day</h2>
    <p>${L("p.moreVersion")} ${VERSION}</p>
    <p class="hint">${L("p.moreAbout")}</p>
  </section>

  <section class="card">
    ${languageSelect(locale)}
  </section>

  <footer class="hint">${L("p.privacy")}</footer>
  </div>

  <nav class="tabbar" role="tablist">
    ${TABS.map(({ id, icon, key }) => `<button type="button" role="tab" data-tab-go="${id}"><span aria-hidden="true">${icon}</span>${L(key)}</button>`).join("")}
  </nav>`;
}
