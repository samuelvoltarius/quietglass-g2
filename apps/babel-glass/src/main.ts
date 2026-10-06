import {
  AudioInputSource, waitForEvenAppBridge, type EvenAppBridge,
} from "@evenrealities/even_hub_sdk";
import {
  createMockStt, createWebSocketStt, type SttProvider, type SttStatus, type Transcript,
} from "./stt/provider";
import { createPassthroughTranslator, type TranslationProvider } from "./translate/provider";
import { selectTranslator, translationRequestFor } from "./translate/select";
import {
  applyTranscript, applyTranslation, clearBuffer, createBuffer, type CaptionBuffer,
} from "./captions/buffer";
import { gestureFromEvent } from "./input/gestures";
import { buildView, MODE_PRESETS, type CaptionView } from "./glasses/view";
import { sameView } from "./glasses/diff";
import { createPage, updatePage } from "./glasses/render";
import {
  load, save, translationEnabled, usesMockStt, type BabelData,
} from "./storage/persist";
import { mountPhoneUi } from "./ui/phone";

async function boot(): Promise<void> {
  const bridge: EvenAppBridge = await waitForEvenAppBridge();

  let data: BabelData = await load(bridge);
  let buffer: CaptionBuffer = createBuffer();
  let stt: SttProvider | null = null;
  let translator: TranslationProvider = createPassthroughTranslator();
  let status: SttStatus = "idle";
  let listening = false;
  let offset = 0;
  let lastView: CaptionView | null = null;
  let pageReady = false;
  let translateError: string | null = null;

  const currentView = (): CaptionView =>
    buildView(buffer, {
      mode: data.mode,
      listening,
      status,
      translating: translationEnabled(data),
      offset,
      mock: usesMockStt(data),
      transliterateOriginal: data.transliterateOriginal,
      sourceLanguage: data.sourceLanguage,
      translateError,
    });

  const draw = async (): Promise<void> => {
    const view = currentView();
    if (sameView(lastView, view)) return;

    const result = pageReady ? await updatePage(bridge, view) : await createPage(bridge, view);
    if (result.ok) {
      pageReady = true;
      lastView = view;
      return;
    }
    pageReady = false;
    console.warn("[babelglass] draw failed:", result.reason);
  };

  const buildTranslator = (): TranslationProvider => selectTranslator(data);

  const translateLine = (text: string, detected: string | undefined): void => {
    if (!translationEnabled(data)) return;
    const request = translationRequestFor(data, translator, text, detected);
    // Already in the target language: nothing to translate, show as is.
    if (!request) return;
    void translator.translate(request).then((result) => {
      if (result.error) {
        translateError = result.error;
        console.warn("[babelglass] translation failed:", result.error);
        void draw();
        return;
      }
      translateError = null;
      if (result.text) buffer = applyTranslation(buffer, text, result.text);
      void draw();
    });
  };

  const onTranscript = (transcript: Transcript): void => {
    buffer = applyTranscript(buffer, transcript, Date.now());
    // New speech pulls the view back to the live edge; reading history while
    // someone is talking is not what the user meant to do.
    if (transcript.final) {
      offset = 0;
      translateLine(transcript.text.trim(), transcript.language);
    }
    void draw();
  };

  /**
   * Captioning never starts on its own: the microphone opens only after an
   * explicit tap, and MIC stays on screen for as long as it is open.
   */
  const startListening = async (): Promise<void> => {
    if (listening) return;

    translator = buildTranslator();
    translateError = null;
    stt = usesMockStt(data)
      ? createMockStt({ onTranscript, onStatus: (s) => { status = s; void draw(); } })
      : createWebSocketStt({
          url: data.sttUrl,
          ...(data.sttToken ? { token: data.sttToken } : {}),
          language: data.sourceLanguage,
          onTranscript,
          onStatus: (s) => { status = s; void draw(); },
        });

    await stt.start();

    const ok = await bridge.audioControl(true, AudioInputSource.Glasses).catch(() => false);
    if (!ok) {
      console.warn("[babelglass] microphone was refused");
      await stt.stop();
      stt = null;
      return;
    }
    listening = true;
    await draw();
  };

  const stopListening = async (): Promise<void> => {
    if (!listening) return;
    await bridge.audioControl(false).catch(() => undefined);
    await stt?.stop();
    stt = null;
    listening = false;
    status = "idle";
    await draw();
  };

  await draw();

  bridge.onEvenHubEvent((event) => {
    const audio = (event as { audioEvent?: { audioPcm?: unknown } }).audioEvent;
    const pcm = audio?.audioPcm;
    if (listening && pcm instanceof Uint8Array && pcm.length > 0) {
      stt?.send(pcm);
      return;
    }

    const gesture = gestureFromEvent(event, { invertScroll: data.invertScroll });
    if (!gesture) return;

    const rows = MODE_PRESETS[data.mode].rows;

    switch (gesture.gesture) {
      case "click":
        void (listening ? stopListening() : startListening());
        return;
      case "scrollUp":
        offset = Math.min(offset + rows, 200);
        break;
      case "scrollDown":
        offset = Math.max(0, offset - rows);
        break;
      case "longPress":
        buffer = clearBuffer();
        offset = 0;
        break;
      case "doubleClick":
        void stopListening().then(() => bridge.shutDownPageContainer());
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
      const previous = data;
      data = next;
      await save(bridge, next);
      translator = buildTranslator();
      translateError = null;
      // The recogniser receives its language once, in the start frame, so a
      // changed server or language only takes effect on a fresh connection.
      if (listening && sttSettingsChanged(previous, next)) {
        await stopListening();
        await startListening();
        return;
      }
      await draw();
    },
  });
}

function sttSettingsChanged(a: BabelData, b: BabelData): boolean {
  return a.sttUrl !== b.sttUrl || a.sttToken !== b.sttToken || a.sourceLanguage !== b.sourceLanguage;
}

void boot().catch((error: unknown) => {
  console.error("[babelglass] failed to start:", error);
});
