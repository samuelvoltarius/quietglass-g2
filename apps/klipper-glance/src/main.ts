import { waitForEvenAppBridge, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { createClient, createDemoPrinter, toApiError, type PrinterApi } from "./printer/client";
import type { Command, PrinterStatus } from "./printer/status";
import { getLocale, type Locale } from "./i18n";
import { gestureFromEvent, type Gesture } from "./input/gestures";
import { t } from "./messages";
import { sameView } from "./glasses/diff";
import { createPage, updatePage } from "./glasses/render";
import type { ScreenView } from "./glasses/screen";
import { buildView, controlRows, errorReason, type Connection, type ViewState } from "./glasses/views";
import { loadSettings, saveSettings, type Settings } from "./storage/persist";
import { mountPhoneUi, type PhoneConnection } from "./ui/phone";

const DEMO = new URLSearchParams(globalThis.location?.search ?? "").get("demo") === "1";

/** How often the bridge is asked. */
const POLL_MS = 5_000;
/** A pending confirmation lapses after this; a forgotten armed cancel must not wait for a stray tap. */
const ARM_MS = 6_000;
/** A feedback line stays this long. */
const MESSAGE_MS = 5_000;

async function boot(): Promise<void> {
  const bridge: EvenAppBridge = await waitForEvenAppBridge();
  let settings: Settings = await loadSettings(bridge);
  let locale: Locale = getLocale();

  const makeApi = (): PrinterApi | null => {
    if (DEMO) return createDemoPrinter();
    if (!settings.bridgeUrl) return null;
    return createClient({ baseUrl: settings.bridgeUrl, ...(settings.token ? { token: settings.token } : {}) });
  };
  let api = makeApi();

  let closed = false;
  let connection: Connection = api ? { kind: "loading" } : { kind: "setup" };
  let status: PrinterStatus | null = null;
  let receivedAt = 0;
  let screen: "hud" | "control" = "hud";
  let cursor = 0;
  let armed: Command | null = null;
  let armTimer: ReturnType<typeof setTimeout> | undefined;
  let sending = false;
  let message = "";
  let messageTimer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let polling = false;
  /** Bumped when the bridge changes: replies for the old one are dropped. */
  let generation = 0;

  const say = (text: string): void => {
    message = text;
    clearTimeout(messageTimer);
    if (text) messageTimer = setTimeout(() => { message = ""; void draw(); }, MESSAGE_MS);
  };

  const disarm = (): void => {
    armed = null;
    clearTimeout(armTimer);
  };

  const viewState = (): ViewState => ({
    locale,
    demo: DEMO,
    connection,
    status,
    ageSeconds: receivedAt ? (Date.now() - receivedAt) / 1000 : 0,
    screen,
    cursor,
    armed,
    sending,
    message,
  });

  let lastView: ScreenView | null = null;
  let pageReady = false;
  let drawing: Promise<void> | null = null;
  let redrawQueued = false;

  const drawOnce = async (): Promise<void> => {
    const view = buildView(viewState());
    if (sameView(lastView, view)) return;
    const result = pageReady ? await updatePage(bridge, view) : await createPage(bridge, view);
    if (result.ok) { pageReady = true; lastView = view; return; }
    pageReady = false;
    lastView = null;
    console.warn("[klipperglance] draw failed:", result.reason);
  };

  /** One draw at a time; requests made meanwhile collapse into one redraw. */
  const draw = (): Promise<void> => {
    if (closed) return Promise.resolve();
    if (drawing) { redrawQueued = true; return drawing; }
    drawing = (async () => {
      try {
        do {
          redrawQueued = false;
          await drawOnce();
        } while (redrawQueued && !closed);
      } catch (error) {
        console.warn("[klipperglance] draw failed:", error);
      } finally {
        drawing = null;
      }
    })();
    return drawing;
  };

  let refreshPhone: () => void = () => undefined;
  let phoneSignature = "";
  /** The phone page is rebuilt only when what it shows changed, and never while someone types. */
  const updatePhone = (): void => {
    const signature = JSON.stringify([phoneConnection(), status, locale]);
    if (signature === phoneSignature) return;
    const active = (globalThis.document as Document | undefined)?.activeElement as HTMLElement | null | undefined;
    if (active?.matches?.("#app input, #app select")) return;
    phoneSignature = signature;
    refreshPhone();
  };

  const phoneConnection = (): PhoneConnection => {
    if (DEMO) return { kind: "demo" };
    switch (connection.kind) {
      case "setup": return { kind: "none" };
      case "loading": return { kind: "loading" };
      case "ok": return { kind: "ok" };
      case "error": return { kind: "error", reason: errorReason(locale, connection.code, connection.status) };
    }
  };

  /** Keeps the control screen consistent with what the printer can do now. */
  const reconcile = (): void => {
    const rows = controlRows(status);
    if (armed && !rows.includes(armed)) disarm();
    cursor = Math.min(cursor, rows.length - 1);
  };

  /** One poll at a time; a reply for a bridge that was replaced meanwhile is dropped. */
  const poll = async (): Promise<void> => {
    const client = api;
    if (polling || closed || !client) return;
    polling = true;
    const startedIn = generation;
    try {
      const next = await client.status();
      if (closed || generation !== startedIn) return;
      status = next;
      receivedAt = Date.now();
      connection = { kind: "ok" };
    } catch (error) {
      if (closed || generation !== startedIn) return;
      const problem = toApiError(error);
      connection = { kind: "error", code: problem.code, ...(problem.status ? { status: problem.status } : {}) };
    } finally {
      polling = false;
    }
    reconcile();
    updatePhone();
    await draw();
  };

  const send = async (command: Command): Promise<void> => {
    const client = api;
    if (!client || sending) return;
    disarm();
    sending = true;
    await draw();
    try {
      await client.command(command);
      if (closed) return;
      say(t(locale, "g.sent." + command));
    } catch (error) {
      if (closed) return;
      const problem = toApiError(error);
      say(t(locale, "g.notSent", { reason: errorReason(locale, problem.code, problem.status) }));
    } finally {
      sending = false;
    }
    screen = "hud";
    await draw();
    await poll();
  };

  const startPolling = (): void => {
    clearInterval(pollTimer);
    if (!api) return;
    void poll();
    pollTimer = setInterval(() => { void poll(); }, POLL_MS);
  };

  /** Leaving asks the system first (exit mode 1); until it confirms, the app keeps running. */
  const requestExit = (): void => {
    bridge.shutDownPageContainer(1).then(
      (left) => { if (left === true) shutDown(); },
      (error: unknown) => { console.warn("[klipperglance] exit failed:", error); },
    );
  };

  const shutDown = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(pollTimer);
    clearTimeout(armTimer);
    clearTimeout(messageTimer);
  };

  const onHud = (gesture: Gesture): void => {
    switch (gesture) {
      case "click":
        if (controlRows(status).length > 1 && connection.kind === "ok") {
          screen = "control";
          cursor = 0;
          disarm();
          break;
        }
        void poll();
        return;
      case "doubleClick":
        requestExit();
        return;
      default:
        return;
    }
    void draw();
  };

  const onControl = (gesture: Gesture): void => {
    const rows = controlRows(status);
    switch (gesture) {
      case "scrollUp":
      case "scrollDown":
        // Moving cancels a pending confirmation, so the next tap can never run what was highlighted before.
        disarm();
        cursor = Math.max(0, Math.min(rows.length - 1, cursor + (gesture === "scrollDown" ? 1 : -1)));
        break;
      case "click": {
        if (sending) return;
        const row = rows[cursor];
        if (!row) return;
        if (row === "back") { disarm(); screen = "hud"; break; }
        if (armed === row) { void send(row); return; }
        armed = row;
        clearTimeout(armTimer);
        armTimer = setTimeout(() => { armed = null; void draw(); }, ARM_MS);
        break;
      }
      case "doubleClick":
        disarm();
        screen = "hud";
        break;
      default:
        return;
    }
    void draw();
  };

  await draw();
  startPolling();

  bridge.onEvenHubEvent((event) => {
    if (closed) return;
    const parsed = gestureFromEvent(event, { invertScroll: settings.invertScroll });
    if (!parsed) return;
    if (screen === "control") onControl(parsed.gesture);
    else onHud(parsed.gesture);
  });

  bridge.onDeviceStatusChanged((device) => {
    if (device?.connectType === "connected" && !closed) {
      pageReady = false;
      lastView = null;
      void draw();
    }
  });

  const phone = mountPhoneUi({
    getSettings: () => settings,
    saveSettings: async (next) => {
      await saveSettings(bridge, next);
      const changed = next.bridgeUrl !== settings.bridgeUrl || next.token !== settings.token;
      settings = next;
      if (changed) {
        generation++;
        api = makeApi();
        status = null;
        receivedAt = 0;
        screen = "hud";
        disarm();
        connection = api ? { kind: "loading" } : { kind: "setup" };
        startPolling();
      }
      await draw();
    },
    connection: phoneConnection,
    status: () => status,
    locale: () => locale,
    onLocaleChange: (next) => {
      locale = next;
      void draw();
    },
  });
  refreshPhone = phone.refresh;
}

void boot().catch((error: unknown) => {
  console.error("[klipperglance] failed to start:", error);
});
