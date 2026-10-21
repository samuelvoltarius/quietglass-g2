import { waitForEvenAppBridge, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { diag, startDiag } from "./diag/diag";
import { traceBridge } from "./diag/bridge";
import { VERSION } from "./version";
import { settleRestore } from "./exit";
import { createClient, createDemoPrinter, toApiError, type PrinterApi } from "./printer/client";
import { createMoonrakerClient, isMoonrakerUrl } from "./printer/moonraker";
import type { Command, PrinterStatus } from "./printer/status";
import { rememberLocale, resolveLocale, type Locale } from "./i18n";
import { gestureFromEvent, menuItemIdFromEvent, type Gesture } from "./input/gestures";
import { t } from "./messages";
import { sameView } from "./glasses/diff";
import { createPage, forgetPage, rebuildPage, updatePage, type MenuSpec } from "./glasses/render";
import type { ScreenView } from "./glasses/screen";
import {
  buildPrintView, buildView, controlRows, errorReason, layoutFor, type Connection, type Layout, type PrintView, type ViewState,
} from "./glasses/views";
import { curveFrame, ringFrame } from "./glasses/charts";
import { demoPreview, previewFrame, type GrayImage } from "./glasses/preview";
import { decodeThumbnail } from "./glasses/thumb-decode";
import {
  currentLayerIndex, demoLayerModel, layerFrame, messageFrame, parseLayerModel, tiles, type LayerModel,
} from "./glasses/layers";
import { bitmapKey } from "./glasses/gfx";
import { TempHistory, demoTempSamples } from "./printer/history";
import { effectiveUrl, loadSettings, saveSettings, type Settings } from "./storage/persist";
import { lifecycleFromEvent } from "./lifecycle";
import { mountPhoneUi, type PhoneConnection } from "./ui/phone";

const DEMO = new URLSearchParams(globalThis.location?.search ?? "").get("demo") === "1";
/** `?demo=1&pct=73` starts the demo print at 73 % (for the simulator). */
const DEMO_PERCENT = Number(new URLSearchParams(globalThis.location?.search ?? "").get("pct"));

/**
 * The glasses' side menu (QIS v1.2). Off: its clicks never reach the app on the real glasses, and while a page
 * carries a menu the hold opens it instead of reaching the app (step log of 15.10.2026). A hold reaches the app
 * only from the optional R1 ring (eventSource 2; on the temple it opens the system menu, 21.10.2026): there it
 * opens the help as an extra. Nothing depends on it: the help repeats the phone's gesture table.
 */
export const SIDE_MENU = false;
/** Side menu id (QIS v1.2): Hilfe. The app has no settings of its own on the glasses. */
export const MENU_HELP = 1;
export function sideMenu(locale: Locale): MenuSpec {
  return { items: SIDE_MENU ? [{ id: MENU_HELP, label: t(locale, "g.menu.help") }] : [] };
}

/** How often the bridge is asked. */
const POLL_MS = 5_000;
/** A pending confirmation lapses after this; a forgotten armed cancel must not wait for a stray tap (QIS v1: 4 s). */
const ARM_MS = 4_000;
/** A tap this soon after the help opened is the end of the menu click itself and does not close it. */
const HELP_GUARD_MS = 400;
/** A feedback line stays this long. */
const MESSAGE_MS = 5_000;

async function boot(): Promise<void> {
  // Private step log (VITE_TRAFFIC_URL, tailnet only): calls, results and events, never printer data.
  startDiag((import.meta as { env?: Record<string, string | undefined> }).env?.["VITE_TRAFFIC_URL"] ?? "", VERSION);
  const bridge: EvenAppBridge = traceBridge(await waitForEvenAppBridge());
  let settings: Settings = await loadSettings(bridge);
  let locale: Locale = await resolveLocale(bridge);

  /** QIS v1.2 #7: without a bridge address the app shows the demo printer; `?demo=1` forces it. */
  const makeApi = (): PrinterApi => {
    const url = effectiveUrl(settings);
    if (DEMO || !url) return createDemoPrinter(Date.now, Number.isFinite(DEMO_PERCENT) && DEMO_PERCENT > 0 ? DEMO_PERCENT : 42);
    // Direct mode (0.6.0): a Moonraker address (port 7125) is read without any bridge.
    if (isMoonrakerUrl(url)) {
      diag("direct", { origin: (globalThis as { location?: { origin?: string } }).location?.origin ?? "" });
      return createMoonrakerClient({ baseUrl: url, ...(settings.token ? { apiKey: settings.token } : {}), allowControl: settings.directControl === true });
    }
    return createClient({ baseUrl: url, ...(settings.token ? { token: settings.token } : {}) });
  };
  let api: PrinterApi = makeApi();
  const isDemo = (): boolean => api.demo;

  let closed = false;
  let connection: Connection = { kind: "loading" };
  let status: PrinterStatus | null = null;
  let receivedAt = 0;
  let screen: "hud" | "control" | "model" | "help" = "hud";
  let helpOpenedAt = 0;
  /** Layer view: the model of the file being printed, and the view angle. */
  let layerModel: LayerModel | null = null;
  let layerFile = "";
  let layerState: "none" | "preparing" | "ready" | "failed" = "none";
  let layerLoading = false;
  let viewAngle = 35;
  let cursor = 0;
  let armed: Command | null = null;
  let armTimer: ReturnType<typeof setTimeout> | undefined;
  let sending = false;
  let message = "";
  let messageTimer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let polling = false;
  /** Left through the system: no polling and no drawing until the app is back. */
  let backgrounded = false;
  /** Bumped when the bridge changes: replies for the old one are dropped. */
  let generation = 0;
  /** The slicer preview of the file being printed; null shows the ring instead. */
  let preview: GrayImage | null = null;
  let previewFile = "";

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
    demo: isDemo(),
    sideMenu: SIDE_MENU,
    connection,
    status,
    ageSeconds: receivedAt ? (Date.now() - receivedAt) / 1000 : 0,
    screen,
    cursor,
    armed,
    sending,
    message,
    now: Date.now(),
    model: layerState,
  });

  const temps = new TempHistory();
  if (isDemo()) for (const sample of demoTempSamples(Date.now())) temps.add(sample.t, { now: sample.now, target: sample.target });
  let lastView: ScreenView | PrintView | null = null;
  let lastLayout: Layout = "plain";
  let lastFrames = "";
  let pageReady = false;
  /** createStartUpPageContainer runs once; afterwards a page is only ever rebuilt. */
  let created = false;
  let drawing: Promise<void> | null = null;
  let redrawQueued = false;

  // While the exit dialog may be on screen (asked, no input since) no timer, poll or stream may draw: a page call
  // could cover it. Data keeps being collected; the back signal restores the page the way of the first one.
  let exitDialogAsked = false;
  /**
   * The system dialog's own lifecycle (step log, Klipper 0.5.11): right after shutDownPageContainer(1) the glasses
   * send FOREGROUND_ENTER (4) when the dialog comes up and FOREGROUND_EXIT (5) when it goes away after "No" - not
   * the app entering or leaving. Between the call and the 5 nothing is drawn; the 5 puts the page up again.
   */
  let dialogPending = false;
  let dialogShown = false;
  const drawOnce = async (): Promise<void> => {
    if (exitDialogAsked) return;
    const state = viewState();
    const layout = layoutFor(state);
    const view = layout === "print" ? buildPrintView(state) : buildView(state);
    const percent = state.status?.online ? state.status.progress : 0;
    const online = state.status?.online ? state.status : null;
    const heightShare = online?.layers && online.layer != null ? online.layer / online.layers : null;
    const frames = { ring: preview ? previewFrame(preview, percent, heightShare) : ringFrame(percent), curve: curveFrame(temps.samples()), tiles: modelTiles(layout) };
    const key = layout === "print"
      ? bitmapKey(frames.ring) + "|" + bitmapKey(frames.curve)
      : layout === "model" ? (frames.tiles ?? []).map(bitmapKey).join("|") : "";
    if (pageReady && layout === lastLayout && sameView(lastView, view) && key === lastFrames) return;
    let result;
    if (!pageReady) {
      // After the first creation a page is only rebuilt: a second create would be refused as invalid.
      result = created ? await rebuildPage(bridge, view, layout, frames, sideMenu(locale)) : await createPage(bridge, view, layout, frames, sideMenu(locale));
      if (result.ok) created = true;
    } else if (layout !== lastLayout) {
      result = await rebuildPage(bridge, view, layout, frames, sideMenu(locale));
    } else {
      result = await updatePage(bridge, view, layout, frames, lastView);
    }
    if (result.ok) { pageReady = true; lastView = view; lastLayout = layout; lastFrames = key; return; }
    pageReady = false;
    lastView = null;
    console.warn("[klipperglance] draw failed:", result.reason);
  };

  /** The four tiles of the layer view (model layout only). */
  function modelTiles(layout: Layout): ReturnType<typeof tiles> | undefined {
    if (layout !== "model") return undefined;
    const online = status?.online ? status : null;
    if (layerModel && online) {
      const index = currentLayerIndex(layerModel, { z: online.z, layer: online.layer, layers: online.layers, progress: online.progress });
      return tiles(layerFrame(layerModel, index, viewAngle));
    }
    return tiles(messageFrame(t(locale, layerState === "preparing" ? "g.model.wait" : "g.model.missing")));
  }

  /** Fetches the layer model once per file; while the bridge prepares it, the next poll asks again. */
  const loadLayers = async (client: PrinterApi, file: string): Promise<void> => {
    if (layerLoading || !file) return;
    if (file === layerFile && (layerState === "ready" || layerState === "failed" || layerState === "none")) return;
    if (file !== layerFile) { layerFile = file; layerModel = null; layerState = "none"; }
    if (client.demo) { layerModel = demoLayerModel(); layerState = "ready"; return; }
    if (!client.layers) return;
    layerLoading = true;
    const startedIn = generation;
    try {
      const reply = await client.layers(file);
      if (closed || generation !== startedIn || layerFile !== file) return;
      if (reply === "preparing") { layerState = "preparing"; return; }
      const parsed = reply === null ? null : parseLayerModel(reply);
      layerModel = parsed;
      layerState = parsed ? "ready" : reply === null ? "none" : "failed";
    } finally {
      layerLoading = false;
    }
    void draw();
  };

  /** One draw at a time; requests made meanwhile collapse into one redraw. */
  const draw = (): Promise<void> => {
    if (exitDialogAsked) return Promise.resolve();
    if (closed || backgrounded) return Promise.resolve();
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
    if (isDemo()) return { kind: "demo" };
    switch (connection.kind) {
      case "setup": return { kind: "none" };
      case "loading": return { kind: "loading" };
      case "ok": return { kind: "ok" };
      case "error": return { kind: "error", reason: errorReason(locale, connection.code, connection.status, true) };
    }
  };

  /** Keeps the control screen consistent with what the printer can do now. */
  const reconcile = (): void => {
    const rows = controlRows(status);
    if (armed && !rows.includes(armed)) disarm();
    cursor = Math.min(cursor, rows.length - 1);
  };

  /** Fetches the preview once per print file, in the background; failure just keeps the ring. */
  const loadPreview = (client: PrinterApi, file: string, startedIn: number): void => {
    if (file === previewFile) return;
    previewFile = file;
    preview = null;
    if (!file) return;
    if (client.demo) { preview = demoPreview(); return; }
    void (async () => {
      const bytes = await client.thumbnail?.(file);
      const image = bytes ? await decodeThumbnail(bytes) : null;
      if (closed || generation !== startedIn || previewFile !== file || !image) return;
      preview = image;
      await draw();
    })();
  };

  /** One poll at a time; a reply for a bridge that was replaced meanwhile is dropped. */
  const poll = async (): Promise<void> => {
    const client = api;
    if (polling || closed || backgrounded) return;
    polling = true;
    const startedIn = generation;
    try {
      const next = await client.status();
      if (closed || generation !== startedIn) return;
      status = next;
      receivedAt = Date.now();
      if (next.online) temps.add(receivedAt, next.nozzle);
      connection = { kind: "ok" };
      if (next.online) loadPreview(client, next.file, startedIn);
      if (next.online && screen === "model") void loadLayers(client, next.file);
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
    if (sending) return;
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
      // Without an answer the command may well have run: say so, and look at the printer at once.
      say(problem.code === "timeout"
        ? t(locale, "g.unknownResult")
        : t(locale, "g.notSent", { reason: errorReason(locale, problem.code, problem.status) }));
    } finally {
      sending = false;
    }
    screen = "hud";
    await draw();
    await poll();
  };

  const startPolling = (): void => {
    clearInterval(pollTimer);
    void poll();
    pollTimer = setInterval(() => { void poll(); }, POLL_MS);
  };

  /** Leaving asks the system first (exit mode 1); the app keeps running, only the system ends it (sysEvent 6/7). */
  // shutDownPageContainer(1) resolves when the dialog is SHOWN (hardware: ~58 ms after the double tap), not when
  // the user answered, so the result never tears the app down. If the user confirms, the system ends the app
  // (sysEvent 6/7 below). After "No" the app has to be alive: on the next signal that it is back (any input,
  // FOREGROUND_ENTER) the page is put up again the way of the first one, then the event is handled normally.
  /** The restore started by the last exitBack(), while it is still running. */
  let restoring: Promise<void> | null = null;
  const exitBack = (): void => {
    if (!exitDialogAsked) return;
    diag("exitBack", { bg: backgrounded });
    exitDialogAsked = false;
    if (closed) return;
    pageReady = false;
    lastView = null;
    forgetPage(bridge);
    const run = draw().catch(() => undefined);
    restoring = run;
    void run.then(() => { if (restoring === run) restoring = null; });
  };
  const requestExit = (): void => {
    // A second double tap before any restore: put the page back first, then ask again.
    exitBack();
    // The first double tap after "No" is the back signal itself: a dialog call issued while the page is still being
    // created is lost (hardware, Klipper 0.5.8). So it waits for the restore and a short settle delay.
    const restore = restoring;
    diag("exitAsk", { waits: restore !== null, bg: backgrounded });
    const ask = async (): Promise<void> => {
      dialogPending = true;
      try {
        await bridge.shutDownPageContainer(1);
      } catch (error: unknown) {
        console.warn("[klipperglance] exit failed:", error);
      }
      exitDialogAsked = true;
    };
    // Without a restore in flight the host is called at once, in this very event.
    if (restore) void settleRestore(restore).then(ask);
    else void ask();
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
      case "longPress":
        // R1-ring extra only (a temple hold never arrives): the help. Never named on the glasses.
        if (SIDE_MENU) return;
        screen = "help";
        helpOpenedAt = Date.now();
        break;
      case "scrollUp":
      case "scrollDown":
        // A swipe opens the layer view while a printer is online (a view only: nothing is sent or changed).
        if (!status?.online) return;
        screen = "model";
        if (status.file !== layerFile || layerState === "preparing" || layerState === "none") {
          if (status.file !== layerFile) { layerModel = null; layerState = "none"; }
          void loadLayers(api, status.file);
        }
        break;
      default:
        return;
    }
    void draw();
  };

  const onModel = (gesture: Gesture): void => {
    switch (gesture) {
      case "scrollUp":
      case "scrollDown":
        // Nothing to turn without a model: the swipe goes back to the overview, like 2×.
        if (layerState !== "ready") { screen = "hud"; break; }
        viewAngle = (viewAngle + (gesture === "scrollDown" ? 30 : -30) + 360) % 360;
        break;
      case "click":
        if (status?.online && layerState !== "ready") { layerState = "none"; layerFile = ""; void loadLayers(api, status.file); }
        void poll();
        return;
      case "doubleClick":
        screen = "hud";
        break;
      default:
        return;
    }
    void draw();
  };

  /** Help is a subpage: tap or 2× go back (so does a hold without a side menu); swipes change nothing. */
  const onHelp = (gesture: Gesture): void => {
    const justOpened = Date.now() - helpOpenedAt < HELP_GUARD_MS;
    if (gesture === "doubleClick" || (!SIDE_MENU && gesture === "longPress") || (gesture === "click" && !justOpened)) {
      screen = "hud";
      void draw();
    }
  };

  const onControl = (gesture: Gesture): void => {
    const rows = controlRows(status);
    // Armed: a swipe, 2× or hold only cancels the question (QIS v1) and stays on this screen, so the
    // next tap can never run what was highlighted before; only a single tap on the same row carries it out.
    if (armed !== null && (gesture === "scrollUp" || gesture === "scrollDown" || gesture === "doubleClick" || gesture === "longPress")) {
      disarm();
      void draw();
      return;
    }
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

  const goBackground = (): void => {
    diag("background", { asked: exitDialogAsked });
    backgrounded = true;
    clearInterval(pollTimer);
    pollTimer = undefined;
    disarm();
    screen = "hud";
  };
  const comeBack = (): void => {
    diag("back", { asked: exitDialogAsked });
    backgrounded = false;
    pageReady = false;
    lastView = null;
    // The exit dialog sends the app to the background; coming back from it the page goes up the way of the first one,
    // and a double tap arriving now waits for exactly this draw before it asks again (hardware, Klipper 0.5.10).
    const run = draw().catch(() => undefined);
    restoring = run;
    void run.then(() => { if (restoring === run) restoring = null; });
    startPolling();
  };

  // The glasses listen before the first page is built: a slow page must never make a tap or the exit go nowhere.
  bridge.onEvenHubEvent((event) => {
    if (closed) return;
    const lifecycle = lifecycleFromEvent(event);
    if (lifecycle === "foreground" && dialogPending) {
      // The exit dialog came up: stay still, it is on screen now.
      dialogPending = false;
      dialogShown = true;
      exitDialogAsked = true;
      diag("dialogShown");
      return;
    }
    if (lifecycle === "background" && dialogShown) {
      // "No": the dialog went away. The app never left - page up again the way of the first one, polling goes on.
      dialogShown = false;
      exitDialogAsked = true;
      diag("dialogClosed");
      exitBack();
      return;
    }
    dialogPending = false;
    dialogShown = false;
    if (lifecycle !== "background" && lifecycle !== "exit") exitBack();
    if (lifecycle === "foreground") { comeBack(); return; }
    if (lifecycle === "background") { goBackground(); return; }
    if (lifecycle === "exit") { goBackground(); shutDown(); return; }
    const menuId = menuItemIdFromEvent(event);
    if (menuId !== null) {
      if (menuId === MENU_HELP && !backgrounded) {
        // Help covers anything armed: the confirmation lapses, nothing is sent.
        disarm();
        screen = "help";
        helpOpenedAt = Date.now();
        void draw();
      }
      return;
    }
    const parsed = gestureFromEvent(event, { invertScroll: settings.invertScroll });
    if (!parsed) return;
    diag("gesture", { g: parsed.gesture, screen, bg: backgrounded, asked: exitDialogAsked });
    // A gesture means the app is on the glasses again, even if no "foreground" came first. Other gestures end there;
    // a double tap on the HUD still asks to leave (after "No" in the exit dialog the app sits in the background and
    // the first 2× was swallowed here - store review 17.10.2026).
    if (backgrounded) { comeBack(); if (!(parsed.gesture === "doubleClick" && screen === "hud")) return; }
    if (screen === "help") onHelp(parsed.gesture);
    else if (screen === "control") onControl(parsed.gesture);
    else if (screen === "model") onModel(parsed.gesture);
    else onHud(parsed.gesture);
  });

  await draw();
  startPolling();

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
        layerFile = "";
        layerModel = null;
        layerState = "none";
        if (screen === "model") screen = "hud";
        previewFile = "";
        preview = null;
        api = makeApi();
        status = null;
        receivedAt = 0;
        temps.clear();
        if (isDemo()) for (const sample of demoTempSamples(Date.now())) temps.add(sample.t, { now: sample.now, target: sample.target });
        screen = "hud";
        disarm();
        connection = { kind: "loading" };
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
      // The menu label follows the language: one rebuild.
      if (SIDE_MENU) { pageReady = false; lastView = null; }
      void draw();
    },
  });
  refreshPhone = phone.refresh;
}

void boot().catch((error: unknown) => {
  console.error("[klipperglance] failed to start:", error);
});
