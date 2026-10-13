import { describe, expect, it } from "vitest";
import { validateEvenHubPageContainer, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { MetricHistory } from "../src/monitor/history";
import { acknowledge, applyError, applyReport, createSource, type SourceStatus } from "../src/monitor/dashboard";
import { DEMO_FLEET, demoFleetReport } from "../src/monitor/demo";
import {
  FLEET_ROWS, ROW_HEIGHT, ROW_TEXT_WIDTH, ROW_WIDTH, agePhrase, fleetPulses, fleetRowFrame, fleetRows, fleetView, isOffline,
} from "../src/glasses/fleet";
import { bitmapKey } from "../src/glasses/gfx";
import { PULSE_MS } from "../src/glasses/charts";
import { FLEET_IMAGES, buildPage, createPage, updatePage } from "../src/glasses/render";
import { locales } from "../src/i18n";

const NOW = 10_000_000;
const MIN = 60_000;

function machine(index: number, opts: { offlineMin?: number; acknowledged?: string } = {}): { source: SourceStatus; history: MetricHistory } {
  const m = DEMO_FLEET[index]!;
  const history = new MetricHistory();
  for (let step = 0; step < 12; step += 1) history.record(m.id, demoFleetReport(m, step));
  let source = applyReport(createSource(m.id, m.name), demoFleetReport(m, 11), opts.offlineMin ? NOW - opts.offlineMin * MIN : NOW);
  if (opts.offlineMin) source = applyError(source, "unreachable", NOW);
  if (opts.acknowledged) source = acknowledge(source, opts.acknowledged);
  return { source, history };
}

function fleet() {
  const history = new MetricHistory();
  const sources: SourceStatus[] = [];
  [machine(0), machine(1), machine(2), machine(3, { offlineMin: 12 })].forEach((m, i) => {
    sources.push(m.source);
    for (let step = 0; step < 12; step += 1) history.record(m.source.id, demoFleetReport(DEMO_FLEET[i]!, step));
  });
  return { sources, history };
}

describe("fleet overview rows", () => {
  it("formats how long ago", () => {
    expect(agePhrase(10_000)).toBe("<1 min");
    expect(agePhrase(12 * MIN)).toBe("12 min");
    expect(agePhrase(130 * MIN)).toBe("2 h 10 min");
    expect(agePhrase(60 * 60 * MIN)).toBe("2 d");
  });

  it("marks fine, warning, critical and offline machines, one row each", () => {
    const { sources, history } = fleet();
    const rows = fleetRows(sources, history, 0, "de", NOW);
    expect(rows.map((r) => r.state)).toEqual(["ok", "warn", "critical", "offline"]);
    expect(rows.map((r) => r.name)).toEqual(["Spark", "Pi5", "ns1", "samuel"]);
    expect(rows[0]!.selected).toBe(true);
    expect(rows[1]!.selected).toBe(false);
  });

  it("says how long a machine has been offline, in both languages", () => {
    const { sources, history } = fleet();
    expect(fleetRows(sources, history, 0, "de", NOW)[3]!.text).toContain("offline seit 12 min");
    expect(fleetRows(sources, history, 0, "en", NOW)[3]!.text).toContain("offline for 12 min");
    const never = [{ ...createSource("x", "X"), error: "unreachable", fetchedAt: NOW }];
    expect(fleetRows(never, new MetricHistory(), 0, "de", NOW)[0]!.text).toContain("noch nie erreicht");
    expect(isOffline(never[0]!, NOW)).toBe(true);
  });

  it("a silent machine counts as offline even without an error", () => {
    const stale = applyReport(createSource("s", "S"), demoFleetReport(DEMO_FLEET[0]!, 0), NOW - 10 * MIN);
    expect(isOffline(stale, NOW)).toBe(true);
    expect(fleetRows([stale], new MetricHistory(), 0, "de", NOW)[0]!.text).toContain("offline seit 10 min");
  });

  it("shows CPU, RAM, fullest disk and temperature of every reachable machine, sick or not", () => {
    const { sources, history } = fleet();
    const rows = fleetRows(sources, history, 0, "de", NOW);
    expect(rows[0]!.text).toMatch(/^> CPU \d+%  RAM \d+%  Disk 71%  \d+°C$/);
    expect(rows[1]!.text).toMatch(/^ {2}CPU \d+%  RAM \d+%  Disk 34%/);
    // ns1 is critical: the light pulses and the header says why, the figures stay.
    expect(rows[2]!.text).toMatch(/Disk 93%/);
  });

  it("falls back to the worst problem for a source without the well-known figures", () => {
    const source = applyReport(createSource("ha", "HA"), { name: "HA", metrics: [{ id: "door", label: "Door open", state: "warn" }] }, NOW);
    expect(fleetRows([source], new MetricHistory(), 0, "de", NOW)[0]!.text).toBe("> · Door open");
  });

  it("an acknowledged problem keeps a calm warning and stops pulsing", () => {
    const m = machine(2);
    const acked = ["cpu", "load", "memory", "disk:/"].reduce(acknowledge, m.source);
    const before = fleetRows([m.source], m.history, 0, "de", NOW)[0]!;
    const after = fleetRows([acked], m.history, 0, "de", NOW)[0]!;
    expect(before.state).toBe("critical");
    expect(after.state).toBe("warn");
    expect(after.text).toContain("CPU");
    // Seen problems leave the warning line in the header.
    expect(fleetView([acked], [after], "de", NOW).header).toBe("RECHNER · 0 von 1 ok");
    expect(fleetPulses([before])).toBe(true);
    expect(fleetPulses([after])).toBe(false);
  });

  it("shows at most four machines, the window follows the cursor, every text fits its column", () => {
    const history = new MetricHistory();
    const sources = Array.from({ length: 7 }, (_, i) => applyReport(createSource(`m${i}`, `Maschine-${i}-mit-sehr-langem-Namen`), demoFleetReport(DEMO_FLEET[0]!, 0), NOW));
    for (let cursor = 0; cursor < 7; cursor += 1) {
      for (const locale of locales) {
        const rows = fleetRows(sources, history, cursor, locale, NOW);
        expect(rows.length).toBeLessThanOrEqual(FLEET_ROWS);
        expect(rows.some((r) => r.selected)).toBe(true);
        for (const row of rows) expect(row.text.length).toBeLessThanOrEqual(ROW_TEXT_WIDTH);
      }
    }
  });

  it("the view counts healthy machines in the header", () => {
    const { sources, history } = fleet();
    const view = fleetView(sources, fleetRows(sources, history, 0, "de", NOW), "de", NOW);
    // The worst open problem is the header; the offline machine speaks in its own row.
    expect(view.header).toMatch(/^! ns1: CPU \d+% \+\d+$/);
    expect(view.body).toHaveLength(4);
    expect(view.header.length).toBeLessThanOrEqual(56);
    const healthy = fleet().sources.slice(0, 1);
    expect(fleetView(healthy, fleetRows(healthy, history, 0, "de", NOW), "de", NOW).header).toBe("RECHNER · 1 von 1 ok");
  });

  it("puts failed services and a full disk into the header, in words", () => {
    const report = { name: "x", metrics: [
      { id: "failed", label: "Failed units", value: 5, unit: "", warn: 1, detail: "a.mount, b.mount" },
      { id: "disk:/data", label: "/data", value: 93, unit: "%", warn: 90, critical: 95 },
    ] };
    const source = applyReport(createSource("s", "Spark"), report, NOW);
    expect(fleetView([source], fleetRows([source], new MetricHistory(), 0, "de", NOW), "de", NOW).header).toBe("· Spark: 5 Dienste fehlgeschlagen +1");
    const diskOnly = acknowledge(source, "failed");
    expect(fleetView([diskOnly], [], "en", NOW).header).toBe("· Spark: Disk /data 93% full");
  });
});

describe("fleet row pictures", () => {
  it("are 288 x 54 with ink for every state, pure, and only critical pulses at 1 Hz", () => {
    const { sources, history } = fleet();
    const rows = fleetRows(sources, history, 0, "de", NOW);
    for (const row of rows) {
      const b = fleetRowFrame(row, 0);
      expect(b.width).toBe(ROW_WIDTH);
      expect(b.height).toBe(ROW_HEIGHT);
      expect(b.pixels.some((v) => v > 0)).toBe(true);
      expect(bitmapKey(fleetRowFrame(row, 777))).toBe(bitmapKey(fleetRowFrame(row, 777)));
    }
    const critical = rows[2]!;
    const [a, b, c] = [0, PULSE_MS, 2 * PULSE_MS].map((t) => bitmapKey(fleetRowFrame(critical, t)));
    expect(a).toBe(c);
    expect(a).not.toBe(b);
    for (const calm of [rows[0]!, rows[1]!, rows[3]!]) {
      expect(bitmapKey(fleetRowFrame(calm, 0))).toBe(bitmapKey(fleetRowFrame(calm, 3 * PULSE_MS + 1)));
    }
  });

  it("copes with a machine that has no series", () => {
    const row = { id: "x", name: "WWWWWWWWWWWWWWWWWW", state: "ok" as const, text: "", series: null, selected: true };
    expect(fleetRowFrame(row, 0).pixels.some((v) => v > 0)).toBe(true);
  });
});

describe("fleet page", () => {
  const { sources, history } = fleet();
  const rows = fleetRows(sources, history, 0, "de", NOW);
  const view = fleetView(sources, rows, "de", NOW);
  const frames = { sign: fleetRowFrame(rows[0]!, 0), rows: rows.map((r) => fleetRowFrame(r, 0)), sparks: [] };

  it("stays inside the SDK limits: 4 images, 6 texts, one capture, rows side by side", () => {
    const page = buildPage(view, "fleet");
    expect(page.imageObject ?? []).toHaveLength(4);
    expect(page.textObject ?? []).toHaveLength(6);
    expect((page.textObject ?? []).filter((c) => c.isEventCapture === 1)).toHaveLength(1);
    expect(validateEvenHubPageContainer(page).valid).toBe(true);
    for (const image of FLEET_IMAGES) {
      expect(image.width).toBeLessThanOrEqual(288);
      expect(image.height).toBeLessThanOrEqual(144);
      expect(image.y + image.height).toBeLessThanOrEqual(252);
    }
    for (const text of (page.textObject ?? []).filter((c) => (c.containerName ?? "").startsWith("row"))) {
      expect(text.xPosition).toBeGreaterThanOrEqual(ROW_WIDTH);
      expect((text.xPosition ?? 0) + (text.width ?? 0)).toBeLessThanOrEqual(576);
    }
  });

  it("sends the four pictures once, then only the row that changed", async () => {
    const calls: string[] = [];
    const bridge = {
      createStartUpPageContainer: async () => { calls.push("create"); return 0; },
      rebuildPageContainer: async () => { calls.push("rebuild"); return true; },
      textContainerUpgrade: async (c: { containerName?: string }) => { calls.push(`text:${c.containerName}`); return true; },
      updateImageRawData: async (c: { containerName?: string }) => { calls.push(`image:${c.containerName}`); return "success"; },
    } as unknown as EvenAppBridge;
    await createPage(bridge, view, "fleet", frames);
    expect(calls.filter((c) => c.startsWith("image:")).sort()).toEqual(["image:machine1", "image:machine2", "image:machine3", "image:machine4"]);
    calls.length = 0;
    await updatePage(bridge, view, "fleet", frames, view);
    expect(calls).toEqual([]);
    const next = { ...view, body: [view.body[0]!, view.body[1]!, "  ! CPU 99 %", view.body[3]!] };
    const moved = { ...frames, rows: [frames.rows[0]!, frames.rows[1]!, fleetRowFrame({ ...rows[2]!, text: "x" }, PULSE_MS), frames.rows[3]!] };
    await updatePage(bridge, next, "fleet", moved, view);
    expect(calls.sort()).toEqual(["image:machine3", "text:row3"]);
  });
});
