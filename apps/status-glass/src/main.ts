import { waitForEvenAppBridge, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { backoffMs, fetchReport, runAction } from "./protocol/fetcher";
import {
  acknowledge, applyError, applyReport, createSource, problems, type SourceStatus,
} from "./monitor/dashboard";
import { gestureFromEvent } from "./input/gestures";
import { lifecycleFromEvent } from "./lifecycle";
import { buildView, type StatusView } from "./glasses/view";
import { MetricHistory, type SparkSeries } from "./monitor/history";
import { DEMO_FLEET, demoFleetReport, demoNasReport } from "./monitor/demo";
import { PULSE_MS, SPARK_WIDTH, signFrame, signState, sparklineFrame } from "./glasses/charts";
import { detailPage, detailSeries } from "./glasses/detail";
import { bitmapKey } from "./glasses/gfx";
import { fleetPulses, fleetRowFrame, fleetRows, fleetView } from "./glasses/fleet";
import { availableActions, buildActionsView } from "./glasses/actions-view";
import { sameView } from "./glasses/diff";
import { BODY_ROWS, DETAIL_SPARK_HEIGHT, createPage, rebuildPage, updatePage, type Frames, type Layout } from "./glasses/render";
import { load, save, type StatusData } from "./storage/persist";
import { mountPhoneUi } from "./ui/phone";
import { createExitRequest } from "./exit";
import { rememberLocale, resolveLocale, type Locale } from "./i18n";

const DEMO = new URLSearchParams(location.search).get("demo") === "1";
/** `?demo=1&scene=graph|warn|critical` shows a NAS with CPU/GPU/RAM sparklines; without it a Home Assistant demo. */
const SCENE = new URLSearchParams(location.search).get("scene");
/** Where the user was on the glasses (machine, detail page); a restart after a locked phone comes back there. */
const UI_KEY = "quietglass.statusglass.ui.v1";

interface SavedUi {
  readonly screen?: "status" | "detail";
  readonly fleetCursor?: number;
  readonly cursor?: number;
  readonly sparkIndex?: number;
  readonly detailId?: string | null;
  readonly detailIndex?: number;
}

function parseUi(raw: string): SavedUi {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const n = (x: unknown): number | undefined => (typeof x === "number" && Number.isInteger(x) && x >= -1000 && x <= 1000 ? x : undefined);
    const out: { -readonly [K in keyof SavedUi]: SavedUi[K] } = {};
    if (value.screen === "detail" || value.screen === "status") out.screen = value.screen;
    for (const key of ["fleetCursor", "cursor", "sparkIndex", "detailIndex"] as const) {
      const v = n(value[key]);
      if (v !== undefined) out[key] = Math.max(key === "sparkIndex" ? -1000 : 0, v);
    }
    if (typeof value.detailId === "string") out.detailId = value.detailId;
    return out;
  } catch {
    return {};
  }
}

async function boot(): Promise<void> {
  const bridge: EvenAppBridge = await waitForEvenAppBridge();

  let data: StatusData = await load(bridge);
  const NAS_DEMO = DEMO && SCENE !== null;
  if (DEMO) {
    data = { ...data, sources: SCENE === "fleet" ? DEMO_FLEET.map((m) => ({ id: m.id, name: m.name, url: `http://demo.local/${m.id}` })) : NAS_DEMO ? [{ id: "nas", name: "NAS", url: "http://demo.local/nas" }] : [{ id: "ha", name: "HA", url: "http://demo.local/home-assistant" }] };
  }
  const history = new MetricHistory();
  /** Which source's sparklines to show while nothing is wrong; a swipe changes it. */
  let sparkIndex = 0;
  /** Which machine is highlighted in the overview (two or more sources). */
  let fleetCursor = 0;
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
  let cursor = 0;
  let lastView: StatusView | null = null;
  let lastLayout: Layout = "list";
  let lastFrames = "";
  let pageReady = false;
  /** createStartUpPageContainer runs once; afterwards a page is only ever rebuilt. */
  let created = false;
  let locale: Locale = await resolveLocale(bridge);

  // The actions screen is a separate mode. Monitoring is something you glance
  // at; triggering something in your house is deliberate, so a stray tap on the
  // dashboard can never run anything.
  let screen: "status" | "actions" | "detail" = "status";
  /** The machine whose detail page is open, and which page of it. */
  let detailId: string | null = null;
  let detailIndex = 0;
  let actionCursor = 0;
  let pendingActionId: string | null = null;
  let actionBusy = false;
  let actionResult: { label: string; ok: boolean } | null = null;
  /** Left through the system: no polling, no drawing until the app is back. */
  let backgrounded = false;

  // Back where the user was before a restart. The actions screen is never restored: running
  // something in the house always starts from a deliberate hold.
  if (!DEMO) {
    const ui = parseUi(await bridge.getLocalStorage(UI_KEY).catch(() => "") ?? "");
    fleetCursor = ui.fleetCursor ?? 0;
    cursor = ui.cursor ?? 0;
    sparkIndex = ui.sparkIndex ?? 0;
    if (ui.screen === "detail" && ui.detailId && data.sources.some((source) => source.id === ui.detailId)) {
      screen = "detail";
      detailId = ui.detailId;
      detailIndex = ui.detailIndex ?? 0;
    }
  }
  let savedUi = "";
  const saveUi = (): void => {
    if (DEMO) return;
    const ui: SavedUi = { screen: screen === "detail" ? "detail" : "status", fleetCursor, cursor, sparkIndex, detailId, detailIndex };
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
    for (const id of statuses.keys()) if (!next.has(id)) history.forget(id);
    for (const id of generations.keys()) {
      if (!next.has(id)) generations.set(id, (generations.get(id) ?? 0) + 1);
    }
    statuses = next;
  };

  interface Scene {
    readonly view: StatusView;
    readonly layout: Layout;
    readonly frames: Frames;
    /** True while something on this page pulses and wants a redraw twice a second. */
    readonly pulses: boolean;
  }

  /** The source whose sparklines are shown: the one with the highlighted problem, else the one a swipe picked. */
  const focusSeries = (sources: readonly SourceStatus[], now: number): { name: string; series: SparkSeries[] } | null => {
    const withSeries = sources
      .map((source) => ({ source, series: history.series(source.id, source.report) }))
      .filter((entry) => entry.series.length > 0);
    if (withSeries.length === 0) return null;
    const preferred = problems(sources, now)[cursor]?.sourceId;
    const count = withSeries.length;
    const pick = withSeries.find((entry) => entry.source.id === preferred)
      ?? withSeries[((sparkIndex % count) + count) % count]!;
    return { name: pick.source.name, series: pick.series };
  };

  /** Everything on the glasses for one moment: text, layout, sign and sparklines. */
  const currentScene = (now: number): Scene => {
    const sources = [...statuses.values()];
    const detailSource = screen === "detail" && detailId !== null ? statuses.get(detailId) : undefined;
    if (screen === "detail" && detailSource) {
      const page = detailPage(detailSource, detailIndex, locale, now);
      detailIndex = page.page;
      const sign = signState([detailSource], now);
      return {
        view: page.view,
        layout: "detail",
        frames: {
          sign: signFrame(sign, now),
          sparks: detailSeries(detailSource, history).map((series) => sparklineFrame(series, SPARK_WIDTH, DETAIL_SPARK_HEIGHT)),
        },
        pulses: sign === "critical",
      };
    }
    if (screen === "detail") screen = "status";
    if (screen === "actions") {
      const view = buildActionsView(availableActions(sources), {
        cursor: actionCursor,
        pendingId: pendingActionId,
        result: actionResult,
        busy: actionBusy,
        locale,
      });
      // The sign stands still here: only the status page pulses.
      return { view, layout: "list", frames: { sign: signFrame(signState(sources, now), 0), sparks: [] }, pulses: false };
    }
    // Two or more machines: one row each, light + name + load line, a failed one marked.
    if (sources.length >= 2) {
      fleetCursor = Math.min(fleetCursor, sources.length - 1);
      const rows = fleetRows(sources, history, fleetCursor, locale, now);
      return {
        view: fleetView(sources, rows, locale, now),
        layout: "fleet",
        frames: { sign: signFrame(signState(sources, now), now), sparks: [], rows: rows.map((row) => fleetRowFrame(row, now)) },
        pulses: fleetPulses(rows),
      };
    }
    const focus = focusSeries(sources, now);
    const layout: Layout = focus ? "graph" : "list";
    const view = buildView(sources, {
      cursor, locale, maxRows: BODY_ROWS[layout], ...(focus ? { focusName: focus.name } : {}),
    }, now);
    return {
      view,
      layout,
      frames: {
        sign: signFrame(signState(sources, now), now),
        sparks: focus ? focus.series.map((series) => sparklineFrame(series)) : [],
      },
      pulses: signState(sources, now) === "critical",
    };
  };

  const draw = async (): Promise<void> => {
    if (closed || backgrounded) return;
    const { view, layout, frames } = currentScene(Date.now());
    const pictures = layout === "fleet" ? frames.rows ?? [] : [frames.sign, ...frames.sparks];
    const key = pictures.map((frame) => (frame ? bitmapKey(frame) : "-")).join("|");
    if (pageReady && layout === lastLayout && sameView(lastView, view) && key === lastFrames) return;

    let result;
    if (!pageReady) {
      // After the first creation a page is only rebuilt: a second create would be refused as invalid.
      result = created ? await rebuildPage(bridge, view, layout, frames) : await createPage(bridge, view, layout, frames);
      if (result.ok) created = true;
    } else if (layout !== lastLayout) {
      result = await rebuildPage(bridge, view, layout, frames);
    } else {
      result = await updatePage(bridge, view, layout, frames, lastView);
    }
    if (closed) return;
    if (result.ok) {
      pageReady = true;
      lastView = view;
      lastLayout = layout;
      lastFrames = key;
      return;
    }
    pageReady = false;
    console.warn("[statusglass] draw failed:", result.reason);
  };

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
      history.record(id, outcome.report);
      statuses.set(id, applyReport(status, outcome.report, now));
      failures.set(id, 0);
    } else {
      statuses.set(id, applyError(status, outcome.error ?? "failed", now));
      failures.set(id, (failures.get(id) ?? 0) + 1);
    }

    void draw();

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

  /**
   * Double tap asks the system exit dialog. Polling carries on while it is
   * open; only a confirmed exit stops every timer and drops anything still in
   * flight.
   */
  const requestExit = createExitRequest(bridge, {
    onConfirmed: () => {
      closed = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      if (tickTimer !== null) clearInterval(tickTimer);
    },
  }, "statusglass");

  const executeAction = async (sourceId: string, actionId: string, label: string): Promise<void> => {
    const config = data.sources.find((c) => c.id === sourceId);
    if (!config) return;

    actionBusy = true;
    pendingActionId = null;
    actionResult = null;
    await draw();

    const outcome = await runAction(config.url, actionId, {
      ...(config.token ? { token: config.token } : {}),
    });
    if (closed) return;

    actionBusy = false;
    actionResult = { label: outcome.ok ? label : (outcome.error ?? "failed"), ok: outcome.ok };
    await draw();

    // Refresh straight away so the dashboard reflects what the action changed.
    if (outcome.ok) void pollSource(sourceId);
  };

  // The glasses listen before anything else is awaited: a page that is
  // still being built, or a source that does not answer, must never make a
  // tap or the exit double tap go nowhere.
  const stopPolling = (): void => {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    // Answers still in flight are dropped.
    for (const id of generations.keys()) generations.set(id, (generations.get(id) ?? 0) + 1);
  };
  let startTick = (): void => undefined;
  const stopTick = (): void => {
    if (tickTimer !== null) clearInterval(tickTimer);
    tickTimer = null;
  };
  /** Left through the system: polling and the pulse stop; the place on the glasses is saved. */
  const goBackground = (): void => {
    saveUi();
    backgrounded = true;
    stopPolling();
    stopTick();
  };
  const comeBack = (): void => {
    backgrounded = false;
    pageReady = false;
    lastView = null;
    lastFrames = "";
    startTick();
    void draw();
    if (!DEMO) startPolling();
  };

  bridge.onEvenHubEvent((event) => {
    if (closed) return;
    const lifecycle = lifecycleFromEvent(event);
    if (lifecycle === "foreground") { comeBack(); return; }
    if (lifecycle === "background") { goBackground(); return; }
    if (lifecycle === "exit") { goBackground(); closed = true; return; }
    const gesture = gestureFromEvent(event, { invertScroll: data.invertScroll });
    if (!gesture) return;
    // A gesture means the app is on the glasses again, even if no "foreground" came first.
    if (backgrounded) { comeBack(); return; }

    const sources = [...statuses.values()];

    if (screen === "actions") {
      const actions = availableActions(sources);
      switch (gesture.gesture) {
        case "click": {
          const entry = actions[actionCursor];
          if (!entry || actionBusy) break;
          // Every action needs a second tap (a source's "confirm" only adds the "!" mark):
          // switching something in the house is never one stray tap away.
          if (pendingActionId !== entry.action.id) {
            pendingActionId = entry.action.id;
            actionResult = null;
            break;
          }
          void executeAction(entry.sourceId, entry.action.id, entry.action.label);
          return;
        }
        case "scrollUp":
        case "scrollDown": {
          // Moving the selection cancels a pending confirmation, so the tap
          // that follows can never run the previously highlighted action.
          pendingActionId = null;
          actionResult = null;
          const delta = gesture.gesture === "scrollDown" ? 1 : -1;
          actionCursor = Math.min(Math.max(0, actions.length - 1), Math.max(0, actionCursor + delta));
          break;
        }
        case "longPress":
          screen = "status";
          pendingActionId = null;
          actionResult = null;
          break;
        case "doubleClick":
          void requestExit();
          return;
        default:
          return;
      }
      saveUi();
      void draw();
      return;
    }

    if (screen === "detail") {
      const source = detailId !== null ? statuses.get(detailId) : undefined;
      switch (gesture.gesture) {
        case "click":
        case "scrollDown":
          detailIndex += 1;
          break;
        case "scrollUp":
          detailIndex -= 1;
          break;
        case "longPress": {
          // Hold = "I have seen it": every open problem of this machine stops being the headline.
          if (!source) break;
          let next = source;
          for (const problem of problems([source], Date.now())) next = acknowledge(next, problem.metric.id);
          statuses.set(source.id, next);
          break;
        }
        case "doubleClick":
          screen = "status";
          detailId = null;
          break;
        default:
          return;
      }
      saveUi();
      void draw();
      return;
    }

    // In the overview the highlighted machine's problems are the list, worst first.
    const fleet = sources.length >= 2;
    const list = fleet
      ? problems(sources.slice(fleetCursor, fleetCursor + 1), Date.now())
      : problems(sources, Date.now());

    switch (gesture.gesture) {
      case "click": {
        // With several machines a tap opens the highlighted one in detail.
        if (fleet) {
          const target = sources[fleetCursor];
          if (!target) break;
          screen = "detail";
          detailId = target.id;
          detailIndex = 0;
          break;
        }
        // Acknowledging says "I know" — it never hides the problem, it just
        // stops it being the headline.
        const problem = list[cursor];
        if (!problem) break;
        const status = statuses.get(problem.sourceId);
        if (status) statuses.set(problem.sourceId, acknowledge(status, problem.metric.id));
        break;
      }
      case "scrollUp":
        if (fleet) fleetCursor = Math.max(0, fleetCursor - 1);
        // With nothing wrong a swipe switches the source whose sparklines are shown.
        else if (list.length === 0) sparkIndex -= 1;
        else cursor = Math.max(0, cursor - 1);
        break;
      case "scrollDown":
        if (fleet) fleetCursor = Math.min(sources.length - 1, fleetCursor + 1);
        else if (list.length === 0) sparkIndex += 1;
        else cursor = Math.min(Math.max(0, list.length - 1), cursor + 1);
        break;
      case "longPress":
        // Hold opens the actions screen when anything is on offer; otherwise
        // it keeps its old meaning of refreshing everything.
        if (availableActions(sources).length > 0) {
          screen = "actions";
          actionCursor = 0;
          pendingActionId = null;
          actionResult = null;
        } else {
          startPolling();
        }
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
  if (SCENE === "fleet") {
    const now = Date.now();
    for (const machine of DEMO_FLEET) {
      const status = statuses.get(machine.id);
      if (!status) continue;
      const seen = machine.offlineMinutes > 0 ? now - machine.offlineMinutes * 60_000 : now;
      for (let step = 0; step < 12; step += 1) history.record(machine.id, demoFleetReport(machine, step));
      const fresh = applyReport(status, demoFleetReport(machine, 11), seen);
      statuses.set(machine.id, machine.offlineMinutes > 0 ? applyError(fresh, "unreachable", now) : fresh);
    }
  } else if (NAS_DEMO) {
    const now = Date.now();
    const nas = statuses.get("nas");
    if (nas) {
      for (let step = 0; step < 12; step += 1) history.record("nas", demoNasReport(SCENE, step));
      statuses.set("nas", applyReport(nas, demoNasReport(SCENE, 11), now));
    }
  } else if (DEMO) {
    const now = Date.now();
    const homeAssistant = statuses.get("ha");
    if (homeAssistant) statuses.set("ha", applyReport(homeAssistant, {
      name: "HA",
      metrics: [
        { id: "door", label: "Front door unlocked", state: "warn" },
        { id: "battery", label: "Hall sensor battery", value: 12, unit: "%", warn: 20, critical: 8, lowerIsWorse: true },
        { id: "heat", label: "Living room heating", state: "ok" },
      ],
      actions: [
        { id: "all-lights-off", label: "All lights off", confirm: true },
        { id: "lock-front-door", label: "Lock front door", confirm: true },
      ],
    }, now));
  }
  await draw();
  if (!DEMO) startPolling();

  bridge.onDeviceStatusChanged((status) => {
    if (status?.connectType === "connected" && !closed) {
      pageReady = false;
      void draw();
    }
  });

  // Keeps staleness current even when no source answers at all (every 5 s), and
  // pulses the alarm sign once per second while something is critical on the
  // status page (a redraw every half second; unchanged frames cost nothing).
  let ticks = 0;
  startTick = (): void => {
    if (tickTimer !== null || closed) return;
    tickTimer = setInterval(() => {
      ticks += 1;
      const pulsing = screen === "status" && currentScene(Date.now()).pulses;
      if (pulsing || ticks % 10 === 0) void draw();
    }, PULSE_MS);
  };
  startTick();

  mountPhoneUi({
    getLocale: () => locale,
    setLocale: (next) => {
      locale = next;
      rememberLocale(bridge, next);
      // The glasses follow straight away, not on the next poll.
      void draw();
    },
    getData: () => data,
    setData: async (next) => {
      data = next;
      await save(bridge, next);
      syncSources();
      cursor = 0;
      startPolling();
      await draw();
    },
  });
}

void boot().catch((error: unknown) => {
  console.error("[statusglass] failed to start:", error);
});
