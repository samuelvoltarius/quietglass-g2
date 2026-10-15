import { ESTIMATED_OFFSET, isCalibrated, setDose, type NoiseData } from "../storage/persist";
import { languageSelect, type Locale } from "../i18n";
import { t } from "../messages";
import type { DoseSettings } from "../noise/dose";

/**
 * The phone companion: dose rules and calibration.
 *
 * Calibration is the important part. Without it the app can only report a
 * relative level, and the UI says so plainly rather than presenting a number
 * that looks authoritative.
 */

export interface PhoneUiPorts {
  readonly getData: () => NoiseData;
  readonly setData: (data: NoiseData) => Promise<void>;
  /** Live reading, for the calibration helper and the next-step sentence. */
  readonly getLevel: () => { dbfs: number | null; listening: boolean; micError?: boolean };
  /** Current language; English when the host does not say. */
  readonly getLocale?: () => Locale;
  /** Called when the user picks another language on this page. */
  readonly setLocale?: (locale: Locale) => void;
}

/** The page is split into tabs instead of one long column (Alfred, 13.10.2026). */
const TABS: readonly { id: string; icon: string; key: string }[] = [
  { id: "main", icon: "🎯", key: "p.tabMain" },
  { id: "set", icon: "🎚️", key: "p.tabSet" },
  { id: "glasses", icon: "👓", key: "p.tabGlasses" },
  { id: "more", icon: "⚙️", key: "p.tabMore" },
];
const TAB_KEY = "quietglass.decibel-guard.tab";

function readTab(): string {
  try { const v = localStorage.getItem(TAB_KEY); return TABS.some((tab) => tab.id === v) ? v! : "main"; } catch { return "main"; }
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

/** Applies the active tab after a redraw and wires the tab bar. */
function bindTabs(root: HTMLElement, current: string, change: (next: string) => void): void {
  applyTab(root, current);
  root.querySelectorAll<HTMLButtonElement>("[data-tab-go]").forEach((button) => {
    button.addEventListener("click", () => {
      const next = button.dataset["tabGo"] ?? "main";
      change(next);
      try { localStorage.setItem(TAB_KEY, next); } catch { /* private mode */ }
      applyTab(root, next);
      window.scrollTo({ top: 0 });
    });
  });
}

export function mountPhoneUi(ports: PhoneUiPorts): void {
  const root = document.getElementById("app");
  if (!root) return;
  const locale = (): Locale => ports.getLocale?.() ?? "en";
  let tab = readTab();

  const render = (): void => {
    const data = ports.getData();
    if (document.documentElement) document.documentElement.lang = locale();
    // A redraw must not snap shut a "Details" section the user is working in.
    const open = [...root.querySelectorAll<HTMLDetailsElement>("details")].map((item) => item.open);
    root.innerHTML = template(data, locale(), ports.getLevel());
    root.querySelectorAll<HTMLDetailsElement>("details").forEach((item, index) => { if (open[index]) item.open = true; });
    bindTabs(root, tab, (next) => { tab = next; });
    wire(root, ports, render);
  };

  render();
  // The raw readout and the next step are live while the page is open.
  setInterval(() => {
    const level = ports.getLevel();
    const readout = root.querySelector("#live");
    if (readout) {
      readout.textContent = level.listening && level.dbfs !== null
        ? level.dbfs.toFixed(1) + " dBFS"
        : t(locale(), "p.liveOff");
    }
    const next = root.querySelector("#next");
    if (next) {
      next.textContent = nextStep(level, locale());
      next.className = level.micError ? "warn" : "";
    }
  }, 500);
}

function nextStep(level: { listening: boolean; micError?: boolean }, locale: Locale): string {
  if (level.listening) return t(locale, "p.nextListening");
  return t(locale, level.micError ? "p.nextMicError" : "p.nextIdle");
}

function template(data: NoiseData, locale: Locale, level: { listening: boolean; micError?: boolean }): string {
  const d = data.dose;
  const x = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  return `
  <header class="brand bar">
    <div>
      <span class="brand-mark">Quietglass</span>
      <h1>DecibelGuard</h1>
    </div>
    <span class="chip${isCalibrated(data) ? " on" : ""}">${isCalibrated(data) ? x("p.chipCal") : x("p.chipEst")}</span>
  </header>

  <div class="tab" data-tab="main">
  <section class="card next">
    <p id="next" class="${level.micError ? "warn" : ""}">${nextStep(level, locale)}</p>
  </section>

  <section class="card">
    <h2>${x("p.aboutTitle")}</h2>
    <p class="hint">${x("p.about")}</p>
    <p class="hint">${isCalibrated(data) ? x("p.calibratedNote") : x("p.estimateNote")}</p>
    <p class="hint">${x("p.notMeter")}</p>
  </section>
  </div>

  <div class="tab" data-tab="set">
  <section class="card">
    <h2>${x("p.rulesTitle")}</h2>
    <p class="hint">${x("p.rulesPlain")}</p>
    <details>
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
    <details>
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
  </div>

  <div class="tab" data-tab="glasses">
  <section class="card">
    <h2>${x("p.glassesTitle")}</h2>
    <label class="check"><input id="invert" type="checkbox" ${data.invertScroll ? "checked" : ""} /> ${x("p.invert")}</label>
    <p class="hint">${x("p.invertHint")}</p>
  </section>
  </div>

  <div class="tab" data-tab="more">
  <section class="card">
    <h2>${x("p.controlsTitle")}</h2>
    <table class="keys">
      <tr><td>${x("p.tap")}</td><td>${x("p.tapDo")}</td></tr>
      <tr><td>${x("p.swipe")}</td><td>${x("p.swipeDo")}</td></tr>
      <tr><td>${x("p.hold")}</td><td>${x("p.holdDo")}</td></tr>
      <tr><td>${x("p.double")}</td><td>${x("p.doubleDo")}</td></tr>
    </table>
    <p class="hint">${x("p.micNote")}</p>
  </section>

  <section class="card compact">${languageSelect(locale)}</section>

  <footer class="hint">${x("p.privacy")}</footer>
  </div>

  <nav class="tabbar" role="tablist">
    ${TABS.map(({ id, icon, key }) => `<button type="button" role="tab" data-tab-go="${id}"><span aria-hidden="true">${icon}</span>${x(key)}</button>`).join("")}
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
