import {
  activeInspection, approximateBytes, hasSpeechServer, maskSecret, nextInspectionId, removeInspection,
  upsertInspection, validateSttUrl, type FieldLogData,
} from "../storage/persist";
import {
  addEntry, countBySeverity, finish, removeEntry, setSection, setSeverity, startInspection,
  toCsv, toMarkdown, type Severity,
} from "../log/entries";
import { lastNoteAt, notesToday } from "../cockpit/model";
import { getLocale, languageSelect, setLocale, type Locale } from "../i18n";
import { autoTitle, quickNotes, severityName, t } from "../messages";
import { csvFormatFor } from "../csv";
import {
  checklistProgress, checklistText, exportWarning, itemCount, itemState, parseChecklist, photoMissing, roomProgress,
  templateText, warningSummary,
} from "../checklist/checklist";
import type { Inspection } from "../log/entries";

/**
 * The phone companion (QUS v1, the look of Rain Lens and Status Glass):
 * exactly three tabs - Jetzt (the state at a glance), Notizen (the entries of
 * the walk, export, all walks) and Einstellungen (language, speech server,
 * glasses).
 *
 * Reviewing belongs here rather than on the glasses - during a walk the
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
  /**
   * Opens the phone camera and files the photo; absent outside the Even app. With an item id the
   * photo belongs to that checklist item, otherwise to the latest entry.
   */
  readonly takePhoto?: (itemId?: string) => Promise<void>;
}

export interface PhoneUi {
  /** Redraws the page after a change made on the glasses. */
  readonly refresh: () => void;
}

/** Warn before per-app storage becomes a problem. */
const SIZE_WARN_BYTES = 4 * 1024 * 1024;

/** Text fields that hold an unsaved draft and must survive a re-render. */
const DRAFT_FIELDS = ["title", "note", "quick", "stt", "stt-token", "lang", "checklist"] as const;

/** The three exports; with open checklist points the phone names them first. */
export type ExportKind = "md" | "md-img" | "csv";

/** Exactly three tabs (QUS v1): the state now, the notes, the settings. */
export const TABS: readonly { id: string; icon: string; key: string }[] = [
  { id: "now", icon: "🎙️", key: "p.tabNow" },
  { id: "notes", icon: "📝", key: "p.tabNotes" },
  { id: "settings", icon: "⚙️", key: "p.tabSettings" },
];
const TAB_KEY = "quietglass.field-log.tab";
/** How long the second tap on a destructive button is waited for. */
const ARM_MS = 4000;

/** Nothing set up yet: Einstellungen opens first, with the three-step checklist. */
export function isFirstRun(data: FieldLogData): boolean {
  return data.inspections.length === 0 && !hasSpeechServer(data);
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

const SEVERITIES: readonly Severity[] = ["note", "minor", "major"];

type Commit = (next: FieldLogData, options?: { readonly keepDraft?: boolean; readonly notice?: string }) => void;

/** Asks for a second tap on `key` within ARM_MS before `run` happens (destructive buttons). */
type Arm = (key: string, run: () => void) => void;

interface View {
  readonly locale: Locale;
  readonly notice: string;
  readonly canPhoto: boolean;
  readonly now: number;
  /** The destructive button waiting for its second tap, if any. */
  readonly armed: string | null;
  /** An export held back by the checklist warning ("export anyway" / "back"). */
  readonly exportAsk: ExportKind | null;
}

/** Asks before an export (`kind`), or clears the question (null). */
type Ask = (kind: ExportKind | null) => void;

export function mountPhoneUi(ports: PhoneUiPorts): PhoneUi {
  const root = document.getElementById("app");
  if (!root) return { refresh: () => undefined };

  let notice = "";
  let locale: Locale = ports.locale?.() ?? getLocale();
  let tab = readTab(isFirstRun(ports.getData()));
  let armed: { key: string; until: number } | null = null;
  let exportAsk: ExportKind | null = null;

  // Re-rendered after every change. Handlers always read the current data:
  // the glasses file entries while this page is open, and a change computed
  // from the data of the last render would write those entries away again.
  const render = (keepDraft = true): void => {
    const draft = keepDraft ? readDraft(root) : null;
    const armedKey = armed !== null && armed.until > Date.now() ? armed.key : null;
    root.innerHTML = template(ports.getData(), { locale, notice, canPhoto: Boolean(ports.takePhoto), now: Date.now(), armed: armedKey, exportAsk });
    notice = "";
    if (draft) writeDraft(root, draft);
    const notify = (message: string): void => { notice = message; render(); };
    applyTab(root, tab);
    root.querySelectorAll<HTMLButtonElement>("[data-tab-go]").forEach((button) => {
      button.addEventListener("click", () => {
        tab = button.dataset["tabGo"] ?? "now";
        try { localStorage.setItem(TAB_KEY, tab); } catch { /* private mode */ }
        applyTab(root, tab);
        window.scrollTo({ top: 0 });
      });
    });
    wire(root, ports, commit, notify, locale, arm, ask, exportAsk);
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

  const arm: Arm = (key, run) => {
    if (armed !== null && armed.key === key && armed.until > Date.now()) { armed = null; run(); return; }
    armed = { key, until: Date.now() + ARM_MS };
    render();
    setTimeout(() => { if (armed?.key === key) { armed = null; render(); } }, ARM_MS + 50);
  };

  const ask: Ask = (kind) => { exportAsk = kind; render(); };

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

// ---- pure view models (tests read these) ----------------------------------------------

export interface PhoneSummary {
  /** Notes made today, over every walk. */
  readonly today: number;
  /** Entries of the open walk. */
  readonly walk: number;
  readonly major: number;
  readonly minor: number;
  readonly note: number;
  readonly photos: number;
  readonly lastAt: number | null;
}

export function summarize(data: FieldLogData, now: number): PhoneSummary {
  const active = activeInspection(data);
  const entries = active?.entries ?? [];
  const counts = active ? countBySeverity(active) : { major: 0, minor: 0, note: 0 };
  return {
    today: notesToday(data.inspections, now),
    walk: entries.length,
    major: counts.major,
    minor: counts.minor,
    note: counts.note,
    photos: entries.filter((entry) => entry.attachment).length,
    lastAt: lastNoteAt(data.inspections),
  };
}

export interface Banner { readonly tone: "ok" | "none"; readonly text: string }

/** The one message that counts right now. */
export function bannerFor(data: FieldLogData, locale: Locale): Banner {
  const active = activeInspection(data);
  return active
    ? { tone: "ok", text: t(locale, "p.bannerRunning", { title: active.title }) }
    : { tone: "none", text: t(locale, "p.bannerNone") };
}

/** The status pill: a dot while a speech server is set up, a word otherwise. */
export function pillOf(data: FieldLogData, locale: Locale): { text: string; on: boolean } {
  return hasSpeechServer(data)
    ? { text: t(locale, "p.pillLive"), on: true }
    : { text: t(locale, "p.pillLocal"), on: false };
}

const esc = (text: string): string => escapeHtml(text);

/** "Jetzt": banner, hero card with one big value, 2 x 2 key figures, the one button, a strip of the latest notes. */
export function nowInner(data: FieldLogData, view: Pick<View, "locale" | "canPhoto" | "now">): string {
  const { locale } = view;
  const x = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  const active = activeInspection(data);
  const sum = summarize(data, view.now);
  const banner = bannerFor(data, locale);
  const stat = (label: string, value: number, unit: string, alert = false): string =>
    `<div${alert ? ' class="alert"' : ""}><span>${esc(label)}</span><b>${value}</b><small>${esc(unit)}</small></div>`;
  const recent = active ? [...active.entries].reverse().slice(0, 8) : [];
  const cards = recent.map((entry) => {
    const time = new Date(entry.at);
    const clock = `${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}`;
    return `<div class="host note-card sev-${entry.severity}"><em>${esc(severityName(locale, entry.severity))}</em><b>${esc(entry.text)}</b><span>${esc(clock)}${entry.attachment ? " 📷" : ""}</span></div>`;
  });
  const primary = active
    ? (view.canPhoto ? `<button id="photo" type="button" class="big">${esc(x("p.photoButton"))}</button>` : "")
    : `<label for="title">${esc(x("p.titleLabel"))}</label>
      <input id="title" type="text" placeholder="${esc(x("p.titlePlaceholder"))}" />
      <button id="start" type="button" class="big">${esc(x("p.startButton"))}</button>`;
  return `
    <p class="banner tone-${banner.tone}">${esc(banner.text)}</p>
    <section class="card hero-card">
      <div class="hero">
        <div><span>${esc(x("p.heroLabel"))}</span><strong>${sum.today}</strong></div>
        <p>${esc(active ? x("p.heroSide", { n: sum.walk }) : "–")}</p>
      </div>
      <div class="stats">
        ${stat(x("p.statMajor"), sum.major, x("p.unitEntries"), sum.major > 0)}
        ${stat(x("p.statMinor"), sum.minor, x("p.unitEntries"))}
        ${stat(x("p.statNote"), sum.note, x("p.unitEntries"))}
        ${stat(x("p.statPhotos"), sum.photos, x("p.unitPhotos"))}
      </div>
      ${primary}
      ${active ? `<button id="finish" type="button" class="quiet">${esc(x("p.finish"))}</button>` : ""}
    </section>
    <h2 class="strip-title">${esc(x("p.stripTitle"))}</h2>
    ${cards.length > 0 ? `<div class="strip">${cards.join("")}</div>` : `<p class="hint">${esc(x("p.stripEmpty"))}</p>`}`;
}

/** First-run checklist: pure, so tests can read it. */
export function setupInner(data: FieldLogData, locale: Locale): string {
  const x = (key: string): string => t(locale, key);
  const started = data.inspections.length > 0;
  const noted = data.inspections.some((inspection) => inspection.entries.length > 0);
  const server = hasSpeechServer(data);
  const step = (n: number, done: boolean, key: string): string =>
    `<li class="${done ? "done" : ""}"><span class="num" aria-hidden="true">${done ? "✓" : n}</span><span>${esc(x(key))}</span></li>`;
  return `<ol class="steps">${step(1, started, "p.setup1")}${step(2, noted, "p.setup2")}${step(3, server, "p.setup3")}</ol>`
    + (server ? "" : `<p class="hint">${esc(x("p.setupDemo"))}</p>`);
}

/**
 * The checklist card of the open walk: every room with its progress, every item with its state and,
 * where a photo is needed, a camera button; below it the plain-text editor with the two templates.
 */
export function checklistInner(active: Inspection, view: Pick<View, "locale" | "canPhoto">): string {
  const { locale } = view;
  const x = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  const checklist = active.checklist;
  const total = checklistProgress(active);
  const rooms = (checklist?.rooms ?? []).map((room) => {
    const progress = roomProgress(active, room);
    const extra = [
      ...(progress.missingPhotos > 0 ? [x("p.roomPhoto", { n: progress.missingPhotos })] : []),
      ...(progress.criticalOpen > 0 ? [x("p.roomCritical", { n: progress.criticalOpen })] : []),
    ];
    const items = room.items.map((item) => {
      const state = itemState(active, item);
      const missing = photoMissing(active, item);
      const button = item.photo && view.canPhoto
        ? `<button type="button" class="item-photo secondary${missing ? "" : " done"}" data-id="${esc(item.id)}">${esc(x("p.itemPhoto"))}</button>` : "";
      return `<li class="check-${state}${missing ? " photo-missing" : ""}"><span>${item.critical ? "<strong>!</strong> " : ""}${esc(item.text)}${item.photo ? (missing ? " 📷?" : " 📷") : ""}<br />
        <small>${esc(x("p.state." + state))}</small></span><span class="row-actions">${button}</span></li>`;
    }).join("");
    return `<h3>${esc(room.name)} ${progress.done}/${progress.total}${extra.map((part) => " · " + esc(part)).join("")}</h3><ul class="scripts checks">${items}</ul>`;
  }).join("");
  return `
    <h2>${esc(x("p.checklist"))}${checklist ? ` · ${total.done}/${total.total}` : ""}</h2>
    ${checklist ? rooms : `<p class="hint">${esc(x("p.checklistNone"))}</p>`}
    <details class="fold"${checklist ? "" : " open"}>
      <summary>${esc(x("p.checklistEdit"))}</summary>
      <p class="hint">${esc(x("p.checklistHint"))}</p>
      <button id="tpl-flat" type="button" class="secondary">${esc(x("p.tplFlat"))}</button>
      <button id="tpl-car" type="button" class="secondary">${esc(x("p.tplCar"))}</button>
      <textarea id="checklist" rows="10">${esc(checklist ? checklistText(checklist, locale) : "")}</textarea>
      <button id="save-checklist" type="button" class="big">${esc(x("p.checklistSave"))}</button>
    </details>`;
}

/** The warning shown instead of exporting while required photos or critical items are open. */
export function exportWarningInner(active: Inspection, locale: Locale): string {
  const warning = exportWarning(active);
  if (!warning) return "";
  const x = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  return `<div class="warn-box">
      <p><strong>${esc(x("p.exportWarnTitle"))}: ${esc(warningSummary(warning, locale))}</strong></p>
      ${warning.roomsWithoutPhoto.length > 0 ? `<p class="hint">${esc(x("p.exportWarnPhotos", { rooms: warning.roomsWithoutPhoto.join(", ") }))}</p>` : ""}
      ${warning.criticalOpen.length > 0 ? `<p class="hint">${esc(x("p.exportWarnCritical", { items: warning.criticalOpen.map((open) => open.room + " – " + open.item).join(", ") }))}</p>` : ""}
      <button id="export-anyway" type="button" class="big">${esc(x("p.exportAnyway"))}</button>
      <button id="export-back" type="button" class="secondary">${esc(x("p.exportBack"))}</button>
    </div>`;
}

function template(data: FieldLogData, view: View): string {
  const { locale } = view;
  const L = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  const active = data.activeId ? data.inspections.find((i) => i.id === data.activeId) : null;
  const bytes = approximateBytes(data);
  const voice = hasSpeechServer(data);
  const firstRun = isFirstRun(data);
  const pill = pillOf(data, locale);
  const csvFormat = csvFormatFor(data.csvFormat, locale);
  const severityOptions = (selected: Severity): string => SEVERITIES.map((s) =>
    '<option value="' + s + '"' + (s === selected ? " selected" : "") + ">" + escapeHtml(severityName(locale, s)) + "</option>").join("");
  /** A destructive button: the first tap asks, the second one does it. */
  const dangerButton = (cls: string, id: string, label: string, aria: string): string => {
    const on = view.armed === cls + ":" + id;
    return `<button type="button" class="${cls} remove${on ? " danger" : ""}" data-id="${escapeHtml(id)}" aria-label="${escapeHtml(aria)}">${escapeHtml(on ? L("p.confirmDrop") : label)}</button>`;
  };

  const notesTab = `
  ${active ? `
  <section class="card">
    <h2>${L("p.addNote")}</h2>
    <input id="note" type="text" placeholder="${L("p.notePlaceholder")}" />
    <label for="note-sev">${L("p.noteSeverity")}</label>
    <select id="note-sev">${severityOptions(data.severity)}</select>
    <button id="add-note" type="button" class="big">${L("p.addNoteButton")}</button>
    <label for="section">${L("p.section")}</label>
    <input id="section" type="text" value="${escapeHtml(active.section)}" placeholder="${L("p.sectionPlaceholder")}" />
    <p class="hint">${L("p.sectionHint")}</p>
  </section>

  <section class="card">
    <h2>${L("p.entries")} · ${active.entries.length}</h2>
    ${active.entries.length === 0 ? `<p class="hint">${L("p.entriesEmpty")}</p>` : `
      <ul class="scripts entries">
        ${[...active.entries].reverse().map((e) => `
          <li>
            <span>${severityBadge(e.severity)}${escapeHtml(e.text)}${e.attachment ? " 📷" : ""}<br />
              <small>${escapeHtml(e.section ?? "")}</small></span>
            <span class="row-actions">
              <select class="sev" data-id="${escapeHtml(e.id)}" aria-label="${L("p.noteSeverity")}">${severityOptions(e.severity)}</select>
              ${dangerButton("drop", e.id, "✕", L("p.removeEntry"))}
            </span>
          </li>`).join("")}
      </ul>`}
  </section>

  <section class="card checklist">
    ${checklistInner(active, view)}
  </section>

  ${active.entries.length > 0 || active.checklist ? `
  <details class="fold card"${view.exportAsk && exportWarning(active) ? " open" : ""}>
    <summary>${L("p.exportTitle")}</summary>
    ${view.exportAsk ? exportWarningInner(active, locale) : ""}
    <button id="md" type="button" class="secondary">${L("p.exportMd")}</button>
    <button id="md-img" type="button" class="secondary">${L("p.exportMdImg")}</button>
    <label for="csv-format">${L("p.csvFormat")}</label>
    <select id="csv-format">
      <option value="excel-de"${csvFormat === "excel-de" ? " selected" : ""}>${L("p.csvExcel")}</option>
      <option value="standard"${csvFormat === "standard" ? " selected" : ""}>${L("p.csvStandard")}</option>
    </select>
    <button id="csv" type="button" class="secondary">${L("p.exportCsv")}</button>
    <p class="hint">${L("p.csvHint")}</p>
  </details>` : ""}` : `<p class="hint">${L("p.noEntriesYet")}</p>`}

  <details class="fold card">
    <summary>${L("p.past")} · ${data.inspections.length}</summary>
    ${data.inspections.length === 0 ? `<p class="hint">${L("p.pastEmpty")}</p>` : `
      <ul class="scripts">
        ${data.inspections.map((i) => {
          const counts = countBySeverity(i);
          const date = new Date(i.startedAt).toLocaleDateString(locale === "de" ? "de-AT" : "en-GB");
          return `<li>
            <span>${escapeHtml(i.title)}<br />
              <small>${L("p.pastLine", { date, n: i.entries.length, major: counts.major })}${i.finishedAt === null ? " · " + L("p.stillOpen") : ""}</small></span>
            <span class="row-actions">
              ${i.id === data.activeId ? "" : '<button type="button" class="open secondary" data-id="' + escapeHtml(i.id) + '">' + L("p.open") + "</button>"}
              ${dangerButton("remove-walk", i.id, L("p.remove"), L("p.remove"))}
            </span>
          </li>`;
        }).join("")}
      </ul>`}
    <p class="hint">
      ${L("p.size", { kb: Math.round(bytes / 1024) })}
      ${bytes > SIZE_WARN_BYTES ? "<strong>" + L("p.sizeWarn") + "</strong>" : ""}
    </p>
  </details>`;

  const settingsTab = `
  ${firstRun ? `<section class="card setup"><h2>${L("p.setupTitle")}</h2>${setupInner(data, locale)}</section>` : ""}

  <section class="card compact">
    ${languageSelect(locale)}
  </section>

  <details class="fold card"${firstRun || !voice ? " open" : ""}>
    <summary>${voice ? L("p.sttFolded") : L("p.advanced")}</summary>
    <p class="hint">${L("p.advancedHint")}</p>
    <p class="hint"><strong>${L(voice ? "p.modeVoice" : "p.modeQuick")}</strong></p>
    <label for="stt">${L("p.server")}</label>
    <input id="stt" type="text" value="${escapeHtml(data.sttUrl)}" placeholder="Whisper-Server (Adresse:Port)" />
    <label for="stt-token">${L("p.token", { state: "<em>" + escapeHtml(maskSecret(data.sttToken, locale)) + "</em>" })}</label>
    <input id="stt-token" type="password" />
    <label for="lang">${L("p.speechLanguage")}</label>
    <input id="lang" type="text" value="${escapeHtml(data.language)}" placeholder="auto, de, en …" />
    <button id="save-stt" type="button" class="big">${L("p.saveServer")}</button>
  </details>

  <details class="fold card">
    <summary>${L("p.quick")}</summary>
    <label for="quick">${L("p.quickHint")}</label>
    <textarea id="quick" rows="7">${escapeHtml(quickNotes(locale, data.quickNotes).join("\n"))}</textarea>
    <button id="save-quick" type="button" class="big">${L("p.quickSave")}</button>
  </details>

  <details class="fold card">
    <summary>${L("p.controls")}</summary>
    <table class="keys">
      <tr><td>${L("p.key.tap")}</td><td>${L("p.key.tapDo")}</td></tr>
      <tr><td>${L("p.key.swipe")}</td><td>${L("p.key.swipeDo")}</td></tr>
      <tr><td>${L("p.key.double")}</td><td>${L("p.key.doubleDo")}</td></tr>
    </table>
    <p class="hint">${L("p.discardHint")}</p>
    <label class="check"><input id="invert" type="checkbox" ${data.invertScroll ? "checked" : ""} /> ${L("p.invert")}</label>
    <p class="hint">${L("p.invertHint")}</p>
  </details>

  <details class="fold card">
    <summary>${L("p.settingsData")}</summary>
    <p class="hint">${L("p.privacy")}</p>
  </details>`;

  return `
  <header class="brand bar">
    <div>
      <div class="brand-mark">${L("p.kicker")}</div>
      <h1>FieldLog</h1>
    </div>
    <span id="pill" class="chip${pill.on ? " on" : ""}">${escapeHtml(pill.text)}</span>
  </header>

  ${view.notice ? '<p class="notice">' + escapeHtml(view.notice) + "</p>" : ""}

  <div class="tab" data-tab="now">
    ${nowInner(data, view)}
  </div>

  <div class="tab" data-tab="notes">
    ${notesTab}
  </div>

  <div class="tab" data-tab="settings">
    ${settingsTab}
  </div>

  <nav class="tabbar" role="tablist">
    ${TABS.map(({ id, icon, key }) => `<button type="button" role="tab" data-tab-go="${id}"><span aria-hidden="true">${icon}</span>${escapeHtml(L(key))}</button>`).join("")}
  </nav>`;
}

function severityBadge(severity: Severity): string {
  if (severity === "major") return "<strong>!</strong> ";
  if (severity === "minor") return "· ";
  return "";
}

function wire(
  root: HTMLElement,
  ports: PhoneUiPorts,
  commit: Commit,
  notify: (message: string) => void,
  locale: Locale,
  arm: Arm,
  ask: Ask,
  /** The export waiting behind the checklist warning, if any. */
  asked: ExportKind | null,
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

  // Deleting asks twice: the first tap turns the button into "Tap again", the second (within 4 s) deletes.
  root.querySelectorAll<HTMLButtonElement>(".drop").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset["id"];
      if (!id) return;
      arm("drop:" + id, () => {
        const open = active();
        if (open) commit(upsertInspection(current(), removeEntry(open, id)));
      });
    });
  });

  root.querySelectorAll<HTMLButtonElement>(".open").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset["id"];
      // Drafts are dropped: the checklist box would carry the other walk's list over.
      if (id) commit({ ...current(), activeId: id }, { keepDraft: false });
    });
  });

  root.querySelectorAll<HTMLButtonElement>(".remove-walk").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset["id"];
      if (!id) return;
      arm("remove-walk:" + id, () => commit(removeInspection(current(), id)));
    });
  });

  const fileName = (extension: string): string => safeName(active()?.title ?? t(locale, "x.file")) + "." + extension;

  const runExport = (kind: ExportKind): void => {
    const open = active();
    if (!open) return;
    if (kind === "md") download(fileName("md"), toMarkdown(open, false, locale), "text/markdown");
    else if (kind === "md-img") download(fileName("full.md"), toMarkdown(open, true, locale), "text/markdown");
    else {
      const format = csvFormatFor(current().csvFormat, locale);
      // Plain ASCII names; the Excel variant says so, so the two cannot be mixed up.
      download(fileName(format === "excel-de" ? "excel.csv" : "csv"), toCsv(open, locale, format), "text/csv;charset=utf-8");
    }
  };
  /** Required photos missing or critical items open: the phone names them and waits for "export anyway" / "back". */
  const requestExport = (kind: ExportKind): void => {
    const open = active();
    if (!open) return;
    if (exportWarning(open)) { ask(kind); return; }
    runExport(kind);
  };
  byId<HTMLButtonElement>("export-anyway")?.addEventListener("click", () => {
    const kind = asked;
    ask(null);
    if (kind) runExport(kind);
  });
  byId<HTMLButtonElement>("export-back")?.addEventListener("click", () => ask(null));
  byId<HTMLButtonElement>("md")?.addEventListener("click", () => requestExport("md"));
  byId<HTMLButtonElement>("md-img")?.addEventListener("click", () => requestExport("md-img"));

  // The checklist: a template is copied into the box (nothing is saved until "Save checklist").
  byId<HTMLButtonElement>("tpl-flat")?.addEventListener("click", () => {
    const box = byId<HTMLTextAreaElement>("checklist");
    if (box) box.value = templateText("flat", locale);
  });
  byId<HTMLButtonElement>("tpl-car")?.addEventListener("click", () => {
    const box = byId<HTMLTextAreaElement>("checklist");
    if (box) box.value = templateText("car", locale);
  });
  byId<HTMLButtonElement>("save-checklist")?.addEventListener("click", () => {
    const open = active();
    if (!open) return;
    const parsed = parseChecklist(byId<HTMLTextAreaElement>("checklist")?.value ?? "", locale);
    if (parsed.rooms.length === 0) {
      // Empty removes the checklist; the ticks stay stored, so saving the same list again brings them back.
      const { checklist: _dropped, ...rest } = open;
      void _dropped;
      commit(upsertInspection(current(), rest), { keepDraft: false, notice: t(locale, "p.checklistRemoved") });
      return;
    }
    commit(upsertInspection(current(), { ...open, checklist: parsed }), {
      keepDraft: false, notice: t(locale, "p.checklistSaved", { rooms: parsed.rooms.length, items: itemCount(parsed) }),
    });
  });
  root.querySelectorAll<HTMLButtonElement>(".item-photo").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset["id"];
      if (!id) return;
      ports.takePhoto?.(id).catch((error: unknown) => { console.warn("[fieldlog] photo failed:", error); });
    });
  });
  byId<HTMLSelectElement>("csv-format")?.addEventListener("change", (event) => {
    const value = (event.target as HTMLSelectElement).value;
    commit({ ...current(), csvFormat: value === "excel-de" ? "excel-de" : "standard" });
  });
  byId<HTMLButtonElement>("csv")?.addEventListener("click", () => requestExport("csv"));

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
    const sttUrl = byId<HTMLInputElement>("stt")?.value.trim() ?? "";
    const check = validateSttUrl(sttUrl, locale);
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
    .normalize("NFD").replace(/[̀-ͯ]/g, "");
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
