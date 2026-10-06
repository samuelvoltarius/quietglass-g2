import {
  entriesOnDay, entrySeconds, formatClock, formatHours, secondsOnDay, startOfDay, toCsv,
  totalsByProject,
} from "../tracking/clock";
import { addProject, removeProject, type ClockData } from "../storage/persist";

/**
 * The phone companion: projects, the log and export. The glasses keep three
 * gestures, so everything else lives here.
 */

export interface PhoneUiPorts {
  /** Must already reflect a `setData` call by the time that call returns its promise. */
  readonly getData: () => ClockData;
  readonly setData: (data: ClockData) => Promise<void>;
}

type Commit = (next: ClockData, options?: { readonly keepDraft?: boolean }) => void;

export function mountPhoneUi(ports: PhoneUiPorts): void {
  const root = document.getElementById("app");
  if (!root) return;

  let notice = "";

  // Re-rendered after every change. Handlers always read the current data:
  // the glasses start and stop the clock while this page is open, and a change
  // computed from the data of the last render would reset the running clock
  // and drop the entries recorded since.
  const render = (keepDraft = true): void => {
    const draft = keepDraft ? root.querySelector<HTMLInputElement>("#project")?.value ?? "" : "";
    root.innerHTML = template(ports.getData(), notice);
    notice = "";
    const field = root.querySelector<HTMLInputElement>("#project");
    if (field && draft) field.value = draft;
    wire(root, ports.getData, commit);
  };

  const commit: Commit = (next, options = {}) => {
    const saving = ports.setData(next);
    render(options.keepDraft ?? true);
    saving.catch((error: unknown) => {
      console.warn("[shiftclock] save failed:", error);
      notice = "Could not save: " + (error instanceof Error ? error.message : String(error));
      render();
    });
  };

  render();
}

function template(data: ClockData, notice: string): string {
  const now = Date.now();
  const dayStart = startOfDay(now);
  const today = entriesOnDay(data.entries, dayStart);
  // Only today's part of a shift that ran past midnight counts towards today.
  const todaySeconds = secondsOnDay(data.entries, dayStart);
  const totals = totalsByProject(data.entries).slice(0, 8);
  const running = data.open.project !== null;

  return `
  <header class="brand">
    <span class="brand-mark">Quietglass</span>
    <h1>ShiftClock</h1>
  </header>

  ${notice ? '<p class="notice">' + escapeHtml(notice) + "</p>" : ""}

  ${running ? '<p class="notice">Running: <strong>' + escapeHtml(data.open.project ?? "") + "</strong></p>" : ""}

  <section class="card">
    <h2>Projects</h2>
    <label for="project">Add a project</label>
    <input id="project" type="text" placeholder="Client, job number, task …" />
    <button id="add" type="button">Add</button>
    ${data.projects.length === 0 ? '<p class="hint">Add a project to start tracking on the glasses.</p>' : ""}
    <ul class="scripts">
      ${data.projects.map((p) => `
        <li>
          <span>${escapeHtml(p)}</span>
          <button type="button" class="remove" data-project="${escapeHtml(p)}">Remove</button>
        </li>`).join("")}
    </ul>
    <p class="hint">Removing a project keeps the time already recorded against it.</p>
  </section>

  <section class="card">
    <h2>Today</h2>
    <p class="hint">
      <strong>${formatClock(todaySeconds)}</strong>
      (${formatHours(todaySeconds)} h) across ${today.length}
      entr${today.length === 1 ? "y" : "ies"}.
    </p>
    ${today.length === 0 ? "" : `
      <table class="keys">
        ${today.map((e) => "<tr><td>" + escapeHtml(e.project) + "</td><td>" +
            new Date(e.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) +
            "</td><td>" + formatClock(entrySeconds(e)) + "</td></tr>").join("")}
      </table>`}
  </section>

  <section class="card">
    <h2>All time</h2>
    ${totals.length === 0 ? '<p class="hint">Nothing recorded yet.</p>' : `
      <table class="keys">
        ${totals.map((row) => "<tr><td>" + escapeHtml(row.project) + "</td><td>" +
            formatClock(row.seconds) + "</td><td>" + formatHours(row.seconds) + " h</td></tr>").join("")}
      </table>
      <button id="export" type="button" class="secondary">Export CSV</button>
      <button id="clear" type="button" class="secondary">Clear log</button>`}
  </section>

  <section class="card">
    <h2>Controls on the glasses</h2>
    <table class="keys">
      <tr><td>Tap</td><td>Stopped: choose a project, then tap to start · Running: stop</td></tr>
      <tr><td>Swipe</td><td>Move through the project list while choosing</td></tr>
      <tr><td>Double tap</td><td>Leave — the clock keeps running</td></tr>
    </table>
    <p class="hint">
      Leaving the app does not stop the clock. The open entry is saved and
      resumes next time, so a disconnect or a closed app never loses time.
      Entries under 10 seconds are discarded as fumbles.
    </p>
  </section>

  <footer class="hint">
    ShiftClock keeps everything on this phone. No account, no sync, no server.
  </footer>`;
}

function wire(root: HTMLElement, current: () => ClockData, commit: Commit): void {
  const byId = <T extends HTMLElement>(id: string): T | null => root.querySelector<T>("#" + id);

  byId<HTMLButtonElement>("add")?.addEventListener("click", () => {
    const input = byId<HTMLInputElement>("project");
    if (input?.value.trim()) commit(addProject(current(), input.value), { keepDraft: false });
  });

  root.querySelectorAll<HTMLButtonElement>(".remove").forEach((button) => {
    button.addEventListener("click", () => {
      const project = button.dataset["project"];
      if (project) commit(removeProject(current(), project));
    });
  });

  byId<HTMLButtonElement>("export")?.addEventListener("click", () => {
    download("shiftclock.csv", toCsv(current().entries), "text/csv");
  });

  byId<HTMLButtonElement>("clear")?.addEventListener("click", () => {
    commit({ ...current(), entries: [] });
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
