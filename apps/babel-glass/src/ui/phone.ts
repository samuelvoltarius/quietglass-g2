import {
  isPlainHttp, maskSecret, translationEnabled, usesMockStt, validateHttpUrl,
  validateWsUrl, type BabelData,
} from "../storage/persist";
import { MODE_PRESETS, type CaptionMode } from "../glasses/view";

/**
 * The phone companion: providers, languages and mode.
 *
 * Credentials are write-only here — once saved, the field reports only that a
 * secret is set and how long it is.
 */

export interface PhoneUiPorts {
  readonly getData: () => BabelData;
  readonly setData: (data: BabelData) => Promise<void>;
}

const MODE_LABELS: Readonly<Record<CaptionMode, string>> = {
  conversation: "Conversation — few lines, both languages",
  lecture: "Lecture — more history, translation only",
  travel: "Travel — short and large",
  captionOnly: "Caption only — no translation",
};

export function mountPhoneUi(ports: PhoneUiPorts): void {
  const root = document.getElementById("app");
  if (!root) return;

  let notice = "";
  const render = (): void => {
    const data = ports.getData();
    root.innerHTML = template(data, notice);
    notice = "";
    wire(root, ports, data, (message) => { notice = message; render(); });
  };
  render();
}

function template(data: BabelData, notice: string): string {
  return `
  <header class="brand">
    <span class="brand-mark">Aigner Labs</span>
    <h1>Babel Glass</h1>
  </header>

  ${notice ? '<p class="notice">' + escapeHtml(notice) + "</p>" : ""}

  ${usesMockStt(data) ? `
  <section class="card">
    <h2>Using the mock recogniser</h2>
    <p class="hint">
      No speech server is configured, so Babel Glass emits fixed placeholder
      text and the glasses show <strong>MOCK</strong>. It exists so the app can
      be tried without a server — it does not transcribe anything.
    </p>
  </section>` : ""}

  <section class="card">
    <h2>Speech recognition</h2>
    <label for="stt">Server (WebSocket)</label>
    <input id="stt" type="text" value="${escapeHtml(data.sttUrl)}" placeholder="wss://your-host:9000/asr" />
    <p class="hint">
      Leave empty to use the mock. Point this at your own
      <code>faster-whisper</code> or WhisperX server — see the README for the
      wire format, which is about a dozen lines of Python.
    </p>
    ${isPlainHttp(data.sttUrl) ? '<p class="hint"><small class="warn">unencrypted ws:// — audio travels in the clear</small></p>' : ""}

    <label for="stt-token">Token (optional) — <em>${escapeHtml(maskSecret(data.sttToken))}</em></label>
    <input id="stt-token" type="password" placeholder="sent in the handshake" />

    <label for="source">Source language</label>
    <input id="source" type="text" value="${escapeHtml(data.sourceLanguage)}" placeholder="auto, en, de, fr …" />
  </section>

  <section class="card">
    <h2>Translation</h2>
    <label for="translate">Endpoint (LibreTranslate-compatible)</label>
    <input id="translate" type="text" value="${escapeHtml(data.translateUrl)}" placeholder="https://your-host:5000/translate" />
    <p class="hint">Leave empty to show captions without translating.</p>
    ${isPlainHttp(data.translateUrl) ? '<p class="hint"><small class="warn">unencrypted http://</small></p>' : ""}

    <label for="translate-key">API key (optional) — <em>${escapeHtml(maskSecret(data.translateKey))}</em></label>
    <input id="translate-key" type="password" placeholder="sent in the request body" />

    <label for="target">Target language</label>
    <input id="target" type="text" value="${escapeHtml(data.targetLanguage)}" placeholder="en, de, fr …" />

    <p class="hint">
      Translation is currently <strong>${translationEnabled(data) ? "on" : "off"}</strong>.
    </p>
  </section>

  <section class="card">
    <h2>Mode</h2>
    <select id="mode">
      ${(Object.keys(MODE_PRESETS) as CaptionMode[]).map((mode) =>
        '<option value="' + mode + '"' + (mode === data.mode ? " selected" : "") + ">" +
        escapeHtml(MODE_LABELS[mode]) + "</option>").join("")}
    </select>
    <label class="check"><input id="invert" type="checkbox" ${data.invertScroll ? "checked" : ""} /> Invert swipe direction</label>
    <button id="save" type="button">Save</button>
  </section>

  <section class="card">
    <h2>Controls on the glasses</h2>
    <table class="keys">
      <tr><td>Tap</td><td>Start / stop captioning</td></tr>
      <tr><td>Swipe</td><td>Scroll back through what was said</td></tr>
      <tr><td>Hold</td><td>Clear the transcript</td></tr>
      <tr><td>Double tap</td><td>Leave — stops the microphone</td></tr>
    </table>
    <p class="hint">
      Captioning never starts by itself, and while the microphone is open the
      glasses show <strong>● MIC</strong> at all times.
    </p>
  </section>

  <footer class="hint">
    Audio is streamed only to the server you configure and is never stored.
    The transcript lives in memory for the session and is discarded when you close the app.
  </footer>`;
}

function wire(
  root: HTMLElement,
  ports: PhoneUiPorts,
  data: BabelData,
  notify: (message: string) => void,
): void {
  const byId = <T extends HTMLElement>(id: string): T | null => root.querySelector<T>("#" + id);
  const commit = (next: BabelData): void => { void ports.setData(next); };

  byId<HTMLSelectElement>("mode")?.addEventListener("change", (event) => {
    const mode = (event.target as HTMLSelectElement).value as CaptionMode;
    commit({ ...data, mode });
  });

  byId<HTMLInputElement>("invert")?.addEventListener("change", (event) => {
    commit({ ...data, invertScroll: (event.target as HTMLInputElement).checked });
  });

  byId<HTMLButtonElement>("save")?.addEventListener("click", () => {
    const sttUrl = byId<HTMLInputElement>("stt")?.value.trim() ?? "";
    const translateUrl = byId<HTMLInputElement>("translate")?.value.trim() ?? "";

    const sttCheck = validateWsUrl(sttUrl);
    const translateCheck = validateHttpUrl(translateUrl);
    const errors = [...sttCheck.errors, ...translateCheck.errors];
    if (errors.length > 0) { notify(errors.join(" ")); return; }

    const sttToken = byId<HTMLInputElement>("stt-token")?.value ?? "";
    const translateKey = byId<HTMLInputElement>("translate-key")?.value ?? "";

    commit({
      ...data,
      sttUrl,
      translateUrl,
      // An empty field means "leave the stored secret alone", not "clear it".
      ...(sttToken ? { sttToken } : data.sttToken ? { sttToken: data.sttToken } : {}),
      ...(translateKey ? { translateKey } : data.translateKey ? { translateKey: data.translateKey } : {}),
      sourceLanguage: byId<HTMLInputElement>("source")?.value.trim() || "auto",
      targetLanguage: byId<HTMLInputElement>("target")?.value.trim() || "en",
    });
  });
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}
