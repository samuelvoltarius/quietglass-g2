import { describe, expect, it } from "vitest";
import { ImageRawDataUpdateResult } from "@evenrealities/even_hub_sdk";
import { buildView, createModel, decide, mergeReport, ROOT_ITEMS, startRows, type HubModel } from "../src/hub/model";
import { demoReport } from "../src/api/demo";
import type { HubReport } from "../src/api/types";
import { cockpitCaption, cockpitCells, cockpitHint, cockpitModel, durationText, hubState, modelKey } from "../src/cockpit/model";
import { cellBoxes, composeCockpit, MASCOT } from "../src/cockpit/compose";
import { frameKey, tiles, type Frame } from "../src/screen/frame";
import { createTileSender, tileSlots } from "../src/screen/sender";
import { pixelBackend } from "../src/screen/text";
import { guardedTileSend } from "../src/glasses/render";
import { ROW_WIDTH } from "../src/glasses/screen";

// QUS v1: the pure parts of the cockpit and the start page - cells, headline, start rows, footer text, tile diff.
const NOW = new Date(2026, 9, 17, 14, 5).getTime();
const backend = pixelBackend();

function working(report: HubReport = demoReport()): HubReport {
  return {
    ...report,
    agents: report.agents.map((a) => (a.id === "claude-win"
      ? { ...a, busy: true, online: true, activity: "Edit: foo.ts", busySince: NOW - 7 * 60_000, steps: ["Read: a.ts", "Edit: foo.ts"], session: { id: "s1", title: "Cockpit bauen" } }
      : { ...a, busy: false })),
    approvals: [],
  };
}
const modelOf = (report: HubReport, extra: Partial<HubModel> = {}): HubModel => ({ ...createModel(report), screen: "cockpit", ...extra });
const idle = (): HubModel => modelOf({ ...demoReport(), agents: demoReport().agents.map((a) => ({ ...a, busy: false })), approvals: [] });

describe("cockpit headline", () => {
  it("says ARBEITET while an agent works, WARTET when one needs you, BEREIT otherwise", () => {
    expect(cockpitModel(modelOf(working()), "de", NOW).headline).toEqual(["ARBEITET"]);
    expect(cockpitModel(modelOf(working()), "en", NOW).headline).toEqual(["WORKING"]);
    const waiting = modelOf({ ...working(), approvals: [{ id: "c", agentId: "claude-win", tool: "Bash", title: "Bash: npm test", detail: "npm test", createdAt: "", expiresAt: 0 }] });
    expect(cockpitModel(waiting, "de", NOW).headline).toEqual(["WARTET"]);
    expect(cockpitModel(idle(), "de", NOW).headline).toEqual(["BEREIT"]);
    expect(cockpitModel(idle(), "en", NOW).headline).toEqual(["READY"]);
  });

  it("an unreachable or missing hub is never ready", () => {
    const link = (problem: "unreachable" | "missing") => modelOf(demoReport(), { link: { problem, host: "x", fails: 3, hadData: false } });
    expect(hubState(link("unreachable"))).toBe("offline");
    expect(cockpitModel(link("unreachable"), "de", NOW).headline).toEqual(["OFFLINE"]);
    expect(cockpitModel(link("missing"), "de", NOW).headline).toEqual(["KEIN SERVER"]);
  });
});

describe("cockpit cells", () => {
  it("working: Agent, Sitzung, Dauer, Schritte, Ungelesen", () => {
    const cells = cockpitCells(modelOf(working()), NOW, "de");
    expect(cells.map((cell) => cell.label)).toEqual(["AGENT", "SITZUNG", "DAUER", "SCHRITTE", "UNGELESEN"]);
    expect(cells.slice(1, 4).map((cell) => cell.value)).toEqual(["Cockpit bauen", "7 min", "1"]);
    expect(cells[0]!.value).not.toBe("–");
    expect(cockpitCells(modelOf(working()), NOW, "en").map((cell) => cell.label)).toEqual(["AGENT", "SESSION", "TIME", "STEPS", "UNREAD"]);
  });

  it("idle: Dauer and Schritte are dashes; unread frames its cell", () => {
    const cells = cockpitCells(idle(), NOW, "de");
    expect(cells[2]!.value).toBe("–");
    expect(cells[3]!.value).toBe("–");
    const unread = cells[4]!;
    expect(unread.alert === true).toBe(Number(unread.value) > 0);
  });

  it("the duration is coarse (once a minute), never seconds", () => {
    expect(durationText(30_000, "de")).toBe("<1 min");
    expect(durationText(59_999, "de")).toBe("<1 min");
    expect(durationText(7 * 60_000 + 59_000, "de")).toBe("7 min");
    expect(durationText(65 * 60_000, "de")).toBe("1 h 05");
  });

  it("lays the five cells out in two rows of three inside the right half", () => {
    const boxes = cellBoxes(cockpitModel(modelOf(working()), "de", NOW).cells);
    expect(boxes.map((box) => [box.x > 288, box.y])).toEqual([[true, 118], [true, 118], [true, 118], [true, 174], [true, 174]]);
    expect(boxes.every((box) => box.x + box.width <= 576)).toBe(true);
  });

  it("caption: what it does, the demo hint, or how many agents are online", () => {
    expect(cockpitCaption(modelOf(working()), "de")).not.toBe("");
    expect(cockpitCaption({ ...idle(), setupHint: true }, "de")).toBe("Demo · am Handy einrichten");
    expect(cockpitCaption(idle(), "de")).toMatch(/\d+\/\d+ online/);
  });

  it("the hint is one footer line that fits the row", () => {
    expect(cockpitHint("de")).toBe("Tippen = Agenten · 2× = zurück");
    expect(cockpitHint("en")).toBe("Tap = agents · 2× = back");
    expect(cockpitModel(idle(), "de", NOW).hint.length).toBeLessThanOrEqual(ROW_WIDTH);
  });
});

describe("start page", () => {
  const report = demoReport();

  it("six areas with one live row each, warnings above them (0.11 command centre)", () => {
    expect(ROOT_ITEMS).toEqual(["agent", "home", "car", "printer", "server", "brief"]);
    const rows = startRows(report, "de");
    expect(rows).toHaveLength(7);
    expect(rows[0]).toBe("! 1 neue Meldung");
    expect(rows.slice(1).map((row) => row.split(" · ")[0])).toEqual(["Agenten", "Zuhause", "Auto", "Drucker", "Server", "Tag"]);
    expect(rows[1]).toMatch(/^Agenten · \d+\/\d+ online/);
    expect(startRows(report, "en").slice(1).map((row) => row.split(" · ")[0])).toEqual(["Agents", "Home", "Car", "Printer", "Servers", "Day"]);
    for (const row of [...rows, ...startRows(report, "en")]) expect(row).not.toMatch(/Halten|Hold/);
  });

  it("renders a dot-less marker cursor, header `Modus · state`, one footer line", () => {
    const view = buildView(createModel(report), "de", NOW);
    expect(view.header).toBe("Quiet Hub · Demo");
    expect(view.body.length).toBeLessThanOrEqual(7);
    expect(view.body[0]!.startsWith("> ")).toBe(true);
    expect(view.footer).toBe("Tippen = öffnen · Wischen = wählen · 2× = Ende");
    const last = buildView({ ...createModel(report), rootKey: "area:brief" }, "de", NOW);
    expect(last.body.at(-1)).toMatch(/^> Tag · /);
  });

  it("the cursor stays on its area when a warning row comes or goes", () => {
    const onHome: HubModel = { ...createModel(report), rootKey: "area:home" };
    const quiet = mergeReport(onHome, { ...report, inbox: { selected: 0, events: [] } });
    expect(buildView(quiet, "de", NOW).body.find((row) => row.startsWith("> "))).toMatch(/^> Zuhause/);
    expect(buildView(onHome, "de", NOW).body.find((row) => row.startsWith("> "))).toMatch(/^> Zuhause/);
    // 2x from an area page lands on that area's row.
    const car = decide({ ...createModel(report), rootKey: "area:car" }, "click", NOW, "de");
    expect(car.model.screen).toBe("car");
    expect(car.effect).toEqual({ kind: "brief", refresh: false });
    const back = decide(car.model, "doubleClick", NOW, "de").model;
    expect(back.screen).toBe("root");
    expect(buildView(back, "de", NOW).body.find((row) => row.startsWith("> "))).toMatch(/^> Auto/);
  });

  it("the first-start demo adds its hint line", () => {
    const view = buildView({ ...createModel(report), setupHint: true }, "de", NOW);
    expect(view.body.at(-1)).toContain("Demo · Verbindung am Handy einrichten");
  });

  it("the cockpit (ring picker): a tap there opens the agents, a swipe changes nothing, 2x goes back to the start page", () => {
    const m = createModel(report);
    const opened: HubModel = { ...m, screen: "cockpit" };
    expect(opened.screen).toBe("cockpit");
    expect(decide(opened, "scrollDown", NOW, "de").model.screen).toBe("cockpit");
    expect(decide(opened, "doubleClick", NOW, "de").model.screen).toBe("root");
    expect(decide(opened, "doubleClick", NOW, "de").effect).toBeUndefined();
    expect(decide(opened, "click", NOW, "de").model.screen).toBe("agent");
    expect(decide(m, "doubleClick", NOW, "de").effect).toEqual({ kind: "exit" });
  });
});

describe("tile diff", () => {
  const frameOf = (m: HubModel, now = NOW): Frame => composeCockpit(cockpitModel(m, "de", now), backend, now);
  const tileKeys = (frame: Frame): string[] => tiles(frame).map(frameKey);
  const changed = (a: string[], b: string[]): number[] => a.map((key, index) => (key === b[index] ? -1 : index)).filter((index) => index >= 0);
  const LEFT = [0, 2];

  it("an unchanged state draws the same frame, tile for tile", () => {
    expect(tileKeys(frameOf(modelOf(working())))).toEqual(tileKeys(frameOf(modelOf(working()))));
    expect(modelKey(cockpitModel(modelOf(working()), "de", NOW))).toBe(modelKey(cockpitModel(modelOf(working()), "de", NOW)));
  });

  it("the mascot animation step changes only the left tiles", () => {
    const m = modelOf(working());
    const base = Math.floor(NOW / 500) * 500;
    const diff = changed(tileKeys(frameOf(m, base)), tileKeys(frameOf(m, base + 500)));
    expect(diff.length).toBeGreaterThan(0);
    expect(diff.every((index) => LEFT.includes(index))).toBe(true);
    expect(MASCOT.x + 18 * MASCOT.scale).toBeLessThanOrEqual(288);
  });

  it("the idle blink changes only the left tiles too", () => {
    const m = idle();
    const base = Math.floor(NOW / 5000) * 5000;
    const diff = changed(tileKeys(frameOf(m, base)), tileKeys(frameOf(m, base + 500)));
    expect(diff.length).toBeGreaterThan(0);
    expect(diff.every((index) => LEFT.includes(index))).toBe(true);
  });

  it("the clock alone changes only the top right tile", () => {
    const m = idle();
    // Both times in the same animation step (no mascot change), one minute apart.
    const base = Math.floor(NOW / 60_000) * 60_000;
    const diff = changed(tileKeys(frameOf(m, base + 100)), tileKeys(frameOf(m, base + 60_000 + 100)));
    expect(diff).toEqual([1]);
  });

  it("the sender sends all four tiles once, nothing for an identical frame, then only what changed", async () => {
    const sent: string[] = [];
    const sender = createTileSender(tileSlots(21, "t"), async (slot) => { sent.push(slot.name); return true; }, () => new Uint8Array(1));
    const m = modelOf(working());
    const base = Math.floor(NOW / 500) * 500;
    await sender.push(frameOf(m, base));
    expect(sent).toEqual(["t-nw", "t-ne", "t-sw", "t-se"]);
    await sender.push(frameOf(m, base));
    expect(sent).toHaveLength(4);
    await sender.push(frameOf(m, base + 500));
    const step = sent.slice(4);
    expect(step.length).toBeGreaterThan(0);
    expect(step.every((name) => name === "t-nw" || name === "t-sw")).toBe(true);
    const total = sent.length;
    // A rebuilt page starts blank: everything goes out again.
    sender.reset();
    await sender.push(frameOf(m, base + 500));
    expect(sent.length - total).toBe(4);
  });

  it("no tile is written while the exit dialog may be up", async () => {
    const calls: string[] = [];
    const bridge = { updateImageRawData: async () => { calls.push("sent"); return ImageRawDataUpdateResult.success; } };
    let asked = false;
    const send = guardedTileSend(bridge as never, () => !asked);
    const slot = tileSlots(21, "t")[0];
    expect(await send(slot, new Uint8Array(1))).toBe(true);
    asked = true;
    expect(await send(slot, new Uint8Array(1))).toBe(false);
    expect(calls).toEqual(["sent"]);
  });
});
