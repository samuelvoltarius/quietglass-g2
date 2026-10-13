import { describe, expect, it } from "vitest";
import {
  CreateStartUpPageContainer, validateEvenHubPageContainer, type EvenAppBridge,
} from "@evenrealities/even_hub_sdk";
import { EMPTY_MODEL, buildView, type HudModel } from "../src/hud/model";
import { ICON_HEIGHT, ICON_WIDTH, MASCOT_STEP_MS, headerIcon, hudMood } from "../src/glasses/face";
import { bitmapKey } from "../src/glasses/gfx";
import { buildPage, FACE, SCREEN_WIDTH, updatePage } from "../src/glasses/render";
import { createDemoApi } from "../src/api/demo";
import type { HudCard } from "../src/api/types";

const NOW = new Date(2026, 9, 13, 12, 0);
const card: HudCard = { id: "c1", title: "Drucker starten?", text: "Bereit.", effect: "physisch" };
const model = (patch: Partial<HudModel> = {}): HudModel => ({
  ...EMPTY_MODEL, configured: true, online: true, feed: { version: "v", status: "Alles ruhig", cards: [] }, ...patch,
});

describe("the face follows Xaventra", () => {
  it("shows sleep without setup or without a server", () => {
    expect(hudMood(EMPTY_MODEL)).toBe("asleep");
    expect(hudMood(model({ configured: false }))).toBe("asleep");
    expect(hudMood(model({ online: false, problem: "Server nicht erreichbar" }))).toBe("asleep");
  });

  it("shows an error when the server answered with a problem", () => {
    expect(hudMood(model({ online: false, fault: true, problem: "Token abgelehnt (401)" }))).toBe("error");
  });

  it("waits with wide eyes while a card needs a yes or no", () => {
    expect(hudMood(model({ feed: { version: "v", status: "Prüft Drucker", cards: [card] } }))).toBe("waiting");
  });

  it("works on a status that is not quiet, rests on a quiet one", () => {
    expect(hudMood(model({ feed: { version: "v", status: "Prüft Drucker — Schritt 1/2", cards: [] } }))).toBe("working");
    expect(hudMood(model())).toBe("idle");
    expect(hudMood(model({ feed: { version: "v", status: "", cards: [] } }))).toBe("idle");
    expect(hudMood(model({ feed: { version: "v", status: "All quiet", cards: [] } }))).toBe("idle");
  });

  it("listens while you speak and works while the server recognises it", () => {
    expect(hudMood(model({ rec: "opening" }))).toBe("listening");
    expect(hudMood(model({ rec: "listening" }))).toBe("listening");
    expect(hudMood(model({ rec: "sending" }))).toBe("working");
  });

  it("draws a 64x30 picture with ink in every mood, and moves while working", () => {
    const states: HudModel[] = [
      EMPTY_MODEL,
      model(),
      model({ feed: { version: "v", status: "Prüft", cards: [] } }),
      model({ feed: { version: "v", status: "Prüft", cards: [card] } }),
      model({ online: false, fault: true }),
      model({ rec: "listening" }),
    ];
    for (const m of states) {
      const icon = headerIcon(m, 123_456);
      expect(icon.width).toBe(ICON_WIDTH);
      expect(icon.height).toBe(ICON_HEIGHT);
      expect(icon.pixels.some((v) => v > 0)).toBe(true);
    }
    const working = model({ feed: { version: "v", status: "Prüft", cards: [] } });
    const frames = new Set([0, 1, 2, 3, 4, 5].map((i) => bitmapKey(headerIcon(working, i * MASCOT_STEP_MS))));
    expect(frames.size).toBeGreaterThan(3);
    expect(bitmapKey(headerIcon(working, 777))).toBe(bitmapKey(headerIcon(working, 777)));
  });

  it("every header leaves the face's corner free (48 characters)", () => {
    for (const locale of ["de", "en"] as const) {
      const views = [
        buildView(EMPTY_MODEL, locale, NOW),
        buildView(model({ online: false, feed: null, problem: "x".repeat(300) }), locale, NOW),
        buildView(model({ rec: "listening" }), locale, NOW),
        buildView(model({ voice: { transcript: "Hallo", reply: "Hi" } }), locale, NOW),
        buildView(model({ feed: { version: "v", status: "s".repeat(300), cards: [card] }, confirm: "c1" }), locale, NOW),
      ];
      for (const view of views) expect(view.header.length).toBeLessThanOrEqual(48);
    }
  });
});

describe("demo scenes", () => {
  it("serve a card by default and none for the quiet scenes", async () => {
    const signal = new AbortController().signal;
    expect((await createDemoApi("de").feed("", signal)).cards).toHaveLength(1);
    expect((await createDemoApi("de", "idle").feed("", signal)).cards).toHaveLength(0);
    await expect(createDemoApi("de", "error").feed("", signal)).rejects.toMatchObject({ code: "auth" });
    await expect(createDemoApi("de", "offline").feed("", signal)).rejects.toMatchObject({ code: "unreachable" });
  });
});

describe("page limits", () => {
  it("keeps the header text out of the face's corner and stays inside the SDK limits", () => {
    const page: CreateStartUpPageContainer = buildPage(buildView(model(), "de", NOW));
    expect((page.imageObject ?? []).length).toBe(1);
    expect((page.textObject ?? []).filter((c) => c.isEventCapture === 1)).toHaveLength(1);
    expect(page.containerTotalNum).toBe(4);
    expect((page.textObject ?? []).find((c) => c.containerName === "header")?.width).toBe(SCREEN_WIDTH - ICON_WIDTH);
    expect(FACE.x).toBe(SCREEN_WIDTH - ICON_WIDTH);
    expect(validateEvenHubPageContainer(page).valid).toBe(true);
  });

  it("an update writes only the text that changed and the face only when it changed", async () => {
    const calls: string[] = [];
    const bridge = {
      textContainerUpgrade: async (c: { containerName?: string }) => { calls.push(`text:${c.containerName}`); return true; },
      updateImageRawData: async () => { calls.push("image"); return "success"; },
    } as unknown as EvenAppBridge;
    const view = buildView(model(), "de", NOW);
    const face = headerIcon(model(), 0);
    await updatePage(bridge, view, face, null);
    expect(calls).toContain("image");
    calls.length = 0;
    await updatePage(bridge, view, face, view);
    expect(calls).toEqual([]);
    await updatePage(bridge, { ...view, footer: "anders" }, face, view);
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
    const view = buildView(model(), "de", NOW);
    const face = headerIcon(model(), 0);
    await createPage(bridge, view, face);
    await createPage(bridge, view, face);
    expect(calls).toEqual(["rebuild", "create", "rebuild"]);
  });
});
