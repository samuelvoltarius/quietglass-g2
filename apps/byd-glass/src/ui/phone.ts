import { isPlainHttp, validateUrl } from "../car/client";
import type { CarState } from "../car/model";
import { getLocale, languageSelect, setLocale, type Locale } from "../i18n";
import { t } from "../messages";
import { ageText, bar, deg, dec, duration, km, kw, pct, volt } from "../format";
import { activeWarnings, lockWord, warningList } from "../glasses/views";
import { BUILD_URL, type Settings } from "../storage/persist";
import { escapeHtml } from "./html";

/**
 * The phone companion (QUS v1, the look of Rain Lens): exactly three tabs -
 * Jetzt (the car at a glance), Auto (charging, details) and
 * Einstellungen (bridge, glasses, language). Without a bridge address the
 * demo runs and Einstellungen opens first with a three-step checklist.
 *
 * Control (0.7.0): the "Auto" tab has a small "Steuern" card that says what the
 * bridge allows and how the last command ended. Commands are given on the
 * glasses only (two taps); the phone sends nothing.
 * A value the car does not report is left out, never shown as 0; climate shows
 * on/off and the fan level, never a temperature (the setpoint is not a reading).
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

/** The three tabs, in one row. */
export const TABS: readonly { id: string; icon: string; key: string }[] = [
  { id: "now", icon: "🚗", key: "p.tabNow" },
  { id: "car", icon: "⚡", key: "p.tabCar" },
  { id: "settings", icon: "⚙️", key: "p.tabSettings" },
];
const TAB_KEY = "quietglass.bydglass.tab";

/** Nothing set up yet: no bridge address of the user and none built in. */
export function isFirstRun(settings: Settings): boolean {
  return !settings.url && !BUILD_URL;
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

export function mountPhoneUi(ports: PhoneUiPorts): PhoneUi {
  const root = document.getElementById("app");
  if (!root) return { refresh: () => undefined };

  let notice = "";
  let locale: Locale = ports.locale?.() ?? getLocale();
  let tab = readTab(isFirstRun(ports.getSettings()));

  const render = (): void => {
    const typed = root.querySelector<HTMLInputElement>("#url")?.value;
    root.innerHTML = template(ports.getSettings(), ports.connection(), ports.car(), locale, notice, ports.build ?? "");
    notice = "";
    const field = root.querySelector<HTMLInputElement>("#url");
    if (field && typed !== undefined && typed !== "") field.value = typed;
    applyTab(root, tab);
    root.querySelectorAll<HTMLButtonElement>("[data-tab-go]").forEach((button) => {
      button.addEventListener("click", () => {
        tab = button.dataset["tabGo"] ?? "now";
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

// ---- pure view models (tests read these) ----------------------------------------------

export interface Banner { readonly tone: "ok" | "warn" | "critical" | "offline" | "none"; readonly text: string }

/** The one message that counts right now. */
export function bannerFor(connection: PhoneConnection, car: CarState | null, locale: Locale): Banner {
  const x = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  if (connection.kind === "error") return { tone: "offline", text: x("p.status.error", { reason: connection.reason }) };
  if (!car) return { tone: "none", text: connection.kind === "demo" ? x("p.status.none") : x("p.status.loading") };
  const worst = activeWarnings(car).find((w) => w.level !== "info");
  if (worst) return { tone: worst.level === "crit" ? "critical" : "warn", text: x("p.status.warnings", { list: warningList(locale, car) }) };
  return {
    tone: car.stale ? "offline" : "ok",
    text: x("p.status.car", { mode: x("p.mode." + car.mode), soc: pct(car.battery.soc), range: km(car.battery.rangeKm), age: car.stale ? ageText(locale, car.ageS) : x("g.live") }),
  };
}

const esc = (text: string): string => escapeHtml(text);

/** "an" / "aus" plus the fan level, or null when the car does not report climate. */
export function climateParts(car: CarState, locale: Locale): { value: string; unit: string } | null {
  const { acOn, acFan } = car.body;
  if (acOn === null) return null;
  const unit = acOn && acFan !== null && acFan > 0 ? t(locale, "p.k.fan", { fan: Math.round(acFan) }) : "";
  return { value: t(locale, acOn ? "g.cp.on" : "g.cp.off"), unit };
}

/** What is open, in words ("Tür offen · Kofferraum offen"), or "". */
function openText(car: CarState, locale: Locale): string {
  return [
    car.body.doorOpen ? t(locale, "p.k.doorOpen") : "",
    car.body.trunkOpen ? t(locale, "p.k.trunkOpen") : "",
    car.body.hoodOpen ? t(locale, "p.k.hoodOpen") : "",
  ].filter(Boolean).join(" · ");
}

/** "Jetzt": banner, hero card with the charge, 2 x 2 key figures, a card per tyre. */
export function nowInner(connection: PhoneConnection, car: CarState | null, locale: Locale): string {
  const x = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  const banner = bannerFor(connection, car, locale);
  const stat = (label: string, value: string, unit: string, alert = false): string =>
    `<div${alert ? ' class="alert"' : ""}><span>${esc(label)}</span><b>${esc(value)}</b><small>${esc(unit)}</small></div>`;
  const bad = car ? Object.values(car.tyres).some((tyre) => tyre.leak || tyre.low) : false;
  const tyreKnown = car ? Object.values(car.tyres).some((tyre) => tyre.kpa !== null) : false;
  // Only wheels the car reports: a model without tyre sensors shows no tyre strip at all.
  const cards = car ? (["fl", "fr", "rl", "rr"] as const).filter((wheel) => car.tyres[wheel].kpa !== null || car.tyres[wheel].leak || car.tyres[wheel].low).map((wheel) => {
    const tyre = car.tyres[wheel];
    const problem = tyre.leak || tyre.low;
    const temp = tyre.temp === null ? "" : ` · ${deg(tyre.temp, locale)}`;
    return `<div class="host tone-${problem ? "warn" : "ok"}"><b>${esc(t(locale, "g.wheelLong." + wheel))}</b><em>${esc(problem ? x("g.cp.tyresCheck") : x("g.cp.tyresOk"))}</em><span><i>${esc((tyre.kpa === null ? "" : bar(tyre.kpa, locale)) + temp)}</i></span></div>`;
  }) : [];
  // Up to four key figures, only the ones the car reports (other BYD models report fewer).
  const climate = car ? climateParts(car, locale) : null;
  const opened = car ? openText(car, locale) : "";
  const figures = car ? [
    climate ? stat(x("p.k.climate"), climate.value, climate.unit) : "",
    car.body.locked !== null ? stat(x("p.k.lock"), lockWord(locale, car), opened, car.body.locked === false) : opened ? stat(x("p.k.lock"), "–", opened, true) : "",
    tyreKnown || bad ? stat(x("p.k.tyres"), x(bad ? "g.cp.tyresCheck" : "g.cp.tyresOk"), "", bad) : "",
    car.body.extTemp !== null ? stat(x("p.k.outside"), deg(car.body.extTemp, locale), "") : "",
    car.battery.volt12 !== null ? stat(x("p.k.v12"), volt(car.battery.volt12, locale), "") : "",
    car.battery.odometerKm !== null ? stat(x("p.k.odometer"), km(car.battery.odometerKm), "") : "",
  ].filter(Boolean).slice(0, 4) : [];
  return `
    <p class="banner tone-${banner.tone}">${esc(banner.text)}</p>
    <section class="card hero-card">
      <div class="hero">
        <div><span>${esc(x("p.heroSoc"))}</span><strong>${esc(car ? pct(car.battery.soc).replace(" ", "") : "–")}</strong></div>
        <p>${esc(car ? km(car.battery.rangeKm) : "–")}</p>
      </div>
      ${figures.length > 0 ? `<div class="stats">${figures.join("")}</div>` : ""}
    </section>
    ${cards.length > 0 ? `<h2 class="strip-title">${esc(x("p.k.tyres"))}</h2><div class="strip">${cards.join("")}</div>` : ""}`;
}

/** "Auto": charging and the car's details (only what the car reports); display only. */
export function carInner(car: CarState | null, locale: Locale): string {
  const L = (key: string, vars: Record<string, string | number> = {}): string => esc(t(locale, key, vars));
  const T = (key: string): string => t(locale, key);
  const row = (label: string, value: string): string => `<tr><td>${esc(label)}</td><td>${esc(value)}</td></tr>`;
  const c = car?.charge;
  const chargeCard = `
  <section class="card">
    <h2>${L("p.tabCharge")}</h2>
    ${!car || !c ? `<p class="hint">${L("p.noData")}</p>` : `
    <p class="big">${esc(pct(car.battery.soc))} · ${esc(km(car.battery.rangeKm))}</p>
    ${car.battery.src === "cloud" ? `<p class="hint">${esc(t(locale, "p.cloudSrc", { min: car.battery.cloudAgeMin ?? "?" }))}</p>` : ""}
    <table class="keys">
      ${row(T("p.k.charging"), c.active ? `${kw(c.kw, locale)} · ${T(c.dc ? "g.charge.dc" : "g.charge.ac")}` : c.done ? T("p.k.done") : T("p.k.notCharging"))}
      ${c.active && c.etaMin !== null ? row(T("p.k.eta"), duration(c.etaMin)) : ""}
      ${c.active && c.kwh !== null ? row(T("p.k.added"), `${dec(c.kwh, 1, locale)} kWh`) : ""}
    </table>`}
    <details class="advanced"><summary>?</summary><p class="hint">${L("p.chargeHint")}</p></details>
  </section>`;
  const tyreRow = car ? (["fl", "fr", "rl", "rr"] as const).filter((w) => car.tyres[w].kpa !== null)
    .map((w) => t(locale, "g.wheel." + w) + " " + bar(car.tyres[w].kpa, locale) + (car.tyres[w].leak || car.tyres[w].low ? " !" : "")).join(" · ") : "";
  const opened = car ? openText(car, locale) : "";
  const climate = car ? climateParts(car, locale) : null;
  const { soh, cellTMin, cellTMax } = car?.battery ?? { soh: null, cellTMin: null, cellTMax: null };
  const battery = [
    soh === null ? "" : `SoH ${pct(soh)}`,
    cellTMin === null && cellTMax === null ? "" : `${deg(cellTMin ?? cellTMax, locale)}${cellTMin !== null && cellTMax !== null && cellTMin !== cellTMax ? " – " + deg(cellTMax, locale) : ""}`,
  ].filter(Boolean).join(" · ");
  const carCard = car ? `
  <section class="card">
    <h2>${L("p.car")}</h2>
    <table class="keys">
      ${car.body.locked !== null || opened ? row(T("p.k.lock"), [car.body.locked !== null ? lockWord(locale, car) : "", opened].filter(Boolean).join(" · ")) : ""}
      ${climate ? row(T("p.k.climate"), climate.value + (climate.unit ? " · " + climate.unit : "")) : ""}
      ${tyreRow ? row(T("p.k.tyres"), tyreRow) : ""}
      ${car.battery.volt12 !== null ? row(T("p.k.v12"), volt(car.battery.volt12, locale)) : ""}
      ${car.battery.odometerKm !== null ? row(T("p.k.odometer"), km(car.battery.odometerKm)) : ""}
      ${car.position ? `<tr><td>${esc(T("p.k.position"))}</td><td><a href="https://www.google.com/maps/search/?api=1&amp;query=${car.position.lat},${car.position.lon}" target="_blank" rel="noopener">${esc(T("p.mapLink"))}</a>${car.position.ageMin !== null ? " · " + esc(t(locale, "p.posAge", { min: car.position.ageMin })) : ""}</td></tr>` : ""}
      ${battery ? row(T("p.k.battery"), battery) : ""}
      ${car.drive.cons50 !== null ? row(T("p.k.cons"), `${dec(car.drive.cons50, 1, locale)} kWh/100 km`) : ""}
    </table>
  </section>` : "";
  return chargeCard + carCard + controlCard(car, locale);
}

/** "Steuern": what the bridge allows, whether the car is off, how the last command ended. Sends nothing. */
export function controlCard(car: CarState | null, locale: Locale): string {
  const L = (key: string, vars: Record<string, string | number> = {}): string => esc(t(locale, key, vars));
  const ctl = car?.control;
  if (!car || !ctl || !ctl.enabled) {
    return `
  <section class="card">
    <h2>${L("p.k.readOnly")}</h2>
    <p class="hint">${L("p.readOnlyHint")}</p>
  </section>`;
  }
  const row = (label: string, value: string): string => `<tr><td>${esc(label)}</td><td>${esc(value)}</td></tr>`;
  const yes = (on: boolean): string => t(locale, on ? "p.ctl.free" : "p.ctl.notSetUp");
  const minutes = ctl.preheatMinutes.filter((m) => m === 10 || m === 20 || m === 30).join(" / ");
  const cmd = car.command;
  const label = cmd ? t(locale, cmd.action === "preheat" ? "g.ctl.preheat" : cmd.action === "unlock" ? "g.ctl.unlock" : "g.ctl.lock", { min: cmd.value ?? "?" }) : "";
  return `
  <section class="card">
    <h2>${L("p.ctl.title")}</h2>
    <p class="${ctl.carOff ? "big" : "hint"}">${L(ctl.carOff ? "g.ctl.ready" : "g.ctl.carOn")}</p>
    <table class="keys">
      ${row(t(locale, "g.ctl.lock"), yes(ctl.lock))}
      ${row(t(locale, "g.ctl.unlock"), yes(ctl.unlock) + (ctl.unlock ? " · " + t(locale, "p.ctl.telegram") : ""))}
      ${row(t(locale, "p.ctl.preheat"), ctl.preheat && minutes ? minutes + " min" : yes(false))}
      ${cmd ? row(t(locale, "p.ctl.last"), t(locale, "g.ctl.st." + cmd.status, { label })) : ""}
    </table>
    <p class="hint">${L("p.ctl.how")}</p>
  </section>`;
}

/** First-run checklist: pure, so tests can read it. */
export function setupInner(settings: Settings, connection: PhoneConnection, car: CarState | null, locale: Locale): string {
  const x = (key: string): string => t(locale, key);
  const added = !isFirstRun(settings);
  const answered = connection.kind === "ok" && car !== null;
  const step = (n: number, done: boolean, key: string): string =>
    `<li class="${done ? "done" : ""}"><span class="num" aria-hidden="true">${done ? "✓" : n}</span><span>${esc(x(key))}</span></li>`;
  return `<ol class="steps">${step(1, added, "p.setup1")}${step(2, added && answered, "p.setup2")}${step(3, added && answered, "p.setup3")}</ol>`
    + (added ? "" : `<p class="hint">${esc(x("p.setupDemo"))}</p>`);
}

function pillOf(connection: PhoneConnection, car: CarState | null, locale: Locale): { text: string; on: boolean } {
  if (connection.kind === "error") return { text: t(locale, "p.chipOffline"), on: false };
  if (!car) return { text: t(locale, connection.kind === "demo" ? "p.chipDemo" : "p.chipLoading"), on: false };
  const on = !car.stale;
  return { text: `${on ? "● " : ""}${t(locale, "p.mode." + car.mode)} · ${pct(car.battery.soc)}`, on };
}

function template(settings: Settings, connection: PhoneConnection, car: CarState | null, locale: Locale, notice: string, build: string): string {
  const L = (key: string, vars: Record<string, string | number> = {}): string => escapeHtml(t(locale, key, vars));
  const url = settings.url;
  const shown = url || BUILD_URL;
  const firstRun = isFirstRun(settings);
  const pill = pillOf(connection, car, locale);
  const serverCard = `
  <details class="fold card"${firstRun ? " open" : ""}>
    <summary>${esc(firstRun ? t(locale, "p.server") : t(locale, "p.serverSet", { url: shown.replace(/^https?:\/\//, "") }))}</summary>
    ${shown ? "" : `<p class="hint">${L("p.firstRun")}</p>`}
    <label for="url">${L("p.url")}</label>
    <input id="url" type="text" inputmode="url" autocomplete="off" value="${escapeHtml(url)}" placeholder="${BUILD_URL ? escapeHtml(BUILD_URL) : L("p.urlPlaceholder")}" />
    ${BUILD_URL ? `<p class="hint">${L("p.urlBuild")}</p>` : ""}
    ${url && isPlainHttp(url) ? `<p class="hint"><small class="warn">${L("p.httpWarn")}</small></p>` : ""}
    <button id="save" type="button" class="big">${L("p.save")}</button>
    ${url ? `<button id="clear" type="button" class="secondary">${L("p.clear")}</button>` : ""}
  </details>`;
  return `
  <header class="brand bar">
    <div>
      <div class="brand-mark">${L("p.kicker")}</div>
      <h1>BYD Glass</h1>
    </div>
    <span id="pill" class="chip${pill.on ? " on" : ""}">${escapeHtml(pill.text)}</span>
  </header>

  ${notice ? `<p class="notice">${escapeHtml(notice)}</p>` : ""}

  <div class="tab" data-tab="now" id="now">
    <div id="now-live">${nowInner(connection, car, locale)}</div>
  </div>

  <div class="tab" data-tab="car">
    ${carInner(car, locale)}
  </div>

  <div class="tab" data-tab="settings">
    ${firstRun ? `<section class="card setup"><h2>${L("p.setupTitle")}</h2>${setupInner(settings, connection, car, locale)}</section>` : ""}
    ${serverCard}

    <section class="card">
      <h2>${L("p.glasses")}</h2>
      <label class="check"><input id="invert" type="checkbox" ${settings.invertScroll ? "checked" : ""} /> ${L("p.invert")}</label>
      <details class="fold">
        <summary>${L("p.controls")}</summary>
        <table class="keys">
          <tr><td>${L("p.c.tap")}</td><td>${L("p.c.tap.d")}</td></tr>
          <tr><td>${L("p.c.swipe")}</td><td>${L("p.c.swipe.d")}</td></tr>
          <tr><td>${L("p.c.double")}</td><td>${L("p.c.double.d")}</td></tr>
        </table>
      </details>
    </section>

    <section class="card compact">${languageSelect(locale)}</section>

    <details class="fold card">
      <summary>${L("p.moreTitle")}</summary>
      <p class="hint">${L("p.notice")}</p>
      <p class="hint">${L("p.privacy")}${build ? " · " + escapeHtml(build) : ""}</p>
    </details>
  </div>

  <nav class="tabbar" role="tablist">
    ${TABS.map(({ id, icon, key }) => `<button type="button" role="tab" data-tab-go="${id}"><span aria-hidden="true">${icon}</span>${L(key)}</button>`).join("")}
  </nav>`;
}
