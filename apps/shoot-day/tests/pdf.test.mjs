import { describe, expect, it } from "vitest";
import { chatUrl, cleanScene, extractPdfText, parseCMap, parseSceneReply, parseSeconds, proposeScenes, storyboardMessages } from "../examples/shoot-day-pdf.mjs";
import { makePdf } from "./pdf-fixture.mjs";

describe("PDF text extraction (no dependencies)", () => {
  it("reads Flate streams, ToUnicode maps, object streams, escapes and both pages in order", () => {
    const { text, pages, encrypted } = extractPdfText(makePdf());
    expect(pages).toBe(2);
    expect(encrypted).toBe(false);
    expect(text).toContain("Szene 1 (Intro)");
    expect(text).toContain("Kamera: nah");
    expect(text).toContain("ÜbcAfi");
    expect(text).toContain("Seite 2: Grüße");
    expect(text.indexOf("Szene 1")).toBeLessThan(text.indexOf("Seite 2"));
  });

  it("says when there is nothing to read: pictures only, encrypted, or not a PDF at all", () => {
    expect(extractPdfText(makePdf({ textless: true })).text).toBe("");
    expect(extractPdfText(makePdf({ encrypted: true }))).toMatchObject({ text: "", encrypted: true });
    expect(extractPdfText(Buffer.from("hello, not a pdf"))).toEqual({ text: "", pages: 0, encrypted: false });
    expect(extractPdfText("not even a buffer")).toEqual({ text: "", pages: 0, encrypted: false });
  });

  it("survives a damaged file without throwing", () => {
    const pdf = makePdf();
    for (const cut of [20, 200, 600, pdf.length - 40]) expect(() => extractPdfText(pdf.subarray(0, cut))).not.toThrow();
    const garbage = Buffer.concat([Buffer.from("%PDF-1.4\n1 0 obj\n<< /Filter /FlateDecode /Length 5 >>\nstream\n"), Buffer.from([1, 2, 3, 4, 5]), Buffer.from("\nendstream\nendobj\n")]);
    expect(extractPdfText(garbage).text).toBe("");
  });

  it("parses CMaps with two-byte codes", () => {
    const { map, width } = parseCMap("begincodespacerange <0000> <FFFF> endcodespacerange beginbfchar <0001> <0041> endbfchar beginbfrange <0010> <0012> <0061> endbfrange");
    expect(width).toBe(2);
    expect([map.get(1), map.get(0x10), map.get(0x12)]).toEqual(["A", "a", "c"]);
  });
});

describe("storyboard proposal", () => {
  it("reads times as seconds", () => {
    expect([parseSeconds("0:05"), parseSeconds("5"), parseSeconds("5 Sek."), parseSeconds("1:02:03"), parseSeconds(7.25), parseSeconds("bald"), parseSeconds(-1)])
      .toEqual([5, 5, 5, 3723, 7.3, null, null]);
  });

  it("accepts the model's JSON with code fences or chatter, and cleans every scene", () => {
    const reply = "Hier ist das Ergebnis:\n```json\n{\"scenes\":[{\"n\":1,\"from\":\"0:00\",\"to\":\"0:05\",\"title\":\"Intro\",\"camera\":\"Totale\",\"overlay\":\"Hallo\",\"goal\":\"Neugier\",\"done\":true},{\"title\":\"\"}]}\n```\nViel Erfolg!";
    expect(parseSceneReply(reply)).toEqual([
      { n: 1, from: 0, to: 5, title: "Intro", content: "", camera: "Totale", overlay: "Hallo", goal: "Neugier", done: true },
    ]);
    expect(parseSceneReply("[{\"title\":\"A\",\"from\":12,\"to\":3}]")).toEqual([
      { n: 1, from: 3, to: 12, title: "A", content: "", camera: "", overlay: "", goal: "", done: false },
    ]);
    expect(parseSceneReply("Sorry, I cannot help.")).toBeNull();
    expect(parseSceneReply("{\"scenes\": \"none\"}")).toBeNull();
    expect(cleanScene({ title: "x".repeat(500) })?.title).toHaveLength(200);
  });

  it("asks an OpenAI-compatible server without thinking and with the PDF text, and reports failures as codes", async () => {
    const seen = [];
    const fake = async (url, init) => {
      seen.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
      return new Response(JSON.stringify({ choices: [{ message: { content: "{\"scenes\":[{\"title\":\"Intro\",\"from\":0,\"to\":4}]}" } }] }), { status: 200 });
    };
    const result = await proposeScenes("SZENE 01 5-10 SEKUNDEN", { url: "https://llm.example/v1", model: "test-model", token: "t0k", fetchImpl: fake });
    expect(result).toEqual({ ok: true, scenes: [{ n: 1, from: 0, to: 4, title: "Intro", content: "", camera: "", overlay: "", goal: "", done: false }] });
    expect(seen[0].url).toBe("https://llm.example/v1/chat/completions");
    expect(seen[0].body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(seen[0].body.model).toBe("test-model");
    expect(seen[0].body.messages[1].content).toContain("SZENE 01");
    expect(seen[0].auth).toBe("Bearer t0k");
    expect(await proposeScenes("x", { url: "", fetchImpl: fake })).toEqual({ ok: false, error: "not-configured" });
    expect(await proposeScenes("x", { url: "https://llm.example", fetchImpl: async () => new Response("no", { status: 500 }) })).toEqual({ ok: false, error: "http 500" });
    expect(await proposeScenes("x", { url: "https://llm.example", fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: "nope" } }] })) })).toEqual({ ok: false, error: "unreadable" });
    expect(await proposeScenes("x", { url: "https://llm.example", fetchImpl: async () => { throw new TypeError("down"); } })).toEqual({ ok: false, error: "unreachable" });
  });

  it("builds the endpoint from a base URL and keeps long documents short", () => {
    expect(chatUrl("https://h:1/v1/")).toBe("https://h:1/v1/chat/completions");
    expect(chatUrl("https://h:1")).toBe("https://h:1/v1/chat/completions");
    expect(chatUrl("https://h:1/v1/chat/completions")).toBe("https://h:1/v1/chat/completions");
    expect(storyboardMessages("x".repeat(100_000), "en")[1].content.length).toBe(24_000);
    expect(storyboardMessages("x", "de")[0].content).toContain("NUR mit JSON");
  });
});
