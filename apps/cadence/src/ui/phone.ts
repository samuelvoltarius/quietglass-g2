import { COMMON_SIGNATURES, MAX_BPM, MIN_BPM, type MetronomeSettings } from "../metronome/engine";
import {
  bestTempoByItem, formatDuration, sessionsToday, toCsv, totalsByItem, totalSeconds,
} from "../practice/log";
import { addItem, removeItem, setSettings, type CadenceData } from "../storage/persist";
import { languageSelect, type Locale } from "../i18n";
import { t } from "../messages";
import { csvFormatFor } from "../csv";

/**
 * The phone companion: tempo, time signature, the user's practice items and
 * the log. The glasses keep three controls, so everything else lives here.
 */

export interface PhoneUiPorts {
  readonly getData: () => CadenceData;
  readonly setData: (data: CadenceData) => Promise<void>;
  /** Current language; English when the host does not say. */
  readonly getLocale?: () => Locale;
  /** Called when the user picks another language on this page. */
  readonly setLocale?: (locale: Locale) => void;
}

/** The page is split into tabs instead of one long column (Alfred, 13.10.2026). */
const TABS: readonly { id: string; icon: string; key: string }[] = [
  { id: "main", icon: "🥁", key: "p.tabMain" },
  { id: "practice", icon: "📒", key: "p.tabPractice" },
  { id: "glasses", icon: "👓", key: "p.tabGlasses" },
  { id: "more", icon: "⚙️", key: "p.tabMore" },
];
const TAB_KEY = "quietglass.cadence.tab";

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

/** Tempo step for a swipe on the glasses; shown in the controls table. */
const BPM_STEP = 4;

export function mountPhoneUi(ports: PhoneUiPorts): void {
  const root = document.getElementById("app");
  if (!root) return;

  let tab = readTab();
  const render = (): void => {
    const locale = ports.getLocale?.() ?? "en";
    if (document.documentElement) document.documentElement.lang = locale;
    root.innerHTML = template(ports.getData(), locale);
    bindTabs(root, tab, (next) => { tab = next; });
    wire(root, ports, render);
  };

  render();
}

function template(data: CadenceData, locale: Locale): string {
  const s = data.settings;
  const x = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  const duration = (seconds: number): string => formatDuration(seconds, locale);
  const today = sessionsToday(data.sessions, Date.now());
  const totals = totalsByItem(data.sessions).slice(0, 6);
  const best = bestTempoByItem(data.sessions).slice(0, 6);
  const csvFormat = csvFormatFor(data.csvFormat, locale);
  const next = data.activeItem
    ? x("p.nextReady", { item: escapeHtml(data.activeItem) })
    : x("p.nextFirst") + (data.items.length === 0 ? "</p><p class=\"hint\">" + x("p.nextItem") : "");

  return `
  <header class="brand bar">
    <div>
      <span class="brand-mark">Quietglass</span>
      <h1>Cadence</h1>
    </div>
    <span class="chip on">${x("p.chipTempo", { bpm: s.bpm, sig: s.signature.beats + "/" + s.signature.unit })}</span>
  </header>

  <div class="tab" data-tab="main">
  <section class="card next">
    <p>${next}</p>
  </section>

  <section class="card">
    <h2>${x("p.tempoTitle")}</h2>
    <label for="bpm">${x("p.speed", { value: `<output id="bpm-out">${s.bpm}</output>` })}</label>
    <input id="bpm" type="range" min="${MIN_BPM}" max="${MAX_BPM}" step="1" value="${s.bpm}" />

    <label for="sig">${x("p.sig")}</label>
    <select id="sig">
      ${COMMON_SIGNATURES.map((sig) => {
        const value = sig.beats + "/" + sig.unit;
        const selected = sig.beats === s.signature.beats && sig.unit === s.signature.unit;
        return '<option value="' + value + '"' + (selected ? " selected" : "") + ">" + value + "</option>";
      }).join("")}
    </select>
    <p class="hint">${x("p.sigHint")}</p>

    <label for="mark">${x("p.mark")}</label>
    <select id="mark">
      <option value="beat" ${s.mark === "beat" ? "selected" : ""}>${x("p.markBeat")}</option>
      <option value="bar" ${s.mark === "bar" ? "selected" : ""}>${x("p.markBar")}</option>
    </select>
    <p class="hint">${x("p.downbeatHint")}</p>
    <details>
      <summary>${x("p.details")}</summary>
      <p class="hint">${x("p.markHint")}</p>
    </details>
  </section>
  </div>

  <div class="tab" data-tab="practice">
  <section class="card">
    <h2>${x("p.itemsTitle")}</h2>
    <label for="item">${x("p.addLabel")}</label>
    <input id="item" type="text" placeholder="${x("p.addPlaceholder")}" />
    <button id="add" type="button">${x("p.add")}</button>
    ${data.items.length === 0 ? `<p class="hint">${x("p.itemsEmpty")}</p>` : ""}
    <ul class="scripts">
      ${data.items.map((item) => `
        <li>
          <label>
            <input type="radio" name="active" value="${escapeHtml(item)}"
              ${item === data.activeItem ? "checked" : ""} />
            <span>${escapeHtml(item)}</span>
          </label>
          <button type="button" class="remove" data-item="${escapeHtml(item)}">${x("p.remove")}</button>
        </li>`).join("")}
    </ul>
  </section>

  <section class="card">
    <h2>${x("p.logTitle")}</h2>
    <p class="hint">
      ${x(today.length === 1 ? "p.todayOne" : "p.today", { time: duration(totalSeconds(today)), count: today.length, total: duration(totalSeconds(data.sessions)) })}
    </p>
    ${totals.length === 0 ? `<p class="hint">${x("p.logEmpty")}</p>` : `
      <table class="keys">
        <tr><td><strong>${x("p.colItem")}</strong></td><td><strong>${x("p.colTime")}</strong></td><td><strong>${x("p.colBest")}</strong></td></tr>
        ${totals.map((row) => {
          const top = best.find((b) => b.item === row.item);
          return "<tr><td>" + escapeHtml(row.item) + "</td><td>" + duration(row.seconds) +
                 "</td><td>" + (top ? x("p.bpm", { bpm: top.bpm }) : "—") + "</td></tr>";
        }).join("")}
      </table>
      <label for="csv-format">${x("p.csvFormat")}</label>
      <select id="csv-format">
        <option value="excel-de" ${csvFormat === "excel-de" ? "selected" : ""}>${x("p.csvExcel")}</option>
        <option value="standard" ${csvFormat === "standard" ? "selected" : ""}>${x("p.csvStandard")}</option>
      </select>
      <p class="hint">${x("p.csvHint")}</p>
      <button id="export" type="button" class="secondary">${x("p.export")}</button>
      <button id="clear" type="button" class="secondary">${x("p.clear")}</button>
    `}
    <p class="hint">${x("p.logHint")}</p>
  </section>
  </div>

  <div class="tab" data-tab="glasses">
  <section class="card">
    <h2>${x("p.glassesTitle")}</h2>
    <label class="check"><input id="invert" type="checkbox" ${data.invertScroll ? "checked" : ""} /> <span>${x("p.invert")}</span></label>
    <p class="hint">${x("p.invertHint")}</p>
  </section>

  <section class="card">
    <h2>${x("p.controlsTitle")}</h2>
    <table class="keys">
      <tr><td>${x("p.tap")}</td><td>${x("p.tapDo")}</td></tr>
      <tr><td>${x("p.swipe")}</td><td>${x("p.swipeDo", { step: BPM_STEP })}</td></tr>
      <tr><td>${x("p.hold")}</td><td>${x("p.holdDo")}</td></tr>
      <tr><td>${x("p.double")}</td><td>${x("p.doubleDo")}</td></tr>
    </table>
  </section>
  </div>

  <div class="tab" data-tab="more">
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
  // drawn: the glasses change the tempo and log sessions in the meantime, and a
  // stale copy would silently undo them. Re-render so new items and the log show.
  const commit = (change: (data: CadenceData) => CadenceData): void => {
    void ports.setData(change(ports.getData())).then(rerender);
  };
  const patch = (change: Partial<MetronomeSettings>): void => commit((data) => setSettings(data, change));

  byId<HTMLSelectElement>("language")?.addEventListener("change", (event) => {
    const value = (event.target as HTMLSelectElement).value;
    ports.setLocale?.(value === "de" ? "de" : "en");
    rerender();
  });

  const bpm = byId<HTMLInputElement>("bpm");
  const bpmOut = byId("bpm-out");
  bpm?.addEventListener("input", () => { if (bpmOut) bpmOut.textContent = bpm.value; });
  bpm?.addEventListener("change", () => patch({ bpm: Number(bpm.value) }));

  byId<HTMLInputElement>("invert")?.addEventListener("change", (event) => {
    const checked = (event.target as HTMLInputElement).checked;
    commit((data) => ({ ...data, invertScroll: checked }));
  });

  byId<HTMLSelectElement>("sig")?.addEventListener("change", (event) => {
    const [beats, unit] = (event.target as HTMLSelectElement).value.split("/").map(Number);
    if (beats && unit) patch({ signature: { beats, unit } });
  });

  byId<HTMLSelectElement>("mark")?.addEventListener("change", (event) => {
    const value = (event.target as HTMLSelectElement).value;
    patch({ mark: value === "bar" ? "bar" : "beat" });
  });

  byId<HTMLButtonElement>("add")?.addEventListener("click", () => {
    const input = byId<HTMLInputElement>("item");
    const value = input?.value ?? "";
    if (value.trim()) commit((data) => addItem(data, value));
  });

  root.querySelectorAll<HTMLButtonElement>(".remove").forEach((button) => {
    button.addEventListener("click", () => {
      const item = button.dataset["item"];
      if (item) commit((data) => removeItem(data, item));
    });
  });

  root.querySelectorAll<HTMLInputElement>('input[name="active"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      if (radio.checked) commit((data) => ({ ...data, activeItem: radio.value }));
    });
  });

  byId<HTMLSelectElement>("csv-format")?.addEventListener("change", (event) => {
    const value = (event.target as HTMLSelectElement).value;
    commit((data) => ({ ...data, csvFormat: value === "excel-de" ? "excel-de" : "standard" }));
  });

  byId<HTMLButtonElement>("export")?.addEventListener("click", () => {
    const locale = ports.getLocale?.() ?? "en";
    const data = ports.getData();
    const format = csvFormatFor(data.csvFormat, locale);
    // Plain ASCII names; the Excel variant says so, so the two cannot be mixed up.
    const name = format === "excel-de" ? "cadence-practice-excel.csv" : "cadence-practice.csv";
    download(name, toCsv(data.sessions, format, locale), "text/csv;charset=utf-8");
  });

  byId<HTMLButtonElement>("clear")?.addEventListener("click", () => {
    commit((data) => ({ ...data, sessions: [] }));
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
