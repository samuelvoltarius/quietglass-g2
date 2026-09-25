import {
  DEFAULT_SETTINGS, nextScriptId, removeScript, setSettings, upsertScript,
  type PromptFlowData, type PromptFlowSettings,
} from "../storage/persist";
import { MODE_PRESETS, type PrompterMode } from "../prompter/engine";

/**
 * The phone companion surface. Typing belongs here — the glasses have no
 * keyboard, so scripts are pasted and settings adjusted on the phone, and the
 * glasses stay a read-only, glanceable surface.
 */

export interface PhoneUiPorts {
  readonly getData: () => PromptFlowData;
  readonly setData: (data: PromptFlowData) => Promise<void>;
}

export function mountPhoneUi(ports: PhoneUiPorts): void {
  const root = document.getElementById("app");
  if (!root) return;

  const render = (): void => {
    const data = ports.getData();
    root.innerHTML = template(data);
    wire(root, ports, data);
  };

  render();
}

function template(data: PromptFlowData): string {
  const s = data.settings;
  return `
  <header class="brand">
    <span class="brand-mark">Quietglass</span>
    <h1>PromptFlow</h1>
  </header>

  <section class="card">
    <h2>Script</h2>
    <label for="title">Title</label>
    <input id="title" type="text" placeholder="Untitled script" />
    <label for="source">Script (Markdown or plain text)</label>
    <textarea id="source" rows="10" placeholder="# My talk&#10;&#10;First paragraph.&#10;&#10;## Section&#10;&#10;Next paragraph."></textarea>
    <p class="hint"><code># Heading</code> becomes the title, <code>## Heading</code> starts a section.</p>
    <button id="add" type="button">Save script</button>
  </section>

  <section class="card">
    <h2>Saved scripts</h2>
    ${data.scripts.length === 0 ? '<p class="hint">No scripts yet.</p>' : ""}
    <ul class="scripts">
      ${data.scripts.map((script) => `
        <li>
          <label>
            <input type="radio" name="active" value="${escapeAttr(script.id)}"
              ${script.id === data.activeId ? "checked" : ""} />
            <span>${escapeHtml(script.title || "Untitled")}</span>
          </label>
          <button type="button" class="remove" data-id="${escapeAttr(script.id)}">Remove</button>
        </li>`).join("")}
    </ul>
  </section>

  <section class="card">
    <h2>Reading</h2>
    <label for="mode">Mode</label>
    <select id="mode">
      ${(Object.keys(MODE_PRESETS) as PrompterMode[]).map((mode) => `
        <option value="${mode}" ${mode === s.mode ? "selected" : ""}>${modeLabel(mode)}</option>`).join("")}
    </select>

    <label for="wpm">Speed — <output id="wpm-out">${s.wpm}</output> words per minute</label>
    <input id="wpm" type="range" min="60" max="260" step="10" value="${s.wpm}" />

    <label for="lines">Lines on screen — <output id="lines-out">${s.visibleLines}</output></label>
    <input id="lines" type="range" min="1" max="8" step="1" value="${s.visibleLines}" />

    <label for="width">Characters per line — <output id="width-out">${s.lineWidth}</output></label>
    <input id="width" type="range" min="20" max="80" step="2" value="${s.lineWidth}" />

    <label class="check"><input id="cursor" type="checkbox" ${s.showCursor ? "checked" : ""} /> Mark the current line</label>
    <label class="check"><input id="invert" type="checkbox" ${s.invertScroll ? "checked" : ""} /> Invert swipe direction</label>
    <p class="hint">Turn inversion on if swiping moves the script the wrong way on your glasses.</p>
  </section>

  <section class="card">
    <h2>Controls on the glasses</h2>
    <table class="keys">
      <tr><td>Tap</td><td>Start / pause</td></tr>
      <tr><td>Swipe</td><td>Paused: move through the script · Reading: adjust speed</td></tr>
      <tr><td>Long press</td><td>Jump to the next section</td></tr>
      <tr><td>Double tap</td><td>Leave PromptFlow</td></tr>
    </table>
    <p class="hint">The R1 ring works the same as the temple pads.</p>
  </section>

  <footer class="hint">
    PromptFlow keeps everything on this phone. It has no network access and sends nothing anywhere.
  </footer>`;
}

function wire(root: HTMLElement, ports: PhoneUiPorts, data: PromptFlowData): void {
  const byId = <T extends HTMLElement>(id: string): T | null => root.querySelector<T>(`#${id}`);

  const commit = (next: PromptFlowData): void => { void ports.setData(next); };

  byId<HTMLButtonElement>("add")?.addEventListener("click", () => {
    const source = byId<HTMLTextAreaElement>("source")?.value ?? "";
    if (!source.trim()) return;
    const title = byId<HTMLInputElement>("title")?.value.trim() ?? "";
    commit(upsertScript(data, {
      id: nextScriptId(data),
      title: title || firstHeading(source) || "Untitled",
      source,
      updatedAt: Date.now(),
    }));
  });

  root.querySelectorAll<HTMLButtonElement>(".remove").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset["id"];
      if (id) commit(removeScript(data, id));
    });
  });

  root.querySelectorAll<HTMLInputElement>('input[name="active"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      if (radio.checked) commit({ ...data, activeId: radio.value });
    });
  });

  const patch = (change: Partial<PromptFlowSettings>): void => commit(setSettings(data, change));

  byId<HTMLSelectElement>("mode")?.addEventListener("change", (event) => {
    const mode = (event.target as HTMLSelectElement).value as PrompterMode;
    const preset = MODE_PRESETS[mode] ?? MODE_PRESETS[DEFAULT_SETTINGS.mode];
    patch({ mode, wpm: preset.wpm, visibleLines: preset.visibleLines });
  });

  bindRange(byId<HTMLInputElement>("wpm"), byId("wpm-out"), (v) => patch({ wpm: v }));
  bindRange(byId<HTMLInputElement>("lines"), byId("lines-out"), (v) => patch({ visibleLines: v }));
  bindRange(byId<HTMLInputElement>("width"), byId("width-out"), (v) => patch({ lineWidth: v }));

  byId<HTMLInputElement>("cursor")?.addEventListener("change", (event) => {
    patch({ showCursor: (event.target as HTMLInputElement).checked });
  });
  byId<HTMLInputElement>("invert")?.addEventListener("change", (event) => {
    patch({ invertScroll: (event.target as HTMLInputElement).checked });
  });
}

/** Live label while dragging; the value is only stored on release. */
function bindRange(
  input: HTMLInputElement | null,
  output: HTMLElement | null,
  commit: (value: number) => void,
): void {
  if (!input) return;
  input.addEventListener("input", () => {
    if (output) output.textContent = input.value;
  });
  input.addEventListener("change", () => commit(Number(input.value)));
}

function modeLabel(mode: PrompterMode): string {
  switch (mode) {
    case "presenter": return "Presenter — slides, script as a safety net";
    case "speech": return "Speech — read aloud at a steady pace";
    case "video": return "Video — to camera, fewer words on screen";
    case "notes": return "Notes — manual, no auto-scroll";
    default: return mode;
  }
}

function firstHeading(source: string): string {
  const match = /^#\s+(.+)$/m.exec(source);
  return match?.[1]?.trim() ?? "";
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

function escapeAttr(text: string): string {
  return escapeHtml(text);
}
