import { AudioInputSource, waitForEvenAppBridge, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { gestureFromEvent } from "./input/gestures";
import { lifecycleFromEvent } from "./lifecycle";
import { createExitRequest, settleRestore } from "./exit";
import { diag, flushDiag, startDiag } from "./diag/diag";
import { traceBridge } from "./diag/bridge";
import { createPage, forgetPage, updatePage } from "./glasses/page";
import { viewFor, type PageView, type Screen } from "./glasses/view";
import { mountPhoneUi, type PhoneUi, type Settings } from "./ui/phone";
import { copyText, diagFields, fmtBytes, glassesLinesB, rowsA, rowsB, summaryA, type ResultA, type ResultB } from "./probe/results";
import { runSpeechTest, type SpeechEnv } from "./probe/speech";
import { TestBRunner, type StageB } from "./probe/testb";
import { detectWebGpu, loadWhisper, netReport, transcribe } from "./probe/whisper";
import { VERSION } from "./version";

const SETTINGS_KEY = "speechprobe.settings";

function loadSettings(): Settings {
  const fallback: Settings = { lang: "de", model: "whisper-tiny", device: "wasm", wasm: "bundled" };  // WASM first: 41 MB instead of 122 MB on a phone
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null") as Partial<Settings> | null;
    if (!raw) return fallback;
    return {
      lang: raw.lang === "en" ? "en" : "de",
      model: raw.model === "whisper-base" ? "whisper-base" : "whisper-tiny",
      device: raw.device === "webgpu" || raw.device === "wasm" ? raw.device : "auto",
      wasm: raw.wasm === "cdn" ? "cdn" : "bundled",
    };
  } catch {
    return fallback;
  }
}

function saveSettings(settings: Settings): void {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* private mode: settings live for this run only */ }
}

async function boot(): Promise<void> {
  // Private step log (VITE_TRAFFIC_URL, tailnet only). Without it nothing is recorded or sent.
  startDiag((import.meta as { env?: Record<string, string | undefined> }).env?.["VITE_TRAFFIC_URL"] ?? "", VERSION);

  let settings = loadSettings();
  let resultA: ResultA | null = null;
  let resultB: ResultB | null = null;
  let runningA = false;
  let runningB = false;
  let bridge: EvenAppBridge | null = null;
  let runner: TestBRunner | null = null;

  // ---- glasses ---------------------------------------------------------------------------------
  let screen: Screen = { kind: "start", sel: 1 };
  let shown: PageView | null = null;
  let pageReady = false;
  let closed = false;
  let drawing: Promise<void> | null = null;
  let drawAgain = false;
  let exitAsked = (): boolean => false;
  /** 2× during a recording ends it early. */
  let cancelRecording = false;

  const currentView = (): PageView => viewFor(screen, { lang: settings.lang, model: settings.model });

  const drawOnce = async (): Promise<void> => {
    if (!bridge || closed || exitAsked()) return;
    const view = currentView();
    if (!pageReady) {
      const result = await createPage(bridge, view);
      diag("page", { ok: result.ok, reason: result.reason ?? null });
      if (!result.ok) return;
      pageReady = true;
      shown = view;
      return;
    }
    if (shown) {
      const result = await updatePage(bridge, view, shown);
      if (result.ok) shown = view;
      else { diag("update", { ok: false, reason: result.reason ?? null }); pageReady = false; }
    }
  };

  /** One page write at a time; a request during a write redraws once after it. */
  const draw = (): Promise<void> => {
    if (drawing) { drawAgain = true; return drawing; }
    drawing = (async () => {
      try { do { drawAgain = false; await drawOnce(); } while (drawAgain && !closed); } finally { drawing = null; }
    })();
    return drawing;
  };

  const show = (next: Screen): void => { screen = next; void draw(); };

  // ---- phone -----------------------------------------------------------------------------------
  const ui: PhoneUi = mountPhoneUi(document.getElementById("app") as HTMLElement, {
    settings,
    onSettings: (next) => { settings = next; saveSettings(next); void draw(); },
    startA: () => { void runA(); },
    startB: () => { void runB(); },
    promptSeen: (answer) => {
      if (!resultA) { ui.statusA("Run test A first."); return; }
      resultA = { ...resultA, promptSeen: answer };
      ui.tableA(rowsA(resultA));
      diag("testAPrompt", { promptSeen: answer });
      void flushDiag();
    },
    copyText: () => copyText(resultA, resultB, VERSION),
  });

  async function runA(): Promise<void> {
    if (runningA) return;
    runningA = true;
    ui.busyA(true);
    ui.statusA("Starting…");
    diag("testAStart", { lang: settings.lang });
    // If the host app has no speech/microphone usage description, iOS may kill it right here: log first.
    await flushDiag();
    try {
      resultA = await runSpeechTest(window as unknown as SpeechEnv, settings.lang, (stage) => ui.statusA(stage));
      ui.tableA(rowsA(resultA));
      ui.statusA(resultA.errors ? `Done with errors: ${resultA.errors}` : "Done. Did a permission prompt appear? Answer below.");
      diag("testA", diagFields(resultA));
      if (screen.kind === "infoA") show({ kind: "infoA", lastA: summaryA(resultA) });
    } catch (error) {
      ui.statusA(`Failed: ${String(error)}`);
      diag("testAError", { error: String(error) });
    } finally {
      runningA = false;
      ui.busyA(false);
      void flushDiag();
    }
  }

  const stageText = (stage: StageB): string => {
    switch (stage.kind) {
      case "recording": return `Recording… ${stage.secondsLeft} s left (${stage.chunks} chunks)`;
      case "loading": return stage.progress
        ? `Loading model ${stage.progress.percent}% (${fmtBytes(stage.progress.loaded)} / ${fmtBytes(stage.progress.total)})`
        : "Loading model…";
      case "transcribing": return `Transcribing ${stage.audioSeconds.toFixed(1)} s of audio…`;
    }
  };

  async function runB(): Promise<void> {
    if (runningB) return;
    if (!bridge || !runner) { ui.statusB("Glasses not connected yet (no Even app bridge)."); return; }
    runningB = true;
    cancelRecording = false;
    ui.busyB(true);
    diag("testBStart", { lang: settings.lang, model: settings.model, device: settings.device, wasm: settings.wasm });
    let lastLoadDraw = 0;
    try {
      const result = await runner.run({
        lang: settings.lang,
        model: settings.model,
        device: settings.device,
        wasm: settings.wasm,
        cancelled: () => cancelRecording || closed,
        onStage: (stage) => {
          ui.statusB(stageText(stage));
          // Leave the glasses alone if the user went back to the start screen meanwhile.
          if (stage.kind === "recording") {
            if (screen.kind === "start" || screen.kind === "result" || screen.kind === "recording") show({ kind: "recording", secondsLeft: stage.secondsLeft, chunks: stage.chunks });
          } else if (screen.kind === "recording" || screen.kind === "working") {
            // Progress lines at most once a second over Bluetooth.
            const now = Date.now();
            if (stage.kind === "loading" && stage.progress && now - lastLoadDraw < 1000) return;
            lastLoadDraw = now;
            show({ kind: "working", line: stageText(stage) });
          }
        },
      });
      resultB = result;
      ui.tableB(rowsB(result));
      ui.statusB(result.error ? `Failed at ${result.failedAt}: ${result.error}` : `Done: ${result.text || "(no text)"}`);
      diag("testB", diagFields(result));
      if (result.failedAt === "cancelled") show({ kind: "start", sel: 1 });
      else if (screen.kind === "working" || screen.kind === "recording") show({ kind: "result", ok: !result.error, lines: glassesLinesB(result) });
    } catch (error) {
      ui.statusB(`Failed: ${String(error)}`);
      diag("testBError", { error: String(error) });
    } finally {
      runningB = false;
      ui.busyB(false);
      void flushDiag();
    }
  }

  // ---- bridge ----------------------------------------------------------------------------------
  bridge = traceBridge(await waitForEvenAppBridge());
  const b = bridge;
  runner = new TestBRunner({
    audioControl: (open) => (open ? b.audioControl(true, AudioInputSource.Glasses) : b.audioControl(false)),
    detectWebGpu: () => detectWebGpu(),
    loadWhisper: (model, device, wasm, onProgress) => loadWhisper(model, device, wasm, onProgress),
    transcribe: (pipe, audio, lang) => transcribe(pipe as Parameters<typeof transcribe>[0], audio, lang),
    netReport,
    cacheApi: typeof caches !== "undefined",
    now: () => Date.now(),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  });

  const requestExit = createExitRequest(b, {
    onBack: () => {
      diag("onBack", {});
      if (closed) return;
      pageReady = false;
      forgetPage(b);
      return draw();
    },
  }, "speechprobe");
  exitAsked = requestExit.asked;

  const exitWithDialog = async (): Promise<void> => {
    diag("exitAsk", {});
    await requestExit();
  };

  const shutDown = (): void => {
    if (closed) return;
    closed = true;
    cancelRecording = true;
    void b.audioControl(false).catch(() => false);
    void flushDiag();
  };

  b.onEvenHubEvent((event) => {
    if (closed) return;
    // Microphone frames go to the recorder only; they say nothing about the user.
    if ((event as { audioEvent?: unknown }).audioEvent !== undefined) { runner?.feed(event); return; }
    const dialog = requestExit.onLifecycle(event);
    if (dialog !== null) { diag(dialog, {}); return; }
    const lifecycle = lifecycleFromEvent(event);
    if (lifecycle === "exit") { shutDown(); return; }
    if (lifecycle === "background") { cancelRecording = true; return; }
    requestExit.back();
    if (lifecycle === "foreground") { pageReady = false; void draw(); return; }

    const gesture = gestureFromEvent(event);
    if (!gesture) return;
    const g = gesture.gesture;
    switch (screen.kind) {
      case "start":
        if (g === "doubleClick") {
          const restore = drawing;
          void settleRestore(restore).then(exitWithDialog);
          return;
        }
        if (g === "scrollUp" || g === "scrollDown") show({ kind: "start", sel: screen.sel === 0 ? 1 : 0 });
        else if (g === "click") {
          if (screen.sel === 0) show({ kind: "infoA", lastA: resultA ? summaryA(resultA) : null });
          else if (!runningB) { show({ kind: "recording", secondsLeft: 5, chunks: 0 }); void runB(); }
        }
        return;
      case "infoA":
        if (g === "doubleClick" || g === "click") show({ kind: "start", sel: 0 });
        return;
      case "recording":
        if (g === "doubleClick") cancelRecording = true;
        return;
      case "working":
        if (g === "doubleClick") show({ kind: "start", sel: 1 });
        return;
      case "result":
        if (g === "doubleClick") show({ kind: "start", sel: 1 });
        else if (g === "click" && !runningB) { show({ kind: "recording", secondsLeft: 5, chunks: 0 }); void runB(); }
        return;
    }
  });

  b.onDeviceStatusChanged((status) => {
    if (status?.connectType === "connected" && !closed) { pageReady = false; void draw(); }
  });

  await draw();
}

void boot().catch((error: unknown) => {
  console.error("[speechprobe] failed to start:", error);
  diag("error", { msg: `boot: ${String(error)}` });
});
