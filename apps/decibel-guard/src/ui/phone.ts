import { isCalibrated, setDose, type NoiseData } from "../storage/persist";
import type { DoseSettings } from "../noise/dose";

/**
 * The phone companion: dose rules and calibration.
 *
 * Calibration is the important part. Without it the app can only report a
 * relative level, and the UI says so plainly rather than presenting a number
 * that looks authoritative.
 */

export interface PhoneUiPorts {
  readonly getData: () => NoiseData;
  readonly setData: (data: NoiseData) => Promise<void>;
  /** Live reading, for the calibration helper. */
  readonly getLevel: () => { dbfs: number | null; listening: boolean };
}

export function mountPhoneUi(ports: PhoneUiPorts): void {
  const root = document.getElementById("app");
  if (!root) return;

  const render = (): void => {
    const data = ports.getData();
    root.innerHTML = template(data);
    wire(root, ports, data, render);
  };

  render();
  // The calibration readout is live while the mic is open.
  setInterval(() => {
    const readout = root.querySelector("#live");
    const { dbfs, listening } = ports.getLevel();
    if (readout) {
      readout.textContent = listening && dbfs !== null
        ? dbfs.toFixed(1) + " dBFS"
        : "not listening";
    }
  }, 500);
}

function template(data: NoiseData): string {
  const d = data.dose;
  return `
  <header class="brand">
    <span class="brand-mark">Quietglass</span>
    <h1>DecibelGuard</h1>
  </header>

  <section class="card">
    <h2>What this is</h2>
    <p class="hint">
      DecibelGuard measures how much noise you are exposed to over time, so it
      can tell you when the day's dose is used up rather than only that it is
      loud right now.
    </p>
    <p class="hint">
      <strong>It is an indicator, not a sound level meter.</strong> The G2
      microphone has no published sensitivity, so absolute levels depend on the
      calibration you enter below, and no frequency weighting is applied. Do not
      use it for compliance, legal evidence or workplace assessment.
    </p>
  </section>

  <section class="card">
    <h2>Calibration</h2>
    <p class="hint">
      Status: <strong>${isCalibrated(data) ? "calibrated" : "not calibrated"}</strong>.
      ${isCalibrated(data) ? "" : "Readings are shown as <em>uncal.</em> on the glasses."}
    </p>
    <ol class="hint">
      <li>Start measuring on the glasses (tap the temple pad).</li>
      <li>Put a reference meter next to the glasses in a steady sound.</li>
      <li>Read the live value here and the reference meter's value.</li>
      <li>Enter the difference below: reference minus live.</li>
    </ol>
    <p class="hint">Live: <strong id="live">not listening</strong></p>

    <label for="offset">Calibration offset — <output id="offset-out">${data.calibrationOffset}</output> dB</label>
    <input id="offset" type="range" min="0" max="160" step="1" value="${data.calibrationOffset}" />
    <p class="hint">0 means uncalibrated. A typical value lands between 90 and 130.</p>
  </section>

  <section class="card">
    <h2>Dose rules</h2>

    <label for="criterion">Criterion level — <output id="criterion-out">${d.criterionDb}</output> dB</label>
    <input id="criterion" type="range" min="70" max="100" step="1" value="${d.criterionDb}" />

    <label for="hours">Reference duration — <output id="hours-out">${d.criterionHours}</output> h</label>
    <input id="hours" type="range" min="1" max="16" step="1" value="${d.criterionHours}" />

    <label for="exchange">Exchange rate</label>
    <select id="exchange">
      <option value="3" ${d.exchangeRateDb === 3 ? "selected" : ""}>3 dB — equal energy (EU)</option>
      <option value="5" ${d.exchangeRateDb === 5 ? "selected" : ""}>5 dB — OSHA</option>
    </select>
    <p class="hint">How much the permitted time halves for each step in level.</p>

    <label for="threshold">Ignore below — <output id="threshold-out">${d.thresholdDb}</output> dB</label>
    <input id="threshold" type="range" min="40" max="90" step="1" value="${d.thresholdDb}" />
  </section>

  <section class="card">
    <h2>Controls on the glasses</h2>
    <table class="keys">
      <tr><td>Tap</td><td>Start / stop measuring</td></tr>
      <tr><td>Hold</td><td>Reset the accumulated dose</td></tr>
      <tr><td>Double tap</td><td>Leave (stops the microphone)</td></tr>
    </table>
    <p class="hint">
      Measuring never starts by itself, and while the microphone is open the
      glasses show <strong>● MIC</strong> at all times.
    </p>
  </section>

  <footer class="hint">
    No audio is recorded or stored, ever — only a level is computed from each
    block and then discarded. No level history is kept either.
  </footer>`;
}

function wire(
  root: HTMLElement,
  ports: PhoneUiPorts,
  data: NoiseData,
  rerender: () => void,
): void {
  const byId = <T extends HTMLElement>(id: string): T | null => root.querySelector<T>("#" + id);
  const commit = (next: NoiseData): void => { void ports.setData(next).then(rerender); };
  const patchDose = (change: Partial<DoseSettings>): void => commit(setDose(data, change));

  bindRange(byId("offset"), byId("offset-out"), (v) => commit({ ...data, calibrationOffset: v }));
  bindRange(byId("criterion"), byId("criterion-out"), (v) => patchDose({ criterionDb: v }));
  bindRange(byId("hours"), byId("hours-out"), (v) => patchDose({ criterionHours: v }));
  bindRange(byId("threshold"), byId("threshold-out"), (v) => patchDose({ thresholdDb: v }));

  byId<HTMLSelectElement>("exchange")?.addEventListener("change", (event) => {
    const value = Number((event.target as HTMLSelectElement).value);
    patchDose({ exchangeRateDb: value === 5 ? 5 : 3 });
  });
}

function bindRange(
  input: HTMLElement | null,
  output: HTMLElement | null,
  commit: (value: number) => void,
): void {
  const range = input as HTMLInputElement | null;
  if (!range) return;
  range.addEventListener("input", () => {
    if (output) output.textContent = range.value;
  });
  range.addEventListener("change", () => commit(Number(range.value)));
}
