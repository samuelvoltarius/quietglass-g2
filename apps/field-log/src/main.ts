import {
  AudioInputSource, waitForEvenAppBridge, type EvenAppBridge,
} from "@evenrealities/even_hub_sdk";
import { createMockStt, createWebSocketStt, type SttProvider, type SttStatus } from "./stt/provider";
import { addEntry, attachToLatest, startInspection, type Inspection, type Severity } from "./log/entries";
import { gestureFromEvent } from "./input/gestures";
import { buildView, type LogView, type Phase } from "./glasses/view";
import { sameView } from "./glasses/diff";
import { createPage, updatePage } from "./glasses/render";
import {
  activeInspection, hasSpeechServer, load, nextInspectionId, save, upsertInspection, usesMockStt, type FieldLogData,
} from "./storage/persist";
import { mountPhoneUi } from "./ui/phone";
import { createExitRequest } from "./exit";
import { getLocale, type Locale } from "./i18n";
import { autoTitle, quickNotes, t } from "./messages";

const SEVERITIES: readonly Severity[] = ["note", "minor", "major"];
const DEMO = new URLSearchParams(location.search).get("demo") === "1";
/**
 * How long to wait for the final transcript after the user taps stop. Servers
 * finish the utterance once the audio ends; one that never answers must not
 * leave the glasses on "Transcribing…" for good.
 */
const FINAL_WAIT_MS = 8_000;

async function boot(): Promise<void> {
  const bridge: EvenAppBridge = await waitForEvenAppBridge();

  let data: FieldLogData = await load(bridge);
  if (DEMO) {
    const now = Date.now(); let sample: Inspection = { ...startInspection("demo", "Hotel inspection", now - 1_380_000), section: "Room 204" };
    sample = addEntry(sample, "Window seal is damaged", "major", now - 480_000); sample = addEntry(sample, "Lamp flickers above desk", "minor", now - 180_000); sample = addEntry(sample, "Smoke detector tested", "note", now - 30_000);
    data = { ...data, inspections: [sample], activeId: sample.id };
  }
  let locale: Locale = getLocale();
  let phase: Phase = "idle";
  /** Highlighted quick note; the row after the last note is "Cancel". */
  let pickIndex = 0;
  let pending: string | null = null;
  let stt: SttProvider | null = null;
  let status: SttStatus = "idle";
  let lastView: LogView | null = null;
  let pageReady = false;
  /** Set once the user confirms the exit dialog; nothing may be drawn on a closed page. */
  let closed = false;
  /** True while the speech server and microphone are being opened. */
  let starting = false;
  let finalTimer: ReturnType<typeof setTimeout> | undefined;
  let drawing: Promise<void> | null = null;
  let redrawQueued = false;

  const inspection = (): Inspection | null => activeInspection(data);
  /**
   * Dictation needs a speech server. Without one, a tap offers quick notes
   * instead — the app is fully usable with no server at all. The labelled mock
   * recogniser is only used by the `?demo=1` preview.
   */
  const voice = (): boolean => hasSpeechServer(data) || DEMO;
  const notes = (): string[] => quickNotes(locale, data.quickNotes);

  const currentView = (): LogView =>
    buildView(inspection(), {
      phase,
      severity: data.severity,
      pending,
      status,
      mock: usesMockStt(data),
      locale,
      voice: voice(),
      quickNotes: notes(),
      pickIndex,
    });

  /** Set once the phone page is mounted; redraws it after a change made on the glasses. */
  let refreshPhone: () => void = () => undefined;

  const drawOnce = async (): Promise<void> => {
    const view = currentView();
    if (sameView(lastView, view)) return;

    const result = pageReady ? await updatePage(bridge, view) : await createPage(bridge, view);
    if (result.ok) { pageReady = true; lastView = view; return; }
    pageReady = false;
    lastView = null;
    console.warn("[fieldlog] draw failed:", result.reason);
  };

  /**
   * One draw at a time. The clock, gestures, the speech status and the phone
   * all request redraws; interleaving them would race two page creations or
   * let an older view land after a newer one. Requests made meanwhile
   * collapse into one redraw.
   */
  const draw = (): Promise<void> => {
    if (closed) return Promise.resolve();
    if (drawing) { redrawQueued = true; return drawing; }
    drawing = (async () => {
      try {
        do {
          redrawQueued = false;
          await drawOnce();
        } while (redrawQueued && !closed);
      } finally {
        drawing = null;
      }
    })();
    return drawing;
  };

  /** Logs a failed background task instead of leaving an unhandled rejection. */
  const background = (task: Promise<unknown>, what: string): void => {
    task.catch((error: unknown) => { console.warn("[fieldlog] " + what + " failed:", error); });
  };

  const persist = async (next: Inspection): Promise<void> => {
    data = upsertInspection(data, next);
    refreshPhone();
    await save(bridge, data);
  };

  /** A tap with no inspection open starts one, named after the date and time. */
  const startNew = async (): Promise<void> => {
    const id = nextInspectionId(data);
    const now = Date.now();
    data = { ...upsertInspection(data, startInspection(id, autoTitle(locale, now), now)), activeId: id };
    refreshPhone();
    await draw();
    await save(bridge, data);
  };

  /** Files the highlighted quick note, or leaves the list on "Cancel". */
  const pickNote = async (): Promise<void> => {
    const current = inspection();
    const note = notes()[pickIndex];
    phase = "idle";
    pickIndex = 0;
    if (current && note) await persist(addEntry(current, note, data.severity, Date.now()));
    await draw();
  };

  const closeStt = async (): Promise<void> => {
    clearTimeout(finalTimer);
    const provider = stt;
    stt = null;
    await provider?.stop();
  };

  const stopMic = async (): Promise<void> => {
    await bridge.audioControl(false).catch(() => undefined);
    await closeStt();
  };

  const onTranscript = (transcript: { text: string; final: boolean }): void => {
    if (!transcript.final || closed) return;
    // Only while dictating: a transcript arriving during review must not
    // replace the text the user is about to confirm.
    if (phase !== "recording" && phase !== "transcribing") return;
    const text = transcript.text.trim();
    if (!text) return;
    // The transcript is shown for confirmation rather than filed straight
    // away: an inspection report is a document someone acts on.
    const wasRecording = phase === "recording";
    pending = text;
    phase = "review";
    background(wasRecording ? stopMic() : closeStt(), "stopping dictation");
    void draw();
  };

  const startMic = async (): Promise<void> => {
    const current = inspection();
    // `starting` keeps a second tap during a slow connect from opening a
    // second socket and a second microphone session.
    if (!current || phase !== "idle" || starting || closed) return;
    starting = true;

    const onStatus = (s: SttStatus): void => { status = s; void draw(); };
    const provider = usesMockStt(data)
      ? createMockStt({ onTranscript, onStatus })
      : createWebSocketStt({
          url: data.sttUrl,
          ...(data.sttToken ? { token: data.sttToken } : {}),
          language: data.language,
          onTranscript,
          onStatus,
        });
    stt = provider;

    try {
      await provider.start();
      const ok = closed ? false : await bridge.audioControl(true, AudioInputSource.Glasses).catch(() => false);
      if (!ok || closed) {
        if (!closed) console.warn("[fieldlog] microphone was refused");
        // Left while the microphone was opening: it must not stay on.
        if (ok) await bridge.audioControl(false).catch(() => undefined);
        if (stt === provider) stt = null;
        await provider.stop();
        return;
      }
      phase = "recording";
    } catch (error) {
      console.warn("[fieldlog] speech server unavailable:", error);
      if (stt === provider) stt = null;
      await provider.stop().catch(() => undefined);
      // After stop(): it reports "idle", which would hide the error again.
      status = "error";
    } finally {
      starting = false;
    }
    await draw();
  };

  /**
   * Stop tapped: the microphone goes off at once, but the speech connection
   * stays open until the final transcript arrives — closing it right away
   * would throw away exactly the words just spoken.
   */
  const endRecording = async (): Promise<void> => {
    phase = "transcribing";
    clearTimeout(finalTimer);
    finalTimer = setTimeout(() => {
      if (phase !== "transcribing") return;
      phase = "idle";
      background(closeStt(), "closing the speech connection");
      void draw();
    }, FINAL_WAIT_MS);
    await bridge.audioControl(false).catch(() => undefined);
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
    if (!inspection()) return;
    const asset = await bridge.captureImageFromCamera().catch(() => null);
    // Read again: an entry may have been filed while the camera was open.
    let current = inspection();
    if (!asset?.base64 || !current) return;

    // With nothing to attach it to, the photo becomes an entry of its own.
    if (current.entries.length === 0) current = addEntry(current, t(locale, "photoOnly"), data.severity, Date.now());
    const dataUri = "data:" + (asset.mimeType || "image/jpeg") + ";base64," + asset.base64;
    await persist(attachToLatest(current, {
      dataUri,
      mimeType: asset.mimeType || "image/jpeg",
      size: asset.size || Math.round(asset.base64.length * 0.75),
    }));
    await draw();
  };

  await draw();

  let clock: ReturnType<typeof setInterval> | undefined;

  /** The microphone was paused for the exit dialog and comes back if the user stays. */
  let micPausedForExit = false;

  const requestExit = createExitRequest(bridge, {
    onConfirmed: async () => {
      closed = true;
      micPausedForExit = false;
      clearInterval(clock);
      await stopMic().catch((error: unknown) => { console.warn("[fieldlog] stopping the microphone failed:", error); });
    },
    onStayed: async () => {
      if (!micPausedForExit) return;
      micPausedForExit = false;
      if (phase !== "recording") return;
      // The speech connection stayed open, so the dictation simply continues.
      const ok = await bridge.audioControl(true, AudioInputSource.Glasses).catch(() => false);
      if (!ok) {
        console.warn("[fieldlog] microphone was refused");
        await endRecording();
        await draw();
      }
    },
  }, "fieldlog");

  /**
   * Double tap asks the system exit dialog. The microphone goes off before
   * the dialog appears, so nothing is heard while the user decides; cancelling
   * turns it back on and the dictation carries on.
   */
  const close = async (): Promise<void> => {
    if (closed) return;
    if (phase === "recording" && !micPausedForExit) {
      micPausedForExit = true;
      await bridge.audioControl(false).catch(() => undefined);
    }
    await requestExit();
  };

  bridge.onEvenHubEvent((event) => {
    if (closed) return;
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
        if (!inspection()) { background(startNew(), "starting an inspection"); return; }
        if (phase === "pick") { background(pickNote(), "saving the note"); return; }
        if (phase === "idle" && !voice()) { phase = "pick"; pickIndex = 0; break; }
        if (phase === "idle") { background(startMic(), "starting dictation"); return; }
        if (phase === "recording") { background(endRecording(), "stopping the microphone"); break; }
        if (phase === "review") { background(keepPending(), "saving the entry"); return; }
        break;

      case "scrollUp":
      case "scrollDown":
        if (phase === "pick") {
          const count = notes().length + 1;
          pickIndex = (pickIndex + (gesture.gesture === "scrollDown" ? 1 : -1) + count) % count;
          break;
        }
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
          if (next) {
            data = { ...data, severity: next };
            background(save(bridge, data), "saving the severity");
          }
        }
        break;

      case "longPress":
        if (phase === "idle") { background(attachPhoto(), "attaching a photo"); return; }
        // Under review the photo belongs to the text on screen: keep it first.
        if (phase === "review") {
          background(keepPending().then(attachPhoto), "attaching a photo");
          return;
        }
        break;

      case "doubleClick":
        void close();
        return;

      default:
        return;
    }
    void draw();
  });

  // The page does not survive a disconnect. The last view is forgotten too,
  // or an unchanged view would skip the rebuild and leave the display blank.
  bridge.onDeviceStatusChanged((deviceStatus) => {
    if (deviceStatus?.connectType === "connected") {
      pageReady = false;
      lastView = null;
      void draw();
    }
  });

  clock = setInterval(() => { void draw(); }, 10_000);

  const phone = mountPhoneUi({
    getData: () => data,
    setData: async (next) => {
      data = next;
      // Quick notes or the server may have changed under an open list.
      if (phase === "pick" && voice()) phase = "idle";
      pickIndex = Math.min(pickIndex, notes().length);
      await save(bridge, next);
      await draw();
    },
    locale: () => locale,
    onLocaleChange: (next) => {
      locale = next;
      void draw();
    },
    takePhoto: () => attachPhoto(),
  });
  refreshPhone = phone.refresh;
}

void boot().catch((error: unknown) => {
  console.error("[fieldlog] failed to start:", error);
});
