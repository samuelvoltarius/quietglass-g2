import { isLoopback, isPlainHttp, validateBridgeUrl } from "../nina/client";
import { alerts, type Alert } from "../nina/alerts";
import { decimal, type OnlineStatus, type StarStatus } from "../nina/status";
import { getLocale, languageSelect, setLocale, type Locale } from "../i18n";
import { t } from "../messages";
import { BUILD_URL, maskToken, type Settings, type WeatherSettings } from "../storage/persist";
import { parseCoordinate, type Forecast } from "../weather/forecast";
import { clampThresholds, clockText, cloudOf, localOffset, rainProbOf, valueAt, type Thresholds, type WeatherWarning } from "../weather/warnings";
import { alertText, warningText, type WeatherLocation } from "../glasses/views";
import { escapeHtml } from "./html";

/**
 * The phone companion (QUS v1, the look of Rain Lens): exactly three tabs -
 * Jetzt (the night at a glance), Verlauf (the readings and events of the
 * night) and Einstellungen (bridge, weather, glasses, language).
 *
 * The token is write-only in this UI: once saved, the field shows how long it
 * is, never the token.
 */

export type PhoneConnection =
  | { readonly kind: "none" }
  | { readonly kind: "demo" }
  | { readonly kind: "loading" }
  | { readonly kind: "ok" }
  | { readonly kind: "error"; readonly reason: string };

/** What the phone page says about the forecast. */
export interface PhoneWeather {
  readonly location: WeatherLocation;
  readonly fetchedAt: number | null;
  readonly error: string | null;
  readonly forecast?: Forecast | null;
  readonly warnings?: readonly WeatherWarning[];
}

export interface PhoneUiPorts {
  readonly getSettings: () => Settings;
  readonly saveSettings: (next: Settings) => Promise<void>;
  readonly connection: () => PhoneConnection;
  readonly status: () => StarStatus | null;
  readonly locale?: () => Locale;
  readonly onLocaleChange?: (locale: Locale) => void;
  readonly weather?: () => PhoneWeather;
  /** Asks the bridge (and the forecast) again. */
  readonly refresh?: () => void;
  /** The app version, shown under "Mehr". */
  readonly version?: string;
}

export interface PhoneUi {
  /** Redraws the whole page (settings, language), keeping what was typed. */
  readonly refresh: () => void;
  /** Redraws the live parts (pill, "Jetzt", "Verlauf") after an answer, leaving every input untouched. */
  readonly refreshLive: () => void;
}

/** The three tabs. */
export const TABS: readonly { id: string; icon: string; key: string }[] = [
  { id: "now", icon: "🔭", key: "p.tabNow" },
  { id: "log", icon: "📈", key: "p.tabLog" },
  { id: "settings", icon: "⚙️", key: "p.tabSettings" },
];
const TAB_KEY = "quietglass.starglass.tab.v2";

/** Nothing set up yet: Einstellungen opens first, with the three-step checklist. */
export function isFirstRun(settings: Settings): boolean {
  return !settings.bridgeUrl && !BUILD_URL;
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

const DRAFT_FIELDS = ["url", "token", "wx-cloud", "wx-rain", "wx-dew", "wx-wind", "wx-lat", "wx-lon"] as const;

// ---- pure view models (tests read these) ----------------------------------------------

export type BannerTone = "ok" | "warn" | "critical" | "offline" | "none";
export interface Banner { readonly tone: BannerTone; readonly text: string }

/** The status pill: the connection in one word. */
export function pillFor(connection: PhoneConnection, status: StarStatus | null, locale: Locale): { on: boolean; text: string } {
  const x = (key: string): string => t(locale, key);
  if (connection.kind === "none") return { on: false, text: x("p.pill.none") };
  if (connection.kind === "demo") return { on: false, text: x("p.pill.demo") };
  if (connection.kind === "error") return { on: false, text: x("p.pill.error") };
  if (connection.kind === "loading" || !status) return { on: false, text: x("p.pill.loading") };
  return status.online ? { on: true, text: x("p.pill.ok") } : { on: false, text: x("p.pill.offline") };
}

/** The one message that counts right now. */
export function bannerFor(connection: PhoneConnection, status: StarStatus | null, warnings: readonly WeatherWarning[], locale: Locale): Banner {
  const x = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  if (connection.kind === "none" || connection.kind === "demo") return { tone: "none", text: x("p.banner.none") };
  if (connection.kind === "error") return { tone: "offline", text: x("p.banner.error", { reason: connection.reason }) };
  if (connection.kind === "loading" || !status) return { tone: "none", text: x("p.banner.loading") };
  if (!status.online) return { tone: "offline", text: x("p.banner.offline") };
  const list = alerts(status);
  const urgent = list.find((alert: Alert) => alert.level !== "info");
  if (urgent) return { tone: urgent.level === "critical" ? "critical" : "warn", text: alertText(urgent, locale) };
  const warning = warnings[0];
  if (warning) return { tone: warning.level === "critical" ? "critical" : "warn", text: warningText(warning, locale) };
  if (list[0]) return { tone: "ok", text: x("p.banner.done") };
  return { tone: "ok", text: x("p.banner.ok") };
}

const esc = escapeHtml;

/** The newest HFR: the last frame's, else the last reading of the history. */
function hfrOf(s: OnlineStatus): number | null {
  return s.last?.hfr ? s.last.hfr : s.history.hfr[s.history.hfr.length - 1] ?? null;
}

export interface HeroValue { readonly label: string; readonly value: string; readonly side: string }

/** The big value: which frame the night is on. */
export function heroFor(status: StarStatus | null, locale: Locale): HeroValue {
  const x = (key: string): string => t(locale, key);
  if (!status?.online) return { label: x("p.hero.state"), value: "–", side: "" };
  const seq = status.sequence;
  const target = seq.target ?? status.last?.target ?? "";
  if (seq.frame !== null) return { label: x("p.hero.frame"), value: seq.frames !== null ? `${seq.frame}/${seq.frames}` : String(seq.frame), side: target };
  return { label: x("p.hero.state"), value: x("g.state." + seq.state), side: target };
}

export interface Stat { readonly label: string; readonly value: string; readonly unit: string; readonly alert: boolean }

/** The 2 x 2 key figures: HFR, guiding, camera, clouds. */
export function statsFor(status: StarStatus | null, weather: PhoneWeather | null, now: number, locale: Locale): Stat[] {
  const x = (key: string): string => t(locale, key);
  const s = status?.online ? status : null;
  const list = alerts(s);
  const dash = "–";
  const cloud = s?.weather?.cloudCover ?? valueAt(weather?.forecast?.hours ?? [], cloudOf, now);
  const hfr = s ? hfrOf(s) : null;
  return [
    { label: x("p.stat.hfr"), value: hfr === null ? dash : decimal(hfr, 2, locale), unit: x("p.stat.hfr.unit"), alert: false },
    { label: x("p.stat.rms"), value: s?.guider.connected && s.guider.rms !== null ? decimal(s.guider.rms, 2, locale) : dash, unit: x("p.stat.rms.unit"), alert: list.some((a) => a.kind === "guidingLost") },
    { label: x("p.stat.cam"), value: s?.camera.connected && s.camera.temp !== null ? decimal(s.camera.temp, 1, locale) : dash, unit: x("p.stat.cam.unit"), alert: list.some((a) => a.kind === "coolingOff" || a.kind === "coolingDrift") },
    { label: x("p.stat.clouds"), value: cloud === null ? dash : String(Math.round(cloud)), unit: x("p.stat.clouds.unit"), alert: (weather?.warnings ?? []).some((w) => w.kind === "clouds") },
  ];
}

/** The next hours of the forecast as cards (clouds, rain). */
export function hourCards(forecast: Forecast | null | undefined, thresholds: Thresholds, now: number, locale: Locale, count = 8): { time: string; clouds: string; rain: string; tone: "ok" | "warn" }[] {
  if (!forecast) return [];
  const offset = localOffset(now);
  const hours = forecast.hours.filter((hour) => hour.time >= now - 3_600_000).slice(0, count);
  return hours.map((hour) => {
    const rain = rainProbOf(hour);
    return {
      time: clockText(hour.time, offset),
      clouds: t(locale, "p.strip.clouds", { pct: hour.cloud === null ? "–" : Math.round(hour.cloud) }),
      rain: t(locale, "p.strip.rain", { pct: rain === null ? "–" : Math.round(rain) }),
      tone: hour.cloud !== null && hour.cloud >= thresholds.cloud ? "warn" : "ok",
    };
  });
}

/** "Jetzt": banner, hero card, 2 x 2 key figures, the one button, a card strip with the next hours. */
export function nowInner(connection: PhoneConnection, status: StarStatus | null, weather: PhoneWeather | null, thresholds: Thresholds, now: number, locale: Locale): string {
  const x = (key: string, vars: Record<string, string | number> = {}): string => esc(t(locale, key, vars));
  const banner = bannerFor(connection, status, weather?.warnings ?? [], locale);
  const hero = heroFor(status, locale);
  const stats = statsFor(status, weather, now, locale);
  const cards = hourCards(weather?.forecast, thresholds, now, locale);
  return `
    <p class="banner tone-${banner.tone}">${esc(banner.text)}</p>
    <section class="card hero-card">
      <div class="hero">
        <div><span>${esc(hero.label)}</span><strong>${esc(hero.value)}</strong></div>
        <p>${esc(hero.side)}</p>
      </div>
      <div class="stats">
        ${stats.map((stat) => `<div${stat.alert ? ' class="alert"' : ""}><span>${esc(stat.label)}</span><b>${esc(stat.value)}</b><small>${esc(stat.unit)}</small></div>`).join("")}
      </div>
      <button id="refresh" class="big" type="button">${x("p.refresh")}</button>
    </section>
    ${cards.length > 0 ? `
    <h3 class="strip-title">${x("p.strip.hours")}</h3>
    <div class="strip">
      ${cards.map((card) => `<div class="host tone-${card.tone}"><b>${esc(card.time)}</b><em>${esc(card.clouds)}</em><span>${esc(card.rain)}</span></div>`).join("")}
    </div>` : ""}`;
}

/** A series as a strip of cards, newest last: "2,31 / Bild 22". */
function seriesStrip(title: string, values: readonly number[], images: number, locale: Locale, digits = 2, count = 8): string {
  const last = values.slice(-count);
  const first = images - last.length + 1;
  return `
    <h3 class="strip-title">${esc(title)}</h3>
    <div class="strip">
      ${last.map((value, index) => `<div class="host"><b>${esc(decimal(value, digits, locale))}</b><span>${esc(t(locale, "p.hero.frame"))} <i>${first + index > 0 ? first + index : "–"}</i></span></div>`).join("")}
    </div>`;
}

function ageOf(seconds: number | null, locale: Locale): string {
  if (seconds === null) return "";
  const text = seconds < 90 ? `${Math.round(seconds)} s` : seconds < 5400 ? `${Math.round(seconds / 60)} min` : `${Math.round(seconds / 3600)} h`;
  return t(locale, "p.log.ago", { age: text });
}

/** "Verlauf": the readings of the night as card strips, then the events. */
export function logInner(status: StarStatus | null, locale: Locale): string {
  const x = (key: string): string => esc(t(locale, key));
  const s = status?.online ? status : null;
  if (!s || (s.history.hfr.length === 0 && s.history.rms.length === 0 && s.events.length === 0)) {
    return `<section class="card"><p class="hint">${x("p.log.empty")}</p></section>`;
  }
  const events = [...s.events].reverse();
  return `
    ${s.history.hfr.length > 0 ? seriesStrip(t(locale, "p.log.hfr"), s.history.hfr, s.images, locale) : ""}
    ${s.history.rms.length > 0 ? seriesStrip(t(locale, "p.log.rms"), s.history.rms, s.images, locale) : ""}
    <section class="card">
      <h2>${x("p.log.events")}</h2>
      ${events.length === 0 ? `<p class="hint">${x("p.log.noEvents")}</p>` : `<ul class="scripts">${events.map((event) => `<li><span>${esc(event.name)}</span><small>${esc(ageOf(event.ageSeconds, locale))}</small></li>`).join("")}</ul>`}
    </section>`;
}

/** The first-run checklist: three steps, ticked off as they come true. */
export function setupInner(settings: Settings, connection: PhoneConnection, status: StarStatus | null, locale: Locale): string {
  const steps: [string, boolean][] = [
    [t(locale, "p.setup.1"), connection.kind === "ok"],
    [t(locale, "p.setup.2"), !isFirstRun(settings)],
    [t(locale, "p.setup.3"), connection.kind === "ok" && status?.online === true],
  ];
  return `<ol class="steps">${steps.map(([text, done], index) => `<li${done ? ' class="done"' : ""}><span class="num">${done ? "✓" : index + 1}</span>${esc(text)}</li>`).join("")}</ol>`;
}

// ---- mounting --------------------------------------------------------------------------

export function mountPhoneUi(ports: PhoneUiPorts): PhoneUi {
  const root = document.getElementById("app");
  if (!root) return { refresh: () => undefined, refreshLive: () => undefined };

  let notice = "";
  let locale: Locale = ports.locale?.() ?? getLocale();
  let tab = readTab(isFirstRun(ports.getSettings()));

  const render = (): void => {
    const typed = DRAFT_FIELDS.map((id) => root.querySelector<HTMLInputElement>("#" + id)?.value);
    const opened = Array.from(root.querySelectorAll<HTMLDetailsElement>("details")).map((el) => el.open);
    root.innerHTML = template(ports.getSettings(), ports.connection(), ports.status(), locale, notice, ports.weather?.() ?? null, ports.version ?? "");
    notice = "";
    applyTab(root, tab);
    Array.from(root.querySelectorAll<HTMLDetailsElement>("details")).forEach((el, index) => { if (opened[index] !== undefined) el.open = opened[index]!; });
    root.querySelectorAll<HTMLButtonElement>("[data-tab-go]").forEach((button) => {
      button.addEventListener("click", () => {
        tab = button.dataset["tabGo"] ?? "now";
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

  /** Only the parts that follow the night; inputs and folded cards stay as they are. */
  const renderLive = (): void => {
    const connection = ports.connection(); const status = ports.status(); const weather = ports.weather?.() ?? null;
    const settings = ports.getSettings();
    const pill = root.querySelector<HTMLElement>("#pill");
    if (pill) {
      const state = pillFor(connection, status, locale);
      pill.textContent = state.text;
      pill.className = "chip" + (state.on ? " on" : "");
    }
    const now = root.querySelector<HTMLElement>("#now-live");
    if (now) now.innerHTML = nowInner(connection, status, weather, settings.weather.thresholds, Date.now(), locale);
    const log = root.querySelector<HTMLElement>("#log-live");
    if (log) log.innerHTML = logInner(status, locale);
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

    // One listener for the whole "Jetzt" tab: its content is redrawn after every answer.
    byId("now")?.addEventListener("click", (event) => {
      const target = (event as Event).target as HTMLElement | null;
      if (target?.closest?.("#refresh")) ports.refresh?.();
    });

    byId<HTMLButtonElement>("save")?.addEventListener("click", () => {
      const url = byId<HTMLInputElement>("url")?.value.trim() ?? "";
      // Empty is fine when the build carries its own address.
      const check = url === "" && BUILD_URL ? { valid: true, errors: [] } : validateBridgeUrl(url);
      if (!check.valid) { notify(check.errors.map((key) => t(locale, key)).join(" ")); return; }
      const tokenField = byId<HTMLInputElement>("token");
      const current = ports.getSettings();
      // The token field is write-only: left empty, the stored token is kept.
      const token = (tokenField?.value ?? "") || current.token;
      if (tokenField) tokenField.value = "";
      commit({ bridgeUrl: url.replace(/\/+$/, ""), invertScroll: current.invertScroll, weather: current.weather, ...(token ? { token } : {}) });
    });

    byId<HTMLButtonElement>("clear-token")?.addEventListener("click", () => {
      const current = ports.getSettings();
      commit({ bridgeUrl: current.bridgeUrl, invertScroll: current.invertScroll, weather: current.weather });
    });

    byId<HTMLButtonElement>("wx-save")?.addEventListener("click", () => {
      const value = (id: string): string => byId<HTMLInputElement>(id)?.value ?? "";
      const latText = value("wx-lat").trim();
      const lonText = value("wx-lon").trim();
      const latitude = parseCoordinate(latText, 90);
      const longitude = parseCoordinate(lonText, 180);
      const empty = latText === "" && lonText === "";
      if (!empty && (latitude === null || longitude === null || (latitude === 0 && longitude === 0))) { notify(t(locale, "p.wx.err.coords")); return; }
      const current = ports.getSettings();
      const weather: WeatherSettings = {
        enabled: byId<HTMLInputElement>("wx-enabled")?.checked ?? current.weather.enabled,
        thresholds: clampThresholds({
          cloud: value("wx-cloud") || current.weather.thresholds.cloud,
          rainProb: value("wx-rain") || current.weather.thresholds.rainProb,
          dewSpread: value("wx-dew") || current.weather.thresholds.dewSpread,
          wind: value("wx-wind") || current.weather.thresholds.wind,
        }),
        ...(!empty && latitude !== null && longitude !== null ? { latitude, longitude } : {}),
      };
      commit({ ...current, weather });
    });

    byId<HTMLInputElement>("invert")?.addEventListener("change", (event) => {
      commit({ ...ports.getSettings(), invertScroll: (event.target as HTMLInputElement).checked });
    });
  };

  render();
  return { refresh: render, refreshLive: renderLive };
}

function template(settings: Settings, connection: PhoneConnection, status: StarStatus | null, locale: Locale, notice: string, weather: PhoneWeather | null, version: string): string {
  const L = (key: string, vars: Record<string, string | number> = {}): string => escapeHtml(t(locale, key, vars));
  const url = settings.bridgeUrl;
  const warnHttp = url && isPlainHttp(url) && !isLoopback(url);
  const firstRun = isFirstRun(settings);
  const pill = pillFor(connection, status, locale);

  return `
  <header class="brand bar">
    <div>
      <span class="brand-mark">${L("p.kicker")}</span>
      <h1>Star Glass</h1>
    </div>
    <span id="pill" class="chip${pill.on ? " on" : ""}">${escapeHtml(pill.text)}</span>
  </header>

  ${notice ? `<p class="notice">${escapeHtml(notice)}</p>` : ""}

  <div class="tab" data-tab="now" id="now">
    <div id="now-live">${nowInner(connection, status, weather, settings.weather.thresholds, Date.now(), locale)}</div>
  </div>

  <div class="tab" data-tab="log">
    <div id="log-live">${logInner(status, locale)}</div>
  </div>

  <div class="tab" data-tab="settings">
    ${firstRun ? `<section class="card setup"><h2>${L("p.setup.title")}</h2>${setupInner(settings, connection, status, locale)}</section>` : ""}

    <details class="fold card"${firstRun ? " open" : ""}>
      <summary>${L("p.bridge")}</summary>
      <label for="url">${L("p.url")}</label>
      <input id="url" type="text" inputmode="url" autocomplete="off" value="${escapeHtml(url)}" placeholder="${BUILD_URL ? escapeHtml(BUILD_URL) : L("p.urlPlaceholder")}" />
      ${BUILD_URL ? `<p class="hint">${L("p.urlBuild")}</p>` : ""}
      ${warnHttp ? `<p class="hint"><small class="warn">${L("p.httpWarn")}</small></p>` : ""}
      <label for="token">${L("p.token")}</label>
      <input id="token" type="password" autocomplete="off" placeholder="${L("p.tokenPlaceholder")}" />
      <p class="hint">${L("p.tokenNow", { state: maskToken(settings.token, locale) })}</p>
      <button id="save" type="button">${L("p.save")}</button>
      ${settings.token ? `<button id="clear-token" type="button" class="remove">${L("p.tokenClear")}</button>` : ""}
      ${status ? `<p class="hint">${L(status.controllable ? "p.control.on" : "p.control.off")}</p>` : ""}
    </details>

    ${weatherCard(settings.weather, weather, locale)}

    <section class="card">
      <h2>${L("p.glasses")}</h2>
      <label class="check"><input id="invert" type="checkbox" ${settings.invertScroll ? "checked" : ""} /> ${L("p.invert")}</label>
      <details class="fold">
        <summary>${L("p.c.title")}</summary>
        <table class="keys">
          <tr><td>${L("p.c.swipe")}</td><td>${L("p.c.swipe.d")}</td></tr>
          <tr><td>${L("p.c.tap")}</td><td>${L("p.c.tap.d")}</td></tr>
          <tr><td>${L("p.c.double")}</td><td>${L("p.c.double.d")}</td></tr>
        </table>
      </details>
    </section>

    <section class="card compact">${languageSelect(locale)}</section>

    <details class="fold card">
      <summary>${L("p.more")}</summary>
      <p class="hint">${L("p.privacy")}</p>
      ${version ? `<p class="hint">${L("p.version", { version })}</p>` : ""}
    </details>
  </div>

  <nav class="tabbar" role="tablist">
    ${TABS.map(({ id, icon, key }) => `<button type="button" role="tab" data-tab-go="${id}"><span aria-hidden="true">${icon}</span>${L(key)}</button>`).join("")}
  </nav>`;
}

function weatherCard(settings: WeatherSettings, weather: PhoneWeather | null, locale: Locale): string {
  const L = (key: string, vars: Record<string, string | number> = {}): string => escapeHtml(t(locale, key, vars));
  const th = settings.thresholds;
  const num = (value: number): string => escapeHtml(locale === "de" ? String(value).replace(".", ",") : String(value));
  const field = (id: string, label: string, value: string, placeholder: string, mode = "decimal"): string =>
    `<label for="${id}">${L(label)}</label><input id="${id}" type="text" inputmode="${mode}" autocomplete="off" value="${value}" placeholder="${placeholder}" />`;
  const source = weather && settings.enabled ? `<p class="hint">${L("p.wx.source." + weather.location)}${weather.fetchedAt
    ? " · " + L("p.wx.forecastAt", { time: clockText(weather.fetchedAt, localOffset(weather.fetchedAt)) }) : ""}</p>` : "";
  return `
  <section class="card">
    <h2>${L("p.wx")}</h2>
    ${source}
    <label class="check"><input id="wx-enabled" type="checkbox" ${settings.enabled ? "checked" : ""} /> ${L("p.wx.enabled")}</label>
    <details class="fold">
      <summary>${L("p.wx.fold")}</summary>
      <p class="hint">${L("p.wx.lede")}</p>
      ${field("wx-cloud", "p.wx.cloud", num(th.cloud), "60", "numeric")}
      ${field("wx-rain", "p.wx.rain", num(th.rainProb), "40", "numeric")}
      ${field("wx-dew", "p.wx.dew", num(th.dewSpread), num(2))}
      ${field("wx-wind", "p.wx.wind", num(th.wind), "30", "numeric")}
      ${field("wx-lat", "p.wx.lat", settings.latitude !== undefined ? num(settings.latitude) : "", num(47.8))}
      ${field("wx-lon", "p.wx.lon", settings.longitude !== undefined ? num(settings.longitude) : "", num(13.04))}
      <p class="hint">${L("p.wx.locHint")}</p>
      <p class="hint"><small>${L("p.wx.privacy")}</small></p>
    </details>
    <button id="wx-save" type="button">${L("p.wx.save")}</button>
  </section>`;
}
