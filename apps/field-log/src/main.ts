import {
  AudioInputSource, waitForEvenAppBridge, type EvenAppBridge,
} from "@evenrealities/even_hub_sdk";
import { createMockStt, createWebSocketStt, type SttProvider, type SttStatus } from "./stt/provider";
import { addEntry, attachToLatest, type Inspection, type Severity } from "./log/entries";
import { gestureFromEvent } from "./input/gestures";
import { buildView, type LogView, type Phase } from "./glasses/view";
import { sameView } from "./glasses/diff";
import { createPage, updatePage } from "./glasses/render";
import {
  activeInspection, load, save, upsertInspection, usesMockStt, type FieldLogData,
} from "./storage/persist";
import { mountPhoneUi } from "./ui/phone";

const SEVERITIES: readonly Severity[] = ["note", "minor", "major"];

async function boot(): Promise<void> {
  const bridge: EvenAppBridge = await waitForEvenAppBridge();

  let data: FieldLogData = await load(bridge);
  let phase: Phase = "idle";
  let pending: string | null = null;
  let stt: SttProvider | null = null;
  let status: SttStatus = "idle";
  let lastView: LogView | null = null;
  let pageReady = false;

  const inspection = (): Inspection | null => activeInspection(data);

  const currentView = (): LogView =>
    buildView(inspection(), {
      phase,
      severity: data.severity,
      pending,
      status,
      mock: usesMockStt(data),
    });

  const draw = async (): Promise<void> => {
    const view = currentView();
    if (sameView(lastView, view)) return;

    const result = pageReady ? await updatePage(bridge, view) : await createPage(bridge, view);
    if (result.ok) { pageReady = true; lastView = view; return; }
    pageReady = false;
    console.warn("[fieldlog] draw failed:", result.reason);
  };

  const persist = async (next: Inspection): Promise<void> => {
    data = upsertInspection(data, next);
    await save(bridge, data);
  };

  const onTranscript = (transcript: { text: string; final: boolean }): void => {
    if (!transcript.final) return;
    const text = transcript.text.trim();
    if (!text) return;
    // The transcript is shown for confirmation rather than filed straight
    // away: an inspection report is a document someone acts on.
    pending = text;
    phase = "review";
    void stopMic();
    void draw();
  };

  const startMic = async (): Promise<void> => {
    const current = inspection();
    if (!current || phase !== "idle") return;

    stt = usesMockStt(data)
      ? createMockStt({ onTranscript, onStatus: (s) => { status = s; void draw(); } })
      : createWebSocketStt({
          url: data.sttUrl,
          ...(data.sttToken ? { token: data.sttToken } : {}),
          language: data.language,
          onTranscript,
          onStatus: (s) => { status = s; void draw(); },
        });

    await stt.start();
    const ok = await bridge.audioControl(true, AudioInputSource.Glasses).catch(() => false);
    if (!ok) {
      console.warn("[fieldlog] microphone was refused");
      await stt.stop();
      stt = null;
      return;
    }
    phase = "recording";
    await draw();
  };

  const stopMic = async (): Promise<void> => {
    await bridge.audioControl(false).catch(() => undefined);
    await stt?.stop();
    stt = null;
  };

  const keepPending = async (): Promise<void> => {
    const current = inspection();
    if (!current || pending === null) return;
    await persist(addEntry(current, pending, data.severity, Date.now()));
    pending = null;
    phase = "idle";
    await draw();
  };

  /**
   * Photos come from the phone camera, which the SDK exposes as a
   * user-initiated picker. The glasses have no camera.
   */
  const attachPhoto = async (): Promise<void> => {
    const current = inspection();
    if (!current) return;
    const asset = await bridge.captureImageFromCamera().catch(() => null);
    if (!asset?.base64) return;

    const dataUri = "data:" + (asset.mimeType || "image/jpeg") + ";base64," + asset.base64;
    await persist(attachToLatest(current, {
      dataUri,
      mimeType: asset.mimeType || "image/jpeg",
      size: asset.size || Math.round(asset.base64.length * 0.75),
    }));
    await draw();
  };

  await draw();

  bridge.onEvenHubEvent((event) => {
    const audio = (event as { audioEvent?: { audioPcm?: unknown } }).audioEvent;
    const pcm = audio?.audioPcm;
    if (phase === "recording" && pcm instanceof Uint8Array && pcm.length > 0) {
      stt?.send(pcm);
      return;
    }

    const gesture = gestureFromEvent(event, { invertScroll: data.invertScroll });
    if (!gesture) return;

    switch (gesture.gesture) {
      case "click":
        if (phase === "idle") { void startMic(); return; }
        if (phase === "recording") { phase = "transcribing"; void stopMic(); break; }
        if (phase === "review") { void keepPending(); return; }
        break;

      case "scrollUp":
      case "scrollDown":
        if (phase === "review") {
          // Discard rather than file a bad transcript.
          pending = null;
          phase = "idle";
          break;
        }
        // Otherwise cycle the severity applied to the next entry.
        {
          const index = SEVERITIES.indexOf(data.severity);
          const delta = gesture.gesture === "scrollDown" ? 1 : -1;
          const next = SEVERITIES[(index + delta + SEVERITIES.length) % SEVERITIES.length];
          if (next) { data = { ...data, severity: next }; void save(bridge, data); }
        }
        break;

      case "longPress":
        if (phase === "review" || phase === "idle") { void attachPhoto(); return; }
        break;

      case "doubleClick":
        void stopMic().then(() => bridge.shutDownPageContainer());
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

  setInterval(() => { void draw(); }, 10_000);

  mountPhoneUi({
    getData: () => data,
    setData: async (next) => {
      data = next;
      await save(bridge, next);
      await draw();
    },
  });
}

void boot().catch((error: unknown) => {
  console.error("[fieldlog] failed to start:", error);
});
