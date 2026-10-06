import { parseMarkdown, parsePack, toPack } from "../checklist/parse";
import { getLocale, languageSelect, setLocale, type Locale } from "../i18n";
import { t } from "../messages";
import {
  activeList, addSamples, nextListId, removeList, samplesMissing, setSettings, upsertList,
  type FlowListData, type FlowListSettings,
} from "../storage/persist";

/**
 * The phone companion. Checklists are written or pasted here; the glasses only
 * run them. Export produces a pack file the user can share however they like —
 * FlowList never uploads anything.
 */

export interface PhoneUiPorts {
  /** Must already reflect a `setData` call by the time that call returns its promise. */
  readonly getData: () => FlowListData;
  readonly setData: (data: FlowListData) => Promise<void>;
  /** Language shown; defaults to the device language. */
  readonly locale?: () => Locale;
  /** Called after the user picked another language, so the glasses follow. */
  readonly onLocaleChange?: (locale: Locale) => void;
}

/** Text fields that hold an unsaved draft and must survive a re-render. */
const DRAFT_FIELDS = ["source"] as const;

type Commit = (
  next: FlowListData,
  options?: { readonly keepDraft?: boolean; readonly notice?: string },
) => void;

export function mountPhoneUi(ports: PhoneUiPorts): void {
  const root = document.getElementById("app");
  if (!root) return;

  let notice = "";
  let locale: Locale = ports.locale?.() ?? getLocale();

  // Re-rendered after every change, so the lists show what is stored. Handlers
  // always read the current data: a closure over the data of the first render
  // would compute the next change from a stale state and undo the previous one.
  const render = (keepDraft = true): void => {
    const draft = keepDraft ? readDraft(root) : null;
    root.innerHTML = template(ports.getData(), notice, locale);
    notice = "";
    if (draft) writeDraft(root, draft);
    wire(root, ports.getData, commit, (message) => { notice = message; render(); }, locale);
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

function template(data: FlowListData, notice: string, locale: Locale): string {
  const s = data.settings;
  const L = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  const active = activeList(data);
  return `
  <header class="brand">
    <span class="brand-mark">Quietglass</span>
    <h1>FlowList</h1>
    <p class="hint">${L("p.lede")}</p>
  </header>

  ${notice ? '<p class="notice">' + escapeHtml(notice) + "</p>" : ""}

  <section class="card">
    <h2>${L("p.start")}</h2>
    ${active
      ? `<p>${L("p.now", { title: escapeHtml(active.title) })} ${L("p.nextStep")}</p>`
      : `<p>${L("p.noneYet")}</p>`}
    ${languageSelect(locale)}
  </section>

  <section class="card">
    <h2>${L("p.lists")}</h2>
    <p class="hint">${data.lists.length === 0 ? L("p.listsEmpty") : L("p.pickHint")}</p>
    <ul class="scripts">
      ${data.lists.map((list) => `
        <li>
          <label>
            <input type="radio" name="active" value="${escapeHtml(list.id)}"
              ${list.id === active?.id ? "checked" : ""} />
            <span>${escapeHtml(list.title)} <em>(${L("p.steps", { n: list.steps.length })})</em></span>
          </label>
          <span class="row-actions">
            <button type="button" class="export" data-id="${escapeHtml(list.id)}">${L("p.export")}</button>
            <button type="button" class="remove" data-id="${escapeHtml(list.id)}">${L("p.remove")}</button>
          </span>
        </li>`).join("")}
    </ul>
    ${samplesMissing(data) ? `<button id="samples" type="button">${L("p.addExamples")}</button>` : ""}
  </section>

  <section class="card">
    <h2>${L("p.add")}</h2>
    <label for="source">${L("p.sourceLabel")}</label>
    <textarea id="source" rows="10" placeholder="${L("p.placeholder")}"></textarea>
    <p class="hint">${L("p.syntax")}</p>
    <button id="add" type="button">${L("p.addButton")}</button>
  </section>

  <section class="card">
    <h2>${L("p.display")}</h2>
    <label class="check"><input id="next" type="checkbox" ${s.showNext ? "checked" : ""} /> ${L("p.showNext")}</label>
    <label for="width">${L("p.width")} — <output id="width-out">${s.lineWidth}</output></label>
    <input id="width" type="range" min="20" max="80" step="2" value="${s.lineWidth}" />
    <label class="check"><input id="invert" type="checkbox" ${s.invertScroll ? "checked" : ""} /> ${L("p.invert")}</label>
    <p class="hint">${L("p.invertHint")}</p>
  </section>

  <section class="card">
    <h2>${L("p.controls")}</h2>
    <table class="keys">
      ${(["tap", "up", "down", "hold", "end", "double"] as const)
        .map((key) => `<tr><td>${L("p.key." + key)}</td><td>${L("p.key." + key + "Do")}</td></tr>`).join("")}
    </table>
    <p class="hint">${L("p.controlsHint")}</p>
  </section>

  <footer class="hint">${L("p.privacy")}</footer>`;
}

function wire(
  root: HTMLElement,
  current: () => FlowListData,
  commit: Commit,
  notify: (message: string) => void,
  locale: Locale,
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

  root.querySelectorAll<HTMLButtonElement>(".remove").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset["id"];
      if (id) commit(removeList(current(), id));
    });
  });

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
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
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
