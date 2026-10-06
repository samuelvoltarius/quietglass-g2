import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bridgeUrl, fetchText } from "../src/podcast/bridge";
import { createPlayer } from "../src/podcast/player";

describe("createPlayer", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const setup = (length: number) => {
    const state = { cursor: 0, changes: 0 };
    const player = createPlayer({ length: () => length, cursor: () => state.cursor, setCursor: (next) => { state.cursor = next; }, onChange: () => { state.changes += 1; }, intervalMs: 1000 });
    return { state, player };
  };

  it("advances one caption per beat", () => {
    const { state, player } = setup(5);
    player.toggle();
    expect(player.playing).toBe(true);
    vi.advanceTimersByTime(2000);
    expect(state.cursor).toBe(2);
  });

  it("pauses and resumes", () => {
    const { state, player } = setup(5);
    player.toggle(); vi.advanceTimersByTime(1000); player.toggle();
    vi.advanceTimersByTime(5000);
    expect([player.playing, state.cursor]).toEqual([false, 1]);
  });

  it("releases its timer at the last caption", () => {
    // Regression: the interval kept firing every 4 s after the end, re-rendering the phone page and wiping typed input.
    const { state, player } = setup(3);
    player.toggle(); vi.advanceTimersByTime(2000);
    expect([player.playing, state.cursor]).toEqual([false, 2]);
    const changes = state.changes;
    vi.advanceTimersByTime(20_000);
    expect(state.changes).toBe(changes);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stop clears a running timer", () => {
    const { player } = setup(10);
    player.toggle(); player.stop();
    expect([player.playing, vi.getTimerCount()]).toEqual([false, 0]);
  });
});

describe("bridge access", () => {
  it("does not double the slash after a typed address", () => {
    expect(bridgeUrl(" http://127.0.0.1:8789/ ", "/feed")).toBe("http://127.0.0.1:8789/feed");
    expect(bridgeUrl("http://h", "/feed")).toBe("http://h/feed");
  });

  it("labels HTTP failures", async () => {
    const fetchImpl = (async () => new Response("", { status: 403 })) as typeof fetch;
    await expect(fetchText("http://h/transcript", "transcript", { fetchImpl })).rejects.toThrow("transcript HTTP 403");
  });

  it("returns the body", async () => {
    const fetchImpl = (async () => new Response("WEBVTT")) as typeof fetch;
    expect(await fetchText("http://h/feed", "feed", { fetchImpl })).toBe("WEBVTT");
  });

  it("times out a bridge that never answers", async () => {
    // Regression: plain fetch() had no timeout.
    const fetchImpl = ((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })) as typeof fetch;
    await expect(fetchText("http://h/feed", "feed", { fetchImpl, timeoutMs: 10 })).rejects.toThrow("feed timed out");
  });
});
