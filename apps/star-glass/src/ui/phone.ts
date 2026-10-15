import { isLoopback, isPlainHttp, validateBridgeUrl } from "../nina/client";
import type { StarStatus } from "../nina/status";
import { getLocale, languageSelect, setLocale, type Locale } from "../i18n";
import { t } from "../messages";
import { BUILD_URL, maskToken, type Settings, type WeatherSettings } from "../storage/persist";
import { parseCoordinate } from "../weather/forecast";
import { clampThresholds, clockText, localOffset } from "../weather/warnings";
import type { WeatherLocation } from "../glasses/views";
import { escapeHtml } from "./html";

/**
 * The phone companion: where the bridge lives, an optional token, and what
 * the imaging night is doing right now.
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
}

export interface PhoneUiPorts {
  readonly getSettings: () => Settings;
  readonly saveSettings: (next: Settings) => Promise<void>;
  readonly connection: () => PhoneConnection;
  readonly status: () => StarStatus | null;
  readonly locale?: () => Locale;
  readonly onLocaleChange?: (locale: Locale) => void;
  readonly weather?: () => PhoneWeather;
}

export interface PhoneUi {
  readonly refresh: () => void;
}

/** The page is split into tabs instead of one long column. */
const TABS: readonly { id: string; icon: string; key: string }[] = [
  { id: "night", icon: "🔭", key: "p.tabNight" },
  { id: "weather", icon: "☁️", key: "p.tabWeather" },
  { id: "glasses", icon: "👓", key: "p.tabGlasses" },
  { id: "link", icon: "🔗", key: "p.tabLink" },
  { id: "more", icon: "⚙️", key: "p.tabMore" },
];
const TAB_KEY = "quietglass.starglass.tab";

function readTab(): string {
  try { const v = localStorage.getItem(TAB_KEY); return TABS.some((tab) => tab.id === v) ? v! : "night"; } catch { return "night"; }
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

export function mountPhoneUi(ports: PhoneUiPorts): PhoneUi {
  const root = document.getElementById("app");
  if (!root) return { refresh: () => undefined };

  let notice = "";
  let locale: Locale = ports.locale?.() ?? getLocale();
  let tab = readTab();

  const render = (): void => {
    const typed = DRAFT_FIELDS.map((id) => root.querySelector<HTMLInputElement>("#" + id)?.value);
    root.innerHTML = template(ports.getSettings(), ports.connection(), ports.status(), locale, notice, ports.weather?.() ?? null);
    notice = "";
    applyTab(root, tab);
    root.querySelectorAll<HTMLButtonElement>("[data-tab-go]").forEach((button) => {
      button.addEventListener("click", () => {
        tab = button.dataset["tabGo"] ?? "night";
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
  return { refresh: render };
}

function template(settings: Settings, connection: PhoneConnection, status: StarStatus | null, locale: Locale, notice: string, weather: PhoneWeather | null): string {
  const L = (key: string, vars: Record<string, string | number> = {}): string => escapeHtml(t(locale, key, vars));
  const url = settings.bridgeUrl;
  const shown = url || BUILD_URL;
  const line = (() => {
    if (connection.kind === "none") return L("p.status.none");
    if (connection.kind === "error") return L("p.status.error", { reason: connection.reason });
    if (!status) return connection.kind === "demo" ? L("p.status.demo") : L("p.status.loading");
    if (!status.online) return L("p.status.offline");
    const frame = status.sequence.frame !== null ? t(locale, "g.frame", { frame: status.sequence.frame, frames: status.sequence.frames ?? "?" }) : "–";
    return L("p.status.online", { state: t(locale, "g.state." + status.sequence.state), target: status.sequence.target ?? "–", frame });
  })();
  const control = status ? `<p class="hint">${L(status.controllable ? "p.control.on" : "p.control.off")}</p>` : "";
  const warnHttp = url && isPlainHttp(url) && !isLoopback(url);

  const chipKey = connection.kind === "none" ? "p.chip.none"
    : connection.kind === "error" ? "p.chip.error"
    : connection.kind === "demo" ? "p.chip.demo"
    : connection.kind === "loading" || !status ? "p.chip.loading"
    : status.online ? "p.chip.online" : "p.chip.offline";

  return `
  <header class="brand bar">
    <div>
      <span class="brand-mark">Quietglass</span>
      <h1>Star Glass</h1>
    </div>
    <span class="chip${chipKey === "p.chip.online" ? " on" : ""}">${L(chipKey)}</span>
  </header>

  ${notice ? `<p class="notice">${escapeHtml(notice)}</p>` : ""}

  <div class="tab" data-tab="night">
  <section class="card">
    <h2>${L("p.status")}</h2>
    <p id="status">${line}</p>
    ${connection.kind === "demo" ? `<p class="hint">${L("p.status.demo")}</p>` : ""}
    ${control}
  </section>

  </div>

  <div class="tab" data-tab="weather">
  ${weatherCard(settings.weather, weather, locale)}
  </div>

  <div class="tab" data-tab="glasses">
  <section class="card">
    <h2>${L("p.controls")}</h2>
    <table class="keys">
      <tr><td>${L("p.c.swipe")}</td><td>${L("p.c.swipe.d")}</td></tr>
      <tr><td>${L("p.c.tap")}</td><td>${L("p.c.tap.d")}</td></tr>
      <tr><td>${L("p.c.hold")}</td><td>${L("p.c.hold.d")}</td></tr>
      <tr><td>${L("p.c.double")}</td><td>${L("p.c.double.d")}</td></tr>
    </table>
    <label class="check"><input id="invert" type="checkbox" ${settings.invertScroll ? "checked" : ""} /> ${L("p.invert")}</label>
  </section>
  </div>

  <div class="tab" data-tab="link">
  <section class="card">
    <h2>${L("p.bridge")}</h2>
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
    ${languageSelect(locale)}
  </section>

  <section class="card">
    <p class="hint">${L("p.lede")}</p>
    <p class="hint">${L("p.privacy")}</p>
  </section>
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
    <p class="hint">${L("p.wx.lede")}</p>
    ${source}
    <label class="check"><input id="wx-enabled" type="checkbox" ${settings.enabled ? "checked" : ""} /> ${L("p.wx.enabled")}</label>
    ${field("wx-cloud", "p.wx.cloud", num(th.cloud), "60", "numeric")}
    ${field("wx-rain", "p.wx.rain", num(th.rainProb), "40", "numeric")}
    ${field("wx-dew", "p.wx.dew", num(th.dewSpread), num(2))}
    ${field("wx-wind", "p.wx.wind", num(th.wind), "30", "numeric")}
    ${field("wx-lat", "p.wx.lat", settings.latitude !== undefined ? num(settings.latitude) : "", num(47.8))}
    ${field("wx-lon", "p.wx.lon", settings.longitude !== undefined ? num(settings.longitude) : "", num(13.04))}
    <p class="hint">${L("p.wx.locHint")}</p>
    <button id="wx-save" type="button">${L("p.wx.save")}</button>
    <p class="hint"><small>${L("p.wx.privacy")}</small></p>
  </section>`;
}
