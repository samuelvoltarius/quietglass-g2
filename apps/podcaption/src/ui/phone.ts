import { languageSelect, tr, type Locale } from "../i18n";
import { messages } from "../messages";
import { progress, type PodState } from "../glasses/view";
import { statusCells } from "../cockpit/model";
import { escapeHtml, formatTime } from "../podcast/view";

/**
 * The phone companion (QUS v1, the look of Rain Lens): exactly three tabs -
 * Jetzt (the player at a glance), Untertitel (what comes next, and opening
 * a file or text) and Einstellungen (the optional feed bridge, glasses,
 * language). The view models are pure so the tests can read them.
 */

/** What the phone shows of the live state: the glasses' state plus the failure in full words (with its code). */
export interface PhoneView {
  readonly state: PodState;
  readonly detail: string;
}

export interface PhonePorts {
  readonly getView: () => PhoneView;
  readonly toggle: () => void;
  readonly openFile: (file: File, title: string) => void;
  readonly usePaste: (text: string, title: string) => void;
  readonly connect: (endpoint: string) => void;
  readonly setLocale: (locale: Locale) => void;
  readonly getInvert: () => boolean;
  readonly setInvert: (value: boolean) => void;
  readonly getEndpoint: () => string;
}

export interface PhoneUi {
  /** Redraws the live parts (pill, "Jetzt", the next captions) without touching any input. */
  readonly refreshLive: () => void;
  /** Redraws the whole page (language, errors, a newly opened file). */
  readonly render: () => void;
}

/** The three tabs (ids, icons and message keys). */
export const TABS: readonly { id: string; icon: string; key: string }[] = [
  { id: "now", icon: "🎧", key: "tabNow" },
  { id: "captions", icon: "📝", key: "tabCaptions" },
  { id: "settings", icon: "⚙️", key: "tabSettings" },
];
const TAB_KEY = "quietglass.podcaption.tab";

/** Nothing opened yet (the sample how-to runs): Einstellungen opens first, with the three-step checklist. */
export function isFirstRun(state: Pick<PodState, "source">): boolean {
  return state.source === "DEMO";
}

const t = (locale: Locale, key: string, vars: Record<string, string | number> = {}): string => tr(messages, locale, key, vars);
const esc = (text: string): string => escapeHtml(text);

export interface Banner { readonly tone: "ok" | "warn" | "critical" | "offline" | "none"; readonly text: string }

/** The one message that counts right now. */
export function bannerFor(view: PhoneView): Banner {
  const { state, detail } = view;
  if (detail) return { tone: "critical", text: t(state.locale, "nextError", { error: detail }) };
  if (state.source === "DEMO") return { tone: "none", text: t(state.locale, "nextDemo") };
  return { tone: "ok", text: t(state.locale, "nextReady", { episode: state.episode }) };
}

/** The status pill: playing or paused. */
export function pillOf(state: PodState): { text: string; on: boolean } {
  return { text: t(state.locale, state.playing ? "stPlay" : "stPause"), on: state.playing };
}

/** "Jetzt": banner, hero card (the progress), 2 x 2 key figures, the one button, the next captions as cards. */
export function nowInner(view: PhoneView): string {
  const { state } = view;
  const { locale } = state;
  const banner = bannerFor(view);
  const cells = statusCells(state);
  const stat = (label: string, value: string, alert = false): string => `<div${alert ? ' class="alert"' : ""}><span>${esc(label)}</span><b>${esc(value)}</b></div>`;
  const next = state.captions.slice(state.cursor, state.cursor + 4);
  return `
    <p class="banner tone-${banner.tone}">${esc(banner.text)}</p>
    <section class="card hero-card">
      <div class="hero">
        <div><span>${esc(t(locale, "heroLabel"))}</span><strong>${esc(state.captions.length === 0 ? "–" : `${progress(state)}%`)}</strong></div>
        <p>${esc(state.episode)}</p>
      </div>
      <div class="stats">${cells.map((cell) => stat(cell.label, cell.value)).join("")}</div>
      <button id="toggle" type="button" class="big">${esc(t(locale, state.playing ? "pause" : "play"))}</button>
    </section>
    ${next.length > 0 ? `<h2 class="strip-title">${esc(t(locale, "stripTitle"))}</h2><div class="strip">${next.map((caption) => `<div class="host tone-ok"><b>${esc(formatTime(caption.start))}</b><span>${esc(caption.text)}</span></div>`).join("")}</div>` : ""}`;
}

/** "Untertitel": the captions that come next, as a card strip. */
export function captionsInner(view: PhoneView): string {
  const { state } = view;
  const rows = state.captions.slice(state.cursor, state.cursor + 6);
  return `
    <h2 class="strip-title">${esc(state.episode)}</h2>
    <div class="strip">${rows.map((caption) => `<div class="host tone-ok"><b>${esc(formatTime(caption.start))}</b><span>${esc(caption.text)}</span></div>`).join("")}</div>`;
}

/** First-run checklist: pure, so tests can read it. */
export function setupInner(state: Pick<PodState, "source" | "cursor" | "locale">): string {
  const opened = state.source !== "DEMO";
  const step = (n: number, done: boolean, key: string): string =>
    `<li class="${done ? "done" : ""}"><span class="num" aria-hidden="true">${done ? "✓" : n}</span><span>${esc(t(state.locale, key))}</span></li>`;
  return `<ol class="steps">${step(1, opened, "setup1")}${step(2, opened && state.cursor > 0, "setup2")}${step(3, opened && state.cursor > 0, "setup3")}</ol>`
    + (opened ? "" : `<p class="hint">${esc(t(state.locale, "setupDemo"))}</p>`);
}

function template(view: PhoneView, ports: Pick<PhonePorts, "getInvert" | "getEndpoint">, typed: { title: string; paste: string }): string {
  const { state } = view;
  const { locale } = state;
  const x = (key: string): string => esc(t(locale, key));
  const firstRun = isFirstRun(state);
  const pill = pillOf(state);
  const endpoint = ports.getEndpoint();
  return `
  <header class="brand bar">
    <div>
      <div class="brand-mark">QUIETGLASS / ACCESSIBILITY</div>
      <h1>PodCaption</h1>
    </div>
    <span id="pill" class="chip${pill.on ? " on" : ""}">${esc(pill.text)}</span>
  </header>

  <div class="tab" data-tab="now"><div id="now-live">${nowInner(view)}</div></div>

  <div class="tab" data-tab="captions">
    <div id="captions-live">${captionsInner(view)}</div>
    <section class="card">
      <h2>${x("open")}</h2>
      <label>${x("file")}<input id="transcript-file" type="file" accept=".vtt,.srt,.json,.txt,text/vtt,application/json,text/plain"></label>
      <label>${x("title")}<input id="title" type="text" value="${esc(typed.title)}"></label>
      <details class="fold">
        <summary>${x("paste")}</summary>
        <textarea id="paste" rows="4" placeholder="${esc(t(locale, "pasteHint"))}">${esc(typed.paste)}</textarea>
        <button id="use-paste" type="button" class="big">${x("usePaste")}</button>
      </details>
      <p class="hint">${x("help")}</p>
    </section>
  </div>

  <div class="tab" data-tab="settings">
    ${firstRun ? `<section class="card setup"><h2>${x("setupTitle")}</h2>${setupInner(state)}</section>` : ""}
    <details class="fold card">
      <summary>${x("bridge")}</summary>
      <p class="hint">${x("bridgeHelp")}</p>
      <label>${x("endpoint")}<input id="endpoint" type="text" value="${esc(endpoint)}"></label>
      <button id="connect" type="button" class="big">${x("connect")}</button>
    </details>
    <section class="card">
      <h2>${x("tabGlasses")}</h2>
      <label class="check"><input id="invert" type="checkbox"${ports.getInvert() ? " checked" : ""}> ${x("invert")}</label>
      <p class="hint">${x("invertHint")}</p>
    </section>
    <section class="card compact">${languageSelect(locale)}</section>
    <details class="fold card">
      <summary>${x("about")}</summary>
      <p class="hint">${x("lede")}</p>
      <p class="hint">${x("help")}</p>
    </details>
  </div>

  <nav class="tabbar" role="tablist">
    ${TABS.map(({ id, icon, key }) => `<button type="button" role="tab" data-tab-go="${id}"><span aria-hidden="true">${icon}</span>${x(key)}</button>`).join("")}
  </nav>`;
}

function readTab(firstRun: boolean): string {
  try { const v = localStorage.getItem(TAB_KEY); if (TABS.some((tab) => tab.id === v)) return v!; } catch { /* no storage */ }
  return firstRun ? "settings" : "now";
}

function applyTab(root: ParentNode, active: string): void {
  root.querySelectorAll<HTMLElement>("[data-tab]").forEach((el) => { el.hidden = el.dataset["tab"] !== active; });
  root.querySelectorAll<HTMLButtonElement>("[data-tab-go]").forEach((button) => {
    const on = button.dataset["tabGo"] === active;
    button.classList.toggle("on", on);
    button.setAttribute("aria-selected", String(on));
  });
}

export function mountPhoneUi(ports: PhonePorts): PhoneUi {
  const app = document.querySelector<HTMLElement>("#app");
  if (!app) return { refreshLive: () => undefined, render: () => undefined };
  let tab = readTab(isFirstRun(ports.getView().state));

  const render = (): void => {
    const view = ports.getView();
    if (document.documentElement) document.documentElement.lang = view.state.locale;
    // A half-typed title or pasted text survives a re-render caused by an error or a language switch.
    const typed = { title: app.querySelector<HTMLInputElement>("#title")?.value ?? "", paste: app.querySelector<HTMLTextAreaElement>("#paste")?.value ?? "" };
    app.innerHTML = template(view, ports, typed);
    applyTab(app, tab);
    app.querySelectorAll<HTMLButtonElement>("[data-tab-go]").forEach((button) => button.addEventListener("click", () => {
      tab = button.dataset["tabGo"] ?? "now";
      try { localStorage.setItem(TAB_KEY, tab); } catch { /* private mode */ }
      applyTab(app, tab);
      window.scrollTo?.({ top: 0 });
    }));
    app.querySelector("#invert")?.addEventListener("change", (event) => ports.setInvert((event.target as HTMLInputElement).checked));
    app.querySelector("#language")?.addEventListener("change", (event) => ports.setLocale((event.target as HTMLSelectElement).value as Locale));
    app.querySelector("#now-live")?.addEventListener("click", (event) => { if ((event.target as HTMLElement | null)?.closest?.("#toggle")) ports.toggle(); });
    const titleFor = (fallback: string): string => app.querySelector<HTMLInputElement>("#title")?.value.trim() || fallback;
    app.querySelector("#transcript-file")?.addEventListener("change", (event) => {
      const file = (event.target as HTMLInputElement).files?.[0];
      if (file) ports.openFile(file, titleFor(file.name.replace(/\.[^.]+$/, "")));
    });
    app.querySelector("#use-paste")?.addEventListener("click", () => ports.usePaste(app.querySelector<HTMLTextAreaElement>("#paste")?.value ?? "", titleFor("")));
    app.querySelector("#connect")?.addEventListener("click", () => ports.connect(app.querySelector<HTMLInputElement>("#endpoint")?.value.trim() ?? ""));
  };

  render();
  return {
    render,
    refreshLive: () => {
      const view = ports.getView();
      const set = (selector: string, html: string): void => {
        const el = app.querySelector<HTMLElement>(selector);
        // Unchanged parts are not touched, so playback never makes the page jump.
        if (el && typeof el.innerHTML === "string" && el.innerHTML !== html) el.innerHTML = html;
      };
      const pill = app.querySelector<HTMLElement>("#pill");
      if (pill && typeof pill.textContent === "string") {
        const state = pillOf(view.state);
        if (pill.textContent !== state.text) pill.textContent = state.text;
        pill.classList?.toggle("on", state.on);
      }
      set("#now-live", nowInner(view));
      set("#captions-live", captionsInner(view));
    },
  };
}
