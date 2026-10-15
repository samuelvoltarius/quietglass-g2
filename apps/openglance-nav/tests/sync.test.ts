import { describe, expect, it } from "vitest";
import { createRouteSync, sameRoutes } from "../src/trip/sync";
import type { SavedRoute } from "../src/trip/saved";

const route = (id: string, name: string, updated: number): SavedRoute => ({
  id, name, mode: "driving", start: null, stops: [], to: { label: name, at: { lat: 47.8, lon: 13.04 } }, distance: 1000, duration: 100, updated,
});

describe("route sync", () => {
  it("is off without a route store", () => {
    expect(createRouteSync({ url: "" })).toBeNull();
  });

  it("sends a simple POST (no own headers, text body) and merges the answer", async () => {
    let seen: { url: string; init: RequestInit | undefined } | null = null;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ routes: [route("a", "Vom PC", 5), { id: "kaputt" }], deleted: [{ id: "b", at: Date.now() }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const sync = createRouteSync({ url: "https://store.example:8465/", fetchImpl })!;
    const outcome = await sync.sync({ routes: [route("a", "Alt", 1), route("b", "Gelöscht", 2)], deleted: [] });
    expect(seen!.url).toBe("https://store.example:8465/routes");
    expect(seen!.init?.method).toBe("POST");
    expect(seen!.init?.headers).toBeUndefined();
    expect(typeof seen!.init?.body).toBe("string");
    expect(outcome.error).toBeNull();
    expect(outcome.result!.routes.map((r) => r.name)).toEqual(["Vom PC"]);
    expect(outcome.result!.deleted.map((d) => d.id)).toEqual(["b"]);
  });

  it("reports sign-in, server and network failures without touching the routes", async () => {
    const answer = (status: number) => (async () => new Response("{}", { status })) as unknown as typeof fetch;
    expect((await createRouteSync({ url: "https://s", fetchImpl: answer(401) })!.sync({ routes: [], deleted: [] })).error).toBe("auth");
    expect((await createRouteSync({ url: "https://s", fetchImpl: answer(502) })!.sync({ routes: [], deleted: [] })).error).toBe("server");
    const offline = (async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
    const outcome = await createRouteSync({ url: "https://s", fetchImpl: offline })!.sync({ routes: [], deleted: [] });
    expect(outcome).toEqual({ result: null, error: "offline" });
  });

  it("compares route sets", () => {
    expect(sameRoutes({ routes: [route("a", "A", 1)], deleted: [] }, { routes: [route("a", "A", 1)], deleted: [] })).toBe(true);
    expect(sameRoutes({ routes: [route("a", "A", 1)], deleted: [] }, { routes: [route("a", "A", 2)], deleted: [] })).toBe(false);
  });
});
