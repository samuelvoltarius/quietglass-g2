import { waitForEvenAppBridge, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import {
  addEntry, isRunning, nextEntryId, startProject, stop, type ClockState,
} from "./tracking/clock";
import { gestureFromEvent } from "./input/gestures";
import { buildView, type ClockView } from "./glasses/view";
import { sameView } from "./glasses/diff";
import { createPage, updatePage } from "./glasses/render";
import { load, save, type ClockData } from "./storage/persist";
import { mountPhoneUi } from "./ui/phone";

async function boot(): Promise<void> {
  const bridge: EvenAppBridge = await waitForEvenAppBridge();

  let data: ClockData = await load(bridge);
  let clock: ClockState = data.open;
  /** Non-null while the user is picking a project on the glasses. */
  let selecting: string | null = null;
  let lastView: ClockView | null = null;
  let pageReady = false;

  const currentView = (): ClockView =>
    buildView(clock, data.entries, { selecting, projects: data.projects });

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
    console.warn("[shiftclock] draw failed:", result.reason);
  };

  /** Persists immediately: tracked time must survive a crash or disconnect. */
  const persist = async (): Promise<void> => {
    data = { ...data, open: clock };
    await save(bridge, data);
  };

  await draw();

  bridge.onEvenHubEvent((event) => {
    const gesture = gestureFromEvent(event, { invertScroll: data.invertScroll });
    if (!gesture) return;

    const now = Date.now();

    switch (gesture.gesture) {
      case "click": {
        if (isRunning(clock)) {
          const result = stop(clock, now, () => nextEntryId(data.entries));
          clock = result.state;
          if (result.closed) data = { ...data, entries: addEntry(data.entries, result.closed) };
          selecting = null;
        } else if (selecting !== null) {
          const result = startProject(clock, selecting, now, () => nextEntryId(data.entries));
          clock = result.state;
          if (result.closed) data = { ...data, entries: addEntry(data.entries, result.closed) };
          selecting = null;
        } else {
          // Opening the picker starts at the most recently used project, which
          // is nearly always the one wanted again.
          selecting = mostRecentProject(data) ?? data.projects[0] ?? null;
          if (selecting === null) break;
        }
        void persist();
        break;
      }

      case "scrollUp":
      case "scrollDown": {
        if (data.projects.length === 0) break;
        if (!isRunning(clock)) {
          selecting = stepProject(data.projects, selecting, gesture.gesture === "scrollDown" ? 1 : -1);
        }
        break;
      }

      case "doubleClick":
        // Leaving does not stop the clock: the open entry is persisted and
        // resumes next time. Ending a shift is an explicit tap, not an exit.
        void persist();
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

  setInterval(() => { void draw(); }, 1000);

  mountPhoneUi({
    getData: () => data,
    setData: async (next) => {
      data = next;
      clock = next.open;
      await save(bridge, next);
      await draw();
    },
  });
}

function stepProject(
  projects: readonly string[],
  current: string | null,
  delta: number,
): string {
  const index = current === null ? -1 : projects.indexOf(current);
  const count = projects.length;
  const next = (((index + delta) % count) + count) % count;
  return projects[next] ?? projects[0] ?? "";
}

function mostRecentProject(data: ClockData): string | null {
  const last = [...data.entries].sort((a, b) => b.endedAt - a.endedAt)[0];
  if (last && data.projects.includes(last.project)) return last.project;
  return null;
}

void boot().catch((error: unknown) => {
  console.error("[shiftclock] failed to start:", error);
});
