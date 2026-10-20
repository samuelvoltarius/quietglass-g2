import { waitForEvenAppBridge, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { appStore } from "./storage/kv";
import { createExitRequest, isBackSignal, isSystemExitEvent } from "./exit";
import { COCKPIT_TILES, createCockpitPage, forgetPage, guardedTileSend } from "./glasses/page";
import { cockpitModel, type CockpitModel } from "./cockpit/model";
import { composeCockpit } from "./cockpit/compose";
import { createTileSender } from "./screen/sender";
import { autoBackend, type TextBackend } from "./screen/text";
import { resolveLocale, rememberLocale, setLocale, type Locale } from "./i18n";
import { gestureFromEvent, menuItemIdFromEvent } from "./input/gestures";
import {
  addSample, DEFAULT_MAX_HR, demoSession, demoTelemetry, effectiveSport, fetchTelemetry, modeOf, nextSport, type Session, type Sport,
} from "./telemetry/model";
import { DEFAULT_ENDPOINT, mountPhoneUi, type PhoneState, type PhoneUi } from "./ui/phone";

/**
 * The glasses' side menu (QIS v1.2). Off: measured with the step log on the real glasses (15.10.2026), the menu is
 * shown but its clicks never reach the app, and while a page carries a menu a hold opens it instead of reaching the app.
 * Off, the pages carry no menu and swipe does what the menu entry "Sportart" did.
 */
export const SIDE_MENU = false;
const KEYS = ["quietglass.locale", "endurance.sport", "endurance.endpoint", "endurance.invert", "endurance.tab", "endurance.maxhr"] as const;
/** The bridge is asked this often; the cockpit follows every answer (an unchanged picture sends nothing). */
const POLL_MS = 2000;

async function boot(): Promise<void> {
  const bridge: EvenAppBridge = await waitForEvenAppBridge();
  // SDK KV is the durable store; hydrate before anything reads a value.
  await appStore.init(bridge, KEYS);
  let locale: Locale = await resolveLocale(bridge);
  setLocale(locale);
  let data = demoTelemetry();
  let receivedAt = Date.now();
  let failed = false;
  let lastError = "";
  let session: Session = demoSession(Date.now());
  let choice = appStore.get("endurance.sport");
  let pageReady = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let polling = false;
  let closed = false;
  let phone: PhoneUi | null = null;
  let textBackend: TextBackend | null = null;

  const invertScroll = (): boolean => appStore.get("endurance.invert") === "1";
  const maxHr = (): number => { const saved = Number(appStore.get("endurance.maxhr")); return Number.isFinite(saved) && saved >= 120 && saved <= 220 ? saved : DEFAULT_MAX_HR; };
  const sport = (): Sport => effectiveSport(choice, data.sport);
  const mode = () => modeOf(data, receivedAt, Date.now(), failed);
  const model = (): CockpitModel => cockpitModel({ locale, sport: sport(), data, mode: mode(), maxHr: maxHr(), now: Date.now(), hrMax: session.hrMax });

  // While the exit dialog may be on screen (asked, no input since) no timer, poll or stream may draw: a page call
  // could cover it. Data keeps being collected; the back signal restores the page the way of the first one.
  let exitAsked = (): boolean => false;

  /** The cockpit is one 576 x 288 frame; only the tiles whose pixels changed cross Bluetooth. Never while the dialog may be up. */
  const tiles = createTileSender(COCKPIT_TILES, guardedTileSend(bridge, () => !exitAsked() && !closed));

  const draw = async (): Promise<void> => {
    if (closed || exitAsked()) return;
    if (!pageReady) {
      const result = await createCockpitPage(bridge);
      if (closed) return;
      if (!result.ok) { console.warn("[endurance-hud] draw failed:", result.reason); return; }
      pageReady = true;
      // A new page starts with blank images.
      tiles.reset();
    }
    textBackend ??= autoBackend();
    // Never awaited: a slow transfer must not hold up the next poll.
    void tiles.push(composeCockpit(model(), textBackend));
  };

  const phoneState = (): PhoneState => ({
    data, mode: mode(), sport: sport(), choice: choice === "run" || choice === "bike" ? choice : null, lastError, session,
    endpoint: appStore.get("endurance.endpoint") ?? "", maxHr: maxHr(), invert: invertScroll(),
  });

  const refresh = async (): Promise<void> => {
    if (polling || closed) return;
    polling = true;
    try {
      data = await fetchTelemetry(appStore.get("endurance.endpoint") || DEFAULT_ENDPOINT);
      receivedAt = Date.now();
      failed = false;
      lastError = "";
      if (data.source !== "demo") session = addSample(session, data, receivedAt);
    } catch (error) {
      console.warn("[endurance-hud] bridge unavailable", error);
      failed = true;
      lastError = error instanceof Error ? error.message : String(error);
    } finally {
      polling = false;
    }
    await draw();
    phone?.refreshLive();
  };

  const setSport = (value: string | null): void => {
    choice = value === "run" || value === "bike" ? value : null;
    if (choice) appStore.set("endurance.sport", choice);
    else appStore.remove("endurance.sport");
    void draw();
    phone?.refreshLive();
  };

  // shutDownPageContainer(1) resolves when the dialog is SHOWN, not when the user answered: the result never
  // tears the app down (the system ends it: sysEvent 6/7). "No" in the dialog: the dialog took the page away;
  // on the next input (or the system's 5) the page comes back as a first page (store review 16.10.2026).
  const requestExit = createExitRequest(bridge, {
    onBack: () => { if (closed) return; pageReady = false; forgetPage(bridge); return draw(); },
  }, "endurance-hud");
  exitAsked = requestExit.asked;

  await draw();
  void refresh();
  timer = setInterval(() => void refresh(), POLL_MS);

  bridge.onEvenHubEvent((event) => {
    if (closed) return;
    // The 4/5 right after an exit call are the system dialog's own show/close, not the app entering/leaving.
    if (requestExit.onLifecycle(event) !== null) return;
    if (isSystemExitEvent(event)) { closed = true; clearInterval(timer); tiles.close(); return; }
    if (isBackSignal(event)) requestExit.back();
    // The glasses' side menu (off while SIDE_MENU is false): a click carries no action here.
    if (menuItemIdFromEvent(event) !== null) return;
    const gesture = gestureFromEvent(event, { invertScroll: invertScroll() });
    if (!gesture) return;
    switch (gesture.gesture) {
      // Back one level; on the main screen it leaves: the system exit dialog, polling goes on until the user confirms.
      case "doubleClick": void requestExit(); return;
      // Harmless: ask the bridge again.
      case "click": void refresh(); return;
      // Swipe cycles the sport (bike <-> run), as before the standard.
      case "scrollDown": setSport(nextSport(sport(), 1)); return;
      case "scrollUp": setSport(nextSport(sport(), -1)); return;
      // Hold does nothing (the help lives on the phone).
      default: return;
    }
  });
  bridge.onDeviceStatusChanged((device) => { if (device?.connectType === "connected" && !closed) { pageReady = false; void draw(); } });

  phone = mountPhoneUi({
    state: phoneState,
    locale: () => locale,
    setLocale: (next) => { locale = next; rememberLocale(bridge, next); void draw(); },
    refresh: () => void refresh(),
    saveEndpoint: (endpoint) => { appStore.set("endurance.endpoint", endpoint); void refresh(); },
    setSport,
    setMaxHr: (value) => { appStore.set("endurance.maxhr", String(value)); void draw(); phone?.refreshLive(); },
    setInvert: (on) => { appStore.set("endurance.invert", on ? "1" : "0"); },
    getTab: () => appStore.get("endurance.tab"),
    setTab: (tab) => { appStore.set("endurance.tab", tab); },
  });
}
void boot().catch((error: unknown) => console.error("[endurance-hud]", error));
