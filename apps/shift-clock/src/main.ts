import { waitForEvenAppBridge, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import {
  addEntry, isRunning, nextEntryId, startProject, stop, type ClockState,
} from "./tracking/clock";
import { gestureFromEvent } from "./input/gestures";
import { buildView, CANCEL, dayBarFor, type ClockView } from "./glasses/view";
import { sameView } from "./glasses/diff";
import { createPage, sendDayBar, updatePage } from "./glasses/render";
import { drawDayBar, sameDayBar, type DayBarState } from "./glasses/daybar";
import { createImageSync } from "./glasses/image-sync";
import { addProject, load, save, type ClockData } from "./storage/persist";
import { mountPhoneUi } from "./ui/phone";
import { createExitRequest } from "./exit";
import { getLocale, type Locale } from "./i18n";
import { defaultProject } from "./messages";

const DEMO = new URLSearchParams(location.search).get("demo") === "1";

async function boot(): Promise<void> {
  const bridge: EvenAppBridge = await waitForEvenAppBridge();

  let locale: Locale = getLocale();
  let data: ClockData = await load(bridge, locale);
  if (DEMO) {
    const now = Date.now();
    data = { ...data, dailyTargetHours: 8, projects: ["Client Portal", "Research"], entries: [{ id: "demo-1", project: "Research", startedAt: now - 7_200_000, endedAt: now - 5_850_000 }], open: { project: "Client Portal", startedAt: now - 2_754_000 } };
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
    buildView(clock, data.entries, { selecting, projects: data.projects, locale, targetHours: data.dailyTargetHours });

  /**
   * The day bar runs on its own lane: an image is a slow BLE transfer and must
   * never hold up the text. It is quantized to five-minute steps, so while the
   * clock runs it is resent at most every five minutes.
   */
  const dayBar = createImageSync<DayBarState>(sameDayBar, async (bar) => {
    if (closed) return false;
    const result = await sendDayBar(bridge, drawDayBar(bar));
    if (!result.ok) console.warn("[shiftclock] day bar failed:", result.reason);
    return result.ok;
  });

  /** Set once the phone page is mounted; redraws it after a change made on the glasses. */
  let refreshPhone: () => void = () => undefined;

  const drawOnce = async (): Promise<void> => {
    const view = currentView();
    // Checked on every redraw, but only sent when a five-minute step changed.
    if (pageReady) dayBar.request(dayBarFor(clock, data.entries, data.dailyTargetHours));
    if (sameView(lastView, view)) return;

    const created = !pageReady;
    const result = pageReady ? await updatePage(bridge, view) : await createPage(bridge, view);
    if (result.ok) {
      pageReady = true;
      lastView = view;
      // A new page starts with an empty image container.
      if (created) { dayBar.reset(); dayBar.request(dayBarFor(clock, data.entries, data.dailyTargetHours)); }
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
    refreshPhone();
    persist().catch((error: unknown) => { console.warn("[shiftclock] save failed:", error); });
  };

  await draw();

  let ticker: ReturnType<typeof setInterval> | undefined;

  const requestExit = createExitRequest(bridge, {
    onConfirmed: () => { closed = true; clearInterval(ticker); },
  }, "shiftclock");
  let leaving: Promise<void> | null = null;

  /**
   * Leaving does not stop the clock: the open entry is persisted and resumes
   * next time. The system exit dialog is asked only once that save has
   * landed; if the user cancels, the clock simply keeps ticking on screen.
   */
  const close = (): void => {
    if (closed || leaving) return;
    leaving = persist()
      .catch((error: unknown) => { console.warn("[shiftclock] save failed:", error); })
      .then(() => requestExit())
      .then(() => undefined)
      .finally(() => { leaving = null; });
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
        } else if (data.projects.length === 0) {
          // One tap creates a project, so the glasses are never a dead end.
          data = addProject(data, defaultProject(locale));
        } else if (selecting === CANCEL) {
          selecting = null;
          break;
        } else if (selecting !== null || data.projects.length === 1) {
          // A single project needs no picker: the tap starts it.
          const project = selecting ?? data.projects[0] ?? "";
          const result = startProject(clock, project, now, () => nextEntryId(data.entries));
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

  const phone = mountPhoneUi({
    getData: () => data,
    setData: async (next) => {
      data = next;
      clock = next.open;
      // A project removed on the phone cannot stay highlighted in the picker.
      if (selecting !== null && selecting !== CANCEL && !data.projects.includes(selecting)) selecting = null;
      await save(bridge, next);
      await draw();
    },
    locale: () => locale,
    onLocaleChange: (next) => {
      locale = next;
      void draw();
    },
  });
  refreshPhone = phone.refresh;
}

/** Moves through the projects and the trailing "Cancel" row, wrapping around. */
function stepProject(
  projects: readonly string[],
  current: string | null,
  delta: number,
): string {
  const choices = [...projects, CANCEL];
  const index = current === null ? -1 : choices.indexOf(current);
  const count = choices.length;
  const next = (((index + delta) % count) + count) % count;
  return choices[next] ?? projects[0] ?? "";
}

function mostRecentProject(data: ClockData): string | null {
  const last = [...data.entries].sort((a, b) => b.endedAt - a.endedAt)[0];
  if (last && data.projects.includes(last.project)) return last.project;
  return null;
}

void boot().catch((error: unknown) => {
  console.error("[shiftclock] failed to start:", error);
});
