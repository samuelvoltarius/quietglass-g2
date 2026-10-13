import { afterEach, describe, expect, it } from "vitest";
import { startHub, until } from "./helpers.mjs";

const open = [];
afterEach(async () => { while (open.length) await open.pop()(); });

/** A mocked Spark vLLM; every other URL goes to the real test hub. */
function vllm(reply) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    if (String(url).includes("/chat/completions")) {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      const aborted = new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new Error("timeout"))));
      return Promise.race([Promise.resolve(reply(calls.length)), aborted]);
    }
    return fetch(url, init);
  };
  return { calls, fetchImpl };
}
const ok = (content) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });

async function hub(options) {
  const h = await startHub({ suggestions: true, vllmUrl: "http://spark.test:8000/v1", ...options });
  open.push(() => h.close());
  return h;
}

async function answered(h, kind) {
  const reg = await h.api("/relay/register", { machine: `m-${kind}`, agents: [{ id: `${kind}-x`, kind }] });
  await h.api("/agent/ask", { agentId: `${kind}-x`, question: "Wie spät ist es?", wait: false });
  const ask = (await h.api(`/relay/poll?relay=${reg.json.relayId}`)).json.commands[0];
  await h.api("/relay/result", { jobId: ask.jobId, status: "done", text: "Es ist 14 Uhr.", suggestions: ["vom Agenten gelogen"] });
  return `${kind}-x`;
}

describe("suggestions come from the Spark vLLM only", () => {
  for (const kind of ["hermes", "claude", "codex", "openclaw"]) {
    it(`${kind}: fast, non-thinking, short JSON prompt; options are trimmed to 32 characters`, async () => {
      const v = vllm(() => ok('["Mehr Details", "Kurzfassung", "x".repeat(40), "Und morgen?"]'.replace('"x".repeat(40)', `"${"x".repeat(40)}"`)));
      const h = await hub({ fetchImpl: v.fetchImpl });
      const id = await answered(h, kind);
      await until(async () => (await h.api("/agents")).json.agents.find((a) => a.id === id).suggestions.length > 0);
      const agent = (await h.api("/agents")).json.agents.find((a) => a.id === id);
      expect(agent.suggestions).toEqual(["Mehr Details", "Kurzfassung", "Und morgen?"]);
      expect(v.calls[0].url).toBe("http://spark.test:8000/v1/chat/completions");
      expect(v.calls[0].body).toMatchObject({
        model: "qwen", temperature: 0.7, chat_template_kwargs: { enable_thinking: false },
      });
      expect(v.calls[0].body.max_tokens).toBeLessThanOrEqual(150);
      const prompt = v.calls[0].body.messages[0].content;
      expect(prompt).toContain("Wie spät ist es?");
      expect(prompt).toContain("Es ist 14 Uhr.");
      expect(prompt).toContain("28");
    });
  }

  it("a suggestion list sent by the agent is never used", async () => {
    const v = vllm(() => new Response("down", { status: 503 }));
    const h = await hub({ fetchImpl: v.fetchImpl });
    const id = await answered(h, "hermes");
    await until(() => v.calls.length > 0);
    await new Promise((r) => setTimeout(r, 50));
    expect((await h.api("/agents")).json.agents.find((a) => a.id === id).suggestions).toEqual([]);
  });

  it("vLLM down, garbage or too slow: NO suggestions, and it is logged", async () => {
    const lines = [];
    for (const reply of [() => new Response("x", { status: 500 }), () => ok("keine Liste"), () => new Promise(() => undefined)]) {
      const v = vllm(reply);
      const h = await hub({ fetchImpl: v.fetchImpl, suggestTimeoutMs: 150, log: (...a) => lines.push(a.join(" ")) });
      const id = await answered(h, "claude");
      await until(() => lines.some((l) => l.includes("showing none")), 3000);
      expect((await h.api("/agents")).json.agents.find((a) => a.id === id).suggestions).toEqual([]);
      lines.length = 0;
    }
  });

  it("success is logged with model and duration", async () => {
    const lines = [];
    const v = vllm(() => ok('["A","B","C"]'));
    const h = await hub({ fetchImpl: v.fetchImpl, log: (...a) => lines.push(a.join(" ")) });
    await answered(h, "hermes");
    await until(() => lines.some((l) => /suggestions \(answer\): vLLM qwen ok, 3 in \d+ ms/.test(l)));
  });

  it("English UI asks for English options", async () => {
    const v = vllm(() => ok('["More","Short"]'));
    const h = await hub({ fetchImpl: v.fetchImpl, lang: "en" });
    await answered(h, "hermes");
    await until(() => v.calls.length > 0);
    expect(v.calls[0].body.messages[0].content).toContain("English");
  });

  it("permission cards get vLLM options too, without delaying the card", async () => {
    const v = vllm(() => ok('["Erlauben","Ablehnen","Nachfragen"]'));
    const h = await hub({ fetchImpl: v.fetchImpl, approvalTimeoutMs: 3000 });
    await h.api("/relay/register", { machine: "m", agents: [{ id: "c", kind: "claude" }] });
    const pending = h.api("/relay/permission", { agentId: "c", tool: "Bash", summary: "npm test" });
    const card = await until(async () => (await h.api("/report")).json.approvals[0]);
    expect(card.title).toContain("npm test");
    await until(async () => (await h.api("/report")).json.approvals[0].suggestions.length === 3);
    expect(v.calls[0].body.messages[0].content).toContain("npm test");
    await h.api("/agent/approve", { cardId: card.id, decision: "allow" });
    expect((await pending).json.decision).toBe("allow");
  });

  it("with vLLM switched off there are no calls and no suggestions", async () => {
    const v = vllm(() => ok('["A"]'));
    const h = await hub({ fetchImpl: v.fetchImpl, suggestions: false });
    const id = await answered(h, "hermes");
    await new Promise((r) => setTimeout(r, 80));
    expect(v.calls).toHaveLength(0);
    expect((await h.api("/agents")).json.agents.find((a) => a.id === id).suggestions).toEqual([]);
  });
});

describe("suggestions know the conversation they belong to (0.6.5)", () => {
  /** A relay agent with a finished answer; returns ids and a function to run more turns. */
  async function relayAgent(h, id = "c") {
    const reg = await h.api("/relay/register", { machine: `m-${id}`, agents: [{ id, kind: "claude" }] });
    const relay = reg.json.relayId;
    const turn = async (question, answer, steps = []) => {
      await h.api("/agent/ask", { agentId: id, question, wait: false });
      const ask = (await h.api(`/relay/poll?relay=${relay}`)).json.commands[0];
      for (const step of steps) await h.api("/relay/result", { jobId: ask.jobId, status: "running", text: "", activity: step });
      await h.api("/relay/result", { jobId: ask.jobId, status: "done", text: answer, sessionId: "sess-1" });
      return ask;
    };
    return { relay, turn };
  }
  const agentOf = async (h, id) => (await h.api("/agents")).json.agents.find((a) => a.id === id);

  it("an answer's prompt carries the question, the answer, the tool steps and earlier turns", async () => {
    const v = vllm(() => ok('["Deploy auf Pi5","Log zeigen","Tests nochmal"]'));
    const h = await hub({ fetchImpl: v.fetchImpl });
    const a = await relayAgent(h);
    await a.turn("Läuft der Build?", "Ja, Build grün.");
    await until(() => v.calls.length === 1);
    await a.turn("Und die Tests?", "Zwei Tests in model.test.ts schlagen fehl.", ["Bash: npm test"]);
    await until(() => v.calls.length === 2);
    const prompt = v.calls[1].body.messages[0].content;
    expect(prompt).toContain("Und die Tests?");
    expect(prompt).toContain("model.test.ts");
    expect(prompt).toContain("Bash: npm test");
    expect(prompt).toContain("Läuft der Build?");
  });

  it("the options just shown are never offered again (duplicate filter + told to the model)", async () => {
    const v = vllm((n) => ok(n === 1 ? '["A eins","B zwei","C drei"]' : '["A eins","D vier","b zwei"]'));
    const h = await hub({ fetchImpl: v.fetchImpl });
    const a = await relayAgent(h);
    await a.turn("Frage 1", "Antwort 1");
    await until(async () => (await agentOf(h, "c")).suggestions.length === 3);
    await a.turn("Frage 2", "Antwort 2");
    await until(async () => (await agentOf(h, "c")).suggesting === false && v.calls.length === 2);
    await until(async () => (await agentOf(h, "c")).suggestions.length > 0);
    expect((await agentOf(h, "c")).suggestions).toEqual(["D vier"]);
    expect(v.calls[1].body.messages[0].content).toContain('"A eins"');
  });

  it("a late answer for an earlier question is dropped, never shown under the new one", async () => {
    let release;
    const v = vllm((n) => (n === 1 ? new Promise((r) => { release = () => r(ok('["Alt eins","Alt zwei"]')); }) : ok('["Neu eins"]')));
    const h = await hub({ fetchImpl: v.fetchImpl });
    const a = await relayAgent(h);
    await a.turn("Erste", "Erste Antwort");
    await until(() => v.calls.length === 1);
    await a.turn("Zweite", "Zweite Antwort");
    await until(async () => (await agentOf(h, "c")).suggestions.length === 1);
    release();
    await new Promise((r) => setTimeout(r, 50));
    expect((await agentOf(h, "c")).suggestions).toEqual(["Neu eins"]);
  });

  it("opening another session (e.g. from an alert) makes NEW suggestions from that session", async () => {
    const v = vllm((n) => ok(n === 1 ? '["Alt A","Alt B","Alt C"]' : '["Rechnung senden","PDF zeigen"]'));
    const h = await hub({ fetchImpl: v.fetchImpl });
    const a = await relayAgent(h);
    await a.turn("Wetter?", "Sonnig, 20 Grad.");
    await until(async () => (await agentOf(h, "c")).suggestions.length === 3);
    const select = h.api("/agent/session/select", { agentId: "c", sessionId: "sess-9", title: "Rechnung" });
    const cmd = await until(async () => (await h.api(`/relay/poll?relay=${a.relay}`)).json.commands[0]);
    await h.api("/relay/reply", { reqId: cmd.reqId, ok: true, data: { lastUser: "Schreib die Rechnung für Huber", lastAssistant: "Rechnung R-17 für Huber ist als PDF fertig.", history: [] } });
    expect((await select).status).toBe(200);
    expect((await agentOf(h, "c")).suggestions).not.toContain("Alt A");
    await until(async () => (await agentOf(h, "c")).suggestions.length === 2);
    expect((await agentOf(h, "c")).suggestions).toEqual(["Rechnung senden", "PDF zeigen"]);
    const prompt = v.calls[1].body.messages[0].content;
    expect(prompt).toContain("Rechnung R-17");
    expect(prompt).toContain("Huber");
    expect(prompt).not.toContain("Sonnig");
  });

  it("a card's prompt carries the tool, the command and what the user asked; options have a decision", async () => {
    const v = vllm((n) => ok(n === 1 ? '["x"]' : '[{"text":"Ja, nur lesen","decision":"allow"},{"text":"Erst Backup machen","decision":"deny"},{"text":"Zeig mir den Diff","decision":"deny"}]'));
    const h = await hub({ fetchImpl: v.fetchImpl, approvalTimeoutMs: 3000 });
    const a = await relayAgent(h);
    await a.turn("Räum die Config auf", "Ich schaue mir config.json an.");
    await until(() => v.calls.length === 1);
    const pending = h.api("/relay/permission", { agentId: "c", tool: "Edit", summary: "/srv/app/config.json" });
    const card = await until(async () => {
      const c = (await h.api("/report")).json.approvals[0];
      return c && c.options.length === 3 ? c : null;
    });
    const prompt = v.calls[1].body.messages[0].content;
    expect(prompt).toContain("Edit");
    expect(prompt).toContain("/srv/app/config.json");
    expect(prompt).toContain("Räum die Config auf");
    expect(card.options[1]).toEqual({ text: "Erst Backup machen", decision: "deny" });
    expect(card.suggestions).toEqual(["Ja, nur lesen", "Erst Backup machen", "Zeig mir den Diff"]);
    await h.api("/agent/approve", { cardId: card.id, decision: "allow" });
    expect((await pending).json.decision).toBe("allow");
  });

  it("a denied card with a note sends the note as the next message once the run ends", async () => {
    const h = await hub({ approvalTimeoutMs: 3000, suggestions: false });
    const reg = await h.api("/relay/register", { machine: "m", agents: [{ id: "c", kind: "claude" }] });
    await h.api("/agent/ask", { agentId: "c", question: "Aufräumen", wait: false });
    const ask = (await h.api(`/relay/poll?relay=${reg.json.relayId}`)).json.commands[0];
    const pending = h.api("/relay/permission", { agentId: "c", tool: "Bash", summary: "rm -rf build" });
    const card = await until(async () => (await h.api("/report")).json.approvals[0]);
    await h.api("/agent/approve", { cardId: card.id, decision: "deny", note: "Erst Backup machen" });
    expect((await pending).json.decision).toBe("deny");
    await h.api("/relay/result", { jobId: ask.jobId, status: "done", text: "Abgebrochen." });
    const next = await until(async () => (await h.api(`/relay/poll?relay=${reg.json.relayId}`)).json.commands[0]);
    expect(next).toMatchObject({ type: "ask", agentId: "c", prompt: "Erst Backup machen" });
  });
});

describe("an opened alert gets suggestions from the alert itself (0.6.5)", () => {
  it("agent without history for that session: the alert's question and answer are the context", async () => {
    const v = vllm(() => ok('["Mahnung schicken","Betrag prüfen"]'));
    const h = await hub({ fetchImpl: v.fetchImpl });
    await h.api("/relay/register", { machine: "m", agents: [{ id: "c", kind: "codex" }] });
    const event = (await h.api("/events", { provider: "c", status: "done", title: "Ist Huber bezahlt?", detail: "Nein, Rechnung R-17 ist offen." })).json.event;
    // Hook events carry no agentId: nothing to open, no vLLM call.
    await h.api("/events/read", { id: event.id, open: true });
    expect(v.calls).toHaveLength(0);
    h.hub.state.events = h.hub.state.events.map((e) => (e.id === event.id ? { ...e, agentId: "c", read: false } : e));
    await h.api("/events/read", { id: event.id, open: true });
    await until(async () => (await h.api("/agents")).json.agents.find((a) => a.id === "c").suggestions.length === 2);
    const prompt = v.calls[0].body.messages[0].content;
    expect(prompt).toContain("Ist Huber bezahlt?");
    expect(prompt).toContain("R-17");
  });

  it("marking read without opening never asks the vLLM", async () => {
    const v = vllm(() => ok('["A"]'));
    const h = await hub({ fetchImpl: v.fetchImpl });
    await h.api("/relay/register", { machine: "m", agents: [{ id: "c", kind: "codex" }] });
    const event = (await h.api("/events", { provider: "c", status: "done", title: "T", detail: "D" })).json.event;
    h.hub.state.events = h.hub.state.events.map((e) => ({ ...e, agentId: "c" }));
    await h.api("/events/read", { id: event.id });
    await new Promise((r) => setTimeout(r, 50));
    expect(v.calls).toHaveLength(0);
  });
});
