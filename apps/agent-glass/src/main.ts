import { waitForEvenAppBridge, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { TerminalClient, describeError, subscribe } from "./terminal/client";
import { EMPTY_STATE, applyEvent, type AgentState, type Session } from "./terminal/types";
import { gestureFromEvent } from "./input/gestures";
import { buildView, sessionList, type AgentView } from "./glasses/view";
import { sameView } from "./glasses/diff";
import { createPage, updatePage } from "./glasses/render";
import { load, parsePairingUrl, save, type Settings } from "./storage/persist";
import { mountPhoneUi } from "./ui/phone";
import { AgentNarrator, createBrowserSpeechEngine } from "./speech/narrator";

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

type Screen = "agent" | "sessions";

async function boot(): Promise<void> {
  const bridge: EvenAppBridge = await waitForEvenAppBridge();

  let settings: Settings = await load(bridge);
  const narrator = new AgentNarrator(createBrowserSpeechEngine(), () => settings);

  // A stored token always wins; the URL only helps the very first run.
  const seeded = pairingFromUrl(globalThis.location?.search ?? "");
  if (!DEMO && seeded && !settings.token) {
    settings = { ...settings, ...seeded };
    await save(bridge, settings);
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

  let lastView: AgentView | null = null;
  let pageReady = false;

  const client = (): TerminalClient =>
    new TerminalClient({ baseUrl: settings.baseUrl, token: settings.token });

  const currentView = (): AgentView =>
    screen === "sessions" ? sessionList(sessions, selected) : buildView(state, new Date());

  const draw = async (): Promise<void> => {
    const view = currentView();
    if (sameView(lastView, view)) return;
    const result = pageReady ? await updatePage(bridge, view) : await createPage(bridge, view);
    if (result.ok) { pageReady = true; lastView = view; return; }
    pageReady = false;
    console.warn("[agent-glass] draw failed:", result.reason);
  };

  const fail = (thrown: unknown): void => {
    state = { ...state, error: describeError(thrown) };
  };

  /** Opens a session: stops any old stream, loads the backlog, starts the new one. */
  const open = async (session: Session): Promise<void> => {
    stopStream?.();
    stopStream = null;

    state = { ...EMPTY_STATE, session };
    screen = "agent";
    await draw();

    // Ask before promising anything: a session Even Terminal only read off
    // disk cannot be prompted or answered, and the display must say so.
    state = { ...state, controllable: await client().controllable(session.id) };

    try {
      const history = await client().history(session.id);
      // Start from the last thing the agent said, so the display is never
      // blank while waiting for the first live event — which, on an idle
      // session, may never come at all.
      const lastAssistant = [...history].reverse().find((entry) => entry.role === "assistant");
      state = { ...state, text: lastAssistant?.text ?? "" };
      narrator.remember(state.text);
    } catch (thrown) {
      fail(thrown);
    }
    await draw();

    stopStream = subscribe(
      client(),
      session.id,
      (event) => {
        state = applyEvent(state, event);
        narrator.accept(event);
        if (state.text) narrator.remember(state.text);
        void draw();
      },
      (message) => { state = { ...state, error: message }; void draw(); },
    );

    settings = { ...settings, sessionId: session.id };
    await save(bridge, settings);
  };

  const loadSessions = async (): Promise<void> => {
    try {
      sessions = await client().sessions();
      state = { ...state, error: null };
    } catch (thrown) {
      fail(thrown);
    }
    await draw();
  };

  const decide = async (decision: "allow" | "deny"): Promise<void> => {
    const session = state.session;
    if (!session || !state.pending) return;

    if (!state.controllable) {
      state = { ...state, error: "This session is not running under Even Terminal — watch only." };
      await draw();
      return;
    }

    if (state.pending.kind === "question") {
      // A free-text question cannot be answered by a swipe. Saying so beats
      // silently sending "allow", which the agent would read as an answer.
      state = { ...state, error: "This question needs text — answer it on the computer." };
      await draw();
      return;
    }

    // Clear it locally at once. The server confirms with permission_result,
    // but leaving the prompt up until then invites a second swipe.
    state = { ...state, pending: null, busy: decision === "allow" };
    await draw();

    try {
      await client().decide(session.id, decision);
    } catch (thrown) {
      fail(thrown);
      await draw();
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
      else if (sessions.length > 0) { screen = "sessions"; await draw(); }
    }
  }

  bridge.onEvenHubEvent((event) => {
    const gesture = gestureFromEvent(event, { invertScroll: false });
    if (!gesture) return;
    if (DEMO && gesture.gesture !== "doubleClick") return;

    // While a decision is pending it outranks every other binding: the swipes
    // mean allow and deny and nothing else, so no other screen can steal them.
    if (state.pending && screen === "agent" && state.controllable) {
      if (gesture.gesture === "scrollUp") { void decide("allow"); return; }
      if (gesture.gesture === "scrollDown") { void decide("deny"); return; }
    }

    switch (gesture.gesture) {
      case "click":
        if (screen === "sessions") {
          const chosen = sessions[selected];
          if (chosen) void open(chosen);
          return;
        }
        if (state.error) { void loadSessions(); return; }
        narrator.replay();
        return;

      case "longPress":
        if (screen === "agent" && state.busy && state.controllable && state.session) {
          void client().interrupt(state.session.id).catch(fail);
          return;
        }
        screen = "sessions";
        selected = 0;
        void loadSessions();
        return;

      case "scrollUp":
        if (screen !== "sessions") return;
        selected = Math.max(0, selected - 1);
        void draw();
        return;

      case "scrollDown":
        if (screen !== "sessions") return;
        selected = Math.min(sessions.length - 1, selected + 1);
        void draw();
        return;

      case "doubleClick":
        stopStream?.();
        narrator.stop();
        void bridge.shutDownPageContainer();
        return;

      default:
        return;
    }
  });

  bridge.onDeviceStatusChanged((status) => {
    if (status?.connectType === "connected") { pageReady = false; void draw(); }
  });

  // The elapsed counter moves with the clock even when no event arrives.
  setInterval(() => { void draw(); }, 1000);

  mountPhoneUi({
    getSettings: () => settings,
    setSettings: async (next) => {
      const reconnect = next.baseUrl !== settings.baseUrl || next.token !== settings.token;
      settings = next;
      if (!next.spokenOutput) narrator.stop();
      await save(bridge, next);
      if (reconnect) {
        stopStream?.();
        stopStream = null;
        state = EMPTY_STATE;
        await loadSessions();
      }
      await draw();
    },
    getState: () => state,
    getSessions: () => sessions,
    refresh: () => { void loadSessions(); },
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

void boot().catch((error: unknown) => {
  console.error("[agent-glass] failed to start:", error);
});
