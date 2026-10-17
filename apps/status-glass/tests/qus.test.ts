import { describe, expect, it } from "vitest";
import {
  captionFor, cockpitHint, cockpitModel, cockpitPages, hostBars, hostCells, hostTone, modelKey, overviewCells, statusLines, uptimeShort,
  type CockpitModel, type CockpitPage,
} from "../src/cockpit/model";
import { arcStyle, cellBoxes, composeCockpit, ringSegments } from "../src/cockpit/compose";
import { createFrame, frameKey, tiles, type Frame } from "../src/screen/frame";
import { createTileSender, tileSlots } from "../src/screen/sender";
import { pixelBackend } from "../src/screen/text";
import { acknowledge, applyError, applyReport, createSource, problems, type SourceStatus } from "../src/monitor/dashboard";
import { demoFleetReport, demoStartFleet } from "../src/monitor/demo";
import { startRows, startView } from "../src/glasses/view";
import { summarize, bannerFor, nowInner, hostsInner, setupInner, TABS, isFirstRun } from "../src/ui/phone";
import { EMPTY_DATA } from "../src/storage/persist";

// QUS v1: the pure parts of the cockpit and the start page - cells, headline, start rows, footer text, tile diff.
const NOW = new Date(2026, 9, 17, 14, 5).getTime();
const backend = pixelBackend();

function fleet(problem: boolean, now = NOW): SourceStatus[] {
  return demoStartFleet(problem).map((machine) => applyReport(createSource(machine.id, machine.name), demoFleetReport(machine, 11), now));
}
const overview: CockpitPage = { kind: "overview" };
const model = (sources: SourceStatus[], page: CockpitPage = overview, locale: "de" | "en" = "de", now = NOW): CockpitModel =>
  cockpitModel({ sources, page, now, locale, demo: false });

describe("cockpit headline", () => {
  it("says ALLES OK when nothing is wrong, and counts open problems otherwise", () => {
    expect(statusLines(fleet(false), NOW, "de")).toEqual(["ALLES OK"]);
    expect(statusLines(fleet(true), NOW, "de")).toEqual(["1 PROBLEM"]);
    expect(statusLines(fleet(true), NOW, "en")).toEqual(["1 PROBLEM"]);
    const two = fleet(true);
    two[0] = applyReport(two[0]!, { name: "Spark", metrics: [{ id: "cpu", label: "CPU", value: 99, unit: "%", warn: 85, critical: 95 }] }, NOW);
    expect(statusLines(two, NOW, "de")).toEqual(["2 PROBLEME"]);
    expect(statusLines(two, NOW, "en")).toEqual(["2 PROBLEMS"]);
  });

  it("a seen problem stops being the headline but is not forgotten", () => {
    let sources = fleet(true);
    const open = problems(sources, NOW)[0]!;
    sources = sources.map((source) => (source.id === open.sourceId ? acknowledge(source, open.metric.id) : source));
    expect(statusLines(sources, NOW, "de")).toEqual(["1 GESEHEN"]);
    expect(statusLines(sources, NOW, "en")).toEqual(["1 SEEN"]);
  });

  it("an unreachable source is never ok: OFFLINE when none answers, a problem when one is missing", () => {
    const down = demoStartFleet(false).map((machine) => applyError(createSource(machine.id, machine.name), "unreachable", NOW));
    expect(statusLines(down, NOW, "de")).toEqual(["OFFLINE"]);
    const mixed = [...fleet(false).slice(0, 3), down[3]!];
    expect(statusLines(mixed, NOW, "de")).toEqual(["1 PROBLEM"]);
    expect(statusLines([], NOW, "de")).toEqual(["KEINE", "QUELLE"]);
    expect(statusLines([createSource("x", "never")], NOW, "de")).toEqual(["OFFLINE"]);
  });

  it("a single server has its name on the first line and its state on the second", () => {
    const sources = fleet(true);
    expect(model(sources, { kind: "host", id: "ns1" }).headline).toEqual(["NS1", "1 PROBLEM"]);
    expect(model(sources, { kind: "host", id: "spark" }).headline).toEqual(["SPARK", "ALLES OK"]);
  });
});

describe("cockpit cells", () => {
  it("overview: servers ok / warning / offline, then the highest CPU, RAM and disk", () => {
    const cells = overviewCells(fleet(true), NOW, "de");
    expect(cells.map((cell) => cell.label)).toEqual(["OK", "WARN", "OFFLINE", "CPU MAX", "RAM MAX", "DISK MAX"]);
    expect(cells.slice(0, 3).map((cell) => cell.value)).toEqual(["3", "1", "0"]);
    // ns1's disk at 93 % is the highest and over its limit: framed.
    expect(cells[5]).toEqual({ label: "DISK MAX", value: "93%", alert: true });
    expect(cells[1]!.alert).toBe(true);
    expect(cells[0]!.alert).toBeUndefined();
    expect(overviewCells(fleet(false), NOW, "de")[5]).toEqual({ label: "DISK MAX", value: "71%" });
    expect(overviewCells(fleet(false), NOW, "en")[2]!.label).toBe("DOWN");
  });

  it("overview without any reading says dashes, offline servers do not count into the maxima", () => {
    const empty = overviewCells([createSource("x", "never")], NOW, "de");
    expect(empty.slice(0, 3).map((cell) => cell.value)).toEqual(["0", "0", "1"]);
    expect(empty.slice(3).map((cell) => cell.value)).toEqual(["–", "–", "–"]);
    const sources = fleet(false);
    sources[0] = applyError(sources[0]!, "unreachable", NOW);
    expect(overviewCells(sources, NOW, "de")[2]!.value).toBe("1");
  });

  it("one server: CPU, RAM, fullest disk, load, temperature, uptime", () => {
    const [spark] = fleet(false);
    const cells = hostCells(spark!, NOW, "de");
    expect(cells.map((cell) => cell.label)).toEqual(["CPU", "RAM", "DISK", "LAST", "TEMP", "LÄUFT"]);
    expect(cells[2]!.value).toBe("71%");
    expect(cells[4]!.value).toMatch(/^\d+°C$/);
    expect(cells[5]!.value).toBe("14 T");
    expect(hostCells(spark!, NOW, "en")[5]).toEqual({ label: "UP", value: "14 d" });
    // A problem frames its cell.
    const [, , ns1] = fleet(true);
    expect(hostCells(ns1!, NOW, "de")[2]).toEqual({ label: "DISK", value: "93%", alert: true });
  });

  it("an offline or silent server shows dashes, never old numbers", () => {
    const [spark] = fleet(false);
    const down = applyError(spark!, "unreachable", NOW);
    expect(hostCells(down, NOW, "de").map((cell) => cell.value)).toEqual(["–", "–", "–", "–", "–", "–"]);
    expect(hostBars(down, NOW, "de").map((bar) => [bar.value, bar.text, bar.tone])).toEqual([[null, "–", "offline"], [null, "–", "offline"], [null, "–", "offline"]]);
    expect(hostTone(down, NOW)).toBe("offline");
    expect(hostTone(spark!, NOW + 10 * 60_000)).toBe("offline");
  });

  it("writes uptime short: hours below two days, then days", () => {
    expect(uptimeShort(5, "de")).toBe("5 h");
    expect(uptimeShort(47, "de")).toBe("47 h");
    expect(uptimeShort(345, "de")).toBe("14 T");
    expect(uptimeShort(345, "en")).toBe("14 d");
  });

  it("bars carry the state of their reading", () => {
    const [, , ns1] = fleet(true);
    const bars = hostBars(ns1!, NOW, "de");
    expect(bars.map((bar) => bar.label)).toEqual(["CPU", "RAM", "DISK"]);
    expect(bars[2]).toMatchObject({ value: 93, text: "93%", tone: "warn" });
    expect(bars[0]!.tone).toBe("ok");
  });
});

describe("cockpit pages, caption and hint", () => {
  it("walks the overview and every server; one server is its own page", () => {
    const sources = fleet(true);
    expect(cockpitPages(sources).map((page) => (page.kind === "host" ? page.id : page.kind))).toEqual(["overview", "spark", "pi", "ns1", "nas"]);
    expect(cockpitPages([sources[0]!])).toEqual([{ kind: "host", id: "spark" }]);
    expect(cockpitPages([])).toEqual([{ kind: "overview" }]);
  });

  it("the caption says when the data is from, and the demo says it is a demo", () => {
    expect(captionFor(fleet(false), NOW, "de", false)).toBe("Stand 14:05");
    expect(captionFor(fleet(false), NOW, "en", false)).toBe("As of 14:05");
    expect(captionFor([createSource("x", "never")], NOW, "de", false)).toBe("Noch keine Daten");
    expect(captionFor(fleet(false), NOW + 10 * 60_000, "de", false)).toBe("Zuletzt 14:05");
    expect(captionFor(fleet(false), NOW, "de", true)).toBe("Demo · am Handy einrichten");
  });

  it("the hint is one footer line, swipe only with more than one page", () => {
    expect(cockpitHint("de", 5)).toBe("Tippen = neu laden · Wischen = Server · 2× = zurück");
    expect(cockpitHint("de", 1)).toBe("Tippen = neu laden · 2× = zurück");
    expect(model(fleet(true)).hint).toBe("Tippen = neu laden · Wischen = Server · 2× = zurück");
    expect(model([fleet(true)[0]!]).hint).toBe("Tippen = neu laden · 2× = zurück");
  });

  it("the graphic of the overview is one arc per server, the centre says how many are fine", () => {
    const warn = model(fleet(true)).graphic;
    expect(warn).toEqual({ kind: "ring", segments: ["ok", "ok", "warn", "ok"], center: "3/4", sub: "SERVER OK" });
    expect(model(fleet(true), { kind: "host", id: "ns1" }).graphic.kind).toBe("bars");
    expect(model([]).graphic).toMatchObject({ center: "–", segments: [] });
    expect(ringSegments(1)).toEqual([{ from: 0, to: Math.PI * 2 }]);
    expect(ringSegments(4)).toHaveLength(4);
    expect(arcStyle("warn").dash).toBeGreaterThan(1);
    expect(arcStyle("critical").thickness).toBeGreaterThan(arcStyle("ok").thickness);
  });
});

describe("start rows", () => {
  const options = (sources: SourceStatus[], actions = 0) => ({ locale: "de" as const, demo: false, problemCount: problems(sources, NOW).length, actionCount: actions });

  it("at most three entries: overview, problems (only while something is wrong), actions (only when offered)", () => {
    const calm = fleet(false);
    expect(startRows([calm[0]!], 0, 0).map((row) => row.kind)).toEqual(["all"]);
    expect(startRows([calm[0]!], 2, 1).map((row) => row.kind)).toEqual(["all", "problems", "actions"]);
    expect(startRows([], 0, 0)).toEqual([]);
  });

  it("servers hang under the overview when there are two or more", () => {
    const rows = startRows(fleet(true), 1, 1);
    expect(rows.map((row) => row.kind)).toEqual(["all", "host", "host", "host", "host", "problems", "actions"]);
    expect(rows.filter((row) => row.kind !== "host")).toHaveLength(3);
  });

  it("renders the cursor as a dot, servers indented, five rows at most", () => {
    const sources = fleet(true);
    const view = startView(sources, 2, NOW, options(sources, 1));
    expect(view.header).toBe("Status · ● live");
    expect(view.body).toEqual([
      "  Alle Server · 3/4 ok", "    Spark · ok", "●   Pi5 · ok", "    ns1 · Warnung", "    NAS · ok",
    ]);
    expect(view.footer).toBe("Tippen = öffnen · Wischen = wählen · 2× = Ende");
    const last = startView(sources, 6, NOW, options(sources, 1));
    expect(last.body).toHaveLength(5);
    expect(last.body.at(-1)).toBe("● Aktionen");
    expect(last.body.at(-2)).toBe("  Probleme · 1");
  });

  it("one server: the entry is the server itself", () => {
    const [spark] = fleet(false);
    expect(startView([spark!], 0, NOW, options([spark!])).body).toEqual(["● Spark"]);
  });
});

describe("tile diff", () => {
  const frameOf = (sources: SourceStatus[], now = NOW, page: CockpitPage = overview): Frame => composeCockpit(model(sources, page, "de", now), backend);
  const tileKeys = (frame: Frame): string[] => tiles(frame).map(frameKey);

  it("an unchanged state draws the same frame, tile for tile", () => {
    expect(tileKeys(frameOf(fleet(true)))).toEqual(tileKeys(frameOf(fleet(true))));
    expect(modelKey(model(fleet(true)))).toBe(modelKey(model(fleet(true))));
  });

  it("the clock alone changes only the top right tile", () => {
    const before = tileKeys(frameOf(fleet(true)));
    const after = tileKeys(frameOf(fleet(true), NOW + 60_000));
    // The caption "Stand 14:05" is the data time, not the clock: it stays.
    const changed = before.map((key, index) => (key === after[index] ? -1 : index)).filter((index) => index >= 0);
    expect(changed).toEqual([1]);
  });

  it("one changed figure in the lower right changes only the lower right tile", () => {
    const calm = fleet(true);
    const busier = calm.map((source) => (source.id === "nas"
      ? applyReport(source, demoFleetReport({ id: "nas", name: "NAS", cpu: 62, ram: 36, offlineMinutes: 0 }, 11), NOW)
      : source));
    const before = tileKeys(frameOf(calm));
    const after = tileKeys(frameOf(busier));
    expect(before.map((key, index) => (key === after[index] ? -1 : index)).filter((index) => index >= 0)).toEqual([3]);
  });

  it("the sender sends all four tiles once, then nothing for an identical frame, then only what changed", async () => {
    const sent: string[] = [];
    const sender = createTileSender(tileSlots(21, "t"), async (slot) => { sent.push(slot.name); return true; }, () => new Uint8Array(1));
    await sender.push(frameOf(fleet(true)));
    expect(sent).toEqual(["t-nw", "t-ne", "t-sw", "t-se"]);
    await sender.push(frameOf(fleet(true)));
    expect(sent).toHaveLength(4);
    await sender.push(frameOf(fleet(true), NOW + 60_000));
    expect(sent.slice(4)).toEqual(["t-ne"]);
    // A rebuilt page starts blank: everything goes out again.
    sender.reset();
    await sender.push(frameOf(fleet(true), NOW + 60_000));
    expect(sent).toHaveLength(9);
    expect(sender.sent()).toBe(9);
  });

  it("lays the six cells out in two rows of three inside the right half", () => {
    const boxes = cellBoxes(model(fleet(true)).cells);
    expect(boxes.map((box) => [box.x > 288, box.y])).toEqual([[true, 118], [true, 118], [true, 118], [true, 174], [true, 174], [true, 174]]);
    expect(boxes.every((box) => box.x + box.width <= 576)).toBe(true);
    expect(composeCockpit(model([]), backend).pixels.some((level) => level > 0)).toBe(true);
    expect(createFrame().pixels.some((level) => level > 0)).toBe(false);
  });
});

describe("phone view models", () => {
  it("have exactly three tabs, Jetzt / Server / Einstellungen", () => {
    expect(TABS.map((tab) => tab.id)).toEqual(["now", "servers", "settings"]);
  });

  it("the hero value is how many servers are fine, the stats are problems, offline, CPU and disk maxima", () => {
    const sources = fleet(true);
    expect(summarize(sources, NOW)).toEqual({ total: 4, ok: 3, open: 1, all: 1, offline: 0, cpuMax: 36, diskMax: 93 });
    const html = nowInner(sources, NOW, false, "de", 30);
    expect(html).toContain("3/4 OK");
    expect(html).toContain("alle 30 s");
    expect(html.match(/<b>/g)!.length).toBeGreaterThanOrEqual(4);
    expect(html).toContain('id="refresh"');
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toContain('class="strip"');
    expect(html.match(/class="host /g)).toHaveLength(4);
  });

  it("the banner carries the one message that counts", () => {
    expect(bannerFor(fleet(false), NOW, false, "de")).toEqual({ tone: "ok", text: "Alles in Ordnung." });
    expect(bannerFor(fleet(true), NOW, false, "de")).toEqual({ tone: "warn", text: "ns1: Disk / 93% voll" });
    expect(bannerFor([], NOW, false, "de").tone).toBe("none");
    expect(bannerFor(fleet(false), NOW, true, "en").text).toContain("demo data");
    expect(bannerFor([createSource("x", "n")], NOW, false, "de").text).toBe("Warte auf die erste Antwort …");
    expect(bannerFor(demoStartFleet(false).map((m) => applyError(createSource(m.id, m.name), "unreachable", NOW)), NOW, false, "de").tone).toBe("offline");
  });

  it("the servers tab lists a card per server with its cells and problems", () => {
    const html = hostsInner(fleet(true), NOW, "de");
    expect(html.match(/<section class="card server/g)).toHaveLength(4);
    expect(html).toContain("Disk / 93% voll");
    expect(hostsInner([], NOW, "de")).toContain("Noch keine Server");
  });

  it("the first-run checklist has three steps and ticks them off", () => {
    expect(isFirstRun(EMPTY_DATA)).toBe(true);
    const none = setupInner(EMPTY_DATA, [], "de");
    expect(none.match(/<li/g)).toHaveLength(3);
    expect(none).not.toContain("✓");
    const added = { ...EMPTY_DATA, sources: [{ id: "s1", name: "nas", url: "https://nas.test/status" }] };
    expect(setupInner(added, [], "de").match(/✓/g)).toHaveLength(1);
    expect(setupInner(added, fleet(false), "de").match(/✓/g)).toHaveLength(3);
  });
});
