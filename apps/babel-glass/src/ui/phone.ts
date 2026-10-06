import {
  isPlainHttp, maskSecret, translationEnabled, usesMockStt, validateHttpUrl,
  validateWsUrl, type BabelData, type TranslateProvider,
} from "../storage/persist";
import { MODE_PRESETS, type CaptionMode } from "../glasses/view";
import {
  AUTO, CUSTOM, LANGUAGES, readLanguageChoice, selectValueFor,
} from "../text/languages";

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

const PROVIDER_LABELS: Readonly<Record<TranslateProvider, string>> = {
  libretranslate: "LibreTranslate-compatible (/translate)",
  openai: "OpenAI-compatible LLM (vLLM, Ollama, LM Studio, llama.cpp)",
};

/** Minimal DOM surface the UI needs; lets tests drive it without a browser. */
export interface UiRoot {
  innerHTML: string;
  querySelector<T extends Element>(selector: string): T | null;
}

export function mountPhoneUi(ports: PhoneUiPorts): void {
  const root = document.getElementById("app");
  if (root) mountPhoneUiInto(root, ports);
}

export function mountPhoneUiInto(root: UiRoot, ports: PhoneUiPorts): void {
  const render = (notice = ""): void => {
    root.innerHTML = template(ports.getData(), notice);
    wire(root, ports, render);
  };
  render();
}

export function languageOptions(selected: string, allowAuto: boolean): string {
  const value = selectValueFor(selected, allowAuto);
  const options = [
    ...(allowAuto ? [{ code: AUTO, label: "Detect automatically" }] : []),
    ...LANGUAGES.map((l) => ({
      code: l.code,
      label: l.name === l.native ? l.name : l.name + " — " + l.native,
    })),
    { code: CUSTOM, label: "Other (enter code)…" },
  ];
  return options.map((o) =>
    '<option value="' + escapeHtml(o.code) + '"' + (o.code === value ? " selected" : "") + ">" +
    escapeHtml(o.label) + "</option>").join("");
}

function languageField(id: string, label: string, code: string, allowAuto: boolean, hint: string): string {
  const isCustom = selectValueFor(code, allowAuto) === CUSTOM;
  return `
    <label for="${id}">${label}</label>
    <select id="${id}">${languageOptions(code, allowAuto)}</select>
    <input id="${id}-custom" type="text" ${isCustom ? "" : "hidden"}
      value="${isCustom ? escapeHtml(code) : ""}" placeholder="${hint}" aria-label="${label} code" />`;
}

function template(data: BabelData, notice: string): string {
  const openai = data.translateProvider === "openai";
  return `
  <header class="brand">
    <span class="brand-mark">Quietglass</span>
    <h1>Babel Glass</h1>
  </header>

  <p id="notice" class="notice" ${notice ? "" : "hidden"}>${escapeHtml(notice)}</p>

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

    ${languageField("source", "Spoken language", data.sourceLanguage, true, "e.g. be, ru, de-AT")}
    <p class="hint">
      For Belarusian choose it explicitly — automatic detection often reports
      Belarusian speech as Russian.
    </p>
  </section>

  <section class="card">
    <h2>Translation</h2>
    <label for="provider">Translation server</label>
    <select id="provider">
      ${(Object.keys(PROVIDER_LABELS) as TranslateProvider[]).map((p) =>
        '<option value="' + p + '"' + (p === data.translateProvider ? " selected" : "") + ">" +
        escapeHtml(PROVIDER_LABELS[p]) + "</option>").join("")}
    </select>

    <div id="libre-fields" ${openai ? "hidden" : ""}>
      <label for="translate">Endpoint</label>
      <input id="translate" type="text" value="${escapeHtml(data.translateUrl)}" placeholder="https://your-host:5000/translate" />
      <p class="hint">
        LibreTranslate, or the NLLB server in <code>examples/translate-server.py</code>
        (needed for Belarusian — LibreTranslate has no Belarusian model).
      </p>
      ${isPlainHttp(data.translateUrl) ? '<p class="hint"><small class="warn">unencrypted http://</small></p>' : ""}
      <label for="translate-key">API key (optional) — <em>${escapeHtml(maskSecret(data.translateKey))}</em></label>
      <input id="translate-key" type="password" placeholder="sent in the request body" />
    </div>

    <div id="llm-fields" ${openai ? "" : "hidden"}>
      <label for="llm-url">Server base URL</label>
      <input id="llm-url" type="text" value="${escapeHtml(data.llmUrl)}" placeholder="http://your-host:11434/v1" />
      <label for="llm-model">Model</label>
      <input id="llm-model" type="text" value="${escapeHtml(data.llmModel)}" placeholder="qwen2.5:7b-instruct" />
      ${isPlainHttp(data.llmUrl) ? '<p class="hint"><small class="warn">unencrypted http://</small></p>' : ""}
      <label for="llm-key">Bearer token (optional) — <em>${escapeHtml(maskSecret(data.llmKey))}</em></label>
      <input id="llm-key" type="password" placeholder="sent as Authorization: Bearer" />
    </div>

    ${languageField("target", "Translate into", data.targetLanguage, false, "e.g. de, en")}

    <label class="check"><input id="translit" type="checkbox" ${data.transliterateOriginal ? "checked" : ""} /> Show original as Latin transliteration</label>
    <p class="hint">
      Shows Russian, Belarusian or Ukrainian on the glasses in Latin letters
      (Privet, kak dela?) — for if the glasses font cannot draw Cyrillic.
      The translation is never changed.
    </p>

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

/** Raw field values as read from the form. */
export interface FormValues {
  readonly sttUrl: string;
  readonly sttToken: string;
  readonly source: string;
  readonly sourceCustom: string;
  readonly provider: string;
  readonly translateUrl: string;
  readonly translateKey: string;
  readonly llmUrl: string;
  readonly llmModel: string;
  readonly llmKey: string;
  readonly target: string;
  readonly targetCustom: string;
  readonly transliterate: boolean;
}

export type FormResult =
  | { readonly ok: true; readonly data: BabelData }
  | { readonly ok: false; readonly errors: readonly string[] };

/** Validates the form and merges it into the stored settings. Pure. */
export function applyForm(current: BabelData, form: FormValues): FormResult {
  const sttUrl = form.sttUrl.trim();
  const translateUrl = form.translateUrl.trim();
  const llmUrl = form.llmUrl.trim();
  const llmModel = form.llmModel.trim();
  const translateProvider: TranslateProvider = form.provider === "openai" ? "openai" : "libretranslate";

  const errors = [
    ...validateWsUrl(sttUrl).errors,
    ...validateHttpUrl(translateUrl).errors,
    ...validateHttpUrl(llmUrl, "LLM server URL").errors,
  ];
  if (translateProvider === "openai" && llmUrl && !llmModel) {
    errors.push("Enter the model name the LLM server should use.");
  }
  if (errors.length > 0) return { ok: false, errors };

  const keep = <K extends "sttToken" | "translateKey" | "llmKey">(key: K, typed: string) =>
    // An empty field means "leave the stored secret alone", not "clear it".
    typed ? { [key]: typed } : current[key] ? { [key]: current[key] } : {};

  return {
    ok: true,
    data: {
      ...current,
      sttUrl,
      translateProvider,
      translateUrl,
      llmUrl,
      llmModel,
      ...keep("sttToken", form.sttToken),
      ...keep("translateKey", form.translateKey),
      ...keep("llmKey", form.llmKey),
      sourceLanguage: readLanguageChoice(form.source, form.sourceCustom, current.sourceLanguage, true),
      targetLanguage: readLanguageChoice(form.target, form.targetCustom, current.targetLanguage, false),
      transliterateOriginal: form.transliterate,
    },
  };
}

function wire(root: UiRoot, ports: PhoneUiPorts, render: (notice?: string) => void): void {
  const byId = <T extends Element>(id: string): T | null => root.querySelector<T>("#" + id);
  const value = (id: string): string => byId<HTMLInputElement>(id)?.value ?? "";
  // Always merge into the *current* settings: the page is not re-rendered on
  // these immediate changes, so a value captured at render time would be
  // stale and silently undo the previous change.
  const commit = (change: Partial<BabelData>): void => {
    void ports.setData({ ...ports.getData(), ...change });
  };

  byId<HTMLSelectElement>("mode")?.addEventListener("change", (event) => {
    commit({ mode: (event.target as HTMLSelectElement).value as CaptionMode });
  });

  byId<HTMLInputElement>("invert")?.addEventListener("change", (event) => {
    commit({ invertScroll: (event.target as HTMLInputElement).checked });
  });

  byId<HTMLSelectElement>("provider")?.addEventListener("change", (event) => {
    const openai = (event.target as HTMLSelectElement).value === "openai";
    const libre = byId<HTMLElement>("libre-fields");
    const llm = byId<HTMLElement>("llm-fields");
    if (libre) libre.hidden = openai;
    if (llm) llm.hidden = !openai;
  });

  for (const id of ["source", "target"]) {
    byId<HTMLSelectElement>(id)?.addEventListener("change", (event) => {
      const custom = byId<HTMLInputElement>(id + "-custom");
      if (custom) custom.hidden = (event.target as HTMLSelectElement).value !== CUSTOM;
    });
  }

  byId<HTMLButtonElement>("save")?.addEventListener("click", () => {
    const result = applyForm(ports.getData(), {
      sttUrl: value("stt"),
      sttToken: value("stt-token"),
      source: value("source"),
      sourceCustom: value("source-custom"),
      provider: value("provider"),
      translateUrl: value("translate"),
      translateKey: value("translate-key"),
      llmUrl: value("llm-url"),
      llmModel: value("llm-model"),
      llmKey: value("llm-key"),
      target: value("target"),
      targetCustom: value("target-custom"),
      transliterate: byId<HTMLInputElement>("translit")?.checked ?? false,
    });
    if (!result.ok) {
      // Report in place: re-rendering would throw away what was typed.
      const notice = byId<HTMLElement>("notice");
      if (notice) { notice.textContent = result.errors.join(" "); notice.hidden = false; }
      return;
    }
    void ports.setData(result.data).then(() => render("Saved."));
  });
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}
