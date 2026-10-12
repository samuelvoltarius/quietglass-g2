/** Phone-side setup and status UI. Glasses remain deliberately minimal. */
import { languageSelect, type Locale } from "../i18n";
import type { HubModel } from "../hub/model";

export interface AppSettings {
  readonly serverUrl: string;
  readonly token: string;
  readonly autoOpenNotifications: boolean;
}

export interface PhoneState {
  readonly model: HubModel;
  readonly locale: Locale;
  readonly settings: AppSettings;
}

export interface PhoneHandlers {
  readonly onLocale: (locale: Locale) => void;
  readonly onSettings: (settings: AppSettings) => Promise<boolean>;
  readonly onScanQr: () => Promise<AppSettings>;
}

const copy = {
  de: {
    agentsOnline: "Agenten online", connected: "Verbunden", disconnected: "Nicht verbunden", devices: "Geräte", notifications: "Meldungen",
    setup: "Einrichtung", scan: "▦ QR-Code vom Pi scannen", scanHint: "Öffnet die Handykamera. Server und Token werden aus dem QR-Code übernommen.", manual: "oder manuell",
    server: "Server-Adresse", token: "Zugangs-Token", save: "Speichern & Verbindung testen",
    display: "Anzeige", language: "Sprache", auto: "Neue Agenten-Meldung automatisch öffnen",
    agents: "Hermes, OpenClaw, Codex und Claude melden Fertig/Wartet/Fehler über denselben Hub.",
    controls: "Brillensteuerung", swipe: "Wischen", select: "Eintrag wählen", tap: "Tippen", open: "Öffnen oder ausführen",
    double: "Doppeltipp", back: "Zurück; auf Übersicht beenden", hold: "Halten", speak: "Beim Agenten sprechen",
    private: "Konfiguration bleibt auf diesem Gerät.", checking: "Verbindung wird geprüft …", camera: "Kamera wird geöffnet …",
    saved: "✓ Verbunden und gespeichert", failed: "Verbindung fehlgeschlagen – Daten sind gespeichert",
    scanned: "✓ QR-Code erkannt und verbunden", unreachable: "QR erkannt, Server aber nicht erreichbar", scanFailed: "QR-Code konnte nicht gelesen werden",
  },
  en: {
    agentsOnline: "agents online", connected: "Connected", disconnected: "Not connected", devices: "devices", notifications: "notifications",
    setup: "Setup", scan: "▦ Scan QR code from Pi", scanHint: "Opens the phone camera and imports the server and access token.", manual: "or enter manually",
    server: "Server address", token: "Access token", save: "Save & test connection",
    display: "Display", language: "Language", auto: "Open new agent notifications automatically",
    agents: "Hermes, OpenClaw, Codex and Claude report Done/Waiting/Error through the same hub.",
    controls: "Glasses controls", swipe: "Swipe", select: "Select item", tap: "Tap", open: "Open or execute",
    double: "Double tap", back: "Back; exit on overview", hold: "Hold", speak: "Speak on Agent page",
    private: "Configuration stays on this device.", checking: "Testing connection …", camera: "Opening camera …",
    saved: "✓ Connected and saved", failed: "Connection failed – settings were saved",
    scanned: "✓ QR code imported and connected", unreachable: "QR imported, but server is unreachable", scanFailed: "QR code could not be read",
  },
} as const;

function esc(value: string): string {
  return value.replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character] ?? character);
}

export function mountPhoneUi(root: HTMLElement, state: () => PhoneState, handlers: PhoneHandlers): () => void {
  let notice = "";
  let busy = false;

  const readForm = (): AppSettings => ({
    serverUrl: (root.querySelector("#server") as HTMLInputElement | null)?.value.trim() ?? "",
    token: (root.querySelector("#token") as HTMLInputElement | null)?.value.trim() ?? "",
    autoOpenNotifications: (root.querySelector("#auto-open") as HTMLInputElement | null)?.checked ?? true,
  });

  const render = (): void => {
    const { model, locale, settings } = state();
    const c = copy[locale];
    const connected = model.report.connection === "connected";
    const unread = model.report.inbox.events.filter((event) => !event.read).length;
    root.innerHTML = `
      <header class="brand"><span class="pixel-logo" aria-hidden="true">▦</span><div><div class="brand-mark">QUIETGLASS</div><h1>Quiet Hub</h1></div></header>
      <section class="card status-card">
        <div><span class="dot ${connected ? "ok" : "bad"}"></span><strong>${connected ? c.connected : c.disconnected}</strong></div>
        <div class="metrics"><span>${model.report.agents.filter((agent) => agent.online).length}/${model.report.agents.length} ${c.agentsOnline}</span><span>${model.report.home.devices.length} ${c.devices}</span><span>${unread} ${c.notifications}</span></div>
      </section>
      <section class="card">
        <h2>${c.setup}</h2>
        <button id="scan" class="primary" type="button" ${busy ? "disabled" : ""}>${c.scan}</button>
        <p class="hint">${c.scanHint}</p>
        <div class="divider"><span>${c.manual}</span></div>
        <label for="server">${c.server}</label>
        <input id="server" type="url" value="${esc(settings.serverUrl)}" placeholder="http://pi5:8787" autocomplete="url" />
        <label for="token">${c.token}</label>
        <input id="token" type="password" value="${esc(settings.token)}" autocomplete="off" />
        <button id="save" type="button" ${busy ? "disabled" : ""}>${c.save}</button>
        ${notice ? `<p class="notice">${esc(notice)}</p>` : ""}
      </section>
      <section class="card">
        <h2>${c.display}</h2>
        ${languageSelect(locale)}
        <label class="check"><input id="auto-open" type="checkbox" ${settings.autoOpenNotifications ? "checked" : ""} /> ${c.auto}</label>
        <p class="hint">${c.agents}</p>
      </section>
      <section class="card">
        <h2>${c.controls}</h2>
        <table class="keys"><tr><td>${c.swipe}</td><td>${c.select}</td></tr><tr><td>${c.tap}</td><td>${c.open}</td></tr><tr><td>${c.double}</td><td>${c.back}</td></tr><tr><td>${c.hold}</td><td>${c.speak}</td></tr></table>
      </section>
      <footer class="hint">Quiet Hub ${esc(model.screen)} · ${c.private}</footer>
    `;

    root.querySelector("#language")?.addEventListener("change", (event) => handlers.onLocale((event.target as HTMLSelectElement).value as Locale));
    root.querySelector("#auto-open")?.addEventListener("change", () => { void handlers.onSettings(readForm()); });
    root.querySelector("#save")?.addEventListener("click", async () => {
      const next = readForm();
      busy = true; notice = c.checking; render();
      const ok = await handlers.onSettings(next).catch(() => false);
      busy = false; notice = ok ? c.saved : c.failed; render();
    });
    root.querySelector("#scan")?.addEventListener("click", async () => {
      busy = true; notice = c.camera; render();
      try {
        const scanned = await handlers.onScanQr();
        const ok = await handlers.onSettings(scanned);
        notice = ok ? c.scanned : c.unreachable;
      } catch (error) {
        notice = error instanceof Error ? error.message : c.scanFailed;
      } finally {
        busy = false; render();
      }
    });
  };

  render();
  return render;
}
