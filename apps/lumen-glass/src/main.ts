import { waitForEvenAppBridge, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import {
  blobFromBase64, fetchStatus, newQuest, submitPhoto, type ClientOptions, type LumenStatus,
} from "./lumen/client";
import { gestureFromEvent } from "./input/gestures";
import { buildView, type LumenView, type Phase } from "./glasses/view";
import { sameView } from "./glasses/diff";
import { createPage, updateIcon, updatePage } from "./glasses/render";
import { FLAP_STEP_MS, isFlapping, mothSprite, spriteKey } from "./glasses/sprite";
import { load, save, type LumenData } from "./storage/persist";
import { mountPhoneUi } from "./ui/phone";
import { createExitRequest } from "./exit";
import { rememberLocale, resolveLocale, type Locale } from "./i18n";
import { t } from "./messages";
import { isFinalExit, lifecycleFromEvent } from "./lifecycle";
import { activeConfirm, CONFIRM_WINDOW_MS, confirmStep, type PendingConfirm } from "./input/confirm";

const DEMO = new URLSearchParams(location.search).get("demo") === "1";

/** How often the moth and the light window refresh. */
const POLL_MS = 60_000;

async function boot(): Promise<void> {
  const bridge: EvenAppBridge = await waitForEvenAppBridge();

  let data: LumenData = await load(bridge);
  let locale: Locale = await resolveLocale(bridge);
  let status: LumenStatus | null = DEMO ? { moth: { light: 72, state: "wach", gesture: "circling in the light", streak: 6 }, quest: { id: 1, title: "Reflected Light", task: "Photograph a reflection that changes the scene.", medium: "foto", minutes: 15, checkable: null }, openQuests: 1, window: { kind: "golden", minutesAway: 24 } } : null;
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
  /** A hold that would replace the open quest waits here for its second hold. */
  let pendingQuest: PendingConfirm<"newQuest"> | null = null;
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
    phase, result, error, locale, confirmQuest: activeConfirm(pendingQuest, Date.now()) !== null,
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

    const outcome = pageReady ? await updatePage(bridge, view, icon) : await createPage(bridge, view, icon);
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
    if (!data.baseUrl) { error = t("en", "g.err.noAddress"); await draw(); return; }
    const outcome = await fetchStatus(options());
    // A newer request (e.g. after the address changed) owns the display now.
    if (seq !== refreshSeq || closed) return;
    if (outcome.error !== null) {
      error = outcome.error;
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

    phase = "shooting";
    result = null;
    await draw();

    const asset = await bridge.captureImageFromCamera().catch(() => null);
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
      await draw();
      return;
    }

    // LUMEN's answer to an upload cannot be read (no CORS on its form route),
    // so its status tells what happened: a quest that is no longer the open
    // one was ticked off. The view words the outcome in the current language.
    const check = await fetchStatus(options());
    if (closed) return;
    if (check.error === null && check.value !== null) {
      status = check.value;
      error = null;
      const ticked = check.value.quest?.id !== quest.id;
      result = ticked || outcome.value === "confirmed"
        ? { ok: true, text: ticked ? "done" : "" }
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

  /**
   * Holding asks LUMEN for a new quest, which replaces the open one. With a
   * quest on screen the first hold only arms that (the footer says so); a
   * second hold within a few seconds carries it out.
   */
  const onHold = (): void => {
    if (phase !== "idle") return;
    if (!status?.quest) { void askForQuest(); return; }
    const step = confirmStep(pendingQuest, "newQuest", Date.now());
    pendingQuest = step.pending;
    clearTimeout(confirmTimer);
    if (step.confirmed) { void askForQuest(); return; }
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
      if (!DEMO) { void refresh().then(schedule, schedule); }
      return;
    }
    if (isFinalExit(step)) { stopAll(); return; }
    const gesture = gestureFromEvent(event, { invertScroll: data.invertScroll });
    if (!gesture) return;

    switch (gesture.gesture) {
      case "click":
        pendingQuest = null;
        if (phase === "result") { phase = "idle"; result = null; break; }
        if (error) { void refresh(); return; }
        void shootAndSubmit();
        return;
      case "longPress":
        onHold();
        return;
      case "scrollUp":
      case "scrollDown":
        pendingQuest = null;
        void refresh();
        return;
      case "doubleClick":
        // System exit dialog; polling continues until the user confirms.
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
  if (!DEMO) { void refresh().then(schedule, schedule); }

  mountPhoneUi({
    getLocale: () => locale,
    setLocale: (next) => {
      locale = next;
      rememberLocale(bridge, next);
      void draw();
    },
    getData: () => data,
    setData: async (next) => {
      data = next;
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
