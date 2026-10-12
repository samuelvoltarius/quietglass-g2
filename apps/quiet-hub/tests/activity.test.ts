import { describe, expect, it } from "vitest";
import { describeActivity, elapsedShort, workingDots } from "../src/hub/activity";
import { workingLine } from "../src/hub/model";
import type { AgentInfo } from "../src/api/types";

describe("readable agent activity", () => {
  it("maps raw tool lines of Claude, Codex and Hermes to plain words", () => {
    expect(describeActivity("Bash: npm test", "de")).toMatchObject({ kind: "test", label: "Führt Tests aus", detail: "npm test" });
    expect(describeActivity("exec: git status", "de")).toMatchObject({ kind: "git", detail: "git status" });
    expect(describeActivity("Edit: src/a.ts", "en")).toMatchObject({ kind: "edit", label: "Editing a file" });
    expect(describeActivity("web_search Wetter Salzburg", "de")).toMatchObject({ kind: "web", label: "Sucht im Web", detail: "Wetter Salzburg" });
    expect(describeActivity("memory", "de").kind).toBe("memory");
    expect(describeActivity("", "de")).toMatchObject({ kind: "think", label: "Denkt nach" });
    expect(describeActivity("frobnicate x", "de")).toMatchObject({ label: "frobnicate", detail: "x" });
  });

  it("shows elapsed time and animated dots", () => {
    expect(elapsedShort(23_400)).toBe("23 s");
    expect(elapsedShort(65_000)).toBe("1:05");
    expect(elapsedShort(13 * 60_000)).toBe("13 min");
    expect(new Set([0, 700, 1400].map(workingDots)).size).toBe(3);
    const agent = { busy: true, busySince: 1_000, activity: "Bash: npm test" } as AgentInfo;
    expect(workingLine(agent, "de", 24_000)).toMatch(/^» Führt Tests aus\.{1,3} *· 23 s · npm test$/);
  });
});

describe("finished steps while there are no words yet", () => {
  it("lists earlier steps above the running one", async () => {
    const { buildView } = await import("../src/hub/model");
    const { demoReport } = await import("../src/api/demo");
    const base = demoReport();
    const report = { ...base, agents: base.agents.map((a, i) => (i === 0 ? { ...a, busy: true, answer: "", lastQuestion: "Zähl", activity: "terminal: wc -l", steps: ["terminal: find /etc", "terminal: wc -l"], suggestions: [] } : a)) };
    const { createModel } = await import("../src/hub/model");
    const m = { ...createModel(report), screen: "agent" as const, agentView: "ask" as const };
    const body = buildView(m, "de", 0).body;
    expect(body.some((r) => r.startsWith("· Führt Befehl aus · find /etc"))).toBe(true);
    expect(buildView(m, "de", 0).header.startsWith("Führt Befehl aus")).toBe(true);
  });
});

describe("alerts lead straight to the conversation", () => {
  it("shows only unread alerts, with the answer, and a tap opens the agent in that session", async () => {
    const { buildView, createModel, decide } = await import("../src/hub/model");
    const { demoReport } = await import("../src/api/demo");
    const base = demoReport();
    const agentId = base.agents[1]!.id;
    const events = [
      { id: "e1", provider: agentId, status: "done" as const, title: "Wie warm?", detail: "Es hat 20 Grad.", createdAt: "", read: false, agentId, sessionId: "S9" },
      { id: "e0", provider: agentId, status: "done" as const, title: "Alt", detail: "alt", createdAt: "", read: true, agentId, sessionId: "S1" },
    ];
    const report = { ...base, inbox: { events, selected: 0 } };
    const m = { ...createModel(report), screen: "inbox" as const };
    const body = buildView(m, "de", 0).body.join(" ");
    expect(body).toContain("Es hat 20 Grad.");
    expect(body).toContain("1/1");
    const out = decide(m, "click", 0);
    expect(out.model.screen).toBe("agent");
    expect(out.model.agentView).toBe("ask");
    expect(out.effect).toEqual({ kind: "openEvent", id: "e1", agentId, sessionId: "S9" });
  });
});
