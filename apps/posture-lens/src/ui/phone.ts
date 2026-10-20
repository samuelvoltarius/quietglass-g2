import { setSettings, type PostureData } from "../storage/persist";
import { heldSeconds, uprightShare, type PostureMonitor, type PostureSettings } from "../posture/monitor";
import { bucketShare, type Bucket } from "../posture/buckets";
import { languageSelect, type Locale } from "../i18n";
import { t } from "../messages";
import { formatDuration, minutesShort } from "../cockpit/model";
import { sensorPanelHtml, updateSensorPanel, wireSensorPanel, type SensorPorts } from "./sensor-panel";

/**
 * The phone companion (QUS v1, the look of Rain Lens): exactly three tabs -
 * Jetzt (the lean at a glance, one button to save the posture), Heute (the
 * tally of this session in slices of ten minutes) and Einstellungen
 * (calibration, warning, display, glasses, language, the sensor test).
 * Nothing needs a server: it works as soon as it opens.
 */

/** What the glasses measure right now (the page follows it once a second). */
export interface PhoneLive {
  readonly monitor: PostureMonitor;
  readonly sensorOff: boolean;
  /** The tally in slices of ten minutes, oldest first. */
  readonly buckets: readonly Bucket[];
}

export interface PhoneUiPorts {
  readonly getData: () => PostureData;
  readonly setData: (data: PostureData) => Promise<void>;
  /** Current language; English when the host does not say. */
  readonly getLocale?: () => Locale;
  /** Called when the user picks another language on this page. */
  readonly setLocale?: (locale: Locale) => void;
  /** True when the glasses refused motion data, so the page can say what to do. */
  readonly getSensorOff?: () => boolean;
  /** The state of the monitor and the tally. */
  readonly getLive?: () => PhoneLive;
  /** Saves the current posture as upright (the one primary button of "Jetzt"). */
  readonly calibrate?: () => void;
  /** The raw-value sensor test in the "Einstellungen" tab; absent = no panel. */
  readonly sensor?: SensorPorts;
}

/** Live numbers on the phone: at most five updates a second, like the glasses. */
const SENSOR_REFRESH_MS = 200;
/** How long the second tap on a dangerous button is waited for. */
const CONFIRM_MS = 4000;

export interface PhoneUi {
  /** Redraws the page, e.g. after the glasses switched the sensor test or a recording ended. */
  readonly refresh: () => void;
  /** Redraws the live parts (pill, "Jetzt", "Heute") without touching any input. */
  readonly refreshLive: () => void;
}

export const TABS: readonly { id: string; icon: string; key: string }[] = [
  { id: "now", icon: "🧍", key: "p.tabNow" },
  { id: "today", icon: "📊", key: "p.tabToday" },
  { id: "settings", icon: "⚙️", key: "p.tabSettings" },
];
const TAB_KEY = "quietglass.posture-lens.tab";

/** Nothing saved yet: Einstellungen opens first, with the three-step checklist. */
export function isFirstRun(data: PostureData): boolean {
  return data.reference === null;
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
export function bannerFor(data: PostureData, live: PhoneLive, locale: Locale): Banner {
  const x = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  if (live.sensorOff) return { tone: "warn", text: x("p.bannerSensorOff") };
  if (!data.reference) return { tone: "none", text: x("p.bannerFirst") };
  if (live.monitor.state === "warned") return { tone: "critical", text: x("p.bannerWarned") };
  if (live.monitor.state === "leaning") return { tone: "warn", text: x("p.bannerLeaning") };
  return { tone: "ok", text: x("p.bannerReady", { time: formatDuration(data.settings.sustainSeconds, locale) }) };
}

export function pillOf(data: PostureData, live: PhoneLive, locale: Locale): { text: string; on: boolean } {
  if (live.sensorOff) return { text: t(locale, "p.chipSensorOff"), on: false };
  return data.reference ? { text: t(locale, "p.chipCal"), on: true } : { text: t(locale, "p.chipNoCal"), on: false };
}

const stat = (label: string, value: string, unit: string, alert = false): string =>
  `<div${alert ? ' class="alert"' : ""}><span>${esc(label)}</span><b>${esc(value)}</b><small>${esc(unit)}</small></div>`;

/** "Jetzt": banner, hero card (the lean), 2 x 2 key figures, the one button. */
export function nowInner(data: PostureData, live: PhoneLive, locale: Locale, now = Date.now()): string {
  const x = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  const banner = bannerFor(data, live, locale);
  const { monitor } = live;
  const share = uprightShare(monitor);
  const angle = data.reference && !live.sensorOff && monitor.angle !== null ? `${Math.round(monitor.angle)}°` : "–";
  const held = heldSeconds(monitor, now);
  const leaning = monitor.state === "leaning" || monitor.state === "warned";
  const toWarning = held === null || monitor.state === "warned" ? "–" : String(Math.max(0, Math.ceil((data.settings.sustainSeconds - held) / 5) * 5));
  return `
    <p class="banner tone-${banner.tone === "none" ? "offline" : banner.tone}">${esc(banner.text)}</p>
    <section class="card hero-card">
      <div class="hero">
        <div><span>${esc(x("p.heroLabel"))}</span><strong>${esc(angle)}</strong></div>
        <p>${esc(x("p.heroSide", { deg: Math.round(data.settings.warnAngle) }))}</p>
      </div>
      <div class="stats">
        ${stat(x("p.statShare"), share === null ? "–" : `${Math.round(share * 100)}%`, x("p.unitToday"))}
        ${stat(x("p.statLean"), minutesShort(monitor.leaningSeconds, locale), x("p.unitMinutes"), leaning)}
        ${stat(x("p.statLimit"), `${Math.round(data.settings.warnAngle)}°`, x("p.unitDeg"))}
        ${stat(x("p.statWarn"), toWarning, x("p.unitSeconds"))}
      </div>
      <button id="calibrate" type="button" class="big">${esc(x(data.reference ? "p.resave" : "p.save"))}</button>
    </section>`;
}

/** "Heute": the share upright as the hero, the figures, one card per ten minutes. */
export function todayInner(data: PostureData, live: PhoneLive, locale: Locale): string {
  const x = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  const { monitor } = live;
  const share = uprightShare(monitor);
  const lastWarn = monitor.lastWarnAt === null ? x("p.never") : new Date(monitor.lastWarnAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  const cards = [...live.buckets].reverse().map((bucket) => {
    const part = bucketShare(bucket);
    const tone = part === null ? "offline" : part >= 0.8 ? "ok" : part >= 0.5 ? "warn" : "critical";
    const time = new Date(bucket.start).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
    return `<div class="host tone-${tone}"><b>${esc(time)}</b><em>${part === null ? "–" : `${Math.round(part * 100)}%`}</em><span>${esc(x("p.stripShare"))}</span></div>`;
  });
  return `
    <section class="card hero-card">
      <div class="hero">
        <div><span>${esc(x("p.todayHero"))}</span><strong>${esc(share === null ? "–" : `${Math.round(share * 100)}%`)}</strong></div>
        <p>${esc(x("p.todaySide"))}</p>
      </div>
      <div class="stats">
        ${stat(x("p.statGood"), minutesShort(monitor.goodSeconds, locale), x("p.unitMinutes"))}
        ${stat(x("p.statLean"), minutesShort(monitor.leaningSeconds, locale), x("p.unitMinutes"), monitor.leaningSeconds > 0)}
        ${stat(x("p.statLastWarn"), lastWarn, "")}
        ${stat(x("p.statLimit"), `${Math.round(data.settings.warnAngle)}°`, x("p.unitDeg"))}
      </div>
    </section>
    <h2 class="strip-title">${esc(x("p.stripTitle"))}</h2>
    ${cards.length > 0 ? `<div class="strip">${cards.join("")}</div>` : `<p class="hint">${esc(x("p.stripNone"))}</p>`}`;
}

/** First-run checklist: pure, so tests can read it. */
export function setupInner(data: PostureData, sensorOff: boolean, locale: Locale): string {
  const x = (key: string): string => t(locale, key);
  const saved = data.reference !== null;
  const step = (n: number, done: boolean, key: string): string =>
    `<li class="${done ? "done" : ""}"><span class="num" aria-hidden="true">${done ? "✓" : n}</span><span>${esc(x(key))}</span></li>`;
  return `<ol class="steps">${step(1, !sensorOff, "p.setup1")}${step(2, saved, "p.setup2")}${step(3, saved, "p.setup3")}</ol>`;
}

// ---- mounting ---------------------------------------------------------------------------

const IDLE_MONITOR: PostureMonitor = {
  state: "uncalibrated", reference: null, current: null, angle: null, leaningSince: null, lastWarnAt: null, goodSeconds: 0, leaningSeconds: 0, lastSampleAt: null,
};

export function mountPhoneUi(ports: PhoneUiPorts): PhoneUi {
  const root = document.getElementById("app");
  if (!root) return { refresh: () => undefined, refreshLive: () => undefined };

  let tab = readTab(isFirstRun(ports.getData()));
  let live: ReturnType<typeof setInterval> | undefined;
  const state = (): PhoneLive => ports.getLive?.() ?? { monitor: IDLE_MONITOR, sensorOff: ports.getSensorOff?.() ?? false, buckets: [] };
  const render = (): void => {
    const locale = ports.getLocale?.() ?? "en";
    if (document.documentElement) document.documentElement.lang = locale;
    root.innerHTML = template(ports.getData(), locale, state(), ports.sensor);
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
  return {
    refresh: render,
    refreshLive: () => {
      const locale = ports.getLocale?.() ?? "en";
      const data = ports.getData();
      const current = state();
      const set = (selector: string, html: string): void => {
        const el = root.querySelector<HTMLElement>(selector);
        // Unchanged parts are not touched, so the page never jumps.
        if (el && el.innerHTML !== html) el.innerHTML = html;
      };
      const pill = root.querySelector<HTMLElement>("#pill");
      if (pill) {
        const p = pillOf(data, current, locale);
        if (pill.textContent !== p.text) pill.textContent = p.text;
        pill.classList?.toggle("on", p.on);
      }
      set("#now-live", nowInner(data, current, locale));
      set("#today-live", todayInner(data, current, locale));
    },
  };
}

function template(data: PostureData, locale: Locale, state: PhoneLive, sensor?: SensorPorts): string {
  const s = data.settings;
  const x = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  const firstRun = isFirstRun(data);
  const pill = pillOf(data, state, locale);
  return `
  <header class="brand bar">
    <div>
      <div class="brand-mark">${esc(x("p.kicker"))}</div>
      <h1>PostureLens</h1>
    </div>
    <span id="pill" class="chip${pill.on ? " on" : ""}">${esc(pill.text)}</span>
  </header>

  <div class="tab" data-tab="now" id="now"><div id="now-live">${nowInner(data, state, locale)}</div></div>

  <div class="tab" data-tab="today"><div id="today-live">${todayInner(data, state, locale)}</div></div>

  <div class="tab" data-tab="settings">
    ${firstRun ? `<section class="card setup"><h2>${esc(x("p.setupTitle"))}</h2>${setupInner(data, state.sensorOff, locale)}</section>` : ""}
    <section class="card">
      <h2>${x("p.calTitle")}</h2>
      <p class="hint">${data.reference ? x("p.calYes") : x("p.calNo")}</p>
      ${data.reference ? `<button id="clear" type="button" class="remove">${x("p.calClear")}</button>` : ""}
      <details class="fold"><summary>${x("p.details")}</summary><p class="hint">${x("p.calHint")}</p></details>
    </section>

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

      <details class="fold">
        <summary>${x("p.details")}</summary>
        <label for="smooth">${x("p.smooth", { value: `<output id="smooth-out">${s.smoothing.toFixed(2)}</output>` })}</label>
        <input id="smooth" type="range" min="0.05" max="1" step="0.05" value="${s.smoothing}" />
        <p class="hint">${x("p.smoothHint")}</p>
      </details>
    </section>

    <section class="card">
      <h2>${x("p.displayTitle")}</h2>
      <label class="check"><input id="angle-good" type="checkbox" ${data.showAngleWhenGood ? "checked" : ""} /> ${x("p.angleGood")}</label>
      <p class="hint">${x("p.angleGoodHint")}</p>
      <label class="check"><input id="invert" type="checkbox" ${data.invertScroll ? "checked" : ""} /> ${x("p.invert")}</label>
      <details class="fold">
        <summary>${x("p.controlsTitle")}</summary>
        <table class="keys">
          <tr><td>${x("p.tap")}</td><td>${x("p.tapDo")}</td></tr>
          <tr><td>${x("p.swipe")}</td><td>${x("p.swipeDo")}</td></tr>
          <tr><td>${x("p.long")}</td><td>${x("p.longDo")}</td></tr>
          <tr><td>${x("p.double")}</td><td>${x("p.doubleDo")}</td></tr>
        </table>
      </details>
    </section>

    <section class="card compact">${languageSelect(locale)}</section>

    <details class="fold card"${sensor?.isOn() ? " open" : ""}>
      <summary>${x("p.moreTitle")}</summary>
      ${sensor ? sensorPanelHtml(locale, sensor) : ""}
      <p class="hint">${x("p.privacy")}</p>
    </details>
  </div>

  <nav class="tabbar" role="tablist">
    ${TABS.map(({ id, icon, key }) => `<button type="button" role="tab" data-tab-go="${id}"><span aria-hidden="true">${icon}</span>${esc(x(key))}</button>`).join("")}
  </nav>`;
}

function wire(root: HTMLElement, ports: PhoneUiPorts, rerender: () => void): void {
  const byId = <T extends HTMLElement>(id: string): T | null => root.querySelector<T>("#" + id);
  const locale = ports.getLocale?.() ?? "en";
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

  // Dangerous buttons (overwrite or clear the saved posture): the first tap asks, a second one within a few seconds does it.
  const armed = (button: HTMLButtonElement, run: () => void): void => {
    let until = 0;
    const label = button.textContent;
    button.addEventListener("click", () => {
      if (Date.now() < until) { run(); return; }
      until = Date.now() + CONFIRM_MS;
      button.textContent = t(locale, "p.confirm");
      button.classList?.add("danger");
      setTimeout(() => { until = 0; button.textContent = label; button.classList?.remove("danger"); }, CONFIRM_MS);
    });
  };
  const clear = byId<HTMLButtonElement>("clear");
  if (clear) armed(clear, () => commit((data) => ({ ...data, reference: null })));

  // One listener for the whole "Jetzt" tab: its content is redrawn once a second. Saving over a saved posture asks first.
  const now = byId("now");
  let calibrateUntil = 0;
  now?.addEventListener("click", (event) => {
    const button = ((event as Event).target as HTMLElement | null)?.closest?.<HTMLButtonElement>("#calibrate");
    if (!button) return;
    if (ports.getData().reference !== null && Date.now() >= calibrateUntil) {
      calibrateUntil = Date.now() + CONFIRM_MS;
      button.textContent = t(locale, "p.confirm");
      button.classList?.add("danger");
      return;
    }
    calibrateUntil = 0;
    ports.calibrate?.();
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

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}
