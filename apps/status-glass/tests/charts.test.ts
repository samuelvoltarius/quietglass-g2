import { describe, expect, it } from "vitest";
import { validateEvenHubPageContainer, type EvenAppBridge, type RebuildPageContainer } from "@evenrealities/even_hub_sdk";
import { MetricHistory, SPARK_POINTS, sparkKey, type SparkSeries } from "../src/monitor/history";
import { applyReport, acknowledge, createSource } from "../src/monitor/dashboard";
import type { Metric, SourceReport } from "../src/protocol/schema";
import {
  ICON_HEIGHT, ICON_WIDTH, PULSE_MS, SPARK_HEIGHT, SPARK_WIDTH, signFrame, signState, sparklineFrame,
} from "../src/glasses/charts";
import { bitmapKey } from "../src/glasses/gfx";
import { buildView } from "../src/glasses/view";
import { BODY_ROWS, SIGN, SPARKS, buildPage, createPage, rebuildPage, updatePage, type Frames } from "../src/glasses/render";
import { demoNasReport } from "../src/monitor/demo";

const metric = (over: Partial<Metric>): Metric => ({ id: "cpu", label: "CPU", unit: "%", ...over });
const report = (cpu: number, extra: Metric[] = []): SourceReport => ({
  name: "nas",
  metrics: [metric({ value: cpu, warn: 80, critical: 95 }), metric({ id: "gpu", label: "GPU", value: 20 }), metric({ id: "mem", label: "RAM", value: 55 }), ...extra],
});

describe("sparkline history", () => {
  it("finds CPU, GPU and RAM by id or label", () => {
    expect(sparkKey({ id: "cpu0", label: "x" })).toBe("cpu");
    expect(sparkKey({ id: "m1", label: "GPU load" })).toBe("gpu");
    expect(sparkKey({ id: "mem", label: "x" })).toBe("ram");
    expect(sparkKey({ id: "disk", label: "Disk" })).toBeNull();
  });

  it("keeps the last 12 readings and ignores metrics that are not numbers", () => {
    const history = new MetricHistory();
    for (let i = 0; i < 20; i += 1) history.record("a", report(i, [{ id: "web", label: "Web", state: "ok" }]));
    const series = history.series("a", report(19));
    expect(series.map((s) => s.key)).toEqual(["cpu", "gpu", "ram"]);
    expect(series[0]!.values).toHaveLength(SPARK_POINTS);
    expect(series[0]!.values.at(-1)).toBe(19);
    expect(series[0]!.values[0]).toBe(8);
  });

  it("keeps sources apart and forgets a removed one", () => {
    const history = new MetricHistory();
    history.record("a", report(10));
    history.record("b", report(90));
    expect(history.series("a", report(10))[0]!.values).toEqual([10]);
    history.forget("a");
    expect(history.series("a", report(10))).toEqual([]);
    expect(history.series("b", report(90))[0]!.values).toEqual([90]);
    expect(history.series("b", null)).toEqual([]);
  });

  it("carries the state of the metric", () => {
    const history = new MetricHistory();
    history.record("a", report(97));
    expect(history.series("a", report(97))[0]!.state).toBe("critical");
  });
});

describe("sparkline frames", () => {
  const series = (values: number[], over: Partial<SparkSeries> = {}): SparkSeries => ({
    key: "cpu", label: "CPU", values, unit: "%", warn: 80, critical: 95, lowerIsWorse: false, state: "ok", ...over,
  });

  it("is 188 x 64, inside the 288 x 64 limit, with ink", () => {
    const b = sparklineFrame(series([10, 20, 30, 25, 40, 55, 60, 52, 48, 70, 66, 61]));
    expect(b.width).toBe(SPARK_WIDTH);
    expect(b.height).toBe(SPARK_HEIGHT);
    expect(SPARK_WIDTH).toBeLessThanOrEqual(288);
    expect(SPARK_HEIGHT).toBeLessThanOrEqual(64);
    expect(b.pixels.some((v) => v > 0)).toBe(true);
  });

  it("is a pure function of the data: same readings, same picture; a new reading changes it", () => {
    const a = sparklineFrame(series([10, 20, 30]));
    const b = sparklineFrame(series([10, 20, 30]));
    const c = sparklineFrame(series([10, 20, 30, 31]));
    expect(bitmapKey(a)).toBe(bitmapKey(b));
    expect(bitmapKey(a)).not.toBe(bitmapKey(c));
  });

  it("copes with one reading, a flat line, negative and huge values", () => {
    const cases: Array<[number[], string]> = [[[5], "%"], [[50, 50, 50, 50], "%"], [[-20, -5, -12], "C"], [[1e9, 2e9, 1.5e9], "B"], [[100, 100, 0, 100], "%"]];
    for (const [values, unit] of cases) {
      const b = sparklineFrame(series(values, { unit }));
      expect(b.pixels).toHaveLength(SPARK_WIDTH * SPARK_HEIGHT);
      expect(b.pixels.some((v) => v > 0)).toBe(true);
    }
  });

  it("draws a frame around a critical reading", () => {
    const calm = sparklineFrame(series([10, 12]));
    const critical = sparklineFrame(series([10, 97], { state: "critical" }));
    expect(critical.pixels[0]).toBeGreaterThan(0);
    expect(calm.pixels[0]).toBe(0);
  });
});

describe("the status sign", () => {
  const source = (rep: SourceReport) => applyReport(createSource("s", "nas"), rep, 1000);

  it("tells ok, warning and critical apart", () => {
    expect(signState([source(report(10))], 1000)).toBe("ok");
    expect(signState([source(report(85))], 1000)).toBe("warn");
    expect(signState([source(report(97))], 1000)).toBe("critical");
    expect(signState([], 0)).toBe("unknown");
  });

  it("pulses critical at 1 Hz and stands still otherwise", () => {
    const frames = [0, 1, 2, 3].map((i) => bitmapKey(signFrame("critical", i * PULSE_MS)));
    expect(frames[0]).toBe(frames[2]);
    expect(frames[1]).toBe(frames[3]);
    expect(frames[0]).not.toBe(frames[1]);
    for (const state of ["ok", "warn", "unknown"] as const) {
      expect(bitmapKey(signFrame(state, 0))).toBe(bitmapKey(signFrame(state, 12_345)));
    }
  });

  it("is a 64 x 30 picture with ink in every state", () => {
    for (const state of ["ok", "unknown", "warn", "critical"] as const) {
      const b = signFrame(state, 0);
      expect(b.width).toBe(ICON_WIDTH);
      expect(b.height).toBe(ICON_HEIGHT);
      expect(b.pixels.some((v) => v > 0)).toBe(true);
    }
  });

  it("an acknowledged critical problem stops pulsing and keeps a calm warning", () => {
    const acked = acknowledge(source(report(97)), "cpu");
    expect(signState([acked], 1000)).toBe("warn");
  });
});

describe("page layouts", () => {
  const sources = [applyReport(createSource("s", "nas"), report(20), 1000)];
  const view = buildView(sources, { maxRows: BODY_ROWS.graph, focusName: "nas" }, 1000);
  const spark = (): Frames["sparks"][number] => sparklineFrame({
    key: "cpu", label: "CPU", values: [1, 2], unit: "%", warn: undefined, critical: undefined, lowerIsWorse: false, state: "ok",
  });
  const frames: Frames = { sign: signFrame("ok", 0), sparks: [spark(), spark(), spark()] };

  it("graph and list stay inside the SDK limits", () => {
    for (const layout of ["graph", "list"] as const) {
      const page = buildPage(view, layout);
      expect((page.imageObject ?? []).length).toBeLessThanOrEqual(4);
      expect((page.textObject ?? []).length).toBeLessThanOrEqual(8);
      expect((page.textObject ?? []).filter((c) => c.isEventCapture === 1)).toHaveLength(1);
      expect(validateEvenHubPageContainer(page).valid).toBe(true);
      const header = (page.textObject ?? []).find((c) => c.containerName === "header");
      expect(header?.width).toBe(576 - ICON_WIDTH);
    }
    expect(buildPage(view, "graph").imageObject ?? []).toHaveLength(4);
    expect(buildPage(view, "list").imageObject ?? []).toHaveLength(1);
    expect(SPARKS.every((s) => s.width <= 288 && s.height <= 64)).toBe(true);
    expect(SIGN.width).toBe(64);
  });

  it("slots do not overlap the body or each other", () => {
    for (let i = 0; i < SPARKS.length; i += 1) {
      const slot = SPARKS[i]!;
      expect(slot.y).toBeGreaterThanOrEqual(36 + 122);
      expect(slot.x + slot.width).toBeLessThanOrEqual(576);
      if (i > 0) expect(slot.x).toBeGreaterThanOrEqual(SPARKS[i - 1]!.x + SPARKS[i - 1]!.width);
    }
  });

  function fakeBridge() {
    const calls: string[] = [];
    let rebuilt: RebuildPageContainer | null = null;
    const bridge = {
      createStartUpPageContainer: async () => { calls.push("create"); return 0; },
      rebuildPageContainer: async (c: RebuildPageContainer) => { calls.push("rebuild"); rebuilt = c; return true; },
      textContainerUpgrade: async (c: { containerName?: string }) => { calls.push(`text:${c.containerName}`); return true; },
      updateImageRawData: async (c: { containerName?: string }) => { calls.push(`image:${c.containerName}`); return "success"; },
    } as unknown as EvenAppBridge;
    return { bridge, calls, rebuilt: () => rebuilt };
  }

  it("sends the sign and sparklines once, then only what changed", async () => {
    const { bridge, calls } = fakeBridge();
    await createPage(bridge, view, "graph", frames);
    expect(calls.filter((c) => c.startsWith("image:")).sort()).toEqual(["image:sign", "image:spark1", "image:spark2", "image:spark3"]);
    calls.length = 0;
    await updatePage(bridge, view, "graph", frames, view);
    expect(calls).toEqual([]);
    const moved: Frames = { ...frames, sign: signFrame("critical", 0) };
    await updatePage(bridge, view, "graph", moved, view);
    expect(calls).toEqual(["image:sign"]);
  });

  it("a slot that loses its series is blanked once; a slot that never had one stays untouched", async () => {
    const { bridge, calls } = fakeBridge();
    const one: Frames = { sign: frames.sign, sparks: [frames.sparks[0] ?? null] };
    await createPage(bridge, view, "graph", one);
    expect(calls.filter((c) => c.startsWith("image:"))).toEqual(["image:sign", "image:spark1"]);
    calls.length = 0;
    await updatePage(bridge, view, "graph", { sign: frames.sign, sparks: [] }, view);
    expect(calls).toEqual(["image:spark1"]);
    calls.length = 0;
    await updatePage(bridge, view, "graph", { sign: frames.sign, sparks: [] }, view);
    expect(calls).toEqual([]);
  });

  it("another layout is a rebuild with the other container set", async () => {
    const { bridge, calls, rebuilt } = fakeBridge();
    await createPage(bridge, view, "graph", frames);
    calls.length = 0;
    await rebuildPage(bridge, buildView(sources, {}, 1000), "list", { sign: frames.sign, sparks: [] });
    expect(calls[0]).toBe("rebuild");
    expect(rebuilt()?.imageObject).toHaveLength(1);
    expect(calls).toContain("image:sign");
  });

  it("only the changed text containers are written", async () => {
    const { bridge, calls } = fakeBridge();
    await updatePage(bridge, view, "graph", frames, null);
    calls.length = 0;
    await updatePage(bridge, { ...view, footer: "anders" }, "graph", frames, view);
    expect(calls).toEqual(["text:footer"]);
  });
});

describe("demo readings", () => {
  it("critical scene ends with a critical CPU, warn scene with a warning, calm scene stays ok", () => {
    const levels = (scene: string | null) => demoNasReport(scene, 11).metrics.map((m) =>
      (m.value ?? 0) >= (m.critical ?? Infinity) ? "critical" : (m.value ?? 0) >= (m.warn ?? Infinity) ? "warn" : "ok");
    expect(levels("critical")).toContain("critical");
    expect(levels("warn")).toContain("warn");
    expect(levels("graph")).not.toContain("critical");
    expect(levels("graph")).not.toContain("warn");
  });
});

describe("page installation", () => {
  it("creates the page exactly once per bridge: one first rebuild, one create, then only rebuilds", async () => {
    const calls: string[] = [];
    const bridge = {
      createStartUpPageContainer: async () => { calls.push("create"); return 0; },
      rebuildPageContainer: async () => { calls.push("rebuild"); return true; },
      textContainerUpgrade: async () => true,
      updateImageRawData: async () => "success",
    } as unknown as EvenAppBridge;
    const sources = [applyReport(createSource("s", "nas"), report(20), 1000)];
    const view = buildView(sources, {}, 1000);
    const frames: Frames = { sign: signFrame("ok", 0), sparks: [] };
    await createPage(bridge, view, "list", frames);
    await createPage(bridge, view, "list", frames);
    await rebuildPage(bridge, view, "graph", frames);
    expect(calls).toEqual(["rebuild", "create", "rebuild", "rebuild"]);
  });
});
