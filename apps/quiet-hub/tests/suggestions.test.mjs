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
        model: "qwen", temperature: 0.3, chat_template_kwargs: { enable_thinking: false },
      });
      expect(v.calls[0].body.max_tokens).toBeLessThanOrEqual(150);
      const prompt = v.calls[0].body.messages[0].content;
      expect(prompt).toContain("Wie spät ist es?");
      expect(prompt).toContain("Es ist 14 Uhr.");
      expect(prompt).toContain("32");
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
