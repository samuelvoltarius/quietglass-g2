import { describe, expect, it } from "vitest";
import {
  createMemoryClient, memoryExport, memoryNotes, memoryQuery, memoryUrl, type MemoryEntry,
} from "../src/companion/memory";
import { explainPrompt, parseInsight, parseSummary, type CompanionLlm } from "../src/companion/llm";
import { createInsightWatcher } from "../src/companion/insights";
import { memoryInner } from "../src/ui/phone";
import { EMPTY_DATA, parseData } from "../src/storage/persist";

interface Call { url: string; method: string; headers: Record<string, string>; body: unknown }

/** A fake /memory server: records calls, answers with `reply`. */
function fakeFetch(reply: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const call: Call = {
      url,
      method: init.method ?? "GET",
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    return reply(call);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

const entry: MemoryEntry = {
  id: "abc123", date: "2026-10-13T10:00:00", type: "session", title: "Wärmepumpe Huber",
  summary: "Angebot besprochen.", agreements: ["Abnahme Dienstag 10 Uhr"],
};

describe("memory client", () => {
  it("talks to /memory next to the language model", () => {
    expect(memoryUrl("https://host:8448/v1")).toBe("https://host:8448/memory");
    expect(memoryUrl("https://host:8448/v1/chat/completions/")).toBe("https://host:8448/memory");
    expect(memoryUrl("http://h/proxy")).toBe("http://h/proxy/memory");
  });

  it("lists, adds, deletes and searches with the bearer token", async () => {
    const { calls, fetchImpl } = fakeFetch((call) => {
      if (call.method === "GET") return json({ memory: true, entries: [entry, { bad: true }] });
      if (call.method === "DELETE") return json({ memory: true, deleted: 1 });
      if (call.url.endsWith("/search")) return json({ memory: true, entries: [{ ...entry, score: 2.5 }] });
      return json({ memory: true, entry: { ...entry, id: "new1", type: "note" } });
    });
    const client = createMemoryClient({ url: "https://h/v1", apiKey: "k", fetchImpl });

    const list = await client.list(20);
    expect(list).toEqual({ ok: true, value: [entry] });
    expect(calls[0]!.url).toBe("https://h/memory?limit=20");
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer k");

    const added = await client.add({ type: "note", title: "T", summary: "S" });
    expect(added.ok && added.value.id).toBe("new1");
    expect(calls[1]!.body).toEqual({ type: "note", title: "T", summary: "S", agreements: [] });

    expect(await client.remove("a/b")).toEqual({ ok: true, value: true });
    expect(calls[2]!).toMatchObject({ method: "DELETE", url: "https://h/memory/a%2Fb" });
    expect(await client.clear()).toEqual({ ok: true, value: true });
    expect(calls[3]!).toMatchObject({ method: "DELETE", url: "https://h/memory" });

    const hits = await client.search("Wärmepumpe", 3);
    expect(hits.ok && hits.value[0]!.score).toBe(2.5);
    expect(calls[4]!.body).toEqual({ query: "Wärmepumpe", limit: 3 });
  });

  it("an older proxy or a plain LLM server means 'unavailable', never an exception", async () => {
    for (const reply of [
      () => new Response("{}", { status: 404 }),
      () => json({ object: "list", data: [] }),          // JSON, but no memory marker
      () => new Response("<html>", { status: 200 }),
      () => { throw new TypeError("Failed to fetch"); },   // CORS / DELETE not allowed
    ]) {
      const client = createMemoryClient({ url: "https://h/v1", fetchImpl: fakeFetch(reply).fetchImpl });
      expect(await client.list()).toEqual({ ok: false, error: "unavailable" });
      expect(await client.remove("x")).toEqual({ ok: false, error: "unavailable" });
      expect((await client.search("x")).ok).toBe(false);
    }
  });

  it("tells a refused login apart", async () => {
    const client = createMemoryClient({ url: "https://h/v1", fetchImpl: fakeFetch(() => json({ error: "unauthorized" }, 401)).fetchImpl });
    expect(await client.list()).toEqual({ ok: false, error: "unauthorized" });
  });

  it("does not ask for an empty search", async () => {
    const { calls, fetchImpl } = fakeFetch(() => json({ memory: true, entries: [] }));
    expect(await createMemoryClient({ url: "https://h/v1", fetchImpl }).search("  ")).toEqual({ ok: true, value: [] });
    expect(calls).toHaveLength(0);
  });
});

describe("memory as prompt context and export", () => {
  it("formats the top hits as short notes", () => {
    const notes = memoryNotes([entry, { ...entry, id: "2" }, { ...entry, id: "3" }, { ...entry, id: "4" }], "de");
    expect(notes.split("\n")).toHaveLength(3);
    expect(notes).toContain("13.10.2026 Wärmepumpe Huber: Angebot besprochen. Abmachungen: Abnahme Dienstag 10 Uhr");
  });

  it("searches with the newest lines", () => {
    expect(memoryQuery([{ text: "a" }, { text: "b" }, { text: "c" }, { text: "d" }])).toBe("b c d");
  });

  it("exports everything as plain text", () => {
    const text = memoryExport([entry, { ...entry, id: "n", type: "note", title: "Rückruf", summary: "ab 9", agreements: [] }], "de");
    expect(text).toContain("13.10.2026 · Gespräch · Wärmepumpe Huber\nAngebot besprochen.\nAbmachungen:\n- Abnahme Dienstag 10 Uhr");
    expect(text).toContain("Notiz · Rückruf\nab 9");
  });
});

describe("memory in the companion", () => {
  it("summary carries the agreements", () => {
    const s = parseSummary('{"kurz":"Termin","lang":"- Termin Dienstag","abmachungen":"- Huber schickt Angebot bis Freitag\\n- Abnahme Dienstag"}');
    expect(s?.agreements).toEqual(["Huber schickt Angebot bis Freitag", "Abnahme Dienstag"]);
    expect(parseSummary('{"kurz":"x","lang":"y","abmachungen":""}')).toEqual({ short: ["x"], long: ["y"] });
  });

  it("with notes the prompt says when to stay silent: exactly '-'", () => {
    expect(explainPrompt("de", [], true)).toContain("antworte genau -");
    expect(explainPrompt("de", [])).not.toContain("Notizen des Nutzers");
    expect(parseInsight("-")).toBeNull();
    expect(parseInsight(" - \n")).toBeNull();
  });

  it("the watcher hands the memory hits to the explanation", async () => {
    const seen: (string | undefined)[] = [];
    const llm: CompanionLlm = {
      name: "fake",
      summarize: async () => ({ ok: false, error: "x" }),
      explain: async (_recent, _known, _locale, _progress, notes) => { seen.push(notes); return { ok: true, value: null }; },
    };
    const watcher = createInsightWatcher({
      llm: () => llm, locale: () => "de", onInsight: () => undefined, debounceMs: 0, minGapMs: 0,
      notes: async (recent) => "- Notiz zu " + recent[recent.length - 1]!.text,
    });
    watcher.onFinal([{ text: "Huber", at: 0 }]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen).toEqual(["- Notiz zu Huber"]);
  });

  it("settings: memory on and speaker auto by default, kept when set", () => {
    expect(EMPTY_DATA.memory).toBe(true);
    expect(parseData("{}").mySpeaker).toBe("auto");
    expect(parseData('{"mySpeaker":"B","memory":false}')).toMatchObject({ mySpeaker: "B", memory: false });
    expect(parseData('{"mySpeaker":"Z"}').mySpeaker).toBe("auto");
  });
});

describe("memory tab", () => {
  it("says 'nicht verfügbar' for an older proxy and lists entries otherwise", () => {
    expect(memoryInner({ status: "unavailable", entries: [], enabled: true }, "de")).toContain("nicht verfügbar");
    expect(memoryInner({ status: "none", entries: [], enabled: true }, "de")).toContain("Sprachmodell-Server");
    const html = memoryInner({ status: "ready", entries: [entry], enabled: true }, "de");
    expect(html).toContain("13.10.2026");
    expect(html).toContain("Wärmepumpe Huber");
    expect(html).toContain('data-mem-del="abc123"');
    expect(html).toContain("mem-export");
    expect(memoryInner({ status: "ready", entries: [entry], enabled: true, confirmClear: true }, "de")).toContain("Wirklich alles löschen");
    expect(memoryInner({ status: "ready", entries: [{ ...entry, title: "<b>x</b>" }], enabled: false }, "en")).toContain("&lt;b&gt;x&lt;/b&gt;");
  });
});
