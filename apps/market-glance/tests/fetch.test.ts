import { describe, expect, it } from "vitest";
import { fetchPositions } from "../src/markets/fetch";

function reply(body: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
}

describe("fetchPositions", () => {
  it("reads positions and a live source", async () => {
    const result = await fetchPositions("u", reply({ positions: [{ title: "A", pnl: 1 }], source: "live" }));
    expect(result.source).toBe("live");
    expect(result.positions[0]?.title).toBe("A");
  });
  it("treats anything but source 'live' as demo", async () => {
    expect((await fetchPositions("u", reply({ positions: [], source: "LIVE" }))).source).toBe("demo");
    expect((await fetchPositions("u", reply([{ title: "A" }]))).source).toBe("demo");
  });
  it("rejects on an HTTP error and keeps the bridge's explanation", async () => {
    await expect(fetchPositions("u", reply({ error: "kalshi: Kalshi HTTP 401" }, 502))).rejects.toThrow("HTTP 502: kalshi: Kalshi HTTP 401");
    await expect(fetchPositions("u", (async () => new Response("<html>", { status: 500 })) as typeof fetch)).rejects.toThrow(/^HTTP 500$/);
  });
  it("regression: reads updatedAt and per-provider errors from a partial response", async () => {
    const result = await fetchPositions("u", reply({ positions: [{ title: "K", provider: "kalshi" }], source: "live", updatedAt: "2026-01-01T00:00:00Z", errors: [{ provider: "polymarket", message: "Polymarket HTTP 500" }] }));
    expect(result.updatedAt).toBe(Date.UTC(2026, 0, 1));
    expect(result.errors).toEqual([{ provider: "polymarket", message: "Polymarket HTTP 500" }]);
    expect(result.positions).toHaveLength(1);
  });
  it("reports a missing timestamp as null", async () => {
    expect((await fetchPositions("u", reply({ positions: [] }))).updatedAt).toBeNull();
  });
  it("rejects a null JSON body with a parse error", async () => {
    await expect(fetchPositions("u", reply(null))).rejects.toThrow("positions response must be an array");
  });
  it("regression: a hung bridge is aborted after the timeout", async () => {
    const hang = ((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })) as unknown as typeof fetch;
    await expect(fetchPositions("u", hang, 10)).rejects.toThrow("aborted");
  });
});
