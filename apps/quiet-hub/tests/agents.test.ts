import { describe, expect, it } from "vitest";
import { buildView, createModel, decide, mergeReport, type HubModel } from "../src/hub/model";
import { demoReport } from "../src/api/demo";
import type { Approval, HubReport } from "../src/api/types";
import { MAX_BODY_ROWS, ROW_WIDTH } from "../src/glasses/screen";

const T0 = 5_000_000;
const card: Approval = { id: "c1", agentId: "claude-win", title: "Bash: npm test --workspaces --if-present", detail: null, createdAt: "", expiresAt: T0 + 120_000 };

function onAgents(report: HubReport = demoReport()): HubModel {
  return { ...createModel(report), screen: "agent", agentView: "list" };
}

describe("agent list", () => {
  it("swipe selects an agent, tap opens its questions", () => {
    const down = decide(onAgents(), "scrollDown", T0).model;
    expect(down.agentIndex).toBe(1);
    const opened = decide(down, "click", T0).model;
    expect(opened.agentView).toBe("ask");
    expect(opened.questionIndex).toBe(0);
  });

  it("an offline agent cannot be opened and says so", () => {
    let model = onAgents();
    model = decide(decide(model, "scrollDown", T0).model, "scrollDown", T0).model;
    expect(model.report.agents[model.agentIndex]?.online).toBe(false);
    const out = decide(model, "click", T0);
    expect(out.model.agentView).toBe("list");
    expect(out.model.message?.text).toBe("Agent ist offline");
  });

  it("marks online and offline agents with different dots", () => {
    const rows = buildView(onAgents(), "de", T0).body;
    expect(rows[0]).toContain("●");
    expect(rows[2]).toContain("○");
    expect(rows[2]).toContain("offline");
  });

  it("hold speaks to the selected agent and release sends it there", () => {
    const model = decide(onAgents(), "scrollDown", T0).model;
    const start = decide(model, "longPress", T0);
    expect(start.effect).toEqual({ kind: "recordStart" });
    expect(start.model.recordAgent).toBe("claude-win");
    const stop = decide(start.model, "longPressRelease", T0 + 800);
    expect(stop.effect).toEqual({ kind: "recordStop", agentId: "claude-win" });
  });

  it("does not record for an offline agent", () => {
    let model = onAgents();
    model = decide(decide(model, "scrollDown", T0).model, "scrollDown", T0).model;
    const out = decide(model, "longPress", T0);
    expect(out.effect).toBeUndefined();
    expect(out.model.recording).toBe(false);
  });

  it("double tap in the question view steps back to the list, then to the overview", () => {
    const ask = decide(onAgents(), "click", T0).model;
    const list = decide(ask, "doubleClick", T0).model;
    expect(list.agentView).toBe("list");
    expect(decide(list, "doubleClick", T0).model.screen).toBe("root");
  });

  it("a busy agent is stopped with double tap instead of leaving the page", () => {
    const ask = decide(onAgents(), "click", T0).model;
    const busy = { ...ask, report: { ...ask.report, agents: ask.report.agents.map((a, i) => (i === 0 ? { ...a, busy: true } : a)) } };
    expect(decide(busy, "doubleClick", T0).effect).toEqual({ kind: "cancel", agentId: "hermes-spark" });
    expect(decide(busy, "click", T0).effect).toBeUndefined();
  });

  it("asking targets the selected agent", () => {
    const ask = decide(decide(onAgents(), "scrollDown", T0).model, "click", T0).model;
    const out = decide(ask, "click", T0);
    expect(out.effect).toMatchObject({ kind: "ask", agentId: "claude-win" });
  });
});

describe("approval cards", () => {
  const withCard = (): HubModel => onAgents({ ...demoReport(), approvals: [card] });

  it("tap allows, double tap denies", () => {
    expect(decide(withCard(), "click", T0).effect).toEqual({ kind: "approve", cardId: "c1", decision: "allow" });
    expect(decide(withCard(), "doubleClick", T0).effect).toEqual({ kind: "approve", cardId: "c1", decision: "deny" });
  });

  it("nothing else can happen while a card waits", () => {
    for (const gesture of ["scrollDown", "scrollUp", "longPress"] as const) {
      const out = decide(withCard(), gesture, T0);
      expect(out.effect).toBeUndefined();
      expect(out.model.recording).toBe(false);
    }
  });

  it("renders tool, command and the agent id within the display", () => {
    for (const locale of ["de", "en"] as const) {
      const view = buildView(withCard(), locale, T0);
      expect(view.body.join("\n")).toContain("npm test");
      expect(view.body[0]).toContain("claude-win");
      expect(view.footer.length).toBeLessThanOrEqual(ROW_WIDTH);
      for (const row of view.body) expect(row.length).toBeLessThanOrEqual(ROW_WIDTH);
    }
  });

  it("shows the pending count on the overview", () => {
    const root = { ...withCard(), screen: "root" as const };
    expect(buildView(root, "de", T0).body[0]).toContain("1 Freigabe");
  });
});

describe("report merge", () => {
  it("keeps the wearer's selections across polls", () => {
    let model = decide(onAgents(), "scrollDown", T0).model;
    model = { ...model, report: { ...model.report, home: { ...model.report.home, selected: 2 } } };
    const merged = mergeReport(model, demoReport());
    expect(merged.agentIndex).toBe(1);
    expect(merged.report.home.selected).toBe(2);
  });

  it("an old daemon without agents[] still gives one usable agent", () => {
    const { agents: _agents, approvals: _approvals, ...legacy } = demoReport();
    const model = createModel(legacy as unknown as HubReport);
    expect(model.report.agents).toHaveLength(1);
    expect(model.report.approvals).toEqual([]);
  });
});

describe("layout limits", () => {
  it("every agent view fits 7 rows x 46 characters, worst case", () => {
    const long = "x".repeat(400);
    const crowded: HubReport = {
      ...demoReport(),
      agents: Array.from({ length: 12 }, (_, i) => ({ ...demoReport().agents[0]!, id: `agent-with-a-very-long-name-${i}`, label: `agent-with-a-very-long-name-number-${i}`, answer: long, busy: i % 2 === 0, activity: long })),
    };
    for (const view of ["list", "ask"] as const) {
      const out = buildView({ ...createModel(crowded), screen: "agent", agentView: view }, "en", T0);
      expect(out.body.length).toBeLessThanOrEqual(MAX_BODY_ROWS);
      for (const row of out.body) expect(row.length).toBeLessThanOrEqual(ROW_WIDTH);
      expect(out.footer.length).toBeLessThanOrEqual(ROW_WIDTH);
    }
  });
});
