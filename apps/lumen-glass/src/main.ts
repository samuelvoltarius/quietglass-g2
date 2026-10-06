import { waitForEvenAppBridge, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import {
  blobFromBase64, fetchStatus, newQuest, submitPhoto, type ClientOptions, type LumenStatus,
} from "./lumen/client";
import { gestureFromEvent } from "./input/gestures";
import { buildView, type LumenView, type Phase } from "./glasses/view";
import { sameView } from "./glasses/diff";
import { createPage, updatePage } from "./glasses/render";
import { load, save, type LumenData } from "./storage/persist";
import { mountPhoneUi } from "./ui/phone";
import { createExitRequest } from "./exit";
import { getLocale, setLocale, type Locale } from "./i18n";
import { t } from "./messages";

const PIXEL_ICON = ["#........#", "###....###", ".###..###.", "..######..", "...####...", "....##....", "...####...", "..##..##..", ".##....##.", "##......##"] as const;
const DEMO = new URLSearchParams(location.search).get("demo") === "1";

/** How often the moth and the light window refresh. */
const POLL_MS = 60_000;

async function boot(): Promise<void> {
  const bridge: EvenAppBridge = await waitForEvenAppBridge();

  let data: LumenData = await load(bridge);
  let locale: Locale = getLocale();
  let status: LumenStatus | null = DEMO ? { moth: { light: 72, state: "wach", gesture: "circling in the light", streak: 6 }, quest: { id: 1, title: "Reflected Light", task: "Photograph a reflection that changes the scene.", medium: "foto", minutes: 15, checkable: null }, openQuests: 1, window: { kind: "golden", minutesAway: 24 } } : null;
  let phase: Phase = "idle";
  let result: { ok: boolean; text: string } | null = null;
  let error: string | null = null;
  let lastView: LumenView | null = null;
  let pageReady = false;
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

  const currentView = (): LumenView => buildView(status, { phase, result, error, locale });

  const drawOnce = async (): Promise<void> => {
    if (closed) return;
    const view = currentView();
    if (sameView(lastView, view)) return;

    const outcome = pageReady ? await updatePage(bridge, view, PIXEL_ICON) : await createPage(bridge, view, PIXEL_ICON);
    if (outcome.ok) { pageReady = true; lastView = view; return; }
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
    if (closed) return;
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

    phase = "result";
    result = outcome.error !== null
      ? { ok: false, text: outcome.error }
      // The view words a success itself, in the current language.
      : { ok: true, text: "" };
    await draw();

    // Refresh so the moth reflects what just happened.
    if (outcome.error === null) await refresh(true);
  };

  const askForQuest = async (): Promise<void> => {
    if (phase !== "idle") return;
    const outcome = await newQuest(options());
    if (outcome.error !== null) { error = outcome.error; await draw(); return; }
    await refresh(true);
  };

  const requestExit = createExitRequest(bridge, {
    onConfirmed: () => { closed = true; clearTimeout(timer); },
  }, "lumen");

  await draw();
  if (!DEMO) { await refresh(); schedule(); }

  bridge.onEvenHubEvent((event) => {
    if (closed) return;
    const gesture = gestureFromEvent(event, { invertScroll: data.invertScroll });
    if (!gesture) return;

    switch (gesture.gesture) {
      case "click":
        if (phase === "result") { phase = "idle"; result = null; break; }
        if (error) { void refresh(); return; }
        void shootAndSubmit();
        return;
      case "longPress":
        void askForQuest();
        return;
      case "scrollUp":
      case "scrollDown":
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
      pageReady = false;
      void draw();
    }
  });

  mountPhoneUi({
    getLocale: () => locale,
    setLocale: (next) => {
      locale = next;
      setLocale(next);
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
