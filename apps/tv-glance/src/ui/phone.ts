import { isPlainHttp, normaliseBase, toApiError, validateUrl } from "../tv/errors";
import { matchRemote, type HaChoice } from "../tv/ha";
import { formatAppList, parseAppList } from "../tv/model";
import { getLocale, languageSelect, setLocale, type Locale } from "../i18n";
import { t } from "../messages";
import { errorReason, shownVolume, type ViewState } from "../glasses/views";
import { activeDeviceOf, addDevice, BUILD_HA_RELAY, BUILD_HA_URL, deviceLabel, effectiveHaToken, effectiveHaUrl, isConfigured, MAX_DEVICES, maskToken, removeDevice, updateDevice, type BackendKind, type Settings } from "../storage/persist";
import { escapeHtml } from "./html";

/**
 * The phone companion (QUS v1, the look of Rain Lens): exactly three tabs -
 * Jetzt (the TV at a glance), Fernseher (choose the TV, D-pad remote, app
 * list) and Einstellungen (connection, glasses, language). The view models are
 * pure so the tests can read them. Tokens are write-only fields: never shown,
 * only "set (n chars)".
 */

export type PhoneConnection =
  | { readonly kind: "demo" }
  | { readonly kind: "loading" }
  | { readonly kind: "ok" }
  | { readonly kind: "error"; readonly reason: string };

/** Relay builds: the state of the relay's device list (`/config`). */
export type RelayState = "checking" | "ok" | "empty" | "unreachable";

export interface HaEntities { readonly players: readonly HaChoice[]; readonly remotes: readonly HaChoice[] }

export interface PhoneUiPorts {
  readonly getSettings: () => Settings;
  readonly saveSettings: (next: Settings) => Promise<void>;
  readonly connection: () => PhoneConnection;
  /** The live state (what the glasses show). */
  readonly state: () => ViewState;
  readonly refresh?: () => void;
  /** Relay builds: whether the relay's device list could be fetched. */
  readonly relayState?: () => RelayState;
  /** The relay address of this build; defaults to the build's own (tests pass one). */
  readonly relay?: string;
  /** GET /api/states of Home Assistant with the given address and token. */
  readonly listEntities?: (url: string, token: string) => Promise<HaEntities>;
  /** The page's own origin, for Home Assistant's cors_allowed_origins. */
  readonly origin?: () => string;
  readonly locale?: () => Locale;
  readonly onLocaleChange?: (locale: Locale) => void;
  readonly build?: string;
}

export interface PhoneUi {
  readonly refresh: () => void;
}

export const TABS: readonly { id: string; icon: string; key: string }[] = [
  { id: "now", icon: "📺", key: "p.tabNow" },
  { id: "tv", icon: "🎛️", key: "p.tabTv" },
  { id: "settings", icon: "⚙️", key: "p.tabSettings" },
];
const TAB_KEY = "quietglass.tvglance.tab";

/** Nothing set up yet: Einstellungen opens first, with the three-step checklist. */
export function isFirstRun(settings: Settings): boolean {
  return !isConfigured(settings);
}

function readTab(firstRun: boolean): string {
  try { const v = localStorage.getItem(TAB_KEY); if (TABS.some((tab) => tab.id === v)) return v!; } catch { /* no storage */ }
  return firstRun ? "settings" : "now";
}

function applyTab(root: HTMLElement, active: string): void {
  root.querySelectorAll<HTMLElement>("[data-tab]").forEach((el) => { el.hidden = el.dataset["tab"] !== active; });
  root.querySelectorAll<HTMLButtonElement>("[data-tab-go]").forEach((button) => {
    const on = button.dataset["tabGo"] === active;
    button.classList.toggle("on", on);
    button.setAttribute("aria-selected", String(on));
  });
}

const DRAFT_FIELDS = ["ha-url", "ha-token", "bridge-url", "bridge-token"] as const;
const esc = (text: string): string => escapeHtml(text);

// ---- pure view models (tests read these) ----------------------------------------------

export interface Banner { readonly tone: "ok" | "warn" | "offline" | "none"; readonly text: string }

export function bannerFor(state: ViewState, connection: PhoneConnection, settings: Settings): Banner {
  const x = (key: string, vars: Record<string, string | number> = {}): string => t(state.locale, key, vars);
  if (connection.kind === "demo") {
    if (settings.backend === "ha" && isConfigured(settings) && !activeDeviceOf(settings)) return { tone: "warn", text: x("p.banner.noTv") };
    return { tone: "none", text: x("p.banner.demo") };
  }
  if (connection.kind === "loading") return { tone: "none", text: x("p.banner.loading") };
  if (connection.kind === "error") return { tone: "offline", text: x("p.banner.error", { reason: connection.reason }) };
  if (state.tv?.unavailable) return { tone: "offline", text: x("p.banner.unavailable", { name: state.device?.name || state.tv.name }) };
  return state.tv?.power === "off" ? { tone: "none", text: x("p.banner.off") } : { tone: "ok", text: x("p.banner.on") };
}

export function pillOf(state: ViewState, connection: PhoneConnection): { text: string; on: boolean } {
  const key = connection.kind === "demo" ? "p.pill.demo"
    : connection.kind === "error" ? "p.pill.error"
      : connection.kind === "loading" || !state.tv ? "p.pill.loading"
        : state.tv.unavailable ? "p.pill.unavailable"
          : state.tv.power === "off" ? "p.pill.off" : "p.pill.on";
  return { text: t(state.locale, key), on: connection.kind === "ok" && state.tv?.power === "on" };
}

/** "Jetzt": banner, hero card (what runs), 2 x 2 key figures, the one button. */
export function nowInner(state: ViewState, connection: PhoneConnection, settings: Settings): string {
  const { locale, tv } = state;
  const x = (key: string, vars: Record<string, string | number> = {}): string => t(locale, key, vars);
  const banner = bannerFor(state, connection, settings);
  const stat = (label: string, value: string): string => `<div><span>${esc(label)}</span><b>${esc(value)}</b></div>`;
  const what = tv && tv.power === "on" ? (tv.app ?? tv.source ?? tv.name) : x("p.hero.nothing");
  const volume = shownVolume(state);
  const via = connection.kind === "demo" ? x("p.via.demo") : settings.backend === "ha" ? x("p.via.ha") : x("p.via.bridge");
  return `
    <p class="banner tone-${banner.tone}">${esc(banner.text)}</p>
    <section class="card hero-card">
      <div class="hero">
        <div><span>${esc(x("p.hero.label"))}</span><strong>${esc(what || "–")}</strong></div>
        <p>${esc(tv?.title ?? "")}</p>
      </div>
      <div class="stats">
        ${stat(x("p.stat.power"), tv ? t(locale, "g.power." + tv.power) : "–")}
        ${stat(x("p.stat.volume"), tv?.muted ? t(locale, "g.cp.muted") : volume === null ? "–" : String(volume))}
        ${stat(x("p.stat.source"), tv?.source ?? "–")}
        ${stat(x("p.stat.via"), via)}
      </div>
      <button id="refresh" type="button" class="big">${esc(x("p.refresh"))}</button>
    </section>
    <p class="hint">${esc(x("p.c.power"))}</p>`;
}

/** "Fernseher": the Home Assistant picker (or a note for the bridge) and the app list. */
export function tvInner(settings: Settings, locale: Locale, entities: HaEntities | null, status: string): string {
  const L = (key: string, vars: Record<string, string | number> = {}): string => esc(t(locale, key, vars));
  let picker = "";
  if (settings.backend !== "ha") {
    picker = `<p class="hint">${L("p.tv.onlyHa")}</p>`;
  } else {
    const players = entities?.players ?? [];
    const remotes = entities?.remotes ?? [];
    const active = activeDeviceOf(settings);
    const card = (device: Settings["devices"][number]): string => {
      const friendly = players.find((p) => p.id === device.entityId)?.name;
      const options = [...new Set([...remotes.map((r) => r.id), ...(device.remoteId ? [device.remoteId] : [])])];
      return `
        <div class="device" data-device="${esc(device.entityId)}">
          <p><b>${esc(deviceLabel(device, friendly))}</b>${device === active ? ` · <small>${L("p.dev.active")}</small>` : ""}<br><small>${esc(device.entityId)}</small></p>
          <label for="name-${esc(device.entityId)}">${L("p.dev.name")}</label>
          <input id="name-${esc(device.entityId)}" type="text" maxlength="40" autocomplete="off" data-dev-name="${esc(device.entityId)}" value="${esc(device.name)}" placeholder="${esc(friendly ?? "")}" />
          <button type="button" data-dev-save="${esc(device.entityId)}">${L("p.dev.rename")}</button>
          <label for="remote-${esc(device.entityId)}">${L("p.tv.remote")}</label>
          <select id="remote-${esc(device.entityId)}" data-dev-remote="${esc(device.entityId)}">
            <option value=""${device.remoteId === "" ? " selected" : ""}>${L("p.tv.remoteNone")}</option>
            ${options.map((id) => `<option value="${esc(id)}"${id === device.remoteId ? " selected" : ""}>${esc(remotes.find((r) => r.id === id)?.name ?? id)}</option>`).join("")}
          </select>
          <button type="button" class="remove" data-dev-remove="${esc(device.entityId)}">${L("p.dev.remove")}</button>
        </div>`;
    };
    picker = `
      <h3>${L("p.dev.title")}</h3>
      ${settings.devices.length === 0 ? `<p class="hint">${L("p.dev.empty", { max: MAX_DEVICES })}</p>` : settings.devices.map(card).join("")}
      ${settings.devices.length >= 2 ? `<p class="hint">${L("p.dev.switchHint")}</p>` : ""}
      <button id="load-tvs" type="button" class="big"${isConfigured(settings) ? "" : " disabled"}>${L("p.tv.load")}</button>
      ${status ? `<p class="hint">${esc(status)}</p>` : ""}
      ${entities && players.length === 0 ? `<p class="hint">${L("p.tv.none")}</p>` : ""}
      ${players.length > 0 ? `<p class="hint">${L("p.dev.add")}${settings.devices.length >= MAX_DEVICES ? " · " + L("p.dev.max", { max: MAX_DEVICES }) : ""}</p>
      <div class="pick">${players.map((p) => `<button type="button" class="choice${settings.devices.some((d) => d.entityId === p.id) ? " on" : ""}" data-player="${esc(p.id)}"><b>${esc(p.name)}</b><small>${esc(p.id)} · ${esc(p.state)}</small></button>`).join("")}</div>` : ""}
      <p class="hint">${L("p.tv.remoteHint")}</p>`;
  }
  return `
    <section class="card"><h2>${L("p.tv.title")}</h2>${picker}</section>
    <section class="card">
      <h2>${L("p.apps.title")}</h2>
      <textarea id="apps" rows="5" autocomplete="off" spellcheck="false">${esc(formatAppList(settings.apps))}</textarea>
      <p class="hint">${L("p.apps.hint")}</p>
      <button id="save-apps" type="button">${L("p.apps.save")}</button>
    </section>`;
}

/**
 * Relay builds (private): replaces the address and token fields. Shows that the connection is automatic and
 * what the relay and the connection say right now.
 */
export function relayInner(settings: Settings, connection: PhoneConnection, relay: RelayState, locale: Locale): string {
  const L = (key: string, vars: Record<string, string | number> = {}): string => esc(t(locale, key, vars));
  let status: string;
  if (relay === "unreachable") status = L("p.relay.unreachable");
  else if (relay === "empty") status = L("p.relay.empty");
  else if (relay === "checking" && settings.devices.length === 0) status = L("p.relay.checking");
  else if (connection.kind === "error") status = L("p.banner.error", { reason: connection.reason });
  else status = L("p.relay.ok", { count: settings.devices.length });
  const bad = relay === "unreachable" || relay === "empty" || connection.kind === "error";
  return `
    <section class="card relay">
      <h2>${L("p.relay.title")}</h2>
      <p class="hint">${L("p.relay.info")}</p>
      <p class="banner tone-${bad ? "offline" : "none"}" id="relay-status">${status}</p>
    </section>`;
}

export function setupInner(settings: Settings, answered: boolean, locale: Locale): string {
  const step = (n: number, done: boolean, key: string): string =>
    `<li class="${done ? "done" : ""}"><span class="num" aria-hidden="true">${done ? "✓" : n}</span><span>${esc(t(locale, key))}</span></li>`;
  const chosen = settings.backend !== "none";
  const configured = isConfigured(settings);
  const tvChosen = configured && (settings.backend === "bridge" || settings.devices.length > 0);
  return `<ol class="steps">${step(1, chosen, "p.setup.1")}${step(2, configured, "p.setup.2")}${step(3, tvChosen && answered, "p.setup.3")}</ol>`
    + `<p class="hint">${esc(t(locale, "p.setup.demo"))}</p>`
    // Plain text, no link: a URL in the bundle must match the network whitelist exactly (store review).
    + `<p class="hint">${esc(t(locale, "p.setup.guide"))}</p>`;
}

/**
 * Troubleshooting only: the app talks to Home Assistant over its WebSocket API, which needs no CORS entry.
 * Only the REST fallback (used when the WebSocket cannot be reached) needs this page's origin in
 * `cors_allowed_origins`. Shown folded, with the real origin (nothing hard-coded).
 */
export function corsInner(origin: string, locale: Locale): string {
  const shown = origin && origin !== "null" ? origin : t(locale, "p.ha.originUnknown");
  return `<details class="fold"><summary>${esc(t(locale, "p.ha.trouble"))}</summary><p class="hint">${esc(t(locale, "p.ha.cors"))}</p><pre class="code">http:\n  cors_allowed_origins:\n    - ${esc(shown)}</pre></details>`;
}

// ---- mounting ---------------------------------------------------------------------------

export function mountPhoneUi(ports: PhoneUiPorts): PhoneUi {
  const root = document.getElementById("app");
  if (!root) return { refresh: () => undefined };

  let notice = "";
  let locale: Locale = ports.locale?.() ?? getLocale();
  let tab = readTab(isFirstRun(ports.getSettings()));
  let entities: HaEntities | null = null;
  let tvStatus = "";

  const render = (): void => {
    const typed = DRAFT_FIELDS.map((id) => root.querySelector<HTMLInputElement>("#" + id)?.value);
    root.innerHTML = template(ports, { ...ports.state(), locale }, notice, entities, tvStatus);
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
    DRAFT_FIELDS.forEach((id, index) => {
      const field = root.querySelector<HTMLInputElement>("#" + id);
      const value = typed[index];
      if (field && value !== undefined && value !== "") field.value = value;
    });
    wire();
  };

  const notify = (message: string): void => { notice = message; render(); };

  const commit = (next: Settings): Promise<void> => ports.saveSettings(next).then(
    () => notify(t(locale, "p.saved")),
    (thrown: unknown) => notify(t(locale, "p.saveFailed", { reason: thrown instanceof Error ? thrown.message : String(thrown) })),
  );

  const clearField = (id: string): void => { const field = root.querySelector<HTMLInputElement>("#" + id); if (field) field.value = ""; };

  const wire = (): void => {
    const byId = <T extends HTMLElement>(id: string): T | null => root.querySelector<T>("#" + id);

    byId<HTMLSelectElement>("language")?.addEventListener("change", (event) => {
      const value = (event.target as HTMLSelectElement).value;
      if (value !== "de" && value !== "en") return;
      locale = value;
      setLocale(locale);
      ports.onLocaleChange?.(locale);
      render();
    });

    byId<HTMLButtonElement>("refresh")?.addEventListener("click", () => { ports.refresh?.(); });

    byId<HTMLSelectElement>("backend")?.addEventListener("change", (event) => {
      const value = (event.target as HTMLSelectElement).value;
      const backend: BackendKind = value === "ha" || value === "bridge" ? value : "none";
      void commit({ ...ports.getSettings(), backend });
    });

    byId<HTMLButtonElement>("save-ha")?.addEventListener("click", () => {
      const current = ports.getSettings();
      const typedUrl = normaliseBase(byId<HTMLInputElement>("ha-url")?.value ?? "") || current.haUrl;
      // Empty is fine when the build carries its own address (private builds).
      const check = typedUrl === "" && BUILD_HA_URL ? { valid: true, errors: [] } : validateUrl(typedUrl, true);
      if (!check.valid) { notify(check.errors.map((key) => t(locale, key)).join(" ")); return; }
      // The token field is write-only: left empty, the stored token is kept.
      const token = (byId<HTMLInputElement>("ha-token")?.value ?? "").trim() || current.haToken;
      if (!token) { notify(t(locale, "p.err.tokenRequired")); return; }
      clearField("ha-token");
      clearField("ha-url");
      const urlChanged = typedUrl !== current.haUrl;
      void commit({ ...current, backend: "ha", haUrl: typedUrl, haToken: token, ...(urlChanged ? { devices: [], activeDevice: 0 } : {}) });
    });

    byId<HTMLButtonElement>("save-bridge")?.addEventListener("click", () => {
      const current = ports.getSettings();
      const typedUrl = normaliseBase(byId<HTMLInputElement>("bridge-url")?.value ?? "") || current.bridgeUrl;
      const check = validateUrl(typedUrl);
      if (!check.valid) { notify(check.errors.map((key) => t(locale, key)).join(" ")); return; }
      const token = (byId<HTMLInputElement>("bridge-token")?.value ?? "").trim() || current.bridgeToken;
      clearField("bridge-token");
      clearField("bridge-url");
      void commit({ ...current, backend: "bridge", bridgeUrl: typedUrl, ...(token ? { bridgeToken: token } : {}) });
    });

    byId<HTMLButtonElement>("clear-ha-token")?.addEventListener("click", () => {
      const { haToken: _drop, ...rest } = ports.getSettings();
      void commit(rest);
    });
    byId<HTMLButtonElement>("clear-bridge-token")?.addEventListener("click", () => {
      const { bridgeToken: _drop, ...rest } = ports.getSettings();
      void commit(rest);
    });

    byId<HTMLButtonElement>("load-tvs")?.addEventListener("click", () => {
      const current = ports.getSettings();
      const token = effectiveHaToken(current, ports.relay);
      if (!ports.listEntities || !token) return;
      tvStatus = t(locale, "p.tv.loading");
      render();
      ports.listEntities(effectiveHaUrl(current, undefined, ports.relay), token).then(
        (found) => { entities = found; tvStatus = ""; render(); },
        (error: unknown) => {
          const problem = toApiError(error);
          tvStatus = t(locale, "p.banner.error", { reason: errorReason(locale, problem.code, problem.status, true) });
          render();
        },
      );
    });

    // Tapping a player adds it as a device (the remote with the same object id is paired); tapping it again removes it.
    root.querySelectorAll<HTMLButtonElement>("[data-player]").forEach((button) => {
      button.addEventListener("click", () => {
        const id = button.dataset["player"] ?? "";
        if (!id.startsWith("media_player.")) return;
        const current = ports.getSettings();
        if (current.devices.some((d) => d.entityId === id)) { void commit(removeDevice(current, id)); return; }
        if (current.devices.length >= MAX_DEVICES) { notify(t(locale, "p.dev.max", { max: MAX_DEVICES })); return; }
        const remote = entities ? matchRemote(id, entities.players, entities.remotes) : "";
        const friendly = entities?.players.find((p) => p.id === id)?.name ?? "";
        void commit(addDevice(current, { entityId: id, remoteId: remote, name: friendly.slice(0, 40) }));
      });
    });

    root.querySelectorAll<HTMLButtonElement>("[data-dev-remove]").forEach((button) => {
      button.addEventListener("click", () => { void commit(removeDevice(ports.getSettings(), button.dataset["devRemove"] ?? "")); });
    });

    root.querySelectorAll<HTMLButtonElement>("[data-dev-save]").forEach((button) => {
      button.addEventListener("click", () => {
        const id = button.dataset["devSave"] ?? "";
        const field = root.querySelector<HTMLInputElement>(`[data-dev-name="${id}"]`);
        void commit(updateDevice(ports.getSettings(), id, { name: (field?.value ?? "").trim().slice(0, 40) }));
      });
    });

    root.querySelectorAll<HTMLSelectElement>("[data-dev-remote]").forEach((select) => {
      select.addEventListener("change", () => {
        const value = select.value;
        void commit(updateDevice(ports.getSettings(), select.dataset["devRemote"] ?? "", { remoteId: value.startsWith("remote.") ? value : "" }));
      });
    });

    byId<HTMLButtonElement>("save-apps")?.addEventListener("click", () => {
      const text = byId<HTMLTextAreaElement>("apps")?.value ?? "";
      void commit({ ...ports.getSettings(), apps: parseAppList(text) });
    });

    byId<HTMLInputElement>("invert")?.addEventListener("change", (event) => {
      void commit({ ...ports.getSettings(), invertScroll: (event.target as HTMLInputElement).checked });
    });
  };

  render();
  return { refresh: render };
}

function template(ports: PhoneUiPorts, state: ViewState, notice: string, entities: HaEntities | null, tvStatus: string): string {
  const settings = ports.getSettings();
  const connection = ports.connection();
  const { locale } = state;
  const L = (key: string, vars: Record<string, string | number> = {}): string => escapeHtml(t(locale, key, vars));
  const firstRun = isFirstRun(settings);
  const pill = pillOf(state, connection);
  const relay = ports.relay ?? BUILD_HA_RELAY;
  const answered = connection.kind === "ok";
  const option = (value: BackendKind, key: string): string => `<option value="${value}"${settings.backend === value ? " selected" : ""}>${L(key)}</option>`;

  return `
  <header class="brand bar">
    <div>
      <div class="brand-mark">${L("p.kicker")}</div>
      <h1>TV Glance</h1>
    </div>
    <span id="pill" class="chip${pill.on ? " on" : ""}">${esc(pill.text)}</span>
  </header>

  ${notice ? `<p class="notice">${escapeHtml(notice)}</p>` : ""}

  <div class="tab" data-tab="now"><div id="now-live">${nowInner(state, connection, settings)}</div></div>
  <div class="tab" data-tab="tv">${tvInner(settings, locale, entities, tvStatus)}</div>

  <div class="tab" data-tab="settings">
    ${firstRun ? `<section class="card setup"><h2>${L("p.setup.title")}</h2>${setupInner(settings, answered, locale)}</section>` : ""}
    ${relay ? relayInner(settings, connection, ports.relayState?.() ?? "checking", locale) : `<section class="card compact">
      <label for="backend">${L("p.backend")}</label>
      <select id="backend">${option("none", "p.backend.none")}${option("ha", "p.backend.ha")}${option("bridge", "p.backend.bridge")}</select>
    </section>`}

    ${!relay && settings.backend === "ha" ? `
    <details class="fold card"${isConfigured(settings) ? "" : " open"}>
      <summary>${L("p.ha")}</summary>
      <label for="ha-url">${L("p.ha.url")}</label>
      <input id="ha-url" type="text" inputmode="url" autocomplete="off" value="${escapeHtml(settings.haUrl)}" placeholder="${BUILD_HA_URL ? escapeHtml(BUILD_HA_URL) : L("p.ha.urlPlaceholder")}" />
      ${BUILD_HA_URL ? `<p class="hint">${L("p.ha.urlBuild")}</p>` : ""}
      ${effectiveHaUrl(settings) && isPlainHttp(effectiveHaUrl(settings)) ? `<p class="hint"><small class="warn">${L("p.httpWarn")}</small></p>` : ""}
      <label for="ha-token">${L("p.ha.token")}</label>
      <input id="ha-token" type="password" autocomplete="off" placeholder="${L("p.tokenPlaceholder")}" />
      <p class="hint">${L("p.tokenNow", { state: maskToken(settings.haToken, locale) })} · ${L("p.ha.tokenHint")}</p>
      <p class="hint">${L("p.ha.ws")}</p>
      <button id="save-ha" type="button" class="big">${L("p.save")}</button>
      ${settings.haToken ? `<button id="clear-ha-token" type="button" class="remove">${L("p.tokenClear")}</button>` : ""}
      ${corsInner(ports.origin?.() ?? "", locale)}
    </details>` : ""}

    ${!relay && settings.backend === "bridge" ? `
    <details class="fold card"${isConfigured(settings) ? "" : " open"}>
      <summary>${L("p.bridge")}</summary>
      <label for="bridge-url">${L("p.bridge.url")}</label>
      <input id="bridge-url" type="text" inputmode="url" autocomplete="off" value="${escapeHtml(settings.bridgeUrl)}" placeholder="${L("p.bridge.urlPlaceholder")}" />
      ${settings.bridgeUrl && isPlainHttp(settings.bridgeUrl) ? `<p class="hint"><small class="warn">${L("p.httpWarn")}</small></p>` : ""}
      <label for="bridge-token">${L("p.bridge.token")}</label>
      <input id="bridge-token" type="password" autocomplete="off" placeholder="${L("p.tokenPlaceholder")}" />
      <p class="hint">${L("p.tokenNow", { state: maskToken(settings.bridgeToken, locale) })}</p>
      <button id="save-bridge" type="button" class="big">${L("p.save")}</button>
      ${settings.bridgeToken ? `<button id="clear-bridge-token" type="button" class="remove">${L("p.tokenClear")}</button>` : ""}
    </details>` : ""}

    <section class="card">
      <h2>${L("p.glasses")}</h2>
      <label class="check"><input id="invert" type="checkbox" ${settings.invertScroll ? "checked" : ""} /> ${L("p.invert")}</label>
      <details class="fold">
        <summary>${L("p.controls")}</summary>
        <table class="keys">
          <tr><td>${L("p.c.tap")}</td><td>${L("p.c.tap.d")}</td></tr>
          <tr><td>${L("p.c.swipe")}</td><td>${L("p.c.swipe.d")}</td></tr>
          <tr><td>${L("p.c.double")}</td><td>${L("p.c.double.d")}</td></tr>
        </table>
        <p class="hint">${L("p.c.power")}</p>
      </details>
    </section>

    <section class="card compact">${languageSelect(locale)}</section>

    <details class="fold card">
      <summary>${L("p.more")}</summary>
      <p class="hint">${L("p.lede")}</p>
      <p class="hint">${L("p.privacy")}${ports.build ? " · " + escapeHtml(ports.build) : ""}</p>
    </details>
  </div>

  <nav class="tabbar" role="tablist">
    ${TABS.map(({ id, icon, key }) => `<button type="button" role="tab" data-tab-go="${id}"><span aria-hidden="true">${icon}</span>${L(key)}</button>`).join("")}
  </nav>`;
}
