import { AudioInputSource, waitForEvenAppBridge, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { createClient, ApiError } from "./api/client";
import { createDemoApi, demoReport } from "./api/demo";
import type { HubApi, HubReport } from "./api/types";
import { getLocale, setLocale, type Locale } from "./i18n";
import { tr } from "./i18n";
import { messages } from "./messages";
import { gestureFromEvent, type Gesture } from "./input/gestures";
import { buildView, createModel, decide, mergeReport, MESSAGE_MS, SCREENS, type Effect, type HubModel, type Screen } from "./hub/model";
import { sameView } from "./glasses/diff";
import { createPage, updatePage } from "./glasses/render";
import { pixelIconFor } from "./glasses/icons";
import type { ScreenView } from "./glasses/screen";
import { buildWav } from "./audio/wav";
import { mountPhoneUi, type AppSettings } from "./ui/phone";
import { decodeQr, parseSetupQr } from "./setup/qr";

const DEMO = new URLSearchParams(globalThis.location?.search ?? "").get("demo") === "1";
const POLL_MS = 5000;
/** Faster while an agent works or a permission card waits, so answers stream. */
const POLL_FAST_MS = 1500;
const RETRY_MS = 5000;
const BUILD = "0.3.0";

/** Map the shared gesture vocabulary onto the hub's page language. */
function hubGesture(gesture: Gesture): "click" | "doubleClick" | "scrollUp" | "scrollDown" | "longPress" | "longPressRelease" | null {
  switch (gesture) {
    case "click": return "click";
    case "doubleClick": return "doubleClick";
    case "scrollUp": return "scrollUp";
    case "scrollDown": return "scrollDown";
    case "longPress": return "longPress";
    case "longPressRelease": return "longPressRelease";
    default: return null;
  }
}

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
  let api: HubApi = DEMO ? createDemoApi(locale) : createClient({ baseUrl: settings.serverUrl, token: settings.token });

  let model: HubModel = createModel(await firstReport(api, locale));
  const savedUi = await loadUiState(bridge);
  if (savedUi !== null && SCREENS.includes(savedUi.screen)) model = { ...model, screen: savedUi.screen };
  let lastView: ScreenView | null = null;
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

  const startMic = async (): Promise<void> => {
    micChunks.length = 0;
    micActive = await bridge.audioControl(true, AudioInputSource.Glasses).catch(() => false);
    if (!micActive) console.warn("[quiethub] microphone refused");
  };

  const stopMic = async (): Promise<void> => {
    micActive = false;
    await bridge.audioControl(false).catch(() => undefined);
    // In-flight blocks still arrive after the off-switch; without the drain the
    // recording loses its tail (drain rule).
    await new Promise((resolve) => setTimeout(resolve, MIC_DRAIN_MS));
  };

  const drawOnce = async (): Promise<void> => {
    const view = buildView(model, locale, Date.now());
    if (sameView(lastView, view)) return;
    const icon = pixelIconFor(model);
    const result = pageCreated ? await updatePage(bridge, view, icon) : await createPage(bridge, view, icon);
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
      if ((isNew || newCard) && settings.autoOpenNotifications && !model.recording) {
        model = newCard
          ? { ...model, screen: "agent", agentView: "list", confirm: null }
          : { ...model, screen: "inbox", confirm: null };
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
        await startMic();
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
        if (wav.length <= 44) {
          model = {
            ...model,
            message: { text: tr(messages, locale, "voice.empty"), until: Date.now() + MESSAGE_MS },
          };
        } else {
          const heard = await api.voice(wav, effect.agentId);
          model = {
            ...model,
            message: { text: tr(messages, locale, "voice.heard", { text: heard.question }), until: Date.now() + MESSAGE_MS },
          };
        }
      } else if (effect.kind === "ask") {
        await api.ask(effect.question, effect.agentId);
      } else if (effect.kind === "approve") {
        await api.approve(effect.cardId, effect.decision);
      } else if (effect.kind === "cancel") {
        await api.cancel(effect.agentId);
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
  const onGesture = (gesture: Gesture): void => {
    const mapped = hubGesture(gesture);
    if (mapped === null) return;
    const outcome = decide(model, mapped, Date.now());
    model = outcome.model;
    saveUiState(bridge, model.screen);
    void draw();
    refreshPhone();
    void runEffect(outcome.effect);
  };

  let unsubscribeEvents: () => void = () => undefined;
  let unsubscribeDevice: () => void = () => undefined;
  const handle = (event: unknown): void => {
    const systemType = (event as { sysEvent?: { eventType?: number } }).sysEvent?.eventType;
    if (systemType === 4) {
      lastView = null;
      void draw();
      return;
    }
    if (systemType === 5) {
      saveUiState(bridge, model.screen);
      return;
    }
    if (systemType === 6 || systemType === 7) {
      closed = true;
      if (pollTimer !== null) clearTimeout(pollTimer);
      if (micActive) void bridge.audioControl(false).catch(() => false);
      saveUiState(bridge, model.screen);
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
    const gesture = gestureFromEvent(event);
    if (gesture !== null) onGesture(gesture.gesture);
  };
  unsubscribeEvents = bridge.onEvenHubEvent(handle as never);

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
        return parseSetupQr(value, settings.autoOpenNotifications);
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
  return { serverUrl: "", token: "", autoOpenNotifications: true };
}

function normalizeSettings(value: Partial<AppSettings>): AppSettings {
  return {
    serverUrl: typeof value.serverUrl === "string" ? value.serverUrl : "",
    token: typeof value.token === "string" ? value.token : "",
    autoOpenNotifications: value.autoOpenNotifications !== false,
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

async function loadUiState(bridge: EvenAppBridge): Promise<{ screen: Screen } | null> {
  try {
    const raw = await bridge.getLocalStorage("quiethub.ui");
    if (raw !== null && raw !== undefined && raw !== "") return JSON.parse(raw) as { screen: Screen };
  } catch {
    // A cold start simply falls back to the mandatory root page.
  }
  return null;
}

function saveUiState(bridge: EvenAppBridge, screen: Screen): void {
  void bridge.setLocalStorage("quiethub.ui", JSON.stringify({ screen }))
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
