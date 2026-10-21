import { isPlainHttp, validateUrl } from "../ns/client";
import { normaliseLimits, type Limits } from "../ns/alerts";
import { delta, type PumpStatus } from "../ns/model";
import { glucose, insulin, parseGlucose, signedDelta, unitLabel, type Unit } from "../ns/units";
import { getLocale, languageSelect, setLocale, type Locale } from "../i18n";
import { t } from "../messages";
import { ageText, arrowText, currentAlerts, type ViewState } from "../glasses/views";
import { sensorShort } from "../cockpit/model";
import { BUILD_URL, maskToken, type Settings } from "../storage/persist";
import { escapeHtml } from "./html";

/**
 * The phone companion (QUS v1, the look of Rain Lens): exactly three tabs -
 * Jetzt (the glucose at a glance), Verlauf (the latest values, pump and meal)
 * and Einstellungen (server, unit and limits, glasses, language). The view
 * models are pure so the tests can read them.
 */

export type PhoneConnection =
  | { readonly kind: "none" }
  | { readonly kind: "demo" }
  | { readonly kind: "loading" }
  | { readonly kind: "ok" }
  | { readonly kind: "error"; readonly reason: string };

export interface PhoneUiPorts {
  readonly getSettings: () => Settings;
  readonly saveSettings: (next: Settings) => Promise<void>;
  readonly connection: () => PhoneConnection;
  /** The live state (what the glasses show). */
  readonly state: () => ViewState;
  /** Asks the server again. */
  readonly refresh?: () => void;
  readonly locale?: () => Locale;
  readonly onLocaleChange?: (locale: Locale) => void;
  readonly build?: string;
}

export interface PhoneUi {
  readonly refresh: () => void;
}

/** The three tabs. */
export const TABS: readonly { id: string; icon: string; key: string }[] = [
  { id: "now", icon: "🩸", key: "p.tabNow" },
  { id: "history", icon: "📈", key: "p.tabHistory" },
  { id: "settings", icon: "⚙️", key: "p.tabSettings" },
];
const TAB_KEY = "quietglass.sugarglass.tab";

/** Nothing set up yet (no server address, none in the build): Einstellungen opens first, with the three-step checklist. */
export function isFirstRun(settings: Settings, buildUrl: string = BUILD_URL): boolean {
  return !settings.url && !buildUrl;
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

const DRAFT_FIELDS = ["url", "token", "targetLow", "targetHigh", "urgentLow", "low", "high", "stale"] as const;
const LIMIT_FIELDS = ["targetLow", "targetHigh", "urgentLow", "low", "high"] as const;

const esc = (text: string): string => escapeHtml(text);

// ---- pure view models (tests read these) ----------------------------------------------

export interface Banner { readonly tone: "ok" | "warn" | "critical" | "offline" | "none"; readonly text: string }

/** The one message that counts right now. */
export function bannerFor(state: ViewState, connection: PhoneConnection): Banner {
  const { locale } = state;
  const x = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  if (connection.kind === "none") return { tone: "none", text: x("p.banner.none") };
  if (connection.kind === "demo") return { tone: "none", text: x("p.banner.demo") };
  if (connection.kind === "loading") return { tone: "none", text: x("p.banner.loading") };
  if (connection.kind === "error") return { tone: "offline", text: x("p.banner.error", { reason: connection.reason }) };
  const newest = state.data?.readings[0];
  if (!newest) return { tone: "none", text: x("p.banner.noData") };
  const worst = currentAlerts(state).find((alert) => alert.kind !== "noData");
  if (worst) {
    const text = x("g.alert." + worst.kind, { value: glucose(newest.mgdl, state.unit, locale), unit: unitLabel(state.unit), age: ageText(locale, state.now - newest.at) });
    return { tone: worst.critical ? (worst.kind === "stale" ? "offline" : "critical") : "warn", text };
  }
  return { tone: "ok", text: x("p.banner.ok") };
}

/** "Jetzt": banner, hero card, 2 x 2 key figures, the one button, a card per pump fact, the notice. */
export function nowInner(state: ViewState, connection: PhoneConnection): string {
  const { locale, unit } = state;
  const x = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  const banner = bannerFor(state, connection);
  const readings = state.data?.readings ?? [];
  const newest = readings[0];
  const list = currentAlerts(state);
  const stale = list.some((alert) => alert.kind === "stale");
  const change = stale ? null : delta(readings);
  const pump = state.data?.pump ?? null;
  const stat = (label: string, value: string, unitText: string, alert = false): string =>
    `<div${alert ? ' class="alert"' : ""}><span>${esc(label)}</span><b>${esc(value)}</b><small>${esc(unitText)}</small></div>`;
  const low = glucose(state.limits.targetLow, unit, locale);
  const high = glucose(state.limits.targetHigh, unit, locale);
  const cards = pump ? pumpCards(pump, state) : [];
  return `
    <p class="banner tone-${banner.tone}">${esc(banner.text)}</p>
    <section class="card hero-card">
      <div class="hero">
        <div><span>${esc(x("p.hero.label"))}</span><strong>${esc(newest ? glucose(newest.mgdl, unit, locale) : "–")}${newest ? ` <small>${esc(arrowText(newest.direction))}</small>` : ""}</strong></div>
        <p>${esc(newest ? `${unitLabel(unit)} · ${ageText(locale, state.now - newest.at)}` : unitLabel(unit))}</p>
      </div>
      <div class="stats">
        ${stat(x("p.stat.trend"), change === null ? "–" : signedDelta(change, unit, locale), unitLabel(unit), list.some((a) => a.kind === "fallingFast"))}
        ${stat(x("p.stat.target"), `${low}–${high}`, unitLabel(unit))}
        ${stat(x("p.stat.iob"), pump?.iob == null ? "–" : insulin(pump.iob, locale), "")}
        ${stat(x("p.stat.reservoir"), pump?.reservoir == null ? "–" : insulin(pump.reservoir, locale), "")}
      </div>
      <button id="refresh" type="button" class="big">${esc(x("p.refresh"))}</button>
    </section>
    ${cards.length > 0 ? `<h2 class="strip-title">${esc(x("p.strip.pump"))}</h2><div class="strip">${cards.join("")}</div>` : ""}
    <p class="hint">${esc(x("p.notice"))}</p>`;
}

function pumpCards(pump: PumpStatus, state: ViewState): string[] {
  const { locale } = state;
  const x = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  const pct = (v: number | null): string => (v === null ? "–" : `${Math.round(v)} %`);
  const card = (title: string, value: string, note: string): string => `<div class="host tone-ok"><b>${esc(title)}</b><em>${esc(value)}</em><span>${esc(note)}</span></div>`;
  return [
    card(pump.device ?? x("g.start.pump"), x("g.pump.mode." + (pump.mode ?? "unknown")), pump.at === null ? "–" : ageText(locale, state.now - pump.at)),
    card(x("p.card.battery"), pct(pump.battery), x("g.cp.barPump")),
    card(x("p.card.phone"), pct(pump.uploaderBattery), x("g.cp.barPhone")),
    card(x("p.card.sensor"), sensorShort(pump, locale), pump.sensorState ? (t(locale, "g.sensor." + pump.sensorState) !== "g.sensor." + pump.sensorState ? x("g.sensor." + pump.sensorState) : pump.sensorState.toLowerCase().replace(/_/g, " ")) : "–"),
  ];
}

/** "Verlauf": the latest values as cards, then the last meal and bolus. */
export function historyInner(state: ViewState): string {
  const { locale, unit } = state;
  const x = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  const readings = (state.data?.readings ?? []).slice(0, 12);
  const hm = (at: number): string => { const d = new Date(at); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
  const treatments = state.data?.treatments;
  const meal = treatments?.lastCarbs || treatments?.lastBolus
    ? [
      treatments.lastCarbs ? `${Math.round(treatments.lastCarbs.grams)} g · ${ageText(locale, state.now - treatments.lastCarbs.at)}` : "",
      treatments.lastBolus ? `${insulin(treatments.lastBolus.units, locale)} · ${ageText(locale, state.now - treatments.lastBolus.at)}` : "",
    ].filter(Boolean).join(" / ")
    : x("p.history.noMeal");
  return `
    <h2 class="strip-title">${esc(x("p.history.title"))}</h2>
    ${readings.length === 0 ? `<section class="card"><p class="hint">${esc(x("p.history.empty"))}</p></section>` : `<div class="strip">${readings.map((r) => {
      const out = r.mgdl < state.limits.low || r.mgdl > state.limits.high;
      return `<div class="host tone-${out ? "warn" : "ok"}"><b>${esc(glucose(r.mgdl, unit, locale))}</b><em>${esc(arrowText(r.direction))}</em><span>${esc(hm(r.at))}</span></div>`;
    }).join("")}</div>`}
    <section class="card"><h2>${esc(x("p.history.meal"))}</h2><p>${esc(meal)}</p></section>`;
}

/** First-run checklist: pure, so tests can read it. */
export function setupInner(settings: Settings, answered: boolean, locale: Locale, buildUrl: string = BUILD_URL): string {
  const added = !isFirstRun(settings, buildUrl);
  const step = (n: number, done: boolean, key: string): string =>
    `<li class="${done ? "done" : ""}"><span class="num" aria-hidden="true">${done ? "✓" : n}</span><span>${esc(t(locale, key))}</span></li>`;
  return `<ol class="steps">${step(1, added, "p.setup.1")}${step(2, added, "p.setup.2")}${step(3, added && answered, "p.setup.3")}</ol>`
    + (added ? "" : `<p class="hint">${esc(t(locale, "p.setup.demo"))}</p>`)
    // Plain text, no link: a URL in the bundle must match the network whitelist exactly (store review).
    + `<p class="hint">${esc(t(locale, "p.setup.guide"))}</p>`;
}

/** The status pill: the value when there is one, otherwise the state in a word. */
export function pillOf(state: ViewState, connection: PhoneConnection): { text: string; on: boolean } {
  const newest = state.data?.readings[0];
  if (newest) return { text: `${glucose(newest.mgdl, state.unit, state.locale)} ${unitLabel(state.unit)}`, on: connection.kind === "ok" };
  const key = connection.kind === "none" ? "p.pill.none" : connection.kind === "error" ? "p.pill.error" : connection.kind === "loading" ? "p.pill.loading" : connection.kind === "demo" ? "p.pill.demo" : "p.pill.nodata";
  return { text: t(state.locale, key), on: false };
}

// ---- mounting ---------------------------------------------------------------------------

export function mountPhoneUi(ports: PhoneUiPorts): PhoneUi {
  const root = document.getElementById("app");
  if (!root) return { refresh: () => undefined };

  let notice = "";
  let locale: Locale = ports.locale?.() ?? getLocale();
  let tab = readTab(isFirstRun(ports.getSettings()));

  const render = (): void => {
    const typed = DRAFT_FIELDS.map((id) => root.querySelector<HTMLInputElement>("#" + id)?.value);
    root.innerHTML = template(ports.getSettings(), ports.connection(), { ...ports.state(), locale }, notice, ports.build ?? "");
    notice = "";
    applyTab(root, tab);
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
      if (field && value !== undefined && value !== "") field.value = value;
    });
    wire();
  };

  const notify = (message: string): void => { notice = message; render(); };

  const commit = (next: Settings, clearDrafts = false): void => {
    if (clearDrafts) for (const id of DRAFT_FIELDS) { const f = root.querySelector<HTMLInputElement>("#" + id); if (f) f.value = ""; }
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

    byId<HTMLButtonElement>("refresh")?.addEventListener("click", () => { ports.refresh?.(); });

    byId<HTMLButtonElement>("save")?.addEventListener("click", () => {
      const url = byId<HTMLInputElement>("url")?.value.trim() ?? "";
      const current = ports.getSettings();
      // Empty is fine when the build carries its own address.
      const check = url === "" && BUILD_URL ? { valid: true, errors: [] } : validateUrl(url || current.url);
      if (!check.valid) { notify(check.errors.map((key) => t(locale, key)).join(" ")); return; }
      const tokenField = byId<HTMLInputElement>("token");
      // The token field is write-only: left empty, the stored token is kept.
      const token = (tokenField?.value ?? "") || current.token;
      if (tokenField) tokenField.value = "";
      const nextUrl = (url || current.url).replace(/\/+$/, "");
      commit({ ...current, url: nextUrl, ...(token ? { token } : {}) });
    });

    byId<HTMLButtonElement>("clear-token")?.addEventListener("click", () => {
      const { token: _drop, ...rest } = ports.getSettings();
      commit(rest);
    });

    byId<HTMLSelectElement>("unit")?.addEventListener("change", (event) => {
      const value = (event.target as HTMLSelectElement).value === "mmol" ? "mmol" : "mgdl";
      commit({ ...ports.getSettings(), unit: value }, true);
    });

    byId<HTMLButtonElement>("save-limits")?.addEventListener("click", () => {
      const current = ports.getSettings();
      const next: Record<string, number> = { ...current.limits };
      for (const id of LIMIT_FIELDS) {
        const raw = byId<HTMLInputElement>(id)?.value ?? "";
        if (raw.trim() === "") continue;
        const mgdl = parseGlucose(raw, current.unit);
        if (mgdl === null) { notify(t(locale, "p.limitsBad")); return; }
        next[id] = mgdl;
      }
      const staleRaw = byId<HTMLInputElement>("stale")?.value ?? "";
      if (staleRaw.trim() !== "") {
        const minutes = Number(staleRaw);
        if (!Number.isFinite(minutes) || minutes < 6 || minutes > 60) { notify(t(locale, "p.limitsBad")); return; }
        next["staleMinutes"] = minutes;
      }
      commit({ ...current, limits: normaliseLimits(next as Partial<Limits>) }, true);
    });

    byId<HTMLInputElement>("invert")?.addEventListener("change", (event) => {
      commit({ ...ports.getSettings(), invertScroll: (event.target as HTMLInputElement).checked });
    });
  };

  render();
  return { refresh: render };
}

function limitInput(id: string, label: string, mgdl: number, unit: Unit, locale: Locale): string {
  return `<label for="${id}">${label} (${unitLabel(unit)})</label><input id="${id}" type="text" inputmode="decimal" autocomplete="off" placeholder="${escapeHtml(glucose(mgdl, unit, locale))}" />`;
}

function template(settings: Settings, connection: PhoneConnection, state: ViewState, notice: string, build: string): string {
  const { locale } = state;
  const L = (key: string, vars: Record<string, string | number> = {}): string => escapeHtml(t(locale, key, vars));
  const url = settings.url;
  const unit = settings.unit;
  const firstRun = isFirstRun(settings);
  const warnHttp = url && isPlainHttp(url);
  const limits = settings.limits;
  const pill = pillOf(state, connection);
  const answered = connection.kind === "ok";

  return `
  <header class="brand bar">
    <div>
      <div class="brand-mark">${L("p.kicker")}</div>
      <h1>Sugar Glass</h1>
    </div>
    <span id="pill" class="chip${pill.on ? " on" : ""}">${esc(pill.text)}</span>
  </header>

  ${notice ? `<p class="notice">${escapeHtml(notice)}</p>` : ""}

  <div class="tab" data-tab="now"><div id="now-live">${nowInner(state, connection)}</div></div>
  <div class="tab" data-tab="history"><div id="history-live">${historyInner(state)}</div></div>

  <div class="tab" data-tab="settings">
    ${firstRun ? `<section class="card setup"><h2>${L("p.setup.title")}</h2>${setupInner(settings, answered, locale)}</section>` : ""}
    <details class="fold card"${firstRun ? " open" : ""}>
      <summary>${L(firstRun ? "p.server" : "p.server.set")}</summary>
      ${firstRun ? `<p class="hint">${L("p.firstRun")}</p>` : ""}
      <label for="url">${L("p.url")}</label>
      <input id="url" type="text" inputmode="url" autocomplete="off" value="${escapeHtml(url)}" placeholder="${BUILD_URL ? escapeHtml(BUILD_URL) : L("p.urlPlaceholder")}" />
      ${BUILD_URL ? `<p class="hint">${L("p.urlBuild")}</p>` : ""}
      ${warnHttp ? `<p class="hint"><small class="warn">${L("p.httpWarn")}</small></p>` : ""}
      <label for="token">${L("p.token")}</label>
      <input id="token" type="password" autocomplete="off" placeholder="${L("p.tokenPlaceholder")}" />
      <p class="hint">${L("p.tokenNow", { state: maskToken(settings.token, locale) })}</p>
      <button id="save" type="button" class="big">${L("p.save")}</button>
      ${settings.token ? `<button id="clear-token" type="button" class="remove">${L("p.tokenClear")}</button>` : ""}
    </details>

    <details class="fold card">
      <summary>${L("p.display")}</summary>
      <label for="unit">${L("p.unit")}</label>
      <select id="unit"><option value="mgdl"${unit === "mgdl" ? " selected" : ""}>mg/dL</option><option value="mmol"${unit === "mmol" ? " selected" : ""}>mmol/L</option></select>
      ${limitInput("targetLow", L("p.targetLow"), limits.targetLow, unit, locale)}
      ${limitInput("targetHigh", L("p.targetHigh"), limits.targetHigh, unit, locale)}
      ${limitInput("urgentLow", L("p.urgentLow"), limits.urgentLow, unit, locale)}
      ${limitInput("low", L("p.low"), limits.low, unit, locale)}
      ${limitInput("high", L("p.high"), limits.high, unit, locale)}
      <label for="stale">${L("p.stale")}</label>
      <input id="stale" type="text" inputmode="numeric" autocomplete="off" placeholder="${limits.staleMinutes}" />
      <button id="save-limits" type="button" class="big">${L("p.limitsSave")}</button>
    </details>

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
      <summary>${L("p.more")}</summary>
      <p class="hint">${L("p.lede")}</p>
      <p class="hint">${L("p.notice")}</p>
      <p class="hint">${L("p.privacy")}${build ? " · " + escapeHtml(build) : ""}</p>
    </details>
  </div>

  <nav class="tabbar" role="tablist">
    ${TABS.map(({ id, icon, key }) => `<button type="button" role="tab" data-tab-go="${id}"><span aria-hidden="true">${icon}</span>${L(key)}</button>`).join("")}
  </nav>`;
}
