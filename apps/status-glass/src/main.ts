import { waitForEvenAppBridge, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { backoffMs, fetchReport } from "./protocol/fetcher";
import {
  acknowledge, applyError, applyReport, createSource, problems, type SourceStatus,
} from "./monitor/dashboard";
import { gestureFromEvent } from "./input/gestures";
import { buildView, type StatusView } from "./glasses/view";
import { sameView } from "./glasses/diff";
import { createPage, updatePage } from "./glasses/render";
import { load, save, type StatusData } from "./storage/persist";
import { mountPhoneUi } from "./ui/phone";

async function boot(): Promise<void> {
  const bridge: EvenAppBridge = await waitForEvenAppBridge();

  let data: StatusData = await load(bridge);
  let statuses = new Map<string, SourceStatus>();
  const failures = new Map<string, number>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let cursor = 0;
  let lastView: StatusView | null = null;
  let pageReady = false;

  const syncSources = (): void => {
    const next = new Map<string, SourceStatus>();
    for (const config of data.sources) {
      next.set(config.id, statuses.get(config.id) ?? createSource(config.id, config.name));
    }
    // Stop polling anything that has been removed.
    for (const [id, timer] of timers) {
      if (!next.has(id)) { clearTimeout(timer); timers.delete(id); failures.delete(id); }
    }
    statuses = next;
  };

  const currentView = (): StatusView =>
    buildView([...statuses.values()], { cursor }, Date.now());

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
    console.warn("[statusglass] draw failed:", result.reason);
  };

  /**
   * Each source polls on its own timer. A failing source backs off without
   * slowing the healthy ones — one dead host must not blind the dashboard.
   */
  const pollSource = async (id: string): Promise<void> => {
    const config = data.sources.find((s) => s.id === id);
    const status = statuses.get(id);
    if (!config || !status) return;

    const outcome = await fetchReport(config.url, config.name, {
      ...(config.token ? { token: config.token } : {}),
    });
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
    timers.set(id, setTimeout(() => { void pollSource(id); }, delay));
  };

  const startPolling = (): void => {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    for (const config of data.sources) {
      void pollSource(config.id);
    }
  };

  syncSources();
  await draw();
  startPolling();

  bridge.onEvenHubEvent((event) => {
    const gesture = gestureFromEvent(event, { invertScroll: data.invertScroll });
    if (!gesture) return;

    const list = problems([...statuses.values()], Date.now());

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
        // Force an immediate refresh of everything.
        startPolling();
        break;
      case "doubleClick":
        for (const timer of timers.values()) clearTimeout(timer);
        void bridge.shutDownPageContainer();
        return;
      default:
        return;
    }
    void draw();
  });

  bridge.onDeviceStatusChanged((status) => {
    if (status?.connectType === "connected") {
      pageReady = false;
      void draw();
    }
  });

  // Keeps staleness current even when no source answers at all.
  setInterval(() => { void draw(); }, 5000);

  mountPhoneUi({
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
