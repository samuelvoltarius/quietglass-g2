import { describe, expect, it } from "vitest";
import {
  CreateStartUpPageContainer, validateEvenHubPageContainer, type EvenAppBridge,
} from "@evenrealities/even_hub_sdk";
import { EMPTY_STATE, type AgentState } from "../src/terminal/types";
import { agentMood, isOffline } from "../src/glasses/face";
import { MASCOT_STEP_MS, mascotFrame, type Mood } from "../src/glasses/mascot";
import { buildPage, COCKPIT_TILES, updatePage } from "../src/glasses/render";
import { buildView } from "../src/glasses/view";

const NOW = new Date("2026-10-13T12:00:00Z");
const session = { id: "s", title: "Improve dashboard loading state", cwd: "/w", provider: "claude", status: "idle", timestamp: NOW };
const state = (patch: Partial<AgentState> = {}): AgentState => ({ ...EMPTY_STATE, session, controllable: true, ...patch });

describe("the face follows the agent", () => {
  it("maps what the agent does to a mood", () => {
    expect(agentMood(state(), false)).toBe("idle");
    expect(agentMood(state({ busy: true }), false)).toBe("working");
    expect(agentMood(state({ pending: { kind: "permission", title: "Bash", detail: "ls" } }), false)).toBe("waiting");
    expect(agentMood(state({ error: "Agent stopped" }), false)).toBe("error");
    expect(agentMood(state({ busy: true }), true)).toBe("asleep");
  });

  it("a decision beats an error, and no connection beats everything", () => {
    const both = state({ error: "x", pending: { kind: "question", title: "Q", detail: "?" } });
    expect(agentMood(both, false)).toBe("waiting");
    expect(agentMood(both, true)).toBe("asleep");
  });

  it("sleeps without a token, on a dropped stream and on connection errors only", () => {
    expect(isOffline(state(), false, false)).toBe(true);
    expect(isOffline(state(), true, true)).toBe(true);
    expect(isOffline(state({ error: "Hermes bridge unreachable" }), true, false)).toBe(true);
    expect(isOffline(state({ error: "Timed out" }), true, false)).toBe(true);
    expect(isOffline(state({ error: "Agent stopped: tests failed" }), true, false)).toBe(false);
    expect(isOffline(state(), true, false)).toBe(false);
  });

  it("every mood draws a pattern with ink, frame after frame", () => {
    const moods: Mood[] = ["idle", "working", "waiting", "error", "asleep"];
    const keys = new Map<Mood, Set<string>>();
    for (const mood of moods) {
      const set = new Set<string>();
      for (let i = 0; i < 12; i += 1) {
        const rows = mascotFrame(mood, i * MASCOT_STEP_MS);
        expect(rows.some((row) => row.includes("#"))).toBe(true);
        set.add(rows.join("|"));
      }
      keys.set(mood, set);
    }
    // Working writes (many frames), idle blinks (two), waiting moves its mouth (two), error and sleep stay still.
    expect(keys.get("working")!.size).toBeGreaterThan(3);
    expect(keys.get("idle")!.size).toBe(2);
    expect(keys.get("waiting")!.size).toBe(2);
    expect(keys.get("error")!.size).toBe(1);
    expect(keys.get("asleep")!.size).toBe(1);
  });

  it("is a pure function of (mood, now)", () => {
    expect(mascotFrame("working", 4321)).toEqual(mascotFrame("working", 4321));
  });
});

describe("page limits", () => {
  it("the text page is three text containers without an image and stays inside the SDK limits", () => {
    const page: CreateStartUpPageContainer = buildPage(buildView(state(), NOW));
    expect(page.imageObject ?? []).toHaveLength(0);
    expect((page.textObject ?? []).filter((c) => c.isEventCapture === 1)).toHaveLength(1);
    expect(page.containerTotalNum).toBe(3);
    const header = (page.textObject ?? []).find((c) => c.containerName === "header");
    expect(header?.width).toBe(576);
    expect(validateEvenHubPageContainer(page).valid).toBe(true);
  });

  it("the cockpit page is four image tiles over an input container and passes the SDK validator", () => {
    const page = buildPage(buildView(state(), NOW), null, "cockpit");
    expect(page.imageObject ?? []).toHaveLength(4);
    expect((page.textObject ?? []).filter((c) => c.isEventCapture === 1)).toHaveLength(1);
    expect(page.containerTotalNum).toBe(5);
    for (const tile of COCKPIT_TILES) { expect(tile.width).toBe(288); expect(tile.height).toBe(144); }
    expect(validateEvenHubPageContainer(page).valid).toBe(true);
  });

  it("an update writes only the text that changed", async () => {
    const calls: string[] = [];
    const bridge = {
      textContainerUpgrade: async (c: { containerName?: string }) => { calls.push(`text:${c.containerName}`); return true; },
    } as unknown as EvenAppBridge;
    const view = buildView(state({ text: "one" }), NOW);
    await updatePage(bridge, view, null);
    expect(calls.splice(0)).toEqual(["text:header", "text:body", "text:footer"]);
    await updatePage(bridge, view, view);
    expect(calls).toEqual([]);
    const next = { ...view, footer: "anders" };
    await updatePage(bridge, next, view);
    expect(calls).toEqual(["text:footer"]);
  });
});

describe("page installation", () => {
  it("creates the page exactly once per bridge: one first rebuild, one create, then only rebuilds", async () => {
    const { createPage } = await import("../src/glasses/render");
    const calls: string[] = [];
    const bridge = {
      createStartUpPageContainer: async () => { calls.push("create"); return 0; },
      rebuildPageContainer: async () => { calls.push("rebuild"); return true; },
      textContainerUpgrade: async () => true,
      updateImageRawData: async () => "success",
    } as unknown as EvenAppBridge;
    const view = buildView(state(), NOW);
    await createPage(bridge, view);
    await createPage(bridge, view, null, "cockpit");
    expect(calls).toEqual(["rebuild", "create", "rebuild"]);
  });
});
