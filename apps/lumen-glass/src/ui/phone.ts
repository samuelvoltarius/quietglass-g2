import { isLocal, maskToken, validateUrl, type LumenData } from "../storage/persist";
import { signIn, signOut, type LumenStatus } from "../lumen/client";
import { languageSelect, type Locale } from "../i18n";
import { t } from "../messages";
import { questMeta, windowLabel } from "../glasses/view";
import { mothTone, windowTime } from "../cockpit/model";
import { VERSION } from "../version";

/**
 * The phone companion (QUS v1, the look of Rain Lens): exactly three tabs -
 * Jetzt (the moth at a glance, with the one button that takes the photo),
 * Quest (the open quest in full) and Einstellungen (connection, glasses,
 * language). The view models are pure so the tests can read them.
 */

export interface PhoneUiPorts {
  readonly getData: () => LumenData;
  readonly setData: (data: LumenData) => Promise<void>;
  /** Opens the phone camera and submits the photo. Same as tapping on the glasses. */
  readonly shoot: () => void;
  readonly getStatus: () => LumenStatus | null;
  /** First start: the page shows made-up data until an address is saved (QIS v1.2 no. 7). */
  readonly isDemo?: () => boolean;
  /** The raw technical message of the last failure; the glasses never show it (QIS v1.2 no. 8). */
  readonly getLastError?: () => string | null;
  /** Current language; English when the host does not say. */
  readonly getLocale?: () => Locale;
  /** Called when the user picks another language on this page; redraws the glasses. */
  readonly setLocale?: (locale: Locale) => void;
}

export interface PhoneUi {
  /** Redraws the live parts (pill, "Jetzt", "Quest") after a poll, leaving every input untouched. */
  readonly refreshLive: () => void;
}

/** What the phone shows of the live state. */
export interface PhoneView {
  readonly status: LumenStatus | null;
  readonly demo: boolean;
  readonly lastError: string | null;
}

/** The three tabs. */
export const TABS: readonly { id: string; icon: string; key: string }[] = [
  { id: "now", icon: "🦋", key: "p.tabNow" },
  { id: "quest", icon: "📷", key: "p.tabQuest" },
  { id: "settings", icon: "⚙️", key: "p.tabSettings" },
];
const TAB_KEY = "quietglass.lumen-glass.tab";

/** Nothing set up yet: Einstellungen opens first, with the three-step checklist. */
export function isFirstRun(demo: boolean): boolean {
  return demo;
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

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}
const esc = (text: string): string => escapeHtml(text);

// ---- pure view models (tests read these) ----------------------------------------------

export interface Banner { readonly tone: "ok" | "warn" | "critical" | "offline" | "none"; readonly text: string }

/** The one message that counts right now. */
export function bannerFor(view: PhoneView, locale: Locale): Banner {
  const x = (key: string): string => t(locale, key);
  if (view.demo) return { tone: "none", text: x("p.banner.demo") };
  if (!view.status) return { tone: view.lastError ? "offline" : "none", text: x(view.lastError ? "p.banner.offline" : "p.banner.loading") };
  if (view.status.quest) return { tone: "ok", text: x("p.banner.quest") };
  return { tone: "none", text: x("p.banner.noQuest") };
}

/** The status pill: connected, offline or demo. */
export function pillOf(view: PhoneView, locale: Locale): { text: string; on: boolean } {
  if (view.demo) return { text: t(locale, "p.pill.demo"), on: false };
  return view.status ? { text: t(locale, "p.pill.live"), on: true } : { text: t(locale, "p.pill.offline"), on: false };
}

/** "Jetzt": banner, hero card (the moth's light), 2 x 2 key figures, the one button, the current quest as a card. */
export function nowInner(view: PhoneView, locale: Locale): string {
  const x = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  const { status } = view;
  const banner = bannerFor(view, locale);
  const stat = (label: string, value: string, unit: string, alert = false): string =>
    `<div${alert ? ' class="alert"' : ""}><span>${esc(label)}</span><b>${esc(value)}</b><small>${esc(unit)}</small></div>`;
  const tone = mothTone({ status, error: view.lastError });
  const windowText = status?.window ? windowLabel(status.window.kind, status.window.minutesAway, locale) : "–";
  const card = status?.quest
    ? `<div class="host tone-ok"><b>${esc(status.quest.title)}</b><em>${esc(questMeta(status.quest, locale))}</em><span>${esc(status.quest.task ?? "")}</span></div>`
    : "";
  return `
    <p class="banner tone-${banner.tone}">${esc(banner.text)}</p>
    <section class="card hero-card">
      <div class="hero">
        <div><span>${esc(x("p.hero.label"))}</span><strong>${esc(status ? `${Math.round(status.moth.light)}` : "–")}</strong></div>
        <p>${esc(status ? status.moth.state : "")}</p>
      </div>
      <div class="stats">
        ${stat(x("p.stat.state"), status ? status.moth.state : "–", "", tone === "warn")}
        ${stat(x("p.stat.streak"), status && status.moth.streak > 0 ? String(status.moth.streak) : "–", x("p.unit.days"))}
        ${stat(x("p.stat.window"), status?.window ? windowTime(status.window.minutesAway, locale) : "–", status?.window ? windowText.split(" ")[0] ?? "" : "")}
        ${stat(x("p.stat.open"), status ? String(status.openQuests) : "–", x("p.unit.quests"))}
      </div>
      ${status?.quest ? `<button id="shoot" type="button" class="big">${esc(x("p.shoot"))}</button>` : ""}
    </section>
    ${card ? `<h2 class="strip-title">${esc(x("p.strip.quest"))}</h2><div class="strip">${card}</div>` : ""}`;
}

/** "Quest": the open quest in full. */
export function questInner(view: PhoneView, locale: Locale): string {
  const x = (key: string): string => t(locale, key);
  const quest = view.status?.quest;
  if (!quest) return `<section class="card"><p class="hint">${esc(x("p.quest.none"))}</p></section>`;
  return `
    <section class="card server tone-ok">
      <div class="server-head"><h2>${esc(quest.title)}</h2><span class="tag tone-ok">${esc(questMeta(quest, locale))}</span></div>
      <p>${esc(quest.task ?? "")}</p>
      ${quest.checkable ? `<p class="hint">${esc(x("p.quest.check"))}: ${esc(quest.checkable)}</p>` : ""}
      <p class="hint">${esc(x("p.shootHint"))}</p>
    </section>`;
}

/** First-run checklist: pure, so tests can read it. */
export function setupInner(demo: boolean, answered: boolean, locale: Locale): string {
  const added = !demo;
  const step = (n: number, done: boolean, key: string): string =>
    `<li class="${done ? "done" : ""}"><span class="num" aria-hidden="true">${done ? "✓" : n}</span><span>${esc(t(locale, key))}</span></li>`;
  return `<ol class="steps">${step(1, added, "p.setup.1")}${step(2, added, "p.setup.2")}${step(3, added && answered, "p.setup.3")}</ol>`
    + (added ? "" : `<p class="hint">${esc(t(locale, "p.setup.demo"))}</p>`);
}

// ---- mounting ---------------------------------------------------------------------------

export function mountPhoneUi(ports: PhoneUiPorts): PhoneUi {
  const root = document.getElementById("app");
  if (!root) return { refreshLive: () => undefined };

  let notice = "";
  let tab = readTab(isFirstRun(ports.isDemo?.() ?? false));
  const view = (): PhoneView => ({ status: ports.getStatus(), demo: ports.isDemo?.() ?? false, lastError: ports.getLastError?.() ?? null });

  const render = (): void => {
    const locale = ports.getLocale?.() ?? "en";
    if (document.documentElement) document.documentElement.lang = locale;
    root.innerHTML = template(ports.getData(), view(), notice, locale);
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
    wire(root, ports, locale, (message) => { notice = message; render(); }, render);
  };

  render();

  const refreshLive = (): void => {
    const locale = ports.getLocale?.() ?? "en";
    const current = view();
    const set = (selector: string, html: string): void => {
      const el = root.querySelector<HTMLElement>(selector);
      // Unchanged parts are not touched, so a poll never makes the page jump.
      if (el && typeof el.innerHTML === "string" && el.innerHTML !== html) el.innerHTML = html;
    };
    const pill = root.querySelector<HTMLElement>("#pill");
    if (pill && typeof pill.textContent === "string") {
      const state = pillOf(current, locale);
      if (pill.textContent !== state.text) pill.textContent = state.text;
      pill.classList?.toggle("on", state.on);
    }
    set("#now-live", nowInner(current, locale));
    set("#quest-live", questInner(current, locale));
  };
  // The poll of the glasses keeps the moth on the phone in step.
  setInterval(refreshLive, 5000);
  return { refreshLive };
}

function template(data: LumenData, view: PhoneView, notice: string, locale: Locale): string {
  const x = (key: string, vars: Record<string, string | number> = {}): string => escapeHtml(t(locale, key, vars));
  const firstRun = isFirstRun(view.demo);
  const pill = pillOf(view, locale);
  return `
  <header class="brand bar">
    <div>
      <div class="brand-mark">${x("p.kicker")}</div>
      <h1>Lumen Glass</h1>
    </div>
    <span id="pill" class="chip${pill.on ? " on" : ""}">${esc(pill.text)}</span>
  </header>

  ${notice ? '<p class="notice">' + escapeHtml(notice) + "</p>" : ""}

  <div class="tab" data-tab="now"><div id="now-live">${nowInner(view, locale)}</div></div>
  <div class="tab" data-tab="quest"><div id="quest-live">${questInner(view, locale)}</div></div>

  <div class="tab" data-tab="settings">
    ${firstRun ? `<section class="card setup"><h2>${x("p.setup.title")}</h2>${setupInner(view.demo, view.status !== null, locale)}</section>` : ""}
    <details class="fold card"${firstRun ? " open" : ""}>
      <summary>${x(firstRun ? "p.connection" : "p.connection.set")}</summary>
      <label for="url">${x("p.address")}</label>
      <input id="url" type="text" value="${escapeHtml(data.baseUrl)}" placeholder="http://127.0.0.1:8077" />
      <p class="hint">
        ${x("p.addressHint")}
        ${data.baseUrl && !isLocal(data.baseUrl)
          ? '<br /><small class="warn">' + x("p.notLocal") + "</small>"
          : ""}
      </p>
      <button id="save" type="button" class="big">${x("p.save")}</button>

      <h3>${x("p.signInTitle")}</h3>
      <p class="hint">${x("p.token")} — <em>${escapeHtml(maskToken(data.token, locale))}</em></p>
      ${data.token ? `
        <button id="signout" type="button" class="remove">${x("p.signOut")}</button>
      ` : `
        <label for="name">${x("p.name")}</label>
        <input id="name" type="text" autocomplete="username" autocapitalize="none" />
        <label for="password">${x("p.password")}</label>
        <input id="password" type="password" autocomplete="current-password" />
        <button id="signin" type="button">${x("p.signIn")}</button>
      `}
      <p class="hint">${x("p.tokenHint")}</p>
    </details>

    <section class="card">
      <h2>${x("p.glasses")}</h2>
      <label class="check"><input id="invert" type="checkbox" ${data.invertScroll ? "checked" : ""} /> ${x("p.invert")}</label>
      <details class="fold">
        <summary>${x("p.controlsTitle")}</summary>
        <table class="keys">
          <tr><td>${x("p.tap")}</td><td>${x("p.tapDo")}</td></tr>
          <tr><td>${x("p.swipe")}</td><td>${x("p.swipeDo")}</td></tr>
          <tr><td>${x("p.hold")}</td><td>${x("p.holdDo")}</td></tr>
          <tr><td>${x("p.doubleTap")}</td><td>${x("p.doubleTapDo")}</td></tr>
        </table>
        <p class="hint">${x("p.controlsHint")}</p>
      </details>
    </section>

    <section class="card compact">${languageSelect(locale)}</section>

    <details class="fold card">
      <summary>${x("p.more")}</summary>
      <p><strong>Lumen Glass</strong> · ${x("p.version")} ${VERSION}</p>
      ${view.lastError ? '<p class="hint"><small>' + x("p.lastError", { error: view.lastError }) + "</small></p>" : ""}
      <p class="hint">${x("p.privacy")}</p>
    </details>
  </div>

  <nav class="tabbar" role="tablist">
    ${TABS.map(({ id, icon, key }) => `<button type="button" role="tab" data-tab-go="${id}"><span aria-hidden="true">${icon}</span>${x(key)}</button>`).join("")}
  </nav>`;
}

function wire(
  root: HTMLElement,
  ports: PhoneUiPorts,
  locale: Locale,
  notify: (message: string) => void,
  rerender: () => void,
): void {
  const byId = <T extends HTMLElement>(id: string): T | null => root.querySelector<T>("#" + id);

  byId<HTMLSelectElement>("language")?.addEventListener("change", (event) => {
    const value = (event.target as HTMLSelectElement).value;
    ports.setLocale?.(value === "de" ? "de" : "en");
    rerender();
  });

  // The switch lives on the "Einstellungen" tab, away from the address and its Save button: it applies at once.
  byId<HTMLInputElement>("invert")?.addEventListener("change", (event) => {
    void ports.setData({ ...ports.getData(), invertScroll: (event.target as HTMLInputElement).checked });
  });

  byId<HTMLButtonElement>("shoot")?.addEventListener("click", () => {
    ports.shoot();
    notify(t(locale, "p.cameraOpening"));
  });

  byId<HTMLButtonElement>("save")?.addEventListener("click", () => {
    const url = byId<HTMLInputElement>("url")?.value.trim() ?? "";
    const check = validateUrl(url, locale);
    if (!check.valid) { notify(check.errors.join(" ")); return; }

    // Read the stored token now, not when the page was drawn: a sign-in in
    // between must not be undone by saving the address.
    const current = ports.getData();
    void ports.setData({
      baseUrl: url,
      ...(current.token ? { token: current.token } : {}),
      invertScroll: current.invertScroll,
    });
  });

  // Name and password go to LUMEN once; only the session token it returns is
  // kept, in the app's own storage. The password is never stored.
  byId<HTMLButtonElement>("signin")?.addEventListener("click", () => {
    const name = byId<HTMLInputElement>("name")?.value.trim() ?? "";
    const password = byId<HTMLInputElement>("password")?.value ?? "";
    if (!name || !password) { notify(t(locale, "p.needBoth")); return; }
    void (async () => {
      const outcome = await signIn({ baseUrl: ports.getData().baseUrl }, name, password);
      const answer = outcome.value;
      if (answer?.kind === "token") {
        await ports.setData({ ...ports.getData(), token: answer.token });
        notify(t(locale, "p.signedIn"));
      } else if (answer?.kind === "open") notify(t(locale, "p.signInOpen"));
      else if (answer?.kind === "wrong") notify(t(locale, "p.signInWrong"));
      else if (answer?.kind === "locked") notify(t(locale, "p.signInLocked"));
      else notify(t(locale, "p.signInFailed", { error: outcome.error ?? "?" }));
    })();
  });

  byId<HTMLButtonElement>("signout")?.addEventListener("click", () => {
    void (async () => {
      const current = ports.getData();
      await signOut({ baseUrl: current.baseUrl, ...(current.token ? { token: current.token } : {}) });
      const { token: _dropped, ...rest } = current;
      await ports.setData(rest);
      notify(t(locale, "p.signedOut"));
    })();
  });
}
