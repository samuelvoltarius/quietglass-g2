import { languageSelect, type Locale } from "../i18n";
import { t } from "../messages";
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
  /** Current language; English when the host does not say. */
  readonly getLocale?: () => Locale;
  /** Called when the user picks another language on this page. */
  readonly setLocale?: (locale: Locale) => void;
}

/** Text inputs whose unsaved contents are carried across a redraw. */
const DRAFT_FIELDS = ["name", "url", "token"] as const;

export function mountPhoneUi(ports: PhoneUiPorts): void {
  const root = document.getElementById("app");
  if (!root) return;

  let notice = "";

  const render = (): void => {
    const data = ports.getData();
    const locale = ports.getLocale?.() ?? "en";
    if (document.documentElement) document.documentElement.lang = locale;
    // Whatever is half typed survives a redraw caused by another control.
    const typed = DRAFT_FIELDS.map((id) => root.querySelector<HTMLInputElement>("#" + id)?.value);
    root.innerHTML = template(data, notice, locale);
    DRAFT_FIELDS.forEach((id, index) => {
      const field = root.querySelector<HTMLInputElement>("#" + id);
      const value = typed[index];
      if (field && value !== undefined) field.value = value;
    });
    notice = "";
    wire(root, ports, data, locale, (message) => { notice = message; render(); }, render);
  };

  render();
}

function template(data: StatusData, notice: string, locale: Locale): string {
  const x = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  return `
  <header class="brand">
    <span class="brand-mark">Quietglass</span>
    <h1>Status Glass</h1>
  </header>

  ${notice ? '<p class="notice">' + escapeHtml(notice) + "</p>" : ""}

  <section class="card compact">${languageSelect(locale)}</section>

  <section class="card">
    <h2>${x("p.addTitle")}</h2>
    <label for="name">${x("p.name")}</label>
    <input id="name" type="text" placeholder="${x("p.namePlaceholder")}" />
    <label for="url">${x("p.url")}</label>
    <input id="url" type="text" placeholder="https://host.example/status.json" />
    <details>
      <summary>${x("p.advanced")}</summary>
      <label for="token">${x("p.token")}</label>
      <input id="token" type="password" placeholder="${x("p.tokenPlaceholder")}" />
    </details>
    <button id="add" type="button">${x("p.add")}</button>
    <p class="hint">${x("p.addHint")}</p>
  </section>

  <section class="card">
    <h2>${x("p.sourcesTitle")}</h2>
    ${data.sources.length === 0 ? `<p class="hint">${x("p.sourcesEmpty")}</p>` : ""}
    <ul class="scripts">
      ${data.sources.map((s) => `
        <li>
          <span>
            <strong>${escapeHtml(s.name)}</strong><br />
            <small>${escapeHtml(s.url)}</small><br />
            <small>${escapeHtml(x("p.tokenLine", { mask: maskToken(s.token, locale) }))}</small>
            ${isPlainHttp(s.url) ? `<br /><small class="warn">${x("p.plainHttp")}</small>` : ""}
          </span>
          <button type="button" class="remove" data-id="${escapeHtml(s.id)}">${x("p.remove")}</button>
        </li>`).join("")}
    </ul>
  </section>

  <section class="card">
    <h2>${x("p.pollTitle")}</h2>
    <label for="poll">${x("p.pollLabel", { value: `<output id="poll-out">${data.pollSeconds}</output>` })}</label>
    <input id="poll" type="range" min="5" max="300" step="5" value="${data.pollSeconds}" />
    <p class="hint">${x("p.pollHint")}</p>
    <label class="check"><input id="invert" type="checkbox" ${data.invertScroll ? "checked" : ""} /> ${x("p.invert")}</label>
  </section>

  <section class="card">
    <h2>${x("p.controlsTitle")}</h2>
    <table class="keys">
      <tr><td>${x("p.tap")}</td><td>${x("p.tapDo")}</td></tr>
      <tr><td>${x("p.swipe")}</td><td>${x("p.swipeDo")}</td></tr>
      <tr><td>${x("p.hold")}</td><td>${x("p.holdDo")}</td></tr>
      <tr><td>${x("p.double")}</td><td>${x("p.doubleDo")}</td></tr>
    </table>
    <p class="hint">${x("p.controlsHint")}</p>
  </section>

  <section class="card">
    <h2>${x("p.securityTitle")}</h2>
    <details>
      <summary>${x("p.advanced")}</summary>
      <p class="hint">${x("p.securityToken")}</p>
      <p class="hint">${x("p.securityHttp")}</p>
    </details>
  </section>

  <footer class="hint">${x("p.footer")}</footer>`;
}

function wire(
  root: HTMLElement,
  ports: PhoneUiPorts,
  data: StatusData,
  locale: Locale,
  notify: (message: string) => void,
  rerender: () => void,
): void {
  const byId = <T extends HTMLElement>(id: string): T | null => root.querySelector<T>("#" + id);
  // The page is redrawn from the stored data after every change. It used to
  // stay as first drawn, so the handlers kept the data from that moment: the
  // second source added got the first one's id and replaced it.
  const commit = (next: StatusData): void => {
    const saving = ports.setData(next);
    rerender();
    void saving.catch((thrown: unknown) => {
      notify(t(locale, "p.saveFailed", { error: thrown instanceof Error ? thrown.message : String(thrown) }));
    });
  };

  byId<HTMLSelectElement>("language")?.addEventListener("change", (event) => {
    const value = (event.target as HTMLSelectElement).value;
    ports.setLocale?.(value === "de" ? "de" : "en");
    rerender();
  });

  byId<HTMLButtonElement>("add")?.addEventListener("click", () => {
    const url = byId<HTMLInputElement>("url")?.value.trim() ?? "";
    const check = validateUrl(url, locale);
    if (!check.valid) { notify(check.errors.join(" ")); return; }

    const name = byId<HTMLInputElement>("name")?.value.trim() ?? "";
    const token = byId<HTMLInputElement>("token")?.value ?? "";
    // Emptied before the redraw; the token in particular should not linger.
    for (const id of DRAFT_FIELDS) {
      const field = byId<HTMLInputElement>(id);
      if (field) field.value = "";
    }

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
