import { describe, expect, it } from "vitest";
import { validateEvenHubPageContainer, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import type { CallSheet } from "../src/api/types";
import {
  BAR_HEIGHT, BAR_WIDTH, ICON_HEIGHT, ICON_WIDTH, PULSE_MS, dayBarFrame, daySpan, headerIcon,
} from "../src/glasses/charts";
import { bitmapKey } from "../src/glasses/gfx";
import { BAR, SIGN, buildPage, createPage, rebuildPage, updatePage, type Frames } from "../src/glasses/render";
import { MENU, buildView, minutesText, stopwatch, type Mode, type ViewState } from "../src/glasses/views";
import { locales } from "../src/i18n";
import { MAX_BODY_ROWS, ROW_WIDTH } from "../src/glasses/screen";

const sheet = (call: string, times: string[]): CallSheet => ({
  date: "Mo", call, location: "", contact: "", notes: "", schedule: times.map((time) => ({ time, what: "x" })),
});

describe("time texts", () => {
  it("counts minutes up to two hours and then hours and minutes", () => {
    expect(minutesText(0)).toBe("0 min");
    expect(minutesText(119)).toBe("119 min");
    expect(minutesText(120)).toBe("2 h 00 min");
    expect(minutesText(1319)).toBe("21 h 59 min");
    expect(minutesText(-4)).toBe("0 min");
  });

  it("the stopwatch shows m:ss and h:mm:ss", () => {
    expect(stopwatch(0)).toBe("0:00");
    expect(stopwatch(83_000)).toBe("1:23");
    expect(stopwatch(3_725_000)).toBe("1:02:05");
    expect(stopwatch(-5)).toBe("0:00");
  });
});

describe("header sign", () => {
  const modes: Mode[] = ["menu", "takes", "prompter", "schedule", "pack"];

  it("is a 64 x 30 picture with ink for every page", () => {
    for (const mode of modes) {
      for (const rolling of [false, true]) {
        const b = headerIcon(mode, rolling, 0);
        expect(b.width).toBe(ICON_WIDTH);
        expect(b.height).toBe(ICON_HEIGHT);
        expect(b.pixels.some((v) => v > 0)).toBe(true);
      }
    }
  });

  it("the recording dot pulses at 1 Hz while a take runs, and only on the takes page", () => {
    const [a, b, c] = [0, PULSE_MS, 2 * PULSE_MS].map((t) => bitmapKey(headerIcon("takes", true, t)));
    expect(a).toBe(c);
    expect(a).not.toBe(b);
    for (const mode of modes) {
      if (mode === "takes") continue;
      expect(bitmapKey(headerIcon(mode, true, 0))).toBe(bitmapKey(headerIcon(mode, true, PULSE_MS)));
    }
    expect(bitmapKey(headerIcon("takes", false, 0))).toBe(bitmapKey(headerIcon("takes", false, PULSE_MS)));
    expect(bitmapKey(headerIcon("takes", false, 0))).not.toBe(a);
  });
});

describe("day bar", () => {
  it("spans from the call time to the last entry", () => {
    expect(daySpan(sheet("07:30", ["08:00", "18:00", "12:15"]))).toEqual({ start: 450, end: 1080 });
    expect(daySpan(sheet("", ["09:00", "11:00"]))).toEqual({ start: 540, end: 660 });
    expect(daySpan(sheet("09:00", []))).toEqual({ start: 540, end: 600 });
    expect(daySpan(sheet("", []))).toBeNull();
    expect(daySpan(sheet("kein", ["auch nicht"]))).toBeNull();
  });

  it("is 288 x 20, pure, and moves its marker with the clock", () => {
    const s = sheet("07:30", ["08:00", "12:00", "18:00"]);
    const a = dayBarFrame(s, 8 * 60)!;
    expect(a.width).toBe(BAR_WIDTH);
    expect(a.height).toBe(BAR_HEIGHT);
    expect(BAR_HEIGHT).toBeGreaterThanOrEqual(20);
    expect(a.pixels.some((v) => v > 0)).toBe(true);
    expect(bitmapKey(a)).toBe(bitmapKey(dayBarFrame(s, 8 * 60)!));
    expect(bitmapKey(dayBarFrame(s, 12 * 60)!)).not.toBe(bitmapKey(a));
    expect(dayBarFrame(sheet("", []), 0)).toBeNull();
  });

  it("copes with a clock before the call and after the end", () => {
    const s = sheet("07:30", ["18:00"]);
    expect(dayBarFrame(s, 3 * 60)!.pixels.some((v) => v > 0)).toBe(true);
    expect(dayBarFrame(s, 23 * 60)!.pixels.some((v) => v > 0)).toBe(true);
    expect(bitmapKey(dayBarFrame(s, 3 * 60)!)).not.toBe(bitmapKey(dayBarFrame(s, 12 * 60)!));
  });
});

describe("pages", () => {
  const state = (patch: Partial<ViewState> = {}): ViewState => ({
    locale: "de", demo: false, configured: true, now: new Date(2026, 9, 13, 10, 0), mode: "schedule", menuCursor: 0,
    project: "P", pendingCount: 0, load: { kind: "ready" }, message: "", rec: null,
    takes: { shots: [{ scene: "1", shot: "A", desc: "d", size: "" }], cursor: 0, screen: "card", actionCursor: 1, noteCursor: 0, ok: 0, ng: 0, last: null, nextN: 1, rollingSince: null, notes: [] },
    prompter: { lines: [], pos: 0, speed: 0.4, playing: false },
    schedule: { sheet: sheet("07:30", ["08:00", "12:00", "18:00"]), scroll: 0 },
    pack: { items: [], cursor: 0, missing: false },
    ...patch,
  });
  const view = buildView(state());
  const frames: Frames = { sign: headerIcon("schedule", false, 0), bar: dayBarFrame(sheet("07:30", ["08:00", "18:00"]), 600) };

  it("both layouts stay inside the SDK limits and keep the text out of the sign's corner", () => {
    for (const layout of ["plain", "schedule"] as const) {
      const page = buildPage(view, layout);
      expect((page.imageObject ?? []).length).toBeLessThanOrEqual(4);
      expect((page.textObject ?? []).filter((c) => c.isEventCapture === 1)).toHaveLength(1);
      expect(validateEvenHubPageContainer(page).valid).toBe(true);
      expect((page.textObject ?? []).find((c) => c.containerName === "header")?.width).toBe(512);
    }
    expect(buildPage(view, "schedule").imageObject ?? []).toHaveLength(2);
    expect(buildPage(view, "plain").imageObject ?? []).toHaveLength(1);
    expect(SIGN.x).toBe(512);
    const body = (buildPage(view, "schedule").textObject ?? []).find((c) => c.containerName === "body")!;
    expect((body.yPosition ?? 0) + (body.height ?? 0)).toBeLessThanOrEqual(BAR.y);
    expect(BAR.y + BAR.height).toBeLessThanOrEqual(252);
    expect(BAR.width).toBeLessThanOrEqual(288);
  });

  it("every view fits its container: header 46, rows 56, at most 7 rows, in both languages and with a running take", () => {
    const LONG = "sehr langer Text ".repeat(20);
    for (const locale of locales) {
      for (const mode of ["menu", "takes", "prompter", "schedule", "pack"] as const) {
        for (const rollingSince of [null, 1]) {
          const v = buildView(state({
            locale, mode, message: LONG, demo: true,
            takes: { ...state().takes, rollingSince, screen: "card" },
            schedule: { sheet: { ...sheet("07:30", Array.from({ length: 12 }, (_, i) => `${8 + i}:00`)), contact: LONG, location: LONG }, scroll: 0 },
          }));
          expect(v.header.length).toBeLessThanOrEqual(46);
          expect(v.body.length).toBeLessThanOrEqual(mode === "schedule" ? 6 : MAX_BODY_ROWS);
          for (const row of [v.footer, ...v.body]) expect(row.length).toBeLessThanOrEqual(ROW_WIDTH);
        }
      }
    }
    expect(MENU.length).toBeGreaterThan(0);
  });

  function fakeBridge() {
    const calls: string[] = [];
    const bridge = {
      createStartUpPageContainer: async () => { calls.push("create"); return 0; },
      rebuildPageContainer: async () => { calls.push("rebuild"); return true; },
      textContainerUpgrade: async (c: { containerName?: string }) => { calls.push(`text:${c.containerName}`); return true; },
      updateImageRawData: async (c: { containerName?: string }) => { calls.push(`image:${c.containerName}`); return "success"; },
    } as unknown as EvenAppBridge;
    return { bridge, calls };
  }

  it("creates once (after one first rebuild) and rebuilds for the other layout", async () => {
    const { bridge, calls } = fakeBridge();
    await createPage(bridge, view, "plain", { sign: frames.sign, bar: null });
    await rebuildPage(bridge, view, "schedule", frames);
    await rebuildPage(bridge, view, "plain", { sign: frames.sign, bar: null });
    expect(calls.filter((c) => c === "create" || c === "rebuild")).toEqual(["rebuild", "create", "rebuild", "rebuild"]);
  });

  it("sends the sign and the bar only when they changed; no bar before there is one", async () => {
    const { bridge, calls } = fakeBridge();
    await createPage(bridge, view, "schedule", { sign: frames.sign, bar: null });
    expect(calls.filter((c) => c.startsWith("image:"))).toEqual(["image:sign"]);
    calls.length = 0;
    await updatePage(bridge, view, "schedule", frames, view);
    expect(calls).toEqual(["image:daybar"]);
    calls.length = 0;
    await updatePage(bridge, view, "schedule", frames, view);
    expect(calls).toEqual([]);
    await updatePage(bridge, view, "schedule", { ...frames, sign: headerIcon("takes", true, 0) }, view);
    expect(calls).toEqual(["image:sign"]);
  });

  it("the take card shows the running take, and the actions list offers to cancel it", () => {
    const rolling = state({ mode: "takes", now: new Date(2026, 9, 13, 10, 0, 23), takes: { ...state().takes, rollingSince: new Date(2026, 9, 13, 10, 0, 0).getTime() } });
    expect(buildView(rolling).body[2]).toBe("● Take 1 läuft · 0:23");
    const actions = buildView({ ...rolling, takes: { ...rolling.takes, screen: "actions" } });
    expect(actions.body[0]).toBe("  Take abbrechen");
    expect(buildView(state({ mode: "takes", takes: { ...state().takes, screen: "actions" } })).body[0]).toBe("  Take starten");
  });

  it("'in 1319 min' reads '21 h 59 min' in the schedule", () => {
    const v = buildView(state({ now: new Date(2026, 9, 13, 8, 1), schedule: { sheet: sheet("08:00", ["08:00", "06:00"]), scroll: 0 } }));
    expect(v.body.join("\n")).not.toContain("min)");
    const far = buildView(state({ now: new Date(2026, 9, 13, 8, 1), schedule: { sheet: sheet("08:00", ["08:00", "23:59", "05:00"]), scroll: 0 } }));
    expect(far.body[1]).toContain("in 15 h 58 min");
  });
});
