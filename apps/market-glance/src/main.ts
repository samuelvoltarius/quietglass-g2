import { waitForEvenAppBridge, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { appStore } from "./storage/kv";
import { createExitRequest, isBackSignal, isSystemExitEvent } from "./exit";
import { COCKPIT_TILES, createCockpitPage, createTextPage, forgetPage, guardedTileSend, updateTextPage, type TextView } from "./glasses/page";
import { listView, startRows, startView } from "./glasses/view";
import { rememberLocale, resolveLocale, setLocale, type Locale } from "./i18n";
import { gestureFromEvent, menuItemIdFromEvent } from "./input/gestures";
import { fetchPositions } from "./markets/fetch";
import { demoPositions, type Position } from "./markets/model";
import { cockpitModel, cockpitPages, demoHistory, type CockpitPage, type FeedStatus, type HistoryPoint } from "./cockpit/model";
import { composeCockpit, type CockpitModel } from "./cockpit/compose";
import { createTileSender } from "./screen/sender";
import { autoBackend, type TextBackend } from "./screen/text";
import { mountPhoneUi, type PhoneUi } from "./ui/phone";

const DEFAULT_ENDPOINT = "http://127.0.0.1:8793/positions";
const INVERT_KEY = "markets.invert";
const ENDPOINT_KEY = "markets.endpoint";
/** The poll of the bridge. */
const POLL_MS = 15_000;
/** The cockpit is redrawn this often: the clock stays current; an unchanged frame sends nothing. */
const TICK_MS = 15_000;
/** The portfolio curve keeps this many points. */
const HISTORY_MAX = 60;

type Screen = "start" | "list" | "cockpit";
type Scene = { readonly kind: "text"; readonly view: TextView } | { readonly kind: "cockpit"; readonly model: CockpitModel };

async function boot(): Promise<void> {
  const bridge: EvenAppBridge = await waitForEvenAppBridge();
  await appStore.init(bridge, ["quietglass.locale", ENDPOINT_KEY, INVERT_KEY]);
  let locale: Locale = await resolveLocale(bridge); setLocale(locale);
  let positions: Position[] = demoPositions();
  let status: FeedStatus = { source: "demo", updatedAt: Date.now(), failed: false, errors: [] };
  let history: HistoryPoint[] = demoHistory(Date.now());
  let lastError = "";
  let screen: Screen = "start";
  let startCursor = 0; let listCursor = 0; let pageIndex = 0;
  let loading = false; let again = false; let closed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let tick: ReturnType<typeof setInterval> | undefined;
  let phone: PhoneUi | null = null;
  const invert = (): boolean => appStore.get(INVERT_KEY) === "1";
  const endpoint = (): string => appStore.get(ENDPOINT_KEY) || DEFAULT_ENDPOINT;

  const pages = (): CockpitPage[] => cockpitPages(positions);

  const currentScene = (now: number): Scene => {
    if (screen === "cockpit") {
      const all = pages();
      pageIndex = Math.min(pageIndex, all.length - 1);
      return { kind: "cockpit", model: cockpitModel({ positions, status, history, page: all[pageIndex]!, now, locale }) };
    }
    if (screen === "list") {
      listCursor = Math.min(listCursor, Math.max(0, positions.length - 1));
      return { kind: "text", view: listView(positions, listCursor, status, now, locale) };
    }
    startCursor = Math.min(startCursor, startRows(positions).length - 1);
    return { kind: "text", view: startView(positions, startCursor, status, now, locale) };
  };

  // ---- drawing ----------------------------------------------------------------------------------

  let pageReady = false;
  /** Which kind of page the glasses carry: a change means one rebuild. */
  let installed: "text" | "cockpit" | null = null;
  let lastView: TextView | null = null;
  let textBackend: TextBackend | null = null;

  // While the exit dialog may be on screen (asked, no input since) no timer, poll or stream may draw: a page call
  // could cover it. Data keeps being collected; the back signal restores the page the way of the first one.
  let exitAsked = (): boolean => false;

  /** The cockpit is one 576 x 288 frame; only the tiles whose pixels changed cross Bluetooth. Never while the dialog may be up. */
  const tiles = createTileSender(COCKPIT_TILES, guardedTileSend(bridge, () => !exitAsked() && !closed && installed === "cockpit"));

  const sameView = (a: TextView | null, b: TextView): boolean => a !== null && a.header === b.header && a.footer === b.footer && a.body.join("\n") === b.body.join("\n");

  const drawOnce = async (): Promise<void> => {
    if (exitAsked() || closed) return;
    const scene = currentScene(Date.now());
    if (scene.kind === "cockpit") {
      if (installed !== "cockpit") pageReady = false;
      if (!pageReady) {
        const result = await createCockpitPage(bridge);
        if (closed) return;
        if (!result.ok) { pageReady = false; console.warn("[market-glance] draw failed:", result.reason); return; }
        pageReady = true; installed = "cockpit"; lastView = null;
        // A new page starts with blank images.
        tiles.reset();
      }
      textBackend ??= autoBackend();
      // Never awaited: a slow transfer must not hold up the next gesture.
      void tiles.push(composeCockpit(scene.model, textBackend));
      return;
    }
    // Leaving the cockpit: its containers are about to go, no tile may be written any more.
    if (installed === "cockpit") { installed = null; pageReady = false; }
    if (pageReady && sameView(lastView, scene.view)) return;
    const result = pageReady ? await updateTextPage(bridge, scene.view, lastView) : await createTextPage(bridge, scene.view);
    if (closed) return;
    if (result.ok) { pageReady = true; installed = "text"; lastView = scene.view; return; }
    pageReady = false;
    console.warn("[market-glance] draw failed:", result.reason);
  };

  /** One page write at a time; requests made during a write collapse into one more pass with the newest state. */
  let drawing: Promise<void> | null = null;
  let drawAgain = false;
  const draw = (): Promise<void> => {
    if (exitAsked()) return Promise.resolve();
    if (drawing) { drawAgain = true; return drawing; }
    drawing = (async () => {
      try { do { drawAgain = false; await drawOnce(); } while (drawAgain && !closed); } finally { drawing = null; }
    })();
    return drawing;
  };

  // ---- data -------------------------------------------------------------------------------------

  const remember = (at: number): void => {
    const value = positions.reduce((sum, p) => sum + p.currentValue, 0);
    history = [...history, { at, value }].slice(-HISTORY_MAX);
  };

  // A call while one is in flight (e.g. Save with a new endpoint) is not dropped: exactly one follow-up runs as soon as the current one ends.
  const refresh = async (): Promise<void> => {
    if (closed) return;
    if (loading) { again = true; return; }
    loading = true; again = false;
    try {
      const result = await fetchPositions(endpoint());
      const wasDemo = status.source === "demo";
      positions = result.positions;
      status = { source: result.source, updatedAt: result.updatedAt ?? Date.now(), failed: false, errors: result.errors };
      lastError = result.errors.map((error) => `${error.provider || "?"}: ${error.message}`).join("; ");
      // The sample curve gives way to the first real reading.
      if (result.source === "live" && wasDemo) history = [];
      if (result.source === "live") remember(Date.now()); else history = demoHistory(Date.now());
    } catch (error) {
      console.warn("[market-glance] bridge unavailable", error);
      status = { ...status, failed: true };
      lastError = error instanceof Error ? error.message : String(error);
    } finally { loading = false; }
    pageIndex = Math.min(pageIndex, pages().length - 1);
    listCursor = Math.min(listCursor, Math.max(0, positions.length - 1));
    await draw();
    phone?.refreshLive();
    if (again) await refresh();
  };

  // Double tap on the start page opens the system exit dialog. The call resolves when the dialog is SHOWN, not when the
  // user answered: its result never stops polling. A confirmed exit arrives as sysEvent 6/7 (see the handler below).
  const requestExit = createExitRequest(bridge, {
    // The dialog took the page away. On the next input the page goes up again the way of the first one
    // (rebuild + create), so the glasses deliver input (and the next 2x) to the app again (store review 16.10.2026).
    onBack: () => { if (closed) return; pageReady = false; lastView = null; installed = null; forgetPage(bridge); return draw(); },
  }, "market-glance");
  exitAsked = requestExit.asked;

  bridge.onEvenHubEvent((event) => {
    if (closed) return;
    // The 4/5 right after an exit call are the system dialog's own show/close, not the app entering/leaving.
    if (requestExit.onLifecycle(event) !== null) return;
    if (isSystemExitEvent(event)) { closed = true; clearInterval(timer); clearInterval(tick); tiles.close(); return; }
    if (isBackSignal(event)) requestExit.back();
    // The glasses' side menu is off (SIDE_MENU): a menu click never runs anything.
    if (menuItemIdFromEvent(event) !== null) return;
    const gesture = gestureFromEvent(event, { invertScroll: invert() });
    if (!gesture) return;
    // 2x only goes back (on the start page: the exit dialog). Swipes only move. Nothing here changes data.
    if (screen === "start") {
      const rows = startRows(positions);
      switch (gesture.gesture) {
        case "click": {
          const row = rows[startCursor];
          if (row?.kind === "overview") { screen = "cockpit"; pageIndex = 0; }
          else { screen = "list"; listCursor = 0; }
          break;
        }
        case "scrollUp": startCursor = Math.max(0, startCursor - 1); break;
        case "scrollDown": startCursor = Math.min(rows.length - 1, startCursor + 1); break;
        case "doubleClick": void requestExit(); return;
        default: return;
      }
    } else if (screen === "list") {
      switch (gesture.gesture) {
        case "click": if (positions.length === 0) return; screen = "cockpit"; pageIndex = listCursor + 1; break;
        case "scrollUp": listCursor = Math.max(0, listCursor - 1); break;
        case "scrollDown": listCursor = Math.min(Math.max(0, positions.length - 1), listCursor + 1); break;
        case "doubleClick": screen = "start"; break;
        default: return;
      }
    } else {
      switch (gesture.gesture) {
        case "click": void refresh(); return;
        case "scrollUp": pageIndex = Math.max(0, pageIndex - 1); break;
        case "scrollDown": pageIndex = Math.min(pages().length - 1, pageIndex + 1); break;
        case "doubleClick": screen = "start"; break;
        default: return;
      }
    }
    void draw();
  });
  bridge.onDeviceStatusChanged((device) => { if (device?.connectType === "connected" && !closed) { pageReady = false; void draw(); } });

  phone = mountPhoneUi({
    getState: () => ({ positions, status, lastError, now: Date.now() }),
    getLocale: () => locale,
    setLocale: (next) => { locale = next; rememberLocale(bridge, next); void draw(); },
    getEndpoint: endpoint,
    isConfigured: () => (appStore.get(ENDPOINT_KEY) ?? "") !== "",
    saveEndpoint: (value) => { appStore.set(ENDPOINT_KEY, value); void refresh(); },
    getInvert: invert,
    setInvert: (value) => { appStore.set(INVERT_KEY, value ? "1" : "0"); },
    refresh: () => { void refresh(); },
  });

  await draw();
  void refresh();
  timer = setInterval(() => void refresh(), POLL_MS);
  // Keeps the clock and the age of the data current even when the bridge does not answer.
  tick = setInterval(() => { void draw(); phone?.refreshLive(); }, TICK_MS);
}

void boot().catch((error: unknown) => console.error("[market-glance]", error));
