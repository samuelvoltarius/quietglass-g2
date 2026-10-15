import { describe, expect, it } from "vitest";
import { cleanPoints, extractTalkPoints, parsePointsReply, pointCount, pointDate, pointKey, talkPointsMessages } from "../examples/shoot-day-talkpoints.mjs";

// invented conversation, no real customer data
const talk = {
  at: Date.UTC(2026, 9, 14, 9, 5),
  summary: "- Kunde will Drohnenflug über den Garten\n- Logo kommt als Vektor bis Freitag\n- Drehtag noch offen",
  cues: [{ title: "Licht", text: "Fenster nutzen", kind: "tipp" }],
};

const reply = (content) => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) });

describe("talk points (shoot-day-talkpoints.mjs)", () => {
  it("dates: ISO, German with and without year, nonsense", () => {
    const now = new Date(Date.UTC(2026, 9, 15));
    expect(pointDate("2026-10-20", now)).toBe("2026-10-20");
    expect(pointDate("20.10.2026", now)).toBe("2026-10-20");
    expect(pointDate("3.11.", now)).toBe("2026-11-03");
    expect(pointDate("31.02.2026", now)).toBe("");
    expect(pointDate("nächste Woche", now)).toBe("");
    expect(pointDate("", now)).toBe("");
  });

  it("the same point in other words of case/spacing has the same key; kinds are kept apart", () => {
    expect(pointKey("needed", "Drohnengenehmigung.")).toBe(pointKey("needed", "  drohnengenehmigung "));
    expect(pointKey("needed", "Drohnengenehmigung")).not.toBe(pointKey("next", "Drohnengenehmigung"));
  });

  it("cleans model output: strings or objects, no duplicates, limits, who/due only where they belong", () => {
    const points = cleanPoints({
      needed: ["Drohnengenehmigung", "drohnengenehmigung.", { text: "Grundeigentümer fragen", due: "2026-10-18", who: "x" }, "", 5],
      questions: ["Drehtag Samstag möglich?"],
      promises: [{ who: "Kunde", text: "Logo als Vektor", due: "2026-10-17" }, { text: "" }],
      next: [{ text: "Angebot schicken", due: "kein Datum" }],
      extra: ["ignoriert"],
    });
    expect(points.needed.map((p) => p.text)).toEqual(["Drohnengenehmigung", "Grundeigentümer fragen"]);
    expect(points.needed[1]).not.toHaveProperty("due");
    expect(points.needed[1]).not.toHaveProperty("who");
    expect(points.promises).toEqual([expect.objectContaining({ who: "Kunde", text: "Logo als Vektor", due: "2026-10-17" })]);
    expect(points.next[0]).not.toHaveProperty("due");
    expect(points).not.toHaveProperty("extra");
    expect(pointCount(points)).toBe(5);
    expect(cleanPoints(null)).toBeNull();
    expect(cleanPoints([1, 2])).toBeNull();
    expect(cleanPoints({ needed: Array.from({ length: 40 }, (_, i) => "Punkt " + i) }).needed).toHaveLength(12);
  });

  it("reads a reply with code fences and chatter; garbage → null", () => {
    const parsed = parsePointsReply("Hier:\n```json\n{\"needed\":[\"Drohnengenehmigung\"],\"questions\":[],\"promises\":[],\"next\":[]}\n```\nfertig");
    expect(parsed.needed[0].text).toBe("Drohnengenehmigung");
    expect(parsePointsReply("kein json")).toBeNull();
    expect(parsePointsReply("{kaputt")).toBeNull();
  });

  it("the prompt holds the summary, the cards and today's date, and asks for JSON only", () => {
    const messages = talkPointsMessages(talk, { today: new Date(Date.UTC(2026, 9, 15)) });
    expect(messages[0].content).toContain("NUR mit JSON");
    expect(messages[0].content).toContain("2026-10-15");
    expect(messages[1].content).toContain("Drohnenflug über den Garten");
    expect(messages[1].content).toContain("Licht: Fenster nutzen");
  });

  it("asks only the configured endpoint and never throws", async () => {
    const seen = [];
    const fetchImpl = async (url, init) => {
      seen.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
      return reply("{\"needed\":[\"Drohnengenehmigung\"],\"questions\":[\"Drehtag?\"],\"promises\":[],\"next\":[]}");
    };
    const ok = await extractTalkPoints(talk, { url: "http://llm.invalid/v1", token: "t0k", model: "qwen", fetchImpl });
    expect(ok.ok).toBe(true);
    expect(pointCount(ok.points)).toBe(2);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ url: "http://llm.invalid/v1/chat/completions", auth: "Bearer t0k" });
    expect(seen[0].body).toMatchObject({ model: "qwen", stream: false, temperature: 0.1 });

    expect(await extractTalkPoints(talk, { url: "" })).toEqual({ ok: false, error: "not-configured" });
    expect(await extractTalkPoints(talk, { url: "http://x/v1", fetchImpl: async () => ({ ok: false, status: 503 }) })).toEqual({ ok: false, error: "http 503" });
    expect(await extractTalkPoints(talk, { url: "http://x/v1", fetchImpl: async () => reply("weiß nicht") })).toEqual({ ok: false, error: "unreadable" });
    expect(await extractTalkPoints(talk, { url: "http://x/v1", fetchImpl: async () => { throw new Error("down"); } })).toEqual({ ok: false, error: "unreachable" });
  });
});
