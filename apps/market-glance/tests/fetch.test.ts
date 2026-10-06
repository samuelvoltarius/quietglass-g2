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
  it("rejects on an HTTP error", async () => {
    await expect(fetchPositions("u", reply({ error: "x" }, 502))).rejects.toThrow("HTTP 502");
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
