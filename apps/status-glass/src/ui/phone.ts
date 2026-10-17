import { languageSelect, type Locale } from "../i18n";
import { t } from "../messages";
import {
  isPlainHttp, maskToken, nextSourceId, removeSource, upsertSource, validateUrl,
  type StatusData,
} from "../storage/persist";
import type { NetworkInfo } from "../protocol/schema";
import { deviceLabel, problems, unacknowledgedProblems, type SourceStatus } from "../monitor/dashboard";
import { hostCells, hostTone, type Tone } from "../cockpit/model";
import { fullestDisk, cpuMetric, percent } from "../glasses/host";
import { isOffline, liveWord, problemText, stateWord, type LiveWord } from "../glasses/view";

/** The home network of one source, as its last report had it. */
export interface PhoneNetwork {
  readonly sourceId: string;
  readonly name: string;
  readonly network: NetworkInfo;
}

/**
 * The phone companion (QUS v1, the look of Rain Lens): exactly three tabs
 * - Jetzt (the state at a glance), Server (every server with its readings and
 * the home network) and Einstellungen (sources, glasses, language).
 *
 * Tokens are write-only in this UI - once saved, the field shows how long the
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
  /** The live state of every source (what the glasses show). */
  readonly getStatuses?: () => readonly SourceStatus[];
  /** True while the glasses show the sample data of the first start. */
  readonly isDemo?: () => boolean;
  /** Asks every source again. */
  readonly refresh?: () => void;
}

export interface PhoneUi {
  /** Redraws the live parts (status pill, "Jetzt", servers, network) after a poll, leaving every input untouched. */
  readonly refreshLive: () => void;
}

/** The three tabs. */
export const TABS: readonly { id: string; icon: string; key: string }[] = [
  { id: "now", icon: "📊", key: "p.tabNow" },
  { id: "servers", icon: "🖥️", key: "p.tabServers" },
  { id: "settings", icon: "⚙️", key: "p.tabSettings" },
];
const TAB_KEY = "quietglass.statusglass.tab";

/** Nothing set up yet: Einstellungen opens first, with the three-step checklist. */
export function isFirstRun(data: StatusData): boolean {
  return data.sources.length === 0;
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

/** Text inputs whose unsaved contents are carried across a redraw. */
const DRAFT_FIELDS = ["name", "url", "token"] as const;

/** How long the second tap on "Entfernen" is waited for. */
const REMOVE_ARM_MS = 4000;

// ---- pure view models (tests read these) ----------------------------------------------

export interface PhoneSummary {
  readonly total: number;
  readonly ok: number;
  /** Problems nobody has seen yet. */
  readonly open: number;
  /** Problems including the seen ones. */
  readonly all: number;
  readonly offline: number;
  readonly cpuMax: number | null;
  readonly diskMax: number | null;
}

export function summarize(sources: readonly SourceStatus[], now: number): PhoneSummary {
  const tones = sources.map((source) => hostTone(source, now));
  const top = (pick: (source: SourceStatus) => number | undefined): number | null => {
    const values = sources.filter((source) => !isOffline(source, now)).map(pick).filter((value): value is number => value !== undefined);
    return values.length === 0 ? null : Math.max(...values);
  };
  return {
    total: sources.length,
    ok: tones.filter((tone) => tone === "ok").length,
    open: unacknowledgedProblems(sources, now).length,
    all: problems(sources, now).length,
    offline: tones.filter((tone) => tone === "offline").length,
    cpuMax: top((source) => { const m = source.report ? cpuMetric(source.report) : undefined; return typeof m?.value === "number" ? m.value : undefined; }),
    diskMax: top((source) => { const m = source.report ? fullestDisk(source.report) : undefined; return m?.value; }),
  };
}

export interface Banner { readonly tone: Tone | "none"; readonly text: string }

/** The one message that counts right now. */
export function bannerFor(sources: readonly SourceStatus[], now: number, demo: boolean, locale: Locale): Banner {
  const x = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  if (sources.length === 0 || demo) return { tone: "none", text: x("p.bannerNone") };
  if (sources.every((source) => source.fetchedAt === null)) return { tone: "none", text: x("p.bannerWaiting") };
  if (sources.every((source) => isOffline(source, now))) return { tone: "offline", text: x("p.bannerOffline") };
  const open = unacknowledgedProblems(sources, now);
  const worst = open[0];
  if (worst) {
    const more = open.length > 1 ? ` (+${open.length - 1})` : "";
    return { tone: worst.state === "critical" ? "critical" : "warn", text: x("p.bannerProblem", { text: `${worst.sourceName}: ${problemText(worst.metric, locale)}${more}` }) };
  }
  const known = problems(sources, now).length;
  return known > 0 ? { tone: "warn", text: x("p.bannerSeen", { n: known }) } : { tone: "ok", text: x("p.bannerOk") };
}

const esc = (text: string): string => escapeHtml(text);

/** "Jetzt": banner, hero card, 2 x 2 key figures, the one button, a card per server. */
export function nowInner(sources: readonly SourceStatus[], now: number, demo: boolean, locale: Locale, pollSeconds: number): string {
  const x = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  const sum = summarize(sources, now);
  const banner = bannerFor(sources, now, demo, locale);
  const num = (value: number | null): string => (value === null ? "–" : percent(value).replace("%", ""));
  const stat = (label: string, value: string, unit: string, alert = false): string =>
    `<div${alert ? ' class="alert"' : ""}><span>${esc(label)}</span><b>${esc(value)}</b><small>${esc(unit)}</small></div>`;
  const cards = sources.map((source) => {
    const tone = hostTone(source, now);
    const cells = hostCells(source, now, locale).slice(0, 3);
    return `<div class="host tone-${tone}"><b>${esc(source.name)}</b><em>${esc(stateWord(source, now, locale))}</em>${cells.map((cell) => `<span>${esc(cell.label)} <i>${esc(cell.value)}</i></span>`).join("")}</div>`;
  });
  return `
    <p class="banner tone-${banner.tone}">${esc(banner.text)}</p>
    <section class="card hero-card">
      <div class="hero">
        <div><span>${esc(x("p.heroLabel"))}</span><strong>${esc(sum.total === 0 ? "–" : x("p.heroValue", { ok: sum.ok, total: sum.total }))}</strong></div>
        <p>${esc(x("p.heroSide", { value: pollSeconds }))}</p>
      </div>
      <div class="stats">
        ${stat(x("p.statProblems"), String(sum.open), x("p.unitOpen"), sum.open > 0)}
        ${stat(x("p.statOffline"), String(sum.offline), x("p.unitServers"), sum.offline > 0)}
        ${stat(x("p.statCpu"), num(sum.cpuMax), x("p.unitPercent"))}
        ${stat(x("p.statDisk"), num(sum.diskMax), x("p.unitPercent"))}
      </div>
      <button id="refresh" type="button" class="big">${esc(x("p.refresh"))}</button>
    </section>
    ${cards.length > 0 ? `<h2 class="strip-title">${esc(x("p.stripTitle"))}</h2><div class="strip">${cards.join("")}</div>` : ""}`;
}

/** "Server": one card per server with its readings and problems. */
export function hostsInner(sources: readonly SourceStatus[], now: number, locale: Locale): string {
  const x = (key: string): string => t(locale, key);
  if (sources.length === 0) return `<section class="card"><p class="hint">${esc(x("p.hostsEmpty"))}</p></section>`;
  return sources.map((source) => {
    const tone = hostTone(source, now);
    const list = problems([source], now);
    return `
    <section class="card server tone-${tone}">
      <div class="server-head"><h2>${esc(source.name)}</h2><span class="tag tone-${tone}">${esc(stateWord(source, now, locale))}</span></div>
      <div class="stats three">${hostCells(source, now, locale).map((cell) => `<div${cell.alert ? ' class="alert"' : ""}><span>${esc(cell.label)}</span><b>${esc(cell.value)}</b></div>`).join("")}</div>
      <h3>${esc(x("p.hostProblems"))}</h3>
      ${list.length === 0 ? `<p class="hint">${esc(x("p.hostNoProblems"))}</p>` : `<ul class="scripts">${list.map((problem) => `<li><span>${esc(problemText(problem.metric, locale))}${problem.acknowledged ? ` <small>${esc(t(locale, "g.ack"))}</small>` : ""}</span></li>`).join("")}</ul>`}
    </section>`;
  }).join("");
}

/** First-run checklist: pure, so tests can read it. */
export function setupInner(data: StatusData, statuses: readonly SourceStatus[], locale: Locale): string {
  const x = (key: string): string => t(locale, key);
  const added = data.sources.length > 0;
  const answered = statuses.some((status) => status.okAt !== null);
  const step = (n: number, done: boolean, key: string): string =>
    `<li class="${done ? "done" : ""}"><span class="num" aria-hidden="true">${done ? "✓" : n}</span><span>${esc(x(key))}</span></li>`;
  return `<ol class="steps">${step(1, added, "p.setup1")}${step(2, added && answered, "p.setup2")}${step(3, added && answered, "p.setup3")}</ol>`
    + (added ? "" : `<p class="hint">${esc(x("p.setupDemo"))}</p>`);
}

function pillOf(word: LiveWord, locale: Locale): { text: string; on: boolean } {
  return word === "live" ? { text: "● " + t(locale, "g.live"), on: true }
    : word === "demo" ? { text: t(locale, "g.demoWord"), on: false }
      : { text: t(locale, "g.offlineWord"), on: false };
}

// ---- mounting ---------------------------------------------------------------------------

export function mountPhoneUi(ports: PhoneUiPorts): PhoneUi {
  const root = document.getElementById("app");
  if (!root) return { refreshLive: () => undefined };

  let notice = "";
  let tab = readTab(isFirstRun(ports.getData()));

  const live = (): { statuses: readonly SourceStatus[]; demo: boolean; now: number } =>
    ({ statuses: ports.getStatuses?.() ?? [], demo: ports.isDemo?.() ?? false, now: Date.now() });

  const render = (): void => {
    const data = ports.getData();
    const locale = ports.getLocale?.() ?? "en";
    if (document.documentElement) document.documentElement.lang = locale;
    // Whatever is half typed survives a redraw caused by another control.
    const typed = DRAFT_FIELDS.map((id) => root.querySelector<HTMLInputElement>("#" + id)?.value);
    root.innerHTML = template(data, notice, locale, ports.getNetworks?.() ?? [], live());
    DRAFT_FIELDS.forEach((id, index) => {
      const field = root.querySelector<HTMLInputElement>("#" + id);
      const value = typed[index];
      if (field && value !== undefined) field.value = value;
    });
    notice = "";
    applyTab(root, tab);
    root.querySelectorAll<HTMLButtonElement>("[data-tab-go]").forEach((button) => {
      button.addEventListener("click", () => {
        tab = button.dataset["tabGo"] ?? "now";
        try { localStorage.setItem(TAB_KEY, tab); } catch { /* private mode */ }
        applyTab(root, tab);
        window.scrollTo({ top: 0 });
      });
    });
    wire(root, ports, data, locale, (message) => { notice = message; render(); }, render);
  };

  render();
  return {
    refreshLive: () => {
      const locale = ports.getLocale?.() ?? "en";
      const data = ports.getData();
      const { statuses, demo, now } = live();
      const set = (selector: string, html: string): void => {
        const el = root.querySelector<HTMLElement>(selector);
        // Unchanged parts are not touched, so a poll never makes the page jump.
        if (el && el.innerHTML !== html) el.innerHTML = html;
      };
      const pill = root.querySelector<HTMLElement>("#pill");
      if (pill) {
        const state = pillOf(liveWord(statuses, now, demo), locale);
        if (pill.textContent !== state.text) pill.textContent = state.text;
        pill.classList?.toggle("on", state.on);
      }
      set("#now-live", nowInner(statuses, now, demo, locale, data.pollSeconds));
      set("#hosts-live", hostsInner(statuses, now, locale));
      set("#netlist", networkHtml(ports.getNetworks?.() ?? [], locale));
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

function template(
  data: StatusData,
  notice: string,
  locale: Locale,
  networks: readonly PhoneNetwork[],
  state: { statuses: readonly SourceStatus[]; demo: boolean; now: number },
): string {
  const x = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  const firstRun = isFirstRun(data);
  const pill = pillOf(liveWord(state.statuses, state.now, state.demo), locale);
  const sourcesCard = `
    <details class="fold card"${firstRun ? " open" : ""}>
      <summary>${esc(firstRun ? x("p.addTitle") : x("p.sourcesCount", { n: data.sources.length }))}</summary>
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
      <h3>${x("p.addTitle")}</h3>
      <label for="name">${x("p.name")}</label>
      <input id="name" type="text" placeholder="${x("p.namePlaceholder")}" />
      <label for="url">${x("p.url")}</label>
      <input id="url" type="text" placeholder="https://host.example/status.json" />
      <details>
        <summary>${x("p.advanced")}</summary>
        <label for="token">${x("p.token")}</label>
        <input id="token" type="password" placeholder="${x("p.tokenPlaceholder")}" />
      </details>
      <button id="add" type="button" class="big">${x("p.add")}</button>
      <p class="hint">${x("p.addHint")}</p>
    </details>`;
  return `
  <header class="brand bar">
    <div>
      <div class="brand-mark">${x("p.kicker")}</div>
      <h1>Status Glass</h1>
    </div>
    <span id="pill" class="chip${pill.on ? " on" : ""}">${escapeHtml(pill.text)}</span>
  </header>

  ${notice ? '<p class="notice">' + escapeHtml(notice) + "</p>" : ""}

  <div class="tab" data-tab="now" id="now">
    <div id="now-live">${nowInner(state.statuses, state.now, state.demo, locale, data.pollSeconds)}</div>
  </div>

  <div class="tab" data-tab="servers">
    <div id="hosts-live">${hostsInner(state.statuses, state.now, locale)}</div>
    <section class="card">
      <h2>${x("p.netTitle")}</h2>
      <div id="netlist">${networkHtml(networks, locale)}</div>
      <p class="hint">${x("p.netHint")}</p>
    </section>
  </div>

  <div class="tab" data-tab="settings">
    ${firstRun ? `<section class="card setup"><h2>${x("p.setupTitle")}</h2>${setupInner(data, state.statuses, locale)}</section>` : ""}
    ${sourcesCard}

    <section class="card">
      <h2>${x("p.glassesTitle")}</h2>
      <label for="poll">${x("p.pollLabel", { value: `<output id="poll-out">${data.pollSeconds}</output>` })}</label>
      <input id="poll" type="range" min="5" max="300" step="5" value="${data.pollSeconds}" />
      <p class="hint">${x("p.pollHint")}</p>
      <label class="check"><input id="invert" type="checkbox" ${data.invertScroll ? "checked" : ""} /> ${x("p.invert")}</label>
      <details class="fold">
        <summary>${x("p.controlsTitle")}</summary>
        <table class="keys">
          <tr><td>${x("p.tap")}</td><td>${x("p.tapDo")}</td></tr>
          <tr><td>${x("p.swipe")}</td><td>${x("p.swipeDo")}</td></tr>
          <tr><td>${x("p.hold")}</td><td>${x("p.holdDo")}</td></tr>
          <tr><td>${x("p.double")}</td><td>${x("p.doubleDo")}</td></tr>
        </table>
        <p class="hint">${x("p.controlsHint")}</p>
      </details>
    </section>

    <section class="card compact">${languageSelect(locale)}</section>

    <details class="fold card">
      <summary>${x("p.moreTitle")}</summary>
      <p class="hint">${x("p.securityToken")}</p>
      <p class="hint">${x("p.securityHttp")}</p>
      <p class="hint">${x("p.footer")}</p>
    </details>
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

  // Removing is the one dangerous thing on this page: the first tap asks, a second one within a few seconds does it.
  root.querySelectorAll<HTMLButtonElement>(".remove").forEach((button) => {
    let armedUntil = 0;
    const label = button.textContent;
    button.addEventListener("click", () => {
      const id = button.dataset["id"];
      if (!id) return;
      if (Date.now() < armedUntil) { commit(removeSource(data, id)); return; }
      armedUntil = Date.now() + REMOVE_ARM_MS;
      button.textContent = t(locale, "p.removeConfirm");
      button.classList?.add("danger");
      setTimeout(() => { armedUntil = 0; button.textContent = label; button.classList?.remove("danger"); }, REMOVE_ARM_MS);
    });
  });

  // One listener for the whole "Jetzt" tab: its content is redrawn after every poll.
  byId("now")?.addEventListener("click", (event) => {
    const target = (event as Event).target as HTMLElement | null;
    if (target?.closest?.("#refresh")) ports.refresh?.();
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
