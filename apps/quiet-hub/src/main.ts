import { AudioInputSource, waitForEvenAppBridge, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { createClient, ApiError } from "./api/client";
import { createDemoApi, DEMO_SCENES, demoReport, type DemoScene } from "./api/demo";
import type { HubApi, HubReport } from "./api/types";
import { getLocale, setLocale, type Locale } from "./i18n";
import { tr } from "./i18n";
import { messages } from "./messages";
import { gestureFromEvent, menuItemIdFromEvent, type Gesture, type InputSource } from "./input/gestures";
import { applyMenu, buildView, createModel, decide, menuFor, mergeReport, MESSAGE_MS, withSessions, withVoiceFailed, withVoiceHeard, type Effect, type HubModel, type Screen } from "./hub/model";
import { hubGesture, startScreen } from "./hub/entry";
import { sameView } from "./glasses/diff";
import { createPage, rebuildPage, updatePage } from "./glasses/render";
import { pixelIconFor } from "./glasses/icons";
import type { ScreenView } from "./glasses/screen";
import { buildWav } from "./audio/wav";
import { mountPhoneUi, type AppSettings } from "./ui/phone";
import { decodeQr, parseSetupQr } from "./setup/qr";

const DEMO = new URLSearchParams(globalThis.location?.search ?? "").get("demo") === "1";
const sceneParam = new URLSearchParams(globalThis.location?.search ?? "").get("scene");
const DEMO_SCENE: DemoScene = DEMO_SCENES.find((scene) => scene === sceneParam) ?? "default";
const POLL_MS = 5000;
/** Faster while an agent works or a permission card waits, so answers stream. */
const POLL_FAST_MS = 1500;
const RETRY_MS = 5000;
const BUILD = "0.5.0";
/** A voice note is cut off here and sent; also guards against a lost "release" event. */
export const MAX_RECORD_MS = 18_000;
/** Less audio than this is a mis-press (16 kHz, 16 bit, mono = 32 bytes per ms). */
const MIN_RECORD_BYTES = 32 * 400;

async function boot(): Promise<void> {
  console.info(`[quiethub] v${BUILD} boot`);
  const bridge: EvenAppBridge = await waitForEvenAppBridge();

  // `?lang=de|en` overrides the device language — the simulator webview has
  // no useful locale of its own, and screenshots want a deterministic one.
  const params = new URLSearchParams(globalThis.location?.search ?? "");
  const setup = new URLSearchParams(globalThis.location?.hash?.replace(/^#/, "") ?? "");
  const forced = params.get("lang");
  if (forced === "de" || forced === "en") setLocale(forced);
  let locale: Locale = getLocale();
  let settings = await loadSettings(bridge);
  // `?server=` points at the daemon without going through the phone page —
  // used by the simulator and for testing the real Hermes bridge.
  const forcedServer = setup.get("server") ?? params.get("server");
  const forcedToken = setup.get("token");
  if (forcedServer !== null && forcedServer !== "") {
    settings = { ...settings, serverUrl: forcedServer, token: forcedToken ?? settings.token };
    saveSettings(bridge, settings);
    // Remove credentials from the visible URL after the one-time QR setup.
    try {
      globalThis.history?.replaceState?.(null, "", `${globalThis.location?.pathname ?? "/"}${globalThis.location?.search ?? ""}`);
    } catch {
      // Some host WebViews do not permit history mutation; setup still worked.
    }
  }
  let api: HubApi = DEMO ? createDemoApi(locale, DEMO_SCENE) : createClient({ baseUrl: settings.serverUrl, token: settings.token });

  let model: HubModel = createModel(await firstReport(api, locale));
  const savedUi = await loadUiState(bridge);
  let launchSource: "appMenu" | "glassesMenu" | null = null;
  if (savedUi !== null) model = { ...model, screen: startScreen(null, savedUi.screen), rootSelected: Math.max(0, Math.min(savedUi.rootSelected ?? 0, 3)) };
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

  // ---- microphone (voice notes) ------------------------------------------
  const micChunks: Uint8Array[] = [];
  const MIC_DRAIN_MS = 150;
  let micActive = false;

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

  let recordTimer: ReturnType<typeof setTimeout> | null = null;
  const clearRecordTimer = (): void => {
    if (recordTimer !== null) clearTimeout(recordTimer);
    recordTimer = null;
  };

  const startMic = async (): Promise<boolean> => {
    micChunks.length = 0;
    micActive = await bridge.audioControl(true, AudioInputSource.Glasses).catch(() => false);
    if (!micActive) {
      console.warn("[quiethub] microphone refused");
      return false;
    }
    // Hard stop: a recording must end even when the release event never arrives.
    clearRecordTimer();
    recordTimer = setTimeout(() => {
      recordTimer = null;
      if (!model.recording) return;
      model = { ...model, message: { text: tr(messages, locale, "voice.limit", { s: MAX_RECORD_MS / 1000 }), until: Date.now() + MESSAGE_MS } };
      onGesture("longPressRelease");
    }, MAX_RECORD_MS);
    return true;
  };

  const stopMic = async (): Promise<void> => {
    clearRecordTimer();
    micActive = false;
    await bridge.audioControl(false).catch(() => undefined);
    // In-flight blocks still arrive after the off-switch; without the drain the
    // recording loses its tail (drain rule).
    await new Promise((resolve) => setTimeout(resolve, MIC_DRAIN_MS));
  };

  const drawOnce = async (): Promise<void> => {
    const view = buildView(model, locale, Date.now());
    const menu = menuFor(model, locale);
    if (sameView(lastView, view) && menu.key === menuKey) return;
    const icon = pixelIconFor(model);
    let result;
    if (!pageCreated) {
      result = await createPage(bridge, view, icon, menu);
      if (result.ok) menuKey = menu.key;
    } else if (menu.key !== menuKey) {
      // Another page = another menu: the only reason to rebuild. menuObject is re-supplied.
      menuKey = menu.key;
      result = await rebuildPage(bridge, view, icon, menu);
      if (!result.ok) {
        console.warn("[quiethub] menu rebuild failed:", result.reason);
        result = await updatePage(bridge, view, icon, lastView);
      }
    } else {
      result = await updatePage(bridge, view, icon, lastView);
    }
    if (result.ok) {
      pageCreated = true;
      lastView = view;
      return;
    }
    lastView = null;
    console.warn("[quiethub] draw failed:", result.reason);
  };

  /** One draw at a time; requests made meanwhile collapse into one redraw. */
  const draw = (): Promise<void> => {
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

  // ---- data --------------------------------------------------------------
  const poll = async (): Promise<void> => {
    if (closed) return;
    try {
      const report = await api.report();
      const nextId = report.inbox.events[0]?.id ?? null;
      const isNew = nextId !== null && nextId !== newestEventId;
      const newCard = report.approvals.length > 0 && model.report.approvals.length === 0;
      newestEventId = nextId;
      model = mergeReport(model, report);
      // A permission card must be answered, so it opens the agent page. A plain
      // "done" notice never pulls the wearer out of a page they are working in:
      // it only opens from the overview (it is waiting in Meldungen otherwise).
      if (newCard && settings.autoOpenNotifications && !model.recording) {
        model = { ...model, screen: "agent", agentView: "list", confirm: null };
      } else if (isNew && settings.autoOpenNotifications && !model.recording && model.screen === "root") {
        model = { ...model, screen: "inbox", confirm: null };
      }
      fast = report.approvals.length > 0 || report.agents.some((agent) => agent.busy);
    } catch (error) {
      if (!(error instanceof ApiError)) console.warn("[quiethub] poll failed:", error);
      pollTimer = setTimeout(() => void poll(), RETRY_MS);
      return;
    }
    await draw();
    refreshPhone();
    pollTimer = setTimeout(() => void poll(), fast ? POLL_FAST_MS : POLL_MS);
  };

  const runEffect = async (effect: Effect | undefined): Promise<void> => {
    if (effect === undefined) return;
    try {
      if (effect.kind === "recordStart") {
        if (!(await startMic())) {
          // Say why nothing is happening instead of a silent dead microphone.
          model = { ...model, recording: false, recordAgent: null, message: { text: tr(messages, locale, "voice.mic"), until: Date.now() + MESSAGE_MS } };
          await draw();
          refreshPhone();
        }
        return;
      }
      if (effect.kind === "recordAbort") {
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
      if (effect.kind === "exit") {
        // Required by Even QA on the root page. Do not clean up here: the user
        // may cancel. Cleanup happens only on SYSTEM/ABNORMAL_EXIT below.
        await bridge.shutDownPageContainer(1);
        return;
      }
      if (effect.kind === "recordStop") {
        await stopMic();
        const wav = buildWav(micChunks);
        const fail = (key: string): void => { model = withVoiceFailed(model, tr(messages, locale, key), Date.now()); };
        if (wav.length <= 44) {
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
        await api.approve(effect.cardId, effect.decision);
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
      } else if (effect.kind === "toggle") {
        await api.toggle(effect.device);
      } else {
        await api.printer(effect.action);
      }
      const report = await api.report();
      newestEventId = report.inbox.events[0]?.id ?? newestEventId;
      model = mergeReport(model, report);
      fast = report.approvals.length > 0 || report.agents.some((agent) => agent.busy);
      if (fast && pollTimer !== null) { clearTimeout(pollTimer); pollTimer = setTimeout(() => void poll(), POLL_FAST_MS); }
    } catch (error) {
      console.warn("[quiethub] effect failed:", error);
    }
    await draw();
    refreshPhone();
  };

  // ---- input -------------------------------------------------------------
  const apply = (outcome: { model: HubModel; effect?: Effect | undefined }): void => {
    model = outcome.model;
    saveUiState(bridge, model);
    void draw();
    refreshPhone();
    void runEffect(outcome.effect);
  };
  const onGesture = (gesture: Gesture, source: InputSource = "unknown"): void => {
    const mapped = hubGesture(gesture, source);
    if (mapped === null) return;
    apply(decide(model, mapped, Date.now(), locale));
  };
  const onMenu = (itemId: number): void => apply(applyMenu(model, itemId, Date.now(), locale));

  let unsubscribeEvents: () => void = () => undefined;
  let unsubscribeDevice: () => void = () => undefined;
  const handle = (event: unknown): void => {
    // Native contextual menu: arrives on its own event, whatever container captures input.
    const menuId = menuItemIdFromEvent(event);
    if (menuId !== null) {
      onMenu(menuId);
      return;
    }
    const systemType = (event as { sysEvent?: { eventType?: number } }).sysEvent?.eventType;
    if (systemType === 4) {
      lastView = null;
      void draw();
      return;
    }
    if (systemType === 5) {
      saveUiState(bridge, model);
      return;
    }
    if (systemType === 6 || systemType === 7) {
      closed = true;
      if (pollTimer !== null) clearTimeout(pollTimer);
      clearRecordTimer();
      if (micActive) void bridge.audioControl(false).catch(() => false);
      saveUiState(bridge, model);
      unsubscribeEvents();
      unsubscribeDevice();
      return;
    }
    // PCM blocks arrive on the same channel as gestures; while recording
    // they are the only thing that matters.
    const audio = (event as { audioEvent?: { audioPcm?: unknown } }).audioEvent;
    const pcm = audio?.audioPcm;
    if (micActive && audio !== undefined) {
      const bytes = toBytes(pcm);
      if (bytes !== null && bytes.length > 0) micChunks.push(bytes);
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
      model = { ...model, screen: startScreen(source, null), confirm: null, help: false, picker: null };
      void draw();
    }
  });
  void launchSource;

  // Reconnect: the page died with the link; forget the last view so even an
  // identical view forces a full re-render. iOS WebView gives no reliable
  // wake event, so this hook (plus visibilitychange below) is the re-render.
  unsubscribeDevice = bridge.onDeviceStatusChanged((device) => {
    if (device?.connectType === "connected" && !closed) {
      lastView = null;
      void draw();
    }
  });
  globalThis.addEventListener?.("visibilitychange", () => {
    if (globalThis.document?.visibilityState === "visible" && !closed) {
      lastView = null;
      void draw();
    }
  });

  // ---- phone page --------------------------------------------------------
  const phoneRoot = document.querySelector<HTMLElement>("#app");
  if (phoneRoot !== null) {
    refreshPhone = mountPhoneUi(phoneRoot, () => ({ model, locale, settings }), {
      onLocale: (next) => {
        locale = next;
        setLocale(next);
        lastView = null;
        void draw();
        refreshPhone();
      },
      onSettings: async (next) => {
        settings = next;
        saveSettings(bridge, settings);
        if (DEMO) return true;
        api = createClient({ baseUrl: settings.serverUrl, token: settings.token });
        try {
          const report = await api.report();
          model = mergeReport(model, report);
          await draw();
          return true;
        } catch {
          return false;
        }
      },
      onScanQr: async () => {
        const asset = await bridge.captureImageFromCamera().catch(() => null);
        if (asset === null || asset.base64 === "") throw new Error("Kamera abgebrochen");
        const value = await decodeQr(asset.base64, asset.mimeType || "image/jpeg");
        return { ...parseSetupQr(value, settings.autoOpenNotifications), invertScroll: settings.invertScroll, voiceAutoSend: settings.voiceAutoSend };
      },
    });
  }

  await draw();
  void poll();
}

async function loadSettings(bridge: EvenAppBridge): Promise<AppSettings> {
  // The SDK KV (`setLocalStorage`/`getLocalStorage`) is the only reliably
  // persistent store in the EvenHub WebView — plain `localStorage` may not
  // survive relaunches there (verified by the Pulse project). Read SDK first,
  // fall back to localStorage for web/simulator contexts.
  try {
    const raw = await bridge.getLocalStorage("quiethub.settings");
    if (raw !== null && raw !== undefined && raw !== "") return normalizeSettings(JSON.parse(raw) as Partial<AppSettings>);
  } catch {
    // Fall through to localStorage.
  }
  try {
    const raw = globalThis.localStorage?.getItem("quiethub.settings");
    if (raw !== null && raw !== undefined) return normalizeSettings(JSON.parse(raw) as Partial<AppSettings>);
  } catch {
    // No storage: start unconfigured.
  }
  return { serverUrl: "", token: "", autoOpenNotifications: true, invertScroll: false, voiceAutoSend: false };
}

function normalizeSettings(value: Partial<AppSettings>): AppSettings {
  return {
    serverUrl: typeof value.serverUrl === "string" ? value.serverUrl : "",
    token: typeof value.token === "string" ? value.token : "",
    autoOpenNotifications: value.autoOpenNotifications !== false,
    invertScroll: value.invertScroll === true,
    voiceAutoSend: value.voiceAutoSend === true,
  };
}

function saveSettings(bridge: EvenAppBridge, settings: AppSettings): void {
  const raw = JSON.stringify(settings);
  try {
    globalThis.localStorage?.setItem("quiethub.settings", raw);
  } catch {
    // Best effort mirror only.
  }
  // SDK KV is authoritative; `setLocalStorage` resolves false without
  // throwing on failure, so check nothing here — persistence is best effort.
  void bridge.setLocalStorage("quiethub.settings", raw)
    .then((ok) => { if (!ok) console.warn("[quiethub] settings were not persisted"); })
    .catch(() => console.warn("[quiethub] settings persistence failed"));
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

async function firstReport(api: HubApi, locale: Locale = "de"): Promise<HubReport> {
  try {
    return await api.report();
  } catch (error) {
    // Daemon unreachable at startup: show the demo so the display is never
    // blank; `connection: "missing"` keeps the footer honest about it.
    console.warn("[quiethub] initial report failed:", error);
    return { ...demoReport(locale), connection: "missing" };
  }
}

globalThis.addEventListener?.("error", (event) => console.error("[quiethub] window error:", event.error ?? event.message));
globalThis.addEventListener?.("unhandledrejection", (event) => console.error("[quiethub] unhandled rejection:", event.reason));
void boot();
