import { languageSelect, type Locale } from "../i18n";
import { fill, qis } from "../qis";
import { words } from "../words";
import { VERSION } from "../version";
import {
  averageHr, averagePower, elapsed, hrZone, pace, paceOf, speedOf, type Mode, type Session, type Sport, type Telemetry,
} from "../telemetry/model";
import { modeWord, sportWord } from "../cockpit/model";
import { escapeHtml } from "./html";

/**
 * The phone companion (QUS v1, the look of Rain Lens): exactly three tabs -
 * Jetzt (the main value at a glance), Verlauf (the workout so far, minute by
 * minute, kept in memory only) and Einstellungen (connection, sport, heart
 * rate, glasses, language). Without a bridge it shows the sample workout.
 */

export interface PhoneState {
  readonly data: Telemetry;
  readonly mode: Mode;
  readonly sport: Sport;
  /** The sport the rider chose, or null for "automatic" (what the bridge reports). */
  readonly choice: Sport | null;
  readonly lastError: string;
  readonly session: Session;
  readonly endpoint: string;
  readonly maxHr: number;
  readonly invert: boolean;
}

export interface PhoneUiPorts {
  readonly state: () => PhoneState;
  readonly locale: () => Locale;
  readonly setLocale: (locale: Locale) => void;
  readonly refresh: () => void;
  readonly saveEndpoint: (endpoint: string) => void;
  readonly setSport: (value: string | null) => void;
  readonly setMaxHr: (value: number) => void;
  readonly setInvert: (on: boolean) => void;
  /** Where the tab choice lives (the SDK key-value store). */
  readonly getTab: () => string | null;
  readonly setTab: (tab: string) => void;
}

export interface PhoneUi { readonly refreshLive: () => void }

export const TABS: readonly { id: string; icon: string; key: "tabNow" | "tabLog" | "tabSettings" }[] = [
  { id: "now", icon: "🚴", key: "tabNow" },
  { id: "log", icon: "📈", key: "tabLog" },
  { id: "settings", icon: "⚙️", key: "tabSettings" },
];
export const DEFAULT_ENDPOINT = "http://127.0.0.1:8792/live";
const esc = (text: string): string => escapeHtml(text);

// ---- pure view models (tests read these) ----------------------------------------------

/** Nothing set up yet: no bridge address saved, the sample workout runs. Einstellungen opens first. */
export function isFirstRun(state: PhoneState): boolean {
  return state.endpoint === "" && state.mode.kind === "demo";
}

export interface Banner { readonly tone: "ok" | "warn" | "none"; readonly text: string }

export function bannerFor(state: PhoneState, locale: Locale): Banner {
  const q = qis[locale];
  if (state.mode.kind === "demo") return { tone: "none", text: q.bannerDemo };
  if (state.mode.kind === "stale") return { tone: "warn", text: state.lastError ? fill(q.bannerError, { error: state.lastError }) : fill(q.bannerStale, { age: state.mode.age }) };
  return { tone: "ok", text: fill(q.bannerLive, { source: state.data.source }) };
}

export function pillOf(state: PhoneState, locale: Locale): { text: string; on: boolean } {
  return state.mode.kind === "live" ? { text: `● ${modeWord(state.mode, locale)}`, on: true } : { text: modeWord(state.mode, locale), on: false };
}

const stat = (label: string, value: string, unit: string, alert = false): string =>
  `<div${alert ? ' class="alert"' : ""}><span>${esc(label)}</span><b>${esc(value)}</b><small>${esc(unit)}</small></div>`;
const num = (value: number): string => (value > 0 ? String(Math.round(value)) : "–");

/** The main value of the phone hero: "31.4" with "km/h" beside it, or "5:42" with "/km". */
export function heroValue(sport: Sport, data: Telemetry): { value: string; unit: string } {
  if (sport === "run") { const p = paceOf(data); return { value: p > 0 ? pace(p) : "–", unit: "/km" }; }
  const s = speedOf(data);
  return { value: s > 0 ? s.toFixed(1) : "–", unit: "km/h" };
}

/** "Jetzt": banner, hero card (the main value), 2 x 2 key figures, the one button. */
export function nowInner(state: PhoneState, locale: Locale): string {
  const q = qis[locale];
  const w = words[locale];
  const banner = bannerFor(state, locale);
  const hero = heroValue(state.sport, state.data);
  const zone = hrZone(state.data.heartRate, state.maxHr);
  return `
    <p class="banner tone-${banner.tone === "none" ? "offline" : banner.tone}">${esc(banner.text)}</p>
    <section class="card hero-card">
      <div class="hero">
        <div><span>${esc((state.sport === "run" ? w.pace : w.speed).toUpperCase())}</span><strong>${esc(hero.value)}</strong></div>
        <p>${esc(hero.unit)} · ${esc(fill(q.heroSide, { sport: sportWord(state.sport, locale) }))}</p>
      </div>
      <div class="stats">
        ${stat(w.heart, num(state.data.heartRate), zone > 0 ? `bpm · Z${zone}` : "bpm", zone >= 5)}
        ${stat(w.power, num(state.data.powerWatts), "W")}
        ${stat(w.cadence, num(state.data.cadence), "rpm")}
        ${stat(w.distance, state.data.distanceKm > 0 ? state.data.distanceKm.toFixed(1) : "–", "km")}
      </div>
      <button id="refresh" type="button" class="big">${esc(q.refreshNow)}</button>
    </section>`;
}

/** "Verlauf": distance as the hero, figures of the workout so far, one card per minute. */
export function logInner(state: PhoneState, locale: Locale): string {
  const q = qis[locale];
  const w = words[locale];
  const { session, data, sport } = state;
  const cards = [...session.history].reverse().slice(0, 12).map((snap) => {
    const main = sport === "run" ? (snap.paceSecPerKm > 0 ? pace(snap.paceSecPerKm) : snap.speedKph > 0 ? pace(3600 / snap.speedKph) : "–") : snap.speedKph > 0 ? snap.speedKph.toFixed(1) : snap.paceSecPerKm > 0 ? (3600 / snap.paceSecPerKm).toFixed(1) : "–";
    return `<div class="host tone-ok"><b>${esc(elapsed(snap.elapsedSeconds))}</b><em>${esc(main)} ${sport === "run" ? "/km" : "km/h"}</em><span><i>${num(snap.heartRate)}</i> bpm · <i>${num(snap.powerWatts)}</i> W</span></div>`;
  });
  return `
    <section class="card hero-card">
      <div class="hero">
        <div><span>${esc(w.distance.toUpperCase())}</span><strong>${esc(data.distanceKm > 0 ? data.distanceKm.toFixed(1) : "–")}</strong></div>
        <p>km</p>
      </div>
      <div class="stats">
        ${stat(q.logTime, elapsed(data.elapsedSeconds), "")}
        ${stat(q.logAvgHr, num(averageHr(session)), "bpm")}
        ${stat(q.logMaxHr, num(session.hrMax), "bpm")}
        ${stat(q.logAvgPower, num(averagePower(session)), "W")}
      </div>
    </section>
    <h2 class="strip-title">${esc(q.stripTitle)}</h2>
    ${cards.length > 0 ? `<div class="strip">${cards.join("")}</div>` : `<p class="hint">${esc(q.stripNone)}</p>`}`;
}

/** First-run checklist: pure, so tests can read it. */
export function setupInner(state: PhoneState, locale: Locale): string {
  const q = qis[locale];
  const step = (n: number, done: boolean, text: string): string =>
    `<li class="${done ? "done" : ""}"><span class="num" aria-hidden="true">${done ? "✓" : n}</span><span>${esc(text)}</span></li>`;
  const bridge = state.endpoint !== "";
  return `<ol class="steps">${step(1, bridge, q.setup1)}${step(2, bridge && state.choice !== null, q.setup2)}${step(3, state.mode.kind === "live", q.setup3)}</ol>`;
}

// ---- mounting ---------------------------------------------------------------------------

export function mountPhoneUi(ports: PhoneUiPorts): PhoneUi {
  const root = document.querySelector<HTMLElement>("#app");
  if (!root) return { refreshLive: () => undefined };
  let tab = ((): string => { const saved = ports.getTab(); return TABS.some((item) => item.id === saved) ? saved! : isFirstRun(ports.state()) ? "settings" : "now"; })();

  const applyTab = (): void => {
    root.querySelectorAll<HTMLElement>("[data-tab]").forEach((el) => { el.hidden = el.dataset["tab"] !== tab; });
    root.querySelectorAll<HTMLButtonElement>("[data-tab-go]").forEach((button) => {
      const on = button.dataset["tabGo"] === tab;
      button.classList.toggle("on", on);
      button.setAttribute("aria-selected", String(on));
    });
  };

  const render = (): void => {
    const locale = ports.locale();
    if (document.documentElement) document.documentElement.lang = locale;
    root.innerHTML = template(ports.state(), locale);
    applyTab();
    root.querySelectorAll<HTMLButtonElement>("[data-tab-go]").forEach((button) => {
      button.addEventListener("click", () => {
        tab = button.dataset["tabGo"] ?? "now";
        ports.setTab(tab);
        applyTab();
        window.scrollTo({ top: 0 });
      });
    });
    wire(root, ports, render);
  };

  render();
  return {
    refreshLive: () => {
      const locale = ports.locale();
      const state = ports.state();
      const set = (selector: string, html: string): void => {
        const el = root.querySelector<HTMLElement>(selector);
        // Unchanged parts are not touched, so a poll never makes the page jump.
        if (el && el.innerHTML !== html) el.innerHTML = html;
      };
      const pill = root.querySelector<HTMLElement>("#pill");
      if (pill) {
        const p = pillOf(state, locale);
        if (pill.textContent !== p.text) pill.textContent = p.text;
        pill.classList?.toggle("on", p.on);
      }
      set("#now-live", nowInner(state, locale));
      set("#log-live", logInner(state, locale));
    },
  };
}

function template(state: PhoneState, locale: Locale): string {
  const q = qis[locale];
  const w = words[locale];
  const pill = pillOf(state, locale);
  const first = isFirstRun(state);
  const options = [["", w.auto], ["bike", w.bike], ["run", w.run]]
    .map(([value, name]) => `<option value="${value}"${(state.choice ?? "") === value ? " selected" : ""}>${esc(name ?? "")}</option>`).join("");
  return `
  <header class="brand bar">
    <div>
      <div class="brand-mark">${esc(q.kicker)}</div>
      <h1>Endurance HUD</h1>
    </div>
    <span id="pill" class="chip${pill.on ? " on" : ""}">${esc(pill.text)}</span>
  </header>

  <div class="tab" data-tab="now" id="now"><div id="now-live">${nowInner(state, locale)}</div></div>

  <div class="tab" data-tab="log"><div id="log-live">${logInner(state, locale)}</div></div>

  <div class="tab" data-tab="settings">
    ${first ? `<section class="card setup"><h2>${esc(q.setupTitle)}</h2>${setupInner(state, locale)}</section>` : ""}
    <details class="fold card"${first ? " open" : ""}>
      <summary>${esc(q.connectionTitle)}</summary>
      <label for="endpoint">${esc(w.endpoint)}</label>
      <input id="endpoint" type="text" value="${esc(state.endpoint || DEFAULT_ENDPOINT)}" />
      <button id="save" type="button" class="big">${esc(w.save)}</button>
      <p class="hint">${esc(w.help)}</p>
    </details>

    <section class="card">
      <h2>${esc(q.sportTitle)}</h2>
      <label for="sport">${esc(w.sport)}</label>
      <select id="sport">${options}</select>
      <label for="maxhr">${fill(q.maxHr, { value: `<output id="maxhr-out">${state.maxHr}</output>` })}</label>
      <input id="maxhr" type="range" min="120" max="220" step="1" value="${state.maxHr}" />
      <p class="hint">${esc(q.maxHrHint)}</p>
    </section>

    <section class="card">
      <h2>${esc(q.glassesTitle)}</h2>
      <label class="check"><input id="invert" type="checkbox"${state.invert ? " checked" : ""} /> ${esc(q.invert)}</label>
      <p class="hint">${esc(q.invertHint)}</p>
      <details class="fold">
        <summary>${esc(q.controlsTitle)}</summary>
        <table class="keys">
          <tr><td>${esc(q.tap)}</td><td>${esc(q.tapHelp)}</td></tr>
          <tr><td>${esc(q.swipe)}</td><td>${esc(q.swipeHelp)}</td></tr>
          <tr><td>${esc(q.hold)}</td><td>${esc(q.holdHelp)}</td></tr>
          <tr><td>${esc(q.double)}</td><td>${esc(q.doubleHelp)}</td></tr>
        </table>
      </details>
    </section>

    <section class="card compact">${languageSelect(locale)}</section>

    <details class="fold card">
      <summary>${esc(q.moreTitle)}</summary>
      <p><strong>Endurance HUD</strong> · ${esc(q.moreVersion)} ${esc(VERSION)}</p>
      <p class="hint">${esc(q.morePrivacy)}</p>
      <p class="hint">${esc(w.lede)}</p>
    </details>
  </div>

  <nav class="tabbar" role="tablist">
    ${TABS.map(({ id, icon, key }) => `<button type="button" role="tab" id="tab-${id}" data-tab-go="${id}"><span aria-hidden="true">${icon}</span>${esc(q[key])}</button>`).join("")}
  </nav>`;
}

function wire(root: HTMLElement, ports: PhoneUiPorts, rerender: () => void): void {
  const byId = <T extends HTMLElement>(id: string): T | null => root.querySelector<T>("#" + id);
  byId<HTMLSelectElement>("language")?.addEventListener("change", (event) => {
    ports.setLocale((event.target as HTMLSelectElement).value as Locale);
    rerender();
  });
  byId<HTMLSelectElement>("sport")?.addEventListener("change", (event) => ports.setSport((event.target as HTMLSelectElement).value || null));
  byId<HTMLInputElement>("invert")?.addEventListener("change", (event) => ports.setInvert((event.target as HTMLInputElement).checked));
  const range = byId<HTMLInputElement>("maxhr");
  const out = byId("maxhr-out");
  range?.addEventListener("input", () => { if (out) out.textContent = range.value; });
  range?.addEventListener("change", () => ports.setMaxHr(Number(range.value)));
  byId<HTMLButtonElement>("save")?.addEventListener("click", () => {
    const input = byId<HTMLInputElement>("endpoint");
    ports.saveEndpoint(input?.value.trim() ?? "");
    rerender();
  });
  // One listener for the whole "Jetzt" tab: its content is redrawn after every poll.
  byId("now")?.addEventListener("click", (event) => {
    const target = (event as Event).target as HTMLElement | null;
    if (target?.closest?.("#refresh")) ports.refresh();
  });
}
