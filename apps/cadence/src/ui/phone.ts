import { COMMON_SIGNATURES, MAX_BPM, MIN_BPM, type MetronomeSettings } from "../metronome/engine";
import {
  bestTempoByItem, durationSeconds, formatDuration, sessionsToday, toCsv, totalsByItem, totalSeconds, type PracticeSession,
} from "../practice/log";
import { addItem, removeItem, setSettings, type CadenceData } from "../storage/persist";
import { languageSelect, type Locale } from "../i18n";
import { t } from "../messages";
import { csvFormatFor } from "../csv";
import { minutesShort, signatureLabel } from "../cockpit/model";

/**
 * The phone companion (QUS v1, the look of Rain Lens): exactly three tabs -
 * Jetzt (the state at a glance), Verlauf (the practice log) and Einstellungen
 * (tempo, what you practise, glasses, language). The glasses keep three
 * controls, so everything else lives here. No server, no sensor: it works
 * as soon as it opens.
 */

/** What the beat does right now (the page follows it once a second). */
export interface PhoneLive {
  readonly running: boolean;
  readonly paused: boolean;
  readonly bar: number;
  readonly sessionSeconds: number;
}

export interface PhoneUiPorts {
  readonly getData: () => CadenceData;
  readonly setData: (data: CadenceData) => Promise<void>;
  /** Current language; English when the host does not say. */
  readonly getLocale?: () => Locale;
  /** Called when the user picks another language on this page. */
  readonly setLocale?: (locale: Locale) => void;
  /** The state of the beat. */
  readonly getLive?: () => PhoneLive;
  /** Starts or pauses the beat (the one primary button of "Jetzt"). */
  readonly toggle?: () => void;
}

export interface PhoneUi {
  /** Redraws the live parts (pill, "Jetzt") without touching any input. */
  readonly refreshLive: () => void;
}

export const TABS: readonly { id: string; icon: string; key: string }[] = [
  { id: "now", icon: "🥁", key: "p.tabNow" },
  { id: "log", icon: "📒", key: "p.tabLog" },
  { id: "settings", icon: "⚙️", key: "p.tabSettings" },
];
const TAB_KEY = "quietglass.cadence.tab";
const IDLE: PhoneLive = { running: false, paused: false, bar: 1, sessionSeconds: 0 };
/** How long the second tap on a dangerous button is waited for. */
const CONFIRM_MS = 4000;

/** Nothing set up yet: Einstellungen opens first, with the three-step checklist. */
export function isFirstRun(data: CadenceData): boolean {
  return data.items.length === 0 && data.sessions.length === 0;
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

const BPM_STEP = 4;
const esc = (text: string): string => escapeHtml(text);

// ---- pure view models (tests read these) ----------------------------------------------

export interface Banner { readonly tone: "ok" | "warn" | "none"; readonly text: string }

/** The one message that counts right now. */
export function bannerFor(live: PhoneLive, item: string, locale: Locale): Banner {
  if (live.running) {
    return { tone: "ok", text: t(locale, "p.bannerRunning", { bar: live.bar, item: item ? ` · ${item}` : "" }) };
  }
  if (live.paused) return { tone: "warn", text: t(locale, "p.bannerPaused") };
  return { tone: "none", text: t(locale, "p.bannerReady") };
}

export function pillOf(live: PhoneLive, locale: Locale): { text: string; on: boolean } {
  if (live.running) return { text: t(locale, "p.pillRunning"), on: true };
  return { text: t(locale, live.paused ? "p.pillPaused" : "p.pillReady"), on: false };
}

export interface DayTotal { readonly start: number; readonly seconds: number }

/** Practice seconds per calendar day for the last `days` days, oldest first. */
export function dayTotals(sessions: readonly PracticeSession[], now: number, days = 7): DayTotal[] {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  return Array.from({ length: days }, (_, index) => {
    const day = new Date(today);
    day.setDate(day.getDate() - (days - 1 - index));
    const start = day.getTime();
    const end = new Date(day);
    end.setDate(end.getDate() + 1);
    const seconds = sessions.filter((s) => s.startedAt >= start && s.startedAt < end.getTime()).reduce((sum, s) => sum + durationSeconds(s), 0);
    return { start, seconds };
  });
}

function dayName(start: number, locale: Locale): string {
  try { return new Date(start).toLocaleDateString(locale, { weekday: "short" }); } catch { return ""; }
}

const stat = (label: string, value: string, unit: string): string =>
  `<div><span>${esc(label)}</span><b>${esc(value)}</b><small>${esc(unit)}</small></div>`;

/** "Jetzt": banner, hero card (the tempo), 2 x 2 key figures, the one button, a strip of recent sessions. */
export function nowInner(data: CadenceData, live: PhoneLive, now: number, locale: Locale): string {
  const x = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  const today = sessionsToday(data.sessions, now);
  const best = bestTempoByItem(data.sessions).find((entry) => entry.item === data.activeItem)?.bpm;
  const banner = bannerFor(live, data.activeItem, locale);
  const recent = [...data.sessions].sort((a, b) => b.startedAt - a.startedAt).slice(0, 5);
  const cards = recent.map((s) =>
    `<div class="host tone-ok"><b>${esc(s.item || "–")}</b><em>${esc(formatDuration(durationSeconds(s), locale))}</em><span><i>${s.bpm}</i> bpm</span></div>`);
  return `
    <p class="banner tone-${banner.tone}">${esc(banner.text)}</p>
    <section class="card hero-card">
      <div class="hero">
        <div><span>${esc(x("p.heroLabel"))}</span><strong>${data.settings.bpm}</strong></div>
        <p>${esc(x("p.heroSide", { sig: signatureLabel(data.settings) }))}</p>
      </div>
      <div class="stats">
        ${stat(x("p.statToday"), minutesShort(totalSeconds(today)), x("p.unitToday"))}
        ${stat(x("p.statSessions"), String(today.length), x("p.unitSessions"))}
        ${stat(x("p.statBar"), live.running || live.paused ? String(live.bar) : "–", x("p.unitBar"))}
        ${stat(x("p.statBest"), best ? String(best) : "–", x("p.unitBest"))}
      </div>
      <button id="toggle" type="button" class="big">${esc(x(live.running ? "p.pause" : "p.start"))}</button>
    </section>
    <h2 class="strip-title">${esc(x("p.stripRecent"))}</h2>
    ${cards.length > 0 ? `<div class="strip">${cards.join("")}</div>` : `<p class="hint">${esc(x("p.stripNone"))}</p>`}`;
}

/** "Verlauf": totals, the last seven days as cards, per item, export and clear. */
export function logInner(data: CadenceData, now: number, locale: Locale): string {
  const x = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  const duration = (seconds: number): string => formatDuration(seconds, locale);
  const today = sessionsToday(data.sessions, now);
  const totals = totalsByItem(data.sessions);
  const best = bestTempoByItem(data.sessions);
  const days = dayTotals(data.sessions, now, 7);
  const csvFormat = csvFormatFor(data.csvFormat, locale);
  const top = totals[0];
  const topBest = best.reduce((max, entry) => Math.max(max, entry.bpm), 0);
  const cards = days.map((day, index) =>
    `<div class="host tone-${day.seconds > 0 ? "ok" : "offline"}"><b>${esc(index === days.length - 1 ? x("p.statToday") : dayName(day.start, locale))}</b><em>${esc(minutesShort(day.seconds))}</em></div>`);
  return `
    <section class="card hero-card">
      <div class="hero">
        <div><span>${esc(x("p.statToday").toUpperCase())}</span><strong>${esc(minutesShort(totalSeconds(today)))}</strong></div>
        <p>${esc(x("p.heroTotal", { total: duration(totalSeconds(data.sessions)) }))}</p>
      </div>
      <div class="stats">
        ${stat(x("p.statSessions"), String(today.length), x("p.unitSessions"))}
        ${stat(x("p.statAll"), String(data.sessions.length), "")}
        ${stat(x("p.statTop"), top ? top.item : "–", top ? duration(top.seconds) : "")}
        ${stat(x("p.statBest"), topBest > 0 ? String(topBest) : "–", x("p.unitBest"))}
      </div>
      ${data.sessions.length > 0 ? `<button id="export" type="button" class="big">${esc(x("p.export"))}</button>` : ""}
    </section>
    <h2 class="strip-title">${esc(x("p.stripDays"))}</h2>
    <div class="strip">${cards.join("")}</div>
    ${totals.length === 0 ? `<p class="hint">${esc(x("p.logEmpty"))}</p>` : `
    <section class="card">
      <h2>${esc(x("p.logTitle"))}</h2>
      <ul class="scripts">
        ${totals.slice(0, 8).map((row) => {
          const b = best.find((entry) => entry.item === row.item);
          return `<li><span><strong>${esc(row.item)}</strong><br /><small>${esc(duration(row.seconds))} · ${b ? esc(x("p.bpm", { bpm: b.bpm })) : "—"}</small></span></li>`;
        }).join("")}
      </ul>
      <label for="csv-format">${esc(x("p.csvFormat"))}</label>
      <select id="csv-format">
        <option value="excel-de" ${csvFormat === "excel-de" ? "selected" : ""}>${esc(x("p.csvExcel"))}</option>
        <option value="standard" ${csvFormat === "standard" ? "selected" : ""}>${esc(x("p.csvStandard"))}</option>
      </select>
      <details class="fold"><summary>${esc(x("p.details"))}</summary><p class="hint">${esc(x("p.csvHint"))}</p><p class="hint">${esc(x("p.logHint"))}</p></details>
      <button id="clear" type="button" class="remove">${esc(x("p.clear"))}</button>
    </section>`}`;
}

/** First-run checklist: pure, so tests can read it. */
export function setupInner(data: CadenceData, locale: Locale): string {
  const x = (key: string): string => t(locale, key);
  const step = (n: number, done: boolean, key: string): string =>
    `<li class="${done ? "done" : ""}"><span class="num" aria-hidden="true">${done ? "✓" : n}</span><span>${esc(x(key))}</span></li>`;
  return `<ol class="steps">${step(1, data.items.length > 0, "p.setup1")}${step(2, data.settings.bpm !== 100 || signatureLabel(data.settings) !== "4/4", "p.setup2")}${step(3, data.sessions.length > 0, "p.setup3")}</ol>`;
}

// ---- mounting ---------------------------------------------------------------------------

export function mountPhoneUi(ports: PhoneUiPorts): PhoneUi {
  const root = document.getElementById("app");
  if (!root) return { refreshLive: () => undefined };

  let tab = readTab(isFirstRun(ports.getData()));
  const live = (): PhoneLive => ports.getLive?.() ?? IDLE;
  const render = (): void => {
    const locale = ports.getLocale?.() ?? "en";
    if (document.documentElement) document.documentElement.lang = locale;
    const typed = root.querySelector<HTMLInputElement>("#item")?.value;
    root.innerHTML = template(ports.getData(), locale, live());
    const field = root.querySelector<HTMLInputElement>("#item");
    if (field && typed) field.value = typed;
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
  };

  render();
  return {
    refreshLive: () => {
      const locale = ports.getLocale?.() ?? "en";
      const state = live();
      const set = (selector: string, html: string): void => {
        const el = root.querySelector<HTMLElement>(selector);
        // Unchanged parts are not touched, so the page never jumps.
        if (el && el.innerHTML !== html) el.innerHTML = html;
      };
      const pill = root.querySelector<HTMLElement>("#pill");
      if (pill) {
        const p = pillOf(state, locale);
        if (pill.textContent !== p.text) pill.textContent = p.text;
        pill.classList?.toggle("on", p.on);
      }
      set("#now-live", nowInner(ports.getData(), state, Date.now(), locale));
    },
  };
}

function template(data: CadenceData, locale: Locale, state: PhoneLive): string {
  const s = data.settings;
  const x = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  const firstRun = isFirstRun(data);
  const pill = pillOf(state, locale);
  const now = Date.now();
  return `
  <header class="brand bar">
    <div>
      <div class="brand-mark">${esc(x("p.kicker"))}</div>
      <h1>Cadence</h1>
    </div>
    <span id="pill" class="chip${pill.on ? " on" : ""}">${esc(pill.text)}</span>
  </header>

  <div class="tab" data-tab="now" id="now"><div id="now-live">${nowInner(data, state, now, locale)}</div></div>

  <div class="tab" data-tab="log" id="log">${logInner(data, now, locale)}</div>

  <div class="tab" data-tab="settings">
    ${firstRun ? `<section class="card setup"><h2>${esc(x("p.setupTitle"))}</h2>${setupInner(data, locale)}</section>` : ""}
    <section class="card">
      <h2>${esc(x("p.tempoTitle"))}</h2>
      <label for="bpm">${x("p.speed", { value: `<output id="bpm-out">${s.bpm}</output>` })}</label>
      <input id="bpm" type="range" min="${MIN_BPM}" max="${MAX_BPM}" step="1" value="${s.bpm}" />
      <label for="sig">${esc(x("p.sig"))}</label>
      <select id="sig">
        ${COMMON_SIGNATURES.map((sig) => {
          const value = sig.beats + "/" + sig.unit;
          const selected = sig.beats === s.signature.beats && sig.unit === s.signature.unit;
          return '<option value="' + value + '"' + (selected ? " selected" : "") + ">" + value + "</option>";
        }).join("")}
      </select>
      <label for="mark">${esc(x("p.mark"))}</label>
      <select id="mark">
        <option value="beat" ${s.mark === "beat" ? "selected" : ""}>${esc(x("p.markBeat"))}</option>
        <option value="bar" ${s.mark === "bar" ? "selected" : ""}>${esc(x("p.markBar"))}</option>
      </select>
      <details class="fold"><summary>${esc(x("p.details"))}</summary><p class="hint">${esc(x("p.sigHint"))}</p><p class="hint">${esc(x("p.downbeatHint"))}</p><p class="hint">${esc(x("p.markHint"))}</p></details>
    </section>

    <section class="card">
      <h2>${esc(x("p.itemsTitle"))}</h2>
      <label for="item">${esc(x("p.addLabel"))}</label>
      <input id="item" type="text" placeholder="${esc(x("p.addPlaceholder"))}" />
      <button id="add" type="button" class="big">${esc(x("p.add"))}</button>
      ${data.items.length === 0 ? `<p class="hint">${esc(x("p.itemsEmpty"))}</p>` : ""}
      <ul class="scripts">
        ${data.items.map((item) => `
          <li>
            <label class="check">
              <input type="radio" name="active" value="${esc(item)}" ${item === data.activeItem ? "checked" : ""} />
              <span>${esc(item)}</span>
            </label>
            <button type="button" class="remove" data-item="${esc(item)}">${esc(x("p.remove"))}</button>
          </li>`).join("")}
      </ul>
    </section>

    <section class="card">
      <h2>${esc(x("p.glassesTitle"))}</h2>
      <label class="check"><input id="invert" type="checkbox" ${data.invertScroll ? "checked" : ""} /> <span>${esc(x("p.invert"))}</span></label>
      <p class="hint">${esc(x("p.invertHint"))}</p>
      <details class="fold">
        <summary>${esc(x("p.controlsTitle"))}</summary>
        <table class="keys">
          <tr><td>${esc(x("p.tap"))}</td><td>${esc(x("p.tapDo"))}</td></tr>
          <tr><td>${esc(x("p.swipe"))}</td><td>${esc(x("p.swipeDo", { step: BPM_STEP }))}</td></tr>
          <tr><td>${esc(x("p.hold"))}</td><td>${esc(x("p.holdDo"))}</td></tr>
          <tr><td>${esc(x("p.double"))}</td><td>${esc(x("p.doubleDo"))}</td></tr>
        </table>
      </details>
    </section>

    <section class="card compact">${languageSelect(locale)}</section>

    <details class="fold card">
      <summary>${esc(x("p.moreTitle"))}</summary>
      <p class="hint">${esc(x("p.privacy"))}</p>
    </details>
  </div>

  <nav class="tabbar" role="tablist">
    ${TABS.map(({ id, icon, key }) => `<button type="button" role="tab" data-tab-go="${id}"><span aria-hidden="true">${icon}</span>${esc(x(key))}</button>`).join("")}
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
  const locale = ports.getLocale?.() ?? "en";

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
    if (input) input.value = "";
    if (value.trim()) commit((data) => addItem(data, value));
  });

  // Dangerous buttons (remove an item, clear the log): the first tap asks, a second one within a few seconds does it.
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
  root.querySelectorAll<HTMLButtonElement>("button.remove[data-item]").forEach((button) => {
    const item = button.dataset["item"];
    if (item) armed(button, () => commit((data) => removeItem(data, item)));
  });
  const clear = byId<HTMLButtonElement>("clear");
  if (clear) armed(clear, () => commit((data) => ({ ...data, sessions: [] })));

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
    const data = ports.getData();
    const format = csvFormatFor(data.csvFormat, locale);
    // Plain ASCII names; the Excel variant says so, so the two cannot be mixed up.
    const name = format === "excel-de" ? "cadence-practice-excel.csv" : "cadence-practice.csv";
    download(name, toCsv(data.sessions, format, locale), "text/csv;charset=utf-8");
  });

  // One listener for the whole "Jetzt" tab: its content is redrawn once a second.
  byId("now")?.addEventListener("click", (event) => {
    const target = (event as Event).target as HTMLElement | null;
    if (target?.closest?.("#toggle")) ports.toggle?.();
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
