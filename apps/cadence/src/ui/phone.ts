import { COMMON_SIGNATURES, MAX_BPM, MIN_BPM, type MetronomeSettings } from "../metronome/engine";
import {
  bestTempoByItem, formatDuration, sessionsToday, toCsv, totalsByItem, totalSeconds,
} from "../practice/log";
import { addItem, removeItem, setSettings, type CadenceData } from "../storage/persist";
import { languageSelect, type Locale } from "../i18n";
import { t } from "../messages";

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

/** Tempo step for a swipe on the glasses; shown in the controls table. */
const BPM_STEP = 4;

export function mountPhoneUi(ports: PhoneUiPorts): void {
  const root = document.getElementById("app");
  if (!root) return;

  const render = (): void => {
    const locale = ports.getLocale?.() ?? "en";
    if (document.documentElement) document.documentElement.lang = locale;
    root.innerHTML = template(ports.getData(), locale);
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
  const next = data.activeItem
    ? x("p.nextReady", { item: escapeHtml(data.activeItem) })
    : x("p.nextFirst") + (data.items.length === 0 ? "</p><p class=\"hint\">" + x("p.nextItem") : "");

  return `
  <header class="brand">
    <span class="brand-mark">Quietglass</span>
    <h1>Cadence</h1>
  </header>

  <section class="card next">
    <p>${next}</p>
  </section>

  <section class="card compact">${languageSelect(locale)}</section>

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
      <button id="export" type="button" class="secondary">${x("p.export")}</button>
      <button id="clear" type="button" class="secondary">${x("p.clear")}</button>
    `}
    <p class="hint">${x("p.logHint")}</p>
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

  <footer class="hint">${x("p.privacy")}</footer>`;
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

  byId<HTMLButtonElement>("export")?.addEventListener("click", () => {
    download("cadence-practice.csv", toCsv(ports.getData().sessions), "text/csv");
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
