import { describe, expect, it } from "vitest";
import {
  AFTER_LONG_FAIL_MS, initialLivePoll, isOlder, LONG_FAIL_LIMIT, LONG_GAP_MS, LONG_OFF_MS, noteLongFailure, noteReport, planPoll, POLL_FAST_MS, POLL_IDLE_MS,
} from "../src/api/live-poll";
import { createClient, longPollPath, voiceTimeoutMs } from "../src/api/client";
import type { HubReport } from "../src/api/types";

const base: HubReport = {
  connection: "connected",
  agent: { provider: "A", questions: [], selected: 0, answer: null, busy: false, suggestions: [] },
  agents: [],
  approvals: [],
  home: { devices: [], selected: 0 },
  printer: { job: null, state: "ready", layer: 0, layers: 0, etaMin: null, nozzleC: 0, bedC: 0, selected: 0 },
  inbox: { events: [], selected: 0 },
};
const liveReport = (rev: number, boot = "b1"): HubReport => ({ ...base, rev, boot, live: { longPoll: true, maxWaitS: 25 } });

describe("poll planner", () => {
  it("polls plainly (0.6.7 timing) when the daemon does not advertise long-poll", () => {
    const state = noteReport(initialLivePoll(), base, false);
    expect(planPoll(state, false, 0)).toEqual({ mode: "plain", delayMs: POLL_IDLE_MS });
    expect(planPoll(state, true, 0)).toEqual({ mode: "plain", delayMs: POLL_FAST_MS });
  });

  it("long-polls from the advertised revision", () => {
    const state = noteReport(initialLivePoll(), liveReport(7), false);
    expect(planPoll(state, false, 0)).toEqual({ mode: "long", delayMs: LONG_GAP_MS, cursor: { rev: 7, boot: "b1" }, waitS: 25 });
  });

  it("after a failed long-poll asks plainly once, then long again when that works", () => {
    let state = noteReport(initialLivePoll(), liveReport(3), false);
    state = noteLongFailure(state, 0);
    expect(planPoll(state, true, 0)).toEqual({ mode: "plain", delayMs: AFTER_LONG_FAIL_MS });
    state = noteReport(state, liveReport(3), false);
    expect(planPoll(state, true, 0).mode).toBe("long");
  });

  it("switches long-poll off for a while after repeated failures", () => {
    let state = noteReport(initialLivePoll(), liveReport(3), false);
    for (let i = 0; i < LONG_FAIL_LIMIT; i += 1) {
      state = noteLongFailure(state, 1000);
      state = noteReport(state, liveReport(3), false);
    }
    expect(planPoll(state, false, 1000)).toEqual({ mode: "plain", delayMs: POLL_IDLE_MS });
    expect(planPoll(state, false, 1000 + LONG_OFF_MS).mode).toBe("long");
  });

  it("a working long-poll resets the failure count", () => {
    let state = noteReport(initialLivePoll(), liveReport(3), false);
    state = noteLongFailure(state, 0);
    state = noteReport(state, liveReport(4), true);
    expect(state.fails).toBe(0);
  });

  it("drops a held answer that is older than what is shown (same daemon only)", () => {
    expect(isOlder(liveReport(4), { rev: 5, boot: "b1" })).toBe(true);
    expect(isOlder(liveReport(5), { rev: 5, boot: "b1" })).toBe(false);
    expect(isOlder(liveReport(1, "b2"), { rev: 5, boot: "b1" })).toBe(false);
    expect(isOlder(base, { rev: 5, boot: "b1" })).toBe(false);
    expect(isOlder(liveReport(1), null)).toBe(false);
  });
});

describe("client", () => {
  it("builds the long-poll query and waits longer than the daemon holds", async () => {
    expect(longPollPath({ rev: 12, boot: "ab cd" }, 25)).toBe("/report?since=12&boot=ab%20cd&wait=25");
    expect(longPollPath({ rev: 1, boot: "x" }, 99)).toContain("wait=25");
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify(liveReport(13)), { status: 200 });
    }) as unknown as typeof fetch;
    const api = createClient({ baseUrl: "https://hub.example/", fetchImpl });
    const report = await api.reportAfter!({ rev: 12, boot: "b1" }, 25);
    expect(calls).toEqual(["https://hub.example/report?since=12&boot=b1&wait=25"]);
    expect(report.rev).toBe(13);
    expect(report.agents).toEqual([]);
  });

  it("gives long voice notes more time", () => {
    expect(voiceTimeoutMs(44)).toBe(90_000);
    // 10 min of 16 kHz s16le = 19.2 MB -> 90 s + 300 s
    expect(voiceTimeoutMs(44 + 32 * 600_000)).toBe(390_000);
  });
});
