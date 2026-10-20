import { waitForEvenAppBridge, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import {
  blobFromBase64, fetchStatus, newQuest, submitPhoto, type ClientOptions, type LumenStatus,
} from "./lumen/client";
import { gestureFromEvent, menuItemIdFromEvent } from "./input/gestures";
import { buildView, startRows, type LumenView, type Phase, type Screen } from "./glasses/view";
import { sameView } from "./glasses/diff";
import { COCKPIT_TILES, createCockpitPage, createTextPage, forgetPage, guardedTileSend, updateTextPage } from "./glasses/page";
import { cockpitModel } from "./cockpit/model";
import { composeCockpit, modelKey } from "./cockpit/compose";
import { createTileSender } from "./screen/sender";
import { autoBackend, type TextBackend } from "./screen/text";
import { loadWithStart, save, type LumenData } from "./storage/persist";
import { mountPhoneUi, type PhoneUi } from "./ui/phone";
import { createExitRequest, isBackSignal } from "./exit";
import { rememberLocale, resolveLocale, type Locale } from "./i18n";
import { t } from "./messages";
import { isFinalExit, lifecycleFromEvent } from "./lifecycle";
import { activeConfirm, CONFIRM_WINDOW_MS, type PendingConfirm } from "./input/confirm";

const DEMO = new URLSearchParams(location.search).get("demo") === "1";
/** `?demo=1&screen=moth|quest` opens straight on a screen (simulator screenshots); without it the start page. */
const START_SCREEN = new URLSearchParams(location.search).get("screen");

/** How often the moth and the light window refresh. */
const POLL_MS = 60_000;
/** A tap this soon after the menu click that armed the question is a slip of the same gesture and counts for nothing. */
const ARM_GUARD_MS = 400;
/** The cockpit is redrawn this often: the clock stays current; an unchanged frame sends nothing. */
const TICK_MS = 15_000;

/** Sample data for the first start, before an address is saved (QIS v1.2 no. 7). */
const DEMO_QUESTS: NonNullable<LumenStatus["quest"]>[] = [
  { id: 1, title: "Reflected Light", task: "Photograph a reflection that changes the scene.", medium: "foto", minutes: 15, checkable: null },
  { id: 2, title: "Long Shadow", task: "Find a shadow that is longer than the thing casting it.", medium: "foto", minutes: 10, checkable: null },
];
const demoStatus = (quest: number): LumenStatus => ({
  moth: { light: 72, state: "wach", gesture: "circling in the light", streak: 6 },
  quest: DEMO_QUESTS[quest % DEMO_QUESTS.length]!,
  openQuests: 1,
  window: { kind: "golden", minutesAway: 24 },
});

async function boot(): Promise<void> {
  const bridge: EvenAppBridge = await waitForEvenAppBridge();

  const start = await loadWithStart(bridge);
  let data: LumenData = start.data;
  let locale: Locale = await resolveLocale(bridge);
  /** Demo: `?demo=1`, or a first start with nothing saved yet. Leaves with the first saved address (`?demo=1` stays). */
  let firstStart = start.firstStart;
  const isDemo = (): boolean => DEMO || firstStart;
  let demoQuest = 0;
  /** The raw technical message of the last failure, for the phone's More tab (never for the glasses). */
  let lastDetail: string | null = null;
  let status: LumenStatus | null = isDemo() ? demoStatus(demoQuest) : null;
  let phase: Phase = "idle";
  let result: { ok: boolean; text: string } | null = null;
  let error: string | null = null;
  let lastView: LumenView | null = null;
  /** What is on the glasses: the start page, the quest (text) or the moth (a cockpit image). */
  let screen: Screen = START_SCREEN === "moth" || START_SCREEN === "quest" ? START_SCREEN : "start";
  let startCursor = 0;
  let tickTimer: ReturnType<typeof setInterval> | undefined;
  let pageReady = false;
  /** Which kind of page the glasses carry: a change means one rebuild. */
  let installed: "text" | "cockpit" | null = null;
  let lastKey = "";
  let textBackend: TextBackend | null = null;
  let phone: PhoneUi | null = null;
  /** Set by a reconnect or a return to the foreground: the next draw rebuilds the page. */
  let rebuildWanted = false;
  /** In the background (system menu, another app): no polling, no wing beats. */
  let paused = false;
  /** The menu armed "new quest" (it would replace the open one); a single tap or the same menu item again within the window carries it out. */
  let pendingQuest: PendingConfirm<"newQuest"> | null = null;
  let armedAt = 0;
  let confirmTimer: ReturnType<typeof setTimeout> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let drawing: Promise<void> | null = null;
  let drawAgain = false;
  /** The status request in flight, shared by everyone who asks meanwhile. */
  let refreshing: Promise<void> | null = null;
  /** Bumped per request, so a slow reply never overwrites a newer one. */
  let refreshSeq = 0;

  const options = (): ClientOptions => ({
    baseUrl: data.baseUrl,
    ...(data.token ? { token: data.token } : {}),
  });

  const currentView = (): LumenView => buildView(status, {
    phase, result, error, locale, confirmQuest: activeConfirm(pendingQuest, Date.now()) !== null, demo: isDemo(), screen: screen === "moth" ? "quest" : screen, startCursor,
  });

  // While the exit dialog may be on screen (asked, no input since) no timer, poll or stream may draw: a page call
  // could cover it. Data keeps being collected; the back signal restores the page the way of the first one.
  let exitAsked = (): boolean => false;
  /** The cockpit is one 576 x 288 frame; only the tiles whose pixels changed cross Bluetooth. Never while the dialog may be up. */
  const tiles = createTileSender(COCKPIT_TILES, guardedTileSend(bridge, () => !exitAsked() && !closed && !paused && installed === "cockpit"));

  /** The moth shows as an image while nothing else (a photo on its way, its result, an error) lies on top of it. */
  const showsCockpit = (): boolean => screen === "moth" && phase === "idle";

  const drawOnce = async (): Promise<void> => {
    if (exitAsked()) return;
    if (closed || paused) return;
    // A page lost with the link or left in the background is rebuilt even
    // when nothing changed; an unchanged view would otherwise leave it blank.
    if (rebuildWanted) { rebuildWanted = false; pageReady = false; lastView = null; lastKey = ""; installed = null; }
    if (showsCockpit()) {
      const model = cockpitModel({ status, error, demo: isDemo(), locale, now: Date.now() });
      const key = modelKey(model);
      if (installed !== "cockpit") pageReady = false;
      if (pageReady && key === lastKey) return;
      if (!pageReady) {
        const created = await createCockpitPage(bridge);
        if (closed) return;
        if (!created.ok) { pageReady = false; lastKey = ""; console.warn("[lumen] draw failed:", created.reason); return; }
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
    const view = currentView();
    // Leaving the cockpit: its containers are about to go, no tile may be written any more.
    if (installed === "cockpit") { installed = null; pageReady = false; }
    if (pageReady && sameView(lastView, view)) return;
    const outcome = pageReady ? await updateTextPage(bridge, view, lastView) : await createTextPage(bridge, view);
    if (closed) return;
    if (outcome.ok) { pageReady = true; installed = "text"; lastView = view; lastKey = ""; return; }
    pageReady = false;
    lastView = null;
    console.warn("[lumen] draw failed:", outcome.reason);
  };

  /** One page write at a time; a request during a write redraws once after it. */
  const draw = (): Promise<void> => {
    if (exitAsked()) return Promise.resolve();
    if (drawing) { drawAgain = true; return drawing; }
    drawing = (async () => {
      try {
        do { drawAgain = false; await drawOnce(); } while (drawAgain && !closed);
      } finally {
        drawing = null;
        phone?.refreshLive();
      }
    })();
    return drawing;
  };

  const fetchAndShow = async (seq: number): Promise<void> => {
    // Stored in the canonical English wording; the view translates it.
    if (isDemo()) return;
    if (!data.baseUrl) { error = t("en", "g.err.noAddress"); await draw(); return; }
    const outcome = await fetchStatus(options());
    // A newer request (e.g. after the address changed) owns the display now.
    if (seq !== refreshSeq || closed) return;
    if (outcome.error !== null) {
      error = outcome.error;
      lastDetail = outcome.error;
    } else {
      error = null;
      status = outcome.value;
    }
    await draw();
  };

  /**
   * Swipes, taps, the poll and the phone all ask for a refresh. While one is in
   * flight they share it instead of stacking requests; `force` starts a fresh
   * one, for when the address or token just changed.
   */
  const refresh = (force = false): Promise<void> => {
    if (closed) return Promise.resolve();
    if (refreshing && !force) return refreshing;
    const seq = ++refreshSeq;
    const current = fetchAndShow(seq).finally(() => {
      if (refreshing === current) refreshing = null;
    });
    refreshing = current;
    return current;
  };

  const schedule = (): void => {
    clearTimeout(timer);
    if (closed || paused) return;
    timer = setTimeout(() => { void refresh().then(schedule, schedule); }, POLL_MS);
  };

  /**
   * Take a photo on the phone and hand it straight to LUMEN.
   *
   * The glasses have no camera, so this opens the phone's own camera through
   * the SDK — user-initiated by design. The photo goes to LUMEN and nowhere
   * else, and is not kept on the glasses side at all.
   */
  const shootAndSubmit = async (): Promise<void> => {
    const quest = status?.quest;
    if (!quest || phase !== "idle") return;

    // Demo: no camera and nothing sent; the result screen shows what a ticked-off quest looks like.
    if (isDemo()) { phase = "result"; result = { ok: true, text: "done" }; await draw(); return; }

    phase = "shooting";
    result = null;
    await draw();

    const asset = await bridge.captureImageFromCamera().catch(() => null);
    // 2× during the shot opens the exit dialog without stopping it (QIS v1.2 no. 2); once the exit was
    // confirmed, a photo that is taken afterwards is not sent.
    if (closed) return;
    if (!asset?.base64) {
      // Cancelling the camera is a normal thing to do, not an error.
      phase = "idle";
      await draw();
      return;
    }

    phase = "submitting";
    await draw();

    const photo = blobFromBase64(asset.base64, asset.mimeType || "image/jpeg");
    const outcome = await submitPhoto(options(), quest.id, photo, asset.name || "photo.jpg");
    if (closed) return;

    if (outcome.error !== null) {
      phase = "result";
      result = { ok: false, text: outcome.error };
      lastDetail = outcome.error;
      await draw();
      return;
    }

    // LUMEN answers with JSON: say right away what it decided, then fetch the
    // moth's new light in the background.
    const submission = outcome.value!;
    if (submission.kind !== "unknown") {
      result = submission.kind === "done"
        ? { ok: true, text: "done" }
        : { ok: false, text: submission.message ?? t("en", "g.err.notTicked") };
      phase = "result";
      await draw();
      void refresh(true);
      return;
    }

    // The answer could not be read (an older LUMEN without CORS on its form
    // route), so its status tells what happened: a quest that is no longer
    // the open one was ticked off. The view words it in the current language.
    const check = await fetchStatus(options());
    if (closed) return;
    if (check.error === null && check.value !== null) {
      status = check.value;
      error = null;
      const ticked = check.value.quest?.id !== quest.id;
      result = ticked
        ? { ok: true, text: "done" }
        : { ok: false, text: t("en", "g.err.notTicked") };
    } else {
      result = { ok: true, text: "" };
    }
    phase = "result";
    await draw();
  };

  const askForQuest = async (): Promise<void> => {
    if (phase !== "idle") return;
    pendingQuest = null;
    if (isDemo()) { demoQuest += 1; status = demoStatus(demoQuest); await draw(); return; }
    const outcome = await newQuest(options());
    if (outcome.error !== null) { error = outcome.error; await draw(); return; }
    await refresh(true);
  };

  // shutDownPageContainer(1) resolves when the dialog is SHOWN, not when the user answered: the result never
  // tears the app down (the system ends it: sysEvent 6/7). On the next input the page comes back as a first page.
  const requestExit = createExitRequest(bridge, {
    onBack: () => {
      // The dialog took the page away. Put it up again the way of the
      // first one (create), so the glasses deliver input - and the next 2x - to the app again.
      if (closed) return;
      pageReady = false;
      lastView = null;
      lastKey = "";
      installed = null;
      forgetPage(bridge);
      return draw();
    },
  }, "lumen");
  exitAsked = requestExit.asked;

  /** Nothing waits for a confirming tap any more. */
  const disarm = (): void => {
    pendingQuest = null;
    clearTimeout(confirmTimer);
  };

  /**
   * The menu item only asks (QIS v1.2 no. 3): it arms "new quest", which replaces the open one, and the footer says so.
   * One single tap, or the same menu item again, within a few seconds carries it out; a swipe, 2× or a pause cancels it.
   */
  const armNewQuest = (fromMenu = true): void => {
    if (phase !== "idle" || !status || error) return;
    if (activeConfirm(pendingQuest, Date.now()) !== null) {
      // The same menu item again carries it out; without a menu a second hold just cancels (a single tap confirms).
      if (fromMenu) { disarm(); void askForQuest(); } else { disarm(); void draw(); }
      return;
    }
    const now = Date.now();
    pendingQuest = { kind: "newQuest", until: now + CONFIRM_WINDOW_MS };
    armedAt = now;
    clearTimeout(confirmTimer);
    // Disarms by itself; the footer goes back to normal.
    confirmTimer = setTimeout(() => { pendingQuest = null; void draw(); }, CONFIRM_WINDOW_MS + 50);
    void draw();
  };

  const stopAll = (): void => {
    closed = true;
    clearTimeout(timer);
    clearTimeout(confirmTimer);
    clearInterval(tickTimer);
    tiles.close();
  };

  // Gestures first: nothing native or on the network may be awaited before
  // this, or an unreachable LUMEN leaves the glasses deaf, even to the exit.
  bridge.onEvenHubEvent((event) => {
    if (closed) return;
    // The 4/5 right after an exit call are the system dialog's own show/close, not the app entering/leaving:
    // they must neither pause the polling nor redraw over the dialog.
    if (requestExit.onLifecycle(event) !== null) return;
    const step = lifecycleFromEvent(event);
    if (isBackSignal(event)) requestExit.back();
    if (step === "foregroundExit") { paused = true; clearTimeout(timer); return; }
    if (step === "foregroundEnter") {
      paused = false;
      rebuildWanted = true;
      void draw();
      if (!isDemo()) { void refresh().then(schedule, schedule); }
      return;
    }
    if (isFinalExit(step)) { stopAll(); return; }
    // The glasses' side menu is off (SIDE_MENU = false): a menu click never runs anything.
    if (menuItemIdFromEvent(event) !== null) return;

    const gesture = gestureFromEvent(event, { invertScroll: data.invertScroll });
    if (!gesture) return;

    const armed = activeConfirm(pendingQuest, Date.now()) !== null;

    // The start page: tap opens the entry, swipe moves, 2x asks the exit dialog.
    if (screen === "start") {
      switch (gesture.gesture) {
        case "click": screen = startRows()[startCursor]?.kind === "moth" ? "moth" : "quest"; break;
        case "scrollUp": startCursor = Math.max(0, startCursor - 1); break;
        case "scrollDown": startCursor = Math.min(startRows().length - 1, startCursor + 1); break;
        case "doubleClick": void requestExit(); return;
        default: return;
      }
      void draw();
      return;
    }

    // The moth: tap asks again, 2x goes back. (A photo's result lies on top and ends with a tap or 2x.)
    if (screen === "moth" && phase === "idle") {
      switch (gesture.gesture) {
        case "click": void refresh(); return;
        case "doubleClick": screen = "start"; break;
        default: return;
      }
      void draw();
      return;
    }

    // The quest.
    switch (gesture.gesture) {
      case "click":
        if (armed) {
          // The tap that ends the hold is not the confirming one.
          if (Date.now() - armedAt < ARM_GUARD_MS) return;
          disarm();
          void askForQuest();
          return;
        }
        disarm();
        if (phase === "result") { phase = "idle"; result = null; break; }
        if (error) { void refresh(); return; }
        void shootAndSubmit();
        return;
      case "longPress":
        // Holding only asks (QIS v1): it arms "new quest", one single tap within the window carries it out.
        armNewQuest(false);
        return;
      case "scrollUp":
      case "scrollDown":
        // A swipe only cancels an open question; it never changes or fetches anything.
        if (armed) { disarm(); break; }
        return;
      case "doubleClick":
        // 2× goes back one level: cancels a question, leaves the result, then the quest page;
        // it never stops a photo on its way.
        if (armed) { disarm(); break; }
        if (phase === "result") { phase = "idle"; result = null; break; }
        if (phase === "submitting") return;
        // A shot in progress is a running job: 2× opens the exit dialog without stopping it (QIS v1.2 no. 2).
        if (phase === "shooting") { void requestExit(); return; }
        screen = "start";
        break;
      default:
        return;
    }
    void draw();
  });

  bridge.onDeviceStatusChanged((deviceStatus) => {
    if (deviceStatus?.connectType === "connected" && !closed) {
      rebuildWanted = true;
      void draw();
    }
  });

  void draw();
  if (!isDemo()) { void refresh().then(schedule, schedule); }
  // The clock on the moth cockpit: redrawn every 15 s; an unchanged frame costs nothing.
  tickTimer = setInterval(() => { void draw(); }, TICK_MS);

  phone = mountPhoneUi({
    getLocale: () => locale,
    setLocale: (next) => {
      locale = next;
      rememberLocale(bridge, next);
      void draw();
    },
    getData: () => data,
    isDemo,
    getLastError: () => lastDetail,
    setData: async (next) => {
      data = next;
      // The first saved address ends the first-start demo (an explicit ?demo=1 stays).
      if (firstStart) { firstStart = false; if (!DEMO) { status = null; error = null; pendingQuest = null; } }
      await save(bridge, next).catch((saveError: unknown) => {
        console.warn("[lumen] save failed:", saveError);
      });
      await refresh(true);
    },
    // The photo flow (shutter, result) lives on the quest page: the phone's button brings the glasses there.
    shoot: () => { screen = "quest"; void shootAndSubmit(); },
    getStatus: () => status,
  });
}

void boot().catch((error: unknown) => {
  console.error("[lumen] failed to start:", error);
});
