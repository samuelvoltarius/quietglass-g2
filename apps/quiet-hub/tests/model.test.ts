import { describe, expect, it } from "vitest";
import { buildView, createModel, decide, withHomePending, type HubModel } from "../src/hub/model";
import { initialZuhause } from "../src/hub/zuhause";
import { demoReport } from "../src/api/demo";
import type { HubReport } from "../src/api/types";
import { ROW_WIDTH, MAX_BODY_ROWS } from "../src/glasses/screen";

const T0 = 1_000_000;

function model(report: HubReport = demoReport()): HubModel {
  return { ...createModel(report), screen: "agent", agentView: "ask" };
}

describe("decide", () => {
  it("swiping changes the selection and cancels a pending confirm", () => {
    const home = { ...model(), screen: "home" as const, zh: { ...initialZuhause(), index: 2 } };
    const armed = withHomePending(home, "lock.haustuer", { token: "t1", label: "Haustür: aufsperren", expiresInMs: 30_000 }, T0);
    const next = decide(armed, "scrollDown", T0 + 100);
    expect(next.model.screen).toBe("home");
    expect(next.model.zh?.index).toBe(3);
    expect(next.model.zh?.pending).toBeNull();
    expect(next.model.confirm).toBeNull();
  });

  it("uses the root as a selectable menu", () => {
    // Demo: one unread alert as a warning row on top, then the six areas.
    const root = createModel(demoReport());
    expect(decide(root, "click", T0).model.screen).toBe("inbox");
    const agents = decide(root, "scrollDown", T0).model;
    expect(agents.rootKey).toBe("area:agent");
    expect(decide(agents, "click", T0).model.screen).toBe("agent");
    const home = decide(agents, "scrollDown", T0).model;
    expect(decide(home, "click", T0).model.screen).toBe("home");
    const last = decide(root, "scrollUp", T0).model;
    expect(last.rootKey).toBe("area:brief"); // wraps to the last row (Tag)
    expect(decide(last, "click", T0).model.screen).toBe("brief");
  });

  it("uses the native Even exit dialog action on the root-page double tap", () => {
    const root = createModel(demoReport());
    expect(decide(root, "doubleClick", T0).effect).toEqual({ kind: "exit" });
  });

  it("swipe selects the next question without activating anything", () => {
    const next = decide(model(), "scrollDown", T0);
    expect(next.model.questionIndex).toBe(1);
    expect(next.effect).toBeUndefined();
    expect(next.model.confirm).toBeNull();
  });

  it("wrap-around selection works on an empty list without throwing", () => {
    const empty: HubReport = {
      ...demoReport(),
      agent: { provider: "Hermes", questions: [], selected: 0, answer: null, busy: false, suggestions: [] },
      agents: demoReport().agents.map((a) => ({ ...a, suggestions: [] })),
    };
    const next = decide(model(empty), "scrollDown", T0);
    expect(next.model.questionIndex).toBe(0);
    expect(next.effect).toBeUndefined();
  });

  it("asking the agent is immediate — the agent is not an outward action", () => {
    // Without suggestions the saved questions are what gets asked.
    const plain: HubReport = { ...demoReport(), agents: demoReport().agents.map((a) => ({ ...a, suggestions: [], answer: null, lastQuestion: null })) };
    const outcome = decide(model(plain), "click", T0);
    expect(outcome.effect).toEqual({ kind: "ask", agentId: "hermes-spark", question: "Drucker fertig?" });
    expect(outcome.model.report.agents[0]?.busy).toBe(true);
    expect(outcome.model.report.agents[0]?.answer).toBeNull();
  });

  it("follow-up suggestions replace the questions as the tappable list", () => {
    expect(demoReport().agents[0]?.suggestions.length).toBeGreaterThan(0);
    const outcome = decide(model(), "click", T0);
    expect(outcome.effect).toEqual({ kind: "ask", agentId: "hermes-spark", question: "Mehr Details" });
  });

  it("a tap on a light opens its choices on 'Aus'; the next tap switches it and shows the new state at once", () => {
    const onHome = { ...model(), screen: "home" as const, zh: { ...initialZuhause(), index: 1 } };
    const opened = decide(onHome, "click", T0);
    expect(opened.effect).toBeUndefined();
    expect(opened.model.zh).toMatchObject({ level: "detail", detailId: "light.buero", choice: 0 });
    const fired = decide(opened.model, "click", T0 + 100);
    expect(fired.effect).toEqual({ kind: "homeAction", target: "light.buero", action: "brightness", value: 0 });
    expect(fired.model.report.homeView?.entities["light.buero"]?.on).toBe(false);
  });

  it("an expired lock confirm asks the daemon again instead of firing", () => {
    const onHome = { ...model(), screen: "home" as const, zh: { ...initialZuhause(), index: 2 } };
    const armed = withHomePending(onHome, "lock.haustuer", { token: "t1", label: "Haustür: aufsperren", expiresInMs: 30_000 }, T0);
    expect(decide(armed, "click", T0 + 100).effect).toEqual({ kind: "homeConfirm", token: "t1" });
    const late = decide(armed, "click", T0 + 10_001);
    expect(late.effect).toEqual({ kind: "homeAction", target: "lock.haustuer", action: "toggle" });
  });

  it("a read-only sensor can never be switched", () => {
    const onHome = { ...model(), screen: "home" as const, zh: { ...initialZuhause(), index: 3 } };
    const outcome = decide(onHome, "click", T0);
    expect(outcome.effect).toBeUndefined();
    expect(outcome.model.confirm).toBeNull();
  });

  it("the printer action follows the job state and confirms the same way", () => {
    const onPrinter = { ...model(), screen: "printer" as const };
    const armed = decide(onPrinter, "click", T0);
    expect(armed.effect).toBeUndefined();
    expect(armed.model.confirm?.what).toBe("printer:pause");
    expect(decide(armed.model, "click", T0 + 100).effect).toEqual({ kind: "printer", action: "pause" });
  });

  it("long press reports a refresh and never acts outside the agent page", () => {
    const onHome = { ...model(), screen: "home" as const };
    const outcome = decide(onHome, "longPress", T0);
    expect(outcome.effect).toEqual({ kind: "refresh" });
    expect(outcome.model.message?.text).toBe("aktualisiert");
  });
});

describe("buildView", () => {
  it("keeps every row inside the display width in both languages", () => {
    for (const locale of ["de", "en"] as const) {
      for (const screen of ["root", "agent", "home", "printer", "inbox"] as const) {
        const view = buildView({ ...model(), screen }, locale, T0);
        expect(view.header.length).toBeLessThanOrEqual(ROW_WIDTH);
        expect(view.footer.length).toBeLessThanOrEqual(ROW_WIDTH);
        for (const row of view.body) expect(row.length).toBeLessThanOrEqual(ROW_WIDTH);
      }
    }
  });

  it("never draws more rows than the body holds", () => {
    const view = buildView(model(), "de", T0);
    expect(view.body.length).toBeLessThanOrEqual(MAX_BODY_ROWS);
  });

  it("shows the confirm line with a countdown while armed", () => {
    const armed = withHomePending({ ...model(), screen: "home" as const, zh: { ...initialZuhause(), index: 2 } }, "lock.haustuer", { token: "t", label: "Haustür: aufsperren", expiresInMs: 4000 }, T0);
    const view = buildView(armed, "de", T0 + 1000);
    expect(view.footer).toContain("Nochmal tippen = Haustür");
    expect(view.footer).toContain("2× = abbrechen");
    expect(view.footer.length).toBeLessThanOrEqual(ROW_WIDTH);
  });

  it("prints the job name, percent and layers on the printer page", () => {
    const onPrinter = { ...model(), screen: "printer" as const };
    const view = buildView(onPrinter, "de", T0);
    const text = view.body.join("\n");
    expect(text).toContain("esp32_gehaeuse.stl");
    expect(text).toContain("72 %");
    expect(text).toContain("148 / 205");
    expect(view.body.some((row) => row.includes("Pause"))).toBe(true);
    expect(view.body.some((row) => row.includes("Druck abbrechen"))).toBe(true);
  });

  it("shows the streaming answer of the selected agent", () => {
    const view = buildView(model(), "de", T0);
    expect(view.body.join("\n")).toContain("41 Minuten");
  });

  it("marks the selected unread completion from the inbox", () => {
    const inbox = { ...model(), screen: "inbox" as const };
    const outcome = decide(inbox, "click", T0);
    expect(outcome.effect).toEqual({ kind: "readEvent", id: "demo-codex-1" });
  });
});

describe("suggestions after an answer", () => {
  it("never falls back to the saved starters once there is an answer; shows that vLLM is still writing", () => {
    const base = demoReport();
    const waiting: HubReport = { ...base, agents: base.agents.map((a, i) => (i === 0 ? { ...a, suggestions: [], suggesting: true } : a)) };
    const m = { ...model(waiting), screen: "agent" as const, agentView: "ask" as const };
    expect(decide(m, "click", T0).effect).toBeUndefined();
    expect(buildView(m, "de", T0).body.join(" ")).toContain("Vorschläge kommen");
    const none: HubReport = { ...base, agents: base.agents.map((a, i) => (i === 0 ? { ...a, suggestions: [], suggesting: false } : a)) };
    expect(buildView({ ...m, report: none }, "de", T0).body.join(" ")).toContain("Keine Vorschläge");
  });
});
