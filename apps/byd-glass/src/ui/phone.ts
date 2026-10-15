import { isPlainHttp, validateUrl } from "../car/client";
import type { CarState } from "../car/model";
import { getLocale, languageSelect, setLocale, type Locale } from "../i18n";
import { t } from "../messages";
import { ageText, bar, deg, dec, duration, km, kw, pct, volt } from "../format";
import { actionLabel, lockWord, warningList } from "../glasses/views";
import { BUILD_URL, type Settings } from "../storage/persist";
import { escapeHtml } from "./html";

/**
 * The phone companion: the bridge address (or demo), the car's state in one
 * line, the warnings, and how the gestures work.
 */

export type PhoneConnection =
  | { readonly kind: "demo" }
  | { readonly kind: "loading" }
  | { readonly kind: "ok" }
  | { readonly kind: "error"; readonly reason: string };

export interface PhoneUiPorts {
  readonly getSettings: () => Settings;
  readonly saveSettings: (next: Settings) => Promise<void>;
  readonly connection: () => PhoneConnection;
  readonly car: () => CarState | null;
  readonly locale?: () => Locale;
  readonly onLocaleChange?: (locale: Locale) => void;
  readonly build?: string;
}

export interface PhoneUi {
  readonly refresh: () => void;
}

/** The page is split into tabs instead of one long column (Alfred, 13.10.2026). */
const TABS: readonly { id: string; icon: string; key: string }[] = [
  { id: "car", icon: "🚗", key: "p.tabCar" },
  { id: "charge", icon: "⚡", key: "p.tabCharge" },
  { id: "control", icon: "🎛️", key: "p.tabControl" },
  { id: "glasses", icon: "👓", key: "p.tabGlasses" },
  { id: "connection", icon: "📡", key: "p.tabConn" },
  { id: "more", icon: "⚙️", key: "p.tabMore" },
];
const TAB_KEY = "quietglass.bydglass.tab";

function readTab(): string {
  try { const v = localStorage.getItem(TAB_KEY); return TABS.some((tab) => tab.id === v) ? v! : "car"; } catch { return "car"; }
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
    const typed = root.querySelector<HTMLInputElement>("#url")?.value;
    root.innerHTML = template(ports.getSettings(), ports.connection(), ports.car(), locale, notice, ports.build ?? "");
    notice = "";
    const field = root.querySelector<HTMLInputElement>("#url");
    if (field && typed !== undefined && typed !== "") field.value = typed;
    applyTab(root, tab);
    root.querySelectorAll<HTMLButtonElement>("[data-tab-go]").forEach((button) => {
      button.addEventListener("click", () => {
        tab = button.dataset["tabGo"] ?? "car";
        try { localStorage.setItem(TAB_KEY, tab); } catch { /* private mode */ }
        applyTab(root, tab);
        globalThis.scrollTo?.({ top: 0 });
      });
    });
    wire();
  };

  const notify = (message: string): void => { notice = message; render(); };

  const commit = (next: Settings, clearDraft = false): void => {
    if (clearDraft) { const f = root.querySelector<HTMLInputElement>("#url"); if (f) f.value = ""; }
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
      const current = ports.getSettings();
      const check = url === "" && (BUILD_URL || current.url) ? { valid: true, errors: [] } : validateUrl(url);
      if (!check.valid) { notify(check.errors.map((key) => t(locale, key)).join(" ")); return; }
      commit({ ...current, url: (url || current.url).replace(/\/+$/, "") }, true);
    });

    byId<HTMLButtonElement>("clear")?.addEventListener("click", () => {
      commit({ ...ports.getSettings(), url: "" }, true);
    });

    byId<HTMLInputElement>("invert")?.addEventListener("change", (event) => {
      commit({ ...ports.getSettings(), invertScroll: (event.target as HTMLInputElement).checked });
    });
  };

  render();
  return { refresh: render };
}

function template(settings: Settings, connection: PhoneConnection, car: CarState | null, locale: Locale, notice: string, build: string): string {
  const L = (key: string, vars: Record<string, string | number> = {}): string => escapeHtml(t(locale, key, vars));
  const url = settings.url;
  const shown = url || BUILD_URL;
  const line = (() => {
    if (connection.kind === "error") return L("p.status.error", { reason: connection.reason });
    if (!car) return connection.kind === "demo" ? L("p.status.none") : L("p.status.loading");
    return L("p.status.car", {
      mode: t(locale, "p.mode." + car.mode),
      soc: pct(car.battery.soc),
      range: km(car.battery.rangeKm),
      age: car.stale ? ageText(locale, car.ageS) : t(locale, "g.live"),
    });
  })();
  const warnings = warningList(locale, car);
  const chip = connection.kind === "error" ? t(locale, "p.chipOffline")
    : !car ? t(locale, connection.kind === "demo" ? "p.chipDemo" : "p.chipLoading")
    : `${t(locale, "p.mode." + car.mode)} · ${pct(car.battery.soc)}`;
  const chipOn = connection.kind !== "error" && car !== null && !car.stale;
  const row = (label: string, value: string): string => `<tr><td>${escapeHtml(label)}</td><td>${escapeHtml(value)}</td></tr>`;
  const T = (key: string): string => t(locale, key);

  const carCard = car ? `
  <section class="card">
    <h2>${L("p.car")}</h2>
    <table class="keys">
      ${row(T("p.k.lock"), lockWord(locale, car) + (car.body.doorOpen ? " · " + T("p.k.doorOpen") : ""))}
      ${row(T("p.k.tyres"), (["fl", "fr", "rl", "rr"] as const).map((w) => t(locale, "g.wheel." + w) + " " + bar(car.tyres[w].kpa, locale) + (car.tyres[w].leak || car.tyres[w].low ? " !" : "")).join(" · "))}
      ${row(T("p.k.v12"), volt(car.battery.volt12, locale))}
      ${car.battery.odometerKm !== null ? row(T("p.k.odometer"), km(car.battery.odometerKm)) : ""}
      ${car.position ? `<tr><td>${escapeHtml(T("p.k.position"))}</td><td><a href="https://www.google.com/maps/search/?api=1&amp;query=${car.position.lat},${car.position.lon}" target="_blank" rel="noopener">${escapeHtml(T("p.mapLink"))}</a>${car.position.ageMin !== null ? " · " + escapeHtml(t(locale, "p.posAge", { min: car.position.ageMin })) : ""}</td></tr>` : ""}
      ${row(T("p.k.battery"), `SoH ${pct(car.battery.soh)} · ${deg(car.battery.cellTMin, locale)} – ${deg(car.battery.cellTMax, locale)}`)}
      ${row(T("p.k.outside"), deg(car.body.extTemp, locale))}
      ${row(T("p.k.cons"), `${dec(car.drive.cons50, 1, locale)} kWh/100 km`)}
    </table>
  </section>` : "";

  const c = car?.charge;
  const chargeCard = `
  <section class="card">
    <h2>${L("p.tabCharge")}</h2>
    ${!car || !c ? `<p class="hint">${L("p.noData")}</p>` : `
    <p class="big">${escapeHtml(pct(car.battery.soc))} · ${escapeHtml(km(car.battery.rangeKm))}</p>
    ${car.battery.src === "cloud" ? `<p class="hint">${escapeHtml(t(locale, "p.cloudSrc", { min: car.battery.cloudAgeMin ?? "?" }))}</p>` : ""}
    <table class="keys">
      ${row(T("p.k.charging"), c.active ? `${kw(c.kw, locale)} · ${T(c.dc ? "g.charge.dc" : "g.charge.ac")}` : c.done ? T("p.k.done") : T("p.k.notCharging"))}
      ${c.active ? row(T("p.k.eta"), duration(c.etaMin)) : ""}
      ${c.active ? row(T("p.k.added"), `${dec(c.kwh, 1, locale)} kWh`) : ""}
    </table>`}
    <p class="hint">${L("p.chargeHint")}</p>
  </section>`;

  const ctl = car?.control;
  const command = car?.command;
  const controlCard = `
  <section class="card">
    <h2>${L("p.tabControl")}</h2>
    <p class="hint">${L("p.controlHint")}</p>
    ${car?.carOn ? `<p class="notice warn">${L("p.carOnNow")}</p>` : ""}
    ${ctl ? `<table class="keys">
      ${row(T("p.k.climate"), ctl.enabled ? (ctl.climateTemp ? T("p.k.climateFree") : T("p.k.climateMapped")) : T("g.reason.readOnly"))}
      ${row(T("g.ctl.lock"), ctl.enabled && ctl.lock ? T("p.k.ready") : T("g.reason.notSetUp"))}
      ${row(T("g.ctl.unlock"), ctl.enabled && ctl.unlock ? T("p.k.unlockReady") : T("p.k.unlockOff"))}
    </table>` : ""}
    ${command ? `<p class="hint">${L("p.lastCommand", { label: actionLabel(locale, command.action, command.value), status: t(locale, "p.cmd." + command.status) })}</p>` : ""}
  </section>

  <section class="card">
    <h2>${L("p.rules")}</h2>
    <ul class="rules">
      <li>${L("p.rule.off")}</li>
      <li>${L("p.rule.unlock")}</li>
      <li>${L("p.rule.double")}</li>
      <li>${L("p.rule.temp")}</li>
    </ul>
  </section>`;

  return `
  <header class="brand bar">
    <div>
      <span class="brand-mark">Quietglass</span>
      <h1>BYD Glass</h1>
    </div>
    <span class="chip${chipOn ? " on" : ""}">${escapeHtml(chip)}</span>
  </header>

  ${notice ? `<p class="notice">${escapeHtml(notice)}</p>` : ""}
  ${warnings ? `<p class="notice warn">${L("p.status.warnings", { list: warnings })}</p>` : ""}

  <div class="tab" data-tab="car">
  <section class="card">
    <h2>${L("p.status")}</h2>
    <p id="status" class="big">${line}</p>
    ${connection.kind === "demo" ? `<p class="hint">${L("p.status.demo")}</p>` : ""}
  </section>
  ${carCard}
  <section class="card warn-card">
    <p>${L("p.notice")}</p>
  </section>
  </div>

  <div class="tab" data-tab="charge">
  ${chargeCard}
  </div>

  <div class="tab" data-tab="control">
  ${controlCard}
  </div>

  <div class="tab" data-tab="glasses">
  <section class="card">
    <h2>${L("p.glasses")}</h2>
    <label class="check"><input id="invert" type="checkbox" ${settings.invertScroll ? "checked" : ""} /> ${L("p.invert")}</label>
  </section>


    <section class="card">
    <h2>${L("p.controls")}</h2>
    <table class="keys">
      <tr><td>${L("p.c.tap")}</td><td>${L("p.c.tap.d")}</td></tr>
      <tr><td>${L("p.c.swipe")}</td><td>${L("p.c.swipe.d")}</td></tr>
      <tr><td>${L("p.c.hold")}</td><td>${L("p.c.hold.d")}</td></tr>
      <tr><td>${L("p.c.double")}</td><td>${L("p.c.double.d")}</td></tr>
    </table>
  </section>
  </div>

  <div class="tab" data-tab="connection">
  <section class="card">
    <h2>${L("p.server")}</h2>
    ${shown ? "" : `<p class="hint">${L("p.firstRun")}</p>`}
    <label for="url">${L("p.url")}</label>
    <input id="url" type="text" inputmode="url" autocomplete="off" value="${escapeHtml(url)}" placeholder="${BUILD_URL ? escapeHtml(BUILD_URL) : L("p.urlPlaceholder")}" />
    ${BUILD_URL ? `<p class="hint">${L("p.urlBuild")}</p>` : ""}
    ${url && isPlainHttp(url) ? `<p class="hint"><small class="warn">${L("p.httpWarn")}</small></p>` : ""}
    <button id="save" type="button">${L("p.save")}</button>
    ${url ? `<button id="clear" type="button" class="secondary">${L("p.clear")}</button>` : ""}
  </section>

  </div>

  <div class="tab" data-tab="more">
  <section class="card">
    <h2>${L("p.langTitle")}</h2>
    ${languageSelect(locale)}
  </section>

  <footer class="card hint">${L("p.privacy")}${build ? " · " + escapeHtml(build) : ""}</footer>
  </div>


  <nav class="tabbar" role="tablist">
    ${TABS.map(({ id, icon, key }) => `<button type="button" role="tab" data-tab-go="${id}"><span aria-hidden="true">${icon}</span>${L(key)}</button>`).join("")}
  </nav>`;
}
