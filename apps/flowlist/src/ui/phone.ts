import { parseMarkdown, parsePack, toPack } from "../checklist/parse";
import type { Checklist } from "../checklist/model";
import { currentStep, positionOf, type RunState } from "../checklist/run";
import { SAMPLE_IDS } from "../checklist/sample";
import { counts } from "../cockpit/model";
import { getLocale, languageSelect, setLocale, type Locale } from "../i18n";
import { t } from "../messages";
import { VERSION } from "../version";
import {
  activeList, addSamples, nextListId, removeList, samplesMissing, setSettings, upsertList,
  type FlowListData, type FlowListSettings,
} from "../storage/persist";

/**
 * The phone companion (QUS v1, the look of Rain Lens): exactly three tabs -
 * Jetzt (the run at a glance), Aufgaben (the lists, add a new one) and
 * Einstellungen (display, glasses, language). Checklists are written or pasted
 * here; the glasses only run them. Export produces a pack file the user can
 * share however they like - FlowList never uploads anything.
 */

export interface PhoneRun {
  readonly list: Checklist;
  readonly state: RunState;
}

export interface PhoneUiPorts {
  /** Must already reflect a `setData` call by the time that call returns its promise. */
  readonly getData: () => FlowListData;
  readonly setData: (data: FlowListData) => Promise<void>;
  /** The run on the glasses; without it "Jetzt" shows the stored list from its first step. */
  readonly getRun?: () => PhoneRun;
  /** Starts the run over (asked twice on the phone). */
  readonly restartRun?: () => void;
  /** Language shown; defaults to the device language. */
  readonly locale?: () => Locale;
  /** Called after the user picked another language, so the glasses follow. */
  readonly onLocaleChange?: (locale: Locale) => void;
}

export interface PhoneUi {
  /** Redraws the live parts (status pill, "Jetzt") after the run moved, leaving every input untouched. */
  readonly refreshLive: () => void;
}

/** Text fields that hold an unsaved draft and must survive a re-render. */
const DRAFT_FIELDS = ["source"] as const;

/** The three tabs. */
export const TABS: readonly { id: string; icon: string; key: string }[] = [
  { id: "now", icon: "📋", key: "p.tabNow" },
  { id: "lists", icon: "✅", key: "p.tabLists" },
  { id: "settings", icon: "⚙️", key: "p.tabSettings" },
];
const TAB_KEY = "quietglass.flowlist.tab";

/** How long the second tap on a dangerous button is waited for. */
const ARM_MS = 4000;

/** Nothing of your own yet (only the example lists): Einstellungen opens first, with the three-step checklist. */
export function isFirstRun(data: FlowListData): boolean {
  return data.lists.every((list) => (SAMPLE_IDS as readonly string[]).includes(list.id));
}

function readTab(firstRun: boolean): string {
  try { const v = localStorage.getItem(TAB_KEY); if (TABS.some((tab) => tab.id === v)) return v!; } catch { /* no storage */ }
  return firstRun ? "settings" : "now";
}

/** Shows only the active tab; the choice survives redraws and restarts. */
function applyTab(root: HTMLElement, active: string): void {
  root.querySelectorAll<HTMLElement>("[data-tab]").forEach((el) => { el.hidden = el.dataset["tab"] !== active; });
  root.querySelectorAll<HTMLButtonElement>("[data-tab-go]").forEach((button) => {
    const on = button.dataset["tabGo"] === active;
    button.classList.toggle("on", on);
    button.setAttribute("aria-selected", String(on));
  });
}

type Commit = (
  next: FlowListData,
  options?: { readonly keepDraft?: boolean; readonly notice?: string },
) => void;

// ---- pure view models (tests read these) ----------------------------------------------

export interface Banner { readonly tone: "ok" | "warn" | "none"; readonly text: string }

/** The one message that counts right now. */
export function bannerFor(list: Checklist, state: RunState, locale: Locale): Banner {
  const x = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  if (list.steps.length === 0) return { tone: "none", text: x("p.bannerNone") };
  const c = counts(list, state);
  if (c.finished) return { tone: "ok", text: x("p.bannerDone") };
  const step = currentStep(list, state);
  if (!step) return { tone: "ok", text: x("p.bannerDone") };
  if (state.awaitingConfirm) return { tone: "warn", text: x("p.bannerConfirm", { text: step.text }) };
  return { tone: step.kind === "critical" ? "warn" : "ok", text: x("p.bannerNow", { text: step.text }) };
}

const esc = (text: string): string => escapeHtml(text);

/** The current step and the ones after it, as cards for the horizontal strip. */
export function upcoming(list: Checklist, state: RunState, max = 6): Checklist["steps"] {
  if (state.currentId === null) return [];
  const at = list.steps.findIndex((step) => step.id === state.currentId);
  return at === -1 ? [] : list.steps.slice(at, at + max);
}

/** "Jetzt": banner, hero card with one big value, 2 x 2 key figures, a card per coming step. */
export function nowInner(list: Checklist, state: RunState, locale: Locale): string {
  const x = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  const empty = list.steps.length === 0;
  const c = counts(list, state);
  const banner = bannerFor(list, state, locale);
  const stat = (label: string, value: string, unit: string, alert = false): string =>
    `<div${alert ? ' class="alert"' : ""}><span>${esc(label)}</span><b>${esc(value)}</b><small>${esc(unit)}</small></div>`;
  const dash = "–";
  const position = c.finished ? list.steps.length : positionOf(list, state);
  const cards = upcoming(list, state).map((step, index) => {
    const tone = step.kind === "critical" ? " tone-warn" : "";
    const kind = step.kind === "critical" ? x("p.kindCritical") : step.kind === "optional" ? x("p.kindOptional") : step.kind === "choice" ? x("p.kindChoice") : "";
    const number = list.steps.findIndex((candidate) => candidate.id === step.id) + 1;
    return `<div class="step-card${tone}${index === 0 ? " now" : ""}"><b>${number}</b><span>${esc(step.text)}</span>${kind ? `<em>${esc(kind)}</em>` : ""}</div>`;
  });
  return `
    <p class="banner tone-${banner.tone}">${esc(banner.text)}</p>
    <section class="card hero-card">
      <div class="hero">
        <div><span>${esc(x("p.heroLabel"))}</span><strong>${esc(empty ? dash : String(c.open))}</strong></div>
        <p>${esc(empty ? "" : x("p.heroSide", { title: list.title }))}</p>
      </div>
      <div class="stats">
        ${stat(x("p.statStep"), empty ? dash : String(position), empty ? "" : x("p.unitOf", { n: list.steps.length }))}
        ${stat(x("p.statDone"), empty ? dash : String(c.done), x("p.unitSteps"))}
        ${stat(x("p.statCritical"), empty ? dash : String(c.criticalLeft), x("p.unitLeft"), c.criticalLeft > 0)}
        ${stat(x("p.statSkipped"), empty ? dash : String(c.skipped), x("p.unitOptional"))}
      </div>
    </section>
    ${cards.length > 0 ? `<h2 class="strip-title">${esc(x("p.stripTitle"))}</h2><div class="strip">${cards.join("")}</div>` : (empty ? "" : `<p class="hint">${esc(x("p.stripEmpty"))}</p>`)}`;
}

/** First-run checklist: pure, so tests can read it. */
export function setupInner(data: FlowListData, locale: Locale): string {
  const x = (key: string): string => t(locale, key);
  const own = data.lists.filter((list) => !(SAMPLE_IDS as readonly string[]).includes(list.id));
  const added = own.length > 0;
  const selected = added && own.some((list) => list.id === activeList(data)?.id);
  const step = (n: number, done: boolean, key: string): string =>
    `<li class="${done ? "done" : ""}"><span class="num" aria-hidden="true">${done ? "✓" : n}</span><span>${esc(x(key))}</span></li>`;
  return `<ol class="steps">${step(1, added, "p.setup1")}${step(2, selected, "p.setup2")}${step(3, selected, "p.setup3")}</ol>`
    + (added ? "" : `<p class="hint">${esc(x("p.setupDemo"))}</p>`);
}

function pillOf(list: Checklist | null, locale: Locale): { text: string; on: boolean } {
  return list && list.steps.length > 0 ? { text: "● " + list.title, on: true } : { text: t(locale, "p.pillNone"), on: false };
}

// ---- mounting ---------------------------------------------------------------------------

export function mountPhoneUi(ports: PhoneUiPorts): PhoneUi {
  const root = document.getElementById("app");
  if (!root) return { refreshLive: () => undefined };

  let notice = "";
  let locale: Locale = ports.locale?.() ?? getLocale();
  let tab = readTab(isFirstRun(ports.getData()));

  const run = (): PhoneRun => {
    if (ports.getRun) return ports.getRun();
    const list = activeList(ports.getData()) ?? { id: "", title: "", steps: [] };
    return { list, state: { listId: list.id, currentId: list.steps[0]?.id ?? null, status: {}, history: [], awaitingConfirm: false, choiceIndex: 0, startedAt: 0, finishedAt: null } };
  };

  // Re-rendered after every change, so the lists show what is stored. Handlers
  // always read the current data: a closure over the data of the first render
  // would compute the next change from a stale state and undo the previous one.
  const render = (keepDraft = true): void => {
    const draft = keepDraft ? readDraft(root) : null;
    if (document.documentElement) document.documentElement.lang = locale;
    root.innerHTML = template(ports.getData(), run(), notice, locale);
    notice = "";
    if (draft) writeDraft(root, draft);
    applyTab(root, tab);
    root.querySelectorAll<HTMLButtonElement>("[data-tab-go]").forEach((button) => {
      button.addEventListener("click", () => {
        tab = button.dataset["tabGo"] ?? "now";
        try { localStorage.setItem(TAB_KEY, tab); } catch { /* private mode */ }
        applyTab(root, tab);
        window.scrollTo({ top: 0 });
      });
    });
    wire(root, ports.getData, commit, (message) => { notice = message; render(); }, locale, ports.restartRun);
    root.querySelector<HTMLSelectElement>("#language")?.addEventListener("change", (event) => {
      const value = (event.target as HTMLSelectElement).value;
      if (value !== "de" && value !== "en") return;
      locale = value;
      setLocale(locale);
      ports.onLocaleChange?.(locale);
      render();
    });
  };

  const commit: Commit = (next, options = {}) => {
    const saving = ports.setData(next);
    notice = options.notice ?? "";
    render(options.keepDraft ?? true);
    saving.catch((error: unknown) => {
      console.warn("[flowlist] save failed:", error);
      notice = t(locale, "p.saveFailed", { error: error instanceof Error ? error.message : String(error) });
      render();
    });
  };

  render();
  return {
    refreshLive: () => {
      const { list, state } = run();
      const html = nowInner(list, state, locale);
      const live = root.querySelector<HTMLElement>("#now-live");
      // An unchanged part is not touched, so the page never jumps.
      if (live && live.innerHTML !== html) live.innerHTML = html;
      const pill = root.querySelector<HTMLElement>("#pill");
      if (pill) {
        const shown = pillOf(activeList(ports.getData()), locale);
        if (pill.textContent !== shown.text) pill.textContent = shown.text;
        pill.classList?.toggle("on", shown.on);
      }
    },
  };
}

function readDraft(root: HTMLElement): Map<string, string> {
  const draft = new Map<string, string>();
  for (const id of DRAFT_FIELDS) {
    const field = root.querySelector<HTMLInputElement | HTMLTextAreaElement>("#" + id);
    if (field) draft.set(id, field.value);
  }
  return draft;
}

function writeDraft(root: HTMLElement, draft: Map<string, string>): void {
  for (const [id, value] of draft) {
    const field = root.querySelector<HTMLInputElement | HTMLTextAreaElement>("#" + id);
    if (field) field.value = value;
  }
}

function template(data: FlowListData, runState: PhoneRun, notice: string, locale: Locale): string {
  const s = data.settings;
  const L = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  const active = activeList(data);
  const firstRun = isFirstRun(data);
  const pill = pillOf(active, locale);
  return `
  <header class="brand bar">
    <div>
      <div class="brand-mark">${esc(L("p.kicker"))}</div>
      <h1>FlowList</h1>
    </div>
    <span id="pill" class="chip${pill.on ? " on" : ""}">${esc(pill.text)}</span>
  </header>

  ${notice ? '<p class="notice">' + escapeHtml(notice) + "</p>" : ""}

  <div class="tab" data-tab="now" id="now">
    <div id="now-live">${nowInner(runState.list, runState.state, locale)}</div>
    ${runState.list.steps.length > 0 ? `<button id="restart" type="button" class="big">${esc(L("p.restart"))}</button>` : ""}
  </div>

  <div class="tab" data-tab="lists">
    <section class="card">
      <h2>${L("p.lists")}</h2>
      <p class="hint">${data.lists.length === 0 ? L("p.noneYet") : L("p.pickHint")}</p>
      <ul class="scripts">
        ${data.lists.map((list) => `
        <li>
          <label>
            <input type="radio" name="active" value="${esc(list.id)}"
              ${list.id === active?.id ? "checked" : ""} />
            <span>${esc(list.title)} <em>(${L("p.steps", { n: list.steps.length })})</em></span>
          </label>
          <span class="row-actions">
            <button type="button" class="export" data-id="${esc(list.id)}">${L("p.export")}</button>
            <button type="button" class="remove" data-id="${esc(list.id)}">${L("p.remove")}</button>
          </span>
        </li>`).join("")}
      </ul>
      ${samplesMissing(data) ? `<button id="samples" type="button">${L("p.addExamples")}</button>` : ""}
    </section>

    <details class="fold card"${data.lists.length === 0 ? " open" : ""}>
      <summary>${L("p.addTitle")}</summary>
      <label for="source">${L("p.sourceLabel")}</label>
      <textarea id="source" rows="10" placeholder="${L("p.placeholder")}"></textarea>
      <p class="hint">${L("p.syntax")}</p>
      <button id="add" type="button" class="big">${L("p.addButton")}</button>
    </details>
  </div>

  <div class="tab" data-tab="settings">
    ${firstRun ? `<section class="card setup"><h2>${L("p.setupTitle")}</h2>${setupInner(data, locale)}</section>` : ""}

    <section class="card">
      <h2>${L("p.display")}</h2>
      <label class="check"><input id="next" type="checkbox" ${s.showNext ? "checked" : ""} /> ${L("p.showNext")}</label>
      <label for="width">${L("p.width")} — <output id="width-out">${s.lineWidth}</output></label>
      <input id="width" type="range" min="20" max="80" step="2" value="${s.lineWidth}" />
    </section>

    <section class="card">
      <h2>${L("p.glassesTitle")}</h2>
      <label class="check"><input id="invert" type="checkbox" ${s.invertScroll ? "checked" : ""} /> ${L("p.invert")}</label>
      <p class="hint">${L("p.invertHint")}</p>
      <details class="fold">
        <summary>${L("p.controls")}</summary>
        <table class="keys">
          ${(["tap", "swipe", "hold", "end", "double"] as const)
            .map((key) => `<tr><td>${L("p.key." + key)}</td><td>${L("p.key." + key + "Do")}</td></tr>`).join("")}
        </table>
        <p class="hint">${L("p.controlsHint")}</p>
      </details>
    </section>

    <section class="card compact">${languageSelect(locale)}</section>

    <details class="fold card">
      <summary>${L("p.moreTitle")}</summary>
      <p><strong>FlowList</strong> · ${L("p.moreVersion")} ${VERSION}</p>
      <p class="hint">${L("p.privacy")}</p>
    </details>
  </div>

  <nav class="tabbar" role="tablist">
    ${TABS.map(({ id, icon, key }) => `<button type="button" role="tab" data-tab-go="${id}"><span aria-hidden="true">${icon}</span>${esc(L(key))}</button>`).join("")}
  </nav>`;
}

function wire(
  root: HTMLElement,
  current: () => FlowListData,
  commit: Commit,
  notify: (message: string) => void,
  locale: Locale,
  restartRun: (() => void) | undefined,
): void {
  const byId = <T extends HTMLElement>(id: string): T | null => root.querySelector<T>("#" + id);

  byId<HTMLButtonElement>("add")?.addEventListener("click", () => {
    const source = byId<HTMLTextAreaElement>("source")?.value ?? "";
    if (!source.trim()) {
      notify(t(locale, "p.emptySource"));
      return;
    }
    const data = current();

    const id = nextListId(data);
    // A pack is JSON; anything else is treated as Markdown.
    const looksLikeJson = source.trim().startsWith("{");
    const result = looksLikeJson ? parsePack(source, locale) : parseMarkdown(source, id, locale);

    if (result.checklist.steps.length === 0) {
      notify([...result.warnings, t(locale, "p.unreadable")].join(" "));
      return;
    }

    commit(upsertList(data, { ...result.checklist, id }), {
      keepDraft: false,
      notice: [t(locale, "p.added", { title: result.checklist.title }), ...result.warnings].join(" "),
    });
  });

  byId<HTMLButtonElement>("samples")?.addEventListener("click", () => {
    commit(addSamples(current(), locale), { notice: t(locale, "p.examplesAdded") });
  });

  // Dangerous things ask twice: the first tap asks, a second one within a few seconds does it.
  const askTwice = (button: HTMLButtonElement, confirmLabel: string, act: () => void): void => {
    let armedUntil = 0;
    const label = button.textContent;
    button.addEventListener("click", () => {
      if (Date.now() < armedUntil) { armedUntil = 0; act(); return; }
      armedUntil = Date.now() + ARM_MS;
      button.textContent = confirmLabel;
      button.classList?.add("danger");
      setTimeout(() => { armedUntil = 0; button.textContent = label; button.classList?.remove("danger"); }, ARM_MS);
    });
  };

  root.querySelectorAll<HTMLButtonElement>(".remove").forEach((button) => {
    askTwice(button, t(locale, "p.removeConfirm"), () => {
      const id = button.dataset["id"];
      if (id) commit(removeList(current(), id));
    });
  });

  const restart = byId<HTMLButtonElement>("restart");
  if (restart) askTwice(restart, t(locale, "p.restartConfirm"), () => restartRun?.());

  root.querySelectorAll<HTMLButtonElement>(".export").forEach((button) => {
    button.addEventListener("click", () => {
      const list = current().lists.find((l) => l.id === button.dataset["id"]);
      if (!list) return;
      download(fileName(list.title) + ".flowlist.json", toPack(list));
    });
  });

  root.querySelectorAll<HTMLInputElement>('input[name="active"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      if (radio.checked) commit({ ...current(), activeId: radio.value });
    });
  });

  const patch = (change: Partial<FlowListSettings>): void => commit(setSettings(current(), change));

  byId<HTMLInputElement>("next")?.addEventListener("change", (event) => {
    patch({ showNext: (event.target as HTMLInputElement).checked });
  });
  byId<HTMLInputElement>("invert")?.addEventListener("change", (event) => {
    patch({ invertScroll: (event.target as HTMLInputElement).checked });
  });

  const width = byId<HTMLInputElement>("width");
  const widthOut = byId("width-out");
  width?.addEventListener("input", () => { if (widthOut) widthOut.textContent = width.value; });
  width?.addEventListener("change", () => patch({ lineWidth: Number(width.value) }));
}

/** A safe file name that keeps German titles readable ("ä" → "ae", "ß" → "ss"). */
export function fileName(title: string): string {
  const plain = title.toLowerCase()
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .normalize("NFD").replace(/[̀-ͯ]/g, "");
  return plain.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "checklist";
}

/** Hands the pack to the phone's own share/save sheet. Nothing is uploaded. */
function download(filename: string, content: string): void {
  const blob = new Blob([content], { type: "application/json" });
  const url = URL.createObjectURL(blob);
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
