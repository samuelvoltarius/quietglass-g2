import { isLocal, maskToken, validateUrl, type LumenData } from "../storage/persist";
import { drawMoth, lightBar, mothLine } from "../lumen/moth";
import { signIn, signOut, type LumenStatus } from "../lumen/client";
import { languageSelect, type Locale } from "../i18n";
import { t } from "../messages";
import { VERSION } from "../version";

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
  /** First start: the page shows made-up data until an address is saved (QIS v1.2 no. 7). */
  readonly isDemo?: () => boolean;
  /** The raw technical message of the last failure; the glasses never show it (QIS v1.2 no. 8). */
  readonly getLastError?: () => string | null;
  /** Current language; English when the host does not say. */
  readonly getLocale?: () => Locale;
  /** Called when the user picks another language on this page; redraws the glasses. */
  readonly setLocale?: (locale: Locale) => void;
}

/** The page is split into tabs instead of one long column. */
const TABS: readonly { id: string; icon: string; key: string }[] = [
  { id: "moth", icon: "🦋", key: "p.tabMoth" },
  { id: "glasses", icon: "👓", key: "p.tabGlasses" },
  { id: "lumen", icon: "🔌", key: "p.tabLumen" },
  { id: "more", icon: "⚙️", key: "p.tabMore" },
];
const TAB_KEY = "quietglass.lumen-glass.tab";

function readTab(): string {
  try { const v = localStorage.getItem(TAB_KEY); return TABS.some((tab) => tab.id === v) ? v! : "moth"; } catch { return "moth"; }
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

export function mountPhoneUi(ports: PhoneUiPorts): void {
  const root = document.getElementById("app");
  if (!root) return;

  let notice = "";
  let tab = readTab();
  const render = (): void => {
    const locale = ports.getLocale?.() ?? "en";
    if (document.documentElement) document.documentElement.lang = locale;
    root.innerHTML = template(ports.getData(), ports.getStatus(), notice, locale, ports.isDemo?.() ?? false, ports.getLastError?.() ?? null);
    notice = "";
    applyTab(root, tab);
    root.querySelectorAll<HTMLButtonElement>("[data-tab-go]").forEach((button) => {
      button.addEventListener("click", () => {
        tab = button.dataset["tabGo"] ?? "moth";
        try { localStorage.setItem(TAB_KEY, tab); } catch { /* private mode */ }
        applyTab(root, tab);
        window.scrollTo({ top: 0 });
      });
    });
    wire(root, ports, locale, (message) => { notice = message; render(); }, render);
  };

  render();
  // Keep the moth on the phone in step with the glasses.
  setInterval(() => {
    const holder = root.querySelector("#moth");
    const status = ports.getStatus();
    if (holder && status) holder.textContent = drawMoth(status.moth.state).join("\n");
  }, 5000);
}

function template(data: LumenData, status: LumenStatus | null, notice: string, locale: Locale, demo = false, lastError: string | null = null): string {
  const x = (key: string, vars: Record<string, string | number> = {}): string => escapeHtml(t(locale, key, vars));
  return `
  <header class="brand bar">
    <div>
      <span class="brand-mark">Quietglass</span>
      <h1>Lumen Glass</h1>
    </div>
    <span class="chip${status && !demo ? " on" : ""}">${x(demo ? "p.chipDemo" : status ? "p.chipOn" : "p.chipOff")}</span>
  </header>

  ${notice ? '<p class="notice">' + escapeHtml(notice) + "</p>" : ""}

  <div class="tab" data-tab="moth">
  ${demo ? '<p class="notice">' + x("p.demoHint") + "</p>" : ""}
  ${status ? `
  <section class="card">
    <h2>${x("p.mothTitle")}</h2>
    <pre id="moth" class="moth">${escapeHtml(drawMoth(status.moth.state).join("\n"))}</pre>
    <p class="hint">
      <strong>${escapeHtml(mothLine(status.moth.state, status.moth.gesture))}</strong><br />
      <code>${escapeHtml(lightBar(status.moth.light, 16))}</code> ${Math.round(status.moth.light)}
    </p>
    ${status.quest ? `
      <h2>${x("p.questTitle")}</h2>
      <p class="hint">${escapeHtml(status.quest.title)}</p>
      ${status.quest.checkable ? '<p class="hint"><small>' + escapeHtml(status.quest.checkable) + "</small></p>" : ""}
      <button id="shoot" type="button">${x("p.shoot")}</button>
      <p class="hint">${x("p.shootHint")}</p>
    ` : '<p class="hint">' + x("p.noQuest") + "</p>"}
  </section>` : `
  <section class="card">
    <h2>${x("p.notConnected")}</h2>
    <p class="hint">${x("p.notConnectedHint")}</p>
  </section>`}
  </div>

  <div class="tab" data-tab="glasses">
  <section class="card">
    <label class="check"><input id="invert" type="checkbox" ${data.invertScroll ? "checked" : ""} /> ${x("p.invert")}</label>
  </section>

  <section class="card compact">${languageSelect(locale)}</section>
  </div>

  <div class="tab" data-tab="lumen">
  <section class="card">
    <h2>${x("p.lumenTitle")}</h2>
    <label for="url">${x("p.address")}</label>
    <input id="url" type="text" value="${escapeHtml(data.baseUrl)}" placeholder="http://127.0.0.1:8077" />
    <p class="hint">
      ${x("p.addressHint")}
      ${data.baseUrl && !isLocal(data.baseUrl)
        ? '<br /><small class="warn">' + x("p.notLocal") + "</small>"
        : ""}
    </p>

    <button id="save" type="button">${x("p.save")}</button>
  </section>

  <section class="card">
    <h2>${x("p.signInTitle")}</h2>
    <p class="hint">${x("p.token")} — <em>${escapeHtml(maskToken(data.token, locale))}</em></p>
    ${data.token ? `
      <button id="signout" type="button">${x("p.signOut")}</button>
    ` : `
      <label for="name">${x("p.name")}</label>
      <input id="name" type="text" autocomplete="username" autocapitalize="none" />
      <label for="password">${x("p.password")}</label>
      <input id="password" type="password" autocomplete="current-password" />
      <button id="signin" type="button">${x("p.signIn")}</button>
    `}
    <p class="hint">${x("p.tokenHint")}</p>
  </section>
  </div>

  <div class="tab" data-tab="more">
  <section class="card">
    <h2>${x("p.controlsTitle")}</h2>
    <table class="keys">
      <tr><td>${x("p.tap")}</td><td>${x("p.tapDo")}</td></tr>
      <tr><td>${x("p.hold")}</td><td>${x("p.holdDo")}</td></tr>
      <tr><td>${x("p.swipe")}</td><td>${x("p.swipeDo")}</td></tr>
      <tr><td>${x("p.doubleTap")}</td><td>${x("p.doubleTapDo")}</td></tr>
    </table>
    <p class="hint">${x("p.controlsHint")}</p>
  </section>

  <section class="card">
    <p><strong>Lumen Glass</strong> · ${x("p.moreVersion")} ${VERSION}</p>
    ${lastError ? '<p class="hint"><small>' + x("p.lastError", { error: lastError }) + "</small></p>" : ""}
    <p class="hint">${x("p.privacy")}</p>
  </section>
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

  // The switch lives on the "Brille" tab, away from the address and its Save button: it applies at once.
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

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}
