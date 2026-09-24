import { COMMON_SIGNATURES, MAX_BPM, MIN_BPM, type MetronomeSettings } from "../metronome/engine";
import {
  bestTempoByItem, formatDuration, sessionsToday, toCsv, totalsByItem, totalSeconds,
} from "../practice/log";
import { addItem, removeItem, setSettings, type CadenceData } from "../storage/persist";

/**
 * The phone companion: tempo, time signature, the user's practice items and
 * the log. The glasses keep three controls, so everything else lives here.
 */

export interface PhoneUiPorts {
  readonly getData: () => CadenceData;
  readonly setData: (data: CadenceData) => Promise<void>;
}

export function mountPhoneUi(ports: PhoneUiPorts): void {
  const root = document.getElementById("app");
  if (!root) return;

  const render = (): void => {
    const data = ports.getData();
    root.innerHTML = template(data);
    wire(root, ports, data);
  };

  render();
}

function template(data: CadenceData): string {
  const s = data.settings;
  const today = sessionsToday(data.sessions, Date.now());
  const totals = totalsByItem(data.sessions).slice(0, 6);
  const best = bestTempoByItem(data.sessions).slice(0, 6);

  return `
  <header class="brand">
    <span class="brand-mark">Aigner Labs</span>
    <h1>Cadence</h1>
  </header>

  <section class="card">
    <h2>Tempo</h2>
    <label for="bpm">Speed — <output id="bpm-out">${s.bpm}</output> bpm</label>
    <input id="bpm" type="range" min="${MIN_BPM}" max="${MAX_BPM}" step="1" value="${s.bpm}" />

    <label for="sig">Time signature</label>
    <select id="sig">
      ${COMMON_SIGNATURES.map((sig) => {
        const value = sig.beats + "/" + sig.unit;
        const selected = sig.beats === s.signature.beats && sig.unit === s.signature.unit;
        return '<option value="' + value + '"' + (selected ? " selected" : "") + ">" + value + "</option>";
      }).join("")}
    </select>

    <label for="mark">Marker</label>
    <select id="mark">
      <option value="beat" ${s.mark === "beat" ? "selected" : ""}>Every beat</option>
      <option value="bar" ${s.mark === "bar" ? "selected" : ""}>Downbeat only</option>
    </select>
    <p class="hint">
      Each display update travels over Bluetooth, and the timing jitter is not
      something an app can control. At fast tempos <strong>downbeat only</strong>
      stays readable where every beat starts to blur.
    </p>
  </section>

  <section class="card">
    <h2>What you practise</h2>
    <label for="item">Add an item</label>
    <input id="item" type="text" placeholder="Scales, bar 34, Study No. 2 …" />
    <button id="add" type="button">Add</button>
    ${data.items.length === 0 ? '<p class="hint">Add something to start logging practice time.</p>' : ""}
    <ul class="scripts">
      ${data.items.map((item) => `
        <li>
          <label>
            <input type="radio" name="active" value="${escapeHtml(item)}"
              ${item === data.activeItem ? "checked" : ""} />
            <span>${escapeHtml(item)}</span>
          </label>
          <button type="button" class="remove" data-item="${escapeHtml(item)}">Remove</button>
        </li>`).join("")}
    </ul>
  </section>

  <section class="card">
    <h2>Practice log</h2>
    <p class="hint">
      Today: <strong>${formatDuration(totalSeconds(today))}</strong> across ${today.length}
      session${today.length === 1 ? "" : "s"}.
      All time: <strong>${formatDuration(totalSeconds(data.sessions))}</strong>.
    </p>
    ${totals.length === 0 ? '<p class="hint">Nothing logged yet.</p>' : `
      <table class="keys">
        <tr><td><strong>Item</strong></td><td><strong>Time</strong></td><td><strong>Best</strong></td></tr>
        ${totals.map((row) => {
          const top = best.find((b) => b.item === row.item);
          return "<tr><td>" + escapeHtml(row.item) + "</td><td>" + formatDuration(row.seconds) +
                 "</td><td>" + (top ? top.bpm + " bpm" : "—") + "</td></tr>";
        }).join("")}
      </table>
      <button id="export" type="button" class="secondary">Export CSV</button>
      <button id="clear" type="button" class="secondary">Clear log</button>
    `}
    <p class="hint">Sessions shorter than 10 seconds are not recorded, and a best tempo needs at least 30 seconds at that speed.</p>
  </section>

  <section class="card">
    <h2>Controls on the glasses</h2>
    <table class="keys">
      <tr><td>Tap</td><td>Start / pause — also starts and ends the practice session</td></tr>
      <tr><td>Swipe</td><td>Tempo ±${4} bpm</td></tr>
      <tr><td>Hold</td><td>Reset the bar count</td></tr>
      <tr><td>Double tap</td><td>Leave Cadence</td></tr>
    </table>
  </section>

  <footer class="hint">
    Cadence makes no sound — the G2 has no speaker. It shows the beat instead,
    and keeps everything on this phone.
  </footer>`;
}

function wire(root: HTMLElement, ports: PhoneUiPorts, data: CadenceData): void {
  const byId = <T extends HTMLElement>(id: string): T | null => root.querySelector<T>("#" + id);
  const commit = (next: CadenceData): void => { void ports.setData(next); };
  const patch = (change: Partial<MetronomeSettings>): void => commit(setSettings(data, change));

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
    if (input?.value.trim()) commit(addItem(data, input.value));
  });

  root.querySelectorAll<HTMLButtonElement>(".remove").forEach((button) => {
    button.addEventListener("click", () => {
      const item = button.dataset["item"];
      if (item) commit(removeItem(data, item));
    });
  });

  root.querySelectorAll<HTMLInputElement>('input[name="active"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      if (radio.checked) commit({ ...data, activeItem: radio.value });
    });
  });

  byId<HTMLButtonElement>("export")?.addEventListener("click", () => {
    download("cadence-practice.csv", toCsv(data.sessions), "text/csv");
  });

  byId<HTMLButtonElement>("clear")?.addEventListener("click", () => {
    commit({ ...data, sessions: [] });
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
