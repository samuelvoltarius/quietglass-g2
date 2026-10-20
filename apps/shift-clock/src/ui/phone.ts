import {
  CSV_FORMATS, defaultCsvFormat, entriesOnDay, entrySeconds, formatClock, formatHM, formatHours, isRunning, openSecondsOnDay, secondsOnDay,
  startOfDay, toCsv, totalsByProject, type CsvFormat,
} from "../tracking/clock";
import { addProject, readTarget, removeProject, type ClockData } from "../storage/persist";
import { getLocale, languageSelect, setLocale, type Locale } from "../i18n";
import { defaultProject, t } from "../messages";
import { cockpitState, formatTargetHours, hhmm, shiftFigures, type CockpitState, type ShiftFigures } from "../cockpit/model";

/**
 * The phone companion (QUS v1, the look of Rain Lens): exactly three tabs -
 * Jetzt (the shift at a glance, one button), Schichten (today's entries,
 * totals, export) and Einstellungen (daily target, projects, glasses,
 * language; with the three-step checklist on the first start).
 */

export interface PhoneUiPorts {
  /** Must already reflect a `setData` call by the time that call returns its promise. */
  readonly getData: () => ClockData;
  readonly setData: (data: ClockData) => Promise<void>;
  /** The one button of "Jetzt": starts the shift (project of the last entry) or stops it. */
  readonly toggleShift?: () => void;
  /** Language shown; defaults to the device language. */
  readonly locale?: () => Locale;
  /** Called after the user picked another language, so the glasses follow. */
  readonly onLocaleChange?: (locale: Locale) => void;
}

export interface PhoneUi {
  /** Redraws the whole page after a change made on the glasses. */
  readonly refresh: () => void;
  /** Redraws only the live parts (status pill, "Jetzt"), leaving every input untouched. */
  readonly refreshLive: () => void;
}

/** The three tabs, in one row. */
export const TABS: readonly { id: string; icon: string; key: string }[] = [
  { id: "now", icon: "⏱️", key: "p.tabNow" },
  { id: "shifts", icon: "📋", key: "p.tabShifts" },
  { id: "settings", icon: "⚙️", key: "p.tabSettings" },
];
const TAB_KEY = "quietglass.shift-clock.tab";

/** Nothing recorded, nothing running, no target: Einstellungen opens first, with the three-step checklist. */
export function isFirstRun(data: ClockData): boolean {
  return data.entries.length === 0 && !isRunning(data.open) && data.dailyTargetHours === null;
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

const esc = (text: string): string => escapeHtml(text);

// ---- pure view models (tests read these) ----------------------------------------------

export interface Pill { readonly text: string; readonly on: boolean }

/** The status pill beside the title. */
export function pillFor(state: CockpitState, locale: Locale): Pill {
  switch (state) {
    case "running":
    case "armed": return { text: t(locale, "p.pill.running"), on: true };
    case "pause": return { text: t(locale, "p.pill.pause"), on: false };
    case "done": return { text: t(locale, "p.pill.done"), on: false };
    case "idle": return { text: t(locale, "p.pill.idle"), on: false };
  }
}

export interface Banner { readonly tone: "ok" | "warn" | "none"; readonly text: string }

/** The one message that counts right now. */
export function bannerFor(data: ClockData, figures: ShiftFigures, state: CockpitState, locale: Locale): Banner {
  const x = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  const since = (time: number | null): string => (time === null ? "–" : hhmm(time));
  switch (state) {
    case "running":
    case "armed": return { tone: "ok", text: x("p.banner.running", { project: data.open.project ?? "", time: since(data.open.startedAt) }) };
    case "pause": return { tone: "warn", text: x("p.banner.pause", { time: since(figures.lastEnd) }) };
    case "done": return { tone: "ok", text: x("p.banner.done") };
    case "idle":
      if (data.projects.length === 0) return { tone: "none", text: x("p.banner.idleNone") };
      return { tone: "none", text: data.projects.length === 1 ? x("p.banner.idleOne", { project: data.projects[0] ?? "" }) : x("p.banner.idleMany") };
  }
}

export interface Hero { readonly label: string; readonly value: string; readonly side: string }

/** The hero card: one label, one big value, a dim side value. */
export function heroFor(data: ClockData, figures: ShiftFigures, state: CockpitState, locale: Locale): Hero {
  const x = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  const target = data.dailyTargetHours === null ? "" : x("p.hero.target", { target: formatTargetHours(data.dailyTargetHours, locale) });
  switch (state) {
    case "running":
    case "armed":
      if (figures.remaining === null) return { label: x("p.hero.running"), value: formatHM(figures.openSeconds), side: data.open.project ?? "" };
      return figures.remaining > 0
        ? { label: x("p.hero.left"), value: formatHM(figures.remaining), side: target }
        : { label: x("p.hero.over"), value: formatHM(-figures.remaining), side: target };
    case "pause": return { label: x("p.hero.pause"), value: formatHM(figures.sinceStop), side: figures.lastEnd === null ? "" : x("p.hero.since", { time: hhmm(figures.lastEnd) }) };
    case "done": return { label: x("p.hero.done"), value: formatHM(figures.worked), side: target };
    case "idle": return { label: x("p.hero.idle"), value: formatHM(0), side: target };
  }
}

export interface DayCard { readonly weekday: string; readonly date: string; readonly seconds: number; readonly today: boolean }

/** The last `count` days, oldest first, today last. */
export function lastDays(data: ClockData, now: number, locale: Locale, count = 7): DayCard[] {
  const tag = locale === "de" ? "de-AT" : "en-GB";
  const today = startOfDay(now);
  const cards: DayCard[] = [];
  for (let back = count - 1; back >= 0; back--) {
    const date = new Date(today);
    date.setDate(date.getDate() - back);
    const start = date.getTime();
    cards.push({
      weekday: date.toLocaleDateString(tag, { weekday: "short" }),
      date: date.toLocaleDateString(tag, { day: "2-digit", month: "2-digit" }),
      seconds: secondsOnDay(data.entries, start) + openSecondsOnDay(data.open, start, now),
      today: back === 0,
    });
  }
  return cards;
}

/** "Jetzt": banner, hero card with the 2 x 2 key figures and the one button, a card per day. */
export function nowInner(data: ClockData, now: number, locale: Locale): string {
  const x = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  const figures = shiftFigures(data.open, data.entries, now, data.dailyTargetHours);
  const state = cockpitState(figures, false);
  const banner = bannerFor(data, figures, state, locale);
  const hero = heroFor(data, figures, state, locale);
  const stat = (label: string, value: string, unit: string): string => `<div><span>${esc(label)}</span><b>${esc(value)}</b><small>${esc(unit)}</small></div>`;
  const days = lastDays(data, now, locale).map((day) =>
    `<div class="host day${day.today ? " today" : ""}"><b>${esc(day.weekday)}</b><em>${esc(formatHM(day.seconds))}</em><span>${esc(day.date)}</span></div>`);
  return `
    <p class="banner tone-${banner.tone}">${esc(banner.text)}</p>
    <section class="card hero-card">
      <div class="hero">
        <div><span>${esc(hero.label)}</span><strong>${esc(hero.value)}</strong></div>
        <p>${esc(hero.side)}</p>
      </div>
      <div class="stats">
        ${stat(x("p.stat.today"), formatHM(figures.worked), x("p.unit.hm"))}
        ${stat(x("p.stat.week"), formatHM(figures.week), x("p.unit.hm"))}
        ${stat(x("p.stat.start"), figures.firstStart === null ? "–" : hhmm(figures.firstStart), x("p.unit.clock"))}
        ${stat(x("p.stat.break"), figures.firstStart === null ? "–" : formatHM(figures.pause), x("p.unit.hm"))}
      </div>
      <button id="toggle" type="button" class="big">${esc(x(figures.running ? "p.btn.stop" : "p.btn.start"))}</button>
    </section>
    <h2 class="strip-title">${esc(x("p.days"))}</h2>
    <div class="strip">${days.join("")}</div>`;
}

/** First-run checklist: pure, so tests can read it. */
export function setupInner(data: ClockData, locale: Locale): string {
  const step = (n: number, done: boolean, key: string): string =>
    `<li class="${done ? "done" : ""}"><span class="num" aria-hidden="true">${done ? "✓" : n}</span><span>${esc(t(locale, key))}</span></li>`;
  const started = data.entries.length > 0 || isRunning(data.open);
  return `<ol class="steps">${step(1, data.projects.length > 0, "p.setup.1")}${step(2, data.dailyTargetHours !== null, "p.setup.2")}${step(3, started, "p.setup.3")}</ol>`;
}

type Commit = (next: ClockData, options?: { readonly keepDraft?: boolean; readonly notice?: string }) => void;

export function mountPhoneUi(ports: PhoneUiPorts): PhoneUi {
  const root = document.getElementById("app");
  if (!root) return { refresh: () => undefined, refreshLive: () => undefined };

  let notice = "";
  let locale: Locale = ports.locale?.() ?? getLocale();
  /** "Clear log" asks once before it deletes every entry. */
  let confirmClear = false;
  let tab = readTab(isFirstRun(ports.getData()));

  const wireToggle = (): void => {
    root.querySelector<HTMLButtonElement>("#toggle")?.addEventListener("click", () => { ports.toggleShift?.(); });
  };

  // Re-rendered after every change. Handlers always read the current data:
  // the glasses start and stop the clock while this page is open, and a change
  // computed from the data of the last render would reset the running clock
  // and drop the entries recorded since.
  const render = (keepDraft = true): void => {
    const draft = keepDraft ? root.querySelector<HTMLInputElement>("#project")?.value ?? "" : "";
    if (document.documentElement) document.documentElement.lang = locale;
    root.innerHTML = template(ports.getData(), notice, locale);
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
    const field = root.querySelector<HTMLInputElement>("#project");
    if (field && draft) field.value = draft;
    const notify = (message: string): void => { notice = message; render(); };
    const askClear = (): boolean => {
      if (confirmClear) { confirmClear = false; return true; }
      confirmClear = true;
      notify(t(locale, "p.clearConfirm"));
      return false;
    };
    wireToggle();
    wire(root, ports.getData, commit, notify, locale, askClear);
    root.querySelector<HTMLSelectElement>("#language")?.addEventListener("change", (event) => {
      const value = (event.target as HTMLSelectElement).value;
      if (value !== "de" && value !== "en") return;
      locale = value;
      setLocale(locale);
      ports.onLocaleChange?.(locale);
      render();
    });
  };

  const commit: Commit = (next, options = {}) => {
    const saving = ports.setData(next);
    notice = options.notice ?? "";
    confirmClear = false;
    render(options.keepDraft ?? true);
    saving.catch((error: unknown) => {
      console.warn("[shiftclock] save failed:", error);
      notice = t(locale, "p.saveFailed", { error: error instanceof Error ? error.message : String(error) });
      render();
    });
  };

  render();
  return {
    refresh: () => render(),
    refreshLive: () => {
      const data = ports.getData();
      const now = Date.now();
      const pill = root.querySelector<HTMLElement>("#pill");
      if (pill) {
        const state = pillFor(cockpitState(shiftFigures(data.open, data.entries, now, data.dailyTargetHours), false), locale);
        if (pill.textContent !== state.text) pill.textContent = state.text;
        pill.classList?.toggle("on", state.on);
      }
      const live = root.querySelector<HTMLElement>("#now-live");
      if (live) {
        const html = nowInner(data, now, locale);
        // Unchanged parts are not touched, so a minute tick never makes the page jump.
        if (live.innerHTML !== html) { live.innerHTML = html; wireToggle(); }
      }
    },
  };
}

/** The format the user picked, or the one that suits the app language. */
export function csvFormatOf(data: ClockData, locale: Locale): CsvFormat {
  return data.csvFormat ?? defaultCsvFormat(locale);
}

/** A target as typed: "7,5" in German, "7.5" in English. */
function hoursText(locale: Locale, hours: number): string {
  return locale === "de" ? String(hours).replace(".", ",") : String(hours);
}

/** Decimal hours as people read them: "1,50" in German, "1.50" in English. */
function hoursFor(locale: Locale, seconds: number): string {
  const hours = formatHours(seconds);
  return locale === "de" ? hours.replace(".", ",") : hours;
}

function template(data: ClockData, notice: string, locale: Locale): string {
  const L = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  const now = Date.now();
  const dayStart = startOfDay(now);
  const today = entriesOnDay(data.entries, dayStart);
  // Only today's part of a shift that ran past midnight counts towards today.
  const todaySeconds = secondsOnDay(data.entries, dayStart);
  const totals = totalsByProject(data.entries).slice(0, 8);
  const name = defaultProject(locale);
  const figures = shiftFigures(data.open, data.entries, now, data.dailyTargetHours);
  const pill = pillFor(cockpitState(figures, false), locale);
  const timeOf = (timestamp: number): string =>
    new Date(timestamp).toLocaleTimeString(locale === "de" ? "de-AT" : "en-GB", { hour: "2-digit", minute: "2-digit" });

  return `
  <header class="brand bar">
    <div>
      <span class="brand-mark">${esc(L("p.kicker"))}</span>
      <h1>ShiftClock</h1>
    </div>
    <span id="pill" class="chip${pill.on ? " on" : ""}">${esc(pill.text)}</span>
  </header>

  ${notice ? '<p class="notice">' + esc(notice) + "</p>" : ""}

  <div class="tab" data-tab="now">
    <div id="now-live">${nowInner(data, now, locale)}</div>
  </div>

  <div class="tab" data-tab="shifts">
    <section class="card">
      <h2>${L("p.today")}</h2>
      ${today.length === 0 ? `<p class="hint">${L("p.todayNone")}</p>` : `
        <p class="hint">${L(today.length === 1 ? "p.todayLineOne" : "p.todayLine", {
          clock: formatClock(todaySeconds), hours: hoursFor(locale, todaySeconds), n: today.length,
        })}</p>
        <table class="keys">
          ${today.map((e) => "<tr><td>" + esc(e.project) + "</td><td>" + timeOf(e.startedAt) +
              "</td><td>" + formatClock(entrySeconds(e)) + "</td></tr>").join("")}
        </table>`}
    </section>

    <section class="card">
      <h2>${L("p.allTime")}</h2>
      ${totals.length === 0 ? `<p class="hint">${L("p.nothing")}</p>` : `
        <table class="keys">
          ${totals.map((row) => "<tr><td>" + esc(row.project) + "</td><td>" +
              formatClock(row.seconds) + "</td><td>" + hoursFor(locale, row.seconds) + " h</td></tr>").join("")}
        </table>
        <label for="csv-format">${L("p.csvFormat")}</label>
        <select id="csv-format">${CSV_FORMATS.map((format) =>
          `<option value="${format}"${format === csvFormatOf(data, locale) ? " selected" : ""}>${L("p.csv." + format)}</option>`).join("")}</select>
        <button id="export" type="button" class="secondary">${L("p.export")}</button>
        <details><summary>${L("p.more")}</summary><p class="hint">${L("p.exportHint")}</p></details>
        <button id="clear" type="button" class="secondary danger">${L("p.clear")}</button>`}
    </section>
  </div>

  <div class="tab" data-tab="settings">
    ${isFirstRun(data) ? `<section class="card setup"><h2>${L("p.setup.title")}</h2>${setupInner(data, locale)}</section>` : ""}

    <section class="card">
      <h2>${L("p.set.target")}</h2>
      <label for="target">${L("p.target")}</label>
      <input id="target" type="text" inputmode="decimal" value="${data.dailyTargetHours === null ? "" : hoursText(locale, data.dailyTargetHours)}" />
      <p class="hint">${L("p.targetHint")}</p>
    </section>

    <section class="card">
      <h2>${L("p.projects")}</h2>
      ${data.projects.length === 0 ? `<button id="add-default" type="button">${L("p.addDefault", { name: esc(name) })}</button>` : ""}
      <label for="project">${L("p.addLabel")}</label>
      <input id="project" type="text" placeholder="${L("p.addPlaceholder")}" />
      <button id="add" type="button">${L("p.add")}</button>
      <ul class="scripts">
        ${data.projects.map((p) => `
          <li>
            <span>${esc(p)}</span>
            <button type="button" class="remove" data-project="${esc(p)}">${L("p.remove")}</button>
          </li>`).join("")}
      </ul>
      <p class="hint">${L("p.removeHint")}</p>
    </section>

    <section class="card">
      <h2>${L("p.glasses")}</h2>
      <label class="check"><input id="invert" type="checkbox" ${data.invertScroll ? "checked" : ""} /> ${L("p.invert")}</label>
      <p class="hint">${L("p.invertHint")}</p>
    </section>

    <section class="card">${languageSelect(locale)}</section>

    <section class="card compact">
      <details class="fold">
        <summary>${L("p.controls")}</summary>
        <table class="keys">
          <tr><td>${L("p.key.tap")}</td><td>${L("p.key.tapDo")}</td></tr>
          <tr><td>${L("p.key.swipe")}</td><td>${L("p.key.swipeDo")}</td></tr>
          <tr><td>${L("p.key.double")}</td><td>${L("p.key.doubleDo")}</td></tr>
        </table>
        <p class="hint">${L("p.controlsHint")}</p>
      </details>
    </section>

    <footer class="hint">${L("p.privacy")}</footer>
  </div>

  <nav class="tabbar" role="tablist">
    ${TABS.map(({ id, icon, key }) => `<button type="button" role="tab" data-tab-go="${id}"><span aria-hidden="true">${icon}</span>${L(key)}</button>`).join("")}
  </nav>`;
}

function wire(
  root: HTMLElement,
  current: () => ClockData,
  commit: Commit,
  notify: (message: string) => void,
  locale: Locale,
  askClear: () => boolean,
): void {
  const byId = <T extends HTMLElement>(id: string): T | null => root.querySelector<T>("#" + id);

  byId<HTMLButtonElement>("add")?.addEventListener("click", () => {
    const name = byId<HTMLInputElement>("project")?.value.trim() ?? "";
    if (!name) { notify(t(locale, "p.nameFirst")); return; }
    if (current().projects.includes(name)) { notify(t(locale, "p.duplicate", { name })); return; }
    commit(addProject(current(), name), { keepDraft: false });
  });

  byId<HTMLButtonElement>("add-default")?.addEventListener("click", () => {
    commit(addProject(current(), defaultProject(locale)));
  });

  root.querySelectorAll<HTMLButtonElement>(".remove").forEach((button) => {
    const project = button.dataset["project"];
    if (project === undefined) return;
    button.addEventListener("click", () => { commit(removeProject(current(), project)); });
  });

  byId<HTMLButtonElement>("export")?.addEventListener("click", () => {
    download("shiftclock.csv", toCsv(current().entries, locale, csvFormatOf(current(), locale)), "text/csv;charset=utf-8");
  });

  byId<HTMLSelectElement>("csv-format")?.addEventListener("change", (event) => {
    const value = (event.target as HTMLSelectElement).value;
    if (value === "excel-de" || value === "standard") commit({ ...current(), csvFormat: value });
  });

  byId<HTMLInputElement>("target")?.addEventListener("change", (event) => {
    commit({ ...current(), dailyTargetHours: readTarget((event.target as HTMLInputElement).value) });
  });

  byId<HTMLButtonElement>("clear")?.addEventListener("click", () => {
    if (askClear()) commit({ ...current(), entries: [] }, { notice: t(locale, "p.cleared") });
  });

  byId<HTMLInputElement>("invert")?.addEventListener("change", (event) => {
    commit({ ...current(), invertScroll: (event.target as HTMLInputElement).checked });
  });
}

/** Hands the file to the phone's own share sheet. Nothing is uploaded. */
function download(filename: string, content: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}
