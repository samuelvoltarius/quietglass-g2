import { waitForEvenAppBridge, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { settleRestore } from "./exit";
import { rememberLocale, resolveLocale, getLocale, type Locale } from "./i18n";
import { t } from "./messages";
import { gestureFromEvent, menuItemIdFromEvent, type Gesture } from "./input/gestures";
import { COCKPIT_TILES, createCockpitPage, createTextPage, forgetPage, guardedTileSend, updateTextPage, type TextView } from "./glasses/page";
import { appsItemLabel, appsItems, appsView, dpadItems, dpadView, errorReason, startRows, startView, type Connection, type DeviceInfo, type Screen, type ViewState } from "./glasses/views";
import { cockpitModel } from "./cockpit/model";
import { composeCockpit } from "./cockpit/compose";
import { createTileSender } from "./screen/sender";
import { autoBackend, type TextBackend } from "./screen/text";
import type { TvBackend } from "./tv/backend";
import { createBridgeBackend } from "./tv/bridge";
import { createPowerArm, createVolumeStepper, POWER_ARM_MS } from "./tv/controls";
import { createDemo } from "./tv/demo";
import { toApiError } from "./tv/errors";
import { createHaBackend, listHaEntities, type HaBackend } from "./tv/ha-backend";
import { launchEntries, UNKNOWN_STATE, type TvState } from "./tv/model";
import { fetchRelayDevices } from "./tv/relay";
import { activeDeviceOf, BUILD_HA_RELAY, deviceLabel, EMPTY_SETTINGS, effectiveHaToken, effectiveHaUrl, importRelayDevices, isConfigured, loadSettings, nextActive, saveSettings, type Settings } from "./storage/persist";
import { mountPhoneUi, type PhoneConnection, type RelayState } from "./ui/phone";

/** Shown in the phone page footer and logs; keep in step with app.json. */
export const BUILD = "0.2.3";

const params = new URLSearchParams(globalThis.location?.search ?? "");
const DEMO = params.get("demo") === "1";
/** `?page=remote|apps|dpad` opens that page first (simulator screenshots); without it the start page. */
const START_SCREEN: Screen = (["remote", "apps", "dpad"] as const).find((name) => name === params.get("page")) ?? "start";

/** The TV is asked this often while the app is open. */
export const POLL_MS = 5_000;
/** After a command the TV is asked again this soon (its state takes a moment to change). */
export const AFTER_COMMAND_MS = 700;
/** A command's result line stays this long. */
export const FLASH_MS = 3_000;
/** The cockpit is redrawn this often for the clock; an unchanged frame sends nothing. */
const TICK_MS = 15_000;

async function boot(): Promise<void> {
  const bridge: EvenAppBridge = await waitForEvenAppBridge();

  // State first, with safe defaults: the gesture handler is registered before any
  // other native call is awaited, so the glasses can always be left (double tap).
  let settings: Settings = EMPTY_SETTINGS;
  let locale: Locale = getLocale();
  let backend: TvBackend = createDemo();
  let demoActive = true;
  let closed = false;
  let connection: Connection = { kind: "loading" };
  let tv: TvState | null = null;
  let screen: Screen = START_SCREEN;
  let startCursor = 0;
  let appsCursor = 0;
  let dpadCursor = 0;
  let flash: { text: string; until: number } | null = null;
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let soonTimer: ReturnType<typeof setTimeout> | undefined;
  let armTimer: ReturnType<typeof setTimeout> | undefined;
  let tickTimer: ReturnType<typeof setInterval> | undefined;
  let polling = false;
  let pollAgain = false;
  let generation = 0;
  let ready = false;
  /** Relay builds only: whether the relay's device list was fetched (see syncRelay). */
  let relayState: RelayState = "checking";
  const powerArm = createPowerArm();

  /** The active Home Assistant device (name, position, how many); none for the bridge and the demo. */
  const deviceInfo = (): DeviceInfo | undefined => {
    if (demoActive || settings.backend !== "ha") return undefined;
    const active = activeDeviceOf(settings);
    if (!active) return undefined;
    return { name: deviceLabel(active, tv?.name), index: Math.max(0, settings.devices.indexOf(active)), count: settings.devices.length };
  };

  const viewState = (): ViewState => ({
    locale, demo: demoActive, connection, tv,
    ...(deviceInfo() ? { device: deviceInfo()! } : {}),
    dpad: backend.dpad,
    entries: launchEntries(tv ?? UNKNOWN_STATE, settings.apps),
    pendingVolume: stepper.pending(),
    flash: flash && flash.until > Date.now() ? flash.text : null,
    armed: powerArm.armed(Date.now()),
    now: Date.now(),
  });

  let lastView: TextView | null = null;
  let pageReady = false;
  /** Which kind of page the glasses carry: a change means one rebuild. */
  let installed: "text" | "cockpit" | null = null;
  let textBackend: TextBackend | null = null;
  let drawing: Promise<void> | null = null;
  let redrawQueued = false;

  // While the exit dialog may be on screen (asked, no input since) no timer or poll may draw: a page call could
  // cover it. The back signal restores the page the way of the first one (step log Klipper 0.5.11).
  let exitDialogAsked = false;
  let dialogPending = false;
  let dialogShown = false;
  const tiles = createTileSender(COCKPIT_TILES, guardedTileSend(bridge, () => !exitDialogAsked && !closed && installed === "cockpit"));

  const sameView = (a: TextView | null, b: TextView): boolean => a !== null && a.header === b.header && a.footer === b.footer && a.body.join("|") === b.body.join("|");

  const textView = (state: ViewState): TextView => {
    if (screen === "apps") return appsView(state, appsCursor);
    if (screen === "dpad") return dpadView(state, dpadCursor);
    return startView(state, startCursor);
  };

  const drawOnce = async (): Promise<void> => {
    if (exitDialogAsked) return;
    const state = viewState();
    if (screen === "remote") {
      if (installed !== "cockpit") pageReady = false;
      if (!pageReady) {
        const result = await createCockpitPage(bridge);
        if (closed) return;
        if (!result.ok) { pageReady = false; console.warn("[tvglance] draw failed:", result.reason); return; }
        pageReady = true; installed = "cockpit"; lastView = null;
        tiles.reset();
      }
      textBackend ??= autoBackend();
      // Never awaited: a slow transfer must not hold up the next gesture.
      void tiles.push(composeCockpit(cockpitModel(state), textBackend));
      return;
    }
    const view = textView(state);
    if (installed === "cockpit") { installed = null; pageReady = false; }
    if (pageReady && sameView(lastView, view)) return;
    const result = pageReady ? await updateTextPage(bridge, view, lastView) : await createTextPage(bridge, view);
    if (closed) return;
    if (result.ok) { pageReady = true; installed = "text"; lastView = view; return; }
    pageReady = false;
    lastView = null;
    console.warn("[tvglance] draw failed:", result.reason);
  };

  /** One draw at a time; requests meanwhile collapse into one redraw. */
  const draw = (): Promise<void> => {
    if (exitDialogAsked) return Promise.resolve();
    if (closed || !ready) return Promise.resolve();
    if (drawing) { redrawQueued = true; return drawing; }
    drawing = (async () => {
      try {
        do { redrawQueued = false; await drawOnce(); } while (redrawQueued && !closed);
      } catch (error) {
        console.warn("[tvglance] draw failed:", error);
      } finally {
        drawing = null;
      }
    })();
    return drawing;
  };

  let refreshPhone: () => void = () => undefined;
  let phoneSignature = "";
  const updatePhone = (force = false): void => {
    const signature = JSON.stringify([phoneConnection(), tv, locale, settings, relayState]);
    if (!force && signature === phoneSignature) return;
    const active = (globalThis.document as Document | undefined)?.activeElement as HTMLElement | null | undefined;
    if (!force && active?.matches?.("#app input, #app select, #app textarea")) return;
    phoneSignature = signature;
    refreshPhone();
  };
  const phoneConnection = (): PhoneConnection => {
    if (demoActive) return { kind: "demo" };
    switch (connection.kind) {
      case "loading": return { kind: "loading" };
      case "ok": return { kind: "ok" };
      case "error": return { kind: "error", reason: errorReason(locale, connection.code, connection.status, true) };
    }
  };

  const poll = async (): Promise<void> => {
    const current = backend;
    if (closed) return;
    // A live update during a read: read once more afterwards, so the change is not missed.
    if (polling) { pollAgain = true; return; }
    polling = true;
    const startedIn = generation;
    let stale = false;
    try {
      const next = await current.state();
      if (closed) return;
      if (generation !== startedIn) stale = true;
      else { tv = next; connection = { kind: "ok" }; }
    } catch (error) {
      if (closed) return;
      if (generation !== startedIn) stale = true;
      else {
        const problem = toApiError(error);
        connection = { kind: "error", code: problem.code, ...(problem.status ? { status: problem.status } : {}) };
      }
    } finally {
      polling = false;
    }
    // Overtaken by a device switch or new settings: read again for the current target.
    if (stale) { pollAgain = false; void poll(); return; }
    updatePhone();
    await draw();
    if (pollAgain && !closed) { pollAgain = false; void poll(); }
  };

  const pollSoon = (): void => {
    clearTimeout(soonTimer);
    soonTimer = setTimeout(() => { void poll(); }, AFTER_COMMAND_MS);
  };

  const showFlash = (text: string): void => {
    flash = { text, until: Date.now() + FLASH_MS };
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { flash = null; void draw(); }, FLASH_MS + 20);
  };

  /** Sends one command; the result shows as a short line, then the TV is asked again. */
  const run = async (what: string | null, action: (target: TvBackend) => Promise<void>): Promise<void> => {
    const target = backend;
    const startedIn = generation;
    // An unavailable device (projector asleep, TV unplugged) takes nothing: say so instead of sending.
    if (tv?.unavailable) {
      showFlash(t(locale, "g.failed", { reason: errorReason(locale, "unavailable") }));
      void draw();
      return;
    }
    try {
      await action(target);
      if (generation === startedIn && what) showFlash(t(locale, "g.sent", { what }));
    } catch (error) {
      if (generation === startedIn) showFlash(t(locale, "g.failed", { reason: errorReason(locale, toApiError(error).code) }));
    }
    if (closed || generation !== startedIn) return;
    pollSoon();
    void draw();
  };

  // Swipes in the remote are collected (VOLUME_SETTLE_MS) and sent as one burst of steps.
  const stepper = createVolumeStepper((steps) => {
    void run(null, async (target) => {
      for (let index = 0; index < Math.abs(steps); index += 1) await target.volumeStep(steps > 0 ? 1 : -1);
      // The TV's value is read again shortly; until then the steps count as done.
      if (tv && tv.volume !== null) tv = { ...tv, volume: Math.max(0, Math.min(100, tv.volume + steps)) };
    });
  });

  const makeBackend = (): TvBackend => {
    (backend as { close?: () => void }).close?.();
    demoActive = false;
    if (!DEMO && isConfigured(settings)) {
      if (settings.backend === "ha") {
        const active = activeDeviceOf(settings);
        if (active) {
          // Every configured device is subscribed, so a switch shows live state at once.
          const ha = createHaBackend({
            baseUrl: effectiveHaUrl(settings), token: effectiveHaToken(settings), entityId: active.entityId, remoteId: active.remoteId,
            devices: settings.devices.map((d) => ({ entityId: d.entityId, remoteId: d.remoteId })),
          });
          // Live updates over the WebSocket subscription: redraw as soon as the TV changes.
          ha.watch(() => { if (backend === ha) void poll(); });
          return ha;
        }
      } else {
        return createBridgeBackend({ baseUrl: settings.bridgeUrl, ...(settings.bridgeToken ? { token: settings.bridgeToken } : {}) });
      }
    }
    // Nothing (or no TV) set up yet: a demo TV instead of an empty page (store review), labelled DEMO.
    demoActive = true;
    return createDemo();
  };

  const startPolling = (): void => {
    clearInterval(pollTimer);
    void poll();
    pollTimer = setInterval(() => { void poll(); }, POLL_MS);
  };

  // Exit dialog, hardware order (skill 1a / Klipper 0.5.11): the promise only says "host call ok"; sysEvent 4 = the
  // dialog is up (draw nothing), 5 after "No" = the dialog is gone (page up again the way of the first one).
  let restoring: Promise<void> | null = null;
  const exitBack = (): void => {
    if (!exitDialogAsked) return;
    exitDialogAsked = false;
    if (closed) return;
    pageReady = false;
    lastView = null;
    installed = null;
    forgetPage(bridge);
    const pending = draw().catch(() => undefined);
    restoring = pending;
    void pending.then(() => { if (restoring === pending) restoring = null; });
  };
  const requestExit = (): void => {
    exitBack();
    const restore = restoring;
    const ask = async (): Promise<void> => {
      dialogPending = true;
      try {
        await bridge.shutDownPageContainer(1);
      } catch (error: unknown) {
        console.warn("[tvglance] exit failed:", error);
      }
      exitDialogAsked = true;
    };
    if (restore) void settleRestore(restore).then(ask);
    else void ask();
  };
  const shutDown = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(pollTimer);
    clearInterval(tickTimer);
    clearTimeout(soonTimer);
    clearTimeout(flashTimer);
    clearTimeout(armTimer);
    stepper.cancel();
    tiles.close();
    (backend as { close?: () => void }).close?.();
  };

  const move = (cursor: number, count: number, gesture: Gesture): number =>
    Math.max(0, Math.min(Math.max(0, count - 1), cursor + (gesture === "scrollDown" ? 1 : -1)));

  /** Start page, row "Device": the next device becomes the active one (wraps around) and is remembered. */
  const switchDevice = (): void => {
    const next = nextActive(settings);
    const device = settings.devices[next];
    if (demoActive || settings.backend !== "ha" || settings.devices.length < 2 || !device) return;
    settings = { ...settings, activeDevice: next };
    generation++;
    stepper.cancel();
    powerArm.disarm();
    (backend as Partial<HaBackend>).select?.(device.entityId, device.remoteId);
    tv = null;
    connection = { kind: "loading" };
    // The D-pad row comes and goes with the device: keep the cursor on the "Device" row.
    startCursor = Math.max(0, startRows(viewState()).indexOf("device"));
    void saveSettings(bridge, settings).catch((error: unknown) => console.warn("[tvglance] saving the device failed:", error));
    updatePhone(true);
    void poll();
    void draw();
  };

  const openStartRow = (): void => {
    const row = startRows(viewState())[startCursor];
    if (!row) return;
    if (row === "device") { switchDevice(); return; }
    screen = row;
    if (row === "apps") appsCursor = 0;
    if (row === "dpad") dpadCursor = 0;
  };

  const tapApps = (): void => {
    const state = viewState();
    const items = appsItems(state);
    const item = items[Math.min(appsCursor, items.length - 1)];
    if (!item) return;
    switch (item.kind) {
      case "power":
        if (item.on) { powerArm.disarm(); void run(appsItemLabel(locale, item), (target) => target.power(true)); return; }
        // Switching off asks: a second tap within POWER_ARM_MS.
        if (powerArm.tap(Date.now())) {
          clearTimeout(armTimer);
          void run(appsItemLabel(locale, item), (target) => target.power(false));
          return;
        }
        clearTimeout(armTimer);
        armTimer = setTimeout(() => { void draw(); }, POWER_ARM_MS + 50);
        void draw();
        return;
      case "mute":
        powerArm.disarm();
        void run(appsItemLabel(locale, item), (target) => target.mute(item.on));
        return;
      case "launch":
        powerArm.disarm();
        void run(item.entry.label, (target) => target.launch(item.entry));
        return;
    }
  };

  const onGesture = (gesture: Gesture): void => {
    // Only tap, swipe and 2× do something: a hold never reaches the app from the temple (skill 1).
    switch (screen) {
      case "start":
        switch (gesture) {
          case "click": openStartRow(); break;
          case "scrollDown": case "scrollUp": startCursor = move(startCursor, startRows(viewState()).length, gesture); break;
          case "doubleClick": requestExit(); return;
          default: return;
        }
        void draw();
        return;
      case "remote":
        switch (gesture) {
          case "click":
            if (tv?.power === "off") void run(t(locale, "g.list.powerOn"), (target) => target.power(true));
            else void run(null, (target) => target.playPause());
            return;
          // Swipe up = louder, down = quieter; the bar moves at once, the steps go out together.
          case "scrollUp": stepper.step(1); void draw(); return;
          case "scrollDown": stepper.step(-1); void draw(); return;
          case "doubleClick": screen = "start"; void draw(); return;
          default: return;
        }
      case "apps":
        switch (gesture) {
          case "click": tapApps(); return;
          case "scrollDown": case "scrollUp":
            powerArm.disarm();
            appsCursor = move(appsCursor, appsItems(viewState()).length, gesture);
            void draw();
            return;
          case "doubleClick":
            // An armed switch-off is cancelled first; otherwise back to the start page.
            if (powerArm.armed(Date.now())) powerArm.disarm();
            else screen = "start";
            void draw();
            return;
          default: return;
        }
      case "dpad":
        switch (gesture) {
          case "click": {
            const key = dpadItems()[dpadCursor];
            if (key) void run(t(locale, "g.key." + key), (target) => target.key(key));
            return;
          }
          case "scrollDown": case "scrollUp": dpadCursor = move(dpadCursor, dpadItems().length, gesture); void draw(); return;
          case "doubleClick": screen = "start"; void draw(); return;
          default: return;
        }
    }
  };

  bridge.onEvenHubEvent((event) => {
    if (closed) return;
    const systemType = (event as { sysEvent?: { eventType?: number } }).sysEvent?.eventType;
    if (systemType === 6 || systemType === 7) { shutDown(); return; }
    if (systemType === 4 && dialogPending) {
      dialogPending = false;
      dialogShown = true;
      exitDialogAsked = true;
      return;
    }
    if (systemType === 5 && dialogShown) {
      dialogShown = false;
      exitDialogAsked = true;
      exitBack();
      return;
    }
    if (systemType !== 8 && (event as { audioEvent?: unknown }).audioEvent === undefined) {
      dialogPending = false;
      dialogShown = false;
    }
    if (systemType !== 5) exitBack();
    // The glasses' side menu is off (SIDE_MENU): a menu click never runs anything.
    if (menuItemIdFromEvent(event) !== null) return;
    const parsed = gestureFromEvent(event, { invertScroll: settings.invertScroll });
    if (!parsed) return;
    if (!ready) { if (parsed.gesture === "doubleClick") requestExit(); return; }
    onGesture(parsed.gesture);
  });

  bridge.onDeviceStatusChanged((device) => {
    if (device?.connectType === "connected" && !closed) {
      pageReady = false;
      lastView = null;
      installed = null;
      void draw();
    }
  });

  settings = await loadSettings(bridge);
  locale = await resolveLocale(bridge);
  backend = makeBackend();
  connection = { kind: "loading" };
  ready = true;

  await draw();
  startPolling();
  tickTimer = setInterval(() => { void draw(); updatePhone(); if (relayState === "unreachable") void syncRelay(); }, TICK_MS);

  /** Stores new settings and, when the connection changed, builds the backend again. */
  const applySettings = async (next: Settings): Promise<void> => {
    await saveSettings(bridge, next);
    // Renaming a device changes no connection: only the player/remote pairs, the active one and the access matter.
    const identity = (s: Settings): string => JSON.stringify([s.backend, s.haUrl, s.haToken, s.devices.map((d) => [d.entityId, d.remoteId]), s.bridgeUrl, s.bridgeToken]);
    const changed = identity(next) !== identity(settings);
    const activeChanged = next.activeDevice !== settings.activeDevice;
    settings = next;
    if (!changed && activeChanged) {
      const active = activeDeviceOf(settings);
      if (active) (backend as Partial<HaBackend>).select?.(active.entityId, active.remoteId);
      generation++;
      tv = null;
      connection = { kind: "loading" };
      void poll();
    }
    if (changed) {
      generation++;
      stepper.cancel();
      powerArm.disarm();
      backend = makeBackend();
      tv = null;
      connection = { kind: "loading" };
      startCursor = Math.min(startCursor, startRows(viewState()).length - 1);
      if (screen === "dpad" && !backend.dpad) screen = "start";
      startPolling();
    }
    updatePhone(true);
    await draw();
  };

  /**
   * Relay builds: while no device is saved, the relay's list (`/config`) becomes the device list - no picking.
   * Unreachable shows as a status on the phone and is tried again with the clock tick.
   */
  const syncRelay = async (): Promise<void> => {
    if (!BUILD_HA_RELAY || closed || DEMO) return;
    if (settings.devices.length > 0) { relayState = "ok"; return; }
    relayState = "checking";
    let found: Awaited<ReturnType<typeof fetchRelayDevices>> | null = null;
    try {
      found = await fetchRelayDevices(BUILD_HA_RELAY);
    } catch {
      found = null;
    }
    if (closed) return;
    relayState = found === null ? "unreachable" : found.length === 0 ? "empty" : "ok";
    const next = found ? importRelayDevices(settings, found) : settings;
    if (next !== settings) {
      await applySettings(next).catch((error: unknown) => console.warn("[tvglance] saving the relay devices failed:", error));
      return;
    }
    updatePhone(true);
    void draw();
  };

  const phone = mountPhoneUi({
    getSettings: () => settings,
    saveSettings: applySettings,
    connection: phoneConnection,
    state: viewState,
    refresh: () => { void poll(); },
    listEntities: (url, token) => listHaEntities({ baseUrl: url, token }),
    relayState: () => relayState,
    origin: () => globalThis.location?.origin ?? "",
    locale: () => locale,
    onLocaleChange: (next) => {
      locale = next;
      rememberLocale(bridge, next);
      void draw();
    },
    build: BUILD,
  });
  refreshPhone = phone.refresh;
  void syncRelay();
  console.info("[tvglance] " + BUILD + (demoActive ? " demo" : " " + backend.kind));
}

void boot().catch((error: unknown) => {
  console.error("[tvglance] failed to start:", error);
});
