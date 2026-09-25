import { parseMarkdown, parsePack, toPack } from "../checklist/parse";
import {
  nextListId, removeList, setSettings, upsertList,
  type FlowListData, type FlowListSettings,
} from "../storage/persist";

/**
 * The phone companion. Checklists are written or pasted here; the glasses only
 * run them. Export produces a pack file the user can share however they like —
 * FlowList never uploads anything.
 */

export interface PhoneUiPorts {
  readonly getData: () => FlowListData;
  readonly setData: (data: FlowListData) => Promise<void>;
}

export function mountPhoneUi(ports: PhoneUiPorts): void {
  const root = document.getElementById("app");
  if (!root) return;

  let notice = "";

  const render = (): void => {
    const data = ports.getData();
    root.innerHTML = template(data, notice);
    notice = "";
    wire(root, ports, data, (message) => { notice = message; render(); });
  };

  render();
}

function template(data: FlowListData, notice: string): string {
  const s = data.settings;
  return `
  <header class="brand">
    <span class="brand-mark">Quietglass</span>
    <h1>FlowList</h1>
  </header>

  ${notice ? '<p class="notice">' + escapeHtml(notice) + "</p>" : ""}

  <section class="card">
    <h2>Add a checklist</h2>
    <label for="source">Paste Markdown or a FlowList pack (JSON)</label>
    <textarea id="source" rows="10" placeholder="# Pre-flight&#10;&#10;## Camera&#10;- [ ] Check battery (!)&#10;- [ ] Format card&#10;    Two cards for long days&#10;- [ ] Fit ND filter (optional)"></textarea>
    <p class="hint">
      <code>#</code> titles the list, <code>##</code> opens a section.
      <code>(!)</code> marks a critical step that asks before it is accepted,
      <code>(optional)</code> makes a step skippable. An indented line becomes
      that step's detail.
    </p>
    <button id="add" type="button">Add checklist</button>
  </section>

  <section class="card">
    <h2>Your checklists</h2>
    ${data.lists.length === 0 ? '<p class="hint">Nothing yet.</p>' : ""}
    <ul class="scripts">
      ${data.lists.map((list) => `
        <li>
          <label>
            <input type="radio" name="active" value="${escapeHtml(list.id)}"
              ${list.id === data.activeId ? "checked" : ""} />
            <span>${escapeHtml(list.title)} <em>(${list.steps.length})</em></span>
          </label>
          <span class="row-actions">
            <button type="button" class="export" data-id="${escapeHtml(list.id)}">Export</button>
            <button type="button" class="remove" data-id="${escapeHtml(list.id)}">Remove</button>
          </span>
        </li>`).join("")}
    </ul>
  </section>

  <section class="card">
    <h2>Display</h2>
    <label class="check"><input id="next" type="checkbox" ${s.showNext ? "checked" : ""} /> Show the next step below the current one</label>
    <label for="width">Characters per line — <output id="width-out">${s.lineWidth}</output></label>
    <input id="width" type="range" min="20" max="80" step="2" value="${s.lineWidth}" />
    <label class="check"><input id="invert" type="checkbox" ${s.invertScroll ? "checked" : ""} /> Invert swipe direction</label>
    <p class="hint">Turn inversion on if swiping moves the wrong way on your glasses.</p>
  </section>

  <section class="card">
    <h2>Controls on the glasses</h2>
    <table class="keys">
      <tr><td>Tap</td><td>Step done — or confirm a critical step, or take the highlighted branch</td></tr>
      <tr><td>Swipe up</td><td>Back one step</td></tr>
      <tr><td>Swipe down</td><td>Skip (optional steps only)</td></tr>
      <tr><td>Hold</td><td>Show the step's detail while held</td></tr>
      <tr><td>Double tap</td><td>Leave FlowList</td></tr>
    </table>
    <p class="hint">On a branching step both swipes move between the options. The R1 ring works the same as the temple pads.</p>
  </section>

  <footer class="hint">
    FlowList keeps everything on this phone. It has no network access; sharing happens by exporting a pack.
  </footer>`;
}

function wire(
  root: HTMLElement,
  ports: PhoneUiPorts,
  data: FlowListData,
  notify: (message: string) => void,
): void {
  const byId = <T extends HTMLElement>(id: string): T | null => root.querySelector<T>("#" + id);
  const commit = (next: FlowListData): void => { void ports.setData(next); };

  byId<HTMLButtonElement>("add")?.addEventListener("click", () => {
    const source = byId<HTMLTextAreaElement>("source")?.value ?? "";
    if (!source.trim()) return;

    const id = nextListId(data);
    // A pack is JSON; anything else is treated as Markdown.
    const looksLikeJson = source.trim().startsWith("{");
    const result = looksLikeJson ? parsePack(source) : parseMarkdown(source, id);

    if (result.checklist.steps.length === 0) {
      notify(result.warnings.join(" ") || "Could not read that.");
      return;
    }

    commit(upsertList(data, { ...result.checklist, id }));
    if (result.warnings.length > 0) notify(result.warnings.join(" "));
  });

  root.querySelectorAll<HTMLButtonElement>(".remove").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset["id"];
      if (id) commit(removeList(data, id));
    });
  });

  root.querySelectorAll<HTMLButtonElement>(".export").forEach((button) => {
    button.addEventListener("click", () => {
      const list = data.lists.find((l) => l.id === button.dataset["id"]);
      if (!list) return;
      download(list.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase() + ".flowlist.json", toPack(list));
    });
  });

  root.querySelectorAll<HTMLInputElement>('input[name="active"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      if (radio.checked) commit({ ...data, activeId: radio.value });
    });
  });

  const patch = (change: Partial<FlowListSettings>): void => commit(setSettings(data, change));

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
