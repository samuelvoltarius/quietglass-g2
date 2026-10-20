import { waitForEvenAppBridge, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import {
  addEntry, entriesOnDay, isRunning, nextEntryId, secondsOnDay, openSecondsOnDay, startOfDay, startProject, stop, type ClockState,
} from "./tracking/clock";
import { gestureFromEvent, menuItemIdFromEvent } from "./input/gestures";
import { ARM_MS, startRows, startView, type ClockView } from "./glasses/view";
import { sameView } from "./glasses/diff";
import {
  COCKPIT_TILES, createCockpitPage, createPage, forgetPage, guardedTileSend, updatePage, type MenuSpec,
} from "./glasses/render";
import { cockpitModel } from "./cockpit/model";
import { composeCockpit } from "./cockpit/compose";
import { createTileSender } from "./screen/sender";
import { autoBackend, type TextBackend } from "./screen/text";
import { addProject, load, save, type ClockData } from "./storage/persist";
import { mountPhoneUi } from "./ui/phone";
import { createExitRequest, isBackSignal, settleRestore } from "./exit";
import { rememberLocale, resolveLocale, type Locale } from "./i18n";
import { defaultProject } from "./messages";
import { isFinalExit, lifecycleFromEvent } from "./lifecycle";

/**
 * The glasses' side menu (QIS v1.2). Off: its clicks never reach the app and, while a page carries it, a hold opens it
 * instead of reaching the app (step log from the real glasses, 15.10.2026). Off means: the pages carry no menu and the
 * hold does nothing (QUS v1 has no help page either).
 */
const SIDE_MENU = false;

const DEMO = new URLSearchParams(location.search).get("demo") === "1";

/**
 * The cockpit is redrawn this often. Everything on it is quantized to whole minutes (the ring to two pixels), so an
 * unchanged frame sends nothing: the clock costs one tile a minute, a gesture only the tiles it touched.
 */
const TICK_MS = 5_000;

async function boot(): Promise<void> {
  const bridge: EvenAppBridge = await waitForEvenAppBridge();

  let locale: Locale = await resolveLocale(bridge);
  let data: ClockData = await load(bridge, locale);
  if (DEMO) {
    const now = Date.now();
    data = { ...data, dailyTargetHours: 8, projects: ["Client Portal", "Research"], entries: [{ id: "demo-1", project: "Research", startedAt: now - 7_200_000, endedAt: now - 5_850_000 }], open: { project: "Client Portal", startedAt: now - 2_754_000 } };
  }
  let clock: ClockState = data.open;
  /** The start page was opened on top of the pause page (a swipe there): 2x goes back to the pause page. */
  let picking = false;
  /** Row of the start page under the cursor. */
  let cursor = 0;
  /** A stop is pending its confirming tap (QIS v1: arm, then confirm within ARM_MS). */
  let armedUntil = 0;
  let armTimer: ReturnType<typeof setTimeout> | undefined;
  let lastView: ClockView | null = null;
  let pageReady = false;
  /** Which kind of page the glasses carry: a change means one rebuild. */
  let installed: "text" | "cockpit" | null = null;
  /** Set by a reconnect or a return to the foreground: the next draw rebuilds the page. */
  let rebuildWanted = false;
  /** Set once the user leaves; nothing may be drawn on a closed page. */
  let closed = false;
  let drawing: Promise<void> | null = null;
  let redrawQueued = false;
  let textBackend: TextBackend | null = null;

  /** Key of the side menu the page on the glasses carries; a different one needs a rebuild. */
  let pageMenuKey = "";
  const menuSpec = (): MenuSpec => ({ key: SIDE_MENU ? "menu" : "none", items: [] });

  const isArmed = (): boolean => armedUntil > Date.now() && isRunning(clock);
  const disarm = (): void => { armedUntil = 0; clearTimeout(armTimer); armTimer = undefined; };

  /** Whether anything was recorded today: then the pause page, not the start page, is the root. */
  const workedToday = (now: number): boolean => {
    const today = startOfDay(now);
    return secondsOnDay(data.entries, today) + openSecondsOnDay(clock, today, now) > 0;
  };
  const cockpitShown = (now: number): boolean => isRunning(clock) || (!picking && workedToday(now));

  /** The project a tap on the pause page resumes: the last of today, else the most recent. */
  const resumeProject = (now: number): string | null => {
    const todays = entriesOnDay(data.entries, startOfDay(now));
    const lastToday = todays[todays.length - 1]?.project;
    if (lastToday !== undefined) return lastToday;
    const last = [...data.entries].sort((a, b) => b.endedAt - a.endedAt)[0];
    if (last && data.projects.includes(last.project)) return last.project;
    return data.projects[0] ?? null;
  };

  type Scene =
    | { readonly kind: "text"; readonly view: ClockView }
    | { readonly kind: "cockpit"; readonly model: ReturnType<typeof cockpitModel> };

  /** Everything on the glasses for one moment. */
  const currentScene = (now: number): Scene => {
    if (cockpitShown(now)) {
      return { kind: "cockpit", model: cockpitModel({ clock, entries: data.entries, now, locale, targetHours: data.dailyTargetHours, armed: isArmed(), demo: DEMO, projectCount: data.projects.length }) };
    }
    const rows = startRows(data.projects, data.entries, locale);
    cursor = Math.min(cursor, Math.max(0, rows.length - 1));
    return { kind: "text", view: startView(rows, cursor, { locale, demo: DEMO, canGoBack: picking }) };
  };

  /** Set once the phone page is mounted; redraws it after a change made on the glasses. */
  let refreshPhone: () => void = () => undefined;
  let refreshPhoneLive: () => void = () => undefined;

  // While the exit dialog may be on screen (asked, no input since) no timer, poll or stream may draw: a page call
  // could cover it. Data keeps being collected; the back signal restores the page the way of the first one.
  let exitAsked = (): boolean => false;

  /** The cockpit is one 576 x 288 frame; only the tiles whose pixels changed cross Bluetooth. Never while the dialog may be up. */
  const tiles = createTileSender(COCKPIT_TILES, guardedTileSend(bridge, () => !exitAsked() && !closed && installed === "cockpit"));

  const drawOnce = async (): Promise<void> => {
    if (exitAsked()) return;
    const scene = currentScene(Date.now());
    const menu = menuSpec();
    if (scene.kind === "cockpit") {
      if (installed !== "cockpit" || rebuildWanted || (pageReady && menu.key !== pageMenuKey)) pageReady = false;
      if (!pageReady) {
        rebuildWanted = false;
        const result = await createCockpitPage(bridge, menu);
        if (closed) return;
        if (!result.ok) { pageReady = false; installed = null; console.warn("[shiftclock] draw failed:", result.reason); return; }
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
    const created = !pageReady || rebuildWanted || menu.key !== pageMenuKey;
    rebuildWanted = false;
    if (!created && sameView(lastView, view)) return;

    const result = created ? await createPage(bridge, view, menu) : await updatePage(bridge, view, lastView);
    if (closed) return;
    if (result.ok) {
      pageReady = true;
      installed = "text";
      if (created) pageMenuKey = menu.key;
      lastView = view;
      return;
    }
    pageReady = false;
    installed = null;
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
  let lastMinute = Math.floor(Date.now() / 60_000);
  const startTicker = (): void => {
    if (ticker !== undefined || closed) return;
    ticker = setInterval(() => {
      void draw();
      // The phone's "Jetzt" shows minutes too: refreshed when one has passed.
      const minute = Math.floor(Date.now() / 60_000);
      if (minute !== lastMinute) { lastMinute = minute; refreshPhoneLive(); }
    }, TICK_MS);
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
      installed = null;
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

  /** Starts (or switches to) a project; the entry that was open is closed in the same move. */
  const beginShift = (project: string, now: number): void => {
    const result = startProject(clock, project, now, () => nextEntryId(data.entries));
    clock = result.state;
    if (result.closed) data = { ...data, entries: addEntry(data.entries, result.closed) };
    picking = false;
    cursor = 0;
  };

  const endShift = (now: number): void => {
    const result = stop(clock, now, () => nextEntryId(data.entries));
    clock = result.state;
    if (result.closed) data = { ...data, entries: addEntry(data.entries, result.closed) };
    picking = false;
    cursor = 0;
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
      tiles.close();
      persist().catch((error: unknown) => { console.warn("[shiftclock] save failed:", error); });
      return;
    }
    // The side menu is off (SIDE_MENU): a click on it, should one ever arrive, never touches the clock.
    if (menuItemIdFromEvent(event) !== null) return;
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

    if (cockpitShown(now)) {
      switch (gesture.gesture) {
        case "click":
          if (isRunning(clock)) {
            if (!isArmed()) {
              // First tap: arm. The timer restores the hint line when the time runs out.
              armedUntil = now + ARM_MS;
              clearTimeout(armTimer);
              armTimer = setTimeout(() => { disarm(); void draw(); }, ARM_MS);
              break;
            }
            disarm();
            endShift(now);
          } else {
            // Pause or finish: a tap carries on with the project of the last entry.
            const project = resumeProject(now);
            if (project === null) break;
            beginShift(project, now);
          }
          persistInBackground();
          break;

        case "scrollUp":
        case "scrollDown":
          // A swipe only moves: on the pause page it offers the other projects.
          if (isRunning(clock) || data.projects.length < 2) return;
          picking = true;
          cursor = 0;
          break;

        case "longPress":
          // Hold is not used (QUS v1 has no help page); it must never stop or leave anything.
          return;

        case "doubleClick":
          // The root with a running or paused shift: leave. A 2x after a genuine 5 (no dialog) means the app is on the
          // glasses again: the clock tick resumes, the page is rebuilt and the dialog is asked only once that restore
          // is through, never swallowed.
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
      return;
    }

    // The start page.
    const rows = startRows(data.projects, data.entries, locale);
    switch (gesture.gesture) {
      case "click": {
        const row = rows[Math.min(cursor, rows.length - 1)];
        if (row === undefined) break;
        if (row.kind === "create") {
          // One tap creates a project, so the glasses are never a dead end; the next tap starts it.
          data = addProject(data, defaultProject(locale));
          cursor = 0;
        } else {
          beginShift(row.name, now);
        }
        persistInBackground();
        break;
      }

      case "scrollUp":
        cursor = Math.max(0, cursor - 1);
        break;

      case "scrollDown":
        cursor = Math.min(Math.max(0, rows.length - 1), cursor + 1);
        break;

      case "doubleClick":
        // Back one level; only on the root screen does it leave the app.
        if (picking) { picking = false; break; }
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
      cursor = 0;
      await save(bridge, next);
      await draw();
    },
    // The phone's one button: start (the project of the last entry) or stop - a deliberate tap on a button needs no arming.
    toggleShift: () => {
      const now = Date.now();
      if (isRunning(clock)) {
        disarm();
        endShift(now);
      } else {
        let project = resumeProject(now);
        if (project === null) { data = addProject(data, defaultProject(locale)); project = data.projects[0] ?? defaultProject(locale); }
        beginShift(project, now);
      }
      persistInBackground();
      void draw();
    },
    locale: () => locale,
    onLocaleChange: (next) => {
      locale = next;
      rememberLocale(bridge, next);
      void draw();
    },
  });
  refreshPhone = phone.refresh;
  refreshPhoneLive = phone.refreshLive;
}

void boot().catch((error: unknown) => {
  console.error("[shiftclock] failed to start:", error);
});
