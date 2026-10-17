import { AppLocationAccuracy, AudioInputSource, waitForEvenAppBridge, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { settleRestore } from "./exit";
import { createClient, toApiError, type ShootDayApi } from "./api/client";
import { createDemoApi } from "./api/demo";
import type { Brief, CallSheet, CustomerItem, CustomerList, EquipmentItem, ProjectItem, Shot, Storyboard, Take, TakeStatus } from "./api/types";
import { rememberLocale, resolveLocale, type Locale } from "./i18n";
import { gestureFromEvent, menuItemIdFromEvent, type Gesture } from "./input/gestures";
import { takeNotes, t } from "./messages";
import { sameView } from "./glasses/diff";
import { LIGHT_TILES, createPage, forgetPage, installLightPage, rebuildPage, sendTile, setPageMenu, updatePage, type Layout, type MenuSpec } from "./glasses/render";
import { createTileSender } from "./screen/sender";
import { autoBackend, type TextBackend } from "./screen/text";
import { composeLight } from "./sun/compose";
import { lightAt, place as validPlace, type Place } from "./sun/light";
import { lightModel, sheetPlace, type PlaceSource } from "./sun/model";
import { PULSE_MS, dayBarFrame, headerIcon } from "./glasses/charts";
import { bitmapKey } from "./glasses/gfx";
import { wrap, type ScreenView } from "./glasses/screen";
import {
  briefPages, buildView, CUSTOMER_MENU, errorText, menuFor, SCHEDULE_BODY_ROWS, SIDE_MENU, TAKE_ACTIONS,
  type ArmKind, type LastTake, type LoadStatus, type Mode, type Module, type RecTarget, type TakeScreen, type ViewState,
} from "./glasses/views";
import {
  ROLLING_MAX_MS, UI_KEY, effectiveUrl, loadOutbox, loadSettings, parseUi, saveOutbox, saveSettings, type PendingTake, type SavedUi, type Settings,
} from "./storage/persist";
import { lifecycleFromEvent } from "./lifecycle";
import { mountPhoneUi, type ConnectionState } from "./ui/phone";
import { parsePackCommand } from "./voice/pack-voice";
import { parseTakeCommand } from "./voice/take-voice";
import { parseCustomerName, sameCustomerName } from "./voice/customer-voice";
import { concat, pcmToWav, toPcm } from "./voice/wav";
import { MAX_COMMAND_MS, liveSttUrl, openLiveStt, type LiveSession } from "./voice/live-stt";

const DEMO = new URLSearchParams(globalThis.location?.search ?? "").get("demo") === "1";

/** Teleprompter step; the view only changes when a new line comes up. */
const PROMPTER_TICK_MS = 200;
/** The schedule's "now / next" lines depend on the clock. */
const CLOCK_TICK_MS = 30_000;
/** A feedback line stays this long. */
const MESSAGE_MS = 6_000;
/** A guard against a lost release event: the microphone never stays on longer than this. */
const MAX_RECORD_MS = MAX_COMMAND_MS;
/** 16 kHz × 2 bytes × 121 s — anything beyond is dropped, never buffered. */
const MAX_PCM_BYTES = 16_000 * 2 * (MAX_RECORD_MS / 1000 + 1);
/** Live text on the glasses is redrawn at most this often. */
const LIVE_REDRAW_MS = 300;
/** Private builds name their live speech recogniser (`VITE_LIVE_STT_URL=wss://host:port`); public builds leave it empty. */
const LIVE_STT_DEFAULT = (import.meta.env.VITE_LIVE_STT_URL as string | undefined) ?? "";
/** Shorter than this is a slip of the finger, not a sentence. */
const MIN_PCM_BYTES = 16_000 * 2 / 5;
/** Takes logged offline are tried again this often while any are waiting. */
const OUTBOX_RETRY_MS = 60_000;
/** QIS v1: an armed action (cancel a take, tick everything) waits this long for its second tap. */
const ARM_MS = 4_000;
/** The phone's location answer is waited for at most this long (the SDK's own timeout is only a hint). */
const LOCATION_TIMEOUT_MS = 10_000;
/** Last known place (rounded to ~1 km), so the light view works without a fresh fix. */
const PLACE_KEY = "quietglass.shootday.place.v1";
/** ?demo=1 without a phone location: a sample place so the light view can be tried in the simulator. */
const DEMO_PLACE: Place = { latitude: 47.8, longitude: 13.04 };
/** One swipe on the light view moves the time shown by this much; at most a day either way. */
const LIGHT_STEP_MIN = 30;
const LIGHT_MAX_MIN = 24 * 60;
/** Side menu (QIS v1.2): item ids. */
const MENU_HELP = 1;
const MENU_DEL_TAKE = 2;
const MENU_SEND_REC = 3;
const MENU_DISCARD_REC = 4;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error: unknown) => { clearTimeout(timer); reject(error); });
  });
}

type LoadKind = Exclude<Mode, "help">;

interface Recording {
  readonly id: number;
  readonly target: RecTarget;
  readonly via: "tap" | "hold";
  phase: "opening" | "listening" | "transcribing";
  stopRequested: boolean;
  chunks: Uint8Array[];
  bytes: number;
  timer?: ReturnType<typeof setTimeout>;
  /** Live transcription while speaking; null without a live recogniser. */
  live: LiveSession | null;
  /** What the live recogniser heard so far. */
  text: string;
}

async function boot(): Promise<void> {
  const bridge: EvenAppBridge = await waitForEvenAppBridge();

  let settings: Settings = await loadSettings(bridge);
  let outbox: PendingTake[] = await loadOutbox(bridge);
  let locale: Locale = await resolveLocale(bridge);

  /** Demo: `?demo=1`, or nothing configured yet (QIS v1.2 no. 7). The first saved server address ends it. */
  const isDemo = (): boolean => DEMO || effectiveUrl(settings) === "";
  /** QIS v1.2: help, undo of the last take and the kept recording live in the glasses' side menu. */
  const menuSpec = (): MenuSpec => ({
    items: [
      { id: MENU_HELP, label: t(locale, "m.help") },
      { id: MENU_DEL_TAKE, label: t(locale, "m.delTake") },
      { id: MENU_SEND_REC, label: t(locale, "m.sendRec") },
      { id: MENU_DISCARD_REC, label: t(locale, "m.discardRec") },
    ],
  });
  setPageMenu(menuSpec());

  const makeApi = (): ShootDayApi | null => {
    if (isDemo()) return createDemoApi(locale);
    const url = effectiveUrl(settings);
    if (!url) return null;
    return createClient({ baseUrl: url, ...(settings.token ? { token: settings.token } : {}) });
  };
  let api = makeApi();

  // ---- state -------------------------------------------------------------
  let closed = false;
  /** Bumped on every module change and settings change: replies from before are dropped. */
  let generation = 0;
  let mode: Mode = "menu";
  let menuCursor = 0;
  const load = new Map<LoadKind, LoadStatus>();
  /** Last failure talking to the server; localised only when shown. */
  let connectionError: { readonly code: string; readonly status?: number } | null = null;
  let connected = false;
  let message = "";
  let messageTimer: ReturnType<typeof setTimeout> | undefined;

  let project = "";
  let shots: Shot[] = [];
  let serverTakes: Take[] = [];
  let shotCursor = 0;
  let takeScreen: TakeScreen = "card";
  let actionCursor = 0;
  let noteCursor = 0;
  /** When the running take started; null while no take runs. */
  let rollingSince: number | null = null;
  /** The shot the running take belongs to ("scene\0shot"): a swipe or a 2× leaves it running. */
  let rollingKey: string | null = null;

  let prompterLines: string[] = [];
  let prompterPos = 0;
  let prompterSpeed = 0.4;
  let playing = false;
  let prompterTimer: ReturnType<typeof setInterval> | undefined;

  let sheet: CallSheet = { date: "", call: "", location: "", contact: "", notes: "", schedule: [] };
  let scheduleScroll = 0;

  let equipment: EquipmentItem[] = [];
  let packCursor = 0;
  let showMissing = false;

  // ---- customers → projects (server 0.5.0+) -------------------------------
  /** The server knows customers; until it has said so, the app behaves exactly as before. */
  let customerMode = false;
  /** Any gesture since the start: from then on the app never switches screens by itself. */
  let touched = false;
  let customerList: CustomerItem[] = [];
  /** 0 = "+ new customer", 1… = customerList. */
  let customerCursor = 0;
  /** A name heard for a new customer, waiting for the confirming tap. */
  let pendingCustomer: string | null = null;
  /** Put the cursor on this customer once the list has (re)loaded. */
  let wantedCustomer = "";
  let customer: CustomerItem | null = null;
  let activeProjectId = "";
  let activeCustomerId = "";
  let projectList: ProjectItem[] = [];
  /** 0 = the card before the appointment, 1… = projectList. */
  let projectCursor = 0;
  let resetProjectCursor = true;
  let brief: Brief | null = null;
  let briefPage = 0;
  let boards: Storyboard[] = [];
  let boardIndex = 0;
  let sceneCursor = 0;
  let boardPicking = false;

  /** Minutes the light view looks ahead (or back) of now. */
  let lightOffset = 0;
  let phonePlace: Place | null = null;
  let savedPlace: Place | null = null;
  try {
    const saved = JSON.parse((await bridge.getLocalStorage(PLACE_KEY).catch(() => "")) || "null") as { latitude?: unknown; longitude?: unknown } | null;
    savedPlace = saved ? validPlace(saved.latitude, saved.longitude) : null;
  } catch {
    savedPlace = null;
  }
  let textBackend: TextBackend | null = null;

  let rec: Recording | null = null;
  let recIds = 0;
  /** An action waiting for its second tap (QIS v1: arm, then confirm within ARM_MS). */
  let armed: { readonly kind: ArmKind; readonly until: number } | null = null;
  let armTimer: ReturnType<typeof setTimeout> | undefined;
  /** A dictation left with 2× (QIS v1.2 no. 2): kept until it is sent from the menu or discarded (armed first). */
  let parked: { readonly target: RecTarget; readonly pcm: Uint8Array; readonly text: string } | null = null;
  /** The side-menu help opens over any screen and goes back to it. */
  let helpBack: LoadKind = "menu";
  /** Left through the system: no microphone, no timers, no drawing until the app is back. */
  let backgrounded = false;
  /** The shot to return to once the shot list has loaded (after a restart). */
  let wantedShot: { scene: string; shot: string } | null = null;

  // Back where the user was before a restart (phone locked, app unloaded).
  const savedUi: SavedUi | null = isDemo() ? null : parseUi(await bridge.getLocalStorage(UI_KEY).catch(() => "") ?? "");
  if (savedUi) {
    menuCursor = savedUi.menuCursor;
    prompterSpeed = savedUi.prompterSpeed;
    packCursor = savedUi.packCursor;
    scheduleScroll = savedUi.scheduleScroll;
    wantedShot = savedUi.shot;
  }
  let lastSavedUi = "";
  const saveUi = (): void => {
    if (isDemo()) return;
    const shot = shots[shotCursor];
    const ui: SavedUi = {
      // The lists above the project are cheap to reach again; a restart starts at the menu (or the customer list).
      mode: mode === "customers" || mode === "projects" || mode === "brief" || mode === "help" ? "menu" : mode,
      menuCursor,
      shot: shot ? { scene: shot.scene, shot: shot.shot } : wantedShot,
      rollingSince: rollingHere() ? rollingSince : null,
      prompterPos,
      prompterSpeed,
      packCursor,
      scheduleScroll,
    };
    const json = JSON.stringify(ui);
    if (json === lastSavedUi) return;
    lastSavedUi = json;
    void bridge.setLocalStorage(UI_KEY, json).catch(() => false);
  };
  /** After a load: the remembered shot wins over the cursor. */
  const placeWantedShot = (): void => {
    if (!wantedShot) return;
    const index = shots.findIndex((shot) => shot.scene === wantedShot?.scene && shot.shot === wantedShot?.shot);
    if (index >= 0) shotCursor = index;
    wantedShot = null;
  };

  const needed = (): EquipmentItem[] => equipment.filter((item) => item.need);
  const notes = (): string[] => takeNotes(locale);

  // ---- background work never leaves a rejection unhandled ----------------
  const background = (task: Promise<unknown>, what: string): void => {
    task.catch((error: unknown) => { console.warn("[shootday] " + what + " failed:", error); });
  };

  /** Writes run one after another, in the order they were made. */
  let writes: Promise<void> = Promise.resolve();
  const queueWrite = (task: () => Promise<void>, what: string): Promise<void> => {
    const next = writes.then(task).catch((error: unknown) => { console.warn("[shootday] " + what + " failed:", error); });
    writes = next;
    return next;
  };

  const say = (text: string): void => {
    message = text;
    clearTimeout(messageTimer);
    if (text) messageTimer = setTimeout(() => { message = ""; void draw(); }, MESSAGE_MS);
  };

  // ---- takes -------------------------------------------------------------
  const takeKey = (scene: string, shot: string): string => scene + "\u0000" + shot;
  /** The running take belongs to the shot on screen (and was not forgotten hours ago). */
  function rollingHere(): boolean {
    const shot = shots[shotCursor];
    if (rollingSince === null || rollingKey === null || !shot) return false;
    if (Date.now() - rollingSince > ROLLING_MAX_MS) return false;
    return takeKey(shot.scene, shot.shot) === rollingKey;
  }
  const stopRolling = (): void => { rollingSince = null; rollingKey = null; };

  const liveArm = (): ArmKind | null => (armed && armed.until > Date.now() ? armed.kind : null);
  const disarm = (): void => { armed = null; clearTimeout(armTimer); armTimer = undefined; };
  const arm = (kind: ArmKind): void => {
    clearTimeout(armTimer);
    armed = { kind, until: Date.now() + ARM_MS };
    // Without input the question goes away on its own and the footer comes back.
    armTimer = setTimeout(() => { armed = null; armTimer = undefined; void draw(); }, ARM_MS + 20);
  };
  type TakeRow = LastTake & { readonly id?: string };
  const takesFor = (shot: Shot | undefined): TakeRow[] => {
    if (!shot) return [];
    const key = takeKey(shot.scene, shot.shot);
    const synced = serverTakes
      .filter((take) => takeKey(take.scene, take.shot) === key)
      .map((take) => ({ n: take.n, status: take.status, note: take.note, ts: take.ts, pending: false }));
    const waiting = outbox
      .filter((take) => take.project === project && takeKey(take.scene, take.shot) === key)
      .map((take, index) => ({ id: take.id, n: synced.length + index + 1, status: take.status, note: take.note, ts: take.ts, pending: true }));
    return [...synced, ...waiting];
  };

  const latestTake = (shot: Shot | undefined): TakeRow | null =>
    takesFor(shot).reduce<TakeRow | null>((latest, take) => (!latest || take.ts >= latest.ts ? take : latest), null);

  // ---- view --------------------------------------------------------------
  const helpLoad = (): LoadKind => helpBack;
  const currentLoad = (): LoadStatus => load.get(mode === "help" ? helpLoad() : mode) ?? { kind: "idle" };

  const viewState = (): ViewState => {
    const shot = shots[shotCursor];
    const all = takesFor(shot);
    const last = all.reduce<LastTake | null>((latest, take) => (!latest || take.ts >= latest.ts ? take : latest), null);
    return {
      locale,
      demo: isDemo(),
      configured: api !== null,
      now: new Date(),
      mode,
      menuCursor,
      project,
      pendingCount: outbox.length,
      load: mode === "menu" ? load.get("menu") ?? { kind: "idle" } : currentLoad(),
      message: message || (parked && !rec ? t(locale, "g.parked") : ""),
      rec: rec ? { target: rec.target, via: rec.via, busy: rec.phase === "transcribing", live: rec.text } : null,
      takes: {
        shots,
        cursor: shotCursor,
        screen: takeScreen,
        actionCursor,
        noteCursor,
        ok: all.filter((take) => take.status === "OK").length,
        ng: all.filter((take) => take.status === "NG").length,
        last,
        nextN: all.length + 1,
        rollingSince: rollingHere() ? rollingSince : null,
        notes: notes(),
      },
      prompter: { lines: prompterLines, pos: prompterPos, speed: prompterSpeed, playing },
      schedule: { sheet, scroll: scheduleScroll },
      pack: {
        items: needed(), cursor: packCursor, missing: showMissing,
      },
      ...(liveArm() !== null ? { armed: liveArm() as ArmKind } : {}),
      customerMode,
      customers: { list: customerList, cursor: customerCursor, pending: pendingCustomer },
      projects: { customer, list: projectList, cursor: projectCursor, active: activeProjectId },
      brief: { data: brief, page: briefPage },
      board: { boards, board: boardIndex, cursor: sceneCursor, picking: boardPicking },
    };
  };

  let lastView: ScreenView | null = null;
  let lastLayout: Layout | "light" = "plain";
  let lastFrames = "";
  let pageReady = false;
  let drawing: Promise<void> | null = null;
  let redrawQueued = false;

  // ---- light view: one full-screen frame, only changed tiles go out ------
  const lightSender = createTileSender(LIGHT_TILES, (slot, png) => sendTile(bridge, slot, png));

  /** Where the sun is computed for: the phone, else the shoot's place, else the last known place. */
  const lightPlace = (): { place: Place; source: PlaceSource } | null => {
    if (phonePlace) return { place: phonePlace, source: "phone" };
    const shoot = sheetPlace(sheet);
    if (shoot) return { place: shoot, source: "shoot" };
    if (savedPlace) return { place: savedPlace, source: "saved" };
    if (isDemo()) return { place: DEMO_PLACE, source: "demo" };
    return null;
  };

  const currentLight = (offsetMinutes: number) => {
    const now = Date.now();
    const where = lightPlace();
    return {
      where,
      model: lightModel({
        at: now + offsetMinutes * 60_000, now, place: where?.place ?? null, source: where?.source ?? null, locale,
        sheet: sheet.schedule.length > 0 || sheetPlace(sheet) ? sheet : null,
      }),
    };
  };

  const drawLight = async (): Promise<void> => {
    if (!pageReady || lastLayout !== "light") {
      const result = await installLightPage(bridge);
      if (!result.ok) { pageReady = false; lastView = null; console.warn("[shootday] light page failed:", result.reason); return; }
      pageReady = true; lastLayout = "light"; lastView = null; lastFrames = "";
      // A new page starts with blank images.
      lightSender.reset();
    }
    textBackend ??= autoBackend();
    // Never awaited: a slow transfer must not hold up the next gesture.
    void lightSender.push(composeLight(currentLight(lightOffset).model, textBackend));
  };

  // While the exit dialog may be on screen (asked, no input since) no timer, poll or stream may draw: a page call
  // could cover it. Data keeps being collected; the back signal restores the page the way of the first one.
  let exitDialogAsked = false;
  // The system dialog's own lifecycle (step log, Klipper 0.5.11): right after shutDownPageContainer(1) the glasses
  // send FOREGROUND_ENTER (4) when the dialog comes up and FOREGROUND_EXIT (5) when it goes away after "No" - not
  // the app entering or leaving. Between the call and the 5 nothing is drawn; the 5 puts the page up again.
  let dialogPending = false;
  let dialogShown = false;
  const drawOnce = async (): Promise<void> => {
    if (exitDialogAsked) return;
    if (mode === "light" && !rec) { await drawLight(); return; }
    const state = viewState();
    const view = buildView(state);
    const layout: Layout = mode === "schedule" && !rec ? "schedule" : "plain";
    const now = Date.now();
    const frames = {
      sign: headerIcon(mode, rollingHere(), now),
      bar: layout === "schedule" && currentLoad().kind === "ready"
        ? dayBarFrame(sheet, state.now.getHours() * 60 + state.now.getMinutes())
        : null,
    };
    const key = bitmapKey(frames.sign) + "|" + (frames.bar ? bitmapKey(frames.bar) : "-");
    if (pageReady && layout === lastLayout && sameView(lastView, view) && key === lastFrames) return;
    const result = !pageReady
      ? await createPage(bridge, view, layout, frames)
      : layout !== lastLayout
        ? await rebuildPage(bridge, view, layout, frames)
        : await updatePage(bridge, view, layout, frames, lastView);
    if (result.ok) { pageReady = true; lastView = view; lastLayout = layout; lastFrames = key; return; }
    pageReady = false;
    lastView = null;
    console.warn("[shootday] draw failed:", result.reason);
  };

  /** One draw at a time; requests made meanwhile collapse into one redraw. */
  const draw = (): Promise<void> => {
    if (exitDialogAsked) return Promise.resolve();
    if (closed || backgrounded) return Promise.resolve();
    if (drawing) { redrawQueued = true; return drawing; }
    drawing = (async () => {
      try {
        do {
          redrawQueued = false;
          await drawOnce();
        } while (redrawQueued && !closed);
      } catch (error) {
        console.warn("[shootday] draw failed:", error);
      } finally {
        drawing = null;
      }
    })();
    return drawing;
  };

  let refreshPhone: () => void = () => undefined;

  /** Positions to come back to after a restart, used once by the first load. */
  let resumePrompterAt: number | null = savedUi?.mode === "prompter" ? savedUi.prompterPos : null;
  let resumeScheduleAt: number | null = savedUi?.mode === "schedule" ? savedUi.scheduleScroll : null;

  // ---- loading: one request per kind, stale replies dropped --------------
  const inflight = new Map<LoadKind, Promise<void>>();
  const reloadWanted = new Set<LoadKind>();

  const fail = (kind: LoadKind, error: unknown): void => {
    const problem = toApiError(error);
    load.set(kind, { kind: "error", code: problem.code, ...(problem.status ? { status: problem.status } : {}) });
    if (kind === "menu" || kind === "takes" || kind === "customers") {
      connectionError = { code: problem.code, ...(problem.status ? { status: problem.status } : {}) };
      connected = false;
    }
  };

  /** A fresh customer list; the cursor stays on the same customer (or goes to the wanted one). */
  const applyCustomers = (next: CustomerList): void => {
    const before = customerList[customerCursor - 1]?.id ?? "";
    customerList = [...next.customers];
    activeProjectId = next.activeProject;
    activeCustomerId = next.activeCustomer;
    const target = wantedCustomer || before;
    const at = target ? customerList.findIndex((c) => c.id === target) : -1;
    if (at >= 0) customerCursor = at + 1;
    wantedCustomer = "";
    customerCursor = Math.min(customerCursor, customerList.length + 1);
    if (customer) customer = customerList.find((c) => c.id === customer?.id) ?? customer;
  };

  const fetchers: Record<LoadKind, (client: ShootDayApi, stillCurrent: () => boolean) => Promise<void>> = {
    customers: async (client, stillCurrent) => {
      const next = await client.customers();
      if (!stillCurrent()) return;
      applyCustomers(next);
    },
    projects: async (client, stillCurrent) => {
      const target = customer;
      if (!target) return;
      const next = await client.customer(target.id);
      if (!stillCurrent()) return;
      customer = next.customer;
      projectList = [...next.projects];
      if (resetProjectCursor) {
        // On the project the glasses work on, else on the card before the appointment.
        const at = projectList.findIndex((item) => item.id === activeProjectId);
        projectCursor = at >= 0 ? at + 1 : 0;
        resetProjectCursor = false;
      }
      projectCursor = Math.min(projectCursor, projectList.length);
    },
    brief: async (client, stillCurrent) => {
      const target = customer;
      if (!target) return;
      const next = await client.brief(target.id);
      if (!stillCurrent()) return;
      brief = next;
      briefPage = Math.min(briefPage, briefPages(locale, next) - 1);
    },
    board: async (client, stillCurrent) => {
      const next = await client.storyboards();
      if (!stillCurrent()) return;
      const before = boards[boardIndex]?.id;
      boards = next.filter((board) => board.scenes.length > 0);
      const again = before ? boards.findIndex((board) => board.id === before) : -1;
      if (again >= 0) boardIndex = again;
      else {
        // A new start: one storyboard opens at once, several ask which one.
        boardIndex = 0;
        sceneCursor = 0;
        boardPicking = boards.length > 1;
      }
      sceneCursor = Math.min(sceneCursor, Math.max(0, (boards[boardIndex]?.scenes.length ?? 1) - 1));
    },
    menu: async (client, stillCurrent) => {
      const list = await client.shotList();
      if (!stillCurrent()) return;
      project = list.project;
      shots = [...list.shots];
      placeWantedShot();
      shotCursor = Math.min(shotCursor, Math.max(0, shots.length - 1));
    },
    takes: async (client, stillCurrent) => {
      const list = await client.shotList();
      const taken = await client.takes();
      if (!stillCurrent()) return;
      if (list.project !== project) shotCursor = 0;
      project = list.project;
      shots = [...list.shots];
      serverTakes = taken;
      placeWantedShot();
      shotCursor = Math.min(shotCursor, Math.max(0, shots.length - 1));
    },
    prompter: async (client, stillCurrent) => {
      const text = await client.prompter();
      if (!stillCurrent()) return;
      prompterLines = text.trim() ? wrap(text) : [];
      // Back after a restart: the same line, paused.
      prompterPos = resumePrompterAt !== null ? Math.min(resumePrompterAt, Math.max(0, prompterLines.length - 1)) : 0;
      resumePrompterAt = null;
      playing = false;
    },
    schedule: async (client, stillCurrent) => {
      const next = await client.callSheet();
      if (!stillCurrent()) return;
      sheet = next;
      scheduleScroll = resumeScheduleAt ?? 0;
      resumeScheduleAt = null;
    },
    pack: async (client, stillCurrent) => {
      const next = await client.equipment();
      if (!stillCurrent()) return;
      equipment = [...next.items];
      packCursor = Math.min(packCursor, Math.max(0, needed().length - 1));
    },
    // The light view works offline; the schedule only adds the next shoot (and maybe its place).
    light: async (client, stillCurrent) => {
      const next = await client.callSheet();
      if (!stillCurrent()) return;
      sheet = next;
    },
  };

  const requestLoad = (kind: LoadKind): void => {
    const client = api;
    if (closed || !client) return;
    if (inflight.has(kind)) { reloadWanted.add(kind); return; }
    const startedIn = generation;
    const stillCurrent = (): boolean => !closed && generation === startedIn && api === client;
    if (load.get(kind)?.kind !== "ready") load.set(kind, { kind: "loading" });
    void draw();
    const run = (async () => {
      try {
        await fetchers[kind](client, stillCurrent);
        if (!stillCurrent()) return;
        load.set(kind, { kind: "ready" });
        if (kind === "menu" || kind === "takes" || kind === "customers") { connectionError = null; connected = true; }
        if (kind === "takes" || kind === "menu") flushOutbox();
      } catch (error) {
        if (!stillCurrent()) return;
        fail(kind, error);
      }
      refreshPhone();
      await draw();
    })().catch((error: unknown) => { console.warn("[shootday] load failed:", error); }).finally(() => {
      inflight.delete(kind);
      // Left and came back while this was running: its answer was dropped, so load again.
      if (reloadWanted.delete(kind) && !closed && (mode === kind || kind === "menu")) requestLoad(kind);
    });
    inflight.set(kind, run);
  };

  // ---- the take outbox ---------------------------------------------------
  let flushing = false;
  const persistOutbox = (): void => { background(saveOutbox(bridge, outbox), "saving the outbox"); };

  const flushOutbox = (): void => {
    const client = api;
    if (flushing || !client || closed) return;
    const ready = outbox.filter((take) => take.project === project);
    if (ready.length === 0) return;
    flushing = true;
    void queueWrite(async () => {
      try {
        for (const pending of ready) {
          if (api !== client || closed) return;
          const saved = await client.addTake({ scene: pending.scene, shot: pending.shot, status: pending.status, note: pending.note });
          outbox = outbox.filter((take) => take.id !== pending.id);
          serverTakes = [...serverTakes, saved];
          persistOutbox();
        }
      } catch {
        // Still offline: they stay queued for the next successful contact.
      } finally {
        flushing = false;
        refreshPhone();
        void draw();
      }
    }, "sending queued takes");
  };

  const addTake = (status: TakeStatus, note = ""): void => {
    const shot = shots[shotCursor];
    const client = api;
    if (!shot || !client) return;
    // A logged take is a finished take (the running one of this shot, not one on another shot).
    if (rollingHere()) stopRolling();
    const pending: PendingTake = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      project, scene: shot.scene, shot: shot.shot, status, note, ts: Date.now(),
    };
    // Into the outbox first: should the app close mid-request, the take is not lost.
    outbox = [...outbox, pending];
    persistOutbox();
    const label = `${shot.scene}${shot.shot} T${takesFor(shot).length} ${status}${note ? " " + note : ""}`;
    void queueWrite(async () => {
      try {
        const saved = await client.addTake({ scene: shot.scene, shot: shot.shot, status, note });
        outbox = outbox.filter((take) => take.id !== pending.id);
        if (api === client) serverTakes = [...serverTakes, saved];
        persistOutbox();
        say(t(locale, "g.msg.saved", { what: label }));
      } catch {
        say(t(locale, "g.msg.queued"));
      }
      refreshPhone();
      await draw();
    }, "logging a take");
  };

  const setLastNote = (picked: string): void => {
    const shot = shots[shotCursor];
    const all = takesFor(shot);
    const last = all.reduce<(typeof all)[number] | null>((latest, take) => (!latest || take.ts >= latest.ts ? take : latest), null);
    if (!shot || !last) return;
    const note = picked.startsWith("(") ? "" : picked;
    say(t(locale, "g.msg.note", { note: note || "–" }));
    if (last.pending) {
      outbox = outbox.map((take) => (take.id === last.id ? { ...take, note } : take));
      persistOutbox();
      return;
    }
    serverTakes = serverTakes.map((take) =>
      take.scene === shot.scene && take.shot === shot.shot && take.n === last.n ? { ...take, note } : take);
    const client = api;
    if (!client) return;
    void queueWrite(async () => {
      try {
        await client.setTakeNote(shot.scene, shot.shot, last.n, note);
      } catch (error) {
        const problem = toApiError(error);
        say(t(locale, "g.msg.notSaved", { reason: t(locale, "g.err." + problem.code, { status: problem.status }) }));
        await draw();
      }
    }, "saving a note");
  };

  // ---- packing list ------------------------------------------------------
  const setPacked = (name: string, packed: boolean, announce: boolean): Promise<void> => {
    const client = api;
    equipment = equipment.map((item) => (item.name === name ? { ...item, packed } : item));
    if (announce) say(t(locale, packed ? "g.pack.ticked" : "g.pack.unticked", { name }));
    void draw();
    if (!client) return Promise.resolve();
    return queueWrite(async () => {
      try {
        await client.setPacked(name, packed);
      } catch (error) {
        // Show what is true: the tick did not reach the server, so take it back.
        if (api === client) equipment = equipment.map((item) => (item.name === name && item.packed === packed ? { ...item, packed: !packed } : item));
        const problem = toApiError(error);
        say(t(locale, "g.msg.notSaved", { reason: t(locale, "g.err." + problem.code, { status: problem.status }) }));
        await draw();
      }
    }, "saving the packing list");
  };

  const applyPackCommand = (text: string): void => {
    const items = needed();
    const command = parsePackCommand(text, items.map((item) => item.name));
    switch (command.kind) {
      case "missing":
        showMissing = true;
        say("");
        break;
      case "all":
        // One misheard sentence must not tick (or clear) the whole list: it is armed, a second tap carries it out.
        arm(command.packed ? "packAll" : "packReset");
        say("");
        break;
      case "item": {
        const item = items[command.index];
        if (!item) break;
        packCursor = command.index;
        void setPacked(item.name, command.packed, true);
        break;
      }
      case "unknown":
        say(t(locale, "g.msg.unknown", { text: text.slice(0, 24) }));
        break;
    }
  };

  const applyTakeCommand = (text: string): void => {
    const command = parseTakeCommand(text, shots, shotCursor, notes());
    if (command.index !== null) shotCursor = command.index;
    const shot = shots[shotCursor];
    takeScreen = "card";
    if (command.status) { addTake(command.status, command.note); return; }
    if (command.index !== null && shot) { say(t(locale, "g.msg.moved", { scene: shot.scene, shot: shot.shot })); return; }
    say(t(locale, "g.msg.unknown", { text: text.slice(0, 24) }));
  };

  // ---- customers by voice ------------------------------------------------
  const applyCustomerName = (text: string): void => {
    const name = parseCustomerName(text);
    if (!name) { say(t(locale, "g.msg.nothing")); return; }
    // Said twice, or already there: go to it instead of a second entry.
    const existing = customerList.findIndex((c) => sameCustomerName(c.name, name));
    if (existing >= 0) { customerCursor = existing + 1; say(t(locale, "g.cust.exists", { name: customerList[existing]?.name ?? name })); return; }
    pendingCustomer = name;
    say("");
  };

  const createCustomer = (name: string): void => {
    const client = api;
    if (!client) return;
    pendingCustomer = null;
    say(t(locale, "g.loading"));
    void draw();
    void queueWrite(async () => {
      try {
        const created = await client.createCustomer(name);
        if (api !== client) return;
        customerList = [...customerList, created];
        customerCursor = customerList.length;
        wantedCustomer = created.id;
        say(t(locale, "g.cust.created", { name: created.name }));
        requestLoad("customers");
      } catch (error) {
        // Nothing is lost: the name waits for the next tap.
        pendingCustomer = name;
        const problem = toApiError(error);
        say(t(locale, "g.msg.notSaved", { reason: t(locale, "g.err." + problem.code, { status: problem.status }) }));
      }
      await draw();
    }, "creating a customer");
  };

  // ---- storyboard ----------------------------------------------------------
  const toggleScene = (): void => {
    const board = boards[boardIndex];
    const scene = board?.scenes[sceneCursor];
    const client = api;
    if (!board || !scene) return;
    const index = sceneCursor;
    const done = !scene.done;
    const patch = (value: boolean): void => {
      boards = boards.map((b) => (b.id !== board.id ? b : { ...b, scenes: b.scenes.map((s, i) => (i === index ? { ...s, done: value } : s)) }));
    };
    patch(done);
    say(t(locale, done ? "g.board.marked" : "g.board.unmarked", { n: scene.n }));
    void draw();
    if (!client) return;
    void queueWrite(async () => {
      try {
        await client.setSceneDone(board.id, index, done);
      } catch (error) {
        // Show what is true: the tick did not reach the server.
        if (api === client) patch(!done);
        const problem = toApiError(error);
        say(t(locale, "g.msg.notSaved", { reason: t(locale, "g.err." + problem.code, { status: problem.status }) }));
        await draw();
      }
    }, "saving a scene");
  };

  // ---- microphone --------------------------------------------------------
  const MIC_DRAIN_MS = 150;
  const micOff = async (): Promise<void> => {
    await bridge.audioControl(false).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, MIC_DRAIN_MS));
  };

  let liveDrawAt = 0;
  let liveDrawTimer: ReturnType<typeof setTimeout> | undefined;
  /** Live text redraws at most every LIVE_REDRAW_MS. */
  const drawLive = (): void => {
    if (liveDrawTimer) return;
    const wait = Math.max(0, liveDrawAt + LIVE_REDRAW_MS - Date.now());
    liveDrawTimer = setTimeout(() => { liveDrawTimer = undefined; liveDrawAt = Date.now(); if (!closed) void draw(); }, wait);
  };

  const startLive = (current: Recording): LiveSession | null => {
    const url = isDemo() ? "" : liveSttUrl(undefined, LIVE_STT_DEFAULT);
    if (!url) return null;
    return openLiveStt({
      url,
      language: locale,
      onText: (text) => {
        if (rec !== current || current.phase !== "listening" || closed) return;
        current.text = text;
        drawLive();
      },
    });
  };

  const startRec = async (target: RecTarget, via: "tap" | "hold"): Promise<void> => {
    if (rec || closed || !api) return;
    disarm();
    const current: Recording = { id: ++recIds, target, via, phase: "opening", stopRequested: false, chunks: [], bytes: 0, live: null, text: "" };
    rec = current;
    say("");
    await draw();
    const ok = await bridge.audioControl(true, AudioInputSource.Glasses).catch(() => false);
    if (rec !== current || closed) {
      // Cancelled or closed while the microphone was opening: it must not stay on.
      if (ok) await micOff();
      return;
    }
    if (!ok) {
      rec = null;
      say(t(locale, "g.msg.micOff"));
      await draw();
      return;
    }
    current.phase = "listening";
    current.live = startLive(current);
    current.timer = setTimeout(() => { background(stopRec(), "stopping the microphone"); }, MAX_RECORD_MS);
    if (current.stopRequested) await stopRec();
  };

  const stopRec = async (): Promise<void> => {
    const current = rec;
    if (!current) return;
    if (current.phase === "opening") { current.stopRequested = true; return; }
    if (current.phase !== "listening") return;
    current.phase = "transcribing";
    clearTimeout(current.timer);
    await micOff();
    await draw();
    const pcm = concat(current.chunks);
    current.chunks = [];
    await recognise(current, pcm);
  };

  /** Turns a finished recording (live text first, else the server's recogniser) into what it asks for. */
  const recognise = async (current: Recording, pcm: Uint8Array): Promise<void> => {
    const client = api;
    if (pcm.length < MIN_PCM_BYTES || !client) {
      current.live?.cancel();
      if (rec === current) { rec = null; say(t(locale, "g.msg.nothing")); }
      await draw();
      return;
    }
    // The live transcript is the command: no second recognition on the server.
    // Only when the live path failed (or heard nothing) does the WAV go to /api/stt.
    let text = current.live ? ((await current.live.finish()) ?? "").trim() : "";
    if (rec !== current || closed) return;
    let failed = "";
    if (!text) {
      try {
        text = (await client.transcribe(pcmToWav(pcm), locale)).trim();
      } catch (error) {
        const problem = toApiError(error);
        failed = t(locale, "g.err." + problem.code, { status: problem.status });
      }
    }
    // Cancelled, closed or left the module while the server was listening.
    if (rec !== current || closed) return;
    rec = null;
    if (failed) say(t(locale, "g.msg.sttFail", { reason: failed }));
    else if (!text) say(t(locale, "g.msg.nothing"));
    else if (current.target === "pack") applyPackCommand(text);
    else if (current.target === "customer") applyCustomerName(text);
    else applyTakeCommand(text);
    await draw();
  };

  /**
   * 2× while speaking goes back and keeps the recording (QIS v1.2 no. 2): the microphone is off, the audio
   * (and what was heard live) stays until it is sent from the menu or discarded there (armed first).
   */
  const parkRec = (): void => {
    const current = rec;
    if (!current || current.phase === "transcribing") return;
    // Nothing recorded yet: nothing to keep.
    if (current.phase === "opening") { cancelRec(false); return; }
    clearTimeout(current.timer);
    const pcm = concat(current.chunks);
    current.chunks = [];
    current.live?.cancel();
    rec = null;
    background(micOff(), "stopping the microphone");
    if (pcm.length >= MIN_PCM_BYTES) {
      parked = { target: current.target, pcm, text: current.text };
      say(t(locale, "g.parked"));
    } else {
      say(t(locale, "g.msg.nothing"));
    }
  };

  /** Menu "Send recording": the kept audio is recognised and used exactly like a recording that ended with a tap. */
  const sendParked = (): void => {
    if (rec || !api) return;
    const kept = parked;
    if (!kept) { say(t(locale, "g.msg.noRec")); void draw(); return; }
    disarm();
    parked = null;
    const current: Recording = { id: ++recIds, target: kept.target, via: "tap", phase: "transcribing", stopRequested: false, chunks: [], bytes: 0, live: null, text: kept.text };
    rec = current;
    say("");
    void draw();
    background(recognise(current, kept.pcm), "recognising a kept recording");
  };

  const cancelRec = (announce: boolean): void => {
    const current = rec;
    if (!current) return;
    rec = null;
    clearTimeout(current.timer);
    current.chunks = [];
    current.live?.cancel();
    if (current.phase !== "transcribing") background(micOff(), "stopping the microphone");
    if (announce) say(t(locale, "g.msg.cancelled"));
  };

  // ---- navigation --------------------------------------------------------
  const stopPrompter = (): void => {
    playing = false;
    clearInterval(prompterTimer);
    prompterTimer = undefined;
  };

  const prompterTick = (): void => {
    if (!playing) return;
    const last = Math.max(0, prompterLines.length - 1);
    prompterPos = Math.min(last, prompterPos + prompterSpeed * (PROMPTER_TICK_MS / 1000));
    if (prompterPos >= last) stopPrompter();
    void draw();
  };

  /** Asks the phone where it is, in the background and never longer than LOCATION_TIMEOUT_MS. */
  let locating: Promise<void> | null = null;
  const locate = (): Promise<void> => {
    if (locating) return locating;
    locating = (async () => {
      if (typeof (bridge as Partial<EvenAppBridge>).getAppLocation !== "function") return;
      const fix = await withTimeout(
        Promise.resolve(bridge.getAppLocation({ accuracy: AppLocationAccuracy.Medium, timeoutMs: 8_000 })),
        LOCATION_TIMEOUT_MS,
      ).catch(() => null);
      const found = fix ? validPlace(fix.latitude, fix.longitude) : null;
      if (!found || closed) return;
      phonePlace = found;
      // Kept on the phone only, rounded to about a kilometre: plenty for the sun.
      const rounded = { latitude: Math.round(found.latitude * 100) / 100, longitude: Math.round(found.longitude * 100) / 100 };
      savedPlace = rounded;
      void bridge.setLocalStorage(PLACE_KEY, JSON.stringify(rounded)).catch(() => false);
      refreshPhone();
      if (mode === "light") void draw();
    })().catch((error: unknown) => { console.warn("[shootday] location failed:", error); }).finally(() => { locating = null; });
    return locating;
  };

  const enter = (next: Module): void => {
    generation++;
    mode = next;
    say("");
    disarm();
    if (next === "takes") { takeScreen = "card"; actionCursor = TAKE_ACTIONS.indexOf("ok"); }
    if (next === "pack") showMissing = false;
    if (next === "light") {
      lightOffset = 0;
      void locate();
      // Drawn at once: the view needs neither the server nor the location to start.
      void draw();
    }
    load.delete(next);
    requestLoad(next);
  };

  /** The lists above a project: customers, a customer's projects, the card before the appointment. */
  const show = (next: "customers" | "projects" | "brief"): void => {
    cancelRec(false);
    stopPrompter();
    disarm();
    generation++;
    mode = next;
    pendingCustomer = null;
    say("");
    requestLoad(next);
    void draw();
  };

  const openCustomer = (picked: CustomerItem): void => {
    if (customer?.id !== picked.id) {
      projectList = [];
      load.delete("projects");
      resetProjectCursor = true;
    }
    customer = picked;
    show("projects");
  };

  /** Double tap in a project's menu: back to its customer's projects. */
  const backToProjects = (): void => {
    const owner = customerList.find((c) => c.id === activeCustomerId) ?? customer;
    if (!owner) { show("customers"); return; }
    openCustomer(owner);
  };

  /** The server makes the project the active one; only then does the menu load it. */
  const openProject = (item: ProjectItem): void => {
    const client = api;
    if (!client) return;
    const started = ++generation;
    say(t(locale, "g.loading"));
    void draw();
    void (async () => {
      try {
        await client.activate(item.id);
      } catch (error) {
        if (generation !== started || closed) return;
        const problem = toApiError(error);
        say(errorText(locale, problem.code, problem.status));
        await draw();
        return;
      }
      if (generation !== started || closed || api !== client) return;
      activeProjectId = item.id;
      activeCustomerId = customer?.id ?? activeCustomerId;
      // Nothing of the previous project may stay on the glasses.
      project = item.name;
      stopRolling();
      shots = [];
      serverTakes = [];
      shotCursor = 0;
      boards = [];
      boardIndex = 0;
      sceneCursor = 0;
      prompterLines = [];
      prompterPos = 0;
      sheet = { date: "", call: "", location: "", contact: "", notes: "", schedule: [] };
      equipment = [];
      packCursor = 0;
      scheduleScroll = 0;
      for (const kind of CUSTOMER_MENU) load.delete(kind);
      menuCursor = 0;
      toMenu();
    })().catch((error: unknown) => { console.warn("[shootday] opening a project failed:", error); });
  };

  /**
   * Asks once whether the server knows customers. An older server answers 404:
   * then nothing changes. A newer one puts the customer list on top — but only
   * if nobody has touched the glasses since the start.
   */
  let probing = false;
  const probeCustomers = (): void => {
    const client = api;
    if (!client || probing || closed) return;
    probing = true;
    void (async () => {
      try {
        const next = await client.customers();
        if (api !== client || closed) return;
        const before = customerMode;
        customerMode = true;
        wantedCustomer = wantedCustomer || next.activeCustomer;
        applyCustomers(next);
        load.set("customers", { kind: "ready" });
        customer ??= customerList.find((c) => c.id === activeCustomerId) ?? null;
        if (!before && mode === "menu") {
          if (!touched) mode = "customers";
          // The storyboard came in front of the other modules: keep the same one selected.
          else menuCursor = Math.min(menuCursor + 1, CUSTOMER_MENU.length - 1);
        }
        refreshPhone();
        await draw();
      } catch {
        // An older server (404) or no connection: the menu works as before.
      } finally {
        probing = false;
      }
    })();
  };

  const toMenu = (): void => {
    cancelRec(false);
    stopPrompter();
    disarm();
    generation++;
    mode = "menu";
    showMissing = false;
    lightOffset = 0;
    say("");
    requestLoad("menu");
  };

  /**
   * Leaving from the menu asks the system first (exit mode 1). Until the
   * system confirms, the app keeps running: the user may still cancel.
   */
  // shutDownPageContainer(1) resolves when the dialog is SHOWN (hardware: ~58 ms after the double tap), not when
  // the user answered, so the result never tears the app down. If the user confirms, the system ends the app
  // (sysEvent 6/7 below). After "No" the app has to be alive: on the next signal that it is back (any input,
  // FOREGROUND_ENTER) the page is put up again the way of the first one, then the event is handled normally.
  /** The restore started by the last exitBack(), while it is still running. */
  let restoring: Promise<void> | null = null;
  const exitBack = (): void => {
    if (!exitDialogAsked) return;
    exitDialogAsked = false;
    if (closed) return;
    pageReady = false;
    lastView = null;
    forgetPage(bridge);
    const run = draw().catch(() => undefined);
    restoring = run;
    void run.then(() => { if (restoring === run) restoring = null; });
  };
  const requestExit = (): void => {
    // A second double tap before any restore: put the page back first, then ask again.
    exitBack();
    // The first double tap after "No" is the back signal itself: a dialog call issued while the page is still being
    // created is lost (hardware, Klipper 0.5.8). So it waits for the restore and a short settle delay.
    const restore = restoring;
    const ask = async (): Promise<void> => {
      dialogPending = true;
      try {
        await bridge.shutDownPageContainer(1);
      } catch (error: unknown) {
        console.warn("[shootday] exit failed:", error);
      }
      exitDialogAsked = true;
    };
    // Without a restore in flight the host is called at once, in this very event.
    if (restore) void settleRestore(restore).then(ask);
    else void ask();
  };

  let clock: ReturnType<typeof setInterval> | undefined;
  let outboxTimer: ReturnType<typeof setInterval> | undefined;
  const shutDown = (): void => {
    if (closed) return;
    cancelRec(false);
    parked = null;
    saveUi();
    closed = true;
    stopPrompter();
    clearInterval(clock);
    clearInterval(outboxTimer);
    clearTimeout(messageTimer);
    clearTimeout(armTimer);
    clearTimeout(liveDrawTimer);
    lightSender.close();
  };

  // ---- gestures ----------------------------------------------------------
  /** Menu "Delete last take" (armed): removes the newest take of the shot on screen. */
  const deleteLastTake = (): void => {
    const shot = shots[shotCursor];
    const target = latestTake(shot);
    if (!shot || !target) { say(t(locale, "g.msg.noTakeToDelete")); void draw(); return; }
    const label = `${shot.scene}${shot.shot} T${target.n} ${target.status}`;
    const client = api;
    // Queued behind any write still on its way (a take just logged may not have reached the server yet).
    void queueWrite(async () => {
      const now = latestTake(shot);
      if (!now || now.n !== target.n) { say(t(locale, "g.msg.noTakeToDelete")); await draw(); return; }
      if (now.pending) {
        outbox = outbox.filter((take) => take.id !== now.id);
        persistOutbox();
        say(t(locale, "g.msg.deleted", { what: label }));
        refreshPhone();
        await draw();
        return;
      }
      if (!client) return;
      try {
        await client.deleteTake(shot.scene, shot.shot, now.n);
        serverTakes = serverTakes.filter((take) => !(take.scene === shot.scene && take.shot === shot.shot && take.n === now.n));
        say(t(locale, "g.msg.deleted", { what: label }));
      } catch (error) {
        const problem = toApiError(error);
        say(t(locale, "g.msg.notSaved", { reason: t(locale, "g.err." + problem.code, { status: problem.status }) }));
      }
      refreshPhone();
      await draw();
    }, "deleting a take");
  };

  /** The second tap of an armed action. */
  const confirmArmed = (kind: ArmKind): void => {
    if (kind === "delTake") {
      takeScreen = "card";
      deleteLastTake();
      return;
    }
    if (kind === "discardRec") {
      if (rec) cancelRec(true);
      else { parked = null; say(t(locale, "g.msg.cancelled")); }
    } else if (kind === "discardName") {
      pendingCustomer = null;
      say(t(locale, "g.cust.discarded"));
    } else if (kind === "ng") {
      takeScreen = "card";
      addTake("NG");
    } else if (kind === "roll") {
      stopRolling();
      takeScreen = "card";
      say(t(locale, "g.msg.cancelled"));
    } else {
      const packed = kind === "packAll";
      for (const entry of needed()) if (entry.packed !== packed) void setPacked(entry.name, packed, false);
      say(t(locale, packed ? "g.pack.all" : "g.pack.reset"));
    }
    void draw();
  };

  const step = (gesture: Gesture): number => (gesture === "scrollDown" ? 1 : -1);
  const wrapIndex = (index: number, count: number): number => (count <= 0 ? 0 : (index + count) % count);

  const onRecGesture = (gesture: Gesture): void => {
    const current = rec;
    if (!current) return;
    // Without the side menu nothing could send or discard a kept recording: 2× cancels it, as before QIS v1.2.
    if (gesture === "doubleClick") { if (SIDE_MENU) parkRec(); else cancelRec(true); return; }
    if (current.phase === "transcribing") return;
    if (gesture === "click" || gesture === "longPressRelease") background(stopRec(), "stopping the microphone");
  };

  /** Hilfe: the gestures on a page of their own; a tap or 2× goes back to where it was opened. */
  const showHelp = (): void => {
    if (mode === "help") return;
    cancelRec(false);
    stopPrompter();
    disarm();
    helpBack = mode;
    mode = "help";
    say("");
    void draw();
  };
  const onHelp = (gesture: Gesture): void => {
    if (gesture !== "click" && gesture !== "doubleClick") return;
    // The server may have turned out to know customers while the help was open.
    mode = helpBack === "menu" && customerMode ? "customers" : helpBack;
    say("");
    void draw();
  };

  const onMenu = (gesture: Gesture): void => {
    const items = menuFor(customerMode);
    switch (gesture) {
      case "scrollUp":
      case "scrollDown":
        menuCursor = wrapIndex(menuCursor + step(gesture), items.length);
        break;
      case "click": {
        const next = items[menuCursor];
        if (!next) break;
        if (next === "help") { showHelp(); return; }
        // The light view needs no server.
        if (!api && next !== "light") { requestLoad("menu"); break; }
        enter(next);
        return;
      }
      case "doubleClick":
        if (customerMode) backToProjects();
        else requestExit();
        return;
      default:
        return;
    }
    void draw();
  };

  const onCustomers = (gesture: Gesture): void => {
    if (pendingCustomer !== null) {
      if (gesture === "click") { createCustomer(pendingCustomer); return; }
      // 2× only asks (QIS v1.2 no. 2): the name is discarded by the second tap, never by 2× alone.
      if (gesture === "doubleClick") { arm("discardName"); void draw(); return; }
      if (gesture === "longPress") { pendingCustomer = null; background(startRec("customer", "hold"), "starting the microphone"); }
      return;
    }
    if (currentLoad().kind !== "ready") {
      if (gesture === "click") requestLoad("customers");
      else if (gesture === "doubleClick") requestExit();
      return;
    }
    switch (gesture) {
      case "scrollUp":
      case "scrollDown":
        customerCursor = wrapIndex(customerCursor + step(gesture), customerList.length + (SIDE_MENU ? 1 : 2));
        say("");
        break;
      case "click": {
        if (customerCursor === 0) { background(startRec("customer", "tap"), "starting the microphone"); return; }
        // Hilfe is the last entry of the list (without the side menu).
        if (!SIDE_MENU && customerCursor === customerList.length + 1) { showHelp(); return; }
        const picked = customerList[customerCursor - 1];
        if (picked) openCustomer(picked);
        return;
      }
      case "longPress":
        background(startRec("customer", "hold"), "starting the microphone");
        return;
      case "doubleClick":
        requestExit();
        return;
      default:
        return;
    }
    void draw();
  };

  const onProjects = (gesture: Gesture): void => {
    if (gesture === "doubleClick") { show("customers"); return; }
    if (currentLoad().kind !== "ready") {
      if (gesture === "click") requestLoad("projects");
      return;
    }
    switch (gesture) {
      case "scrollUp":
      case "scrollDown":
        projectCursor = wrapIndex(projectCursor + step(gesture), projectList.length + 1);
        say("");
        break;
      case "click": {
        if (projectCursor === 0) {
          brief = null;
          briefPage = 0;
          load.delete("brief");
          show("brief");
          return;
        }
        const picked = projectList[projectCursor - 1];
        if (picked) openProject(picked);
        return;
      }
      default:
        return;
    }
    void draw();
  };

  /** Swipe = page, tap = load again, 2× = back to the projects. */
  const onBrief = (gesture: Gesture): void => {
    if (gesture === "doubleClick") { show("projects"); return; }
    if (gesture === "click") { requestLoad("brief"); return; }
    if ((gesture === "scrollUp" || gesture === "scrollDown") && currentLoad().kind === "ready") {
      briefPage = Math.max(0, Math.min(briefPages(locale, brief) - 1, briefPage + step(gesture)));
      void draw();
    }
  };

  /** Swipe = next/previous scene, tap = done (or not), 2× = other storyboard or menu. */
  const onBoard = (gesture: Gesture): void => {
    if (currentLoad().kind !== "ready" || boards.length === 0) {
      if (gesture === "click" && currentLoad().kind !== "loading") { enter("board"); return; }
      if (gesture === "doubleClick") toMenu();
      return;
    }
    if (boardPicking) {
      if (gesture === "scrollUp" || gesture === "scrollDown") boardIndex = wrapIndex(boardIndex + step(gesture), boards.length);
      else if (gesture === "click") { boardPicking = false; sceneCursor = 0; }
      else if (gesture === "doubleClick") { toMenu(); return; }
      else return;
      void draw();
      return;
    }
    const scenes = boards[boardIndex]?.scenes ?? [];
    switch (gesture) {
      case "scrollUp":
      case "scrollDown":
        sceneCursor = Math.max(0, Math.min(scenes.length - 1, sceneCursor + step(gesture)));
        say("");
        break;
      case "click":
        toggleScene();
        return;
      case "doubleClick":
        if (boards.length > 1) { boardPicking = true; say(""); break; }
        toMenu();
        return;
      default:
        return;
    }
    void draw();
  };

  const onTakes = (gesture: Gesture): void => {
    if (currentLoad().kind !== "ready" || shots.length === 0) {
      if (gesture === "click" && currentLoad().kind === "error") { enter("takes"); return; }
      if (gesture === "doubleClick") toMenu();
      return;
    }
    if (takeScreen === "actions") {
      if (gesture === "scrollUp" || gesture === "scrollDown") actionCursor = wrapIndex(actionCursor + step(gesture), TAKE_ACTIONS.length);
      else if (gesture === "doubleClick") takeScreen = "card";
      else if (gesture === "click") {
        const action = TAKE_ACTIONS[actionCursor];
        // Cancelling a running take is armed: the first tap asks, the second one carries it out.
        if (action === "roll" && rollingHere()) { arm("roll"); void draw(); return; }
        // Marking a take "nicht ok" is armed as well; OK stays a single tap.
        if (action === "ng") { arm("ng"); void draw(); return; }
        // Deleting the newest take is armed too (no side menu): the second tap carries it out; with no take there is nothing to ask.
        if (action === "delTake" && latestTake(shots[shotCursor])) { arm("delTake"); void draw(); return; }
        takeScreen = "card";
        if (action === "roll") {
          const here = shots[shotCursor];
          rollingSince = Date.now();
          rollingKey = here ? takeKey(here.scene, here.shot) : null;
        } else if (action === "ok") addTake("OK");
        else if (action === "note") { takeScreen = "notes"; noteCursor = 0; }
        else if (action === "voice") { background(startRec("takes", "tap"), "starting the microphone"); return; }
        else if (action === "delTake") say(t(locale, "g.msg.noTakeToDelete"));
      } else return;
      void draw();
      return;
    }
    if (takeScreen === "notes") {
      const count = notes().length;
      if (gesture === "scrollUp" || gesture === "scrollDown") noteCursor = wrapIndex(noteCursor + step(gesture), count);
      else if (gesture === "doubleClick") takeScreen = "card";
      else if (gesture === "click") { setLastNote(notes()[noteCursor] ?? ""); takeScreen = "card"; }
      else return;
      void draw();
      return;
    }
    switch (gesture) {
      case "scrollUp":
      case "scrollDown":
        // A swipe only moves; a running take stays with its shot.
        shotCursor = wrapIndex(shotCursor + step(gesture), shots.length);
        say("");
        break;
      case "click":
        takeScreen = "actions";
        actionCursor = TAKE_ACTIONS.indexOf("ok");
        break;
      case "longPress":
        background(startRec("takes", "hold"), "starting the microphone");
        return;
      case "doubleClick":
        toMenu();
        return;
      default:
        return;
    }
    void draw();
  };

  const onPrompter = (gesture: Gesture): void => {
    if (currentLoad().kind !== "ready") {
      if (gesture === "click" && currentLoad().kind === "error") { enter("prompter"); return; }
      if (gesture === "doubleClick") toMenu();
      return;
    }
    switch (gesture) {
      case "scrollDown":
        prompterSpeed = Math.min(3, Math.round((prompterSpeed + 0.1) * 10) / 10);
        break;
      case "scrollUp":
        prompterSpeed = Math.max(0.1, Math.round((prompterSpeed - 0.1) * 10) / 10);
        break;
      case "click":
        if (prompterLines.length === 0) { enter("prompter"); return; }
        if (playing) stopPrompter();
        else {
          if (prompterPos >= prompterLines.length - 1) prompterPos = 0;
          playing = true;
          clearInterval(prompterTimer);
          prompterTimer = setInterval(prompterTick, PROMPTER_TICK_MS);
        }
        break;
      case "doubleClick":
        toMenu();
        return;
      default:
        return;
    }
    void draw();
  };

  const onSchedule = (gesture: Gesture): void => {
    if (gesture === "doubleClick") { toMenu(); return; }
    if (gesture === "click") { requestLoad("schedule"); return; }
    if (currentLoad().kind !== "ready") return;
    if (gesture === "scrollUp" || gesture === "scrollDown") {
      const rows = Math.max(1, SCHEDULE_BODY_ROWS - 3);
      scheduleScroll = Math.max(0, Math.min(Math.max(0, sheet.schedule.length - rows), scheduleScroll + step(gesture)));
      void draw();
    }
  };

  const onPack = (gesture: Gesture): void => {
    if (currentLoad().kind !== "ready") {
      if (gesture === "click" && currentLoad().kind === "error") { enter("pack"); return; }
      if (gesture === "doubleClick") toMenu();
      return;
    }
    if (showMissing) {
      if (gesture === "click" || gesture === "doubleClick") { showMissing = false; void draw(); }
      return;
    }
    const items = needed();
    switch (gesture) {
      case "scrollUp":
      case "scrollDown":
        packCursor = Math.max(0, Math.min(items.length - 1, packCursor + step(gesture)));
        break;
      case "click": {
        const item = items[packCursor];
        if (!item) { requestLoad("pack"); return; }
        void setPacked(item.name, !item.packed, false);
        return;
      }
      case "longPress":
        background(startRec("pack", "hold"), "starting the microphone");
        return;
      case "doubleClick":
        toMenu();
        return;
      default:
        return;
    }
    void draw();
  };

  /** Swipe = look 30 min ahead or back, tap = back to now (or, at now, ask for the location again), 2× = menu. */
  const onLight = (gesture: Gesture): void => {
    switch (gesture) {
      case "scrollUp":
      case "scrollDown":
        lightOffset = Math.max(-LIGHT_MAX_MIN, Math.min(LIGHT_MAX_MIN, lightOffset + step(gesture) * LIGHT_STEP_MIN));
        break;
      case "click":
        if (lightOffset !== 0) lightOffset = 0;
        else { void locate(); requestLoad("light"); }
        break;
      case "doubleClick":
        toMenu();
        return;
      default:
        return;
    }
    void draw();
  };

  /** Left through the system: microphone off, prompter stopped, place saved; nothing runs until the app is back. */
  const goBackground = (): void => {
    if (backgrounded) return;
    cancelRec(false);
    stopPrompter();
    saveUi();
    backgrounded = true;
    clearInterval(clock);
    clock = undefined;
    clearInterval(outboxTimer);
    outboxTimer = undefined;
  };
  const comeBack = (): void => {
    backgrounded = false;
    pageReady = false;
    lastView = null;
    startTimers();
    // A double tap arriving right now waits for exactly this draw before it asks the exit dialog again.
    const run = draw().catch(() => undefined);
    restoring = run;
    void run.then(() => { if (restoring === run) restoring = null; });
    if (api) requestLoad(mode === "help" ? helpBack : mode);
  };

  /**
   * A click in the glasses' side menu (QIS v1.2). Help only looks. Deleting the last take and discarding a
   * recording change something, so the first click arms them (footer: "Nochmal tippen = …") and a single tap
   * or a second click of the same item within the window carries them out; a swipe, 2× or the timeout cancel.
   */
  const onSideMenu = (id: number): void => {
    if (closed || backgrounded) return;
    touched = true;
    const pending = liveArm();
    switch (id) {
      case MENU_HELP:
        if (rec) return;
        showHelp();
        return;
      case MENU_DEL_TAKE: {
        if (rec) return;
        const shot = shots[shotCursor];
        if (mode !== "takes" || !shot) { disarm(); say(t(locale, "g.msg.takesOnly")); void draw(); return; }
        if (!latestTake(shot)) { disarm(); say(t(locale, "g.msg.noTakeToDelete")); void draw(); return; }
        if (pending === "delTake") { disarm(); confirmArmed("delTake"); return; }
        arm("delTake");
        void draw();
        return;
      }
      case MENU_SEND_REC:
        disarm();
        sendParked();
        return;
      case MENU_DISCARD_REC:
        if (!rec && !parked) { disarm(); say(t(locale, "g.msg.noRec")); void draw(); return; }
        if (pending === "discardRec") { disarm(); confirmArmed("discardRec"); void draw(); return; }
        arm("discardRec");
        void draw();
        return;
      default:
        return;
    }
  };

  // The glasses listen before the first page is built: a slow page must never make a tap or the exit go nowhere.
  bridge.onEvenHubEvent((event) => {
    if (closed) return;
    const lifecycle = lifecycleFromEvent(event);
    if (lifecycle === "foreground" && dialogPending) {
      // The exit dialog came up: stay still, it is on screen now.
      dialogPending = false;
      dialogShown = true;
      exitDialogAsked = true;
      return;
    }
    if (lifecycle === "background" && dialogShown) {
      // "No": the dialog went away. The app never left - page up again the way of the first one; clock, outbox and
      // everything else keep running (no background state).
      dialogShown = false;
      exitDialogAsked = true;
      exitBack();
      return;
    }
    // Only gestures and system events end the dialog state; the microphone stream and sysEvent 8 leave it alone.
    const sysType = (event as { sysEvent?: { eventType?: number } }).sysEvent?.eventType;
    if ((event as { audioEvent?: unknown }).audioEvent === undefined && sysType !== 8) {
      dialogPending = false;
      dialogShown = false;
    }
    // Not the microphone stream: PCM keeps flowing while the dialog is open and says nothing about the user.
    if (lifecycle !== "background" && lifecycle !== "exit" && (event as { audioEvent?: unknown }).audioEvent === undefined) exitBack();
    if (lifecycle === "foreground") { comeBack(); return; }
    if (lifecycle === "background") { goBackground(); return; }
    if (lifecycle === "exit") { goBackground(); shutDown(); return; }
    const menuId = menuItemIdFromEvent(event);
    if (menuId !== null) { onSideMenu(menuId); return; }
    const audio = (event as { audioEvent?: { audioPcm?: unknown } }).audioEvent;
    if (audio) {
      const current = rec;
      if (!current || current.phase !== "listening") return;
      const pcm = toPcm(audio.audioPcm);
      if (pcm.length === 0) return;
      if (current.bytes + pcm.length > MAX_PCM_BYTES) { background(stopRec(), "stopping the microphone"); return; }
      current.chunks.push(pcm);
      current.bytes += pcm.length;
      current.live?.send(pcm);
      return;
    }

    const parsed = gestureFromEvent(event, { invertScroll: settings.invertScroll });
    if (!parsed) return;
    touched = true;
    // A gesture means the app is on the glasses again, even if no "foreground" came first.
    // A double tap on a root page still asks to leave (after "No" the first 2x must not be swallowed here); it
    // waits for the restore draw started by comeBack().
    if (backgrounded) {
      comeBack();
      const rootPage = (mode === "menu" && !customerMode) || (mode === "customers" && pendingCustomer === null);
      if (!(parsed.gesture === "doubleClick" && rootPage)) return;
    }
    const gesture = parsed.gesture;
    const pending = liveArm();
    if (rec) {
      // A pending "discard recording" yields to anything: only the confirming tap carries it out.
      if (pending === "discardRec") { disarm(); if (gesture === "click") confirmArmed("discardRec"); else void draw(); return; }
      onRecGesture(gesture);
      void draw();
      return;
    }
    // QIS v1: while an action is armed, a tap carries it out; swipe, hold and 2× only cancel it.
    if (pending !== null) {
      disarm();
      if (gesture === "click") confirmArmed(pending);
      else void draw();
      saveUi();
      return;
    }
    if (armed) disarm();
    switch (mode) {
      case "help": onHelp(gesture); break;
      case "customers": onCustomers(gesture); break;
      case "projects": onProjects(gesture); break;
      case "brief": onBrief(gesture); break;
      case "board": onBoard(gesture); break;
      case "menu": onMenu(gesture); break;
      case "takes": onTakes(gesture); break;
      case "prompter": onPrompter(gesture); break;
      case "schedule": onSchedule(gesture); break;
      case "pack": onPack(gesture); break;
      case "light": onLight(gesture); break;
    }
    saveUi();
  });

  await draw();
  if (api) {
    // Back in the module that was open before a restart; a running take keeps its clock.
    if (savedUi && savedUi.mode !== "menu") {
      enter(savedUi.mode);
      if (savedUi.mode === "takes" && savedUi.rollingSince !== null && savedUi.shot) {
        rollingSince = savedUi.rollingSince;
        rollingKey = takeKey(savedUi.shot.scene, savedUi.shot.shot);
      }
      requestLoad("menu");
    } else requestLoad("menu");
    probeCustomers();
  }

  // The page does not survive a disconnect; the last view is forgotten too,
  // or an unchanged view would skip the rebuild and leave the display blank.
  bridge.onDeviceStatusChanged((status) => {
    if (status?.connectType === "connected" && !closed) {
      pageReady = false;
      lastView = null;
      void draw();
    }
  });

  // The recording dot pulses twice a second while a take runs on the takes page,
  // the schedule follows the clock every 30 s. Unchanged frames cost nothing.
  let ticks = 0;
  function startTimers(): void {
    clearInterval(clock);
    clearInterval(outboxTimer);
    clock = setInterval(() => {
      ticks += 1;
      if (mode === "takes" && rollingHere() && !rec) void draw();
      else if ((mode === "schedule" || mode === "light") && ticks % Math.round(CLOCK_TICK_MS / PULSE_MS) === 0) void draw();
    }, PULSE_MS);
    // Takes logged offline go out as soon as the server answers again, not only on the next visit.
    outboxTimer = setInterval(() => {
      if (closed || backgrounded || outbox.length === 0 || !api) return;
      if (project) flushOutbox();
      else requestLoad("menu");
    }, OUTBOX_RETRY_MS);
  }
  startTimers();

  const phone = mountPhoneUi({
    getSettings: () => settings,
    saveSettings: async (next) => {
      await saveSettings(bridge, next);
      const serverChanged = next.serverUrl !== settings.serverUrl || next.token !== settings.token;
      settings = next;
      if (serverChanged) {
        api = makeApi();
        project = "";
        shots = [];
        serverTakes = [];
        load.clear();
        connectionError = null;
        connected = false;
        stopRolling();
        parked = null;
        customerMode = false;
        customerList = [];
        customer = null;
        projectList = [];
        boards = [];
        touched = false;
        toMenu();
        probeCustomers();
      }
      await draw();
    },
    connection: (): ConnectionState => {
      if (isDemo()) return { kind: "demo" };
      if (!api) return { kind: "none" };
      // The phone shows the HTTP status; the glasses never do (QIS v1.2 no. 8).
      if (connectionError) {
        const { code, status } = connectionError;
        return { kind: "error", reason: code === "http" ? t(locale, "g.error", { reason: t(locale, "p.err.http", { status: status ?? 0 }) }) : errorText(locale, code, status) };
      }
      return connected ? { kind: "ok", project } : { kind: "loading" };
    },
    pendingCount: () => outbox.length,
    light: () => {
      const { where, model } = currentLight(0);
      return { model, place: where?.place ?? null, source: where?.source ?? null, phase: where ? lightAt(Date.now(), where.place).phase : null };
    },
    onLocate: () => { void locate(); requestLoad("light"); },
    locale: () => locale,
    onLocaleChange: (next) => {
      locale = next;
      rememberLocale(bridge, next);
      // The side menu carries the language: the page is rebuilt with it.
      setPageMenu(menuSpec());
      pageReady = false;
      lastView = null;
      void draw();
    },
  });
  refreshPhone = phone.refresh;
}

void boot().catch((error: unknown) => {
  console.error("[shootday] failed to start:", error);
});
