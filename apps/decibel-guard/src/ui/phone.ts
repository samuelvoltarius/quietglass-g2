import { ESTIMATED_OFFSET, isCalibrated, setDose, type NoiseData } from "../storage/persist";
import { languageSelect, type Locale } from "../i18n";
import { t } from "../messages";
import { averageDb, createDose, doseLevel, formatDuration, permittedSeconds, type DoseSettings, type DoseState } from "../noise/dose";
import { dosePercent } from "../glasses/quant";
import { minutesShort, percent } from "../cockpit/model";

/**
 * The phone companion (QUS v1, the look of Rain Lens): exactly three tabs -
 * Jetzt (the level at a glance), Heute (today's dose and the allowed times)
 * and Einstellungen (rules, calibration, glasses, language).
 *
 * Calibration is the important setting. Without it the app can only report an
 * estimate, and the page says so plainly rather than presenting a number that
 * looks authoritative.
 */

/** What the glasses measure right now (the page follows it twice a second). */
export interface PhoneLive {
  readonly listening: boolean;
  readonly micError: boolean;
  /** Raw level in dBFS, or null. */
  readonly dbfs: number | null;
  /** Approximate SPL, or null before audio arrives. */
  readonly level: number | null;
  readonly dose: DoseState;
}

export interface PhoneUiPorts {
  readonly getData: () => NoiseData;
  readonly setData: (data: NoiseData) => Promise<void>;
  /** Live reading, for the hero card and the calibration helper. */
  readonly getLive?: () => PhoneLive;
  /** Starts or stops measuring (the one primary button of "Jetzt"). */
  readonly toggle?: () => void;
  /** Current language; English when the host does not say. */
  readonly getLocale?: () => Locale;
  /** Called when the user picks another language on this page. */
  readonly setLocale?: (locale: Locale) => void;
}

export interface PhoneUi {
  /** Redraws the live parts (pill, "Jetzt", "Heute", raw readout) without touching any input. */
  readonly refreshLive: () => void;
}

export const TABS: readonly { id: string; icon: string; key: string }[] = [
  { id: "now", icon: "🎯", key: "p.tabNow" },
  { id: "today", icon: "📊", key: "p.tabToday" },
  { id: "settings", icon: "⚙️", key: "p.tabSettings" },
];
const TAB_KEY = "quietglass.decibel-guard.tab";
const IDLE: PhoneLive = { listening: false, micError: false, dbfs: null, level: null, dose: createDose() };

/** Nothing measured and nothing calibrated yet: Einstellungen opens first, with the three-step checklist. */
export function isFirstRun(data: NoiseData, dose: DoseState): boolean {
  return !isCalibrated(data) && dose.measuredSeconds === 0;
}

function readTab(firstRun: boolean): string {
  try { const v = localStorage.getItem(TAB_KEY); if (TABS.some((tab) => tab.id === v)) return v!; } catch { /* no storage */ }
  return firstRun ? "settings" : "now";
}

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

export interface Banner { readonly tone: "ok" | "warn" | "critical" | "none"; readonly text: string }

/** The one message that counts right now. */
export function bannerFor(live: PhoneLive, locale: Locale): Banner {
  const band = doseLevel(live.dose);
  if (band === "exceeded") return { tone: "critical", text: t(locale, "p.bannerFull") };
  if (band === "high") return { tone: "warn", text: t(locale, "p.bannerHigh") };
  if (live.listening) return { tone: "ok", text: t(locale, "p.bannerListening") };
  if (live.micError) return { tone: "warn", text: t(locale, "p.bannerMicError") };
  return { tone: "none", text: t(locale, "p.bannerReady") };
}

export function pillOf(live: PhoneLive, locale: Locale): { text: string; on: boolean } {
  if (live.listening) return { text: t(locale, "p.pillOn"), on: true };
  return { text: t(locale, live.micError ? "p.pillMicError" : "p.pillReady"), on: false };
}

const dash = "–";
const stat = (label: string, value: string, unit: string, alert = false): string =>
  `<div${alert ? ' class="alert"' : ""}><span>${esc(label)}</span><b>${esc(value)}</b><small>${esc(unit)}</small></div>`;

function levelValue(live: PhoneLive, calibrated: boolean): string {
  if (!live.listening || live.level === null) return dash;
  return `${calibrated ? "" : "~"}${Math.max(0, Math.round(live.level))}`;
}

/** "Jetzt": banner, hero card (the level), 2 x 2 key figures, the one button. */
export function nowInner(data: NoiseData, live: PhoneLive, locale: Locale): string {
  const x = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  const banner = bannerFor(live, locale);
  const dose = live.dose;
  const avg = averageDb(dose);
  return `
    <p class="banner tone-${banner.tone === "critical" ? "critical" : banner.tone === "warn" ? "warn" : banner.tone === "ok" ? "ok" : "offline"}">${esc(banner.text)}</p>
    <section class="card hero-card">
      <div class="hero">
        <div><span>${esc(x("p.heroLabel"))}</span><strong>${esc(levelValue(live, isCalibrated(data)))}</strong></div>
        <p>${esc(x("p.heroSide", { pct: percent(dose.fraction) }))}</p>
      </div>
      <div class="stats">
        ${stat(x("p.statDose"), percent(dose.fraction), x("p.unitOfLimit"), doseLevel(dose) !== "quiet" && doseLevel(dose) !== "accumulating")}
        ${stat(x("p.statMax"), dose.peakDb === null ? dash : String(Math.round(dose.peakDb)), x("p.unitDb"))}
        ${stat(x("p.statAvg"), avg === null ? dash : String(Math.round(avg)), x("p.unitDb"))}
        ${stat(x("p.statTime"), minutesShort(dose.measuredSeconds), x("p.unitMeasured"))}
      </div>
      <button id="toggle" type="button" class="big">${esc(x(live.listening ? "p.stopMeasure" : "p.measure"))}</button>
    </section>`;
}

export interface AllowedTime { readonly db: number; readonly seconds: number }

/** The permitted time per day at a few levels around the criterion (a table for the strip of cards). */
export function allowedTimes(settings: DoseSettings): AllowedTime[] {
  const base = Math.round(settings.criterionDb);
  return [-5, 0, 3, 6, 9, 15].map((delta) => ({ db: base + delta, seconds: permittedSeconds(base + delta, settings) }));
}

/** "Heute": the dose as the hero, the figures, the allowed times as cards. */
export function todayInner(data: NoiseData, live: PhoneLive, locale: Locale): string {
  const x = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  const dose = live.dose;
  const pct = dosePercent(dose.fraction);
  const cards = allowedTimes(data.dose).map((row) => {
    const tone = row.db >= data.dose.criterionDb ? (row.db >= data.dose.criterionDb + 6 ? "critical" : "warn") : "ok";
    const time = row.seconds > 24 * 3600 ? x("p.stripOpen") : formatDuration(row.seconds, locale);
    return `<div class="host tone-${tone}"><b>${row.db} dB</b><em>${esc(time)}</em></div>`;
  });
  return `
    <section class="card hero-card">
      <div class="hero">
        <div><span>${esc(x("p.todayHero"))}</span><strong>${esc(percent(dose.fraction))}</strong></div>
        <p>${esc(x("p.todaySide", { db: data.dose.criterionDb, h: data.dose.criterionHours }))}</p>
      </div>
      <div class="stats">
        ${stat(x("p.statMax"), dose.peakDb === null ? dash : String(Math.round(dose.peakDb)), x("p.unitDb"))}
        ${stat(x("p.statAvg"), averageDb(dose) === null ? dash : String(Math.round(averageDb(dose)!)), x("p.unitDb"))}
        ${stat(x("p.statTime"), minutesShort(dose.measuredSeconds), x("p.unitMeasured"))}
        ${stat(x("p.statOver"), minutesShort(dose.overSeconds), x("p.unitOver"), dose.overSeconds > 0)}
      </div>
      <p class="hint">${esc(pct >= 100 ? x("p.bannerFull") : pct >= 50 ? x("p.bannerHigh") : x("p.rulesPlain"))}</p>
    </section>
    <h2 class="strip-title">${esc(x("p.stripTitle"))}</h2>
    <div class="strip">${cards.join("")}</div>
    <p class="hint">${esc(x("p.stripHint"))}</p>
    <p class="hint">${x("p.notMeter")}</p>`;
}

/** First-run checklist: pure, so tests can read it. */
export function setupInner(data: NoiseData, dose: DoseState, locale: Locale): string {
  const x = (key: string): string => t(locale, key);
  const measured = dose.measuredSeconds > 0;
  const step = (n: number, done: boolean, key: string): string =>
    `<li class="${done ? "done" : ""}"><span class="num" aria-hidden="true">${done ? "✓" : n}</span><span>${esc(x(key))}</span></li>`;
  return `<ol class="steps">${step(1, measured, "p.setup1")}${step(2, measured, "p.setup2")}${step(3, isCalibrated(data), "p.setup3")}</ol>`;
}

// ---- mounting ---------------------------------------------------------------------------

export function mountPhoneUi(ports: PhoneUiPorts): PhoneUi {
  const root = document.getElementById("app");
  if (!root) return { refreshLive: () => undefined };
  const locale = (): Locale => ports.getLocale?.() ?? "en";
  const live = (): PhoneLive => ports.getLive?.() ?? IDLE;
  let tab = readTab(isFirstRun(ports.getData(), live().dose));

  const render = (): void => {
    const data = ports.getData();
    if (document.documentElement) document.documentElement.lang = locale();
    // A redraw must not snap shut a "Details" section the user is working in.
    const open = [...root.querySelectorAll<HTMLDetailsElement>("details")].map((item) => item.open);
    root.innerHTML = template(data, locale(), live());
    root.querySelectorAll<HTMLDetailsElement>("details").forEach((item, index) => { if (open[index]) item.open = true; });
    applyTab(root, tab);
    root.querySelectorAll<HTMLButtonElement>("[data-tab-go]").forEach((button) => {
      button.addEventListener("click", () => {
        tab = button.dataset["tabGo"] ?? "now";
        try { localStorage.setItem(TAB_KEY, tab); } catch { /* private mode */ }
        applyTab(root, tab);
        window.scrollTo({ top: 0 });
      });
    });
    wire(root, ports, render);
  };

  render();
  const refreshLive = (): void => {
    const state = live();
    const data = ports.getData();
    const set = (selector: string, html: string): void => {
      const el = root.querySelector<HTMLElement>(selector);
      // Unchanged parts are not touched, so the page never jumps.
      if (el && el.innerHTML !== html) el.innerHTML = html;
    };
    const pill = root.querySelector<HTMLElement>("#pill");
    if (pill) {
      const p = pillOf(state, locale());
      if (pill.textContent !== p.text) pill.textContent = p.text;
      pill.classList?.toggle("on", p.on);
    }
    set("#now-live", nowInner(data, state, locale()));
    set("#today-live", todayInner(data, state, locale()));
    const readout = root.querySelector("#live");
    if (readout) {
      readout.textContent = state.listening && state.dbfs !== null ? state.dbfs.toFixed(1) + " dBFS" : t(locale(), "p.liveOff");
    }
  };
  // The level and the raw readout are live while the page is open.
  setInterval(refreshLive, 500);
  return { refreshLive };
}

function template(data: NoiseData, locale: Locale, state: PhoneLive): string {
  const d = data.dose;
  const x = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  const firstRun = isFirstRun(data, state.dose);
  const pill = pillOf(state, locale);
  return `
  <header class="brand bar">
    <div>
      <div class="brand-mark">${esc(x("p.kicker"))}</div>
      <h1>DecibelGuard</h1>
    </div>
    <span id="pill" class="chip${pill.on ? " on" : ""}">${esc(pill.text)}</span>
  </header>

  <div class="tab" data-tab="now" id="now"><div id="now-live">${nowInner(data, state, locale)}</div></div>

  <div class="tab" data-tab="today"><div id="today-live">${todayInner(data, state, locale)}</div></div>

  <div class="tab" data-tab="settings">
    ${firstRun ? `<section class="card setup"><h2>${esc(x("p.setupTitle"))}</h2>${setupInner(data, state.dose, locale)}</section>` : ""}
    <section class="card">
      <h2>${x("p.rulesTitle")}</h2>
      <p class="hint">${x("p.rulesPlain")}</p>
      <details class="fold">
        <summary>${x("p.details")}</summary>

        <label for="criterion">${x("p.criterion", { value: `<output id="criterion-out">${d.criterionDb}</output>` })}</label>
        <input id="criterion" type="range" min="70" max="100" step="1" value="${d.criterionDb}" />
        <p class="hint">${x("p.criterionHint")}</p>

        <label for="hours">${x("p.hours", { value: `<output id="hours-out">${d.criterionHours}</output>` })}</label>
        <input id="hours" type="range" min="1" max="16" step="1" value="${d.criterionHours}" />

        <label for="exchange">${x("p.exchange")}</label>
        <select id="exchange">
          <option value="3" ${d.exchangeRateDb === 3 ? "selected" : ""}>${x("p.exchange3")}</option>
          <option value="5" ${d.exchangeRateDb === 5 ? "selected" : ""}>${x("p.exchange5")}</option>
        </select>

        <label for="threshold">${x("p.threshold", { value: `<output id="threshold-out">${d.thresholdDb}</output>` })}</label>
        <input id="threshold" type="range" min="40" max="90" step="1" value="${d.thresholdDb}" />
      </details>
    </section>

    <section class="card">
      <h2>${x("p.calTitle")}</h2>
      <p class="hint">${isCalibrated(data) ? x("p.calibratedNote") : x("p.estimateNote")}</p>
      <details class="fold">
        <summary>${x("p.calSummary")}</summary>
        <ol class="hint">
          <li>${x("p.calStep1")}</li>
          <li>${x("p.calStep2")}</li>
          <li>${x("p.calStep3")}</li>
          <li>${x("p.calStep4")}</li>
        </ol>
        <p class="hint">${x("p.live", { value: x("p.liveOff") })}</p>
        <p class="hint">${x("p.liveHint")}</p>

        <label for="offset">${x("p.offset", { value: `<output id="offset-out">${data.calibrationOffset}</output>` })}</label>
        <input id="offset" type="range" min="0" max="160" step="1" value="${data.calibrationOffset}" />
        <p class="hint">${x("p.offsetHint", { estimate: ESTIMATED_OFFSET })}</p>
      </details>
    </section>

    <section class="card">
      <h2>${x("p.glassesTitle")}</h2>
      <label class="check"><input id="invert" type="checkbox" ${data.invertScroll ? "checked" : ""} /> ${x("p.invert")}</label>
      <p class="hint">${x("p.invertHint")}</p>
      <details class="fold">
        <summary>${x("p.controlsTitle")}</summary>
        <table class="keys">
          <tr><td>${x("p.tap")}</td><td>${x("p.tapDo")}</td></tr>
          <tr><td>${x("p.swipe")}</td><td>${x("p.swipeDo")}</td></tr>
          <tr><td>${x("p.hold")}</td><td>${x("p.holdDo")}</td></tr>
          <tr><td>${x("p.double")}</td><td>${x("p.doubleDo")}</td></tr>
        </table>
        <p class="hint">${x("p.micNote")}</p>
      </details>
    </section>

    <section class="card compact">${languageSelect(locale)}</section>

    <details class="fold card">
      <summary>${x("p.moreTitle")}</summary>
      <p class="hint">${x("p.about")}</p>
      <p class="hint">${x("p.notMeter")}</p>
      <p class="hint">${x("p.privacy")}</p>
    </details>
  </div>

  <nav class="tabbar" role="tablist">
    ${TABS.map(({ id, icon, key }) => `<button type="button" role="tab" data-tab-go="${id}"><span aria-hidden="true">${icon}</span>${esc(x(key))}</button>`).join("")}
  </nav>`;
}

function wire(root: HTMLElement, ports: PhoneUiPorts, rerender: () => void): void {
  const byId = <T extends HTMLElement>(id: string): T | null => root.querySelector<T>("#" + id);
  // Always build on the current data, never on a copy taken when the page was
  // drawn: a second change made before the first one's save and redraw finish
  // would otherwise write the old values back and silently undo the first.
  const commit = (change: (data: NoiseData) => NoiseData): void => {
    void ports.setData(change(ports.getData())).then(rerender);
  };
  const patchDose = (change: Partial<DoseSettings>): void => commit((data) => setDose(data, change));

  byId<HTMLSelectElement>("language")?.addEventListener("change", (event) => {
    const value = (event.target as HTMLSelectElement).value;
    ports.setLocale?.(value === "de" ? "de" : "en");
    rerender();
  });

  byId<HTMLInputElement>("invert")?.addEventListener("change", (event) => {
    const checked = (event.target as HTMLInputElement).checked;
    commit((data) => ({ ...data, invertScroll: checked }));
  });

  bindRange(byId("offset"), byId("offset-out"), (v) => commit((data) => ({ ...data, calibrationOffset: v })));
  bindRange(byId("criterion"), byId("criterion-out"), (v) => patchDose({ criterionDb: v }));
  bindRange(byId("hours"), byId("hours-out"), (v) => patchDose({ criterionHours: v }));
  bindRange(byId("threshold"), byId("threshold-out"), (v) => patchDose({ thresholdDb: v }));

  byId<HTMLSelectElement>("exchange")?.addEventListener("change", (event) => {
    const value = Number((event.target as HTMLSelectElement).value);
    patchDose({ exchangeRateDb: value === 5 ? 5 : 3 });
  });

  // One listener for the whole "Jetzt" tab: its content is redrawn twice a second.
  byId("now")?.addEventListener("click", (event) => {
    const target = (event as Event).target as HTMLElement | null;
    if (target?.closest?.("#toggle")) ports.toggle?.();
  });
}

function bindRange(
  input: HTMLElement | null,
  output: HTMLElement | null,
  commit: (value: number) => void,
): void {
  const range = input as HTMLInputElement | null;
  if (!range) return;
  range.addEventListener("input", () => {
    if (output) output.textContent = range.value;
  });
  range.addEventListener("change", () => commit(Number(range.value)));
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}
