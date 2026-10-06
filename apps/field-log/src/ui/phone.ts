import {
  activeInspection, approximateBytes, hasSpeechServer, maskSecret, nextInspectionId, removeInspection,
  upsertInspection, validateWsUrl, type FieldLogData,
} from "../storage/persist";
import {
  addEntry, countBySeverity, finish, removeEntry, setSection, setSeverity, startInspection,
  toCsv, toMarkdown, type Severity,
} from "../log/entries";
import { getLocale, languageSelect, setLocale, type Locale } from "../i18n";
import { autoTitle, quickNotes, severityName, t } from "../messages";

/**
 * The phone companion: starting an inspection, reviewing entries, exporting.
 *
 * Reviewing belongs here rather than on the glasses — during a walk the
 * glasses should not slow you down, and afterwards a phone screen is simply
 * better for reading a report.
 */

export interface PhoneUiPorts {
  /** Must already reflect a `setData` call by the time that call returns its promise. */
  readonly getData: () => FieldLogData;
  readonly setData: (data: FieldLogData) => Promise<void>;
  /** Language shown; defaults to the device language. */
  readonly locale?: () => Locale;
  /** Called after the user picked another language, so the glasses follow. */
  readonly onLocaleChange?: (locale: Locale) => void;
  /** Opens the phone camera and files the photo; absent outside the Even app. */
  readonly takePhoto?: () => Promise<void>;
}

export interface PhoneUi {
  /** Redraws the page after a change made on the glasses. */
  readonly refresh: () => void;
}

/** Warn before per-app storage becomes a problem. */
const SIZE_WARN_BYTES = 4 * 1024 * 1024;

/** Text fields that hold an unsaved draft and must survive a re-render. */
const DRAFT_FIELDS = ["title", "note", "quick", "stt", "stt-token", "lang"] as const;

const SEVERITIES: readonly Severity[] = ["note", "minor", "major"];

type Commit = (next: FieldLogData, options?: { readonly keepDraft?: boolean; readonly notice?: string }) => void;

interface View {
  readonly locale: Locale;
  readonly notice: string;
  readonly advancedOpen: boolean;
  readonly canPhoto: boolean;
}

export function mountPhoneUi(ports: PhoneUiPorts): PhoneUi {
  const root = document.getElementById("app");
  if (!root) return { refresh: () => undefined };

  let notice = "";
  let locale: Locale = ports.locale?.() ?? getLocale();
  /** The advanced section stays open while the user works in it. */
  let advancedOpen = false;

  // Re-rendered after every change. Handlers always read the current data:
  // the glasses file entries while this page is open, and a change computed
  // from the data of the last render would write those entries away again.
  const render = (keepDraft = true): void => {
    const draft = keepDraft ? readDraft(root) : null;
    root.innerHTML = template(ports.getData(), { locale, notice, advancedOpen, canPhoto: Boolean(ports.takePhoto) });
    notice = "";
    if (draft) writeDraft(root, draft);
    const notify = (message: string): void => { notice = message; render(); };
    wire(root, ports, commit, notify, locale, () => { advancedOpen = true; });
    root.querySelector<HTMLSelectElement>("#language")?.addEventListener("change", (event) => {
      const value = (event.target as HTMLSelectElement).value;
      if (value !== "de" && value !== "en") return;
      locale = value;
      setLocale(locale);
      ports.onLocaleChange?.(locale);
      // Drafts are dropped: the quick-note box would keep the old language.
      render(false);
    });
  };

  const commit: Commit = (next, options = {}) => {
    const saving = ports.setData(next);
    notice = options.notice ?? "";
    render(options.keepDraft ?? true);
    saving.catch((error: unknown) => {
      console.warn("[fieldlog] save failed:", error);
      notice = t(locale, "p.saveFailed", { error: error instanceof Error ? error.message : String(error) });
      render();
    });
  };

  render();
  return { refresh: () => render() };
}

function readDraft(root: HTMLElement): Map<string, string> {
  const draft = new Map<string, string>();
  for (const id of DRAFT_FIELDS) {
    const field = root.querySelector<HTMLInputElement>("#" + id);
    if (field) draft.set(id, field.value);
  }
  return draft;
}

function writeDraft(root: HTMLElement, draft: Map<string, string>): void {
  for (const [id, value] of draft) {
    const field = root.querySelector<HTMLInputElement>("#" + id);
    if (field) field.value = value;
  }
}

function template(data: FieldLogData, view: View): string {
  const { locale } = view;
  const L = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  const active = data.activeId ? data.inspections.find((i) => i.id === data.activeId) : null;
  const bytes = approximateBytes(data);
  const voice = hasSpeechServer(data);
  const severityOptions = (selected: Severity): string => SEVERITIES.map((s) =>
    '<option value="' + s + '"' + (s === selected ? " selected" : "") + ">" + escapeHtml(severityName(locale, s)) + "</option>").join("");

  return `
  <header class="brand">
    <span class="brand-mark">Quietglass</span>
    <h1>FieldLog</h1>
    <p class="hint">${L("p.lede")}</p>
  </header>

  ${view.notice ? '<p class="notice">' + escapeHtml(view.notice) + "</p>" : ""}

  <section class="card">
    <h2>${L("p.start")}</h2>
    ${active
      ? `<p>${L("p.running", { title: escapeHtml(active.title) })} ${L(voice ? "p.nextVoice" : "p.nextQuick")}</p>`
      : `<p>${L("p.noneYet")}</p>`}
    ${languageSelect(locale)}
  </section>

  <section class="card">
    <h2>${active ? L("p.current") : L("p.startTitle")}</h2>
    ${active ? `
      <p class="hint"><strong>${escapeHtml(active.title)}</strong> — ${L("p.entryCount", { n: active.entries.length })}</p>
      <label for="section">${L("p.section")}</label>
      <input id="section" type="text" value="${escapeHtml(active.section)}" placeholder="${L("p.sectionPlaceholder")}" />
      <p class="hint">${L("p.sectionHint")}</p>
      <button id="finish" type="button">${L("p.finish")}</button>
    ` : `
      <label for="title">${L("p.titleLabel")}</label>
      <input id="title" type="text" placeholder="${L("p.titlePlaceholder")}" />
      <button id="start" type="button">${L("p.startButton")}</button>
    `}
  </section>

  ${active ? `
  <section class="card">
    <h2>${L("p.addNote")}</h2>
    <input id="note" type="text" placeholder="${L("p.notePlaceholder")}" />
    <label for="note-sev">${L("p.noteSeverity")}</label>
    <select id="note-sev">${severityOptions(data.severity)}</select>
    <button id="add-note" type="button">${L("p.addNoteButton")}</button>
    ${view.canPhoto ? `<button id="photo" type="button" class="secondary">${L("p.photoButton")}</button>
    <p class="hint">${L("p.photoHint")}</p>` : ""}
  </section>

  <section class="card">
    <h2>${L("p.entries")}</h2>
    ${active.entries.length === 0 ? `<p class="hint">${L("p.entriesEmpty")}</p>` : `
      <table class="keys">
        ${active.entries.map((e) => `
          <tr>
            <td>${severityBadge(e.severity)}</td>
            <td>${escapeHtml(e.text)}${e.attachment ? " 📷" : ""}<br />
                <small>${escapeHtml(e.section ?? "")}</small></td>
            <td>
              <select class="sev" data-id="${escapeHtml(e.id)}">${severityOptions(e.severity)}</select>
              <button type="button" class="drop" data-id="${escapeHtml(e.id)}" title="${L("p.removeEntry")}" aria-label="${L("p.removeEntry")}">✕</button>
            </td>
          </tr>`).join("")}
      </table>
      <button id="md" type="button" class="secondary">${L("p.exportMd")}</button>
      <button id="md-img" type="button" class="secondary">${L("p.exportMdImg")}</button>
      <button id="csv" type="button" class="secondary">${L("p.exportCsv")}</button>
    `}
  </section>` : ""}

  <section class="card">
    <h2>${L("p.past")}</h2>
    ${data.inspections.length === 0 ? `<p class="hint">${L("p.pastEmpty")}</p>` : `
      <ul class="scripts">
        ${data.inspections.map((i) => {
          const counts = countBySeverity(i);
          const date = new Date(i.startedAt).toLocaleDateString(locale === "de" ? "de-AT" : "en-GB");
          return `<li>
            <span>${escapeHtml(i.title)}<br />
              <small>${L("p.pastLine", { date, n: i.entries.length, major: counts.major })}${i.finishedAt === null ? " · " + L("p.stillOpen") : ""}</small></span>
            <span class="row-actions">
              ${i.id === data.activeId ? "" : '<button type="button" class="open" data-id="' + escapeHtml(i.id) + '">' + L("p.open") + "</button>"}
              <button type="button" class="remove" data-id="${escapeHtml(i.id)}">${L("p.remove")}</button>
            </span>
          </li>`;
        }).join("")}
      </ul>`}
    <p class="hint">
      ${L("p.size", { kb: Math.round(bytes / 1024) })}
      ${bytes > SIZE_WARN_BYTES ? "<strong>" + L("p.sizeWarn") + "</strong>" : ""}
    </p>
  </section>

  <section class="card">
    <h2>${L("p.quick")}</h2>
    <label for="quick">${L("p.quickHint")}</label>
    <textarea id="quick" rows="7">${escapeHtml(quickNotes(locale, data.quickNotes).join("\n"))}</textarea>
    <button id="save-quick" type="button">${L("p.quickSave")}</button>
  </section>

  <section class="card">
    <h2>${L("p.controls")}</h2>
    <table class="keys">
      <tr><td>${L("p.key.tap")}</td><td>${L(voice ? "p.key.tapVoice" : "p.key.tapQuick")}</td></tr>
      <tr><td>${L("p.key.swipe")}</td><td>${L("p.key.swipeDo")}</td></tr>
      <tr><td>${L("p.key.hold")}</td><td>${L("p.key.holdDo")}</td></tr>
      <tr><td>${L("p.key.double")}</td><td>${L("p.key.doubleDo")}</td></tr>
    </table>
    <label class="check"><input id="invert" type="checkbox" ${data.invertScroll ? "checked" : ""} /> ${L("p.invert")}</label>
    <p class="hint">${L("p.invertHint")}</p>
  </section>

  <details class="card"${view.advancedOpen ? " open" : ""}>
    <summary><h2>${L("p.advanced")}</h2></summary>
    <p class="hint">${L("p.advancedHint")}</p>
    <p class="hint"><strong>${L(voice ? "p.modeVoice" : "p.modeQuick")}</strong></p>
    <label for="stt">${L("p.server")}</label>
    <input id="stt" type="text" value="${escapeHtml(data.sttUrl)}" placeholder="wss://your-host:9000/asr" />
    <label for="stt-token">${L("p.token", { state: "<em>" + escapeHtml(maskSecret(data.sttToken, locale)) + "</em>" })}</label>
    <input id="stt-token" type="password" />
    <label for="lang">${L("p.speechLanguage")}</label>
    <input id="lang" type="text" value="${escapeHtml(data.language)}" placeholder="auto, de, en …" />
    <button id="save-stt" type="button">${L("p.saveServer")}</button>
  </details>

  <footer class="hint">${L("p.privacy")}</footer>`;
}

function severityBadge(severity: Severity): string {
  if (severity === "major") return "<strong>!</strong>";
  if (severity === "minor") return "·";
  return "";
}

function wire(
  root: HTMLElement,
  ports: PhoneUiPorts,
  commit: Commit,
  notify: (message: string) => void,
  locale: Locale,
  keepAdvancedOpen: () => void,
): void {
  const current = ports.getData;
  const byId = <T extends HTMLElement>(id: string): T | null => root.querySelector<T>("#" + id);
  /** The open inspection as it is now, not as it was when the page was drawn. */
  const active = (): ReturnType<typeof activeInspection> => activeInspection(current());

  // No name needed: an empty title gets the date and time.
  byId<HTMLButtonElement>("start")?.addEventListener("click", () => {
    const now = Date.now();
    const title = byId<HTMLInputElement>("title")?.value.trim() || autoTitle(locale, now);
    const data = current();
    const id = nextInspectionId(data);
    commit({ ...upsertInspection(data, startInspection(id, title, now)), activeId: id }, { keepDraft: false });
  });

  byId<HTMLButtonElement>("finish")?.addEventListener("click", () => {
    const open = active();
    if (!open) return;
    commit({ ...upsertInspection(current(), finish(open, Date.now())), activeId: null });
  });

  byId<HTMLInputElement>("section")?.addEventListener("change", (event) => {
    const open = active();
    if (!open) return;
    commit(upsertInspection(current(), setSection(open, (event.target as HTMLInputElement).value)));
  });

  byId<HTMLButtonElement>("add-note")?.addEventListener("click", () => {
    const open = active();
    const text = byId<HTMLInputElement>("note")?.value.trim() ?? "";
    if (!open) return;
    if (!text) { notify(t(locale, "p.noteEmpty")); return; }
    const severity = (byId<HTMLSelectElement>("note-sev")?.value || "note") as Severity;
    const field = byId<HTMLInputElement>("note");
    if (field) field.value = "";
    commit(upsertInspection(current(), addEntry(open, text, severity, Date.now())));
  });

  byId<HTMLButtonElement>("photo")?.addEventListener("click", () => {
    ports.takePhoto?.().catch((error: unknown) => { console.warn("[fieldlog] photo failed:", error); });
  });

  root.querySelectorAll<HTMLSelectElement>(".sev").forEach((select) => {
    select.addEventListener("change", () => {
      const id = select.dataset["id"];
      const open = active();
      if (open && id) commit(upsertInspection(current(), setSeverity(open, id, select.value as Severity)));
    });
  });

  root.querySelectorAll<HTMLButtonElement>(".drop").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset["id"];
      const open = active();
      if (open && id) commit(upsertInspection(current(), removeEntry(open, id)));
    });
  });

  root.querySelectorAll<HTMLButtonElement>(".open").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset["id"];
      if (id) commit({ ...current(), activeId: id });
    });
  });

  root.querySelectorAll<HTMLButtonElement>(".remove").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset["id"];
      if (id) commit(removeInspection(current(), id));
    });
  });

  const fileName = (extension: string): string => safeName(active()?.title ?? t(locale, "x.file")) + "." + extension;

  byId<HTMLButtonElement>("md")?.addEventListener("click", () => {
    const open = active();
    if (open) download(fileName("md"), toMarkdown(open, false, locale), "text/markdown");
  });
  byId<HTMLButtonElement>("md-img")?.addEventListener("click", () => {
    const open = active();
    if (open) download(fileName("full.md"), toMarkdown(open, true, locale), "text/markdown");
  });
  byId<HTMLButtonElement>("csv")?.addEventListener("click", () => {
    const open = active();
    if (open) download(fileName("csv"), toCsv(open, locale), "text/csv");
  });

  byId<HTMLButtonElement>("save-quick")?.addEventListener("click", () => {
    const lines = (byId<HTMLTextAreaElement>("quick")?.value ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
    // Saving the defaults unchanged keeps them following the app language.
    const defaults = quickNotes(locale, []);
    const same = lines.length === defaults.length && lines.every((line, i) => line === defaults[i]);
    commit({ ...current(), quickNotes: same ? [] : lines }, { keepDraft: false, notice: t(locale, "p.quickSaved") });
  });

  byId<HTMLInputElement>("invert")?.addEventListener("change", (event) => {
    commit({ ...current(), invertScroll: (event.target as HTMLInputElement).checked });
  });

  byId<HTMLButtonElement>("save-stt")?.addEventListener("click", () => {
    keepAdvancedOpen();
    const sttUrl = byId<HTMLInputElement>("stt")?.value.trim() ?? "";
    const check = validateWsUrl(sttUrl, locale);
    if (!check.valid) { notify(check.errors.join(" ")); return; }
    const token = byId<HTMLInputElement>("stt-token")?.value ?? "";
    const data = current();
    commit({
      ...data,
      sttUrl,
      ...(token ? { sttToken: token } : data.sttToken ? { sttToken: data.sttToken } : {}),
      language: byId<HTMLInputElement>("lang")?.value.trim() || "auto",
    }, { keepDraft: false, notice: t(locale, "p.serverSaved") });
  });
}

/** A safe file name that keeps German titles readable ("ä" → "ae", "ß" → "ss"). */
export function safeName(title: string): string {
  const plain = title.toLowerCase()
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return plain.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "inspection";
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
