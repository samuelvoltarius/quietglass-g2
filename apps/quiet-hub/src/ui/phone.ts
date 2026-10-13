/** Phone-side setup and status UI. Glasses remain deliberately minimal. */
import { languageSelect, type Locale } from "../i18n";
import type { HubModel } from "../hub/model";

export interface AppSettings {
  readonly serverUrl: string;
  readonly token: string;
  readonly autoOpenNotifications: boolean;
  /** Real G2 hardware may report swipes the other way round than the simulator. */
  readonly invertScroll: boolean;
  /** Send a voice note without the "Verstanden: …" confirmation tap. Off by default. */
  readonly voiceAutoSend: boolean;
  /** Read agent answers aloud on the phone (AirPods / headphones). Off by default. */
  readonly speakAnswers: boolean;
  /** Near-blank glasses display while the agent on display works. Off by default. */
  readonly quietWhileWorking: boolean;
}

export type ConnProblem = "missing" | "unreachable" | "unauthorized" | "timeout" | "error" | "insecure";

/** What the phone page shows about the link to the hub. */
export interface ConnView {
  readonly configured: boolean;
  readonly connected: boolean;
  /** Server host only, never the token. */
  readonly host: string;
  readonly lastOkAt: number | null;
  readonly problem: ConnProblem | null;
  readonly lastErrorAt: number | null;
  readonly fails: number;
  /** Raw error text of the last failed request (e.g. "TypeError: Load failed"). */
  readonly raw?: string;
}

export interface SettingsResult {
  readonly ok: boolean;
  /** The SDK key-value store returned the written value on read-back. */
  readonly persisted: boolean;
  readonly problem: ConnProblem | null;
}

export interface TestResult {
  readonly ok: boolean;
  readonly problem: ConnProblem | null;
  readonly ms: number;
}

export interface PhoneState {
  readonly model: HubModel;
  readonly locale: Locale;
  readonly settings: AppSettings;
  readonly conn: ConnView;
  /** off | needs-activation | ready | speaking | unavailable */
  readonly speech: string;
}

export interface PhoneHandlers {
  readonly onLocale: (locale: Locale) => void;
  readonly onSettings: (settings: AppSettings) => Promise<SettingsResult>;
  readonly onTest: (settings: AppSettings) => Promise<TestResult>;
  readonly onScanQr: () => Promise<AppSettings>;
  /** Called from the tap itself: browsers only allow speech after a user gesture. */
  readonly onSpeechActivate: () => void;
}

const copy = {
  de: {
    agentsOnline: "Agenten online", connected: "Verbunden", disconnected: "Nicht verbunden", devices: "Geräte", notifications: "Meldungen",
    setup: "Einrichtung", scan: "▦ QR-Code vom Pi scannen", scanHint: "Öffnet die Handykamera. Server und Token werden aus dem QR-Code übernommen.", manual: "oder manuell",
    server: "Server-Adresse", token: "Zugangs-Token", save: "Speichern & Verbindung testen",
    display: "Anzeige", language: "Sprache", auto: "Neue Agenten-Meldung automatisch öffnen (nur auf der Übersicht)", invert: "Wischrichtung umkehren (falls oben/unten vertauscht ist)", voiceAuto: "Sprachnotiz sofort senden (sonst: Tippen bestätigt „Verstanden: …“)", speakAnswers: "Antworten vorlesen (AirPods / Kopfhörer, Code und Passwörter werden übersprungen)", speakOn: "Vorlesen aktivieren", speech_off: "aus", speech_needs_activation: "einmal „Vorlesen aktivieren“ tippen", speech_ready: "bereit", speech_speaking: "spricht", speech_unavailable: "in dieser Handy-Ansicht nicht verfügbar",
    quiet: "Ruhe während der Agent arbeitet: Brille fast dunkel (Text aus, Helligkeit 0, keine Bilder), bis er fertig ist, eine Freigabe braucht oder eine Meldung kommt. Tippen/Wischen zeigt 20 s den Fortschritt. Auch im Brillen-Menü der Agent-Seite.",
    agents: "Hermes, OpenClaw, Codex und Claude melden Fertig/Wartet/Fehler über denselben Hub.",
    controls: "Brillensteuerung", swipe: "Wischen", select: "Eintrag wählen", tap: "Tippen", open: "Öffnen oder ausführen",
    double: "Doppeltipp", back: "Zurück; läuft ein Agent: Stopp; Übersicht: beenden", hold: "Halten", speak: "In die Sitzung sprechen (max. 18 s), dann Tippen = senden, 2× = verwerfen", menuKey: "Tippen + Halten", menu: "Menü der Seite (Stoppen, Neue Sitzung, Alle gelesen …)", ring: "R1-Ring", ringDo: "2× tippen = Seitenwahl, Wischen = wählen",
    private: "Konfiguration bleibt auf diesem Gerät.", checking: "Verbindung wird geprüft …", camera: "Kamera wird geöffnet …",
    saved: "✓ Verbunden und gespeichert", failed: "Verbindung fehlgeschlagen – Daten sind gespeichert",
    scanned: "✓ QR-Code erkannt und verbunden", unreachable: "QR erkannt, Server aber nicht erreichbar", scanFailed: "QR-Code konnte nicht gelesen werden",
    technical: "Technisch",
    test: "Verbindung testen", testing: "Teste …", testOk: "✓ Verbindung ok", notSaved: "⚠ Konnte nicht dauerhaft gespeichert werden",
    notConnectedServer: "Nicht verbunden · Server fehlt", scanFirst: "Zum Verbinden zuerst den QR-Code vom Pi scannen.",
    serverLabel: "Server", lastOk: "Letzter Erfolg", never: "noch nie", lastError: "Letzter Fehler", none: "keiner", tries: "Fehlversuche in Folge",
    p_missing: "Server fehlt", p_unreachable: "Server nicht erreichbar", p_unauthorized: "Token falsch", p_timeout: "Zeitüberschreitung", p_error: "Verbindungsfehler",
    p_insecure: "Server muss https sein – z. B. https://<pi>.<tailnet>.ts.net:8443",
  },
  en: {
    agentsOnline: "agents online", connected: "Connected", disconnected: "Not connected", devices: "devices", notifications: "notifications",
    setup: "Setup", scan: "▦ Scan QR code from Pi", scanHint: "Opens the phone camera and imports the server and access token.", manual: "or enter manually",
    server: "Server address", token: "Access token", save: "Save & test connection",
    display: "Display", language: "Language", auto: "Open new agent notifications automatically (overview only)", invert: "Reverse swipe direction (if up/down feels swapped)", voiceAuto: "Send voice notes immediately (otherwise a tap confirms \"Understood: …\")", speakAnswers: "Read answers aloud (AirPods / headphones; code and secrets are skipped)", speakOn: "Activate spoken output", speech_off: "off", speech_needs_activation: "tap “Activate spoken output” once", speech_ready: "ready", speech_speaking: "speaking", speech_unavailable: "not available in this phone view",
    quiet: "Quiet while the agent works: glasses nearly dark (text off, brightness 0, no images) until it is done, needs a permission or an alert arrives. Tap/swipe shows progress for 20 s. Also in the glasses menu of the Agent page.",
    agents: "Hermes, OpenClaw, Codex and Claude report Done/Waiting/Error through the same hub.",
    controls: "Glasses controls", swipe: "Swipe", select: "Select item", tap: "Tap", open: "Open or execute",
    double: "Double tap", back: "Back; stops a running agent; exit on overview", hold: "Hold", speak: "Speak into the session (max 18 s), then tap = send, 2x = discard", menuKey: "Tap + hold", menu: "Page menu (Stop, New session, Mark all read …)", ring: "R1 ring", ringDo: "double tap = page picker, swipe = select",
    private: "Configuration stays on this device.", checking: "Testing connection …", camera: "Opening camera …",
    saved: "✓ Connected and saved", failed: "Connection failed – settings were saved",
    scanned: "✓ QR code imported and connected", unreachable: "QR imported, but server is unreachable", scanFailed: "QR code could not be read",
    technical: "Technical",
    test: "Test connection", testing: "Testing …", testOk: "✓ Connection ok", notSaved: "⚠ Could not be stored permanently",
    notConnectedServer: "Not connected · server missing", scanFirst: "To connect, scan the QR code from the Pi first.",
    serverLabel: "Server", lastOk: "Last success", never: "never", lastError: "Last error", none: "none", tries: "Failed attempts in a row",
    p_missing: "Server missing", p_unreachable: "Server unreachable", p_unauthorized: "Wrong token", p_timeout: "Timed out", p_error: "Connection error",
    p_insecure: "Server must be https - e.g. https://<pi>.<tailnet>.ts.net:8443",
  },
} as const;

function clock(at: number | null): string {
  if (at === null) return "";
  const d = new Date(at);
  const two = (n: number): string => String(n).padStart(2, "0");
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

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
    invertScroll: (root.querySelector("#invert-scroll") as HTMLInputElement | null)?.checked ?? false,
    voiceAutoSend: (root.querySelector("#voice-auto") as HTMLInputElement | null)?.checked ?? false,
    speakAnswers: (root.querySelector("#speak") as HTMLInputElement | null)?.checked ?? false,
    quietWhileWorking: (root.querySelector("#quiet") as HTMLInputElement | null)?.checked ?? false,
  });

  const describe = (ok: boolean, problem: ConnProblem | null, good: string, bad: string): string => {
    if (ok) return good;
    const c = copy[state().locale];
    return problem === null ? bad : `✗ ${c[`p_${problem}` as keyof typeof c]}`;
  };

  const render = (): void => {
    const { model, locale, settings, conn } = state();
    const c = copy[locale];
    const connected = conn.connected;
    const reason = conn.problem === null ? "" : c[`p_${conn.problem}` as keyof typeof c];
    const title = connected ? c.connected : conn.problem === "missing" || !conn.configured ? c.notConnectedServer : `${c.disconnected} · ${reason}`;
    const scanBlock = `<button id="scan" class="primary" type="button" ${busy ? "disabled" : ""}>${c.scan}</button><p class="hint">${c.scanHint}</p>`;
    const unread = model.report.inbox.events.filter((event) => !event.read).length;
    root.innerHTML = `
      <header class="brand"><span class="pixel-logo" aria-hidden="true">▦</span><div><div class="brand-mark">QUIETGLASS</div><h1>Quiet Hub</h1></div></header>
      <section class="card status-card">
        <div><span class="dot ${connected ? "ok" : "bad"}"></span><strong>${esc(title)}</strong></div>
        <div class="metrics"><span>${c.serverLabel}: ${esc(conn.host || "–")}</span><span>${c.lastOk}: ${conn.lastOkAt === null ? c.never : clock(conn.lastOkAt)}</span><span>${c.lastError}: ${conn.problem === null ? c.none : `${esc(String(reason))}${conn.lastErrorAt === null ? "" : ` (${clock(conn.lastErrorAt)})`}`}</span>${conn.fails > 0 ? `<span>${c.tries}: ${conn.fails}</span>` : ""}${conn.raw ? `<span>${c.technical}: ${esc(conn.raw)}</span>` : ""}</div>
        ${connected ? "" : scanBlock}
        <div class="metrics"><span>${model.report.agents.filter((agent) => agent.online).length}/${model.report.agents.length} ${c.agentsOnline}</span><span>${model.report.home.devices.length} ${c.devices}</span><span>${unread} ${c.notifications}</span></div>
      </section>
      <section class="card">
        <h2>${c.setup}</h2>
        ${connected ? scanBlock : ""}
        <div class="divider"><span>${c.manual}</span></div>
        <label for="server">${c.server}</label>
        <input id="server" type="url" value="${esc(settings.serverUrl)}" placeholder="http://pi5:8787" autocomplete="url" />
        <label for="token">${c.token}</label>
        <input id="token" type="password" value="${esc(settings.token)}" autocomplete="off" />
        <button id="save" type="button" ${busy ? "disabled" : ""}>${c.save}</button>
        <button id="test" type="button" ${busy ? "disabled" : ""}>${c.test}</button>
        ${notice ? `<p class="notice">${esc(notice)}</p>` : ""}
      </section>
      <section class="card">
        <h2>${c.display}</h2>
        ${languageSelect(locale)}
        <label class="check"><input id="auto-open" type="checkbox" ${settings.autoOpenNotifications ? "checked" : ""} /> ${c.auto}</label>
        <label class="check"><input id="invert-scroll" type="checkbox" ${settings.invertScroll ? "checked" : ""} /> ${c.invert}</label>
        <label class="check"><input id="voice-auto" type="checkbox" ${settings.voiceAutoSend ? "checked" : ""} /> ${c.voiceAuto}</label>
        <label class="check"><input id="quiet" type="checkbox" ${settings.quietWhileWorking ? "checked" : ""} /> ${c.quiet}</label>
        <label class="check"><input id="speak" type="checkbox" ${settings.speakAnswers ? "checked" : ""} /> ${c.speakAnswers}</label>
        ${settings.speakAnswers ? `<button id="speak-on" type="button">${c.speakOn}</button> <span class="hint">${esc((c as Record<string, string>)[`speech_${state().speech.replace("-", "_")}`] ?? state().speech)}</span>` : ""}
        <p class="hint">${c.agents}</p>
      </section>
      <section class="card">
        <h2>${c.controls}</h2>
        <table class="keys"><tr><td>${c.swipe}</td><td>${c.select}</td></tr><tr><td>${c.tap}</td><td>${c.open}</td></tr><tr><td>${c.double}</td><td>${c.back}</td></tr><tr><td>${c.hold}</td><td>${c.speak}</td></tr><tr><td>${c.menuKey}</td><td>${c.menu}</td></tr><tr><td>${c.ring}</td><td>${c.ringDo}</td></tr></table>
      </section>
      <footer class="hint">Quiet Hub ${esc(model.screen)} · ${c.private}</footer>
    `;

    root.querySelector("#language")?.addEventListener("change", (event) => handlers.onLocale((event.target as HTMLSelectElement).value as Locale));
    root.querySelector("#auto-open")?.addEventListener("change", () => { void handlers.onSettings(readForm()); });
    root.querySelector("#invert-scroll")?.addEventListener("change", () => { void handlers.onSettings(readForm()); });
    root.querySelector("#quiet")?.addEventListener("change", () => { void handlers.onSettings(readForm()); });
    root.querySelector("#voice-auto")?.addEventListener("change", () => { void handlers.onSettings(readForm()); });
    root.querySelector("#speak")?.addEventListener("change", () => { void handlers.onSettings(readForm()).then(() => render()); });
    root.querySelector("#speak-on")?.addEventListener("click", () => { handlers.onSpeechActivate(); render(); });
    root.querySelector("#save")?.addEventListener("click", async () => {
      const next = readForm();
      busy = true; notice = c.checking; render();
      const result = await handlers.onSettings(next).catch((): SettingsResult => ({ ok: false, persisted: false, problem: "error" }));
      busy = false; notice = describe(result.ok, result.problem, c.saved, c.failed) + (result.persisted ? "" : ` ${c.notSaved}`); render();
    });
    root.querySelector("#test")?.addEventListener("click", async () => {
      busy = true; notice = c.testing; render();
      const result = await handlers.onTest(readForm()).catch((): TestResult => ({ ok: false, problem: "error", ms: 0 }));
      busy = false; notice = result.ok ? `${c.testOk} (${result.ms} ms)` : describe(false, result.problem, "", c.failed); render();
    });
    root.querySelector("#scan")?.addEventListener("click", async () => {
      busy = true; notice = c.camera; render();
      try {
        const scanned = await handlers.onScanQr();
        const result = await handlers.onSettings(scanned);
        notice = (result.ok ? c.scanned : `${c.unreachable}: ${describe(false, result.problem, "", "")}`) + (result.persisted ? "" : ` ${c.notSaved}`);
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
