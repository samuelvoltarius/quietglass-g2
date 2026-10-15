import { setSettings, type PostureData } from "../storage/persist";
import type { PostureSettings } from "../posture/monitor";
import { languageSelect, type Locale } from "../i18n";
import { t } from "../messages";
import { formatDuration } from "../glasses/view";
import { sensorPanelHtml, updateSensorPanel, wireSensorPanel, type SensorPorts } from "./sensor-panel";

/**
 * The phone companion: thresholds and calibration management. The glasses only
 * need one control (tap to calibrate), so everything adjustable lives here.
 */

export interface PhoneUiPorts {
  readonly getData: () => PostureData;
  readonly setData: (data: PostureData) => Promise<void>;
  /** Current language; English when the host does not say. */
  readonly getLocale?: () => Locale;
  /** Called when the user picks another language on this page. */
  readonly setLocale?: (locale: Locale) => void;
  /** True when the glasses refused motion data, so the page can say what to do. */
  readonly getSensorOff?: () => boolean;
  /** The raw-value sensor test in the "More" tab; absent = no panel. */
  readonly sensor?: SensorPorts;
}

/** Live numbers on the phone: at most five updates a second, like the glasses. */
const SENSOR_REFRESH_MS = 200;

export interface PhoneUi {
  /** Redraws the page, e.g. after the glasses switched the sensor test or a recording ended. */
  readonly refresh: () => void;
}

/** The page is split into tabs instead of one long column (Alfred, 13.10.2026). */
const TABS: readonly { id: string; icon: string; key: string }[] = [
  { id: "main", icon: "🧍", key: "p.tabMain" },
  { id: "warn", icon: "🔔", key: "p.tabWarn" },
  { id: "glasses", icon: "👓", key: "p.tabGlasses" },
  { id: "more", icon: "⚙️", key: "p.tabMore" },
];
const TAB_KEY = "quietglass.posture-lens.tab";

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

export function mountPhoneUi(ports: PhoneUiPorts): PhoneUi {
  const root = document.getElementById("app");
  if (!root) return { refresh: () => undefined };

  let tab = readTab();
  let live: ReturnType<typeof setInterval> | undefined;
  const render = (): void => {
    const locale = ports.getLocale?.() ?? "en";
    if (document.documentElement) document.documentElement.lang = locale;
    root.innerHTML = template(ports.getData(), locale, ports.getSensorOff?.() ?? false, ports.sensor);
    bindTabs(root, tab, (next) => { tab = next; });
    wire(root, ports, render);
    const sensor = ports.sensor;
    if (sensor) {
      wireSensorPanel(root, locale, sensor, render);
      // The interval only runs while the test is on; it reads the live DOM each time.
      clearInterval(live);
      live = undefined;
      if (sensor.isOn()) {
        updateSensorPanel(root, locale, sensor);
        live = setInterval(() => updateSensorPanel(root, ports.getLocale?.() ?? "en", sensor), SENSOR_REFRESH_MS);
      }
    }
  };

  render();
  return { refresh: render };
}

function template(data: PostureData, locale: Locale, sensorOff: boolean, sensor?: SensorPorts): string {
  const s = data.settings;
  const x = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  const next = sensorOff
    ? x("p.nextSensorOff")
    : data.reference
      ? x("p.nextReady", { time: formatDuration(s.sustainSeconds, locale) })
      : x("p.nextFirst");
  return `
  <header class="brand bar">
    <div>
      <span class="brand-mark">Quietglass</span>
      <h1>PostureLens</h1>
    </div>
    <span class="chip${data.reference && !sensorOff ? " on" : ""}">${sensorOff ? x("p.chipSensorOff") : data.reference ? x("p.chipCal") : x("p.chipNoCal")}</span>
  </header>

  <div class="tab" data-tab="main">
  <section class="card next">
    <p class="${sensorOff ? "warn" : ""}">${next}</p>
  </section>

  <section class="card">
    <h2>${x("p.calTitle")}</h2>
    <p class="hint">${data.reference ? x("p.calYes") : x("p.calNo")}</p>
    ${data.reference ? `<button id="clear" type="button" class="secondary">${x("p.calClear")}</button>` : ""}
    <p class="hint">${x("p.calHint")}</p>
  </section>
  </div>

  <div class="tab" data-tab="warn">
  <section class="card">
    <h2>${x("p.warnTitle")}</h2>

    <label for="angle">${x("p.angle", { value: `<output id="angle-out">${s.warnAngle}</output>` })}</label>
    <input id="angle" type="range" min="5" max="60" step="1" value="${s.warnAngle}" />
    <p class="hint">${x("p.angleHint")}</p>

    <label for="sustain">${x("p.sustain", { value: `<output id="sustain-out">${s.sustainSeconds}</output>` })}</label>
    <input id="sustain" type="range" min="5" max="300" step="5" value="${s.sustainSeconds}" />
    <p class="hint">${x("p.sustainHint")}</p>

    <label for="snooze">${x("p.snooze", { value: `<output id="snooze-out">${Math.round(s.snoozeSeconds / 60)}</output>` })}</label>
    <input id="snooze" type="range" min="1" max="30" step="1" value="${Math.round(s.snoozeSeconds / 60)}" />

    <details>
      <summary>${x("p.details")}</summary>
      <label for="smooth">${x("p.smooth", { value: `<output id="smooth-out">${s.smoothing.toFixed(2)}</output>` })}</label>
      <input id="smooth" type="range" min="0.05" max="1" step="0.05" value="${s.smoothing}" />
      <p class="hint">${x("p.smoothHint")}</p>
    </details>
  </section>
  </div>

  <div class="tab" data-tab="glasses">
  <section class="card">
    <h2>${x("p.displayTitle")}</h2>
    <label class="check"><input id="angle-good" type="checkbox" ${data.showAngleWhenGood ? "checked" : ""} /> ${x("p.angleGood")}</label>
    <p class="hint">${x("p.angleGoodHint")}</p>
    <label class="check"><input id="invert" type="checkbox" ${data.invertScroll ? "checked" : ""} /> ${x("p.invert")}</label>
  </section>
  </div>

  <div class="tab" data-tab="more">
  <section class="card">
    <h2>${x("p.controlsTitle")}</h2>
    <table class="keys">
      <tr><td>${x("p.tap")}</td><td>${x("p.tapDo")}</td></tr>
      <tr><td>${x("p.swipe")}</td><td>${x("p.swipeDo")}</td></tr>
      <tr><td>${x("p.long")}</td><td>${x("p.longDo")}</td></tr>
      <tr><td>${x("p.double")}</td><td>${x("p.doubleDo")}</td></tr>
    </table>
  </section>

  ${sensor ? sensorPanelHtml(locale, sensor) : ""}

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
  // drawn: a tap on the glasses calibrates in the meantime, and a stale copy
  // would write `reference: null` back and silently throw the calibration away.
  // Re-render so the calibration status and its button stay true.
  const commit = (change: (data: PostureData) => PostureData): void => {
    void ports.setData(change(ports.getData())).then(rerender);
  };
  const patch = (change: Partial<PostureSettings>): void => commit((data) => setSettings(data, change));

  byId<HTMLSelectElement>("language")?.addEventListener("change", (event) => {
    const value = (event.target as HTMLSelectElement).value;
    ports.setLocale?.(value === "de" ? "de" : "en");
    rerender();
  });

  byId<HTMLButtonElement>("clear")?.addEventListener("click", () => {
    commit((data) => ({ ...data, reference: null }));
  });

  bindRange(byId("angle"), byId("angle-out"), (v) => patch({ warnAngle: v }));
  bindRange(byId("sustain"), byId("sustain-out"), (v) => patch({ sustainSeconds: v }));
  bindRange(byId("snooze"), byId("snooze-out"), (v) => patch({ snoozeSeconds: v * 60 }), (v) => String(v));
  bindRange(byId("smooth"), byId("smooth-out"), (v) => patch({ smoothing: v }), (v) => v.toFixed(2));

  byId<HTMLInputElement>("angle-good")?.addEventListener("change", (event) => {
    const checked = (event.target as HTMLInputElement).checked;
    commit((data) => ({ ...data, showAngleWhenGood: checked }));
  });
  byId<HTMLInputElement>("invert")?.addEventListener("change", (event) => {
    const checked = (event.target as HTMLInputElement).checked;
    commit((data) => ({ ...data, invertScroll: checked }));
  });
}

/** Live label while dragging; the value is stored on release. */
function bindRange(
  input: HTMLElement | null,
  output: HTMLElement | null,
  commit: (value: number) => void,
  format: (value: number) => string = String,
): void {
  const range = input as HTMLInputElement | null;
  if (!range) return;
  range.addEventListener("input", () => {
    if (output) output.textContent = format(Number(range.value));
  });
  range.addEventListener("change", () => commit(Number(range.value)));
}
