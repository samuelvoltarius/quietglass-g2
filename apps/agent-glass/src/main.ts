import { waitForEvenAppBridge, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { EMPTY_STATE, applyEvent, type AgentState, type Session } from "./terminal/types";
import { gestureFromEvent } from "./input/gestures";
import { buildView, sessionList, type AgentView } from "./glasses/view";
import { sameView } from "./glasses/diff";
import { createPage, updatePage } from "./glasses/render";
import { load, parsePairingUrl, save, type Settings } from "./storage/persist";
import { mountPhoneUi } from "./ui/phone";
import { AgentNarrator, createBrowserSpeechEngine } from "./speech/narrator";
import { createBackend, describeBackendError, type AgentBackend } from "./providers/backend";
import { DecisionGate } from "./input/decision";
import { decisionOnScreen, routeGesture } from "./input/route";
import { createExitRequest } from "./exit";
import { getLocale, setLocale, type Locale } from "./i18n";

const DEMO = new URLSearchParams(globalThis.location?.search ?? "").get("demo") === "1";
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
 * something, the question appears in your field of view and a swipe answers
 * it. Everything else — the streaming text, the tool name, the session list —
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

type Screen = "agent" | "sessions";

async function boot(): Promise<void> {
  const bridge: EvenAppBridge = await waitForEvenAppBridge();

  let settings: Settings = await load(bridge);
  /** App language for glasses and phone; the narrator keeps its own setting. */
  let locale: Locale = getLocale();
  const narrator = new AgentNarrator(createBrowserSpeechEngine(), () => settings, () => locale);

  // A stored token always wins; the URL only helps the very first run.
  const seeded = pairingFromUrl(globalThis.location?.search ?? "");
  if (!DEMO && seeded && !settings.token) {
    settings = { ...settings, ...seeded };
    await save(bridge, settings);
  }
  if (seeded && globalThis.location && globalThis.history?.replaceState) {
    const { pathname, search, hash } = globalThis.location;
    globalThis.history.replaceState(null, "", pathname + stripPairing(search) + hash);
  }
  let state: AgentState = DEMO ? {
    ...EMPTY_STATE,
    session: DEMO_SESSION,
    text: "I am updating the loading state and checking the component tests.",
    tool: "Edit",
    busy: true,
    startedAt: new Date(Date.now() - 12000),
    controllable: true,
  } : EMPTY_STATE;
  narrator.remember(state.text);
  let sessions: readonly Session[] = DEMO ? [DEMO_SESSION] : [];
  let screen: Screen = "agent";
  let selected = 0;
  let stopStream: (() => void) | null = null;
  let activeBackend: AgentBackend = createBackend(settings);
  /** Bumped by every open and backend switch; older async work then stands down. */
  let generation = 0;
  /** The stream-gap message currently shown, cleared by the next live event. */
  let streamGap: string | null = null;
  /** Set once the user confirms the exit dialog: nothing may draw on, or listen for, the glasses again. */
  let closed = false;
  const gate = new DecisionGate();

  let lastView: AgentView | null = null;
  let pageReady = false;

  const backend = (): AgentBackend => activeBackend;

  const currentView = (): AgentView =>
    screen === "sessions" ? sessionList(sessions, selected, locale) : buildView(state, new Date(), locale);

  const draw = async (): Promise<void> => {
    if (closed) return;
    const view = currentView();
    // Only what was actually drawn may be answered by a swipe.
    const shown = decisionOnScreen(screen, state) ? state.pending : null;
    if (sameView(lastView, view)) { gate.displayed(shown, Date.now()); return; }
    const result = pageReady ? await updatePage(bridge, view) : await createPage(bridge, view);
    if (closed) return;
    if (result.ok) { pageReady = true; lastView = view; gate.displayed(shown, Date.now()); return; }
    pageReady = false;
    gate.displayed(null, Date.now());
    console.warn("[agent-glass] draw failed:", result.reason);
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
      sessions = loaded;
      selected = Math.min(selected, Math.max(0, sessions.length - 1));
      state = { ...state, error: null };
    } catch (thrown) {
      if (owner !== activeBackend) return;
      fail(thrown);
    }
    await draw();
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

  if (DEMO) {
    await draw();
  } else {
    if (!settings.token) {
      state = { ...state, error: "No token — enter one in the phone app." };
    }
    await draw();

    if (settings.token) {
      await loadSessions();
      const previous = sessions.find((session) => session.id === settings.sessionId);
      if (previous) await open(previous);
      else if (sessions.length === 1 && sessions[0]) await open(sessions[0]);
      else if (sessions.length > 1) { screen = "sessions"; await draw(); }
    }
  }

  // The elapsed counter moves with the clock even when no event arrives.
  const ticker = setInterval(() => { void draw(); }, 1000);

  const requestExit = createExitRequest(bridge, {
    onConfirmed: () => {
      closed = true;
      generation += 1;
      clearInterval(ticker);
      stopStream?.();
      stopStream = null;
      activeBackend.dispose();
      narrator.stop();
    },
  }, "agent-glass");

  bridge.onEvenHubEvent((event) => {
    if (closed) return;
    const gesture = gestureFromEvent(event, { invertScroll: false });
    if (!gesture) return;

    const action = routeGesture(gesture.gesture, {
      screen, state, selected, sessionCount: sessions.length,
      decisions: backend().capabilities.decisions, demo: DEMO,
    });

    switch (action.kind) {
      case "decide":
        void decide(action.decision);
        return;

      case "open": {
        const chosen = sessions[selected];
        if (chosen) void open(chosen);
        return;
      }

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
        const session = state.session;
        if (!session) return;
        void backend().interrupt(session.id).catch((thrown: unknown) => { fail(thrown); void draw(); });
        return;
      }

      case "sessions":
        screen = "sessions";
        selected = 0;
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
    if (status?.connectType === "connected") { pageReady = false; void draw(); }
  });

  mountPhoneUi({
    getLocale: () => locale,
    setLocale: (next) => {
      locale = next;
      setLocale(next);
      // The glasses follow at once, not on the next tick or event.
      void draw();
    },
    getSettings: () => settings,
    setSettings: async (next) => {
      const reconnect = next.provider !== settings.provider
        || next.baseUrl !== settings.baseUrl || next.token !== settings.token;
      settings = next;
      if (!next.spokenOutput) narrator.stop();
      await save(bridge, next);
      if (reconnect) {
        generation += 1;
        stopStream?.();
        stopStream = null;
        streamGap = null;
        activeBackend.dispose();
        activeBackend = createBackend(next);
        if (!DEMO) {
          state = EMPTY_STATE;
          sessions = [];
          selected = 0;
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
    createSession: async () => {
      const owner = activeBackend;
      const create = owner.createSession;
      if (!create) return;
      try {
        const session = await create.call(owner, "Agent Glass");
        if (owner !== activeBackend) return;
        sessions = [...sessions.filter((item) => item.id !== session.id), session];
        await open(session);
      } catch (thrown) {
        if (owner !== activeBackend) return;
        fail(thrown);
        await draw();
      }
    },
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
