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

const PIXEL_ICON = ["...####...", ".########.", ".##....##.", "##...#.###", "##...#.###", "##...####.", "##......##", ".##....##.", ".########.", "...####..."] as const;
const DEMO = new URLSearchParams(location.search).get("demo") === "1";

async function boot(): Promise<void> {
  const bridge: EvenAppBridge = await waitForEvenAppBridge();

  let data: ClockData = await load(bridge);
  if (DEMO) {
    const now = Date.now();
    data = { ...data, projects: ["Client Portal", "Research"], entries: [{ id: "demo-1", project: "Research", startedAt: now - 7_200_000, endedAt: now - 5_850_000 }], open: { project: "Client Portal", startedAt: now - 2_754_000 } };
  }
  let clock: ClockState = data.open;
  /** Non-null while the user is picking a project on the glasses. */
  let selecting: string | null = null;
  let lastView: ClockView | null = null;
  let pageReady = false;
  /** Set once the user leaves; nothing may be drawn on a closed page. */
  let closed = false;
  let drawing: Promise<void> | null = null;
  let redrawQueued = false;

  const currentView = (): ClockView =>
    buildView(clock, data.entries, { selecting, projects: data.projects });

  const drawOnce = async (): Promise<void> => {
    const view = currentView();
    if (sameView(lastView, view)) return;

    // The icon never changes, so it is sent with the page only. Re-encoding
    // and resending it on every clock tick cost a BLE image transfer a second.
    const result = pageReady ? await updatePage(bridge, view) : await createPage(bridge, view, PIXEL_ICON);
    if (result.ok) {
      pageReady = true;
      lastView = view;
      return;
    }
    pageReady = false;
    lastView = null;
    console.warn("[shiftclock] draw failed:", result.reason);
  };

  /**
   * One draw at a time. The clock tick, gestures and the phone all request
   * redraws; interleaving them would race two page creations or let an older
   * view land after a newer one. Requests made meanwhile collapse into one.
   */
  const draw = (): Promise<void> => {
    if (closed) return Promise.resolve();
    if (drawing) { redrawQueued = true; return drawing; }
    drawing = (async () => {
      try {
        do {
          redrawQueued = false;
          await drawOnce();
        } while (redrawQueued && !closed);
      } finally {
        drawing = null;
      }
    })();
    return drawing;
  };

  /** Persists immediately: tracked time must survive a crash or disconnect. */
  const persist = async (): Promise<void> => {
    data = { ...data, open: clock };
    await save(bridge, data);
  };

  const persistInBackground = (): void => {
    persist().catch((error: unknown) => { console.warn("[shiftclock] save failed:", error); });
  };

  await draw();

  let ticker: ReturnType<typeof setInterval> | undefined;

  /**
   * Leaving does not stop the clock: the open entry is persisted and resumes
   * next time. The page is shut only once that save has landed.
   */
  const close = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(ticker);
    persist()
      .catch((error: unknown) => { console.warn("[shiftclock] save failed:", error); })
      .then(() => bridge.shutDownPageContainer())
      .catch((error: unknown) => { console.warn("[shiftclock] shutdown failed:", error); });
  };

  bridge.onEvenHubEvent((event) => {
    if (closed) return;
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
        persistInBackground();
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
        close();
        return;

      default:
        return;
    }
    void draw();
  });

  // The page does not survive a disconnect. The last view is forgotten too,
  // or an unchanged view would skip the rebuild and leave the display blank.
  bridge.onDeviceStatusChanged((status) => {
    if (status?.connectType === "connected") {
      pageReady = false;
      lastView = null;
      void draw();
    }
  });

  ticker = setInterval(() => { void draw(); }, 1000);

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
