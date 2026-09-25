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

/** How often the moth and the light window refresh. */
const POLL_MS = 60_000;

async function boot(): Promise<void> {
  const bridge: EvenAppBridge = await waitForEvenAppBridge();

  let data: LumenData = await load(bridge);
  let status: LumenStatus | null = null;
  let phase: Phase = "idle";
  let result: { ok: boolean; text: string } | null = null;
  let error: string | null = null;
  let lastView: LumenView | null = null;
  let pageReady = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const options = (): ClientOptions => ({
    baseUrl: data.baseUrl,
    ...(data.token ? { token: data.token } : {}),
  });

  const currentView = (): LumenView => buildView(status, { phase, result, error });

  const draw = async (): Promise<void> => {
    const view = currentView();
    if (sameView(lastView, view)) return;

    const outcome = pageReady ? await updatePage(bridge, view) : await createPage(bridge, view);
    if (outcome.ok) { pageReady = true; lastView = view; return; }
    pageReady = false;
    console.warn("[lumen] draw failed:", outcome.reason);
  };

  const refresh = async (): Promise<void> => {
    if (!data.baseUrl) { error = "No Lumen address set."; await draw(); return; }
    const outcome = await fetchStatus(options());
    if (outcome.error !== null) {
      error = outcome.error;
    } else {
      error = null;
      status = outcome.value;
    }
    await draw();
  };

  const schedule = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => { void refresh().then(schedule); }, POLL_MS);
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
      : { ok: true, text: "Sent. Lumen is looking at it." };
    await draw();

    // Refresh so the moth reflects what just happened.
    if (outcome.error === null) await refresh();
  };

  const askForQuest = async (): Promise<void> => {
    if (phase !== "idle") return;
    const outcome = await newQuest(options());
    if (outcome.error !== null) { error = outcome.error; await draw(); return; }
    await refresh();
  };

  await draw();
  await refresh();
  schedule();

  bridge.onEvenHubEvent((event) => {
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
        clearTimeout(timer);
        void bridge.shutDownPageContainer();
        return;
      default:
        return;
    }
    void draw();
  });

  bridge.onDeviceStatusChanged((deviceStatus) => {
    if (deviceStatus?.connectType === "connected") {
      pageReady = false;
      void draw();
    }
  });

  mountPhoneUi({
    getData: () => data,
    setData: async (next) => {
      data = next;
      await save(bridge, next);
      await refresh();
    },
    shoot: () => { void shootAndSubmit(); },
    getStatus: () => status,
  });
}

void boot().catch((error: unknown) => {
  console.error("[lumen] failed to start:", error);
});
