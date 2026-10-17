import { waitForEvenAppBridge, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { backoffMs, fetchReport, markDeviceKnown, runAction } from "./protocol/fetcher";
import {
  acknowledge, applyError, applyReport, createSource, problems, type Problem, type SourceStatus,
} from "./monitor/dashboard";
import { gestureFromEvent, menuItemIdFromEvent } from "./input/gestures";
import { lifecycleFromEvent } from "./lifecycle";
import { liveWord, problemsView, startRows, startView, type StatusView } from "./glasses/view";
import { DEMO_FLEET, demoFleetReport, demoNasReport, demoNetwork, demoStartFleet, type DemoMachine } from "./monitor/demo";
import { ARM_MS, SIDE_MENU, availableActions, buildActionsView } from "./glasses/actions-view";
import { sameView } from "./glasses/diff";
import {
  COCKPIT_TILES, createCockpitPage, createTextPage, forgetPage, guardedTileSend, updateTextPage, type MenuSpec,
} from "./glasses/page";
import { cockpitModel, cockpitPages, type CockpitModel } from "./cockpit/model";
import { composeCockpit } from "./cockpit/compose";
import { createTileSender } from "./screen/sender";
import { autoBackend, type TextBackend } from "./screen/text";
import { load, save, type StatusData } from "./storage/persist";
import { mountPhoneUi, type PhoneNetwork, type PhoneUi } from "./ui/phone";
import { describeIssue, t } from "./messages";
import { createExitRequest, isBackSignal, settleRestore } from "./exit";
import { rememberLocale, resolveLocale, type Locale } from "./i18n";

/** Side-menu item ids (off while SIDE_MENU is false). */
const MENU_ACTIONS = 1;
const MENU_RELOAD = 2;

const DEMO = new URLSearchParams(location.search).get("demo") === "1";
/** `?demo=1&scene=fleet|graph|warn|critical|ok` picks a sample; without it the first-start demo (four servers, one problem). */
const SCENE = new URLSearchParams(location.search).get("scene");
/** Where the user was on the glasses; a restart after a locked phone comes back there. */
const UI_KEY = "quietglass.statusglass.ui.v2";
/** The cockpit is redrawn this often: the clock and the age of the data stay current; an unchanged frame sends nothing. */
const TICK_MS = 15_000;
/** The sample data is renewed this often, so it never goes stale. */
const DEMO_REFRESH_MS = 30_000;

type Screen = "start" | "cockpit" | "problems" | "actions";

interface SavedUi {
  readonly screen?: "start" | "cockpit";
  readonly startCursor?: number;
  readonly page?: number;
  readonly cursor?: number;
}

function parseUi(raw: string): SavedUi {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const n = (x: unknown): number | undefined => (typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= 1000 ? x : undefined);
    const out: { -readonly [K in keyof SavedUi]: SavedUi[K] } = {};
    if (value["screen"] === "cockpit" || value["screen"] === "start") out.screen = value["screen"];
    for (const key of ["startCursor", "page", "cursor"] as const) {
      const v = n(value[key]);
      if (v !== undefined) out[key] = v;
    }
    return out;
  } catch {
    return {};
  }
}

const sourcesOf = (machines: readonly DemoMachine[]) => machines.map((m) => ({ id: m.id, name: m.name, url: `http://demo.local/${m.id}` }));

async function boot(): Promise<void> {
  const bridge: EvenAppBridge = await waitForEvenAppBridge();

  let stored: StatusData = await load(bridge);
  let data: StatusData = stored;
  // QIS v1.2 ruling 7: without a source the app starts in demo mode (sample data, one hint line).
  // Explicit ?demo=1 stays as it was; the first-start demo never writes its sample sources to storage.
  let firstStartDemo = !DEMO && stored.sources.length === 0;
  let demo = DEMO || firstStartDemo;
  const NAS_DEMO = DEMO && (SCENE === "graph" || SCENE === "warn" || SCENE === "critical");
  const demoMachines: readonly DemoMachine[] = SCENE === "fleet" ? DEMO_FLEET : demoStartFleet(SCENE !== "ok");
  const demoSources = NAS_DEMO ? [{ id: "nas", name: "NAS", url: "http://demo.local/nas" }] : sourcesOf(demoMachines);
  if (demo) data = { ...data, sources: demoSources };

  let statuses = new Map<string, SourceStatus>();
  const failures = new Map<string, number>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * Bumped whenever a source's polling is restarted or removed. A reply from
   * an older round is dropped: otherwise every restart while a request was in
   * flight left one more polling loop running, and a source removed mid-poll
   * came back from the dead when its answer arrived.
   */
  const generations = new Map<string, number>();
  let closed = false;
  let tickTimer: ReturnType<typeof setInterval> | null = null;
  let demoTimer: ReturnType<typeof setInterval> | null = null;
  let demoStep = 11;
  let locale: Locale = await resolveLocale(bridge);

  // What is on the glasses: the start page, the cockpit (overview / one server), the problem list, the actions.
  let screen: Screen = "start";
  let startCursor = 0;
  /** Index into cockpitPages(sources). */
  let pageIndex = 0;
  let problemCursor = 0;
  let actionCursor = 0;
  let pendingActionId: string | null = null;
  /** An armed action lapses after ARM_MS without the confirming tap (QIS v1). */
  let armTimer: ReturnType<typeof setTimeout> | null = null;
  const disarm = (): void => {
    if (armTimer !== null) clearTimeout(armTimer);
    armTimer = null;
    pendingActionId = null;
  };
  const arm = (id: string): void => {
    disarm();
    pendingActionId = id;
    armTimer = setTimeout(() => {
      armTimer = null;
      if (pendingActionId === null) return;
      pendingActionId = null;
      void draw();
    }, ARM_MS);
  };
  /** "Seen" (acknowledging) is armed too: a first tap asks, a second tap within ARM_MS does it. */
  let ackArmedUntil = 0;
  let ackTimer: ReturnType<typeof setTimeout> | null = null;
  const ackArmed = (): boolean => ackArmedUntil > Date.now();
  const disarmAck = (): void => {
    if (ackTimer !== null) clearTimeout(ackTimer);
    ackTimer = null;
    ackArmedUntil = 0;
  };
  const armAck = (): void => {
    disarmAck();
    ackArmedUntil = Date.now() + ARM_MS;
    ackTimer = setTimeout(() => {
      ackTimer = null;
      ackArmedUntil = 0;
      void draw();
    }, ARM_MS);
  };
  let actionBusy = false;
  let actionResult: { label: string; ok: boolean } | null = null;
  /** Left through the system: no polling, no drawing until the app is back. */
  let backgrounded = false;
  /** The phone page; it follows every poll. */
  let phone: PhoneUi | null = null;

  /** Off while its clicks do not arrive on the real glasses (SIDE_MENU, step log 15.10.2026): the pages carry no menu. */
  const menuSpec = (): MenuSpec => !SIDE_MENU ? { key: "none", items: [] } : ({
    key: `menu:${locale}`,
    items: [
      { id: MENU_ACTIONS, label: t(locale, "g.start.actions") },
      { id: MENU_RELOAD, label: t(locale, "g.w.reload") },
    ],
  });

  // Back where the user was before a restart. The problem list and the actions are never restored:
  // running something in the house always starts from a deliberate tap.
  if (!demo) {
    const ui = parseUi(await bridge.getLocalStorage(UI_KEY).catch(() => "") ?? "");
    startCursor = ui.startCursor ?? 0;
    problemCursor = ui.cursor ?? 0;
    if (ui.screen === "cockpit") { screen = "cockpit"; pageIndex = ui.page ?? 0; }
  }
  let savedUi = "";
  const saveUi = (): void => {
    if (demo) return;
    const ui: SavedUi = { screen: screen === "cockpit" ? "cockpit" : "start", startCursor, page: pageIndex, cursor: problemCursor };
    const json = JSON.stringify(ui);
    if (json === savedUi) return;
    savedUi = json;
    void bridge.setLocalStorage(UI_KEY, json).catch(() => false);
  };

  const syncSources = (): void => {
    const next = new Map<string, SourceStatus>();
    for (const config of data.sources) {
      next.set(config.id, statuses.get(config.id) ?? createSource(config.id, config.name));
    }
    // Stop polling anything that has been removed.
    for (const [id, timer] of timers) {
      if (!next.has(id)) { clearTimeout(timer); timers.delete(id); failures.delete(id); }
    }
    for (const id of generations.keys()) {
      if (!next.has(id)) generations.set(id, (generations.get(id) ?? 0) + 1);
    }
    statuses = next;
  };

  type Scene =
    | { readonly kind: "text"; readonly view: StatusView }
    | { readonly kind: "cockpit"; readonly model: CockpitModel };

  /** The problems the list page shows (all of them, worst first, seen ones last). */
  const allProblems = (now: number): Problem[] => problems([...statuses.values()], now);

  /** Everything on the glasses for one moment. */
  const currentScene = (now: number): Scene => {
    const sources = [...statuses.values()];
    const actions = availableActions(sources);
    if (screen === "actions") {
      const view = buildActionsView(actions, {
        cursor: actionCursor, pendingId: pendingActionId, result: actionResult, busy: actionBusy, locale,
        word: liveWord(sources, now, demo),
      });
      return { kind: "text", view };
    }
    if (screen === "problems") {
      const list = allProblems(now);
      problemCursor = Math.min(problemCursor, Math.max(0, list.length - 1));
      return { kind: "text", view: problemsView(sources, list, problemCursor, now, { locale, demo, armed: ackArmed() }) };
    }
    if (screen === "cockpit") {
      const pages = cockpitPages(sources);
      pageIndex = Math.min(pageIndex, pages.length - 1);
      return { kind: "cockpit", model: cockpitModel({ sources, page: pages[pageIndex]!, now, locale, demo }) };
    }
    const count = allProblems(now).length;
    const rows = startRows(sources, count, actions.length);
    startCursor = Math.min(startCursor, Math.max(0, rows.length - 1));
    return { kind: "text", view: startView(sources, startCursor, now, { locale, demo, problemCount: count, actionCount: actions.length }) };
  };

  // ---- drawing ----------------------------------------------------------------------------------

  let pageReady = false;
  /** Which kind of page the glasses carry: a change means one rebuild. */
  let installed: "text" | "cockpit" | null = null;
  let lastView: StatusView | null = null;
  /** Key of the side menu the page on the glasses carries; a different one (language) needs a rebuild. */
  let pageMenuKey = "";
  let textBackend: TextBackend | null = null;

  // While the exit dialog may be on screen (asked, no input since) no timer, poll or stream may draw: a page call
  // could cover it. Data keeps being collected; the back signal restores the page the way of the first one.
  let exitAsked = (): boolean => false;

  /** The cockpit is one 576 x 288 frame; only the tiles whose pixels changed cross Bluetooth. Never while the dialog may be up. */
  const tiles = createTileSender(COCKPIT_TILES, guardedTileSend(bridge, () => !exitAsked() && !closed && installed === "cockpit"));

  const drawOnce = async (): Promise<void> => {
    if (exitAsked()) return;
    if (closed || backgrounded) return;
    const scene = currentScene(Date.now());
    const menu = menuSpec();
    if (scene.kind === "cockpit") {
      if (installed !== "cockpit" || (pageReady && menu.key !== pageMenuKey)) pageReady = false;
      if (!pageReady) {
        const result = await createCockpitPage(bridge, menu);
        if (closed) return;
        if (!result.ok) { pageReady = false; console.warn("[statusglass] draw failed:", result.reason); return; }
        pageReady = true;
        installed = "cockpit";
        pageMenuKey = menu.key;
        lastView = null;
        // A new page starts with blank images.
        tiles.reset();
      }
      textBackend ??= autoBackend();
      // Never awaited: a slow transfer must not hold up the next gesture.
      void tiles.push(composeCockpit(scene.model, textBackend));
      return;
    }
    const view = scene.view;
    // Leaving the cockpit: its containers are about to go, no tile may be written any more.
    if (installed === "cockpit") { installed = null; pageReady = false; }
    // The side menu travels with the page: a different one (language) means one rebuild.
    if (pageReady && menu.key !== pageMenuKey) pageReady = false;
    if (pageReady && sameView(lastView, view)) return;
    const result = pageReady ? await updateTextPage(bridge, view, lastView) : await createTextPage(bridge, view, menu);
    if (closed) return;
    if (result.ok) {
      pageReady = true;
      installed = "text";
      pageMenuKey = menu.key;
      lastView = view;
      return;
    }
    pageReady = false;
    console.warn("[statusglass] draw failed:", result.reason);
  };

  /**
   * One page write at a time. A gesture, a poll answer and the tick all ask for redraws; two writes in
   * flight compare against the same stale view, so a quick cancel could leave the armed footer behind.
   * Requests made during a write collapse into one more pass with the newest state.
   */
  let drawing: Promise<void> | null = null;
  let drawAgain = false;
  const draw = (): Promise<void> => {
    if (exitAsked()) return Promise.resolve();
    if (drawing) { drawAgain = true; return drawing; }
    drawing = (async () => {
      try {
        do { drawAgain = false; await drawOnce(); } while (drawAgain && !closed);
      } finally {
        drawing = null;
      }
    })();
    return drawing;
  };

  // ---- polling ----------------------------------------------------------------------------------

  /**
   * Each source polls on its own timer. A failing source backs off without
   * slowing the healthy ones — one dead host must not blind the dashboard.
   */
  const pollSource = async (id: string): Promise<void> => {
    if (closed || backgrounded) return;
    const config = data.sources.find((s) => s.id === id);
    if (!config || !statuses.has(id)) return;
    const generation = generations.get(id) ?? 0;

    const outcome = await fetchReport(config.url, config.name, {
      ...(config.token ? { token: config.token } : {}),
    });
    // Restarted, removed, closed or paused meanwhile: this answer belongs to nobody.
    if (closed || backgrounded || generation !== (generations.get(id) ?? 0)) return;
    const status = statuses.get(id);
    if (!status) return;
    const now = Date.now();

    if (outcome.report) {
      statuses.set(id, applyReport(status, outcome.report, now));
      failures.set(id, 0);
    } else {
      statuses.set(id, applyError(status, outcome.error ?? "failed", now));
      failures.set(id, (failures.get(id) ?? 0) + 1);
    }

    void draw();
    phone?.refreshLive();

    const delay = backoffMs(failures.get(id) ?? 0, data.pollSeconds * 1000);
    // An extra poll (after an action) must replace the scheduled one, not run
    // beside it as a second loop.
    const scheduled = timers.get(id);
    if (scheduled !== undefined) clearTimeout(scheduled);
    timers.set(id, setTimeout(() => { void pollSource(id); }, delay));
  };

  const startPolling = (): void => {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    for (const config of data.sources) {
      generations.set(config.id, (generations.get(config.id) ?? 0) + 1);
      void pollSource(config.id);
    }
  };

  const stopPolling = (): void => {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    // Answers still in flight are dropped.
    for (const id of generations.keys()) generations.set(id, (generations.get(id) ?? 0) + 1);
  };

  // ---- sample data ------------------------------------------------------------------------------

  /** Puts (new) sample readings into the sources; the sample never goes stale. */
  const seedDemo = (): void => {
    const now = Date.now();
    demoStep += 1;
    const put = (id: string, report: Parameters<typeof applyReport>[1], offlineMinutes = 0): void => {
      const status = statuses.get(id);
      if (!status) return;
      const seen = offlineMinutes > 0 ? now - offlineMinutes * 60_000 : now;
      const fresh = applyReport(status, report, seen);
      statuses.set(id, offlineMinutes > 0 ? applyError(fresh, "unreachable", now) : fresh);
    };
    if (NAS_DEMO) {
      put("nas", demoNasReport(SCENE, demoStep));
      return;
    }
    for (const machine of demoMachines) {
      const report = demoFleetReport(machine, demoStep);
      put(machine.id, SCENE === "fleet" && machine.id === "spark" ? { ...report, network: demoNetwork(now) } : report, machine.offlineMinutes);
    }
  };
  const startDemoTimer = (): void => {
    if (!demo || demoTimer !== null || closed) return;
    demoTimer = setInterval(() => { seedDemo(); void draw(); phone?.refreshLive(); }, DEMO_REFRESH_MS);
  };
  const stopDemoTimer = (): void => {
    if (demoTimer !== null) clearInterval(demoTimer);
    demoTimer = null;
  };

  /** Asks every source again (the sample renews itself). */
  const reload = (): void => {
    if (demo) { seedDemo(); void draw(); phone?.refreshLive(); } else startPolling();
  };

  /**
   * Double tap on the start page asks the system exit dialog. Polling carries on while it is
   * open; the system ends the app on a confirmed exit (sysEvent 6/7, which stops every timer and drops
   * anything still in flight). The call resolves when the dialog is SHOWN, not when the user answered.
   */
  const requestExit = createExitRequest(bridge, {
    // On the next input put the page up again the way of the first one,
    // so the glasses deliver input (and the next 2x) to the app again.
    onBack: () => {
      if (closed) return;
      pageReady = false;
      lastView = null;
      installed = null;
      forgetPage(bridge);
      return draw();
    },
  }, "statusglass");
  exitAsked = requestExit.asked;

  const executeAction = async (sourceId: string, actionId: string, label: string): Promise<void> => {
    const config = data.sources.find((c) => c.id === sourceId);
    if (!config) return;

    actionBusy = true;
    disarm();
    actionResult = null;
    await draw();

    const outcome = demo ? { ok: true } as { ok: boolean; error?: string } : await runAction(config.url, actionId, {
      ...(config.token ? { token: config.token } : {}),
    });
    if (closed) return;

    actionBusy = false;
    actionResult = { label: outcome.ok ? label : (outcome.error ?? "failed"), ok: outcome.ok };
    await draw();

    // Refresh straight away so the dashboard reflects what the action changed.
    if (outcome.ok && !demo) void pollSource(sourceId);
  };

  // The glasses listen before anything else is awaited: a page that is
  // still being built, or a source that does not answer, must never make a
  // tap or the exit double tap go nowhere.
  let startTick = (): void => undefined;
  const stopTick = (): void => {
    if (tickTimer !== null) clearInterval(tickTimer);
    tickTimer = null;
  };
  /** Left through the system: polling stops; the place on the glasses is saved. */
  const goBackground = (): void => {
    saveUi();
    backgrounded = true;
    stopPolling();
    stopTick();
    stopDemoTimer();
  };
  const comeBack = (): Promise<void> => {
    backgrounded = false;
    pageReady = false;
    lastView = null;
    installed = null;
    startTick();
    startDemoTimer();
    const restore = draw();
    if (!demo) startPolling();
    return restore;
  };

  /** An item of the glasses' side menu. Nothing here changes data. */
  const onMenu = (itemId: number): void => {
    if (actionBusy) return;
    disarm();
    disarmAck();
    actionResult = null;
    if (itemId === MENU_ACTIONS) { screen = "actions"; actionCursor = 0; }
    else if (itemId === MENU_RELOAD) reload();
    else return;
    saveUi();
    void draw();
  };

  /** Opens the row under the cursor of the start page. */
  const openStartRow = (sources: readonly SourceStatus[], now: number): void => {
    const rows = startRows(sources, allProblems(now).length, availableActions(sources).length);
    const row = rows[startCursor];
    if (!row) return;
    if (row.kind === "all") { screen = "cockpit"; pageIndex = 0; }
    else if (row.kind === "host") {
      screen = "cockpit";
      pageIndex = Math.max(0, cockpitPages(sources).findIndex((page) => page.kind === "host" && page.id === row.id));
    } else if (row.kind === "problems") { screen = "problems"; problemCursor = 0; disarmAck(); }
    else { screen = "actions"; actionCursor = 0; disarm(); actionResult = null; }
  };

  bridge.onEvenHubEvent((event) => {
    if (closed) return;
    // The 4/5 right after an exit call are the system dialog's own show/close, not the app entering/leaving.
    if (requestExit.onLifecycle(event) !== null) return;
    const lifecycle = lifecycleFromEvent(event);
    if (isBackSignal(event)) requestExit.back();
    if (lifecycle === "foreground") { comeBack(); return; }
    if (lifecycle === "background") { goBackground(); return; }
    if (lifecycle === "exit") {
      goBackground();
      closed = true;
      tiles.close();
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      return;
    }
    // The glasses' side menu (off while SIDE_MENU is false). A menu click never runs anything.
    const menuId = menuItemIdFromEvent(event);
    if (menuId !== null) {
      if (backgrounded) { comeBack(); return; }
      onMenu(menuId);
      return;
    }
    const gesture = gestureFromEvent(event, { invertScroll: data.invertScroll });
    if (!gesture) return;
    // A gesture means the app is on the glasses again, even if no "foreground" came first.
    if (backgrounded) {
      const restore = comeBack();
      // A double tap on the start page while backgrounded comes back and asks the dialog (it waits for exactly
      // this restore draw) instead of being swallowed.
      if (gesture.gesture === "doubleClick" && screen === "start") void settleRestore(restore).then(() => requestExit());
      return;
    }

    const sources = [...statuses.values()];
    const now = Date.now();

    // Armed "seen" lapses on anything but its confirming tap (a swipe cancels and still moves).
    if (ackArmed() && screen !== "problems") disarmAck();

    if (screen === "actions") {
      const actions = availableActions(sources);
      switch (gesture.gesture) {
        case "click": {
          if (actionBusy) break;
          const entry = actions[actionCursor];
          if (!entry) break;
          // Every action is armed first (a source's "confirm" only adds the "!" mark): a second
          // single tap within ARM_MS runs it. Switching something in the house is never one tap away.
          if (pendingActionId !== entry.action.id) {
            arm(entry.action.id);
            actionResult = null;
            break;
          }
          void executeAction(entry.sourceId, entry.action.id, entry.action.label);
          return;
        }
        case "scrollUp":
        case "scrollDown": {
          // A swipe only moves - and cancels an armed action, so the tap that follows can
          // never run the previously highlighted one.
          disarm();
          actionResult = null;
          const delta = gesture.gesture === "scrollDown" ? 1 : -1;
          actionCursor = Math.min(Math.max(0, actions.length - 1), Math.max(0, actionCursor + delta));
          break;
        }
        case "doubleClick":
          // 2× is "back one level" - never a way to leave from here.
          disarm();
          screen = "start";
          actionResult = null;
          break;
        default:
          // Hold does nothing here: it must never run, cancel or leave anything.
          return;
      }
      saveUi();
      void draw();
      return;
    }

    if (screen === "problems") {
      const list = allProblems(now);
      switch (gesture.gesture) {
        case "click": {
          // Acknowledging says "I know" — it never hides the problem, it just stops it being the headline.
          // The first tap asks (footer: Nochmal tippen = gesehen), a second one within ARM_MS does it.
          const problem = list[problemCursor];
          if (!problem || problem.acknowledged) break;
          if (!ackArmed()) { armAck(); break; }
          disarmAck();
          const status = statuses.get(problem.sourceId);
          if (status) statuses.set(problem.sourceId, acknowledge(status, problem.metric.id));
          break;
        }
        case "scrollUp":
          disarmAck();
          problemCursor = Math.max(0, problemCursor - 1);
          break;
        case "scrollDown":
          disarmAck();
          problemCursor = Math.min(Math.max(0, list.length - 1), problemCursor + 1);
          break;
        case "doubleClick":
          disarmAck();
          screen = "start";
          break;
        default:
          return;
      }
      saveUi();
      void draw();
      phone?.refreshLive();
      return;
    }

    if (screen === "cockpit") {
      const pages = cockpitPages(sources);
      switch (gesture.gesture) {
        case "click":
          // Harmless: ask every source again.
          reload();
          return;
        case "scrollUp":
          pageIndex = Math.max(0, Math.min(pageIndex, pages.length - 1) - 1);
          break;
        case "scrollDown":
          pageIndex = Math.min(pages.length - 1, pageIndex + 1);
          break;
        case "doubleClick":
          screen = "start";
          break;
        default:
          return;
      }
      saveUi();
      void draw();
      return;
    }

    // The start page.
    const rows = startRows(sources, allProblems(now).length, availableActions(sources).length);
    switch (gesture.gesture) {
      case "click":
        openStartRow(sources, now);
        break;
      case "scrollUp":
        startCursor = Math.max(0, startCursor - 1);
        break;
      case "scrollDown":
        startCursor = Math.min(Math.max(0, rows.length - 1), startCursor + 1);
        break;
      case "doubleClick":
        void requestExit();
        return;
      default:
        return;
    }
    saveUi();
    void draw();
  });

  syncSources();
  if (demo) seedDemo();
  await draw();
  if (!demo) startPolling();
  startDemoTimer();

  bridge.onDeviceStatusChanged((status) => {
    if (status?.connectType === "connected" && !closed) {
      pageReady = false;
      void draw();
    }
  });

  // Keeps staleness and the clock current even when no source answers at all.
  startTick = (): void => {
    if (tickTimer !== null || closed) return;
    tickTimer = setInterval(() => { void draw(); }, TICK_MS);
  };
  startTick();

  /** Marks a device known on its source and shows it at once; the next poll confirms it. */
  const markKnown = async (sourceId: string, mac: string): Promise<string | null> => {
    const config = data.sources.find((s) => s.id === sourceId);
    if (!config) return describeIssue("failed", locale);
    if (!demo) {
      const outcome = await markDeviceKnown(config.url, mac, true, {
        ...(config.token ? { token: config.token } : {}),
      });
      if (!outcome.ok) return describeIssue(outcome.error ?? "failed", locale, { detail: true });
    }
    const status = statuses.get(sourceId);
    const report = status?.report;
    if (status && report?.network) {
      const devices = report.network.devices.map((d) => (d.mac === mac ? { ...d, known: true, new: false } : d));
      const network = { ...report.network, devices, new: devices.filter((d) => d.new).length };
      statuses.set(sourceId, { ...status, report: { ...report, network } });
    }
    void draw();
    phone?.refreshLive();
    if (!demo && !closed && !backgrounded) void pollSource(sourceId);
    return null;
  };

  phone = mountPhoneUi({
    getLocale: () => locale,
    getNetworks: () => data.sources.flatMap((config): PhoneNetwork[] => {
      const network = statuses.get(config.id)?.report?.network;
      return network ? [{ sourceId: config.id, name: config.name, network }] : [];
    }),
    getStatuses: () => [...statuses.values()],
    isDemo: () => demo,
    refresh: reload,
    markKnown,
    setLocale: (next) => {
      locale = next;
      rememberLocale(bridge, next);
      // The glasses follow straight away, not on the next poll.
      void draw();
    },
    // The phone always works on what is stored, never on the first-start sample sources.
    getData: () => (firstStartDemo ? stored : data),
    setData: async (next) => {
      stored = next;
      // Other settings changed while there is still no source: the sample sources stay.
      data = firstStartDemo && next.sources.length === 0 ? { ...next, sources: demoSources } : next;
      await save(bridge, next);
      if (firstStartDemo && next.sources.length > 0) {
        // The first real source ends the demo: sample data goes, polling starts.
        firstStartDemo = false;
        demo = false;
        stopDemoTimer();
        statuses = new Map();
        screen = "start";
      }
      syncSources();
      startCursor = 0;
      problemCursor = 0;
      pageIndex = 0;
      if (!demo) startPolling();
      await draw();
      phone?.refreshLive();
    },
  });
}

void boot().catch((error: unknown) => {
  console.error("[statusglass] failed to start:", error);
});
