import { describe, expect, it } from "vitest";
import { agentItems, applyMenu, buildView, cardChoices, createModel, decide, MENU, selectedAgent, type HubModel } from "../src/hub/model";
import { demoReport } from "../src/api/demo";
import type { AgentEvent, Approval, HubReport } from "../src/api/types";

const T0 = 1_700_000_000_000;

/** Two unread alerts of the second agent, from a session that is NOT the one it has open. */
function inboxModel(patch: (report: HubReport) => HubReport = (r) => r): HubModel {
  const base = demoReport();
  const agent = base.agents[1]!;
  const ev = (id: string, title: string, sessionId: string): AgentEvent => ({
    id, provider: agent.id, status: "done", title, detail: "Rechnung R-17 ist fertig.", createdAt: "", read: false, agentId: agent.id, sessionId,
  });
  const report: HubReport = {
    ...base,
    agents: base.agents.map((a, i) => (i === 1 ? { ...a, session: { id: "S-alt", title: "Alt" }, suggestions: ["Alter Vorschlag 1", "Alter Vorschlag 2"], answer: "alte Antwort", chat: [{ role: "assistant", text: "alte Antwort" }] } : a)),
    inbox: { selected: 0, events: [ev("e1", "Schreib die Rechnung", "S-neu"), ev("e2", "Und die Mahnung?", "S-neu2")] },
  };
  return { ...createModel(patch(report)), screen: "inbox" };
}

describe("getting out of an alert (0.6.5)", () => {
  it("alert -> session -> ONE double tap -> overview, cursor on Meldungen while unread are left", () => {
    const opened = decide(inboxModel(), "click", T0);
    expect(opened.model).toMatchObject({ screen: "agent", agentView: "ask", origin: "inbox" });
    // The alert left the list at once.
    expect(opened.model.report.inbox.events.find((e) => e.id === "e1")?.read).toBe(true);
    const back = decide(opened.model, "doubleClick", T0);
    expect(back.effect).toBeUndefined();
    expect(back.model.screen).toBe("root");
    expect(back.model.origin).toBeNull();
    expect(back.model.rootKey).toBe("warn:inbox");
    // A tap on the overview opens the inbox with the next unread alert: no loop back into the old session.
    const inbox = decide(back.model, "click", T0);
    expect(inbox.model.screen).toBe("inbox");
    expect(buildView(inbox.model, "de", T0).body.join(" ")).toContain("Und die Mahnung?");
  });

  it("the last alert read: back lands on the overview where the cursor was", () => {
    const one = inboxModel((r) => ({ ...r, inbox: { selected: 0, events: [r.inbox.events[0]!] } }));
    const back = decide(decide({ ...one, rootSelected: 1 }, "click", T0).model, "doubleClick", T0);
    expect(back.model.screen).toBe("root");
    expect(back.model.rootSelected).toBe(1);
  });

  it("a running agent opened from an alert: double tap goes back, it does NOT stop the agent", () => {
    const opened = decide(inboxModel(), "click", T0).model;
    const busy: HubModel = { ...opened, report: { ...opened.report, agents: opened.report.agents.map((a, i) => (i === 1 ? { ...a, busy: true } : a)) } };
    expect(buildView(busy, "de", T0).footer).toBe("Tippen = stoppen · 2× = zurück");
    const back = decide(busy, "doubleClick", T0);
    expect(back.effect).toBeUndefined();
    expect(back.model.screen).toBe("root");
    // Stop stays reachable through the menu - armed first, the next tap stops.
    const armed = applyMenu(busy, MENU.stop, T0);
    expect(armed.effect).toBeUndefined();
    expect(decide(armed.model, "click", T0 + 500).effect).toEqual({ kind: "cancel", agentId: busy.report.agents[1]!.id });
  });

  it("without an alert the session still climbs to the session list (unchanged)", () => {
    const ask: HubModel = { ...createModel(demoReport()), screen: "agent", agentView: "ask" };
    expect(decide(ask, "doubleClick", T0).model.agentView).toBe("sessions");
  });

  it("an alert of another session never shows the previous session's suggestions or chat", () => {
    const opened = decide(inboxModel(), "click", T0).model;
    const agent = selectedAgent(opened)!;
    expect(agentItems(agent, opened.report.agent.questions)).toEqual([]);
    const body = buildView(opened, "de", T0).body.join(" ");
    expect(body).not.toContain("Alter Vorschlag");
    expect(body).not.toContain("alte Antwort");
    expect(body).toContain("Vorschläge kommen");
  });

  it("leaving via the menu (Übersicht) also forgets where the session came from", () => {
    const opened = decide(inboxModel(), "click", T0).model;
    expect(applyMenu(opened, MENU.overview, T0).model).toMatchObject({ screen: "root", origin: null });
  });
});

describe("permission cards with the vLLM's own replies (0.6.5)", () => {
  const card: Approval = {
    id: "c1", agentId: "claude-win", tool: "Edit", title: "Edit: /srv/app/config.json", detail: "/srv/app/config.json", createdAt: "", expiresAt: T0 + 60_000,
    suggestions: ["Ja, nur lesen", "Erst Backup machen"],
    options: [{ text: "Ja, nur lesen", decision: "allow" }, { text: "Erst Backup machen", decision: "deny" }],
  };
  const withCard = (): HubModel => ({ ...createModel({ ...demoReport(), approvals: [card] }), screen: "agent" });

  it("shows Erlauben, Ablehnen and the replies as a list", () => {
    expect(cardChoices(card, "de").map((c) => c.label)).toEqual(["Erlauben", "Ablehnen", "Ja, nur lesen", "Erst Backup machen"]);
    const body = buildView(withCard(), "de", T0).body.join("\n");
    expect(body).toContain("/srv/app/config.json");
    expect(body).toContain("Erst Backup machen");
  });

  it("a reply that denies goes to the daemon with its text as note", () => {
    let m = withCard();
    for (let i = 0; i < 3; i++) m = decide(m, "scrollDown", T0).model;
    const armed = decide(m, "click", T0);
    expect(armed.effect).toBeUndefined();
    expect(decide(armed.model, "click", T0 + 500).effect).toEqual({ kind: "approve", cardId: "c1", decision: "deny", note: "Erst Backup machen" });
  });

  it("double tap leaves the card waiting and is back at the overview", () => {
    const out = decide(withCard(), "doubleClick", T0);
    expect(out.effect).toBeUndefined();
    expect(out.model.screen).toBe("root");
    expect(buildView(out.model, "de", T0 + 1).footer).toBe("Freigabe wartet weiter");
  });

  it("the menu picks the row and arms it; the next tap answers (QIS v1)", () => {
    const deny = applyMenu(withCard(), MENU.deny, T0);
    expect(deny.effect).toBeUndefined();
    expect(decide(deny.model, "click", T0 + 500).effect).toEqual({ kind: "approve", cardId: "c1", decision: "deny" });
    const allow = applyMenu(withCard(), MENU.allow, T0);
    expect(allow.effect).toBeUndefined();
    expect(decide(allow.model, "click", T0 + 500).effect).toEqual({ kind: "approve", cardId: "c1", decision: "allow" });
  });
});
