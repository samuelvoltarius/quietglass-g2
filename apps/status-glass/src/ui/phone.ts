import { languageSelect, type Locale } from "../i18n";
import { t } from "../messages";
import {
  isPlainHttp, maskToken, nextSourceId, removeSource, upsertSource, validateUrl,
  type StatusData,
} from "../storage/persist";
import type { NetworkInfo } from "../protocol/schema";
import { deviceLabel } from "../monitor/dashboard";

/** The home network of one source, as its last report had it. */
export interface PhoneNetwork {
  readonly sourceId: string;
  readonly name: string;
  readonly network: NetworkInfo;
}

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
  /** The home networks the sources report (only sources with a network watch). */
  readonly getNetworks?: () => readonly PhoneNetwork[];
  /** Marks a device as known on its source; resolves to an error text, or null. */
  readonly markKnown?: (sourceId: string, mac: string) => Promise<string | null>;
}

export interface PhoneUi {
  /** Redraws the network tab alone (after a poll), leaving every input untouched. */
  readonly refreshNetwork: () => void;
}

/** The page is split into tabs instead of one long column. */
const TABS: readonly { id: string; icon: string; key: string }[] = [
  { id: "network", icon: "🏠", key: "p.tabNetwork" },
  { id: "glasses", icon: "👓", key: "p.tabGlasses" },
  { id: "sources", icon: "📡", key: "p.tabSources" },
  { id: "more", icon: "⚙️", key: "p.tabMore" },
];
const TAB_KEY = "quietglass.statusglass.tab";

function readTab(): string {
  try { const v = localStorage.getItem(TAB_KEY); return TABS.some((tab) => tab.id === v) ? v! : "sources"; } catch { return "sources"; }
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

/** Text inputs whose unsaved contents are carried across a redraw. */
const DRAFT_FIELDS = ["name", "url", "token"] as const;

export function mountPhoneUi(ports: PhoneUiPorts): PhoneUi {
  const root = document.getElementById("app");
  if (!root) return { refreshNetwork: () => undefined };

  let notice = "";
  let tab = readTab();

  const render = (): void => {
    const data = ports.getData();
    const locale = ports.getLocale?.() ?? "en";
    if (document.documentElement) document.documentElement.lang = locale;
    // Whatever is half typed survives a redraw caused by another control.
    const typed = DRAFT_FIELDS.map((id) => root.querySelector<HTMLInputElement>("#" + id)?.value);
    root.innerHTML = template(data, notice, locale, ports.getNetworks?.() ?? []);
    DRAFT_FIELDS.forEach((id, index) => {
      const field = root.querySelector<HTMLInputElement>("#" + id);
      const value = typed[index];
      if (field && value !== undefined) field.value = value;
    });
    notice = "";
    applyTab(root, tab);
    root.querySelectorAll<HTMLButtonElement>("[data-tab-go]").forEach((button) => {
      button.addEventListener("click", () => {
        tab = button.dataset["tabGo"] ?? "sources";
        try { localStorage.setItem(TAB_KEY, tab); } catch { /* private mode */ }
        applyTab(root, tab);
        window.scrollTo({ top: 0 });
      });
    });
    wire(root, ports, data, locale, (message) => { notice = message; render(); }, render);
  };

  render();
  return {
    refreshNetwork: () => {
      const list = root.querySelector<HTMLElement>("#netlist");
      if (!list) return;
      const html = networkHtml(ports.getNetworks?.() ?? [], ports.getLocale?.() ?? "en");
      // Unchanged lists are not touched, so a poll never makes the page jump.
      if (list.innerHTML !== html) list.innerHTML = html;
    },
  };
}

/** "Netz: 23 Geräte · 1 NEU" per source, then its devices, new ones first. */
export function networkHtml(networks: readonly PhoneNetwork[], locale: Locale): string {
  const x = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  if (networks.length === 0) return `<p class="hint">${x("p.netEmpty")}</p>`;
  return networks.map(({ sourceId, name, network }) => `
    <h3>${escapeHtml(name)} · ${escapeHtml(network.new > 0
      ? x("g.netLineNew", { total: network.total, count: network.new })
      : x("g.netLine", { total: network.total, online: network.online }))}</h3>
    <ul class="scripts devices">
      ${network.devices.map((device) => `
        <li${device.new ? ' class="new"' : ""}>
          <span>
            <strong>${escapeHtml(deviceLabel(device))}</strong>${device.new ? ` <span class="badge">${x("p.netNew")}</span>` : ""}<br />
            <small>${escapeHtml([device.name ? device.ip : undefined, device.mac, x(device.online ? "p.netOnline" : "p.netOffline")].filter(Boolean).join(" · "))}</small>
          </span>
          ${device.known
            ? `<small>${x("p.netKnown")}</small>`
            : `<button type="button" class="mark" data-source="${escapeHtml(sourceId)}" data-mac="${escapeHtml(device.mac)}" data-label="${escapeHtml(deviceLabel(device))}">${x("p.netMarkKnown")}</button>`}
        </li>`).join("")}
    </ul>`).join("");
}

function template(data: StatusData, notice: string, locale: Locale, networks: readonly PhoneNetwork[]): string {
  const x = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  return `
  <header class="brand bar">
    <div>
      <span class="brand-mark">Quietglass</span>
      <h1>Status Glass</h1>
    </div>
    <span class="chip${data.sources.length ? " on" : ""}">${escapeHtml(x(data.sources.length ? "p.chipSources" : "p.chipNone", { n: data.sources.length }))}</span>
  </header>

  ${notice ? '<p class="notice">' + escapeHtml(notice) + "</p>" : ""}

  <div class="tab" data-tab="sources">
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
  </div>

  <div class="tab" data-tab="network">
  <section class="card">
    <h2>${x("p.netTitle")}</h2>
    <div id="netlist">${networkHtml(networks, locale)}</div>
    <p class="hint">${x("p.netHint")}</p>
  </section>
  </div>

  <div class="tab" data-tab="glasses">
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
  </div>

  <div class="tab" data-tab="more">
  <section class="card compact">${languageSelect(locale)}</section>

  <section class="card">
    <h2>${x("p.securityTitle")}</h2>
    <p class="hint">${x("p.securityToken")}</p>
    <p class="hint">${x("p.securityHttp")}</p>
  </section>

  <footer class="hint">${x("p.footer")}</footer>
  </div>

  <nav class="tabbar" role="tablist">
    ${TABS.map(({ id, icon, key }) => `<button type="button" role="tab" data-tab-go="${id}"><span aria-hidden="true">${icon}</span>${escapeHtml(x(key))}</button>`).join("")}
  </nav>`;
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

  // One listener for the whole list: it is redrawn after every poll.
  byId("netlist")?.addEventListener("click", (event) => {
    const target = (event as Event).target as HTMLElement | null;
    const button = target?.closest?.<HTMLButtonElement>("button.mark");
    const sourceId = button?.dataset["source"];
    const mac = button?.dataset["mac"];
    if (!button || !sourceId || !mac || !ports.markKnown || button.disabled) return;
    button.disabled = true;
    const label = button.dataset["label"] ?? mac;
    void ports.markKnown(sourceId, mac).then((error) => {
      notify(error === null ? t(locale, "p.netMarked", { name: label }) : t(locale, "p.netMarkFailed", { error }));
    });
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
