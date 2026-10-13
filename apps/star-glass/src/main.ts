import { waitForEvenAppBridge, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { createClient, toApiError, type StarApi } from "./nina/client";
import { createDemoNina, type DemoScene } from "./nina/demo";
import type { Command, StarStatus } from "./nina/status";
import { rememberLocale, resolveLocale, getLocale, type Locale } from "./i18n";
import { gestureFromEvent, type Gesture } from "./input/gestures";
import { t } from "./messages";
import { installPage, updatePage, type Preview } from "./glasses/render";
import { bitmapKey } from "./glasses/gfx";
import { ICON_STEP_MS } from "./glasses/charts";
import {
  PAGES, buildFrames, buildView, controlRows, errorReason, type Connection, type Frames, type Layout, type Page, type PageView, type ViewState,
} from "./glasses/views";
import { EMPTY_SETTINGS, effectiveUrl, loadSettings, saveSettings, type Settings } from "./storage/persist";
import { mountPhoneUi, type PhoneConnection } from "./ui/phone";

/** Shown in the phone page footer and logs; keep in step with app.json. */
export const BUILD = "0.1.0";

const params = new URLSearchParams(globalThis.location?.search ?? "");
const DEMO = params.get("demo") === "1";
const SCENES: readonly DemoScene[] = ["run", "flip", "lost", "warm", "done"];
const SCENE: DemoScene = SCENES.includes(params.get("scene") as DemoScene) ? (params.get("scene") as DemoScene) : "run";
/** `?page=3` opens on that page (simulator screenshots). */
const START_PAGE = Math.max(0, Math.min(PAGES.length - 1, Number(params.get("page") ?? 1) - 1)) || 0;

/** How often the bridge is asked; the exposure is counted down locally in between. */
const POLL_MS = 4_000;
const ARM_MS = 6_000;
const MESSAGE_MS = 5_000;

async function boot(): Promise<void> {
  const bridge: EvenAppBridge = await waitForEvenAppBridge();

  // State first, with safe defaults: the gesture handler is registered before any
  // other native call is awaited, so the glasses can always be left (double tap).
  let settings: Settings = EMPTY_SETTINGS;
  let locale: Locale = getLocale();
  let api: StarApi | null = null;
  let closed = false;
  let connection: Connection = { kind: "loading" };
  let status: StarStatus | null = null;
  let receivedAt = 0;
  let page: Page = PAGES[START_PAGE] ?? "overview";
  let screen: "pages" | "control" = "pages";
  let cursor = 0;
  let armed: Command | null = null;
  let armTimer: ReturnType<typeof setTimeout> | undefined;
  let sending = false;
  let message = "";
  let messageTimer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let tickTimer: ReturnType<typeof setInterval> | undefined;
  let polling = false;
  let generation = 0;
  let preview: Preview | null = null;
  let fetchingPreview = "";
  let ready = false;

  const say = (text: string): void => {
    message = text;
    clearTimeout(messageTimer);
    if (text) messageTimer = setTimeout(() => { message = ""; void draw(); }, MESSAGE_MS);
  };
  const disarm = (): void => { armed = null; clearTimeout(armTimer); };

  const viewState = (): ViewState => ({
    locale, demo: DEMO, connection, status,
    ageSeconds: receivedAt ? (Date.now() - receivedAt) / 1000 : 0,
    page, screen, cursor, armed, sending, message,
    hasPreview: preview !== null,
    now: Date.now(),
  });

  let lastView: PageView | null = null;
  let lastLayout: Layout | null = null;
  let lastKey = "";
  let pageReady = false;
  let drawing: Promise<void> | null = null;
  let redrawQueued = false;

  const frameKey = (f: Frames): string =>
    [f.icon, f.ring, f.panelA, f.panelB].map((b) => (b ? bitmapKey(b) : "-")).join("|") + "|" + (preview?.key ?? "");

  const drawOnce = async (): Promise<void> => {
    const state = viewState();
    const view = buildView(state);
    const frames = buildFrames(state, view.layout);
    const key = frameKey(frames);
    const same = lastView && view.layout === lastView.layout && view.header === lastView.header && view.footer === lastView.footer
      && view.body.join("\n") === lastView.body.join("\n");
    if (pageReady && same && key === lastKey) return;
    const shownPreview = view.layout === "image" ? preview : null;
    const result = !pageReady || view.layout !== lastLayout
      ? await installPage(bridge, view, frames, shownPreview)
      : await updatePage(bridge, view, frames, shownPreview, lastView);
    if (result.ok) { pageReady = true; lastView = view; lastLayout = view.layout; lastKey = key; return; }
    pageReady = false;
    lastView = null;
    console.warn("[starglass] draw failed:", result.reason);
  };

  /** One draw at a time; requests meanwhile collapse into one redraw. */
  const draw = (): Promise<void> => {
    if (closed || !ready) return Promise.resolve();
    if (drawing) { redrawQueued = true; return drawing; }
    drawing = (async () => {
      try {
        do { redrawQueued = false; await drawOnce(); } while (redrawQueued && !closed);
      } catch (error) {
        console.warn("[starglass] draw failed:", error);
      } finally {
        drawing = null;
      }
    })();
    return drawing;
  };

  let refreshPhone: () => void = () => undefined;
  let phoneSignature = "";
  const updatePhone = (): void => {
    const signature = JSON.stringify([phoneConnection(), status?.online ? [status.sequence, status.controllable] : status, locale]);
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

  const reconcile = (): void => {
    const rows = controlRows(status);
    if (armed && !rows.includes(armed)) disarm();
    cursor = Math.min(cursor, rows.length - 1);
  };

  /** The newest frame is fetched only for the image page, and only when its key changed. */
  const loadPreview = async (): Promise<void> => {
    const client = api;
    const key = status?.online ? status.preview : null;
    if (!client || !key || page !== "image" || screen !== "pages" || preview?.key === key || fetchingPreview === key) return;
    fetchingPreview = key;
    const startedIn = generation;
    try {
      const bytes = await client.preview(key);
      if (closed || generation !== startedIn) return;
      preview = { key, bytes };
    } catch (error) {
      console.warn("[starglass] preview failed:", toApiError(error).code);
    } finally {
      fetchingPreview = "";
    }
    await draw();
  };

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
    void loadPreview();
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
    screen = "pages";
    await draw();
    await poll();
  };

  const makeApi = (): StarApi | null => {
    if (DEMO) return createDemoNina(Date.now, SCENE);
    const url = effectiveUrl(settings);
    if (!url) return null;
    return createClient({ baseUrl: url, ...(settings.token ? { token: settings.token } : {}) });
  };

  const startPolling = (): void => {
    clearInterval(pollTimer);
    if (!api) return;
    void poll();
    pollTimer = setInterval(() => { void poll(); }, POLL_MS);
  };

  const requestExit = (): void => {
    bridge.shutDownPageContainer(1).then(
      (left) => { if (left === true) shutDown(); },
      (error: unknown) => { console.warn("[starglass] exit failed:", error); },
    );
  };
  const shutDown = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(pollTimer);
    clearInterval(tickTimer);
    clearTimeout(armTimer);
    clearTimeout(messageTimer);
  };

  const turn = (delta: number): void => {
    const index = (PAGES.indexOf(page) + delta + PAGES.length) % PAGES.length;
    page = PAGES[index] ?? "overview";
    void loadPreview();
  };

  const onPages = (gesture: Gesture): void => {
    switch (gesture) {
      case "scrollDown": turn(1); break;
      case "scrollUp": turn(-1); break;
      case "click":
        if (controlRows(status).length > 1 && connection.kind === "ok") { screen = "control"; cursor = 0; disarm(); break; }
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
        disarm();
        cursor = Math.max(0, Math.min(rows.length - 1, cursor + (gesture === "scrollDown" ? 1 : -1)));
        break;
      case "click": {
        if (sending) return;
        const row = rows[cursor];
        if (!row) return;
        if (row === "back") { disarm(); screen = "pages"; break; }
        if (armed === row) { void send(row); return; }
        armed = row;
        clearTimeout(armTimer);
        armTimer = setTimeout(() => { armed = null; void draw(); }, ARM_MS);
        break;
      }
      case "doubleClick":
        disarm();
        screen = "pages";
        break;
      default:
        return;
    }
    void draw();
  };

  bridge.onEvenHubEvent((event) => {
    if (closed) return;
    const parsed = gestureFromEvent(event, { invertScroll: settings.invertScroll });
    if (!parsed) return;
    // Before the first page exists only "leave" means anything.
    if (!ready) { if (parsed.gesture === "doubleClick") requestExit(); return; }
    if (screen === "control") onControl(parsed.gesture);
    else onPages(parsed.gesture);
  });

  bridge.onDeviceStatusChanged((device) => {
    if (device?.connectType === "connected" && !closed) {
      pageReady = false;
      lastView = null;
      void draw();
    }
  });

  settings = await loadSettings(bridge);
  locale = await resolveLocale(bridge);
  api = makeApi();
  connection = api ? { kind: "loading" } : { kind: "setup" };
  ready = true;

  await draw();
  startPolling();
  // The sign animates and the exposure counts down; drawOnce writes only what changed.
  tickTimer = setInterval(() => { void draw(); }, ICON_STEP_MS);

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
        preview = null;
        screen = "pages";
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
      rememberLocale(bridge, next);
      void draw();
    },
  });
  refreshPhone = phone.refresh;
  console.info("[starglass] " + BUILD + (DEMO ? " demo " + SCENE : ""));
}

void boot().catch((error: unknown) => {
  console.error("[starglass] failed to start:", error);
});
