import {
  isPlainHttp, maskSecret, translationEnabled, usesMockStt, validateHttpUrl,
  validateWsUrl, type BabelData, type TranslateProvider,
} from "../storage/persist";
import { MODE_PRESETS, type CaptionMode } from "../glasses/view";
import {
  AUTO, CUSTOM, LANGUAGES, readLanguageChoice, selectValueFor,
} from "../text/languages";
import { languageSelect, type Locale } from "../i18n";
import { t } from "../messages";

/**
 * The phone companion: UI language, caption languages, mode and — under
 * "Advanced" — the servers.
 *
 * Credentials are write-only here — once saved, the field reports only that a
 * secret is set and how long it is.
 */

export interface PhoneUiPorts {
  readonly getData: () => BabelData;
  readonly setData: (data: BabelData) => Promise<void>;
  /** UI language; English when the host does not provide one. */
  readonly getLocale?: () => Locale;
  /** The user picked another UI language: the host persists it and redraws the glasses. */
  readonly setLocale?: (locale: Locale) => void;
}

const PROVIDERS: readonly TranslateProvider[] = ["libretranslate", "openai"];

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
    const locale = ports.getLocale?.() ?? "en";
    try {
      const html = globalThis.document?.documentElement;
      if (html) html.lang = locale;
    } catch { /* no document outside the WebView */ }
    root.innerHTML = template(ports.getData(), notice, locale);
    wire(root, ports, render);
  };
  render();
}

/** A language as listed in the pickers: its name in the UI language, plus its own name. */
function languageLabel(code: string, native: string, locale: Locale): string {
  const name = t(locale, "l." + code);
  return name === native ? name : name + " — " + native;
}

export function languageOptions(selected: string, allowAuto: boolean, locale: Locale = "en"): string {
  const value = selectValueFor(selected, allowAuto);
  const options = [
    ...(allowAuto ? [{ code: AUTO, label: t(locale, "p.auto") }] : []),
    ...LANGUAGES.map((l) => ({ code: l.code, label: languageLabel(l.code, l.native, locale) })),
    { code: CUSTOM, label: t(locale, "p.custom") },
  ];
  return options.map((o) =>
    '<option value="' + escapeHtml(o.code) + '"' + (o.code === value ? " selected" : "") + ">" +
    escapeHtml(o.label) + "</option>").join("");
}

function languageField(
  id: string, label: string, code: string, allowAuto: boolean, hint: string, locale: Locale,
): string {
  const isCustom = selectValueFor(code, allowAuto) === CUSTOM;
  return `
    <label for="${id}">${label}</label>
    <select id="${id}">${languageOptions(code, allowAuto, locale)}</select>
    <input id="${id}-custom" type="text" ${isCustom ? "" : "hidden"}
      value="${isCustom ? escapeHtml(code) : ""}" placeholder="${escapeHtml(hint)}" aria-label="${escapeHtml(t(locale, "p.codeLabel", { label }))}" />`;
}

function template(data: BabelData, notice: string, locale: Locale): string {
  const x = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  const secret = (value: string | undefined): string => escapeHtml(maskSecret(value, locale));
  const openai = data.translateProvider === "openai";
  // A server section carrying a warning stays open, so the warning is seen.
  const sttOpen = isPlainHttp(data.sttUrl) ? " open" : "";
  const trOpen = isPlainHttp(data.translateUrl) || isPlainHttp(data.llmUrl) ? " open" : "";
  return `
  <header class="brand">
    <span class="brand-mark">Quietglass</span>
    <h1>Babel Glass</h1>
  </header>

  <section class="card compact">${languageSelect(locale)}</section>

  <p id="notice" class="notice" ${notice ? "" : "hidden"}>${escapeHtml(notice)}</p>

  ${usesMockStt(data) ? `
  <section class="card">
    <h2>${x("p.mockTitle")}</h2>
    <p class="hint">${x("p.mockBody", { mock: x("g.mock") })}</p>
  </section>` : ""}

  <section class="card">
    <h2>${x("p.sttTitle")}</h2>
    ${languageField("source", x("p.source"), data.sourceLanguage, true, x("p.codeHintSource"), locale)}
    <p class="hint">${x("p.sourceHint")}</p>

    <details class="advanced"${sttOpen}>
      <summary>${x("p.advanced")}</summary>
      <label for="stt">${x("p.sttServer")}</label>
      <input id="stt" type="text" value="${escapeHtml(data.sttUrl)}" placeholder="wss://your-host:9000/asr" />
      <p class="hint">${x("p.sttServerHint")}</p>
      ${isPlainHttp(data.sttUrl) ? `<p class="hint"><small class="warn">${x("p.warnWs")}</small></p>` : ""}

      <label for="stt-token">${x("p.sttToken")} — <em>${secret(data.sttToken)}</em></label>
      <input id="stt-token" type="password" placeholder="${escapeHtml(x("p.sttTokenPlaceholder"))}" />
    </details>
  </section>

  <section class="card">
    <h2>${x("p.trTitle")}</h2>
    ${languageField("target", x("p.target"), data.targetLanguage, false, x("p.codeHintTarget"), locale)}

    <label class="check"><input id="translit" type="checkbox" ${data.transliterateOriginal ? "checked" : ""} /> ${x("p.translit")}</label>
    <p class="hint">${x("p.translitHint")}</p>

    <p class="hint">${x("p.trState", { state: translationEnabled(data) ? x("p.on") : x("p.off") })}</p>

    <details class="advanced"${trOpen}>
      <summary>${x("p.advanced")}</summary>
      <label for="provider">${x("p.trServer")}</label>
      <select id="provider">
        ${PROVIDERS.map((p) =>
          '<option value="' + p + '"' + (p === data.translateProvider ? " selected" : "") + ">" +
          escapeHtml(x("p.provider." + p)) + "</option>").join("")}
      </select>

      <div id="libre-fields" ${openai ? "hidden" : ""}>
        <label for="translate">${x("p.endpoint")}</label>
        <input id="translate" type="text" value="${escapeHtml(data.translateUrl)}" placeholder="https://your-host:5000/translate" />
        <p class="hint">${x("p.endpointHint")}</p>
        ${isPlainHttp(data.translateUrl) ? `<p class="hint"><small class="warn">${x("p.warnHttp")}</small></p>` : ""}
        <label for="translate-key">${x("p.apiKey")} — <em>${secret(data.translateKey)}</em></label>
        <input id="translate-key" type="password" placeholder="${escapeHtml(x("p.apiKeyPlaceholder"))}" />
      </div>

      <div id="llm-fields" ${openai ? "" : "hidden"}>
        <label for="llm-url">${x("p.llmUrl")}</label>
        <input id="llm-url" type="text" value="${escapeHtml(data.llmUrl)}" placeholder="http://your-host:11434/v1" />
        <label for="llm-model">${x("p.llmModel")}</label>
        <input id="llm-model" type="text" value="${escapeHtml(data.llmModel)}" placeholder="qwen2.5:7b-instruct" />
        ${isPlainHttp(data.llmUrl) ? `<p class="hint"><small class="warn">${x("p.warnHttp")}</small></p>` : ""}
        <label for="llm-key">${x("p.llmKey")} — <em>${secret(data.llmKey)}</em></label>
        <input id="llm-key" type="password" placeholder="${escapeHtml(x("p.llmKeyPlaceholder"))}" />
      </div>
    </details>
  </section>

  <section class="card">
    <h2>${x("p.modeTitle")}</h2>
    <select id="mode">
      ${(Object.keys(MODE_PRESETS) as CaptionMode[]).map((mode) =>
        '<option value="' + mode + '"' + (mode === data.mode ? " selected" : "") + ">" +
        escapeHtml(x("p.mode." + mode)) + "</option>").join("")}
    </select>
    <label class="check"><input id="invert" type="checkbox" ${data.invertScroll ? "checked" : ""} /> ${x("p.invert")}</label>
    <button id="save" type="button">${x("p.save")}</button>
  </section>

  <section class="card">
    <h2>${x("p.controlsTitle")}</h2>
    <table class="keys">
      <tr><td>${x("p.tap")}</td><td>${x("p.tapDo")}</td></tr>
      <tr><td>${x("p.swipe")}</td><td>${x("p.swipeDo")}</td></tr>
      <tr><td>${x("p.hold")}</td><td>${x("p.holdDo")}</td></tr>
      <tr><td>${x("p.double")}</td><td>${x("p.doubleDo")}</td></tr>
    </table>
    <p class="hint">${x("p.controlsHint", { mic: x("g.mic") })}</p>
  </section>

  <footer class="hint">${x("p.footer")}</footer>`;
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

/** Validates the form and merges it into the stored settings. Pure; errors come in `locale`. */
export function applyForm(current: BabelData, form: FormValues, locale: Locale = "en"): FormResult {
  const sttUrl = form.sttUrl.trim();
  const translateUrl = form.translateUrl.trim();
  const llmUrl = form.llmUrl.trim();
  const llmModel = form.llmModel.trim();
  const translateProvider: TranslateProvider = form.provider === "openai" ? "openai" : "libretranslate";

  const errors = [
    ...validateWsUrl(sttUrl).errors,
    ...validateHttpUrl(translateUrl).errors,
    ...validateHttpUrl(llmUrl, "llm").errors,
  ];
  if (translateProvider === "openai" && llmUrl && !llmModel) {
    errors.push("e.model");
  }
  if (errors.length > 0) return { ok: false, errors: errors.map((key) => t(locale, key)) };

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

  byId<HTMLSelectElement>("language")?.addEventListener("change", (event) => {
    const value = (event.target as HTMLSelectElement).value;
    ports.setLocale?.(value === "de" ? "de" : "en");
    render();
  });

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
    const locale = ports.getLocale?.() ?? "en";
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
    }, locale);
    if (!result.ok) {
      // Report in place: re-rendering would throw away what was typed.
      const notice = byId<HTMLElement>("notice");
      if (notice) { notice.textContent = result.errors.join(" "); notice.hidden = false; }
      return;
    }
    void ports.setData(result.data).then(() => render(t(locale, "p.saved")));
  });
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}
