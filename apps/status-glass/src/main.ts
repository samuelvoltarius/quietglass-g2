import { waitForEvenAppBridge, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { backoffMs, fetchReport, runAction } from "./protocol/fetcher";
import {
  acknowledge, applyError, applyReport, createSource, problems, type SourceStatus,
} from "./monitor/dashboard";
import { gestureFromEvent } from "./input/gestures";
import { buildView, type StatusView } from "./glasses/view";
import { availableActions, buildActionsView } from "./glasses/actions-view";
import { sameView } from "./glasses/diff";
import { createPage, updatePage } from "./glasses/render";
import { load, save, type StatusData } from "./storage/persist";
import { mountPhoneUi } from "./ui/phone";
import { createExitRequest } from "./exit";
import { getLocale, setLocale, type Locale } from "./i18n";

const DEMO = new URLSearchParams(location.search).get("demo") === "1";

async function boot(): Promise<void> {
  const bridge: EvenAppBridge = await waitForEvenAppBridge();

  let data: StatusData = await load(bridge);
  if (DEMO) data = { ...data, sources: [{ id: "ha", name: "HA", url: "http://demo.local/home-assistant" }] };
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
  let pageReady = false;
  let locale: Locale = getLocale();

  // The actions screen is a separate mode. Monitoring is something you glance
  // at; triggering something in your house is deliberate, so a stray tap on the
  // dashboard can never run anything.
  let screen: "status" | "actions" = "status";
  let actionCursor = 0;
  let pendingActionId: string | null = null;
  let actionBusy = false;
  let actionResult: { label: string; ok: boolean } | null = null;

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

  const currentView = (): StatusView => {
    if (screen === "actions") {
      return buildActionsView(availableActions([...statuses.values()]), {
        cursor: actionCursor,
        pendingId: pendingActionId,
        result: actionResult,
        busy: actionBusy,
        locale,
      });
    }
    return buildView([...statuses.values()], { cursor, locale }, Date.now());
  };

  const draw = async (): Promise<void> => {
    if (closed) return;
    const view = currentView();
    if (sameView(lastView, view)) return;

    const result = pageReady ? await updatePage(bridge, view) : await createPage(bridge, view);
    if (closed) return;
    if (result.ok) {
      pageReady = true;
      lastView = view;
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
    if (closed) return;
    const config = data.sources.find((s) => s.id === id);
    if (!config || !statuses.has(id)) return;
    const generation = generations.get(id) ?? 0;

    const outcome = await fetchReport(config.url, config.name, {
      ...(config.token ? { token: config.token } : {}),
    });
    // Restarted, removed or closed meanwhile: this answer belongs to nobody.
    if (closed || generation !== (generations.get(id) ?? 0)) return;
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

  syncSources();
  if (DEMO) {
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

  bridge.onEvenHubEvent((event) => {
    if (closed) return;
    const gesture = gestureFromEvent(event, { invertScroll: data.invertScroll });
    if (!gesture) return;

    const sources = [...statuses.values()];

    if (screen === "actions") {
      const actions = availableActions(sources);
      switch (gesture.gesture) {
        case "click": {
          const entry = actions[actionCursor];
          if (!entry || actionBusy) break;
          // An action the source marked as consequential needs a second tap.
          if (entry.action.confirm && pendingActionId !== entry.action.id) {
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
      void draw();
      return;
    }

    const list = problems(sources, Date.now());

    switch (gesture.gesture) {
      case "click": {
        // Acknowledging says "I know" — it never hides the problem, it just
        // stops it being the headline.
        const problem = list[cursor];
        if (!problem) break;
        const status = statuses.get(problem.sourceId);
        if (status) statuses.set(problem.sourceId, acknowledge(status, problem.metric.id));
        break;
      }
      case "scrollUp":
        cursor = Math.max(0, cursor - 1);
        break;
      case "scrollDown":
        cursor = Math.min(Math.max(0, list.length - 1), cursor + 1);
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
    void draw();
  });

  bridge.onDeviceStatusChanged((status) => {
    if (status?.connectType === "connected" && !closed) {
      pageReady = false;
      void draw();
    }
  });

  // Keeps staleness current even when no source answers at all.
  tickTimer = setInterval(() => { void draw(); }, 5000);

  mountPhoneUi({
    getLocale: () => locale,
    setLocale: (next) => {
      locale = next;
      setLocale(next);
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
