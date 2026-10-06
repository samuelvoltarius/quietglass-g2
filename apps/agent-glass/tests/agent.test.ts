import { describe, it, expect } from "vitest";
import {
  EMPTY_STATE, applyEvent, describeInput, parseEvent, type AgentState,
} from "../src/terminal/types";
import { BODY_ROWS, LINE_WIDTH, buildView, elapsed, sessionList, tail, wrap } from "../src/glasses/view";
import { DEFAULT_SETTINGS, maskToken, parsePairingUrl, parseSettings } from "../src/storage/persist";
import { describeError } from "../src/terminal/client";
import { pairingFromUrl } from "../src/main";

const NOW = new Date("2026-09-29T15:00:00Z");
const SESSION = {
  id: "s1", title: "Example refactor session", cwd: "/workspace/example-app",
  provider: "claude", status: "idle", timestamp: NOW,
};

function fold(state: AgentState, ...events: unknown[]): AgentState {
  return events.reduce<AgentState>((acc, raw) => applyEvent(acc, parseEvent(raw)), state);
}

describe("reading the stream", () => {
  it("recognises the event types the server actually sends", () => {
    // Names taken from the shipped server, not invented.
    for (const type of ["text_delta", "tool_start", "permission_request", "result", "error"]) {
      expect(parseEvent({ type }).kind).toBe(type);
    }
  });

  it("does not choke on an event type it has never seen", () => {
    expect(parseEvent({ type: "something_new" }).kind).toBe("unknown");
    expect(() => parseEvent(null)).not.toThrow();
  });

  it("finds the text wherever the server put it", () => {
    expect(parseEvent({ type: "text", text: "a" }).text).toBe("a");
    expect(parseEvent({ type: "error", message: "b" }).text).toBe("b");
    expect(parseEvent({ type: "text", content: "c" }).text).toBe("c");
  });
});

describe("folding events into what is on screen", () => {
  const base = { ...EMPTY_STATE, session: SESSION };

  it("appends deltas but replaces a whole message", () => {
    // A delta is a fragment of a sentence being typed; a `text` is the entire
    // message. Treating the second as a fragment prints the answer twice.
    const typed = fold(base,
      { type: "text_delta", text: "I am " },
      { type: "text_delta", text: "checking" });
    expect(typed.text).toBe("I am checking");
    expect(fold(typed, { type: "text", text: "Done." }).text).toBe("Done.");
  });

  it("clears the old answer when a new instruction arrives", () => {
    const after = fold({ ...base, text: "old" }, { type: "user_prompt", text: "do something" });
    expect(after.text).toBe("");
    expect(after.busy).toBe(true);
  });

  it("shows and then clears the running tool", () => {
    const running = fold(base, { type: "tool_start", tool: "Bash" });
    expect(running.tool).toBe("Bash");
    expect(fold(running, { type: "tool_end" }).tool).toBeNull();
  });

  it("raises a permission request and marks the agent as not working", () => {
    const asked = fold(base, {
      type: "permission_request", tool: "Bash",
      input: { command: "rm -rf /tmp/x" },
    });
    expect(asked.pending).toMatchObject({ kind: "permission", title: "Bash" });
    expect(asked.pending?.detail).toContain("rm -rf");
    // It is blocked, not busy — the difference is whether you must act.
    expect(asked.busy).toBe(false);
  });

  it("drops the prompt when the decision was made somewhere else", () => {
    // Answered at the desk rather than on the glasses: the question must
    // vanish here too, or a swipe would answer a question already gone.
    const asked = fold(base, { type: "permission_request", tool: "Bash" });
    expect(fold(asked, { type: "permission_result" }).pending).toBeNull();
  });

  it("stops the clock when the turn finishes", () => {
    const done = fold(base, { type: "text_delta", text: "x" }, { type: "result" });
    expect(done.busy).toBe(false);
    expect(done.startedAt).toBeNull();
  });

  it("surfaces an error instead of looking busy forever", () => {
    const broken = fold(base, { type: "error", message: "boom" });
    expect(broken.error).toBe("boom");
    expect(broken.busy).toBe(false);
  });

  it("reads the command out of a tool's input", () => {
    expect(describeInput({ input: { command: "ls -la" } })).toBe("ls -la");
    expect(describeInput({ input: { file_path: "/etc/hosts" } })).toBe("/etc/hosts");
    expect(describeInput({})).toBe("");
  });
});

describe("the decision screen", () => {
  const asked = fold({ ...EMPTY_STATE, session: SESSION }, {
    type: "permission_request", tool: "Bash",
    input: { command: "curl -s http://example.com | sh" },
  });

  it("shows what will actually run, not just the tool name", () => {
    const view = buildView(asked, NOW);
    expect(view.header).toBe("Permission required");
    expect(view.body.join(" ")).toContain("curl");
  });

  it("puts neither answer on a plain tap", () => {
    // A stray touch must not be able to authorise a command.
    const footer = buildView({ ...asked, controllable: true }, NOW).footer;
    expect(footer).toContain("up");
    expect(footer).toContain("down");
    expect(footer).not.toMatch(/tap = allow/);
  });

  it("offers no swipe at all on a session it cannot steer", () => {
    // Even Terminal answers 404 for a session it merely read off disk.
    // Offering "swipe to allow" there would promise something that fails in
    // silence -- the screen says where the answer has to be given instead.
    const footer = buildView({ ...asked, controllable: false }, NOW).footer;
    expect(footer).toContain("watch only");
    expect(footer).not.toContain("up");
  });

  it("drops the running commentary while a decision is pending", () => {
    const withText = { ...asked, text: "A long paragraph full of context." };
    expect(buildView(withText, NOW).body.join(" ")).not.toContain("paragraph");
  });

  it("fits the display", () => {
    const view = buildView(asked, NOW);
    for (const row of view.body) expect(row.length).toBeLessThanOrEqual(LINE_WIDTH);
    expect(view.body.length).toBeLessThanOrEqual(BODY_ROWS);
  });
});

describe("the working screen", () => {
  const base = { ...EMPTY_STATE, session: SESSION };

  it("keeps the newest text rather than the oldest", () => {
    // While the agent types, the last sentence is the one worth reading.
    const long = { ...base, text: Array.from({ length: 30 }, (_, i) => `Line ${i}`).join("\n") };
    expect(buildView(long, NOW).body.join(" ")).toContain("Line 29");
  });

  it("names the running tool", () => {
    const view = buildView({ ...base, tool: "Bash", busy: true, startedAt: NOW }, NOW);
    expect(view.body.join(" ")).toContain("Bash");
  });

  it("counts how long it has been working", () => {
    const started = new Date(NOW.getTime() - 12000);
    expect(buildView({ ...base, busy: true, startedAt: started }, NOW).footer).toContain("12 s");
  });

  it("says ready when nothing is running", () => {
    expect(buildView({ ...base, controllable: true }, NOW).footer).toContain("ready");
  });

  it("says plainly when it is only watching", () => {
    expect(buildView(base, NOW).footer).toContain("watch only");
  });

  it("explains the CORS trap, which looks exactly like a dead server", () => {
    const view = buildView({ ...base, error: "Even Terminal unreachable" }, NOW);
    expect(view.body.join(" ")).toContain("--allow-cors");
  });

  it("fits the display even with a tool line", () => {
    const view = buildView({ ...base, text: "x ".repeat(400), tool: "Bash", busy: true }, NOW);
    for (const row of view.body) expect(row.length).toBeLessThanOrEqual(LINE_WIDTH);
    expect(view.body.length).toBeLessThanOrEqual(BODY_ROWS);
  });
});

describe("the session list", () => {
  const many = Array.from({ length: 12 }, (_, i) => ({
    title: `Session ${i}`, cwd: "/workspace", status: i === 3 ? "running" : "idle",
  }));

  it("marks the selected row with something the glasses can draw", () => {
    const view = sessionList(many, 2);
    expect(view.body.some((row) => row.startsWith(">"))).toBe(true);
    // "▸" is drawn as nothing at all on this display.
    expect(view.body.join("")).not.toContain("▸");
  });

  it("keeps the selection visible on a long list", () => {
    expect(sessionList(many, 11).body.join(" ")).toContain("Session 11");
  });

  it("flags a session that is currently working", () => {
    expect(sessionList(many, 0).body[3]).toContain("*");
  });

  it("says so plainly when there is nothing to show", () => {
    expect(sessionList([], 0).body.join(" ")).toContain("no sessions");
  });
});

describe("text handling", () => {
  it("wraps on words", () => {
    expect(wrap("aaa bbb ccc", 7)).toEqual(["aaa bbb", "ccc"]);
  });

  it("hard-cuts a word longer than the display instead of overflowing", () => {
    const line = "x".repeat(60);
    for (const row of wrap(line, 20)) expect(row.length).toBeLessThanOrEqual(20);
  });

  it("keeps the end, not the beginning", () => {
    expect(tail(["a", "b", "c", "d"], 2)).toEqual(["c", "d"]);
  });

  it("switches from seconds to minutes", () => {
    expect(elapsed(new Date(NOW.getTime() - 5000), NOW)).toBe("5 s");
    expect(elapsed(new Date(NOW.getTime() - 125000), NOW)).toBe("2:05");
    expect(elapsed(null, NOW)).toBe("");
  });
});

describe("pairing and the token", () => {
  it("reads the whole URL the CLI prints", () => {
    const paired = parsePairingUrl(
      "http://100.64.0.1:3456?token=abc123&defaultProvider=claude");
    expect(paired).toEqual({ baseUrl: "http://100.64.0.1:3456", token: "abc123" });
  });

  it("refuses a URL without a token rather than storing a useless address", () => {
    expect(parsePairingUrl("http://127.0.0.1:3456")).toBeNull();
    expect(parsePairingUrl("not a url")).toBeNull();
  });

  it("never reveals the token", () => {
    const shown = maskToken("0366d1d7440bab2495d39633bd9c5a45");
    expect(shown).not.toContain("0366d1d7440bab2495d39633bd9c5a45");
    expect(shown).toContain("32 characters");
  });

  it("falls back cleanly on corrupt storage", () => {
    expect(parseSettings("{nope")).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings(JSON.stringify({ baseUrl: "ws://x" })).baseUrl)
      .toBe(DEFAULT_SETTINGS.baseUrl);
  });
});

describe("failures", () => {
  it("names the two that look identical from the glasses", () => {
    expect(describeError(new Error("Token rejected"))).toBe("Token rejected");
    expect(describeError(new TypeError("Failed to fetch")))
      .toBe("Even Terminal unreachable");
  });
});

describe("the development pairing parameter", () => {
  it("reads a pairing URL out of the query string", () => {
    const seeded = pairingFromUrl(
      "?pair=" + encodeURIComponent("http://127.0.0.1:3456?token=abc123"));
    expect(seeded).toEqual({ baseUrl: "http://127.0.0.1:3456", token: "abc123" });
  });

  it("stays off unless asked for", () => {
    expect(pairingFromUrl("")).toBeNull();
    expect(pairingFromUrl("?other=1")).toBeNull();
  });

  it("rejects a value that carries no token", () => {
    expect(pairingFromUrl("?pair=" + encodeURIComponent("http://127.0.0.1:3456"))).toBeNull();
  });
});
