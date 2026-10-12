import { describe, expect, it } from "vitest";
import { HubNarrator, type SpeechEngine } from "../src/speech/narrator";
import type { AgentInfo, Approval } from "../src/api/types";

function engine(): SpeechEngine & { said: string[] } {
  const said: string[] = [];
  return { said, available: true, voices: () => [], speak: (r) => { said.push(r.text); r.onEnd(); }, cancel: () => undefined, pause: () => undefined, resume: () => undefined };
}
const agent = (patch: Partial<AgentInfo>): AgentInfo => ({
  id: "hermes-pi5", label: "hermes-pi5", kind: "hermes", machine: "pi5", online: true, busy: false, mode: "ask", activity: "", error: null,
  answer: null, lastQuestion: null, suggestions: [], ...patch,
} as AgentInfo);

describe("spoken answers", () => {
  it("is silent until enabled and activated by a tap", () => {
    const e = engine();
    let on = false;
    const n = new HubNarrator(e, () => on, () => "de");
    expect(n.status()).toBe("off");
    on = true;
    expect(n.status()).toBe("needs-activation");
    n.activate();
    expect(e.said).toEqual(["Vorlesen ist bereit."]);
  });

  it("speaks a new answer sentence by sentence, never an old one, and skips secrets", () => {
    const e = engine();
    const n = new HubNarrator(e, () => true, () => "de");
    n.observe(agent({ answer: "Alte Antwort.", lastQuestion: "alt" }), []);
    n.activate();
    e.said.length = 0;
    n.observe(agent({ busy: true, lastQuestion: "Wie geht's?", answer: "" }), []);
    n.observe(agent({ busy: true, lastQuestion: "Wie geht's?", answer: "Gut. Der Schlüssel ist API_KEY=abc123" }), []);
    expect(e.said).toEqual(["Gut."]);
    n.observe(agent({ busy: false, lastQuestion: "Wie geht's?", answer: "Gut. Der Schlüssel ist API_KEY=abc123" }), []);
    expect(e.said[1]).toContain("Einstellung ausgelassen");
    expect(e.said.join(" ")).not.toContain("abc123");
    expect(e.said.join(" ")).not.toContain("Alte Antwort");
  });

  it("announces a new permission card once", () => {
    const e = engine();
    const n = new HubNarrator(e, () => true, () => "de");
    const card = { id: "c1", agentId: "hermes-pi5", title: "Bash: ls", detail: null, tool: "Bash", createdAt: "", expiresAt: "", suggestions: [] } as unknown as Approval;
    n.observe(agent({}), []);
    n.activate();
    n.observe(agent({}), [card]);
    n.observe(agent({}), [card]);
    expect(e.said.filter((s) => s.includes("Freigabe"))).toEqual(["Freigabe nötig für Bash. Schau auf die Brille."]);
  });
});
