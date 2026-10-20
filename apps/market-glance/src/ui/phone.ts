import { languageSelect, type Locale } from "../i18n";
import { cents, money, providerTag, type Position } from "../markets/model";
import { feedLabel, feedWord, providerLabel, totals, usd, type FeedStatus } from "../cockpit/model";
import { t } from "../text";
import { escapeHtml } from "./html";
import type { Tone } from "../cockpit/compose";

/**
 * The phone companion (QUS v1, the look of Rain Lens): exactly three tabs -
 * Jetzt (the portfolio at a glance), Positionen (a card per position) and
 * Einstellungen (bridge, glasses, language). The view models are pure so the
 * tests can read them.
 */

export interface PhoneState {
  readonly positions: readonly Position[];
  readonly status: FeedStatus;
  readonly lastError: string;
  readonly now: number;
}

export interface PhonePorts {
  readonly getState: () => PhoneState;
  readonly getLocale: () => Locale;
  readonly setLocale: (locale: Locale) => void;
  readonly getEndpoint: () => string;
  readonly isConfigured: () => boolean;
  readonly saveEndpoint: (value: string) => void;
  readonly getInvert: () => boolean;
  readonly setInvert: (value: boolean) => void;
  readonly refresh: () => void;
}

export interface PhoneUi { readonly refreshLive: () => void }

/** The three tabs. */
export const TABS: readonly { id: string; icon: string; key: "tabNow" | "tabPositions" | "tabSettings" }[] = [
  { id: "now", icon: "📈", key: "tabNow" },
  { id: "positions", icon: "🗂️", key: "tabPositions" },
  { id: "settings", icon: "⚙️", key: "tabSettings" },
];
const TAB_KEY = "quietglass.marketglance.tab";

/** Nothing set up yet (no bridge address saved): Einstellungen opens first, with the three-step checklist. */
export function isFirstRun(configured: boolean): boolean { return !configured; }

export interface Banner { readonly tone: Tone | "none"; readonly text: string }

/** The one message that counts right now. */
export function bannerFor(state: PhoneState, locale: Locale): Banner {
  const { status, now } = state;
  if (status.source === "demo") return { tone: "none", text: t(locale, "bannerDemo") };
  const word = feedWord(status, now);
  if (word.kind === "stale") return { tone: "offline", text: t(locale, "bannerStale", { age: word.age ?? "" }) };
  if (status.errors.length > 0) return { tone: "warn", text: t(locale, "bannerErrors", { names: [...new Set(status.errors.map((e) => providerLabel(e.provider)))].join(", ") }) };
  return { tone: "ok", text: t(locale, "bannerOk") };
}

export interface PhoneSummary {
  readonly count: number;
  readonly value: number;
  readonly pnl: number | null;
  readonly realized: number | null;
  readonly sources: string;
}

export function summarize(positions: readonly Position[]): PhoneSummary {
  const total = totals(positions);
  return { count: positions.length, value: total.value, pnl: total.pnl, realized: total.realized, sources: [...new Set(positions.map((p) => providerTag(p.provider)))].join(" ") };
}

const esc = (text: string): string => escapeHtml(text);

/** "Jetzt": banner, hero card, 2 x 2 key figures, the one button, a card per position. */
export function nowInner(state: PhoneState, locale: Locale): string {
  const sum = summarize(state.positions);
  const banner = bannerFor(state, locale);
  const stat = (label: string, value: string, unit: string, alert = false): string =>
    `<div${alert ? ' class="alert"' : ""}><span>${esc(label)}</span><b>${esc(value)}</b><small>${esc(unit)}</small></div>`;
  const cards = state.positions.map((p) =>
    `<div class="host tone-${p.pnl !== null && p.pnl < 0 ? "warn" : "ok"}"><b>${esc(p.title)}</b><em>${esc(cents(p.price))} · ${esc(money(p.pnl))}</em><span>${esc(providerLabel(p.provider))} · ${esc(p.outcome)}</span></div>`);
  return `
    <p class="banner tone-${banner.tone}">${esc(banner.text)}</p>
    <section class="card hero-card">
      <div class="hero">
        <div><span>${esc(t(locale, "heroLabel"))}</span><strong>${esc(sum.count === 0 ? "–" : usd(sum.value))}</strong></div>
        <p>${esc(t(locale, "heroSide", { n: sum.count }))}</p>
      </div>
      <div class="stats">
        ${stat(t(locale, "statPnl"), money(sum.pnl), t(locale, "unitUsd"), sum.pnl !== null && sum.pnl < 0)}
        ${stat(t(locale, "statRealized"), money(sum.realized), t(locale, "unitUsd"))}
        ${stat(t(locale, "statCount"), String(sum.count), t(locale, "unitOpen"))}
        ${stat(t(locale, "statSource"), state.status.source === "demo" ? t(locale, "demoWord") : sum.sources || "–", "")}
      </div>
      <button id="refresh" type="button" class="big">${esc(t(locale, "refresh"))}</button>
    </section>
    ${cards.length > 0 ? `<h2 class="strip-title">${esc(t(locale, "stripTitle"))}</h2><div class="strip">${cards.join("")}</div>` : ""}`;
}

/** "Positionen": one card per position, with its numbers. */
export function positionsInner(state: PhoneState, locale: Locale): string {
  if (state.positions.length === 0) return `<section class="card"><p class="hint">${esc(t(locale, "positionsEmpty"))}</p></section>`;
  const error = state.lastError ? `<p class="banner tone-warn">${esc(t(locale, "lastError"))}: ${esc(state.lastError)}</p>` : "";
  return error + state.positions.map((p) => `
    <section class="card server tone-${p.pnl !== null && p.pnl < 0 ? "warn" : "ok"}">
      <div class="server-head"><h2>${esc(p.title)}</h2><span class="tag">${esc(providerLabel(p.provider))}</span></div>
      <div class="stats three">
        <div><span>${esc(t(locale, "cellPrice"))}</span><b>${esc(cents(p.price))}</b></div>
        <div${p.pnl !== null && p.pnl < 0 ? ' class="alert"' : ""}><span>${esc(t(locale, "cellPnl"))}</span><b>${esc(money(p.pnl))}</b></div>
        <div><span>${esc(t(locale, "cellValue"))}</span><b>${esc(usd(p.currentValue))}</b></div>
      </div>
      <p class="hint">${esc(p.outcome)} · ${esc(t(locale, "cellQuantity"))} ${esc(String(p.quantity))}${p.realizedPnl === undefined ? "" : ` · ${esc(t(locale, "realized"))} ${esc(money(p.realizedPnl))}`}</p>
    </section>`).join("");
}

/** First-run checklist: pure, so tests can read it. */
export function setupInner(configured: boolean, answered: boolean, locale: Locale): string {
  const step = (n: number, done: boolean, key: "setup1" | "setup2" | "setup3"): string =>
    `<li class="${done ? "done" : ""}"><span class="num" aria-hidden="true">${done ? "✓" : n}</span><span>${esc(t(locale, key))}</span></li>`;
  return `<ol class="steps">${step(1, configured, "setup1")}${step(2, configured, "setup2")}${step(3, configured && answered, "setup3")}</ol>`
    + (configured ? "" : `<p class="hint">${esc(t(locale, "setupDemo"))}</p>`);
}

function pillOf(status: FeedStatus, now: number, locale: Locale): { text: string; on: boolean } {
  const word = feedWord(status, now);
  return { text: feedLabel(word, locale), on: word.kind === "live" };
}

export function template(state: PhoneState, locale: Locale, ports: Pick<PhonePorts, "getEndpoint" | "isConfigured" | "getInvert">): string {
  const configured = ports.isConfigured();
  const firstRun = isFirstRun(configured);
  const pill = pillOf(state.status, state.now, locale);
  const answered = state.status.source === "live";
  return `
  <header class="brand bar">
    <div>
      <div class="brand-mark">${esc(t(locale, "kicker"))}</div>
      <h1>Market Glance</h1>
    </div>
    <span id="pill" class="chip${pill.on ? " on" : ""}">${esc(pill.text)}</span>
  </header>

  <div class="tab" data-tab="now"><div id="now-live">${nowInner(state, locale)}</div></div>
  <div class="tab" data-tab="positions"><div id="positions-live">${positionsInner(state, locale)}</div></div>

  <div class="tab" data-tab="settings">
    ${firstRun ? `<section class="card setup"><h2>${esc(t(locale, "setupTitle"))}</h2>${setupInner(configured, answered, locale)}</section>` : ""}
    <details class="fold card"${firstRun ? " open" : ""}>
      <summary>${esc(firstRun ? t(locale, "bridgeSummary") : t(locale, "bridgeTitle") + " · " + t(locale, "bridgeSummary"))}</summary>
      <label for="endpoint">${esc(t(locale, "endpoint"))}</label>
      <input id="endpoint" type="text" value="${esc(ports.getEndpoint())}" />
      <button id="save" type="button" class="big">${esc(t(locale, "save"))}</button>
    </details>
    <section class="card">
      <h2>${esc(t(locale, "glassesTitle"))}</h2>
      <label class="check"><input id="invert" type="checkbox" ${ports.getInvert() ? "checked" : ""} /> ${esc(t(locale, "invert"))}</label>
      <p class="hint">${esc(t(locale, "invertHint"))}</p>
    </section>
    <section class="card compact">${languageSelect(locale)}</section>
    <details class="fold card">
      <summary>${esc(t(locale, "moreTitle"))}</summary>
      <p class="hint">${esc(t(locale, "about"))}</p>
      <p class="hint">${esc(t(locale, "warning"))}</p>
    </details>
  </div>

  <nav class="tabbar" role="tablist">
    ${TABS.map(({ id, icon, key }) => `<button type="button" role="tab" data-tab-go="${id}"><span aria-hidden="true">${icon}</span>${esc(t(locale, key))}</button>`).join("")}
  </nav>`;
}

function readTab(firstRun: boolean): string {
  try { const v = localStorage.getItem(TAB_KEY); if (TABS.some((tab) => tab.id === v)) return v!; } catch { /* no storage */ }
  return firstRun ? "settings" : "now";
}

function applyTab(root: ParentNode, active: string): void {
  root.querySelectorAll<HTMLElement>("[data-tab]").forEach((el) => { el.hidden = el.dataset["tab"] !== active; });
  root.querySelectorAll<HTMLButtonElement>("[data-tab-go]").forEach((button) => {
    const on = button.dataset["tabGo"] === active;
    button.classList.toggle("on", on);
    button.setAttribute("aria-selected", String(on));
  });
}

export function mountPhoneUi(ports: PhonePorts): PhoneUi {
  const root = document.querySelector<HTMLElement>("#app");
  if (!root) return { refreshLive: () => undefined };
  let tab = readTab(isFirstRun(ports.isConfigured()));

  const phoneIdle = (): boolean => !document.activeElement?.matches?.("#app input, #app select");

  const render = (): void => {
    const locale = ports.getLocale();
    if (document.documentElement) document.documentElement.lang = locale;
    const typed = root.querySelector<HTMLInputElement>("#endpoint")?.value;
    root.innerHTML = template(ports.getState(), locale, ports);
    const field = root.querySelector<HTMLInputElement>("#endpoint");
    if (field && typed !== undefined && typed !== "") field.value = typed;
    applyTab(root, tab);
    root.querySelectorAll<HTMLButtonElement>("[data-tab-go]").forEach((button) => {
      button.addEventListener("click", () => {
        tab = button.dataset["tabGo"] ?? "now";
        try { localStorage.setItem(TAB_KEY, tab); } catch { /* private mode */ }
        applyTab(root, tab);
        window.scrollTo?.({ top: 0 });
      });
    });
    root.querySelector("#language")?.addEventListener("change", (event) => { ports.setLocale((event.target as HTMLSelectElement).value as Locale); render(); });
    root.querySelector("#invert")?.addEventListener("change", (event) => { ports.setInvert((event.target as HTMLInputElement).checked); });
    root.querySelector("#save")?.addEventListener("click", () => {
      const input = root.querySelector<HTMLInputElement>("#endpoint");
      if (input) ports.saveEndpoint(input.value.trim());
      render();
    });
    root.querySelector("#now-live")?.addEventListener("click", (event) => {
      if ((event.target as HTMLElement | null)?.closest?.("#refresh")) ports.refresh();
    });
  };

  render();
  return {
    refreshLive: () => {
      if (!phoneIdle()) return;
      const locale = ports.getLocale();
      const state = ports.getState();
      const set = (selector: string, html: string): void => {
        const el = root.querySelector<HTMLElement>(selector);
        if (el && el.innerHTML !== html) el.innerHTML = html;
      };
      const pill = root.querySelector<HTMLElement>("#pill");
      if (pill) {
        const next = pillOf(state.status, state.now, locale);
        if (pill.textContent !== next.text) pill.textContent = next.text;
        pill.classList?.toggle("on", next.on);
      }
      set("#now-live", nowInner(state, locale));
      set("#positions-live", positionsInner(state, locale));
    },
  };
}
