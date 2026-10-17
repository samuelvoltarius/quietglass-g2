import { waitForEvenAppBridge, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import {
  addEntry, isRunning, nextEntryId, startProject, stop, type ClockState,
} from "./tracking/clock";
import { gestureFromEvent, menuItemIdFromEvent } from "./input/gestures";
import { ARM_MS, buildView, CANCEL, dayBarFor, HELP, type ClockView } from "./glasses/view";
import { sameView } from "./glasses/diff";
import { createPage, forgetPage, sendDayBar, updatePage, type MenuSpec } from "./glasses/render";
import { drawDayBar, sameDayBar, type DayBarState } from "./glasses/daybar";
import { createImageSync } from "./glasses/image-sync";
import { addProject, load, save, type ClockData } from "./storage/persist";
import { mountPhoneUi } from "./ui/phone";
import { createExitRequest, isBackSignal, settleRestore } from "./exit";
import { rememberLocale, resolveLocale, type Locale } from "./i18n";
import { defaultProject, t } from "./messages";
import { isFinalExit, lifecycleFromEvent } from "./lifecycle";

/** Side-menu item ids (QIS v1.2: the help lives in the glasses' side menu). */
const MENU_HELP = 1;
/**
 * The glasses' side menu (QIS v1.2). Off: its clicks never reach the app and, while a page carries it, a hold opens it
 * instead of reaching the app (step log from the real glasses, 15.10.2026). Off means: the pages carry no menu,
 * a hold opens the help and the project picker has its "Help" row again.
 */
const SIDE_MENU = false;

const DEMO = new URLSearchParams(location.search).get("demo") === "1";

async function boot(): Promise<void> {
  const bridge: EvenAppBridge = await waitForEvenAppBridge();

  let locale: Locale = await resolveLocale(bridge);
  let data: ClockData = await load(bridge, locale);
  if (DEMO) {
    const now = Date.now();
    data = { ...data, dailyTargetHours: 8, projects: ["Client Portal", "Research"], entries: [{ id: "demo-1", project: "Research", startedAt: now - 7_200_000, endedAt: now - 5_850_000 }], open: { project: "Client Portal", startedAt: now - 2_754_000 } };
  }
  let clock: ClockState = data.open;
  /** Non-null while the user is picking a project on the glasses. */
  let selecting: string | null = null;
  /** A stop is pending its confirming tap (QIS v1: arm, then confirm within ARM_MS). */
  let armedUntil = 0;
  let armTimer: ReturnType<typeof setTimeout> | undefined;
  /** The help page is open. */
  let helpOpen = false;
  let lastView: ClockView | null = null;
  let pageReady = false;
  /** Set by a reconnect or a return to the foreground: the next draw rebuilds the page. */
  let rebuildWanted = false;
  /** Set once the user leaves; nothing may be drawn on a closed page. */
  let closed = false;
  let drawing: Promise<void> | null = null;
  let redrawQueued = false;

  /** Key of the side menu the page on the glasses carries; a different one (language) needs a rebuild. */
  let pageMenuKey = "";
  const menuSpec = (): MenuSpec => !SIDE_MENU ? { key: "none", items: [] } : ({ key: `help:${locale}`, items: [{ id: MENU_HELP, label: t(locale, "g.menu.help") }] });

  const isArmed = (): boolean => armedUntil > Date.now() && isRunning(clock);
  const disarm = (): void => { armedUntil = 0; clearTimeout(armTimer); armTimer = undefined; };

  const currentView = (): ClockView =>
    buildView(clock, data.entries, { selecting, projects: data.projects, locale, targetHours: data.dailyTargetHours, armed: isArmed(), help: helpOpen, holdHelp: !SIDE_MENU });

  /**
   * The day bar runs on its own lane: an image is a slow BLE transfer and must
   * never hold up the text. It is quantized to five-minute steps, so while the
   * clock runs it is resent at most every five minutes.
   */
  const dayBar = createImageSync<DayBarState>(sameDayBar, async (bar) => {
    // Also silent while the exit dialog may be on screen: a transfer that was queued before the ask must not land on it.
    if (closed || exitAsked()) return false;
    const result = await sendDayBar(bridge, drawDayBar(bar));
    if (!result.ok) console.warn("[shiftclock] day bar failed:", result.reason);
    return result.ok;
  });

  /** Set once the phone page is mounted; redraws it after a change made on the glasses. */
  let refreshPhone: () => void = () => undefined;

  // While the exit dialog may be on screen (asked, no input since) no timer, poll or stream may draw: a page call
  // could cover it. Data keeps being collected; the back signal restores the page the way of the first one.
  let exitAsked = (): boolean => false;
  const drawOnce = async (): Promise<void> => {
    if (exitAsked()) return;
    const view = currentView();
    // Checked on every redraw, but only sent when a five-minute step changed.
    const menu = menuSpec();
    const created = !pageReady || rebuildWanted || menu.key !== pageMenuKey;
    rebuildWanted = false;
    if (!created) dayBar.request(dayBarFor(clock, data.entries, data.dailyTargetHours));
    if (!created && sameView(lastView, view)) return;

    const result = created ? await createPage(bridge, view, menu) : await updatePage(bridge, view);
    if (result.ok) {
      pageReady = true;
      if (created) pageMenuKey = menu.key;
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
    if (exitAsked()) return Promise.resolve();
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

  let ticker: ReturnType<typeof setInterval> | undefined;
  const startTicker = (): void => {
    if (ticker !== undefined || closed) return;
    ticker = setInterval(() => { void draw(); }, 1000);
  };
  const stopTicker = (): void => {
    if (ticker !== undefined) clearInterval(ticker);
    ticker = undefined;
  };

  // shutDownPageContainer(1) resolves when the dialog is SHOWN, not when the user answered: the result never
  // tears the app down (the system ends it: sysEvent 6/7). On the next input the page comes back as a first page.
  const requestExit = createExitRequest(bridge, {
    // The dialog took the page away: put it up again the way of the first one,
    // so the glasses deliver input (and the next 2x) to the app again.
    onBack: () => {
      if (closed) return;
      pageReady = false;
      lastView = null;
      forgetPage(bridge);
      return draw();
    },
  }, "shiftclock");
  exitAsked = requestExit.asked;
  let leaving: Promise<void> | null = null;

  /**
   * Leaving does not stop the clock: the open entry is persisted and resumes
   * next time. The system exit dialog is asked only once that save has
   * landed; if the user cancels, the clock simply keeps ticking on screen.
   */
  const close = (restore: Promise<void> | null = null): void => {
    if (closed || leaving) return;
    leaving = persist()
      .catch((error: unknown) => { console.warn("[shiftclock] save failed:", error); })
      .then(() => settleRestore(restore))
      .then(() => requestExit())
      .then(() => undefined)
      .finally(() => { leaving = null; });
  };

  /** Rebuilds the page from scratch: after a reconnect or a return to the foreground. */
  const redrawFully = (): Promise<void> => {
    rebuildWanted = true;
    lastView = null;
    return draw();
  };

  bridge.onEvenHubEvent((event) => {
    if (closed) return;
    // The 4/5 right after an exit call are the system dialog's own show/close, not the app entering/leaving.
    if (requestExit.onLifecycle(event) !== null) return;
    // Left or back through the system instead of a double tap: the open entry
    // is saved either way (the clock itself keeps running, as on a double tap).
    const step = lifecycleFromEvent(event);
    if (isBackSignal(event)) requestExit.back();
    if (step === "foregroundEnter") { startTicker(); redrawFully(); return; }
    if (step === "foregroundExit") { stopTicker(); disarm(); persistInBackground(); return; }
    if (isFinalExit(step)) {
      closed = true;
      stopTicker();
      disarm();
      persist().catch((error: unknown) => { console.warn("[shiftclock] save failed:", error); });
      return;
    }
    // QIS v1.2: the side menu opens the help; a click on it never touches the clock.
    const menuId = menuItemIdFromEvent(event);
    if (menuId !== null) {
      if (menuId === MENU_HELP) { disarm(); selecting = null; helpOpen = true; void draw(); }
      return;
    }
    const gesture = gestureFromEvent(event, { invertScroll: data.invertScroll });
    if (!gesture) return;

    const now = Date.now();

    // Anything but the confirming tap cancels a pending stop: a swipe or a
    // hold never carries it out, and a double tap goes back instead of out.
    if (gesture.gesture !== "click" && isArmed()) {
      disarm();
      void draw();
      return;
    }

    // The help page: only the double tap does something (back).
    if (helpOpen) {
      if (gesture.gesture === "doubleClick") { helpOpen = false; void draw(); }
      return;
    }

    switch (gesture.gesture) {
      case "click": {
        if (isRunning(clock)) {
          if (!isArmed()) {
            // First tap: arm. The timer restores the footer when the time runs out.
            armedUntil = now + ARM_MS;
            clearTimeout(armTimer);
            armTimer = setTimeout(() => { disarm(); void draw(); }, ARM_MS);
            break;
          }
          disarm();
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
        } else if (selecting === HELP) {
          selecting = null;
          helpOpen = true;
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
          selecting = stepProject(data.projects, selecting, gesture.gesture === "scrollDown" ? 1 : -1, !SIDE_MENU);
        }
        break;
      }

      case "longPress":
        // Without the side menu (SIDE_MENU): hold is the harmless secondary action, the help page (the picker has its own row).
        if (SIDE_MENU || selecting !== null) return;
        helpOpen = true;
        break;

      case "doubleClick":
        // Back one level; only on the root screen does it leave the app.
        if (selecting !== null) { selecting = null; break; }
        // A 2x after a genuine 5 (no dialog) means the app is on the glasses again: the clock tick resumes, the page
        // is rebuilt and the dialog is asked only once that restore is through, never swallowed.
        {
          const away = ticker === undefined;
          startTicker();
          close(away ? redrawFully() : null);
        }
        return;

      default:
        return;
    }
    void draw();
  });

  // The page does not survive a disconnect. The last view is forgotten too,
  // or an unchanged view would skip the rebuild and leave the display blank.
  bridge.onDeviceStatusChanged((status) => {
    if (status?.connectType === "connected" && !closed) redrawFully();
  });

  // Only now, with the gestures wired, the first page goes up: a slow native
  // call can never leave the glasses deaf, not even to the double tap.
  void draw();
  startTicker();

  const phone = mountPhoneUi({
    getData: () => data,
    setData: async (next) => {
      data = next;
      clock = next.open;
      // A project removed on the phone cannot stay highlighted in the picker.
      if (selecting !== null && selecting !== CANCEL && selecting !== HELP && !data.projects.includes(selecting)) selecting = null;
      await save(bridge, next);
      await draw();
    },
    locale: () => locale,
    onLocaleChange: (next) => {
      locale = next;
      rememberLocale(bridge, next);
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
  helpRow: boolean,
): string {
  const choices = helpRow ? [...projects, CANCEL, HELP] : [...projects, CANCEL];
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
