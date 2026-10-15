import { waitForEvenAppBridge, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { EMPTY_STATE, applyEvent, type AgentState, type Session } from "./terminal/types";
import { gestureFromEvent, menuItemIdFromEvent } from "./input/gestures";
import { answerPages, buildView, helpView, sessionList, type AgentView, type Armed } from "./glasses/view";
import { sameView } from "./glasses/diff";
import { footer } from "./glasses/footer";
import { createPage, faceKey, updatePage, type MenuSpec } from "./glasses/render";
import { t } from "./messages";
import { MASCOT_STEP_MS, headerIcon, isOffline } from "./glasses/face";
import { load, parsePairingUrl, save, type Settings } from "./storage/persist";
import { mountPhoneUi } from "./ui/phone";
import { AgentNarrator, createBrowserSpeechEngine } from "./speech/narrator";
import { createBackend, describeBackendError, type AgentBackend } from "./providers/backend";
import { CONFIRM_MS, DecisionGate } from "./input/decision";
import { decisionOnScreen, routeGesture, type ScreenName } from "./input/route";
import { createExitRequest } from "./exit";
import { rememberLocale, resolveLocale, type Locale } from "./i18n";
import { isFinalExit, lifecycleFromEvent } from "./lifecycle";
import { hiddenCount, prepareSessions, sessionRows, withoutHidden, type SessionRow } from "./sessions/model";
import { manageMode, removeSession, renameSession } from "./sessions/manage";
import { applyTranscript, fromHistory, type Transcript } from "./sessions/transcript";

const DEMO_FLAG = new URLSearchParams(globalThis.location?.search ?? "").get("demo") === "1";
const DEMO_SESSION: Session = {
  id: "demo",
  title: "Improve dashboard loading state",
  cwd: "/workspace/example-app",
  provider: "codex",
  status: "running",
  timestamp: new Date("2026-01-01T12:00:00Z"),
};

/**
 * Agent Glass.
 *
 * Watch a coding agent work, and answer it, without going back to the desk.
 *
 * The one thing this app is really for: when the agent stops and asks to run
 * something, the question appears in your field of view as a list (Erlauben /
 * Ablehnen): a swipe moves the cursor, a tap arms, a second tap within 4 s
 * sends (QIS v1). Everything else — the streaming text, the tool name, the session list —
 * exists to give that decision enough context to be made honestly.
 */


/**
 * Pairing supplied in the URL, for development.
 *
 *     http://127.0.0.1:5202/?pair=http://127.0.0.1:3456%3Ftoken%3D…
 *
 * The simulator has no way to type a token, so without this the app can only
 * ever be seen saying "no token". A value stored in the app always wins, so
 * this seeds the first run and is then out of the way.
 */
/**
 * The demo run, for the simulator and screenshots: `?demo=1&scene=working|idle|waiting|error`.
 * Working is the default; the face follows the scene.
 */
export function demoState(scene: string | null): AgentState {
  const base: AgentState = {
    ...EMPTY_STATE,
    session: DEMO_SESSION,
    text: "I am updating the loading state and checking the component tests.",
    tool: "Edit",
    busy: true,
    startedAt: new Date(Date.now() - 12000),
    controllable: true,
  };
  switch (scene) {
    case "idle": return { ...base, busy: false, tool: null, startedAt: null };
    case "waiting": return { ...base, tool: null, pending: { kind: "permission", title: "Bash", detail: "npm test -- --run" } };
    case "error": return { ...base, busy: false, tool: null, error: "Agent stopped: tests failed" };
    case "offline": return { ...base, busy: false, tool: null, error: "Hermes bridge unreachable" };
    default: return base;
  }
}

/** The phone transcript of the demo run: neutral text only, no live data. */
export const DEMO_TRANSCRIPT: Transcript = [
  { role: "user", text: "Improve the dashboard loading state and run the tests." },
  { role: "assistant", text: "I will replace the spinner with skeleton rows and keep the layout stable while data loads." },
  { role: "tool", text: "Edit" },
  { role: "assistant", text: "I am updating the loading state and checking the component tests." },
];

export function pairingFromUrl(search: string): Partial<Settings> | null {
  const raw = new URLSearchParams(search).get("pair");
  if (!raw) return null;
  const paired = parsePairingUrl(raw);
  return paired ? { baseUrl: paired.baseUrl, token: paired.token } : null;
}

/**
 * The same query string without `pair`, so the token does not linger in the
 * WebView's address (and anything that records it) once it has been stored.
 */
export function stripPairing(search: string): string {
  const params = new URLSearchParams(search);
  if (!params.has("pair")) return search;
  params.delete("pair");
  const rest = params.toString();
  return rest ? `?${rest}` : "";
}

type Screen = ScreenName;

/** The glasses' side menu (QIS v1.2). Off: its clicks do not arrive on the real glasses (step log 15.10.2026). */
export const SIDE_MENU = false;

/** Side menu ids (QIS v1.2): Hilfe first, then the overview. */
export const MENU_HELP = 1;
export const MENU_SESSIONS = 2;

/** The glasses' side menu in the app language. */
export function sideMenu(locale: Locale): MenuSpec {
  // 15.10.2026, step log from the real glasses: the side menu shows, but its clicks never
  // reach the app, and while a page carries a menu a hold opens it instead of reaching the
  // app. Without a menu: hold = session list / arm interrupt, help is a row of the list.
  if (!SIDE_MENU) return { items: [] };
  return { items: [
    { id: MENU_HELP, label: t(locale, "g.menu.help") },
    { id: MENU_SESSIONS, label: t(locale, "g.menu.sessions") },
  ] };
}

async function boot(): Promise<void> {
  const bridge: EvenAppBridge = await waitForEvenAppBridge();

  let settings: Settings = await load(bridge);
  /** App language for glasses and phone; the narrator keeps its own setting. */
  let locale: Locale = await resolveLocale(bridge);
  const narrator = new AgentNarrator(createBrowserSpeechEngine(), () => settings, () => locale);

  // A stored token always wins; the URL only helps the very first run.
  const seeded = pairingFromUrl(globalThis.location?.search ?? "");
  if (!DEMO_FLAG && seeded && !settings.token) {
    settings = { ...settings, ...seeded };
    await save(bridge, settings);
  }
  if (seeded && globalThis.location && globalThis.history?.replaceState) {
    const { pathname, search, hash } = globalThis.location;
    globalThis.history.replaceState(null, "", pathname + stripPairing(search) + hash);
  }
  /** QIS v1.2: without a token the app starts in demo with sample data; `?demo=1` forces it. */
  let demo = DEMO_FLAG || settings.token === "";
  const demoScene = new URLSearchParams(globalThis.location?.search ?? "").get("scene");
  let state: AgentState = demo ? demoState(demoScene) : EMPTY_STATE;
  narrator.remember(state.text);
  /** As the backend reported them. */
  let rawSessions: readonly Session[] = demo ? [DEMO_SESSION] : [];
  /** What is shown: local names applied, hidden ones gone, newest first. */
  let sessions: readonly Session[] = rawSessions;
  let screen: Screen = "agent";
  /** Where the help page was opened from (menu), and where it closes to. */
  let helpFrom: Screen = "agent";
  let selected = 0;
  /** Screen of the current answer on the glasses, counted back from the newest (0). */
  let page = 0;
  /** The full conversation of the open session, for the phone. */
  let transcript: Transcript = demo ? DEMO_TRANSCRIPT : [];
  const transcriptListeners = new Set<() => void>();
  const transcriptChanged = (): void => { for (const listener of transcriptListeners) listener(); };
  let stopStream: (() => void) | null = null;
  let activeBackend: AgentBackend = createBackend(settings);
  /** Bumped by every open and backend switch; older async work then stands down. */
  let generation = 0;
  /** The stream-gap message currently shown, cleared by the next live event. */
  let streamGap: string | null = null;
  /** Set once the user confirms the exit dialog: nothing may draw on, or listen for, the glasses again. */
  let closed = false;
  const gate = new DecisionGate();
  /** Cursor in the answer list (0 = Erlauben, 1 = Ablehnen); back on 0 for every new request. */
  let choice: 0 | 1 = 0;
  /** What a first tap (or hold) has armed; lapses after CONFIRM_MS. */
  let armed: Armed | null = null;
  let armTimer: ReturnType<typeof setTimeout> | undefined;
  /** The request the cursor belongs to. */
  let choiceFor: AgentState["pending"] = null;

  let lastView: AgentView | null = null;
  let lastFace = "";
  let pageReady = false;
  /** Set by a reconnect or a return to the foreground: the next draw rebuilds the page. */
  let rebuildWanted = false;
  /** In the background (system menu, another app): nothing is drawn, the ticker rests. */
  let paused = false;
  let drawing: Promise<void> | null = null;
  let drawAgain = false;

  const backend = (): AgentBackend => activeBackend;

  const rows = (): readonly SessionRow[] => sessionRows(sessions, backend().capabilities.createSession);

  const refreshVisible = (): void => {
    sessions = prepareSessions(rawSessions, settings.sessionPrefs, settings.provider);
    selected = Math.min(selected, Math.max(0, rows().length - 1));
    // The open session follows a rename made on the phone.
    const shown = state.session ? sessions.find((session) => session.id === state.session?.id) : undefined;
    if (shown && state.session && shown.title !== state.session.title) {
      state = { ...state, session: { ...state.session, title: shown.title } };
    }
  };

  /** The list opens on the session that is open, else on the newest one, never on "+ new". */
  const defaultSelection = (): number => {
    const list = rows();
    const current = list.findIndex((row) => row.kind === "session" && row.session.id === state.session?.id);
    if (current >= 0) return current;
    const first = list.findIndex((row) => row.kind === "session");
    return first >= 0 ? first : 0;
  };

  const disarm = (): void => { clearTimeout(armTimer); armed = null; };
  const arm = (what: Armed): void => {
    clearTimeout(armTimer);
    armed = what;
    armTimer = setTimeout(() => { armed = null; void draw(); }, CONFIRM_MS);
  };
  /** A new request starts on Erlauben, unarmed; an interrupt lapses when the agent is no longer busy. */
  const syncChoice = (): void => {
    if (state.pending !== choiceFor) { choiceFor = state.pending; choice = 0; if (armed === "allow" || armed === "deny") disarm(); }
    if (armed === "interrupt" && !state.busy) disarm();
    if ((armed === "allow" || armed === "deny") && !decisionOnScreen(screen, state)) disarm();
  };

  const currentView = (): AgentView => {
    syncChoice();
    if (screen === "help") return helpView(locale);
    const view = screen === "sessions"
      ? sessionList(sessions, selected, locale, state.session !== null, {
        canCreate: backend().capabilities.createSession,
        listable: backend().capabilities.sessions,
        now: new Date(),
      })
      : buildView(state, new Date(), locale, page, { choice, armed, decisions: backend().capabilities.decisions });
    // Demo: nothing but 2× works, so the footer says what to do instead (QIS §7).
    return demo ? { ...view, footer: footer(locale, { hint: t(locale, "g.demoFoot") }, "exit") } : view;
  };

  const drawOnce = async (): Promise<void> => {
    if (closed || paused) return;
    if (rebuildWanted) { rebuildWanted = false; pageReady = false; }
    const view = currentView();
    // Only what was actually drawn may be answered by a swipe.
    const shown = decisionOnScreen(screen, state) ? state.pending : null;
    const now = Date.now();
    const face = headerIcon(screen, state, isOffline(state, demo || settings.token !== "", streamGap !== null), now);
    const key = faceKey(face);
    if (pageReady && sameView(lastView, view) && key === lastFace) { gate.displayed(shown, now); return; }
    const result = pageReady ? await updatePage(bridge, view, face, lastView) : await createPage(bridge, view, face, sideMenu(locale));
    if (closed) return;
    if (result.ok) { pageReady = true; lastView = view; lastFace = key; gate.displayed(shown, Date.now()); return; }
    pageReady = false;
    gate.displayed(null, Date.now());
    console.warn("[agent-glass] draw failed:", result.reason);
  };

  /**
   * One page write at a time. The ticker, the stream, gestures and the phone
   * all ask for redraws; two overlapping first draws would both create the
   * start-up page, and a second create leaves real glasses deaf.
   */
  const draw = (): Promise<void> => {
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

  const fail = (thrown: unknown): void => {
    state = { ...state, error: describeBackendError(thrown, settings.provider) };
  };

  /** Opens a session: stops any old stream, loads the backlog, starts the new one. */
  const open = async (session: Session): Promise<void> => {
    // Two quick opens, or a backend switch half-way through, must not leave
    // two streams running into the same state: that doubles every delta.
    const mine = ++generation;
    const owner = activeBackend;
    const current = (): boolean => !closed && mine === generation && owner === activeBackend;

    stopStream?.();
    stopStream = null;
    streamGap = null;

    state = { ...EMPTY_STATE, session };
    screen = "agent";
    page = 0;
    transcript = [];
    transcriptChanged();
    await draw();

    // Ask before promising anything: a session Even Terminal only read off
    // disk cannot be prompted or answered, and the display must say so.
    let controllable = false;
    try {
      controllable = await owner.controllable(session.id);
    } catch {
      controllable = false;
    }
    if (!current()) return;
    state = { ...state, controllable };

    try {
      const history = await owner.history(session.id);
      if (!current()) return;
      // Start from the last thing the agent said, so the display is never
      // blank while waiting for the first live event — which, on an idle
      // session, may never come at all.
      const lastAssistant = [...history].reverse().find((entry) => entry.role === "assistant");
      state = { ...state, text: lastAssistant?.text ?? "" };
      transcript = fromHistory(history);
      transcriptChanged();
      narrator.remember(state.text);
    } catch (thrown) {
      if (!current()) return;
      fail(thrown);
    }
    await draw();
    if (!current()) return;

    stopStream = owner.subscribe(
      session.id,
      (event) => {
        if (!current()) return;
        // A live event proves the connection is back.
        if (streamGap && state.error === streamGap) state = { ...state, error: null };
        streamGap = null;
        state = applyEvent(state, event);
        transcript = applyTranscript(transcript, event);
        transcriptChanged();
        // A new question starts a new answer: back to its newest part.
        if (event.kind === "user_prompt") page = 0;
        // A reconnecting stream may deliver a request that was already
        // answered from here; it must not come back as a fresh prompt.
        if (gate.answered(state.pending)) state = { ...state, pending: null };
        narrator.accept(event);
        if (state.text) narrator.remember(state.text);
        void draw();
      },
      (message) => {
        if (!current()) return;
        streamGap = message;
        state = { ...state, error: message };
        void draw();
      },
    );

    settings = { ...settings, sessionId: session.id };
    await save(bridge, settings);
  };

  const loadSessions = async (): Promise<void> => {
    if (demo) return;
    if (!settings.token) {
      sessions = [];
      state = { ...state, error: "No token — enter one in the phone app." };
      await draw();
      return;
    }
    const owner = activeBackend;
    try {
      const loaded = await owner.sessions();
      if (owner !== activeBackend) return;
      rawSessions = loaded;
      refreshVisible();
      state = { ...state, error: null };
    } catch (thrown) {
      if (owner !== activeBackend) return;
      fail(thrown);
    }
    await draw();
  };

  /** "+ New session", from the glasses or the phone. */
  const startNew = async (): Promise<void> => {
    const owner = activeBackend;
    const create = owner.createSession;
    if (!create) return;
    try {
      const session = await create.call(owner, "Agent Glass");
      if (owner !== activeBackend) return;
      rawSessions = [...rawSessions.filter((item) => item.id !== session.id), session];
      refreshVisible();
      await open(sessions.find((item) => item.id === session.id) ?? session);
    } catch (thrown) {
      if (owner !== activeBackend) return;
      fail(thrown);
      screen = "agent";
      await draw();
    }
  };

  /** Rename or remove from the phone, then show the result everywhere. */
  const manage = async (change: (owner: AgentBackend) => ReturnType<typeof renameSession>): Promise<void> => {
    const owner = activeBackend;
    try {
      const result = await change(owner);
      if (owner !== activeBackend) return;
      settings = { ...settings, sessionPrefs: result.prefs };
      await save(bridge, settings);
      if (result.where === "remote") await loadSessions();
      else { refreshVisible(); await draw(); }
    } catch (thrown) {
      if (owner !== activeBackend) return;
      fail(thrown);
      await draw();
    }
  };

  const decide = async (decision: "allow" | "deny"): Promise<void> => {
    const session = state.session;
    const pending = state.pending;
    if (!session || !pending) return;

    if (!state.controllable) {
      state = { ...state, error: "This session is not running under Even Terminal — watch only." };
      await draw();
      return;
    }

    if (pending.kind === "question") {
      // A free-text question cannot be answered by a swipe. Saying so beats
      // silently sending "allow", which the agent would read as an answer.
      state = { ...state, error: "This question needs text — answer it on the computer." };
      await draw();
      return;
    }

    // Not yet shown long enough, replaced, already answered, or an answer is
    // still on its way: the swipe is dropped rather than guessed at.
    if (!gate.begin(pending, Date.now())) return;

    const owner = activeBackend;
    // Clear it locally at once. The server confirms with permission_result,
    // but leaving the prompt up until then invites a second swipe.
    state = { ...state, pending: null, busy: decision === "allow" };
    try {
      // Sent before the redraw: the server matches the answer to whatever
      // request is pending *when it arrives*, so waiting on a slow BLE write
      // first would widen the window for a newer request to take its place.
      const sent = owner.decide(session.id, decision);
      void draw();
      await sent;
    } catch (thrown) {
      if (owner === activeBackend) {
        fail(thrown);
        await draw();
      }
    } finally {
      gate.end();
    }
  };

  // The elapsed counter moves with the clock and the face blinks or writes:
  // redraw twice a second, but only on the page that shows them. Unchanged
  // frames cost nothing (see draw).
  const ticker = setInterval(() => { if (screen === "agent" && !paused) void draw(); }, MASCOT_STEP_MS);

  /** Everything off for good: after the exit dialog, a system exit or a crash. */
  const shutDown = (): void => {
    closed = true;
    generation += 1;
    clearInterval(ticker);
    clearTimeout(armTimer);
    stopStream?.();
    stopStream = null;
    activeBackend.dispose();
    narrator.stop();
  };

  const requestExit = createExitRequest(bridge, { onConfirmed: shutDown }, "agent-glass");

  // Gestures and the exit come first. Loading sessions and opening one are
  // network calls with up to 10 s timeouts each; awaited before this, a slow
  // or dead backend left the glasses deaf for up to half a minute.
  bridge.onEvenHubEvent((event) => {
    if (closed) return;
    const step = lifecycleFromEvent(event);
    if (step === "foregroundExit") { paused = true; return; }
    if (step === "foregroundEnter") { paused = false; rebuildWanted = true; void draw(); return; }
    if (isFinalExit(step)) { shutDown(); return; }
    const menuId = menuItemIdFromEvent(event);
    if (menuId !== null) {
      // Help and overview never carry out anything risky; an armed answer lapses.
      disarm();
      if (menuId === MENU_HELP) {
        if (screen !== "help") helpFrom = screen;
        screen = "help";
        void draw();
      } else if (menuId === MENU_SESSIONS && !demo) {
        screen = "sessions";
        selected = defaultSelection();
        void loadSessions();
        void draw();
      }
      return;
    }
    const gesture = gestureFromEvent(event, { invertScroll: settings.invertScroll });
    if (!gesture) return;

    syncChoice();
    const action = routeGesture(gesture.gesture, {
      screen, state, selected, sessionCount: rows().length,
      decisions: backend().capabilities.decisions, demo,
      page, pages: answerPages(state), choice, armed,
    });

    // Anything but the confirming tap itself lapses an armed action.
    if (armed && action.kind !== "decide" && action.kind !== "interrupt" && action.kind !== "arm") disarm();

    switch (action.kind) {
      case "decide":
        disarm();
        void decide(action.decision);
        return;

      case "choose":
        choice = action.index;
        void draw();
        return;

      case "arm":
        arm(action.what);
        void draw();
        return;

      case "disarm":
        void draw();
        return;

      case "closeHelp":
        screen = helpFrom;
        void draw();
        return;

      case "open": {
        const chosen = rows()[selected];
        if (chosen?.kind === "new") void startNew();
        else if (chosen?.kind === "session") void open(chosen.session);
        else if (chosen?.kind === "help") { helpFrom = screen; screen = "help"; void draw(); }
        return;
      }

      case "page":
        page = action.page;
        void draw();
        return;

      case "back":
        screen = "agent";
        void draw();
        return;

      case "retry":
        // A dead stream does not come back by reloading the list; reopening
        // the session subscribes again.
        if (state.session) void open(state.session);
        else void loadSessions();
        return;

      case "replay":
        narrator.replay();
        return;

      case "interrupt": {
        disarm();
        void draw();
        const session = state.session;
        if (!session) return;
        void backend().interrupt(session.id).catch((thrown: unknown) => { fail(thrown); void draw(); });
        return;
      }

      case "sessions":
        screen = "sessions";
        selected = defaultSelection();
        void loadSessions();
        return;

      case "select":
        selected = action.index;
        void draw();
        return;

      case "exit":
        // System exit dialog; the stream and narration keep going until the user confirms.
        void requestExit();
        return;

      default:
        return;
    }
  });

  bridge.onDeviceStatusChanged((status) => {
    if (closed) return;
    if (status?.connectType === "connected") { rebuildWanted = true; void draw(); }
  });

  // Only now the first page, then the network in the background.
  void draw();
  if (!demo && settings.token) {
    void (async () => {
      await loadSessions();
      if (closed) return;
      const previous = sessions.find((session) => session.id === settings.sessionId);
      if (previous) await open(previous);
      else if (sessions.length === 1 && sessions[0]) await open(sessions[0]);
      else if (sessions.length > 1) { screen = "sessions"; await draw(); }
    })().catch((thrown: unknown) => { fail(thrown); void draw(); });
  }

  mountPhoneUi({
    getLocale: () => locale,
    setLocale: (next) => {
      locale = next;
      rememberLocale(bridge, next);
      // The menu labels follow the language, so the page is rebuilt once.
      rebuildWanted = true;
      // The glasses follow at once, not on the next tick or event.
      void draw();
    },
    getSettings: () => settings,
    setSettings: async (next) => {
      const reconnect = next.provider !== settings.provider
        || next.baseUrl !== settings.baseUrl || next.token !== settings.token;
      settings = next;
      const wasDemo = demo;
      demo = DEMO_FLAG || next.token === "";
      if (!next.spokenOutput) narrator.stop();
      await save(bridge, next);
      if (reconnect) {
        generation += 1;
        stopStream?.();
        stopStream = null;
        streamGap = null;
        activeBackend.dispose();
        activeBackend = createBackend(next);
        if (demo) {
          // Token removed: back to the sample data.
          if (!wasDemo) {
            state = demoState(demoScene);
            rawSessions = [DEMO_SESSION];
            sessions = rawSessions;
            screen = "agent";
            transcript = DEMO_TRANSCRIPT;
            transcriptChanged();
          }
        } else {
          state = EMPTY_STATE;
          screen = "agent";
          rawSessions = [];
          sessions = [];
          selected = 0;
          page = 0;
          transcript = [];
          transcriptChanged();
          await loadSessions();
        }
      }
      await draw();
    },
    getState: () => state,
    getSessions: () => sessions,
    refresh: () => { void loadSessions(); },
    sendPrompt: async (text) => {
      const session = state.session;
      if (!session || !text.trim()) return;
      const owner = activeBackend;
      state = { ...state, busy: true, error: null, startedAt: new Date() };
      await draw();
      try {
        await owner.prompt(session.id, text.trim());
      } catch (thrown) {
        // A request cut off by switching backend is not an error of the new one.
        if (owner !== activeBackend) return;
        fail(thrown);
        await draw();
      }
    },
    createSession: startNew,
    openSession: async (id) => {
      const chosen = sessions.find((session) => session.id === id);
      if (chosen) await open(chosen);
    },
    renameSession: (id, title) =>
      manage((owner) => renameSession(owner, settings.sessionPrefs, settings.provider, id, title)),
    removeSession: (id) =>
      manage((owner) => removeSession(owner, settings.sessionPrefs, settings.provider, id)),
    restoreHidden: async () => {
      settings = { ...settings, sessionPrefs: withoutHidden(settings.sessionPrefs, settings.provider) };
      await save(bridge, settings);
      refreshVisible();
      await draw();
    },
    getHiddenCount: () => hiddenCount(settings.sessionPrefs, settings.provider),
    getManageMode: () => manageMode(backend()),
    getTranscript: () => transcript,
    onTranscript: (listener) => { transcriptListeners.add(listener); },
    getCapabilities: () => backend().capabilities,
    getSpeechStatus: () => narrator.status(),
    getSpeechVoices: () => narrator.voices(),
    activateSpeech: async () => {
      settings = { ...settings, spokenOutput: true };
      await save(bridge, settings);
      return narrator.activate();
    },
    disableSpeech: async () => {
      narrator.stop();
      settings = { ...settings, spokenOutput: false };
      await save(bridge, settings);
    },
    toggleSpeechPause: () => narrator.togglePause(),
    replaySpeech: () => narrator.replay(),
  });
}

if (typeof window !== "undefined") {
  void boot().catch((error: unknown) => {
    console.error("[agent-glass] failed to start:", error instanceof Error ? error.message : "unknown error");
  });
}
