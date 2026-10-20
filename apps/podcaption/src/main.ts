import { waitForEvenAppBridge, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { appStore } from "./storage/kv";
import { COCKPIT_TILES, createCockpitPage, createTextPage, forgetPage, guardedTileSend, updateTextPage, type TextView } from "./glasses/page";
import { captionsView, startRows, startView, type PodState, type Screen, type Source } from "./glasses/view";
import { cockpitModel } from "./cockpit/model";
import { composeCockpit, modelKey } from "./cockpit/compose";
import { createTileSender } from "./screen/sender";
import { autoBackend, type TextBackend } from "./screen/text";
import { rememberLocale, resolveLocale, setLocale, tr, type Locale } from "./i18n";
import { gestureFromEvent, menuItemIdFromEvent } from "./input/gestures";
import { createExitRequest, isBackSignal, isSystemExitEvent } from "./exit";
import { messages } from "./messages";
import { bridgeUrl, fetchText } from "./podcast/bridge";
import { failureFor, type Failure } from "./podcast/errors";
import { demoCaptions, parsePodcastFeed, readTranscript, type Caption } from "./podcast/parse";
import { captionDelay, createPlayer } from "./podcast/player";
import { mountPhoneUi, type PhoneUi } from "./ui/phone";

const DEFAULT_API = "http://127.0.0.1:8789";
const INVERT_KEY = "podcaption.invert";
/** The clock on the status cockpit: redrawn this often; an unchanged frame sends nothing. */
const TICK_MS = 15_000;

async function boot(): Promise<void> {
  const bridge: EvenAppBridge = await waitForEvenAppBridge();
  await appStore.init(bridge, ["quietglass.locale", "podcaption.bridge", INVERT_KEY]);
  let locale: Locale = await resolveLocale(bridge); setLocale(locale);
  const t = (key: string, vars: Record<string, string | number> = {}): string => tr(messages, locale, key, vars);
  /** The first-run captions are a how-to in the user's language, not sample podcast text. */
  const demo = (): Caption[] => demoCaptions([t("demo1"), t("demo2"), t("demo3"), t("demo4")]);
  let captions: Caption[] = demo(); let episode = t("demoTitle"); let cursor = 0; let source: Source = "DEMO";
  let failure: Failure | null = null; let closed = false;
  /** `?screen=captions|status` opens straight on a screen (simulator screenshots); without it the start page. */
  const startScreen = new URLSearchParams(globalThis.location?.search ?? "").get("screen");
  let screen: Screen = startScreen === "captions" || startScreen === "status" ? startScreen : "start";
  let startCursor = 0;
  let phone: PhoneUi | null = null;
  const errorText = (): string => failure ? t(failure.key, { status: failure.status ?? "" }) : "";
  /** QIS v1.2: the glasses never show a status code; the phone keeps the detail. */
  const glassesErrorText = (): string => failure ? t(failure.key === "errServer" ? "errServerGlasses" : failure.key) : "";
  const invert = (): boolean => appStore.get(INVERT_KEY) === "1";
  const endpoint = (): string => appStore.get("podcaption.bridge") || DEFAULT_API;

  // ---- drawing ----------------------------------------------------------------------------------
  let pageReady = false;
  /** Which kind of page the glasses carry: a change means one rebuild. */
  let installed: "text" | "cockpit" | null = null;
  let lastView: TextView | null = null;
  let lastKey = "";
  let textBackend: TextBackend | null = null;
  // While the exit dialog may be on screen (asked, no input since) no timer, poll or stream may draw: a page call
  // could cover it. Data keeps being collected; the back signal restores the page the way of the first one.
  let exitAsked = (): boolean => false;

  const podState = (): PodState => ({ locale, captions, episode, cursor, source, playing: player.playing, failure: glassesErrorText() });

  /** The cockpit is one 576 x 288 frame; only the tiles whose pixels changed cross Bluetooth. Never while the dialog may be up. */
  const tiles = createTileSender(COCKPIT_TILES, guardedTileSend(bridge, () => !exitAsked() && !closed && installed === "cockpit"));
  const sameView = (a: TextView | null, b: TextView): boolean => a !== null && a.header === b.header && a.footer === b.footer && a.body.join("\n") === b.body.join("\n");

  const drawOnce = async (): Promise<void> => {
    if (closed || exitAsked()) return;
    const state = podState();
    if (screen === "status") {
      const model = cockpitModel(state, Date.now());
      const key = modelKey(model);
      if (installed !== "cockpit") pageReady = false;
      if (pageReady && key === lastKey) return;
      if (!pageReady) {
        const created = await createCockpitPage(bridge);
        if (closed) return;
        if (!created.ok) { pageReady = false; lastKey = ""; console.warn("[podcaption] draw failed:", created.reason); return; }
        pageReady = true; installed = "cockpit"; lastView = null;
        // A new page starts with blank images.
        tiles.reset();
      }
      lastKey = key;
      textBackend ??= autoBackend();
      // Never awaited: a slow transfer must not hold up the next gesture.
      void tiles.push(composeCockpit(model, textBackend));
      return;
    }
    const view = screen === "captions" ? captionsView(state) : startView(state, startCursor);
    // Leaving the cockpit: its containers are about to go, no tile may be written any more.
    if (installed === "cockpit") { installed = null; pageReady = false; }
    if (pageReady && sameView(lastView, view)) return;
    const result = pageReady ? await updateTextPage(bridge, view, lastView) : await createTextPage(bridge, view);
    if (closed) return;
    if (result.ok) { pageReady = true; installed = "text"; lastView = view; lastKey = ""; return; }
    pageReady = false;
    lastView = null;
  };

  /** One page write at a time; requests made during a write collapse into one more pass with the newest state. */
  let drawing: Promise<void> | null = null;
  let drawAgain = false;
  const draw = (): Promise<void> => {
    if (closed || exitAsked()) return Promise.resolve();
    if (drawing) { drawAgain = true; return drawing; }
    drawing = (async () => {
      try { do { drawAgain = false; await drawOnce(); } while (drawAgain && !closed); } finally { drawing = null; phone?.refreshLive(); }
    })();
    return drawing;
  };

  // ---- the captions ------------------------------------------------------------------------------
  // Errors reach the phone in full and the glasses as one cut-down row; the raw cause stays in the console.
  const fail = (cause: unknown): void => { console.warn("[podcaption]", cause); failure = failureFor(cause); void draw(); phone?.render(); };
  const useCaptions = async (parsed: Caption[], title: string, nextSource: Source): Promise<void> => {
    player.stop(); captions = parsed; episode = title || t("transcript"); source = nextSource; cursor = 0; failure = null;
    await draw(); phone?.render();
  };
  /** Newest episode with a transcript; its files are tried best first (VTT, SRT, JSON, then HTML/text), so one broken link does not end the load. */
  const loadFeed = async (): Promise<void> => {
    const api = endpoint();
    try {
      const first = parsePodcastFeed(await fetchText(bridgeUrl(api, "/feed"), "feed"))[0];
      if (!first) throw new Error("feed has no podcast:transcript");
      let lastFailure: unknown = new Error("transcript unavailable");
      for (const transcript of first.transcripts) {
        try { await useCaptions(readTranscript(await fetchText(bridgeUrl(api, `/transcript?url=${encodeURIComponent(transcript.url)}`), "transcript"), transcript.type), first.title, "RSS"); return; }
        catch (cause) { lastFailure = cause; }
      }
      throw lastFailure;
    } catch (cause) { fail(cause); }
  };
  const player = createPlayer({ delayMs: (index) => captionDelay(captions, index), length: () => captions.length, cursor: () => cursor, setCursor: (next) => { cursor = next; }, onChange: () => { void draw(); } });
  const toggle = (): void => player.toggle();

  // Double tap on the start page opens the system exit dialog; playback continues while it is open. The call resolves when the
  // dialog is SHOWN, not when the user answered: its result never stops playback. A confirmed exit arrives as
  // sysEvent 6/7 (handler below).
  const requestExit = createExitRequest(bridge, {
    // The dialog took the page away: on the next input put it up again the way of the first one, so input (and the next 2x) reaches the app again.
    onBack: () => { if (closed) return; pageReady = false; lastView = null; lastKey = ""; installed = null; forgetPage(bridge); return draw(); },
  }, "podcaption");
  exitAsked = requestExit.asked;

  phone = mountPhoneUi({
    getView: () => ({ state: podState(), detail: errorText() }),
    toggle,
    openFile: (file, title) => {
      const mime = file.type || (file.name.endsWith(".json") ? "application/json" : "text/vtt");
      void file.text().then((text) => useCaptions(readTranscript(text, mime), title, "FILE")).catch(fail);
    },
    usePaste: (text, title) => {
      if (!text.trim()) { failure = { key: "errPasteEmpty" }; void draw(); phone?.render(); return; }
      void useCaptions(readTranscript(text, text.trimStart().startsWith("{") ? "application/json" : "text/vtt"), title || t("transcript"), "FILE").catch(fail);
    },
    connect: (value) => { appStore.set("podcaption.bridge", value); void loadFeed(); },
    setLocale: (next) => {
      locale = next; rememberLocale(bridge, locale);
      if (source === "DEMO") { captions = demo(); episode = t("demoTitle"); }
      void draw(); phone?.render();
    },
    getInvert: invert,
    setInvert: (value) => { appStore.set(INVERT_KEY, value ? "1" : "0"); },
    getEndpoint: endpoint,
  });

  await draw();
  // Keeps the clock on the status cockpit current.
  const tick = setInterval(() => { if (closed) clearInterval(tick); else void draw(); }, TICK_MS);

  bridge.onEvenHubEvent((event) => {
    if (closed) return;
    // The 4/5 right after an exit call are the system dialog's own show/close, not the app entering/leaving.
    if (requestExit.onLifecycle(event) !== null) return;
    if (isSystemExitEvent(event)) { closed = true; player.stop(); clearInterval(tick); tiles.close(); return; }
    if (isBackSignal(event)) requestExit.back();
    // The glasses' side menu is off (SIDE_MENU): a menu click never runs anything.
    if (menuItemIdFromEvent(event) !== null) return;
    const gesture = gestureFromEvent(event, { invertScroll: invert() });
    if (!gesture) return;
    // 2x is back one level and only on the start page the exit dialog; it never ends playback by itself. Hold has no function.
    if (screen === "start") {
      switch (gesture.gesture) {
        case "click": screen = startRows()[startCursor]?.kind === "status" ? "status" : "captions"; break;
        case "scrollUp": startCursor = Math.max(0, startCursor - 1); break;
        case "scrollDown": startCursor = Math.min(startRows().length - 1, startCursor + 1); break;
        case "doubleClick": void requestExit(); return;
        default: return;
      }
      void draw();
      return;
    }
    if (gesture.gesture === "doubleClick") { screen = "start"; void draw(); return; }
    if (gesture.gesture === "click") { toggle(); return; }
    if (screen === "status") return;
    if (gesture.gesture !== "scrollDown" && gesture.gesture !== "scrollUp") return;
    if (gesture.gesture === "scrollDown") cursor = Math.max(0, Math.min(captions.length - 1, cursor + 1));
    if (gesture.gesture === "scrollUp") cursor = Math.max(0, cursor - 1);
    player.resync(); void draw();
  });
  bridge.onDeviceStatusChanged((status) => { if (status?.connectType === "connected" && !closed) { pageReady = false; lastView = null; lastKey = ""; installed = null; void draw(); } });
}
void boot().catch((error: unknown) => console.error("[podcaption]", error));
