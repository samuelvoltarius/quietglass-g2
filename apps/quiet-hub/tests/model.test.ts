import { describe, expect, it } from "vitest";
import { buildView, createModel, decide, CONFIRM_MS, type HubModel } from "../src/hub/model";
import { demoReport } from "../src/api/demo";
import type { HubReport } from "../src/api/types";
import { ROW_WIDTH, MAX_BODY_ROWS } from "../src/glasses/screen";

const T0 = 1_000_000;

function model(report: HubReport = demoReport()): HubModel {
  return { ...createModel(report), screen: "agent", agentView: "ask" };
}

describe("decide", () => {
  it("swiping changes the selection and cancels a pending confirm", () => {
    const home = { ...model(), screen: "home" as const };
    const armed = decide(home, "click", T0).model;
    const next = decide(armed, "scrollDown", T0 + 100);
    expect(next.model.screen).toBe("home");
    expect(next.model.report.home.selected).toBe(1);
    expect(next.model.confirm).toBeNull();
  });

  it("uses the root as a selectable menu", () => {
    const root = createModel(demoReport());
    const selectedHome = decide(root, "scrollDown", T0).model;
    expect(selectedHome.rootSelected).toBe(1);
    expect(decide(selectedHome, "click", T0).model.screen).toBe("home");
    expect(decide(root, "scrollUp", T0).model.rootSelected).toBe(3);
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
    const plain: HubReport = { ...demoReport(), agents: demoReport().agents.map((a) => ({ ...a, suggestions: [] })) };
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

  it("switching a device needs a second double tap within the window", () => {
    const onHome = { ...model(), screen: "home" as const };
    const armed = decide(onHome, "click", T0);
    expect(armed.effect).toBeUndefined();
    expect(armed.model.confirm?.what).toBe("light_office");

    const fired = decide(armed.model, "click", T0 + CONFIRM_MS - 1);
    expect(fired.effect).toEqual({ kind: "toggle", device: "light_office" });
  });

  it("an expired confirm arms again instead of firing", () => {
    const onHome = { ...model(), screen: "home" as const };
    const armed = decide(onHome, "click", T0).model;
    const reArmed = decide(armed, "click", T0 + CONFIRM_MS + 1);
    expect(reArmed.effect).toBeUndefined();
    expect(reArmed.model.confirm).not.toBeNull();
  });

  it("a read-only device can never be armed", () => {
    const report = demoReport();
    const readOnly = {
      ...report,
      home: {
        ...report.home,
        selected: 0,
        devices: [{ ...report.home.devices[0]!, writable: false }],
      },
    };
    const onHome = { ...model(readOnly), screen: "home" as const };
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
    expect(outcome.effect).toBeUndefined();
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
    const armed = decide({ ...model(), screen: "home" as const }, "click", T0).model;
    const view = buildView(armed, "de", T0 + 1000);
    expect(view.footer).toContain("Nochmals tippen");
    expect(view.footer).toContain("(3s)");
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
    expect(view.body.some((row) => row.includes("Abbrechen"))).toBe(true);
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
