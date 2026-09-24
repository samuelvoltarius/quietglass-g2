import {
  isPlainHttp, maskToken, nextSourceId, removeSource, upsertSource, validateUrl,
  type StatusData,
} from "../storage/persist";

/**
 * The phone companion: sources, credentials and poll interval.
 *
 * Tokens are write-only in this UI — once saved, the field shows how long the
 * token is, never the token. Shoulder-surfing a dashboard should not hand
 * someone your API key.
 */

export interface PhoneUiPorts {
  readonly getData: () => StatusData;
  readonly setData: (data: StatusData) => Promise<void>;
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

function template(data: StatusData, notice: string): string {
  return `
  <header class="brand">
    <span class="brand-mark">Aigner Labs</span>
    <h1>Status Glass</h1>
  </header>

  ${notice ? '<p class="notice">' + escapeHtml(notice) + "</p>" : ""}

  <section class="card">
    <h2>Add a source</h2>
    <label for="name">Name</label>
    <input id="name" type="text" placeholder="nas, pi, web" />
    <label for="url">URL</label>
    <input id="url" type="text" placeholder="https://host.example/status.json" />
    <label for="token">Bearer token (optional)</label>
    <input id="token" type="password" placeholder="sent as an Authorization header" />
    <button id="add" type="button">Add source</button>
    <p class="hint">
      The URL must return the Status Glass JSON shape. See the README for the
      format and a reference server you can copy.
    </p>
  </section>

  <section class="card">
    <h2>Sources</h2>
    ${data.sources.length === 0 ? '<p class="hint">Nothing configured yet.</p>' : ""}
    <ul class="scripts">
      ${data.sources.map((s) => `
        <li>
          <span>
            <strong>${escapeHtml(s.name)}</strong><br />
            <small>${escapeHtml(s.url)}</small><br />
            <small>token: ${escapeHtml(maskToken(s.token))}</small>
            ${isPlainHttp(s.url) ? '<br /><small class="warn">unencrypted http</small>' : ""}
          </span>
          <button type="button" class="remove" data-id="${escapeHtml(s.id)}">Remove</button>
        </li>`).join("")}
    </ul>
  </section>

  <section class="card">
    <h2>Polling</h2>
    <label for="poll">Interval — <output id="poll-out">${data.pollSeconds}</output> s</label>
    <input id="poll" type="range" min="5" max="300" step="5" value="${data.pollSeconds}" />
    <p class="hint">
      A source that fails backs off automatically, up to five minutes, so a host
      that is down is not hammered. Healthy sources keep their normal interval.
    </p>
    <label class="check"><input id="invert" type="checkbox" ${data.invertScroll ? "checked" : ""} /> Invert swipe direction</label>
  </section>

  <section class="card">
    <h2>Controls on the glasses</h2>
    <table class="keys">
      <tr><td>Tap</td><td>Acknowledge the highlighted problem</td></tr>
      <tr><td>Swipe</td><td>Move through the problem list</td></tr>
      <tr><td>Hold</td><td>Refresh every source now</td></tr>
      <tr><td>Double tap</td><td>Leave Status Glass</td></tr>
    </table>
    <p class="hint">
      When everything is healthy the glasses show a single line. Acknowledging
      a problem moves it to the bottom of the list — it never hides it, and it
      comes back if the metric recovers and fails again.
    </p>
  </section>

  <section class="card">
    <h2>Security</h2>
    <p class="hint">
      Tokens are sent in an <code>Authorization</code> header, never in the URL,
      and are stored in this app's private storage on the phone. They are never
      written to logs and never shown in full here.
    </p>
    <p class="hint">
      Prefer <code>https://</code>. Plain <code>http://</code> is permitted
      because homelab services routinely lack certificates, but anything sent
      over it — including your token — travels in the clear.
    </p>
  </section>

  <footer class="hint">
    Status Glass talks only to the sources you configure. There is no vendor
    service, no account and no telemetry.
  </footer>`;
}

function wire(
  root: HTMLElement,
  ports: PhoneUiPorts,
  data: StatusData,
  notify: (message: string) => void,
): void {
  const byId = <T extends HTMLElement>(id: string): T | null => root.querySelector<T>("#" + id);
  const commit = (next: StatusData): void => { void ports.setData(next); };

  byId<HTMLButtonElement>("add")?.addEventListener("click", () => {
    const url = byId<HTMLInputElement>("url")?.value.trim() ?? "";
    const check = validateUrl(url);
    if (!check.valid) { notify(check.errors.join(" ")); return; }

    const name = byId<HTMLInputElement>("name")?.value.trim() ?? "";
    const token = byId<HTMLInputElement>("token")?.value ?? "";

    commit(upsertSource(data, {
      id: nextSourceId(data),
      name: name || hostOf(url),
      url,
      ...(token ? { token } : {}),
    }));
  });

  root.querySelectorAll<HTMLButtonElement>(".remove").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset["id"];
      if (id) commit(removeSource(data, id));
    });
  });

  const poll = byId<HTMLInputElement>("poll");
  const pollOut = byId("poll-out");
  poll?.addEventListener("input", () => { if (pollOut) pollOut.textContent = poll.value; });
  poll?.addEventListener("change", () => commit({ ...data, pollSeconds: Number(poll.value) }));

  byId<HTMLInputElement>("invert")?.addEventListener("change", (event) => {
    commit({ ...data, invertScroll: (event.target as HTMLInputElement).checked });
  });
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "source";
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}
