import {
  CSV_FORMATS, defaultCsvFormat, entriesOnDay, entrySeconds, formatClock, formatHours, secondsOnDay, startOfDay, toCsv,
  totalsByProject, type CsvFormat,
} from "../tracking/clock";
import { addProject, readTarget, removeProject, type ClockData } from "../storage/persist";
import { getLocale, languageSelect, setLocale, type Locale } from "../i18n";
import { defaultProject, t } from "../messages";

/**
 * The phone companion: projects, the log and export. The glasses keep three
 * gestures, so everything else lives here.
 */

export interface PhoneUiPorts {
  /** Must already reflect a `setData` call by the time that call returns its promise. */
  readonly getData: () => ClockData;
  readonly setData: (data: ClockData) => Promise<void>;
  /** Language shown; defaults to the device language. */
  readonly locale?: () => Locale;
  /** Called after the user picked another language, so the glasses follow. */
  readonly onLocaleChange?: (locale: Locale) => void;
}

export interface PhoneUi {
  /** Redraws the page after a change made on the glasses. */
  readonly refresh: () => void;
}

/** The page is split into tabs instead of one long column (Alfred, 13.10.2026). */
const TABS: readonly { id: string; icon: string; key: string }[] = [
  { id: "today", icon: "⏱️", key: "p.tabToday" },
  { id: "projects", icon: "📁", key: "p.tabProjects" },
  { id: "glasses", icon: "👓", key: "p.tabGlasses" },
  { id: "more", icon: "⚙️", key: "p.tabMore" },
];
const TAB_KEY = "quietglass.shift-clock.tab";

function readTab(): string {
  try { const v = localStorage.getItem(TAB_KEY); return TABS.some((tab) => tab.id === v) ? v! : "today"; } catch { return "today"; }
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
      const next = button.dataset["tabGo"] ?? "today";
      change(next);
      try { localStorage.setItem(TAB_KEY, next); } catch { /* private mode */ }
      applyTab(root, next);
      window.scrollTo({ top: 0 });
    });
  });
}

type Commit = (next: ClockData, options?: { readonly keepDraft?: boolean; readonly notice?: string }) => void;

export function mountPhoneUi(ports: PhoneUiPorts): PhoneUi {
  const root = document.getElementById("app");
  if (!root) return { refresh: () => undefined };

  let notice = "";
  let locale: Locale = ports.locale?.() ?? getLocale();
  /** "Clear log" asks once before it deletes every entry. */
  let confirmClear = false;
  let tab = readTab();

  // Re-rendered after every change. Handlers always read the current data:
  // the glasses start and stop the clock while this page is open, and a change
  // computed from the data of the last render would reset the running clock
  // and drop the entries recorded since.
  const render = (keepDraft = true): void => {
    const draft = keepDraft ? root.querySelector<HTMLInputElement>("#project")?.value ?? "" : "";
    root.innerHTML = template(ports.getData(), notice, locale);
    notice = "";
    bindTabs(root, tab, (next) => { tab = next; });
    const field = root.querySelector<HTMLInputElement>("#project");
    if (field && draft) field.value = draft;
    const notify = (message: string): void => { notice = message; render(); };
    const askClear = (): boolean => {
      if (confirmClear) { confirmClear = false; return true; }
      confirmClear = true;
      notify(t(locale, "p.clearConfirm"));
      return false;
    };
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
  return { refresh: () => render() };
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
  const running = data.open.project !== null;
  const name = defaultProject(locale);
  const timeOf = (timestamp: number): string =>
    new Date(timestamp).toLocaleTimeString(locale === "de" ? "de-AT" : "en-GB", { hour: "2-digit", minute: "2-digit" });

  let next: string;
  if (running) next = L("p.running", { project: escapeHtml(data.open.project ?? "") });
  else if (data.projects.length === 1) next = L("p.nextOne", { project: escapeHtml(data.projects[0] ?? "") });
  else if (data.projects.length > 1) next = L("p.nextMany");
  else next = L("p.nextNone", { name: escapeHtml(name) });

  return `
  <header class="brand bar">
    <div>
      <span class="brand-mark">Quietglass</span>
      <h1>ShiftClock</h1>
    </div>
    <span class="chip${running ? " on" : ""}">${escapeHtml(running ? data.open.project ?? "" : L("p.chipIdle"))}</span>
  </header>

  ${notice ? '<p class="notice">' + escapeHtml(notice) + "</p>" : ""}

  <div class="tab" data-tab="today">
  <section class="card">
    <h2>${L("p.start")}</h2>
    <p class="hint">${L("p.lede")}</p>
    <p>${next}</p>
    ${data.projects.length === 0 ? `<button id="add-default" type="button">${L("p.addDefault", { name: escapeHtml(name) })}</button>` : ""}
  </section>

  <section class="card">
    <h2>${L("p.today")}</h2>
    <p class="hint">${L(today.length === 1 ? "p.todayLineOne" : "p.todayLine", {
      clock: formatClock(todaySeconds), hours: hoursFor(locale, todaySeconds), n: today.length,
    })}</p>
    ${today.length === 0 ? "" : `
      <table class="keys">
        ${today.map((e) => "<tr><td>" + escapeHtml(e.project) + "</td><td>" + timeOf(e.startedAt) +
            "</td><td>" + formatClock(entrySeconds(e)) + "</td></tr>").join("")}
      </table>`}
    <label for="target">${L("p.target")}</label>
    <input id="target" type="text" inputmode="decimal" value="${data.dailyTargetHours === null ? "" : hoursText(locale, data.dailyTargetHours)}" />
    <p class="hint">${L("p.targetHint")}</p>
  </section>

  </div>

  <div class="tab" data-tab="projects">
  <section class="card">
    <h2>${L("p.projects")}</h2>
    <label for="project">${L("p.addLabel")}</label>
    <input id="project" type="text" placeholder="${L("p.addPlaceholder")}" />
    <button id="add" type="button">${L("p.add")}</button>
    <ul class="scripts">
      ${data.projects.map((p) => `
        <li>
          <span>${escapeHtml(p)}</span>
          <button type="button" class="remove" data-project="${escapeHtml(p)}">${L("p.remove")}</button>
        </li>`).join("")}
    </ul>
    <p class="hint">${L("p.removeHint")}</p>
  </section>

  <section class="card">
    <h2>${L("p.allTime")}</h2>
    ${totals.length === 0 ? `<p class="hint">${L("p.nothing")}</p>` : `
      <table class="keys">
        ${totals.map((row) => "<tr><td>" + escapeHtml(row.project) + "</td><td>" +
            formatClock(row.seconds) + "</td><td>" + hoursFor(locale, row.seconds) + " h</td></tr>").join("")}
      </table>
      <label for="csv-format">${L("p.csvFormat")}</label>
      <select id="csv-format">${CSV_FORMATS.map((format) =>
        `<option value="${format}"${format === csvFormatOf(data, locale) ? " selected" : ""}>${L("p.csv." + format)}</option>`).join("")}</select>
      <button id="export" type="button" class="secondary">${L("p.export")}</button>
      <p class="hint">${L("p.exportHint")}</p>
      <button id="clear" type="button" class="secondary">${L("p.clear")}</button>`}
  </section>
  </div>

  <div class="tab" data-tab="glasses">
  <section class="card">
    <h2>${L("p.glasses")}</h2>
    <label class="check"><input id="invert" type="checkbox" ${data.invertScroll ? "checked" : ""} /> ${L("p.invert")}</label>
    <p class="hint">${L("p.invertHint")}</p>
  </section>
  </div>

  <div class="tab" data-tab="more">
  <section class="card">
    <h2>${L("p.controls")}</h2>
    <table class="keys">
      <tr><td>${L("p.key.tap")}</td><td>${L("p.key.tapDo")}</td></tr>
      <tr><td>${L("p.key.swipe")}</td><td>${L("p.key.swipeDo")}</td></tr>
      <tr><td>${L("p.key.hold")}</td><td>${L("p.key.holdDo")}</td></tr>
      <tr><td>${L("p.key.double")}</td><td>${L("p.key.doubleDo")}</td></tr>
    </table>
    <p class="hint">${L("p.controlsHint")}</p>
  </section>

  <section class="card">${languageSelect(locale)}</section>

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
    button.addEventListener("click", () => {
      const project = button.dataset["project"];
      if (project) commit(removeProject(current(), project));
    });
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
