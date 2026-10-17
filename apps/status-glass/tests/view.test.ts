import { describe, it, expect, vi } from "vitest";
import { problemsView, startView } from "../src/glasses/view";
import { applyError, applyReport, acknowledge, createSource, problems } from "../src/monitor/dashboard";
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

const NOW = 0;
const list = (sources: ReturnType<typeof applyReport>[]) => problems(sources, NOW);
const opts = { locale: "en", demo: false, armed: false } as const;

describe("healthy display", () => {
  it("asks for configuration when there are no sources", () => {
    const view = startView([], 0, NOW, { locale: "en", demo: false, problemCount: 0, actionCount: 0 });
    expect(view.body.join(" ")).toContain("phone app");
    expect(view.footer).toBe("2× = exit");
  });

  it("shows only the overview when everything is fine: header, one row, one footer line", () => {
    const source = applyReport(createSource("s1", "nas"), healthy, 0);
    const view = startView([source], 0, NOW, { locale: "en", demo: false, problemCount: 0, actionCount: 0 });
    expect(view.header).toBe("Status · ● live");
    expect(view.body).toEqual(["● nas"]);
    expect(view.footer).toBe("Tap = open · Swipe = choose · 2× = exit");
  });
});

describe("problem display", () => {
  it("header names the page and the live state", () => {
    const source = applyReport(createSource("s1", "nas"), broken, 0);
    expect(problemsView([source], list([source]), 0, NOW, opts).header).toBe("Problems · ● live");
  });

  it("puts the worst problem first", () => {
    const source = applyReport(createSource("s1", "nas"), broken, 0);
    expect(problemsView([source], list([source]), 0, NOW, opts).body[0]).toContain("Disk");
  });

  it("marks severity distinctly", () => {
    const source = applyReport(createSource("s1", "nas"), broken, 0);
    const body = problemsView([source], list([source]), 0, NOW, opts).body;
    expect(body[0]).toContain("!");
    expect(body[1]).toContain("·");
  });

  it("marks acknowledged problems and sinks them", () => {
    let source = applyReport(createSource("s1", "nas"), broken, 0);
    source = acknowledge(source, "disk");
    const body = problemsView([source], list([source]), 0, NOW, opts).body;
    expect(body[0]).toContain("RAM");
    expect(body[1]).toContain("(ack)");
  });

  it("shows an unreachable source as a problem, never as ok", () => {
    const source = applyError(createSource("s1", "nas"), "unreachable", 0);
    const view = problemsView([source], list([source]), 0, NOW, opts);
    expect(view.header).toBe("Problems · offline");
    expect(view.body[0]).toContain("unreachable");
  });

  it("keeps the cursor row on screen in a long list, five rows at most", () => {
    const many = {
      name: "nas",
      metrics: Array.from({ length: 12 }, (_, i) =>
        metric({ id: "m" + i, label: "M" + i, value: 99, warn: 80, critical: 95 })),
    };
    const source = applyReport(createSource("s1", "nas"), many, 0);
    const view = problemsView([source], list([source]), 10, NOW, opts);
    expect(view.body).toHaveLength(5);
    expect(view.body.filter((line) => line.startsWith("● "))).toHaveLength(1);
    expect(view.footer).toBe("Tap = seen · Swipe = list · 2× = back");
  });

  it("clamps an out-of-range cursor instead of showing nothing", () => {
    const source = applyReport(createSource("s1", "nas"), broken, 0);
    expect(problemsView([source], list([source]), 99, NOW, opts).body.some((l) => l.startsWith("● "))).toBe(true);
  });

  it("asks for the second tap in the footer once armed, and offers no tap for a seen problem", () => {
    const source = applyReport(createSource("s1", "nas"), broken, 0);
    expect(problemsView([source], list([source]), 0, NOW, { ...opts, armed: true }).footer).toBe("Tap again = seen · Swipe/2× = cancel");
    const seen = acknowledge(source, "disk");
    expect(problemsView([seen], list([seen]), 0, NOW, { ...opts }).footer).toBe("Tap = seen · Swipe = list · 2× = back");
    expect(problemsView([seen], list([seen]), 0, NOW, opts).body[0]).toContain("RAM");
    const onlySeen = acknowledge(acknowledge(source, "disk"), "ram");
    expect(problemsView([onlySeen], list([onlySeen]), 0, NOW, opts).footer).toBe("Swipe = list · 2× = back");
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

describe("review regressions", () => {
  it("keeps every problem row on one line, whatever the source sends", () => {
    // Regression: rows were never cut, so a long source name, metric label or
    // error text wrapped and pushed the rest of the list off the body.
    const long = applyReport(createSource("s1", "living-room-raspberry-pi-4-model-b"), {
      name: "x",
      metrics: [metric({ id: "t", label: "Temperature of the attic sensor near the chimney", value: 41, unit: "°C", warn: 30 })],
    }, 0);
    const down = acknowledge(applyError(createSource("s2", "nas"), "x".repeat(60), 0), "__source");
    const view = problemsView([long, down], list([long, down]), 0, NOW, opts);
    for (const row of view.body) expect(row.length).toBeLessThanOrEqual(56);
    expect(view.body.some((row) => row.endsWith("(ack)"))).toBe(true);
  });

  it("refuses a URL with credentials in it", () => {
    // Regression: accepted, then shown in full on the sources list and refused
    // by fetch on every poll as "unreachable".
    expect(validateUrl("https://admin:hunter2@nas.local/status").valid).toBe(false);
    expect(validateUrl("https://nas.local/status").valid).toBe(true);
  });
});
