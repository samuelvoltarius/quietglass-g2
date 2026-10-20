import { AppLocationAccuracy, AudioInputSource, waitForEvenAppBridge, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { settleRestore } from "./exit";
import { createClient, ApiError, classifyError, insecureServer, serverHost, type LinkProblem } from "./api/client";
import { emptyReport } from "./api/empty";
import { createDemoApi, DEMO_SCENES, type DemoScene } from "./api/demo";
import type { HubApi } from "./api/types";
import { rememberLocale, resolveLocale, setLocale, type Locale } from "./i18n";
import { tr } from "./i18n";
import { messages } from "./messages";
import { gestureFromEvent, menuItemIdFromEvent, type Gesture, type InputSource } from "./input/gestures";
import { applyMenu, buildView, createModel, decide, linkBlocks, menuFor, mergeReport, MESSAGE_MS, ROOT_ITEMS, selectedAgent, withBrief, withLink, withLiveText, withHomePending, withSessions, withVoiceFailed, withVoiceHeard, type Effect, type HubModel, type Screen } from "./hub/model";
import { morningStart } from "./hub/brief";
import { createLocator } from "./hub/place";
import { initialLivePoll, isOlder, noteLongFailure, noteReport, planPoll } from "./api/live-poll";
import { buildLiveSttUrl, chooseVoicePath, startLiveStt, type LiveSttSession } from "./stt/live-stt";
import { hubGesture, startScreen } from "./hub/entry";
import { sameView } from "./glasses/diff";
import { COCKPIT_TILES, createCockpitPage, createPage, guardedTileSend, rebuildCockpitPage, rebuildPage, updatePage } from "./glasses/render";
import { cockpitModel } from "./cockpit/model";
import { composeCockpit } from "./cockpit/compose";
import { createTileSender } from "./screen/sender";
import { autoBackend, type TextBackend } from "./screen/text";
import { pixelIconFor } from "./glasses/icons";
import { MASCOT_STEP_MS } from "./glasses/mascot";
import { BLANK_ICON, isQuiet, QUIET_VIEW, quietGesture, wake } from "./hub/quiet";
import type { ScreenView } from "./glasses/screen";
import { buildWav } from "./audio/wav";
import { MicGuard, type MicStart } from "./audio/mic-guard";
import { mountPhoneUi, type ConnView, type SettingsResult } from "./ui/phone";
import { loadSettings, saveSettings } from "./setup/settings";
import { decodeQr, parseSetupQr } from "./setup/qr";
import { createBrowserSpeechEngine, createServerSpeechEngine, HubNarrator } from "./speech/narrator";
import { buildTtsUrl, DEFAULT_VOICES, ServerTts } from "./speech/server-tts";

const DEMO = new URLSearchParams(globalThis.location?.search ?? "").get("demo") === "1";
const sceneParam = new URLSearchParams(globalThis.location?.search ?? "").get("scene");
const DEMO_SCENE: DemoScene = DEMO_SCENES.find((scene) => scene === sceneParam) ?? "default";
const BUILD = "0.10.0";
/** Wait before the next automatic try while the hub is unreachable: 2, 5, 10, then every 30 s. */
export const BACKOFF_MS = [2000, 5000, 10_000, 30_000] as const;
/** A voice note is cut off here and sent (10 min dictation); also guards against a lost "release" event. */
export const MAX_RECORD_MS = 600_000;
/** Less audio than this is a mis-press (16 kHz, 16 bit, mono = 32 bytes per ms). */
const MIN_RECORD_BYTES = 32 * 400;

async function boot(): Promise<void> {
  console.info(`[quiethub] v${BUILD} boot`);
  const bridge: EvenAppBridge = await waitForEvenAppBridge();

  // `?lang=de|en` overrides the device language — the simulator webview has
  // no useful locale of its own, and screenshots want a deterministic one.
  const params = new URLSearchParams(globalThis.location?.search ?? "");
  const setup = new URLSearchParams(globalThis.location?.hash?.replace(/^#/, "") ?? "");
  const forced = params.get("lang") ?? setup.get("lang");
  if (forced === "de" || forced === "en") setLocale(forced);
  let locale: Locale = forced === "de" || forced === "en" ? forced : await resolveLocale(bridge);
  setLocale(locale);
  let settings = await loadSettings(bridge);
  // `?server=` points at the daemon without going through the phone page —
  // used by the simulator and for testing the real Hermes bridge.
  const forcedServer = setup.get("server") ?? params.get("server");
  const forcedToken = setup.get("token");
  if (forcedServer !== null && forcedServer !== "") {
    settings = { ...settings, serverUrl: forcedServer, token: forcedToken ?? settings.token };
    void saveSettings(bridge, settings);
    // Remove credentials from the visible URL after the one-time QR setup.
    try {
      globalThis.history?.replaceState?.(null, "", `${globalThis.location?.pathname ?? "/"}${globalThis.location?.search ?? ""}`);
    } catch {
      // Some host WebViews do not permit history mutation; setup still worked.
    }
  }
  const finishParam = Number(params.get("finish") ?? "");
  // The phone's position for the Tagesstart weather: rounded to ~1 km, cached 30 min,
  // never waited for longer than 4 s (then the daemon's default place is used).
  const locator = createLocator({
    getLocation: typeof (bridge as Partial<EvenAppBridge>).getAppLocation === "function"
      ? () => bridge.getAppLocation({ accuracy: AppLocationAccuracy.Medium, timeoutMs: 3_500 })
      : undefined,
  });
  // QIS v1.2 #7: without a server the first start is the demo (hint "Demo · Verbindung am Handy einrichten").
  // `?demo=1` is the same demo without the hint (simulator, screenshots).
  const unconfigured = (): boolean => settings.serverUrl.trim() === "";
  let demoMode = DEMO || unconfigured();
  const demoApi = (): HubApi => createDemoApi(locale, DEMO ? DEMO_SCENE : "default", DEMO && Number.isFinite(finishParam) && finishParam > 0 ? finishParam * 1000 : null);
  let api: HubApi = demoMode ? demoApi() : createClient({ baseUrl: settings.serverUrl, token: settings.token });

  // ---- connection state: real data or an honest reason; demo data only while no server is set ----
  const conn = { lastOkAt: null as number | null, lastProblem: null as LinkProblem | "missing" | null, lastAt: null as number | null, raw: "" as string, fails: 0, hadData: demoMode };
  const problemFor = (error: unknown): LinkProblem | "missing" => {
    if (settings.serverUrl.trim() === "") return "missing";
    if (insecureServer(settings.serverUrl, globalThis.location?.protocol)) return "insecure";
    return classifyError(error);
  };
  let model: HubModel = createModel(emptyReport(DEMO ? "demo" : "missing"));
  const markFailure = (error: unknown): void => {
    const problem = problemFor(error);
    conn.fails += 1;
    conn.lastProblem = problem;
    conn.lastAt = Date.now();
    conn.raw = rawText(error);
    model = withLink(model, { problem, host: serverHost(settings.serverUrl), fails: conn.fails, hadData: conn.hadData });
  };
  const markOk = (): void => {
    conn.lastOkAt = Date.now();
    conn.lastProblem = null;
    conn.fails = 0;
    conn.hadData = true;
  };
  if (demoMode) {
    model = { ...createModel(await api.report()), setupHint: !DEMO };
  } else if (problemFor(null) !== "error") {
    // No server, or an http:// server that an https page may not call (mixed content): do not even try.
    markFailure(null);
  } else {
    // No network wait before the gesture handler exists (a slow daemon made the
    // glasses deaf and black for up to 8 s): draw "connecting", the first poll
    // after the handlers fetches the report.
    model = createModel(emptyReport("loading"));
  }
  // `?quiet=1` switches quiet mode on for this run only (simulator screenshots).
  model = { ...model, quietWhileWorking: settings.quietWhileWorking || params.get("quiet") === "1" };
  const savedUi = await loadUiState(bridge);
  let launchSource: "appMenu" | "glassesMenu" | null = null;
  if (savedUi !== null) model = { ...model, screen: startScreen(null, savedUi.screen), rootSelected: Math.max(0, Math.min(savedUi.rootSelected ?? 0, ROOT_ITEMS.length - 1)) };
  // "Tagesstart als Startseite bis 11:00": in the morning every start lands on the briefing.
  if (morningStart(settings.briefMorning === true, new Date())) model = { ...model, screen: "brief", briefPage: 0, briefLoad: "loading" };
  let lastView: ScreenView | null = null;
  let menuKey = "";
  let pageCreated = false;
  let drawing: Promise<void> | null = null;
  let redrawQueued = false;
  let refreshPhone: () => void = () => undefined;
  let closed = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let fast = false;
  let newestEventId: string | null = model.report.inbox.events[0]?.id ?? null;
  // The first report is what was there at start, not news: it must not auto-open a page.
  let firstReport = !demoMode;
  // Spoken answers on the phone (AirPods / headphones), opt-in on the phone page.
  // Piper server voice (private build: VITE_TTS_URL), browser voice as fallback.
  const serverTts = new ServerTts({ url: buildTtsUrl(), voices: DEFAULT_VOICES });
  const narrator = new HubNarrator(createServerSpeechEngine(createBrowserSpeechEngine(), serverTts), () => settings.speakAnswers, () => locale);
  // ---- report updates: long-poll when the daemon offers it, plain polling otherwise ----
  let livePoll = initialLivePoll();
  /** Bumped when the server changes: answers of requests to the old one are dropped. */
  let pollGen = 0;
  /** A poll request is on its way (a long-poll may be held by the daemon for 25 s). */
  let pollBusy = false;
  const schedulePoll = (ms: number): void => {
    if (pollTimer !== null) clearTimeout(pollTimer);
    pollTimer = setTimeout(() => { pollTimer = null; void poll(); }, ms);
  };
  const nextPollMs = (): number => planPoll(livePoll, fast, Date.now()).delayMs;
  const applyReport = (report: Awaited<ReturnType<HubApi["report"]>>, viaLong = false): void => {
    livePoll = noteReport(livePoll, report, viaLong);
    markOk();
    const wasBusy = new Set(model.report.agents.filter((agent) => agent.busy).map((agent) => agent.id));
    model = mergeReport(model, report);
    // An agent just finished with an answer: the face smiles for a few seconds.
    if (report.agents.some((agent) => wasBusy.has(agent.id) && !agent.busy && (agent.answer ?? "") !== "" && agent.error === null)) {
      model = { ...model, cheerUntil: Date.now() + 4000 };
    }
    narrator.observe(selectedAgent(model), model.report.approvals);
  };

  // ---- microphone (voice notes) ------------------------------------------
  const micChunks: Uint8Array[] = [];
  // Live STT (private build: VITE_LIVE_STT_URL): the transcript grows on the glasses while
  // the wearer speaks. The PCM is kept in micChunks anyway: WAV upload is the fallback.
  const liveSttUrl = DEMO ? "" : buildLiveSttUrl();
  let liveStt: LiveSttSession | null = null;
  const stopLiveStt = (): void => {
    liveStt?.cancel();
    liveStt = null;
  };
  const MIC_DRAIN_MS = 150;

  /**
   * audioPcm arrives as Uint8Array, number[] or base64 depending on the host
   * bridge — normalize it or every chunk is silently dropped and the recording
   * comes out empty (claude-code-g2, g2-channels).
   */
  const toBytes = (pcm: unknown): Uint8Array | null => {
    if (pcm instanceof Uint8Array) return pcm;
    if (Array.isArray(pcm)) return Uint8Array.from(pcm as number[]);
    if (typeof pcm === "string") {
      try {
        const bin = atob(pcm);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
        return out;
      } catch {
        return null;
      }
    }
    return null;
  };

  // The guard closes the two ways the mic used to stay open: a release before the
  // mic answered (late "on" is switched off again) and a missing release (hard limit).
  const mic = new MicGuard({
    control: (on) => (on ? bridge.audioControl(true, AudioInputSource.Glasses) : bridge.audioControl(false)),
    maxMs: MAX_RECORD_MS,
    onLimit: () => {
      if (!model.recording) return;
      model = { ...model, message: { text: tr(messages, locale, "voice.limit", { m: MAX_RECORD_MS / 60_000 }), until: Date.now() + MESSAGE_MS } };
      onGesture("longPressRelease");
    },
  });
  let micDraining = false;

  const startMic = async (): Promise<MicStart> => {
    micChunks.length = 0;
    const started = await mic.start();
    if (started === "refused") console.warn("[quiethub] microphone refused");
    if (started === "cancelled") console.info("[quiethub] hold released before the mic was on: mic switched off again");
    return started;
  };

  const stopMic = async (): Promise<void> => {
    micDraining = true;
    await mic.stop();
    // In-flight blocks still arrive after the off-switch; without the drain the
    // recording loses its tail (drain rule).
    await new Promise((resolve) => setTimeout(resolve, MIC_DRAIN_MS));
    micDraining = false;
  };

  let lastIconShown = "";
  // While the exit dialog may be on screen (asked, no input since) no timer, poll or stream may draw: a page call
  // could cover it. Data keeps being collected; the back signal restores the page the way of the first one.
  let exitDialogAsked = false;
  // The system dialog's own lifecycle (step log, Klipper 0.5.11): right after shutDownPageContainer(1) the glasses
  // send FOREGROUND_ENTER (4) when the dialog comes up and FOREGROUND_EXIT (5) when it goes away after "No".
  let dialogPending = false;
  let dialogShown = false;
  /** Which kind of page the glasses carry: text containers (+ the face) or the cockpit's four image tiles. */
  let installed: "text" | "cockpit" | null = null;
  let textBackend: TextBackend | null = null;
  /** The cockpit is one 576 x 288 frame; only the tiles whose pixels changed cross Bluetooth. Never while the exit dialog may be up. */
  const tiles = createTileSender(COCKPIT_TILES, guardedTileSend(bridge, () => !exitDialogAsked && !closed && installed === "cockpit"));
  /** Nothing on the glasses can be trusted (reconnect, foreground): the next draw writes everything again. */
  const forgetShown = (): void => { lastView = null; tiles.reset(); };
  /** The cockpit image replaces the text page only when nothing else (help, picker, a broken link) owns the screen. */
  const cockpitShown = (): boolean => model.screen === "cockpit" && !model.help && model.picker === null && !linkBlocks(model.link);
  const drawOnce = async (): Promise<void> => {
    if (exitDialogAsked) return;
    const now = Date.now();
    const menu = menuFor(model, locale);
    if (cockpitShown()) {
      if (!pageCreated || installed !== "cockpit" || menu.key !== menuKey) {
        const result = pageCreated ? await rebuildCockpitPage(bridge, menu) : await createCockpitPage(bridge, menu);
        if (!result.ok) { console.warn("[quiethub] cockpit page failed:", result.reason); return; }
        pageCreated = true;
        installed = "cockpit";
        menuKey = menu.key;
        lastView = null;
        lastIconShown = "";
        // A new page starts with blank images.
        tiles.reset();
      }
      textBackend ??= autoBackend();
      // Never awaited: a slow transfer must not hold up the next gesture.
      void tiles.push(composeCockpit(cockpitModel(model, locale, now), textBackend, now));
      return;
    }
    // Quiet while the agent works: empty text at brightness 0/1 and a black (= transparent) face, all in place.
    const quiet = isQuiet(model, now);
    const view = quiet ? QUIET_VIEW : buildView(model, locale, now);
    const icon = quiet ? BLANK_ICON : pixelIconFor(model, now);
    if (installed === "text" && sameView(lastView, view) && menu.key === menuKey && icon.join("/") === lastIconShown) return;
    lastIconShown = icon.join("/");
    let result;
    if (!pageCreated) {
      result = await createPage(bridge, view, icon, menu);
      if (result.ok) menuKey = menu.key;
    } else if (menu.key !== menuKey || installed !== "text") {
      // Another page kind (the cockpit was up) or another menu: the only reasons to rebuild. menuObject is re-supplied.
      menuKey = menu.key;
      result = await rebuildPage(bridge, view, icon, menu);
      if (!result.ok) {
        console.warn("[quiethub] page rebuild failed:", result.reason);
        result = installed === "text" ? await updatePage(bridge, view, icon, lastView) : result;
      }
    } else {
      result = await updatePage(bridge, view, icon, lastView);
    }
    if (result.ok) {
      pageCreated = true;
      installed = "text";
      lastView = view;
      return;
    }
    lastView = null;
    console.warn("[quiethub] draw failed:", result.reason);
  };

  /** One draw at a time; requests made meanwhile collapse into one redraw. */
  const draw = (): Promise<void> => {
    if (exitDialogAsked) return Promise.resolve();
    if (drawing !== null) {
      redrawQueued = true;
      return drawing;
    }
    drawing = drawOnce()
      .catch((error: unknown) => console.warn("[quiethub] draw error:", error))
      .finally(() => {
        drawing = null;
        if (redrawQueued) {
          redrawQueued = false;
          void draw();
        }
      });
    return drawing;
  };

  // While the agent on the glasses works, redraw once a second: the dots move and
  // the elapsed time counts up. textContainerUpgrade is cheap and sameView skips no-ops.
  // The face blinks and looks around, the working line counts up: redraw twice a
  // second on the pages that show them. Unchanged frames cost nothing (see drawOnce).
  setInterval(() => {
    if (closed || (model.screen !== "agent" && model.screen !== "root" && model.screen !== "cockpit")) return;
    // Quiet and already drawn quiet: the face animation is paused, nothing to compute or send.
    if (lastView?.dim === true && isQuiet(model, Date.now())) return;
    void draw();
  }, MASCOT_STEP_MS);

  // ---- data --------------------------------------------------------------
  const poll = async (): Promise<void> => {
    if (closed || pollBusy) return;
    if (!demoMode && problemFor(null) !== "error") {
      // Nothing to poll (no server / insecure URL); saving new settings triggers a poll.
      markFailure(null);
      await draw();
      refreshPhone();
      return;
    }
    const gen = pollGen;
    const plan = planPoll(livePoll, fast, Date.now());
    const viaLong = plan.mode === "long" && api.reportAfter !== undefined;
    pollBusy = true;
    try {
      const report = viaLong && plan.mode === "long" ? await api.reportAfter!(plan.cursor, plan.waitS) : await api.report();
      if (gen === pollGen) pollBusy = false;
      // Settings changed meanwhile: this answer is from the old server.
      if (gen !== pollGen || closed) return;
      // A held answer overtaken by a newer report (fetched right after a tap): just ask again.
      if (viaLong && isOlder(report, livePoll.cursor)) { schedulePoll(nextPollMs()); return; }
      const nextId = report.inbox.events[0]?.id ?? null;
      const isNew = !firstReport && nextId !== null && nextId !== newestEventId;
      const newCard = !firstReport && report.approvals.length > 0 && model.report.approvals.length === 0;
      firstReport = false;
      newestEventId = nextId;
      applyReport(report, viaLong);
      // A permission card must be answered, so it opens the agent page. A plain
      // "done" notice never pulls the wearer out of a page they are working in:
      // it only opens from the overview (it is waiting in Meldungen otherwise).
      if (newCard && settings.autoOpenNotifications && !model.recording) {
        // After the decision the wearer sees that agent's conversation; 2× is back at the overview.
        const cardAgent = model.report.agents.findIndex((agent) => agent.id === report.approvals[0]?.agentId);
        model = cardAgent >= 0
          ? { ...model, screen: "agent", agentView: "ask", agentIndex: cardAgent, chatScroll: 0, questionIndex: 0, origin: "inbox", cardIndex: 0, confirm: null }
          : { ...model, screen: "agent", agentView: "list", cardIndex: 0, confirm: null };
      } else if (isNew && settings.autoOpenNotifications && !model.recording && model.screen === "root") {
        model = { ...model, screen: "inbox", confirm: null };
      }
      // An alert arrives while the display is quiet: show it (and the working agent) for a while.
      if (isNew) model = wake(model, Date.now());
      fast = report.approvals.length > 0 || report.agents.some((agent) => agent.busy);
    } catch (error) {
      if (gen === pollGen) pollBusy = false;
      if (gen !== pollGen || closed) return;
      if (viaLong) {
        // A held request may be cut by a proxy or the WebView: a plain report decides whether the hub is really gone.
        livePoll = noteLongFailure(livePoll, Date.now());
        console.warn("[quiethub] long-poll failed, plain report next:", rawText(error));
        schedulePoll(nextPollMs());
        return;
      }
      if (!(error instanceof ApiError)) console.warn("[quiethub] poll failed:", error);
      markFailure(error);
      await draw();
      refreshPhone();
      schedulePoll(BACKOFF_MS[Math.min(conn.fails - 1, BACKOFF_MS.length - 1)] ?? 30_000);
      return;
    }
    await draw();
    refreshPhone();
    schedulePoll(nextPollMs());
  };

  /** The restore started by the last exitBack(), while it is still running. */
  let restoring: Promise<void> | null = null;
  const exitBack = (): void => {
    if (!exitDialogAsked) return;
    exitDialogAsked = false;
    if (closed) return;
    // The dialog takes the page away and a plain rebuild no longer reaches it (store review 16.10.2026):
    // put the page up again the way of the first one (rebuild + create), so input (and the next 2×) reaches the app.
    pageCreated = false;
    installed = null;
    lastView = null;
    menuKey = "";
    lastIconShown = "";
    const run = draw().catch(() => undefined);
    restoring = run;
    void run.then(() => { if (restoring === run) restoring = null; });
  };

  const runEffect = async (effect: Effect | undefined): Promise<void> => {
    if (effect === undefined) return;
    try {
      if (effect.kind === "recordStart") {
        stopLiveStt();
        if (liveSttUrl !== "") {
          // Opens while the mic switches on; PCM that comes first is held until the socket is open.
          liveStt = startLiveStt({
            url: liveSttUrl,
            language: locale,
            // The 500 ms face tick redraws the listening page; unchanged text costs nothing.
            onText: (text) => { model = withLiveText(model, text); },
          });
        }
        // "cancelled": the hold was released meanwhile - the release already handles the rest.
        if ((await startMic()) === "refused") {
          stopLiveStt();
          // Say why nothing is happening instead of a silent dead microphone.
          model = { ...model, recording: false, recordAgent: null, message: { text: tr(messages, locale, "voice.mic"), until: Date.now() + MESSAGE_MS } };
          await draw();
          refreshPhone();
        }
        return;
      }
      if (effect.kind === "recordAbort") {
        stopLiveStt();
        await stopMic();
        micChunks.length = 0;
        await draw();
        refreshPhone();
        return;
      }
      if (effect.kind === "loadSessions") {
        try {
          const list = await api.sessions(effect.agentId);
          model = withSessions(model, effect.agentId, { status: list.supported ? "ready" : "unsupported", items: list.sessions, transport: list.transport });
        } catch {
          model = withSessions(model, effect.agentId, { status: "error", items: [], transport: "" });
        }
        await draw();
        refreshPhone();
        return;
      }
      if (effect.kind === "quietSetting") {
        settings = { ...settings, quietWhileWorking: effect.on };
        const saved = await saveSettings(bridge, settings);
        if (!saved.persisted) console.warn("[quiethub] quiet setting was not persisted");
        refreshPhone();
        return;
      }
      if (effect.kind === "brief") {
        // Its own request: the daemon answers from its ~2 min cache unless the wearer tapped "reload".
        if (api.brief === undefined) {
          model = withBrief(model, null, "unsupported", locale);
        } else {
          try {
            const place = await locator.locate();
            refreshPhone();
            model = withBrief(model, await api.brief(effect.refresh, place), "ready", locale);
          } catch (error) {
            const old = error instanceof ApiError && error.status === 404;
            model = withBrief(model, null, old ? "unsupported" : "error", locale);
            if (!old) console.warn("[quiethub] brief failed:", rawText(error));
          }
        }
        await draw();
        refreshPhone();
        return;
      }
      if (effect.kind === "exit") {
        // Required by Even QA on the root page. Do not clean up here: the call resolves when the dialog is
        // SHOWN (hardware: ~58 ms after the double tap), not when the user answered. Cleanup happens only on
        // SYSTEM/ABNORMAL_EXIT below. A second double tap before any restore: page back first, then ask again.
        exitBack();
        // The first double tap after "No" is the back signal itself: a dialog call issued while the page is still
        // being created is lost (hardware, Klipper 0.5.8). So wait for the restore and a short settle delay.
        if (restoring) await settleRestore(restoring);
        dialogPending = true;
        try {
          await bridge.shutDownPageContainer(1);
        } catch (error) {
          console.warn("[quiethub] exit failed:", rawText(error));
        }
        // No redraw now: the dialog may still be on screen and a page call could cover it. On the next input
        // (or FOREGROUND_ENTER) the page is put up again the way of the first one (exitBack).
        exitDialogAsked = true;
        return;
      }
      if (effect.kind === "recordStop") {
        await stopMic();
        const fail = (key: string): void => { model = withVoiceFailed(model, tr(messages, locale, key), Date.now()); };
        const session = liveStt;
        liveStt = null;
        const live = session === null ? { ok: false, text: "" } : await session.finish();
        const wav = buildWav(micChunks);
        if (chooseVoicePath(live) === "live") {
          // The wearer already read it while speaking: straight to the confirm step, no upload, no second pass.
          micChunks.length = 0;
          try {
            if (settings.voiceAutoSend) await api.ask(live.text, effect.agentId);
            model = withVoiceHeard(model, effect.agentId, live.text, settings.voiceAutoSend, Date.now(), locale);
          } catch (error) {
            const status = error instanceof ApiError ? error.status : undefined;
            fail(status === 503 ? "agent.offline" : status === 409 ? "agent.busy" : "voice.failed");
            console.warn("[quiethub] live voice ask failed:", error);
          }
        } else if (wav.length <= 44) {
          fail("voice.empty");
        } else if (wav.length - 44 < MIN_RECORD_BYTES) {
          fail("voice.short");
        } else {
          try {
            const heard = await api.voice(wav, effect.agentId, settings.voiceAutoSend);
            // An older daemon asks right away (accepted, no `asked` flag): then there is nothing to confirm.
            const asked = heard.asked === true || (heard.asked === undefined && heard.accepted === true);
            model = withVoiceHeard(model, effect.agentId, heard.question, asked, Date.now(), locale);
          } catch (error) {
            // Each failure gets its own words: the wearer must know what to fix.
            const status = error instanceof ApiError ? error.status : undefined;
            fail(status === 502 ? "voice.stt" : status === 422 ? "voice.unclear" : status === 503 ? "agent.offline" : status === 409 ? "agent.busy" : status === undefined ? "voice.stt" : "voice.failed");
            console.warn("[quiethub] voice failed:", error);
          }
        }
      } else if (effect.kind === "ask") {
        await api.ask(effect.question, effect.agentId);
      } else if (effect.kind === "approve") {
        await api.approve(effect.cardId, effect.decision, effect.note);
      } else if (effect.kind === "cancel") {
        await api.cancel(effect.agentId);
      } else if (effect.kind === "newSession") {
        await api.newSession(effect.agentId);
      } else if (effect.kind === "selectSession") {
        await api.selectSession(effect.agentId, effect.sessionId, effect.title);
      } else if (effect.kind === "refresh") {
        // Nothing to send: the report fetch below is the refresh.
      } else if (effect.kind === "readAll") {
        for (const id of effect.ids) await api.readEvent(id);
      } else if (effect.kind === "readEvent") {
        await api.readEvent(effect.id);
      } else if (effect.kind === "openEvent") {
        // Switch first, then mark read: the daemon then knows which conversation the alert opened.
        if (effect.sessionId !== null) await api.selectSession(effect.agentId, effect.sessionId, "");
        await api.readEvent(effect.id, true);
      } else if (effect.kind === "toggle") {
        await api.toggle(effect.device);
      } else if (effect.kind === "homeAction") {
        if (api.homeAction === undefined) {
          await api.toggle(effect.target);
        } else {
          const result = await api.homeAction(effect.target, effect.action, effect.value);
          // Lock / alarm / garage: nothing happened yet; the next tap on the same row confirms.
          if (result.confirm !== undefined) { model = withHomePending(model, effect.target, result.confirm, Date.now()); watchConfirm(); }
        }
      } else if (effect.kind === "homeConfirm") {
        await api.homeConfirm?.(effect.token);
      } else {
        await api.printer(effect.action);
      }
      const report = await api.report();
      newestEventId = report.inbox.events[0]?.id ?? newestEventId;
      applyReport(report);
      fast = report.approvals.length > 0 || report.agents.some((agent) => agent.busy);
      // A held long-poll answers by itself on the next change; otherwise ask again soon.
      if (!pollBusy) schedulePoll(nextPollMs());
    } catch (error) {
      console.warn("[quiethub] effect failed:", error);
      const problem = classifyError(error);
      if (problem !== "error") markFailure(error);
      // QIS v1.2 #8: the glasses get plain words, the exact error goes to the phone (Mehr).
      else { conn.raw = rawText(error); conn.lastAt = Date.now(); }
      const why = tr(messages, locale, problem === "error" ? "effect.failedHttp" : `link.title.${problem}`);
      model = { ...model, message: { text: tr(messages, locale, "effect.failed", { why }), until: Date.now() + MESSAGE_MS } };
      if (problem !== "error" && !pollBusy) schedulePoll(BACKOFF_MS[0]);
    }
    await draw();
    refreshPhone();
  };

  // ---- input -------------------------------------------------------------
  // QIS v1: an armed action ("Nochmal tippen = stoppen") disarms by itself after CONFIRM_MS; redraw then so the old footer returns.
  let confirmTimer: ReturnType<typeof setTimeout> | null = null;
  const watchConfirm = (): void => {
    if (confirmTimer !== null) { clearTimeout(confirmTimer); confirmTimer = null; }
    const armed = model.confirm;
    if (armed === null) return;
    confirmTimer = setTimeout(() => { confirmTimer = null; if (!closed) void draw(); }, Math.max(0, armed.until - Date.now()) + 60);
  };
  const apply = (outcome: { model: HubModel; effect?: Effect | undefined }): void => {
    model = outcome.model;
    saveUiState(bridge, model);
    watchConfirm();
    void draw();
    refreshPhone();
    void runEffect(outcome.effect);
  };
  const onGesture = (gesture: Gesture, source: InputSource = "unknown"): void => {
    const mapped = hubGesture(gesture, source);
    if (mapped === null) return;
    const now = Date.now();
    // While quiet, a tap or swipe only wakes the display; every gesture keeps it awake for a while.
    const quiet = quietGesture(model, mapped, now);
    if (quiet.consumed) { apply({ model: quiet.model }); return; }
    apply(decide(quiet.model, mapped, now, locale));
  };
  const onMenu = (itemId: number): void => { const now = Date.now(); apply(applyMenu(wake(model, now), itemId, now, locale)); };

  let unsubscribeEvents: () => void = () => undefined;
  let unsubscribeDevice: () => void = () => undefined;
  const handle = (event: unknown): void => {
    if (closed) return;
    const systemType = (event as { sysEvent?: { eventType?: number } }).sysEvent?.eventType;
    if (systemType === 4 && dialogPending) {
      // The exit dialog came up: stay still, it is on screen now.
      dialogPending = false;
      dialogShown = true;
      exitDialogAsked = true;
      return;
    }
    if (systemType === 5 && dialogShown) {
      // "No": the dialog went away. The app never left - page up again the way of the first one; timers, polls and
      // streams keep running.
      dialogShown = false;
      exitDialogAsked = true;
      exitBack();
      return;
    }
    // Only input and system events end the dialog state; the microphone stream and sysEvent 8 leave it alone.
    if ((event as { audioEvent?: unknown }).audioEvent === undefined && systemType !== 8) {
      dialogPending = false;
      dialogShown = false;
    }
    // Not the microphone stream, and not the events that leave: only input and FOREGROUND_ENTER mean the app is back.
    if ((event as { audioEvent?: unknown }).audioEvent === undefined && systemType !== 5 && systemType !== 6 && systemType !== 7) exitBack();
    // Native contextual menu: arrives on its own event, whatever container captures input.
    const menuId = menuItemIdFromEvent(event);
    if (menuId !== null) {
      onMenu(menuId);
      return;
    }
    if (systemType === 4) {
      forgetShown();
      void draw();
      return;
    }
    if (systemType === 5) {
      saveUiState(bridge, model);
      return;
    }
    if (systemType === 6 || systemType === 7) {
      closed = true;
      tiles.close();
      if (pollTimer !== null) clearTimeout(pollTimer);
      if (mic.active) void mic.stop();
      stopLiveStt();
      saveUiState(bridge, model);
      unsubscribeEvents();
      unsubscribeDevice();
      return;
    }
    // PCM blocks arrive on the same channel as gestures; while recording
    // they are the only thing that matters.
    const audio = (event as { audioEvent?: { audioPcm?: unknown } }).audioEvent;
    const pcm = audio?.audioPcm;
    if ((mic.active || micDraining) && audio !== undefined) {
      const bytes = toBytes(pcm);
      if (bytes !== null && bytes.length > 0) {
        micChunks.push(bytes);
        liveStt?.send(bytes);
      }
      return;
    }
    const gesture = gestureFromEvent(event, { invertScroll: settings.invertScroll });
    if (gesture !== null) onGesture(gesture.gesture, gesture.source);
  };
  unsubscribeEvents = bridge.onEvenHubEvent(handle as never);
  // Launched from the glasses menu: land on the Overview, whatever page was open last.
  bridge.onLaunchSource((source) => {
    launchSource = source;
    if (source === "glassesMenu") {
      const morning = morningStart(settings.briefMorning === true, new Date());
      model = { ...model, screen: morning ? "brief" : startScreen(source, null), confirm: null, help: false, picker: null };
      void draw();
      if (morning) void runEffect({ kind: "brief", refresh: false });
    }
  });
  void launchSource;

  // Reconnect: the page died with the link; forget the last view so even an
  // identical view forces a full re-render. iOS WebView gives no reliable
  // wake event, so this hook (plus visibilitychange below) is the re-render.
  unsubscribeDevice = bridge.onDeviceStatusChanged((device) => {
    if (device?.connectType === "connected" && !closed) {
      forgetShown();
      void draw();
    }
  });
  globalThis.addEventListener?.("visibilitychange", () => {
    if (globalThis.document?.visibilityState === "visible" && !closed) {
      forgetShown();
      void draw();
    }
  });

  // ---- phone page --------------------------------------------------------
  const phoneRoot = document.querySelector<HTMLElement>("#app");
  if (phoneRoot !== null) {
    const connView = (): ConnView => ({
      configured: settings.serverUrl.trim() !== "",
      connected: !(demoMode && !DEMO) && model.link === null && model.report.connection !== "missing" && model.report.connection !== "error" && model.report.connection !== "loading",
      host: serverHost(settings.serverUrl),
      lastOkAt: conn.lastOkAt,
      problem: conn.lastProblem,
      lastErrorAt: conn.lastAt,
      raw: conn.raw,
      fails: conn.fails,
    });
    /** Applies new settings at once: persist (SDK store), rebuild the client, poll right now. */
    const applySettings = async (next: typeof settings): Promise<SettingsResult> => {
      settings = next;
      model = { ...model, quietWhileWorking: settings.quietWhileWorking };
      void draw();
      const saved = await saveSettings(bridge, settings);
      if (!saved.persisted) console.warn("[quiethub] settings were not persisted");
      if (DEMO) return { ok: true, persisted: saved.persisted, problem: null };
      if (unconfigured()) {
        // Server removed: back to the demo with its hint instead of an empty "not connected" page.
        demoMode = true;
        api = demoApi();
        pollGen += 1;
        if (pollTimer !== null) clearTimeout(pollTimer);
        pollTimer = null;
        model = { ...mergeReport(withLink(model, null), await api.report()), setupHint: true };
        conn.hadData = true;
        await draw();
        return { ok: false, persisted: saved.persisted, problem: "missing" };
      }
      if (demoMode) {
        // Leaving the demo: no demo data may pass for the real hub, a failing first try shows at once.
        demoMode = false;
        conn.hadData = false;
        model = { ...model, setupHint: false };
      }
      api = createClient({ baseUrl: settings.serverUrl, token: settings.token });
      conn.fails = 0;
      // Another server: forget the old long-poll (its answer is dropped) and its cursor.
      pollGen += 1;
      pollBusy = false;
      livePoll = initialLivePoll();
      if (pollTimer !== null) clearTimeout(pollTimer);
      pollTimer = null;
      if (problemFor(null) !== "error") {
        markFailure(null);
        await draw();
        return { ok: false, persisted: saved.persisted, problem: conn.lastProblem };
      }
      try {
        applyReport(await api.report());
        await draw();
        fast = model.report.approvals.length > 0 || model.report.agents.some((agent) => agent.busy);
        schedulePoll(nextPollMs());
        return { ok: true, persisted: saved.persisted, problem: null };
      } catch (error) {
        markFailure(error);
        await draw();
        schedulePoll(BACKOFF_MS[0]);
        return { ok: false, persisted: saved.persisted, problem: conn.lastProblem };
      }
    };
    refreshPhone = mountPhoneUi(phoneRoot, () => ({ model, locale, settings, conn: connView(), speech: narrator.status(), location: locator.state() }), {
      onSpeechActivate: () => { serverTts.unlock(); narrator.activate(); },
      onLocale: (next) => {
        locale = next;
        rememberLocale(bridge, next);
        forgetShown();
        void draw();
        refreshPhone();
      },
      onSettings: applySettings,
      onRefresh: () => { fast = true; if (pollTimer !== null) clearTimeout(pollTimer); pollTimer = null; void poll(); },
      onBriefRefresh: () => runEffect({ kind: "brief", refresh: true }),
      onTest: async (candidate) => {
        const started = Date.now();
        if (candidate.serverUrl.trim() === "") return { ok: false, problem: "missing", ms: 0 };
        if (insecureServer(candidate.serverUrl, globalThis.location?.protocol)) return { ok: false, problem: "insecure", ms: 0 };
        try {
          await createClient({ baseUrl: candidate.serverUrl, token: candidate.token }).report();
          return { ok: true, problem: null, ms: Date.now() - started };
        } catch (error) {
          conn.raw = rawText(error);
          return { ok: false, problem: classifyError(error), ms: Date.now() - started };
        }
      },
      onScanQr: async () => {
        const asset = await bridge.captureImageFromCamera().catch(() => null);
        if (asset === null || asset.base64 === "") throw new Error("Kamera abgebrochen");
        const value = await decodeQr(asset.base64, asset.mimeType || "image/jpeg");
        return { ...parseSetupQr(value, settings.autoOpenNotifications), invertScroll: settings.invertScroll, voiceAutoSend: settings.voiceAutoSend, speakAnswers: settings.speakAnswers, quietWhileWorking: settings.quietWhileWorking, briefMorning: settings.briefMorning === true };
      },
    });
  }

  await draw();
  void poll();
  // Started on the Tagesstart (morning setting or the page open last time): load it right away.
  if (model.screen === "brief") void runEffect({ kind: "brief", refresh: false });
}

/** The exact error text of a failed request ("Load failed", "Failed to fetch", "HTTP 401" ...) - tells a whitelist block from a network error. */
function rawText(error: unknown): string {
  if (error === null || error === undefined) return "";
  if (error instanceof ApiError) return `${error.kind}: ${error.message}${error.status !== undefined ? ` (HTTP ${error.status})` : ""}`;
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

async function loadUiState(bridge: EvenAppBridge): Promise<{ screen: Screen; rootSelected?: number } | null> {
  try {
    const raw = await bridge.getLocalStorage("quiethub.ui");
    if (raw !== null && raw !== undefined && raw !== "") return JSON.parse(raw) as { screen: Screen; rootSelected?: number };
  } catch {
    // A cold start simply falls back to the mandatory root page.
  }
  return null;
}

function saveUiState(bridge: EvenAppBridge, model: HubModel): void {
  void bridge.setLocalStorage("quiethub.ui", JSON.stringify({ screen: model.screen, rootSelected: model.rootSelected }))
    .then((ok) => { if (!ok) console.warn("[quiethub] UI state was not persisted"); })
    .catch(() => console.warn("[quiethub] UI state persistence failed"));
}

globalThis.addEventListener?.("error", (event) => console.error("[quiethub] window error:", event.error ?? event.message));
globalThis.addEventListener?.("unhandledrejection", (event) => console.error("[quiethub] unhandled rejection:", event.reason));
void boot();
