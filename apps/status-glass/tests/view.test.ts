import { describe, it, expect, vi } from "vitest";
import { buildView } from "../src/glasses/view";
import { applyError, applyReport, acknowledge, createSource } from "../src/monitor/dashboard";
import { backoffMs, describeError, fetchReport } from "../src/protocol/fetcher";
import { parseData, EMPTY_DATA, maskToken, validateUrl, isPlainHttp, upsertSource, removeSource, nextSourceId } from "../src/storage/persist";
import type { Metric } from "../src/protocol/schema";

const metric = (over: Partial<Metric> = {}): Metric => ({ id: "cpu", label: "CPU", ...over });
const healthy = { name: "nas", metrics: [metric({ value: 10, warn: 80 })] };
const broken = {
  name: "nas",
  metrics: [
    metric({ id: "disk", label: "Disk", value: 99, warn: 80, critical: 95 }),
    metric({ id: "ram", label: "RAM", value: 85, warn: 80, critical: 95 }),
  ],
};

describe("healthy display", () => {
  it("asks for configuration when there are no sources", () => {
    expect(buildView([], {}, 0).body.join(" ")).toContain("phone app");
  });

  it("shows one quiet line when everything is fine", () => {
    const source = applyReport(createSource("s1", "nas"), healthy, 0);
    const view = buildView([source], {}, 0);
    expect(view.header).toBe("");
    expect(view.body).toEqual(["1 of 1 ok"]);
    expect(view.footer).toBe("all ok");
  });
});

describe("problem display", () => {
  it("names the severity and the count", () => {
    const source = applyReport(createSource("s1", "nas"), broken, 0);
    expect(buildView([source], {}, 0).header).toBe("CRITICAL  2");
  });

  it("puts the worst problem first", () => {
    const source = applyReport(createSource("s1", "nas"), broken, 0);
    expect(buildView([source], {}, 0).body[0]).toContain("Disk");
  });

  it("marks severity distinctly", () => {
    const source = applyReport(createSource("s1", "nas"), broken, 0);
    const body = buildView([source], {}, 0).body;
    expect(body[0]).toContain("!");
    expect(body[1]).toContain("·");
  });

  it("marks acknowledged problems and sinks them", () => {
    let source = applyReport(createSource("s1", "nas"), broken, 0);
    source = acknowledge(source, "disk");
    const body = buildView([source], {}, 0).body;
    expect(body[0]).toContain("RAM");
    expect(body[1]).toContain("(ack)");
  });

  it("shows an unreachable source as a problem, never as ok", () => {
    const source = applyError(createSource("s1", "nas"), "unreachable", 0);
    const view = buildView([source], {}, 0);
    expect(view.header).toContain("NO DATA");
    expect(view.body[0]).toContain("unreachable");
  });

  it("keeps the cursor row on screen in a long list", () => {
    const many = {
      name: "nas",
      metrics: Array.from({ length: 12 }, (_, i) =>
        metric({ id: "m" + i, label: "M" + i, value: 99, warn: 80, critical: 95 })),
    };
    const source = applyReport(createSource("s1", "nas"), many, 0);
    const view = buildView([source], { cursor: 10, maxRows: 3 }, 0);
    expect(view.body.some((line) => line.startsWith("> "))).toBe(true);
    expect(view.footer).toContain("more");
  });

  it("clamps an out-of-range cursor instead of showing nothing", () => {
    const source = applyReport(createSource("s1", "nas"), broken, 0);
    expect(buildView([source], { cursor: 99 }, 0).body.some((l) => l.startsWith("> "))).toBe(true);
  });
});

describe("fetching", () => {
  it("parses a good response", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(healthy), { status: 200 }));
    const outcome = await fetchReport("https://x/status", "nas", { fetchImpl: fetchImpl as never });
    expect(outcome.error).toBeNull();
    expect(outcome.report?.metrics).toHaveLength(1);
  });

  it("reports an HTTP error without throwing", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 503 }));
    const outcome = await fetchReport("https://x/status", "nas", { fetchImpl: fetchImpl as never });
    expect(outcome.error).toBe("HTTP 503");
    expect(outcome.report).toBeNull();
  });

  it("sends the token as a header, never in the URL", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer secret");
      return new Response(JSON.stringify(healthy), { status: 200 });
    });
    await fetchReport("https://x/status", "nas", { token: "secret", fetchImpl: fetchImpl as never });
    expect(fetchImpl.mock.calls[0]?.[0]).not.toContain("secret");
  });

  it("sends no Authorization header without a token", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>)["Authorization"]).toBeUndefined();
      return new Response(JSON.stringify(healthy), { status: 200 });
    });
    await fetchReport("https://x/status", "nas", { fetchImpl: fetchImpl as never });
  });

  it("describes failures without leaking internals", () => {
    expect(describeError(new TypeError("Failed to fetch"))).toBe("unreachable");
    expect(describeError(new DOMException("aborted", "AbortError"))).toBe("timed out");
    expect(describeError("weird")).toBe("failed");
    expect(describeError(new Error("x".repeat(200))).length).toBeLessThanOrEqual(60);
  });

  it("backs off a failing source but recovers promptly", () => {
    expect(backoffMs(0, 30_000)).toBe(30_000);
    expect(backoffMs(1, 30_000)).toBe(60_000);
    expect(backoffMs(99, 30_000)).toBe(300_000);
  });
});

describe("configuration", () => {
  it("validates URLs", () => {
    expect(validateUrl("https://x/status").valid).toBe(true);
    expect(validateUrl("http://192.168.1.5:9000/s").valid).toBe(true);
    expect(validateUrl("ftp://x").valid).toBe(false);
    expect(validateUrl("").valid).toBe(false);
    expect(validateUrl("not a url").valid).toBe(false);
  });

  it("flags plain http so the UI can warn", () => {
    expect(isPlainHttp("http://x/s")).toBe(true);
    expect(isPlainHttp("https://x/s")).toBe(false);
  });

  it("never reveals a token", () => {
    expect(maskToken("supersecret")).toBe("set (11 chars)");
    expect(maskToken("supersecret")).not.toContain("supersecret");
    expect(maskToken(undefined)).toBe("none");
  });

  it("drops a stored source with an unusable URL", () => {
    const parsed = parseData(JSON.stringify({
      sources: [{ id: "a", url: "ftp://bad" }, { id: "b", url: "https://good/s" }],
    }));
    expect(parsed.sources.map((s) => s.id)).toEqual(["b"]);
  });

  it("clamps the poll interval", () => {
    expect(parseData(JSON.stringify({ pollSeconds: 0 })).pollSeconds).toBe(5);
    expect(parseData(JSON.stringify({ pollSeconds: 99999 })).pollSeconds).toBe(600);
  });

  it("falls back cleanly on corrupt data", () => {
    expect(parseData("{nope")).toEqual(EMPTY_DATA);
  });

  it("adds, replaces and removes sources", () => {
    let data = upsertSource(EMPTY_DATA, { id: "s1", name: "a", url: "https://a/s" });
    data = upsertSource(data, { id: "s1", name: "renamed", url: "https://a/s" });
    expect(data.sources).toHaveLength(1);
    expect(data.sources[0]?.name).toBe("renamed");
    expect(nextSourceId(data)).toBe("s2");
    expect(removeSource(data, "s1").sources).toEqual([]);
  });
});
