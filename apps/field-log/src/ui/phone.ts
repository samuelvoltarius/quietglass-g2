import {
  approximateBytes, maskSecret, nextInspectionId, removeInspection, upsertInspection,
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
  readonly getData: () => FieldLogData;
  readonly setData: (data: FieldLogData) => Promise<void>;
}

/** Warn before per-app storage becomes a problem. */
const SIZE_WARN_BYTES = 4 * 1024 * 1024;

export function mountPhoneUi(ports: PhoneUiPorts): void {
  const root = document.getElementById("app");
  if (!root) return;

  let notice = "";
  const render = (): void => {
    const data = ports.getData();
    root.innerHTML = template(data);
    if (notice) notice = "";
    wire(root, ports, data, (message) => { notice = message; render(); });
  };
  render();
}

function template(data: FieldLogData): string {
  const active = data.activeId ? data.inspections.find((i) => i.id === data.activeId) : null;
  const bytes = approximateBytes(data);

  return `
  <header class="brand">
    <span class="brand-mark">Aigner Labs</span>
    <h1>FieldLog</h1>
  </header>

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
  ports: PhoneUiPorts,
  data: FieldLogData,
  notify: (message: string) => void,
): void {
  const byId = <T extends HTMLElement>(id: string): T | null => root.querySelector<T>("#" + id);
  const commit = (next: FieldLogData): void => { void ports.setData(next); };
  const active = data.activeId ? data.inspections.find((i) => i.id === data.activeId) : null;

  byId<HTMLButtonElement>("start")?.addEventListener("click", () => {
    const title = byId<HTMLInputElement>("title")?.value.trim() ?? "";
    if (!title) { notify("Give the inspection a title."); return; }
    const id = nextInspectionId(data);
    commit({ ...upsertInspection(data, startInspection(id, title, Date.now())), activeId: id });
  });

  byId<HTMLButtonElement>("finish")?.addEventListener("click", () => {
    if (!active) return;
    commit({ ...upsertInspection(data, finish(active, Date.now())), activeId: null });
  });

  byId<HTMLInputElement>("section")?.addEventListener("change", (event) => {
    if (!active) return;
    commit(upsertInspection(data, setSection(active, (event.target as HTMLInputElement).value)));
  });

  root.querySelectorAll<HTMLSelectElement>(".sev").forEach((select) => {
    select.addEventListener("change", () => {
      const id = select.dataset["id"];
      if (active && id) commit(upsertInspection(data, setSeverity(active, id, select.value as Severity)));
    });
  });

  root.querySelectorAll<HTMLButtonElement>(".drop").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset["id"];
      if (active && id) commit(upsertInspection(data, removeEntry(active, id)));
    });
  });

  root.querySelectorAll<HTMLButtonElement>(".open").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset["id"];
      if (id) commit({ ...data, activeId: id });
    });
  });

  root.querySelectorAll<HTMLButtonElement>(".remove").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset["id"];
      if (id) commit(removeInspection(data, id));
    });
  });

  const fileName = (extension: string): string =>
    (active?.title ?? "inspection").replace(/[^a-z0-9]+/gi, "-").toLowerCase() + "." + extension;

  byId<HTMLButtonElement>("md")?.addEventListener("click", () => {
    if (active) download(fileName("md"), toMarkdown(active), "text/markdown");
  });
  byId<HTMLButtonElement>("md-img")?.addEventListener("click", () => {
    if (active) download(fileName("full.md"), toMarkdown(active, true), "text/markdown");
  });
  byId<HTMLButtonElement>("csv")?.addEventListener("click", () => {
    if (active) download(fileName("csv"), toCsv(active), "text/csv");
  });

  byId<HTMLButtonElement>("save-stt")?.addEventListener("click", () => {
    const sttUrl = byId<HTMLInputElement>("stt")?.value.trim() ?? "";
    const check = validateWsUrl(sttUrl);
    if (!check.valid) { notify(check.errors.join(" ")); return; }
    const token = byId<HTMLInputElement>("stt-token")?.value ?? "";
    commit({
      ...data,
      sttUrl,
      ...(token ? { sttToken: token } : data.sttToken ? { sttToken: data.sttToken } : {}),
      language: byId<HTMLInputElement>("lang")?.value.trim() || "auto",
      invertScroll: byId<HTMLInputElement>("invert")?.checked ?? false,
    });
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
