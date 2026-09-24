import { setSettings, type PostureData } from "../storage/persist";
import type { PostureSettings } from "../posture/monitor";

/**
 * The phone companion: thresholds and calibration management. The glasses only
 * need one control (tap to calibrate), so everything adjustable lives here.
 */

export interface PhoneUiPorts {
  readonly getData: () => PostureData;
  readonly setData: (data: PostureData) => Promise<void>;
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

function template(data: PostureData): string {
  const s = data.settings;
  return `
  <header class="brand">
    <span class="brand-mark">Aigner Labs</span>
    <h1>PostureLens</h1>
  </header>

  <section class="card">
    <h2>Calibration</h2>
    <p class="hint">
      ${data.reference
        ? "Calibrated. Your upright posture is stored on this phone."
        : "Not calibrated yet. Put the glasses on, sit the way you want to sit, and tap the temple pad."}
    </p>
    ${data.reference ? '<button id="clear" type="button" class="secondary">Clear calibration</button>' : ""}
    <p class="hint">
      PostureLens measures the angle away from the posture you calibrated — not
      away from vertical. Calibrate the way you actually want to sit.
    </p>
  </section>

  <section class="card">
    <h2>When to warn</h2>

    <label for="angle">Lean angle — <output id="angle-out">${s.warnAngle}</output>°</label>
    <input id="angle" type="range" min="5" max="60" step="1" value="${s.warnAngle}" />
    <p class="hint">How far forward counts as leaning. Start around 25°.</p>

    <label for="sustain">Hold time — <output id="sustain-out">${s.sustainSeconds}</output>s</label>
    <input id="sustain" type="range" min="5" max="300" step="5" value="${s.sustainSeconds}" />
    <p class="hint">How long the lean must be held before a warning. This is what stops it complaining every time you glance down.</p>

    <label for="snooze">Quiet after a warning — <output id="snooze-out">${Math.round(s.snoozeSeconds / 60)}</output> min</label>
    <input id="snooze" type="range" min="1" max="30" step="1" value="${Math.round(s.snoozeSeconds / 60)}" />

    <label for="smooth">Steadiness — <output id="smooth-out">${s.smoothing.toFixed(2)}</output></label>
    <input id="smooth" type="range" min="0.05" max="1" step="0.05" value="${s.smoothing}" />
    <p class="hint">Lower reacts more slowly and ignores more head movement.</p>
  </section>

  <section class="card">
    <h2>Display</h2>
    <label class="check"><input id="angle-good" type="checkbox" ${data.showAngleWhenGood ? "checked" : ""} /> Show the live angle even when upright</label>
    <p class="hint">Off by default. With good posture the display stays nearly empty on purpose.</p>
    <label class="check"><input id="invert" type="checkbox" ${data.invertScroll ? "checked" : ""} /> Invert swipe direction</label>
  </section>

  <section class="card">
    <h2>Controls on the glasses</h2>
    <table class="keys">
      <tr><td>Tap</td><td>Set the current posture as upright</td></tr>
      <tr><td>Swipe</td><td>Reset today's tally</td></tr>
      <tr><td>Double tap</td><td>Leave PostureLens</td></tr>
    </table>
  </section>

  <footer class="hint">
    PostureLens stores your calibration and thresholds on this phone and nothing else.
    No posture history is recorded, and nothing is sent anywhere.
  </footer>`;
}

function wire(root: HTMLElement, ports: PhoneUiPorts, data: PostureData): void {
  const byId = <T extends HTMLElement>(id: string): T | null => root.querySelector<T>("#" + id);
  const commit = (next: PostureData): void => { void ports.setData(next); };
  const patch = (change: Partial<PostureSettings>): void => commit(setSettings(data, change));

  byId<HTMLButtonElement>("clear")?.addEventListener("click", () => {
    commit({ ...data, reference: null });
  });

  bindRange(byId("angle"), byId("angle-out"), (v) => patch({ warnAngle: v }));
  bindRange(byId("sustain"), byId("sustain-out"), (v) => patch({ sustainSeconds: v }));
  bindRange(byId("snooze"), byId("snooze-out"), (v) => patch({ snoozeSeconds: v * 60 }), (v) => String(v));
  bindRange(byId("smooth"), byId("smooth-out"), (v) => patch({ smoothing: v }), (v) => v.toFixed(2));

  byId<HTMLInputElement>("angle-good")?.addEventListener("change", (event) => {
    commit({ ...data, showAngleWhenGood: (event.target as HTMLInputElement).checked });
  });
  byId<HTMLInputElement>("invert")?.addEventListener("change", (event) => {
    commit({ ...data, invertScroll: (event.target as HTMLInputElement).checked });
  });
}

/** Live label while dragging; the value is stored on release. */
function bindRange(
  input: HTMLElement | null,
  output: HTMLElement | null,
  commit: (value: number) => void,
  format: (value: number) => string = String,
): void {
  const range = input as HTMLInputElement | null;
  if (!range) return;
  range.addEventListener("input", () => {
    if (output) output.textContent = format(Number(range.value));
  });
  range.addEventListener("change", () => commit(Number(range.value)));
}
