import {
  AXES, csvFileName, fmt2, guideStep, GUIDE_STEPS, mostChangedAxis, recordingDone, sampleRate, toCsv,
  type Recording, type SensorStats,
} from "../imu/diagnostics";
import type { Locale } from "../i18n";
import { t } from "../messages";

/** The SDK's ImuReportPace values (100…1000 in steps of 100). Unit undocumented. */
export const PACES: readonly number[] = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];

/** What the phone page needs from the app for the sensor test. */
export interface SensorPorts {
  readonly isOn: () => boolean;
  readonly setOn: (on: boolean) => void;
  readonly getPace: () => number;
  readonly setPace: (pace: number) => void;
  readonly resetStats: () => void;
  readonly startRecording: () => void;
  readonly getStats: () => SensorStats;
  readonly getRecording: () => Recording | null;
}

/** Static part of the panel; the numbers are filled in by updateSensorPanel. */
export function sensorPanelHtml(locale: Locale, ports: SensorPorts, now = Date.now()): string {
  const x = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  const on = ports.isOn();
  const pace = ports.getPace();
  const rec = ports.getRecording();
  const finished = rec !== null && recordingDone(rec, now);
  const steps = GUIDE_STEPS.map((step, i) => `<li>${i === 0 ? x("p.sensorGuide1") : x(step.key)}</li>`).join("");
  const live = on ? `
    <table class="keys sensor">
      ${AXES.map((axis) => `<tr><td>${axis}</td><td><b id="sensor-${axis}">--</b> <span class="hint" id="sensor-${axis}-range"></span></td></tr>`).join("")}
      <tr><td>${x("p.sensorMag")}</td><td id="sensor-mag">--</td></tr>
      <tr><td>${x("p.sensorRate")}</td><td id="sensor-rate">--</td></tr>
      <tr><td>${x("p.sensorAxis")}</td><td id="sensor-axis">--</td></tr>
      <tr><td>${x("p.sensorCount")}</td><td id="sensor-count">0</td></tr>
    </table>
    <button id="sensor-reset" type="button" class="secondary">${x("p.sensorReset")}</button>

    <label for="sensor-pace">${x("p.sensorPace")}</label>
    <select id="sensor-pace">${PACES.map((p) => `<option value="${p}"${p === pace ? " selected" : ""}>${p}</option>`).join("")}</select>
    <p class="hint">${x("p.sensorPaceHint")}</p>

    <h3>${x("p.sensorGuide")}</h3>
    <ol class="guide">${steps}</ol>
    <p id="sensor-rec-status" class="hint"></p>
    <button id="sensor-record" type="button">${x("p.sensorRecord")}</button>
    ${finished && rec ? resultHtml(locale, rec, pace) : ""}
    <p class="hint">${x("p.sensorPrivacy")}</p>` : "";
  return `
  <section class="card" id="sensor-card">
    <h2>${x("p.sensorTitle")}</h2>
    <p class="hint">${x("p.sensorIntro")}</p>
    <button id="sensor-toggle" type="button"${on ? ' class="secondary"' : ""}>${on ? x("p.sensorClose") : x("p.sensorOpen")}</button>
    ${live}
  </section>`;
}

function resultHtml(locale: Locale, rec: Recording, pace: number): string {
  const x = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  const csv = toCsv(rec, pace);
  return `
    <p>${x("p.sensorDone", { n: rec.samples.length, s: Math.round(rec.durationMs / 1000) })}</p>
    <button id="sensor-download" type="button">${x("p.sensorDownload")}</button>
    <button id="sensor-copy" type="button" class="secondary">${x("p.sensorCopy")}</button>
    <p id="sensor-copy-status" class="hint"></p>
    <textarea id="sensor-csv" readonly rows="6">${escapeHtml(csv)}</textarea>`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Fills the live numbers; called about five times a second while the test runs. */
export function updateSensorPanel(root: ParentNode, locale: Locale, ports: SensorPorts, now = Date.now()): void {
  const set = (id: string, text: string): void => {
    const el = root.querySelector<HTMLElement>("#" + id);
    if (el && el.textContent !== text) el.textContent = text;
  };
  const stats = ports.getStats();
  for (const axis of AXES) {
    set(`sensor-${axis}`, fmt2(stats.last?.[axis]));
    const range = stats.range?.[axis];
    set(`sensor-${axis}-range`, range ? `min ${fmt2(range.min)} · max ${fmt2(range.max)}` : "");
  }
  const mag = stats.magnitudeRange;
  set("sensor-mag", stats.lastMagnitude === null ? "--" : `${fmt2(stats.lastMagnitude)}${mag ? ` (min ${fmt2(mag.min)} · max ${fmt2(mag.max)})` : ""}`);
  const rate = sampleRate(stats.recent, now);
  set("sensor-rate", rate === null ? "--" : `${rate.toFixed(1)} Hz`);
  set("sensor-axis", mostChangedAxis(stats) ?? "--");
  set("sensor-count", String(stats.count));
  const rec = ports.getRecording();
  if (rec && !recordingDone(rec, now)) {
    const elapsed = now - rec.startedAt;
    set("sensor-rec-status", `${t(locale, "p.sensorRecording", { s: Math.ceil((rec.durationMs - elapsed) / 1000) })} — ${t(locale, GUIDE_STEPS[guideStep(elapsed)]!.key)}`);
  } else {
    set("sensor-rec-status", "");
  }
}

/** Wires the buttons; `rerender` redraws the page (panel opened/closed, recording done). */
export function wireSensorPanel(root: ParentNode, locale: Locale, ports: SensorPorts, rerender: () => void): void {
  const byId = <T extends HTMLElement>(id: string): T | null => root.querySelector<T>("#" + id);
  byId<HTMLButtonElement>("sensor-toggle")?.addEventListener("click", () => {
    ports.setOn(!ports.isOn());
    rerender();
  });
  byId<HTMLButtonElement>("sensor-reset")?.addEventListener("click", () => ports.resetStats());
  byId<HTMLSelectElement>("sensor-pace")?.addEventListener("change", (event) => {
    const value = Number((event.target as HTMLSelectElement).value);
    if (PACES.includes(value)) ports.setPace(value);
  });
  byId<HTMLButtonElement>("sensor-record")?.addEventListener("click", () => {
    ports.startRecording();
    rerender();
  });
  const csvNow = (): { csv: string; name: string } | null => {
    const rec = ports.getRecording();
    return rec ? { csv: toCsv(rec, ports.getPace()), name: csvFileName(rec) } : null;
  };
  byId<HTMLButtonElement>("sensor-download")?.addEventListener("click", () => {
    const file = csvNow();
    if (file) download(file.csv, file.name);
  });
  byId<HTMLButtonElement>("sensor-copy")?.addEventListener("click", () => {
    const file = csvNow();
    if (!file) return;
    const status = byId<HTMLElement>("sensor-copy-status");
    const done = (ok: boolean): void => { if (status) status.textContent = t(locale, ok ? "p.sensorCopied" : "p.sensorCopyFail"); };
    try {
      void navigator.clipboard.writeText(file.csv).then(() => done(true), () => done(false));
    } catch {
      done(false);
    }
  });
}

/** Offers the CSV as a file; WebViews that ignore downloads still have copy and the text box. */
function download(csv: string, name: string): void {
  try {
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } catch (error) {
    console.warn("[posturelens] CSV download failed:", error);
  }
}
