import { waitForEvenAppBridge, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import {
  blobFromBase64, fetchStatus, newQuest, submitPhoto, type ClientOptions, type LumenStatus,
} from "./lumen/client";
import { gestureFromEvent, menuItemIdFromEvent } from "./input/gestures";
import { buildView, type LumenView, type Phase } from "./glasses/view";
import { sameView } from "./glasses/diff";
import { createPage, updateIcon, updatePage, type MenuSpec } from "./glasses/render";
import { FLAP_STEP_MS, isFlapping, mothSprite, spriteKey } from "./glasses/sprite";
import { loadWithStart, save, type LumenData } from "./storage/persist";
import { mountPhoneUi } from "./ui/phone";
import { createExitRequest } from "./exit";
import { rememberLocale, resolveLocale, type Locale } from "./i18n";
import { t } from "./messages";
import { isFinalExit, lifecycleFromEvent } from "./lifecycle";
import { activeConfirm, CONFIRM_WINDOW_MS, type PendingConfirm } from "./input/confirm";

const DEMO = new URLSearchParams(location.search).get("demo") === "1";

/** How often the moth and the light window refresh. */
const POLL_MS = 60_000;
/** A tap this soon after the menu click that armed the question is a slip of the same gesture and counts for nothing. */
const ARM_GUARD_MS = 400;
/**
 * The glasses' side menu (QIS v1.2). Off: its clicks never reach the app on the real glasses, and while a page
 * carries a menu the hold opens it instead of reaching the app (step log of 15.10.2026). Without it a swipe
 * opens the help and a hold arms "new quest" again.
 */
const SIDE_MENU = false;
/** Side menu (QIS v1.2): item ids. */
const MENU_HELP = 1;
const MENU_NEW_QUEST = 2;

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
  /** Key of the sprite the glasses show now; the image is only resent when it changes. */
  let lastIcon: string | null = null;
  let flapTimer: ReturnType<typeof setInterval> | undefined;
  let pageReady = false;
  /** Set by a reconnect or a return to the foreground: the next draw rebuilds the page. */
  let rebuildWanted = false;
  /** In the background (system menu, another app): no polling, no wing beats. */
  let paused = false;
  /** The menu armed "new quest" (it would replace the open one); a single tap or the same menu item again within the window carries it out. */
  let pendingQuest: PendingConfirm<"newQuest"> | null = null;
  let armedAt = 0;
  /** The help page (side menu) is open. */
  let helpOpen = false;
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
    phase, result, error, locale, confirmQuest: activeConfirm(pendingQuest, Date.now()) !== null, help: helpOpen, demo: isDemo(), sideMenu: SIDE_MENU,
  });

  /** QIS v1.2: the side menu, in the current language; supplied again on every page (re)build. */
  const menu = (): MenuSpec => ({
    items: !SIDE_MENU ? [] : [
      { id: MENU_HELP, label: t(locale, "m.help") },
      { id: MENU_NEW_QUEST, label: t(locale, "m.newQuest") },
    ],
  });

  const currentIcon = () => mothSprite(status?.moth.state ?? "eingerollt", Date.now());

  const drawOnce = async (): Promise<void> => {
    if (closed) return;
    const view = currentView();
    const icon = currentIcon();
    const iconKey = spriteKey(icon);
    // A page lost with the link or left in the background is rebuilt even
    // when nothing changed; an unchanged view would otherwise leave it blank.
    if (rebuildWanted) { rebuildWanted = false; pageReady = false; }
    const sameText = pageReady && sameView(lastView, view);
    if (sameText && iconKey === lastIcon) return;

    // Only the wings moved: send the small image, not the text.
    if (sameText && pageReady) {
      const quick = await updateIcon(bridge, icon);
      // A lost image is retried with the next wing beat; the page itself stands.
      if (quick.ok) lastIcon = iconKey;
      else console.warn("[lumen] icon failed:", quick.reason);
      return;
    }

    const outcome = pageReady ? await updatePage(bridge, view, icon) : await createPage(bridge, view, icon, menu());
    if (outcome.ok) { pageReady = true; lastView = view; lastIcon = iconKey; return; }
    pageReady = false;
    console.warn("[lumen] draw failed:", outcome.reason);
  };

  /** One page write at a time; a request during a write redraws once after it. */
  const draw = (): Promise<void> => {
    if (drawing) { drawAgain = true; return drawing; }
    drawing = (async () => {
      try {
        do { drawAgain = false; await drawOnce(); } while (drawAgain && !closed);
      } finally {
        drawing = null;
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

  /** The wings only beat while the moth is awake and nothing else is on screen. */
  const flapTick = (): void => {
    if (closed || paused || !pageReady || !status || phase !== "idle" || error) return;
    if (isFlapping(status.moth.state)) void draw();
  };
  flapTimer = setInterval(flapTick, FLAP_STEP_MS);

  const requestExit = createExitRequest(bridge, {
    onConfirmed: () => { closed = true; clearTimeout(timer); clearTimeout(confirmTimer); clearInterval(flapTimer); },
  }, "lumen");

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
    clearInterval(flapTimer);
  };

  // Gestures first: nothing native or on the network may be awaited before
  // this, or an unreachable LUMEN leaves the glasses deaf, even to the exit.
  bridge.onEvenHubEvent((event) => {
    if (closed) return;
    const step = lifecycleFromEvent(event);
    if (step === "foregroundExit") { paused = true; clearTimeout(timer); return; }
    if (step === "foregroundEnter") {
      paused = false;
      rebuildWanted = true;
      void draw();
      if (!isDemo()) { void refresh().then(schedule, schedule); }
      return;
    }
    if (isFinalExit(step)) { stopAll(); return; }
    // QIS v1.2: a click in the glasses' side menu (hold). Help is a page; "new quest" is armed first.
    const menuId = menuItemIdFromEvent(event);
    if (menuId !== null) {
      if (paused) return;
      if (menuId === MENU_HELP && !helpOpen && phase === "idle") { disarm(); helpOpen = true; void draw(); return; }
      if (menuId === MENU_NEW_QUEST && !helpOpen) { armNewQuest(true); return; }
      return;
    }

    const gesture = gestureFromEvent(event, { invertScroll: data.invertScroll });
    if (!gesture) return;

    const armed = activeConfirm(pendingQuest, Date.now()) !== null;
    switch (gesture.gesture) {
      case "click":
        if (helpOpen) { helpOpen = false; break; }
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
        // With a side menu the hold belongs to it; nothing happens in the app (it only leaves the help).
        if (helpOpen) { helpOpen = false; break; }
        if (SIDE_MENU) return;
        // Without one, holding only asks (QIS v1): it arms "new quest", one single tap within the window carries it out.
        armNewQuest(false);
        return;
      case "scrollUp":
      case "scrollDown":
        // With a side menu a swipe changes nothing and fetches nothing (QIS v1.2); it only cancels an open question
        // or leaves the help. Without one it opens the help (swiping again closes it and refreshes the moth).
        if (armed) { disarm(); break; }
        if (helpOpen) { helpOpen = false; if (!SIDE_MENU) void refresh(); break; }
        if (SIDE_MENU || phase !== "idle") return;
        helpOpen = true;
        break;
      case "doubleClick":
        // 2× goes back one level: closes the help, cancels a question, leaves the result;
        // it never stops a photo on its way. At the root it opens the system exit dialog (polling continues until confirmed).
        if (helpOpen) { helpOpen = false; break; }
        if (armed) { disarm(); break; }
        if (phase === "result") { phase = "idle"; result = null; break; }
        if (phase === "submitting") return;
        void requestExit();
        return;
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

  mountPhoneUi({
    getLocale: () => locale,
    setLocale: (next) => {
      locale = next;
      rememberLocale(bridge, next);
      // The side menu carries the language: the page is rebuilt with it.
      if (SIDE_MENU) rebuildWanted = true;
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
    shoot: () => { void shootAndSubmit(); },
    getStatus: () => status,
  });
}

void boot().catch((error: unknown) => {
  console.error("[lumen] failed to start:", error);
});
