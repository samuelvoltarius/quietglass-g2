import { isLocal, maskToken, validateUrl, type LumenData } from "../storage/persist";
import { drawMoth, lightBar, mothLine } from "../lumen/moth";
import type { LumenStatus } from "../lumen/client";
import { languageSelect, type Locale } from "../i18n";
import { t } from "../messages";

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
  /** Current language; English when the host does not say. */
  readonly getLocale?: () => Locale;
  /** Called when the user picks another language on this page; redraws the glasses. */
  readonly setLocale?: (locale: Locale) => void;
}

export function mountPhoneUi(ports: PhoneUiPorts): void {
  const root = document.getElementById("app");
  if (!root) return;

  let notice = "";
  const render = (): void => {
    const locale = ports.getLocale?.() ?? "en";
    if (document.documentElement) document.documentElement.lang = locale;
    root.innerHTML = template(ports.getData(), ports.getStatus(), notice, locale);
    notice = "";
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

function template(data: LumenData, status: LumenStatus | null, notice: string, locale: Locale): string {
  const x = (key: string, vars: Record<string, string | number> = {}): string => escapeHtml(t(locale, key, vars));
  return `
  <header class="brand">
    <span class="brand-mark">Quietglass</span>
    <h1>Lumen Glass</h1>
  </header>

  <section class="card compact">${languageSelect(locale)}</section>

  ${notice ? '<p class="notice">' + escapeHtml(notice) + "</p>" : ""}

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

    <label class="check"><input id="invert" type="checkbox" ${data.invertScroll ? "checked" : ""} /> ${x("p.invert")}</label>

    <details${data.token ? " open" : ""}>
      <summary>${x("p.advanced")}</summary>
      <label for="token">${x("p.token")} — <em>${escapeHtml(maskToken(data.token, locale))}</em></label>
      <input id="token" type="password" placeholder="${x("p.tokenPlaceholder")}" />
      <p class="hint">${x("p.tokenHint")}</p>
    </details>

    <button id="save" type="button">${x("p.save")}</button>
  </section>

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

  <footer class="hint">${x("p.privacy")}</footer>`;
}

function wire(
  root: HTMLElement,
  ports: PhoneUiPorts,
  locale: Locale,
  notify: (message: string) => void,
  rerender: () => void,
): void {
  const byId = <T extends HTMLElement>(id: string): T | null => root.querySelector<T>("#" + id);
  const data = ports.getData();

  byId<HTMLSelectElement>("language")?.addEventListener("change", (event) => {
    const value = (event.target as HTMLSelectElement).value;
    ports.setLocale?.(value === "de" ? "de" : "en");
    rerender();
  });

  byId<HTMLButtonElement>("shoot")?.addEventListener("click", () => {
    ports.shoot();
    notify(t(locale, "p.cameraOpening"));
  });

  byId<HTMLButtonElement>("save")?.addEventListener("click", () => {
    const url = byId<HTMLInputElement>("url")?.value.trim() ?? "";
    const check = validateUrl(url, locale);
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
