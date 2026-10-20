import { isLoopback, isPlainHttp, validateServerUrl } from "../api/client";
import { getLocale, languageSelect, setLocale, type Locale } from "../i18n";
import { t } from "../messages";
import { BUILD_URL, maskToken, type Settings } from "../storage/persist";
import { VERSION } from "../version";
import { escapeHtml } from "./html";
import type { Place, Phase } from "../sun/light";
import type { LightModel, PlaceSource } from "../sun/model";
import type { CallSheet, CustomerItem, ProjectItem } from "../api/types";
import { timedRows, type DayModel } from "../day/model";

/**
 * The phone companion: where the server lives, an optional token, and how the
 * glasses are operated. Projects, shots, script, schedule and packing list are
 * edited in the server's own web terminal — a laptop screen is the better
 * place for that than the Even app.
 */

export type ConnectionState =
  | { readonly kind: "none" }
  | { readonly kind: "demo" }
  | { readonly kind: "loading" }
  | { readonly kind: "ok"; readonly project: string }
  | { readonly kind: "error"; readonly reason: string };

/** What the Licht tab shows: the same model the glasses draw, for now. */
export interface LightPhone {
  readonly model: LightModel;
  readonly place: Place | null;
  readonly source: PlaceSource | null;
  readonly phase: Phase | null;
}

/** What the Jetzt tab shows: the same model the glasses draw, plus the sheet for the card strip. */
export interface DayPhone {
  readonly model: DayModel;
  readonly sheet: CallSheet;
  /** The minute of the day now, to mark the scenes in the strip. */
  readonly minutes: number;
}

/** What the Projekte tab lists. */
export interface ProjectsPhone {
  readonly customers: readonly CustomerItem[];
  readonly projects: readonly ProjectItem[];
  readonly activeProject: string;
  readonly project: string;
}

export interface PhoneUiPorts {
  readonly day?: () => DayPhone;
  readonly projects?: () => ProjectsPhone;
  /** Asks the server again (the primary button of Jetzt). */
  readonly onRefresh?: () => void;
  readonly getSettings: () => Settings;
  /** Persists and applies; rejects when storage refused it. */
  readonly saveSettings: (next: Settings) => Promise<void>;
  readonly connection: () => ConnectionState;
  readonly pendingCount: () => number;
  readonly light?: () => LightPhone;
  readonly onLocate?: () => void;
  readonly locale?: () => Locale;
  readonly onLocaleChange?: (locale: Locale) => void;
}

export interface PhoneUi {
  /** Redraws the page after a change made elsewhere (connection, glasses). */
  readonly refresh: () => void;
}

/** Text inputs whose unsaved contents survive a redraw. */
const DRAFT_FIELDS = ["url", "token"] as const;

/** Exactly three tabs (QUS v1), one row. */
export const TABS: readonly { id: string; icon: string; key: string }[] = [
  { id: "now", icon: "🎬", key: "p.tabNow" },
  { id: "projects", icon: "📁", key: "p.tabProjects" },
  { id: "settings", icon: "⚙️", key: "p.tabSettings" },
];
const TAB_KEY = "quietglass.shoot-day.tab.v2";

/** Nothing set up yet: no server address (and none built in). Settings open first, with the checklist. */
export function isFirstRun(settings: Settings): boolean {
  return settings.serverUrl === "" && BUILD_URL === "";
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
    const typed = DRAFT_FIELDS.map((id) => root.querySelector<HTMLInputElement>("#" + id)?.value);
    root.innerHTML = template(ports.getSettings(), ports.connection(), ports.pendingCount(), locale, notice, ports.light?.() ?? null, ports.day?.() ?? null, ports.projects?.() ?? null);
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
      if (field && value !== undefined) field.value = value;
    });
    wire();
  };

  const notify = (message: string): void => { notice = message; render(); };

  const commit = (next: Settings, okNotice: string): void => {
    ports.saveSettings(next).then(
      () => notify(okNotice),
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
      const urlField = byId<HTMLInputElement>("url");
      const tokenField = byId<HTMLInputElement>("token");
      const url = urlField?.value.trim() ?? "";
      // Empty is fine when the build carries its own address.
      const check = url === "" && BUILD_URL ? { valid: true, errors: [] } : validateServerUrl(url);
      if (!check.valid) { notify(check.errors.map((key) => t(locale, key)).join(" ")); return; }
      const typedToken = tokenField?.value ?? "";
      // The token field is write-only: left empty, the stored token is kept.
      const current = ports.getSettings();
      const token = typedToken || current.token;
      // The token should not linger in the field; the address stays visible.
      if (tokenField) tokenField.value = "";
      const next: Settings = { serverUrl: url.replace(/\/+$/, ""), invertScroll: current.invertScroll, ...(token ? { token } : {}) };
      commit(next, t(locale, "p.saved"));
    });

    byId<HTMLButtonElement>("locate")?.addEventListener("click", () => ports.onLocate?.());
    byId<HTMLButtonElement>("refresh")?.addEventListener("click", () => ports.onRefresh?.());

    byId<HTMLButtonElement>("clear-token")?.addEventListener("click", () => {
      const current = ports.getSettings();
      commit({ serverUrl: current.serverUrl, invertScroll: current.invertScroll }, t(locale, "p.saved"));
    });

    byId<HTMLInputElement>("invert")?.addEventListener("change", (event) => {
      const current = ports.getSettings();
      commit({ ...current, invertScroll: (event.target as HTMLInputElement).checked }, t(locale, "p.saved"));
    });
  };

  render();
  // The Jetzt tab follows the clock; nothing else changes on its own. Never while typing.
  const ticker = setInterval(() => {
    if (tab !== "now" || !ports.day) return;
    const active = globalThis.document?.activeElement;
    if (active && (active.tagName === "INPUT" || active.tagName === "SELECT")) return;
    render();
  }, 60_000);
  // In node (tests) the timer must not keep the process alive.
  (ticker as unknown as { unref?: () => void }).unref?.();
  return { refresh: render };
}

/** The Licht tab: headline, sun now, facts, the schedule in its light and today's timeline. */
export function lightSection(light: LightPhone | null, locale: Locale, now = Date.now()): string {
  const L = (key: string, vars: Record<string, string | number> = {}): string => escapeHtml(t(locale, key, vars));
  if (!light) return "";
  const { model, place, source, phase } = light;
  const where = place && source
    ? `<p class="hint">${L("p.light.source." + source, { lat: place.latitude.toFixed(2), lon: place.longitude.toFixed(2) })}</p>`
    : "";
  const locate = `<button id="locate" type="button" class="secondary">${L("p.light.locate")}</button>`;
  if (!model.ok) {
    return `<section class="card"><h2>${L("p.light.title")}</h2><p class="hint">${L("p.light.none")}</p>${locate}</section>`;
  }
  const facts = model.facts.map((fact) => `<p class="hint">${escapeHtml(fact)}</p>`).join("");
  const shoots = model.shoots.length
    ? `<section class="card"><h2>${L("p.light.shoots")}</h2><ul class="light-list">${model.shoots.map((shoot) =>
      `<li${shoot.at < now ? ' class="past"' : ""}><b>${escapeHtml(shoot.what || shoot.time)}</b><br>${escapeHtml(shoot.line)}</li>`).join("")}</ul></section>`
    : "";
  const rows = model.timeline.map((entry) =>
    `<tr class="${entry.kind}${entry.at < now ? " past" : ""}"><td>${escapeHtml(entry.time)}</td><td>${escapeHtml(entry.label)}</td></tr>`).join("");
  return `
  <section class="card">
    <h2>${L("p.light.title")}</h2>
    <p class="light-headline">${escapeHtml(model.headline)}</p>
    <p>${L("p.light.sunNow", { sun: model.sunWords, phase: phase ? t(locale, "p.light.phase." + phase) : "–" })}</p>
    ${facts}
    <p class="hint">${escapeHtml(model.moon)}</p>
    ${where}
    ${locate}
  </section>
  ${shoots}
  <section class="card">
    <h2>${L("p.light.today")}</h2>
    <table class="keys timeline">${rows}</table>
    <p class="hint">${L("p.light.offline")}</p>
  </section>`;
}

export interface Banner { readonly tone: "ok" | "warn" | "none" | "critical"; readonly text: string }

/** The one message that counts right now. */
export function bannerFor(connection: ConnectionState, pending: number, locale: Locale): Banner {
  const x = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  switch (connection.kind) {
    case "demo": return { tone: "none", text: x("p.banner.demo") };
    case "none": return { tone: "none", text: x("p.banner.none") };
    case "loading": return { tone: "none", text: x("p.banner.loading") };
    case "error": return { tone: "critical", text: x("p.banner.error", { reason: connection.reason }) };
    case "ok": return pending > 0 ? { tone: "warn", text: x("p.banner.pending", { count: pending }) } : { tone: "ok", text: x("p.banner.ok", { project: connection.project || "–" }) };
  }
}

/** The hero card: the next scene's time as the one big value. */
export function heroOf(model: DayModel, locale: Locale): { label: string; value: string; side: string; what: string } {
  const timed = /^\d{1,2}:\d{2}$/.test(model.headline[0] ?? "");
  return {
    label: t(locale, timed ? "p.hero.next" : model.headline[0] === t(locale, "g.day.over") ? "p.hero.over" : "p.hero.none"),
    value: timed ? model.headline[0]! : "–",
    side: timed ? model.caption : "",
    what: timed ? (model.headline[1] ?? "") : "",
  };
}

/** "Jetzt": banner, hero card, 2 x 2 key figures, the one button, a card per scene, the light folded. */
export function nowInner(day: DayPhone | null, connection: ConnectionState, pending: number, locale: Locale, light: LightPhone | null): string {
  const L = (key: string, vars: Record<string, string | number> = {}): string => escapeHtml(t(locale, key, vars));
  const banner = bannerFor(connection, pending, locale);
  const bannerHtml = `<p class="banner tone-${banner.tone}">${escapeHtml(banner.text)}</p>`;
  if (!day) return bannerHtml;
  const hero = heroOf(day.model, locale);
  const cell = (index: number): string => {
    const c = day.model.cells[index];
    return c ? `<div${c.alert ? ' class="alert"' : ""}><span>${escapeHtml(c.label)}</span><b>${escapeHtml(c.value)}</b></div>` : "";
  };
  const rows = timedRows(day.sheet);
  const nextAt = rows.findIndex((row) => row.minutes > day.minutes);
  const strip = rows.length === 0 ? "" : `
  <p class="strip-title">${L("p.strip")}</p>
  <div class="strip">${rows.map((row, index) => {
    const state = index === nextAt ? "next" : row.minutes <= day.minutes ? "past" : "later";
    return `<div class="host scene ${state}"><em>${escapeHtml(row.row.time.trim())}</em><b>${escapeHtml(row.row.what)}</b></div>`;
  }).join("")}</div>`;
  return `${bannerHtml}
  <section class="card hero-card">
    <div class="hero"><div><span>${escapeHtml(hero.label)}</span><strong>${escapeHtml(hero.value)}</strong></div><p>${escapeHtml(hero.side)}</p></div>
    ${hero.what ? `<p class="hero-what">${escapeHtml(hero.what)}</p>` : ""}
    <div class="stats">${[0, 1, 2, 4].map(cell).join("")}</div>
    <button id="refresh" type="button" class="big">${L("p.primary.refresh")}</button>
  </section>
  ${strip}
  ${light ? `<details class="card fold"><summary>${L("p.light.title")}</summary>${lightSection(light, locale)}</details>` : ""}`;
}

/** "Projekte": the customers and the projects the server knows. */
export function projectsInner(data: ProjectsPhone | null, locale: Locale, terminalUrl: string): string {
  const L = (key: string, vars: Record<string, string | number> = {}): string => escapeHtml(t(locale, key, vars));
  const customers = data?.customers ?? [];
  const projects = data?.projects ?? [];
  const list = (title: string, items: string): string => items ? `<section class="card"><h2>${title}</h2><ul class="scripts">${items}</ul></section>` : "";
  const customerItems = customers.map((c) => `<li><span><strong>${escapeHtml(c.name)}</strong>${c.company && c.company !== c.name ? ` <small>${escapeHtml(c.company)}</small>` : ""}</span><small>${c.projectCount}</small></li>`).join("");
  const projectItems = projects.map((p) => `<li><span><strong>${escapeHtml(p.name)}</strong>${p.date ? ` <small>${escapeHtml(p.date)}</small>` : ""}</span>${p.id === data?.activeProject ? `<span class="tag tone-ok">${L("p.projects.active")}</span>` : ""}</li>`).join("");
  const current = data?.project && projects.length === 0 && customers.length === 0
    ? `<section class="card"><h2>${L("p.projects.projects")}</h2><ul class="scripts"><li><strong>${escapeHtml(data.project)}</strong><span class="tag tone-ok">${L("p.projects.active")}</span></li></ul></section>` : "";
  const empty = !customerItems && !projectItems && !current ? `<section class="card"><p class="hint">${L("p.projects.none")}</p></section>` : "";
  return `${list(L("p.projects.customers"), customerItems)}${list(L("p.projects.projects"), projectItems)}${current}${empty}${terminalUrl ? `<p class="hint">${L("p.terminal", { url: terminalUrl })}</p>` : ""}`;
}

function template(settings: Settings, connection: ConnectionState, pending: number, locale: Locale, notice: string, light: LightPhone | null, day: DayPhone | null, projects: ProjectsPhone | null): string {
  const L = (key: string, vars: Record<string, string | number> = {}): string => escapeHtml(t(locale, key, vars));
  const url = settings.serverUrl;
  const shown = url || BUILD_URL;
  const warnHttp = shown && isPlainHttp(shown) && !isLoopback(shown);
  const firstRun = isFirstRun(settings);
  const configured = shown !== "";
  const steps = ["p.step.1", "p.step.2", "p.step.3"].map((key, index) =>
    `<li class="${index === 0 && configured ? "done" : ""}"><span class="num">${index + 1}</span>${L(key)}</li>`).join("");

  return `
  <header class="brand bar">
    <div>
      <span class="brand-mark">${L("p.kicker")}</span>
      <h1>Shoot Day</h1>
    </div>
    <span class="chip${connection.kind === "ok" ? " on" : ""}">${connection.kind === "ok" && connection.project ? escapeHtml(connection.project) : L("p.chip." + connection.kind)}</span>
  </header>

  ${notice ? `<p class="notice">${escapeHtml(notice)}</p>` : ""}

  <div class="tab" data-tab="now">
  ${nowInner(day, connection, pending, locale, light)}
  </div>

  <div class="tab" data-tab="projects">
  ${projectsInner(projects, locale, shown ? shown + "/" : "")}
  </div>

  <div class="tab" data-tab="settings">
  ${firstRun ? `<section class="card setup"><h2>${L("p.status")}</h2><p class="hint">${L("p.firstRun")}</p><ol class="steps">${steps}</ol></section>` : ""}
  <details class="card fold"${configured ? "" : " open"}>
    <summary>${configured ? L("p.card.serverSet") : L("p.card.server")}</summary>
    <label for="url">${L("p.url")}</label>
    <input id="url" type="text" inputmode="url" autocomplete="off" value="${escapeHtml(url)}" placeholder="${BUILD_URL ? escapeHtml(BUILD_URL) : L("p.urlPlaceholder")}" />
    ${BUILD_URL ? `<p class="hint">${L("p.urlBuild")}</p>` : ""}
    ${warnHttp ? `<p class="hint"><small class="warn">${L("p.httpWarn")}</small></p>` : ""}
    <label for="token">${L("p.token")}</label>
    <input id="token" type="password" autocomplete="off" placeholder="${L("p.tokenPlaceholder")}" />
    <p class="hint">${L("p.tokenNow", { state: maskToken(settings.token, locale) })}</p>
    <button id="save" type="button">${L("p.save")}</button>
    ${settings.token ? `<button id="clear-token" type="button" class="secondary">${L("p.tokenClear")}</button>` : ""}
  </details>

  <section class="card">
    <h2>${L("p.card.glasses")}</h2>
    <label class="check"><input id="invert" type="checkbox" ${settings.invertScroll ? "checked" : ""} /> ${L("p.invert")}</label>
    <details>
      <summary>${L("p.controls")}</summary>
      <table class="keys">
        <tr><td>${L("p.c.tap")}</td><td>${L("p.c.tap.d")}</td></tr>
        <tr><td>${L("p.c.swipe")}</td><td>${L("p.c.swipe.d")}</td></tr>
        <tr><td>${L("p.c.hold")}</td><td>${L("p.c.hold.d")}</td></tr>
        <tr><td>${L("p.c.double")}</td><td>${L("p.c.double.d")}</td></tr>
        <tr><td>${L("p.c.light")}</td><td>${L("p.c.light.d")}</td></tr>
        <tr><td>${L("p.c.customers")}</td><td>${L("p.c.customers.d")}</td></tr>
      </table>
    </details>
  </section>

  <section class="card">
    <h2>${L("p.card.language")}</h2>
    ${languageSelect(locale)}
  </section>

  <section class="card">
    <h2>${L("p.card.about")}</h2>
    <p>Shoot Day ${L("p.moreVersion")} ${VERSION}</p>
    <details><summary>${L("p.more")}</summary><p class="hint">${L("p.moreAbout")}</p><p class="hint">${L("p.privacy")}</p></details>
  </section>
  </div>

  <nav class="tabbar" role="tablist">
    ${TABS.map(({ id, icon, key }) => `<button type="button" role="tab" data-tab-go="${id}"><span aria-hidden="true">${icon}</span>${L(key)}</button>`).join("")}
  </nav>`;
}
