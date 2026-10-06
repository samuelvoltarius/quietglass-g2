import {
  activeInspection, approximateBytes, maskSecret, nextInspectionId, removeInspection, upsertInspection,
  usesMockStt, validateWsUrl, type FieldLogData,
} from "../storage/persist";
import {
  countBySeverity, finish, removeEntry, setSection, setSeverity, startInspection,
  toCsv, toMarkdown, type Severity,
} from "../log/entries";

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
}

/** Warn before per-app storage becomes a problem. */
const SIZE_WARN_BYTES = 4 * 1024 * 1024;

/** Text fields that hold an unsaved draft and must survive a re-render. */
const DRAFT_FIELDS = ["title", "stt", "stt-token", "lang"] as const;

type Commit = (next: FieldLogData, options?: { readonly keepDraft?: boolean }) => void;

export function mountPhoneUi(ports: PhoneUiPorts): void {
  const root = document.getElementById("app");
  if (!root) return;

  let notice = "";

  // Re-rendered after every change. Handlers always read the current data:
  // the glasses file entries while this page is open, and a change computed
  // from the data of the last render would write those entries away again.
  const render = (keepDraft = true): void => {
    const draft = keepDraft ? readDraft(root) : null;
    root.innerHTML = template(ports.getData(), notice);
    notice = "";
    if (draft) writeDraft(root, draft);
    wire(root, ports.getData, commit, (message) => { notice = message; render(); });
  };

  const commit: Commit = (next, options = {}) => {
    const saving = ports.setData(next);
    render(options.keepDraft ?? true);
    saving.catch((error: unknown) => {
      console.warn("[fieldlog] save failed:", error);
      notice = "Could not save: " + (error instanceof Error ? error.message : String(error));
      render();
    });
  };

  render();
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

function template(data: FieldLogData, notice: string): string {
  const active = data.activeId ? data.inspections.find((i) => i.id === data.activeId) : null;
  const bytes = approximateBytes(data);

  return `
  <header class="brand">
    <span class="brand-mark">Quietglass</span>
    <h1>FieldLog</h1>
  </header>

  ${notice ? '<p class="notice">' + escapeHtml(notice) + "</p>" : ""}

  ${usesMockStt(data) ? `
  <section class="card">
    <h2>Using the mock recogniser</h2>
    <p class="hint">
      No speech server is configured, so dictation produces fixed placeholder
      text and the glasses show <strong>MOCK</strong>. Configure a server below
      to transcribe for real.
    </p>
  </section>` : ""}

  <section class="card">
    <h2>${active ? "Current inspection" : "Start an inspection"}</h2>
    ${active ? `
      <p class="hint"><strong>${escapeHtml(active.title)}</strong> — ${active.entries.length} entries</p>
      <label for="section">Current section</label>
      <input id="section" type="text" value="${escapeHtml(active.section)}" placeholder="Kitchen, Axle, Roof …" />
      <p class="hint">New entries are filed under this section until you change it.</p>
      <button id="finish" type="button">Finish inspection</button>
    ` : `
      <label for="title">Title</label>
      <input id="title" type="text" placeholder="Handover flat 3, Van MOT, Roof survey" />
      <button id="start" type="button">Start</button>
    `}
  </section>

  ${active ? `
  <section class="card">
    <h2>Entries</h2>
    ${active.entries.length === 0 ? '<p class="hint">Nothing logged yet. Tap the temple pad to dictate.</p>' : `
      <table class="keys">
        ${active.entries.map((e) => `
          <tr>
            <td>${severityBadge(e.severity)}</td>
            <td>${escapeHtml(e.text)}${e.attachment ? " 📷" : ""}<br />
                <small>${escapeHtml(e.section ?? "")}</small></td>
            <td>
              <select class="sev" data-id="${escapeHtml(e.id)}">
                ${(["note", "minor", "major"] as Severity[]).map((s) =>
                  '<option value="' + s + '"' + (s === e.severity ? " selected" : "") + ">" + s + "</option>").join("")}
              </select>
              <button type="button" class="drop" data-id="${escapeHtml(e.id)}">✕</button>
            </td>
          </tr>`).join("")}
      </table>
      <button id="md" type="button" class="secondary">Export Markdown</button>
      <button id="md-img" type="button" class="secondary">Markdown + photos</button>
      <button id="csv" type="button" class="secondary">Export CSV</button>
    `}
  </section>` : ""}

  <section class="card">
    <h2>Past inspections</h2>
    ${data.inspections.length === 0 ? '<p class="hint">None yet.</p>' : `
      <ul class="scripts">
        ${data.inspections.map((i) => {
          const counts = countBySeverity(i);
          return `<li>
            <span>${escapeHtml(i.title)}<br />
              <small>${new Date(i.startedAt).toLocaleDateString()} · ${i.entries.length} entries ·
              ${counts.major} major${i.finishedAt === null ? " · open" : ""}</small></span>
            <span class="row-actions">
              ${i.id === data.activeId ? "" : '<button type="button" class="open" data-id="' + escapeHtml(i.id) + '">Open</button>'}
              <button type="button" class="remove" data-id="${escapeHtml(i.id)}">Remove</button>
            </span>
          </li>`;
        }).join("")}
      </ul>`}
    <p class="hint">
      Stored size: about ${Math.round(bytes / 1024)} kB.
      ${bytes > SIZE_WARN_BYTES ? "<strong>Getting large — export and remove old inspections.</strong>" : ""}
    </p>
  </section>

  <section class="card">
    <h2>Speech recognition</h2>
    <label for="stt">Server (WebSocket)</label>
    <input id="stt" type="text" value="${escapeHtml(data.sttUrl)}" placeholder="wss://your-host:9000/asr" />
    <label for="stt-token">Token (optional) — <em>${escapeHtml(maskSecret(data.sttToken))}</em></label>
    <input id="stt-token" type="password" />
    <label for="lang">Language</label>
    <input id="lang" type="text" value="${escapeHtml(data.language)}" placeholder="auto, en, de …" />
    <label class="check"><input id="invert" type="checkbox" ${data.invertScroll ? "checked" : ""} /> Invert swipe direction</label>
    <button id="save-stt" type="button">Save</button>
  </section>

  <section class="card">
    <h2>Controls on the glasses</h2>
    <table class="keys">
      <tr><td>Tap</td><td>Dictate an entry · stop · keep the transcript</td></tr>
      <tr><td>Swipe</td><td>Change severity · discard the transcript under review</td></tr>
      <tr><td>Hold</td><td>Attach a photo from the phone camera</td></tr>
      <tr><td>Double tap</td><td>Leave — stops the microphone</td></tr>
    </table>
    <p class="hint">
      Every transcript is shown for confirmation before it is filed, because an
      inspection report is a document someone acts on.
    </p>
  </section>

  <footer class="hint">
    Audio goes only to the server you configure and is never stored. Entries and
    photos stay on this phone until you export them.
  </footer>`;
}

function severityBadge(severity: Severity): string {
  if (severity === "major") return "<strong>!</strong>";
  if (severity === "minor") return "·";
  return "";
}

function wire(
  root: HTMLElement,
  current: () => FieldLogData,
  commit: Commit,
  notify: (message: string) => void,
): void {
  const byId = <T extends HTMLElement>(id: string): T | null => root.querySelector<T>("#" + id);
  /** The open inspection as it is now, not as it was when the page was drawn. */
  const active = (): ReturnType<typeof activeInspection> => activeInspection(current());

  byId<HTMLButtonElement>("start")?.addEventListener("click", () => {
    const title = byId<HTMLInputElement>("title")?.value.trim() ?? "";
    if (!title) { notify("Give the inspection a title."); return; }
    const data = current();
    const id = nextInspectionId(data);
    commit({ ...upsertInspection(data, startInspection(id, title, Date.now())), activeId: id }, { keepDraft: false });
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

  const fileName = (extension: string): string =>
    (active()?.title ?? "inspection").replace(/[^a-z0-9]+/gi, "-").toLowerCase() + "." + extension;

  byId<HTMLButtonElement>("md")?.addEventListener("click", () => {
    const open = active();
    if (open) download(fileName("md"), toMarkdown(open), "text/markdown");
  });
  byId<HTMLButtonElement>("md-img")?.addEventListener("click", () => {
    const open = active();
    if (open) download(fileName("full.md"), toMarkdown(open, true), "text/markdown");
  });
  byId<HTMLButtonElement>("csv")?.addEventListener("click", () => {
    const open = active();
    if (open) download(fileName("csv"), toCsv(open), "text/csv");
  });

  byId<HTMLButtonElement>("save-stt")?.addEventListener("click", () => {
    const sttUrl = byId<HTMLInputElement>("stt")?.value.trim() ?? "";
    const check = validateWsUrl(sttUrl);
    if (!check.valid) { notify(check.errors.join(" ")); return; }
    const token = byId<HTMLInputElement>("stt-token")?.value ?? "";
    const data = current();
    commit({
      ...data,
      sttUrl,
      ...(token ? { sttToken: token } : data.sttToken ? { sttToken: data.sttToken } : {}),
      language: byId<HTMLInputElement>("lang")?.value.trim() || "auto",
      invertScroll: byId<HTMLInputElement>("invert")?.checked ?? false,
    }, { keepDraft: false });
  });
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
