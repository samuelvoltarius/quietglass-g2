import { beforeEach, describe, expect, it } from "vitest";
import { buildView, createModel, decide, withSessions, type Effect, type HubModel, type Screen } from "../src/hub/model";
import { demoReport } from "../src/api/demo";
import type { AgentInfo, HubReport, SessionInfo } from "../src/api/types";
import { gestureFromEvent, resetGestureDedupe } from "../src/input/gestures";
import { MAX_BODY_ROWS, ROW_WIDTH } from "../src/glasses/screen";

const T0 = 9_000_000;
const sessions: SessionInfo[] = [
  { id: "s-1", title: "Erste Sitzung", when: "10m", current: true },
  { id: "s-2", title: "Zweite mit einem wirklich sehr langen Titel der nicht passt", when: "3d", current: false },
];

function onAgents(report: HubReport = demoReport()): HubModel {
  return { ...createModel(report), screen: "agent", agentView: "list" };
}

/** list -> sessions page with a loaded session list. */
function onSessions(agentIndex = 0): HubModel {
  let model = onAgents();
  for (let i = 0; i < agentIndex; i += 1) model = decide(model, "scrollDown", T0).model;
  const opened = decide(model, "click", T0);
  expect(opened.effect).toMatchObject({ kind: "loadSessions" });
  return withSessions(opened.model, opened.effect!.kind === "loadSessions" ? opened.effect.agentId : "", { status: "ready", items: sessions, transport: "bridge" });
}

describe("session page", () => {
  it("shows new, continue and the listed sessions, selected row starts on continue", () => {
    const model = onSessions();
    expect(model.sessionIndex).toBe(1);
    const rows = buildView(model, "de", T0).body;
    expect(rows[0]).toContain("hermes-spark");
    expect(rows[0]).toContain("bridge");
    expect(rows.join("\n")).toContain("+ Neue Sitzung");
    expect(rows.join("\n")).toContain("Erste Sitzung · 10m");
    expect(rows[2]).toMatch(/^> /); // "continue" is preselected
  });

  it("tap on a listed session selects it and opens the question view", () => {
    let model = onSessions();
    model = decide(decide(model, "scrollDown", T0).model, "scrollDown", T0).model; // row 3 = second listed session
    const out = decide(model, "click", T0);
    expect(out.effect).toEqual({ kind: "selectSession", agentId: "hermes-spark", sessionId: "s-2", title: sessions[1]!.title });
    expect(out.model.agentView).toBe("ask");
    expect(out.model.report.agents[0]?.session).toEqual({ id: "s-2", title: sessions[1]!.title });
  });

  it("'Neue Sitzung' creates one and clears the old answer", () => {
    const model = decide(onSessions(), "scrollUp", T0).model; // row 0
    const out = decide(model, "click", T0);
    expect(out.effect).toEqual({ kind: "newSession", agentId: "hermes-spark" });
    expect(out.model.agentView).toBe("ask");
    expect(out.model.report.agents[0]).toMatchObject({ answer: null, session: { id: null, title: "" }, stopped: false });
    expect(buildView(out.model, "de", T0).body[0]).toContain("Neue Sitzung");
  });

  it("'Weiter' just opens the current session without any request", () => {
    const out = decide(onSessions(), "click", T0);
    expect(out.effect).toBeUndefined();
    expect(out.model.agentView).toBe("ask");
  });

  it("a running agent cannot be switched to another session (only the running one opens)", () => {
    const model = onSessions();
    const busy = { ...model, report: { ...model.report, agents: model.report.agents.map((a, i) => (i === 0 ? { ...a, busy: true, session: { id: "s-1", title: "Erste Sitzung" } } : a)) } };
    const toNew = decide(decide(busy, "scrollUp", T0).model, "click", T0);
    expect(toNew.effect).toBeUndefined();
    expect(toNew.model.agentView).toBe("sessions");
    expect(toNew.model.message?.text).toBe("denkt nach …");
    const sameOne = decide(decide(decide(busy, "scrollDown", T0).model, "click", T0).model, "scrollUp", T0);
    expect(sameOne.model.agentView).toBe("ask");
  });

  it("a failed or unsupported list still lets the wearer continue or start fresh", () => {
    const base = decide(onAgents(), "click", T0);
    const failed = withSessions(base.model, "hermes-spark", { status: "error", items: [], transport: "" });
    expect(buildView(failed, "de", T0).body.join("\n")).toContain("Sitzungen nicht ladbar");
    expect(decide(failed, "click", T0).model.agentView).toBe("ask");
    const unsupported = withSessions(base.model, "hermes-spark", { status: "unsupported", items: [], transport: "http" });
    expect(buildView(unsupported, "en", T0).body.join("\n")).toContain("No session list");
  });

  it("an answer for another agent's list is ignored", () => {
    const model = onSessions();
    expect(withSessions(model, "claude-win", { status: "ready", items: [], transport: "cli" })).toBe(model);
  });

  it("with a single agent the overview opens its session page directly", () => {
    const one: HubReport = { ...demoReport(), agents: [demoReport().agents[0]!] };
    const root = createModel(one);
    const out = decide({ ...root, rootSelected: 0 }, "click", T0);
    expect(out.model.screen).toBe("agent");
    expect(out.model.agentView).toBe("sessions");
    expect(out.effect).toEqual({ kind: "loadSessions", agentId: "hermes-spark" });
    // ...and one double tap less than before is needed to leave: sessions -> overview
    expect(decide(out.model, "doubleClick", T0).model.screen).toBe("root");
  });
});

describe("stop", () => {
  it("shows 'gestoppt' on the agent list too and clears it with the next question", () => {
    const base = onSessions();
    const ask = decide(base, "click", T0).model;
    const stopped = { ...ask, report: { ...ask.report, agents: ask.report.agents.map((a, i) => (i === 0 ? { ...a, stopped: true, answer: "halb fer" } : a)) } };
    const text = buildView(stopped, "de", T0).body.join("\n");
    expect(text).toContain("[gestoppt]");
    expect(text).toContain("halb fer");
    expect(buildView({ ...stopped, agentView: "list" }, "de", T0).body[0]).toContain("[gestoppt]");
    const next = decide(stopped, "click", T0);
    expect(next.effect).toMatchObject({ kind: "ask" });
  });
});

describe("no page traps the wearer", () => {
  const SCREENS: Screen[] = ["root", "agent", "home", "printer", "inbox"];
  const VIEWS = ["list", "sessions", "ask"] as const;

  /** Applies double taps (and the daemon's reaction to a stop) until the exit effect fires. */
  function stepsToExit(start: HubModel): number {
    let model = start;
    for (let step = 1; step <= 8; step += 1) {
      const out = decide(model, "doubleClick", T0 + step * 1000);
      if (out.effect?.kind === "exit") return step;
      model = out.model;
      const effect: Effect | undefined = out.effect;
      if (effect?.kind === "cancel") {
        model = { ...model, report: { ...model.report, agents: model.report.agents.map((a) => (a.id === effect.agentId ? { ...a, busy: false } : a)) } };
      }
      if (effect?.kind === "approve") {
        model = { ...model, report: { ...model.report, approvals: [] } };
      }
    }
    return -1;
  }

  for (const screen of SCREENS) {
    for (const view of VIEWS) {
      for (const busy of [false, true]) {
        for (const card of [false, true]) {
          it(`${screen}/${view}${busy ? "/busy" : ""}${card ? "/permission-card" : ""}: repeated double tap always reaches the exit dialog`, () => {
            const report = demoReport();
            const prepared: HubReport = {
              ...report,
              agents: report.agents.map((a, i) => (i === 0 ? { ...a, busy } : a)),
              approvals: card ? [{ id: "c", agentId: "claude-win", title: "Bash: ls", detail: null, createdAt: "", expiresAt: T0 + 9e6 }] : [],
            };
            const model = { ...createModel(prepared), screen, agentView: view, sessions: { agentId: "hermes-spark", status: "ready" as const, items: sessions, transport: "bridge" } };
            const steps = stepsToExit(model);
            expect(steps).toBeGreaterThan(0);
            expect(steps).toBeLessThanOrEqual(6);
          });
        }
      }
    }
  }

  it("a lost 'release' event cannot lock the page: double tap discards the recording and back works", () => {
    const ask = { ...createModel(demoReport()), screen: "agent" as const, agentView: "ask" as const };
    const recording = decide(ask, "longPress", T0).model;
    expect(recording.recording).toBe(true);
    const discarded = decide(recording, "doubleClick", T0 + 100).model;
    expect(discarded.recording).toBe(false);
    expect(stepsToExit(discarded)).toBeGreaterThan(0);
  });

  it("a stuck confirm countdown does not block going back", () => {
    const home = { ...createModel(demoReport()), screen: "home" as const };
    const armed = decide(home, "click", T0).model;
    expect(armed.confirm).not.toBeNull();
    expect(decide(armed, "doubleClick", T0 + 10).model.screen).toBe("root");
  });
});

describe("footer hint on every page", () => {
  const cases: Array<[string, HubModel]> = [
    ["root", createModel(demoReport())],
    ["agents", onAgents()],
    ["sessions", onSessions()],
    ["ask", { ...createModel(demoReport()), screen: "agent", agentView: "ask" }],
    ["home", { ...createModel(demoReport()), screen: "home" }],
    ["printer", { ...createModel(demoReport()), screen: "printer" }],
    ["inbox", { ...createModel(demoReport()), screen: "inbox" }],
  ];
  for (const [name, model] of cases) {
    for (const locale of ["de", "en"] as const) {
      it(`${name} (${locale}) tells how to go back, within 46 characters`, () => {
        const view = buildView(model, locale, T0);
        expect(view.footer).toMatch(/2× = /);
        expect(view.footer.length).toBeLessThanOrEqual(ROW_WIDTH);
        expect(view.body.length).toBeLessThanOrEqual(MAX_BODY_ROWS);
        for (const row of view.body) expect(row.length).toBeLessThanOrEqual(ROW_WIDTH);
      });
    }
  }

  it("a running agent says 2× = stop, a card says 2× = deny, the root says 2× = exit", () => {
    const ask = { ...createModel(demoReport()), screen: "agent" as const, agentView: "ask" as const };
    const busy = { ...ask, report: { ...ask.report, agents: ask.report.agents.map((a, i) => (i === 0 ? { ...a, busy: true } : a)) } };
    expect(buildView(busy, "de", T0).footer).toBe("läuft … · 2× = stoppen");
    expect(buildView(busy, "en", T0).footer).toBe("running … · 2× = stop");
    expect(buildView(createModel(demoReport()), "en", T0).footer).toContain("exit");
  });

  it("worst-case content stays inside 7 x 46 on the session and question pages", () => {
    const long = "x".repeat(300);
    const agent: AgentInfo = { ...demoReport().agents[0]!, label: long, answer: long, lastQuestion: long, stopped: true, transport: long, session: { id: "s", title: long } };
    const report: HubReport = { ...demoReport(), agents: [agent] };
    const many: SessionInfo[] = Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, title: long, when: "10m", current: i === 0 }));
    for (const view of ["sessions", "ask"] as const) {
      const model = { ...createModel(report), screen: "agent" as const, agentView: view, sessions: { agentId: agent.id, status: "ready" as const, items: many, transport: long } };
      for (const locale of ["de", "en"] as const) {
        const out = buildView(model, locale, T0);
        expect(out.body.length).toBeLessThanOrEqual(MAX_BODY_ROWS);
        for (const row of out.body) expect(row.length).toBeLessThanOrEqual(ROW_WIDTH);
        expect(out.footer.length).toBeLessThanOrEqual(ROW_WIDTH);
      }
    }
  });
});

describe("real G2 event shapes", () => {
  beforeEach(() => resetGestureDedupe());

  it("double tap = sysEvent eventType 3", () => {
    expect(gestureFromEvent({ sysEvent: { eventType: 3, eventSource: 1 } })?.gesture).toBe("doubleClick");
  });

  it("a missing eventType is a tap (proto3 omits CLICK = 0)", () => {
    expect(gestureFromEvent({ sysEvent: { eventSource: 1 } })?.gesture).toBe("click");
    expect(gestureFromEvent({ textEvent: { containerID: 2 } })?.gesture).toBe("click");
  });

  it("a double tap that arrives next to an empty textEvent is still a double tap", () => {
    expect(gestureFromEvent({ textEvent: { containerID: 2, containerName: "body" }, sysEvent: { eventType: 3, eventSource: 1 } })?.gesture).toBe("doubleClick");
  });

  it("long press starts (9) and release ends (10) the recording", () => {
    expect(gestureFromEvent({ sysEvent: { eventType: 9, eventSource: 1 } })?.gesture).toBe("longPress");
    resetGestureDedupe();
    expect(gestureFromEvent({ sysEvent: { eventType: 10, eventSource: 1 } })?.gesture).toBe("longPressRelease");
  });

  it("swipes may arrive inverted on hardware: the phone setting flips them", () => {
    expect(gestureFromEvent({ sysEvent: { eventType: 1 } })?.gesture).toBe("scrollUp");
    resetGestureDedupe();
    expect(gestureFromEvent({ sysEvent: { eventType: 1 } }, { invertScroll: true })?.gesture).toBe("scrollDown");
    resetGestureDedupe();
    expect(gestureFromEvent({ sysEvent: { eventType: 2 } }, { invertScroll: true })?.gesture).toBe("scrollUp");
  });

  it("lifecycle codes (4-8) are not gestures", () => {
    for (const code of [4, 5, 6, 7, 8]) {
      resetGestureDedupe();
      expect(gestureFromEvent({ sysEvent: { eventType: code } })).toBeNull();
    }
  });
});
