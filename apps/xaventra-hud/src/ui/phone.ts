import { isLoopback, isPlainHttp, validateServerUrl } from "../api/client";
import { getLocale, languageSelect, setLocale, type Locale } from "../i18n";
import { t } from "../messages";
import { maskToken, type Settings } from "../storage/persist";
import { currentCard, type HudModel } from "../hud/model";
import { hhmm } from "../cockpit/compose";
import { statusTone } from "../cockpit/model";
import { escapeHtml } from "./html";

/**
 * The phone companion (QUS v1, the look of Rain Lens): exactly three tabs -
 * Jetzt (Xaventra at a glance), Fragen (the open questions) and
 * Einstellungen (connection, glasses, language). The view models are pure so
 * the tests can read them. Answers are given on the glasses, never here.
 */

export type ConnectionState =
  | { readonly kind: "none" }
  | { readonly kind: "demo" }
  | { readonly kind: "loading" }
  | { readonly kind: "ok" }
  | { readonly kind: "error"; readonly reason: string };

/** What the phone shows of the live state. */
export interface PhoneView {
  readonly model: HudModel;
  readonly connection: ConnectionState;
}

export interface PhoneUiPorts {
  readonly getSettings: () => Settings;
  /** Persists and applies; rejects when storage refused it. */
  readonly saveSettings: (next: Settings) => Promise<void>;
  readonly connection: () => ConnectionState;
  /** The live state (what the glasses show). */
  readonly model?: () => HudModel;
  /** Asks the server again. */
  readonly refresh?: () => void;
  readonly locale?: () => Locale;
  readonly onLocaleChange?: (locale: Locale) => void;
}

export interface PhoneUi {
  /** Redraws the page after a change made elsewhere (connection, glasses). */
  readonly refresh: () => void;
}

/** Text inputs whose unsaved contents survive a redraw. */
const DRAFT_FIELDS = ["url", "token"] as const;

/** The three tabs. */
export const TABS: readonly { id: string; icon: string; key: string }[] = [
  { id: "now", icon: "🤖", key: "p.tabNow" },
  { id: "cards", icon: "❓", key: "p.tabCards" },
  { id: "settings", icon: "⚙️", key: "p.tabSettings" },
];
const TAB_KEY = "quietglass.xaventra-hud.tab";

/** Nothing set up yet (no server entered): Einstellungen opens first, with the three-step checklist. */
export function isFirstRun(settings: Settings): boolean {
  return !settings.serverUrl;
}

function readTab(firstRun: boolean): string {
  try { const v = localStorage.getItem(TAB_KEY); if (TABS.some((tab) => tab.id === v)) return v!; } catch { /* no storage */ }
  return firstRun ? "settings" : "now";
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

const esc = (text: string): string => escapeHtml(text);

// ---- pure view models (tests read these) ----------------------------------------------

export interface Banner { readonly tone: "ok" | "warn" | "critical" | "offline" | "none"; readonly text: string }

/** The one message that counts right now. */
export function bannerFor(view: PhoneView, locale: Locale): Banner {
  const x = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  const { model, connection } = view;
  if (connection.kind === "none") return { tone: "none", text: x("p.banner.none") };
  if (connection.kind === "demo") return { tone: "none", text: x("p.banner.demo") };
  if (connection.kind === "loading") return { tone: "none", text: x("p.banner.loading") };
  if (connection.kind === "error") return { tone: model.fault ? "critical" : "offline", text: x("p.banner.error", { reason: connection.reason }) };
  const cards = model.feed?.cards.length ?? 0;
  if (cards > 0) return { tone: "warn", text: x("p.banner.cards", { n: cards }) };
  const status = model.feed?.status.trim() ?? "";
  return status && statusTone(model) === "ok" && !/^(alles ruhig|ruhig|bereit|idle|all quiet|ready)/i.test(status)
    ? { tone: "ok", text: x("p.banner.working", { status }) }
    : { tone: "ok", text: x("p.banner.ok") };
}

/** "Jetzt": banner, hero card, 2 x 2 key figures, the one button, a card per open question. */
export function nowInner(view: PhoneView, locale: Locale): string {
  const x = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  const { model } = view;
  const banner = bannerFor(view, locale);
  const cards = model.feed?.cards ?? [];
  const card = currentCard(model);
  const effect = card ? (card.effect.trim().toLowerCase() === "intern" ? x("g.cp.internal") : card.effect) : "–";
  const stat = (label: string, value: string, unit: string, alert = false): string =>
    `<div${alert ? ' class="alert"' : ""}><span>${esc(label)}</span><b>${esc(value)}</b><small>${esc(unit)}</small></div>`;
  const strip = cards.map((entry) => `<div class="host tone-warn"><b>${esc(entry.title)}</b><em>${esc(entry.effect.trim().toLowerCase() === "intern" ? x("g.cp.internal") : entry.effect)}</em><span>${esc(entry.text)}</span></div>`);
  return `
    <p class="banner tone-${banner.tone}">${esc(banner.text)}</p>
    <section class="card hero-card">
      <div class="hero">
        <div><span>${esc(x("p.hero.label"))}</span><strong>${esc(model.online ? String(cards.length) : "–")}</strong></div>
        <p>${esc(model.feedAt > 0 ? x("p.hero.side", { time: hhmm(model.feedAt) }) : "")}</p>
      </div>
      <div class="stats">
        ${stat(x("p.stat.cards"), model.online ? String(cards.length) : "–", x("p.unit.open"), cards.length > 0)}
        ${stat(x("p.stat.server"), model.demo ? x("g.state.demo") : x(model.online ? "p.serverOk" : "p.serverDown"), "", !model.online && !model.demo)}
        ${stat(x("p.stat.stand"), model.feedAt > 0 ? hhmm(model.feedAt) : "–", "")}
        ${stat(x("p.stat.effect"), effect, "")}
      </div>
      <button id="refresh" type="button" class="big">${esc(x("p.refresh"))}</button>
    </section>
    ${strip.length > 0 ? `<h2 class="strip-title">${esc(x("p.strip.cards"))}</h2><div class="strip">${strip.join("")}</div>` : ""}`;
}

/** "Fragen": one card per open question; answering happens on the glasses. */
export function cardsInner(view: PhoneView, locale: Locale): string {
  const cards = view.model.feed?.cards ?? [];
  const x = (key: string): string => t(locale, key);
  if (cards.length === 0) return `<section class="card"><p class="hint">${esc(x("p.cards.empty"))}</p></section>`;
  return cards.map((card) => `
    <section class="card server tone-warn">
      <div class="server-head"><h2>${esc(card.title)}</h2><span class="tag tone-warn">${esc(card.effect.trim().toLowerCase() === "intern" ? x("g.cp.internal") : card.effect)}</span></div>
      <p>${esc(card.text)}</p>
    </section>`).join("") + `<p class="hint">${esc(x("p.cards.hint"))}</p>`;
}

/** First-run checklist: pure, so tests can read it. */
export function setupInner(settings: Settings, answered: boolean, locale: Locale): string {
  const added = !isFirstRun(settings);
  const step = (n: number, done: boolean, key: string): string =>
    `<li class="${done ? "done" : ""}"><span class="num" aria-hidden="true">${done ? "✓" : n}</span><span>${esc(t(locale, key))}</span></li>`;
  return `<ol class="steps">${step(1, added, "p.setup.1")}${step(2, added, "p.setup.2")}${step(3, added && answered, "p.setup.3")}</ol>`
    + (added ? "" : `<p class="hint">${esc(t(locale, "p.setup.demo"))}</p>`);
}

/** The status pill: the connection in a word. */
export function pillOf(connection: ConnectionState, locale: Locale): { text: string; on: boolean } {
  return { text: t(locale, "p.pill." + connection.kind), on: connection.kind === "ok" };
}

// ---- mounting ---------------------------------------------------------------------------

export function mountPhoneUi(ports: PhoneUiPorts): PhoneUi {
  const root = document.getElementById("app");
  if (!root) return { refresh: () => undefined };

  let notice = "";
  let locale: Locale = ports.locale?.() ?? getLocale();
  let tab = readTab(isFirstRun(ports.getSettings()));

  const view = (): PhoneView => ({ model: ports.model?.() ?? { ...EMPTY_VIEW_MODEL }, connection: ports.connection() });

  const render = (): void => {
    const typed = DRAFT_FIELDS.map((id) => root.querySelector<HTMLInputElement>("#" + id)?.value);
    root.innerHTML = template(ports.getSettings(), view(), locale, notice);
    notice = "";
    applyTab(root, tab);
    root.querySelectorAll<HTMLButtonElement>("[data-tab-go]").forEach((button) => {
      button.addEventListener("click", () => {
        tab = button.dataset["tabGo"] ?? "now";
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

    byId<HTMLButtonElement>("refresh")?.addEventListener("click", () => { ports.refresh?.(); });

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

/** An empty live state for a phone page mounted without a glasses model (tests). */
const EMPTY_VIEW_MODEL: HudModel = {
  configured: false, demo: false, screen: "start", startCursor: 0, feedAt: 0, online: false, problem: "", fault: false, feed: null, index: 0,
  confirm: null, nein: null, message: "", voice: null, rec: "off", live: "", recSince: 0, draft: "",
};

function template(settings: Settings, view: PhoneView, locale: Locale, notice: string): string {
  const L = (key: string, vars: Record<string, string | number> = {}): string => escapeHtml(t(locale, key, vars));
  const url = settings.serverUrl;
  const firstRun = isFirstRun(settings);
  const warnHttp = url && isPlainHttp(url) && !isLoopback(url);
  const pill = pillOf(view.connection, locale);

  return `
  <header class="brand bar">
    <div>
      <div class="brand-mark">${L("p.kicker")}</div>
      <h1>Xaventra HUD</h1>
    </div>
    <span id="pill" class="chip${pill.on ? " on" : ""}">${esc(pill.text)}</span>
  </header>

  ${notice ? `<p class="notice">${escapeHtml(notice)}</p>` : ""}

  <div class="tab" data-tab="now"><div id="now">${nowInner(view, locale)}</div></div>
  <div class="tab" data-tab="cards"><div id="cards-live">${cardsInner(view, locale)}</div></div>

  <div class="tab" data-tab="settings">
    ${firstRun ? `<section class="card setup"><h2>${L("p.setup.title")}</h2>${setupInner(settings, view.connection.kind === "ok", locale)}</section>` : ""}
    <details class="fold card"${firstRun ? " open" : ""}>
      <summary>${L(firstRun ? "p.server" : "p.server.set")}</summary>
      ${firstRun ? `<p class="hint">${L("p.firstRun")}</p>` : ""}
      <label for="url">${L("p.url")}</label>
      <input id="url" type="text" inputmode="url" autocomplete="off" value="${escapeHtml(url)}" placeholder="${L("p.urlPlaceholder")}" />
      ${warnHttp ? `<p class="hint"><small class="warn">${L("p.httpWarn")}</small></p>` : ""}
      <label for="token">${L("p.token")}</label>
      <input id="token" type="password" autocomplete="off" placeholder="${L("p.tokenPlaceholder")}" />
      <p class="hint">${L("p.tokenNow", { state: maskToken(settings.token, locale) })}</p>
      <button id="save" type="button" class="big">${L("p.save")}</button>
      ${settings.token ? `<button id="clear-token" type="button" class="remove">${L("p.tokenClear")}</button>` : ""}
      <p class="hint">${L("p.https")}</p>
    </details>

    <section class="card">
      <h2>${L("p.glasses")}</h2>
      <label class="check"><input id="invert" type="checkbox" ${settings.invertScroll ? "checked" : ""} /> ${L("p.invert")}</label>
      <details class="fold">
        <summary>${L("p.controls")}</summary>
        <table class="keys">
          <tr><td>${L("p.c.tap")}</td><td>${L("p.c.tap.d")}</td></tr>
          <tr><td>${L("p.c.swipe")}</td><td>${L("p.c.swipe.d")}</td></tr>
          <tr><td>${L("p.c.hold")}</td><td>${L("p.c.hold.d")}</td></tr>
          <tr><td>${L("p.c.double")}</td><td>${L("p.c.double.d")}</td></tr>
        </table>
      </details>
    </section>

    <section class="card compact">${languageSelect(locale)}</section>

    <details class="fold card">
      <summary>${L("p.more")}</summary>
      <p class="hint">${L("p.lede")}</p>
      <p class="hint">${L("p.privacy")}</p>
    </details>
  </div>

  <nav class="tabbar" role="tablist">
    ${TABS.map(({ id, icon, key }) => `<button type="button" role="tab" data-tab-go="${id}"><span aria-hidden="true">${icon}</span>${L(key)}</button>`).join("")}
  </nav>`;
}
