import { describe, expect, it } from "vitest";
import {
  CreateStartUpPageContainer, validateEvenHubPageContainer, type EvenAppBridge,
} from "@evenrealities/even_hub_sdk";
import { EMPTY_STATE, type AgentState } from "../src/terminal/types";
import { ICON_HEIGHT, ICON_WIDTH, MASCOT_STEP_MS, agentMood, headerIcon, isOffline } from "../src/glasses/face";
import { mascotFrame, type Mood } from "../src/glasses/mascot";
import { bitmapKey } from "../src/glasses/gfx";
import { buildPage, FACE, SCREEN_WIDTH, updatePage } from "../src/glasses/render";
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

  it("every mood draws an 64x30 picture with ink, frame after frame", () => {
    const moods: Mood[] = ["idle", "working", "waiting", "error", "asleep"];
    const keys = new Map<Mood, Set<string>>();
    for (const mood of moods) {
      const set = new Set<string>();
      for (let i = 0; i < 12; i += 1) {
        const s = state({
          busy: mood === "working",
          error: mood === "error" ? "boom" : null,
          pending: mood === "waiting" ? { kind: "permission", title: "Bash", detail: "ls" } : null,
        });
        const icon = headerIcon("agent", s, mood === "asleep", i * MASCOT_STEP_MS);
        expect(icon.width).toBe(ICON_WIDTH);
        expect(icon.height).toBe(ICON_HEIGHT);
        expect(icon.pixels.some((v) => v > 0)).toBe(true);
        set.add(bitmapKey(icon));
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

  it("is a pure function of (state, now)", () => {
    const a = headerIcon("agent", state({ busy: true }), false, 4321);
    const b = headerIcon("agent", state({ busy: true }), false, 4321);
    expect(bitmapKey(a)).toBe(bitmapKey(b));
    expect(mascotFrame("working", 4321)).toEqual(mascotFrame("working", 4321));
  });

  it("the session list has its own sign", () => {
    const agent = headerIcon("agent", state(), false, 0);
    const list = headerIcon("sessions", state(), false, 0);
    expect(bitmapKey(agent)).not.toBe(bitmapKey(list));
  });
});

describe("page limits", () => {
  it("keeps the header text out of the face's corner and stays inside the SDK limits", () => {
    const page: CreateStartUpPageContainer = buildPage(buildView(state(), NOW));
    expect(page.imageObject).toHaveLength(1);
    expect((page.imageObject ?? []).length).toBeLessThanOrEqual(4);
    expect((page.textObject ?? []).filter((c) => c.isEventCapture === 1)).toHaveLength(1);
    expect(page.containerTotalNum).toBe(4);
    const header = (page.textObject ?? []).find((c) => c.containerName === "header");
    expect(header?.width).toBe(SCREEN_WIDTH - ICON_WIDTH);
    expect(FACE.x).toBe(SCREEN_WIDTH - ICON_WIDTH);
    expect(validateEvenHubPageContainer(page).valid).toBe(true);
  });

  it("an update writes only the text that changed and the face only when it changed", async () => {
    const calls: string[] = [];
    const bridge = {
      textContainerUpgrade: async (c: { containerName?: string }) => { calls.push(`text:${c.containerName}`); return true; },
      updateImageRawData: async () => { calls.push("image"); return "success"; },
    } as unknown as EvenAppBridge;
    const view = buildView(state({ text: "one" }), NOW);
    const face = headerIcon("agent", state(), false, 0);
    await updatePage(bridge, view, face, null);
    const first = calls.splice(0);
    expect(first).toContain("image");
    await updatePage(bridge, view, face, view);
    expect(calls).toEqual([]);
    const next = { ...view, footer: "anders" };
    await updatePage(bridge, next, face, view);
    expect(calls).toEqual(["text:footer"]);
  });
});
