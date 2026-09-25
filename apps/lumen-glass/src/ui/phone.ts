import { isLocal, maskToken, validateUrl, type LumenData } from "../storage/persist";
import { drawMoth, lightBar, mothLine } from "../lumen/moth";
import type { LumenStatus } from "../lumen/client";

/**
 * The phone companion.
 *
 * Besides the address, it carries a **Take a photo** button — the same action
 * as tapping the temple pad. Sometimes the phone is already in your hand, and
 * having to reach for your face then would be silly.
 */

export interface PhoneUiPorts {
  readonly getData: () => LumenData;
  readonly setData: (data: LumenData) => Promise<void>;
  /** Opens the phone camera and submits the photo. Same as tapping on the glasses. */
  readonly shoot: () => void;
  readonly getStatus: () => LumenStatus | null;
}

export function mountPhoneUi(ports: PhoneUiPorts): void {
  const root = document.getElementById("app");
  if (!root) return;

  let notice = "";
  const render = (): void => {
    root.innerHTML = template(ports.getData(), ports.getStatus(), notice);
    notice = "";
    wire(root, ports, (message) => { notice = message; render(); });
  };

  render();
  // Keep the moth on the phone in step with the glasses.
  setInterval(() => {
    const holder = root.querySelector("#moth");
    const status = ports.getStatus();
    if (holder && status) holder.textContent = drawMoth(status.moth.state).join("\n");
  }, 5000);
}

function template(data: LumenData, status: LumenStatus | null, notice: string): string {
  return `
  <header class="brand">
    <span class="brand-mark">Quietglass</span>
    <h1>Lumen Glass</h1>
  </header>

  ${notice ? '<p class="notice">' + escapeHtml(notice) + "</p>" : ""}

  ${status ? `
  <section class="card">
    <h2>Your moth</h2>
    <pre id="moth" class="moth">${escapeHtml(drawMoth(status.moth.state).join("\n"))}</pre>
    <p class="hint">
      <strong>${escapeHtml(mothLine(status.moth.state, status.moth.gesture))}</strong><br />
      <code>${escapeHtml(lightBar(status.moth.light, 16))}</code> ${Math.round(status.moth.light)}
    </p>
    ${status.quest ? `
      <h2>Quest</h2>
      <p class="hint">${escapeHtml(status.quest.title)}</p>
      ${status.quest.checkable ? '<p class="hint"><small>' + escapeHtml(status.quest.checkable) + "</small></p>" : ""}
      <button id="shoot" type="button">Take a photo and send it</button>
      <p class="hint">
        Opens your phone camera and hands the picture straight to Lumen —
        the same as tapping the temple pad.
      </p>
    ` : '<p class="hint">No open quest. Hold the temple pad to ask for one.</p>'}
  </section>` : `
  <section class="card">
    <h2>Not connected</h2>
    <p class="hint">Enter the address of your Lumen below, then the moth appears here.</p>
  </section>`}

  <section class="card">
    <h2>Your Lumen</h2>
    <label for="url">Address</label>
    <input id="url" type="text" value="${escapeHtml(data.baseUrl)}" placeholder="http://127.0.0.1:8077" />
    <p class="hint">
      Wherever you run Lumen. On your own machine or LAN, nothing leaves the house.
      ${data.baseUrl && !isLocal(data.baseUrl)
        ? '<br /><small class="warn">This address is not on your local network.</small>'
        : ""}
    </p>

    <label for="token">Session cookie — <em>${escapeHtml(maskToken(data.token))}</em></label>
    <input id="token" type="password" placeholder="only needed if Lumen runs in closed mode" />
    <p class="hint">
      Running Lumen just for yourself? Leave this empty — it treats you as the
      default person and no sign-in is needed.
    </p>

    <label class="check"><input id="invert" type="checkbox" ${data.invertScroll ? "checked" : ""} /> Invert swipe direction</label>
    <button id="save" type="button">Save</button>
  </section>

  <section class="card">
    <h2>On the glasses</h2>
    <table class="keys">
      <tr><td>Tap</td><td>Take a photo and send it</td></tr>
      <tr><td>Hold</td><td>Ask for a new quest</td></tr>
      <tr><td>Swipe</td><td>Refresh the moth</td></tr>
      <tr><td>Double tap</td><td>Leave Lumen Glass</td></tr>
    </table>
    <p class="hint">
      The glasses show the moth, the quest, and how long until the next golden
      or blue hour — which is the bit that actually gets you out the door.
    </p>
  </section>

  <footer class="hint">
    Photos go to your Lumen and nowhere else. Nothing is kept on the glasses side.
  </footer>`;
}

function wire(
  root: HTMLElement,
  ports: PhoneUiPorts,
  notify: (message: string) => void,
): void {
  const byId = <T extends HTMLElement>(id: string): T | null => root.querySelector<T>("#" + id);
  const data = ports.getData();

  byId<HTMLButtonElement>("shoot")?.addEventListener("click", () => {
    ports.shoot();
    notify("Camera opening…");
  });

  byId<HTMLButtonElement>("save")?.addEventListener("click", () => {
    const url = byId<HTMLInputElement>("url")?.value.trim() ?? "";
    const check = validateUrl(url);
    if (!check.valid) { notify(check.errors.join(" ")); return; }

    const token = byId<HTMLInputElement>("token")?.value ?? "";
    void ports.setData({
      baseUrl: url,
      // An empty field means "leave the stored token alone", not "clear it".
      ...(token ? { token } : data.token ? { token: data.token } : {}),
      invertScroll: byId<HTMLInputElement>("invert")?.checked ?? false,
    });
  });
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}
