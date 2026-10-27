import { describe, expect, it, vi } from "vitest";
import { choicesFrom } from "../src/routing/choice";
import { createValhallaProvider, type Route } from "../src/routing/provider";

const route = (duration: number, toll: boolean | undefined): Route => ({ shape: [], maneuvers: [], distance: 123_000, duration, ...(toll === undefined ? {} : { toll }) });

// 15.10.: Salzburg -> Tamsweg, A10 77 min with the tunnel toll; over the Radstaedter Tauern (B99)
// 98 min without - Valhalla's own alternates never offered it.
describe("the toll-free way as a choice", () => {
  const a10 = route(77 * 60, true);
  const b99 = route(98 * 60, false);

  it("is offered second when the best way has a toll and it is at most 1.5x slower", () => {
    expect(choicesFrom(a10, [], b99)).toEqual([a10, b99]);
  });

  it("is not offered when the best way is free, when it is far slower, or a free alternate exists", () => {
    expect(choicesFrom(route(77 * 60, false), [], b99)).toHaveLength(1);
    expect(choicesFrom(a10, [], route(130 * 60, false))).toHaveLength(1);
    const freeAlt = route(90 * 60, false);
    expect(choicesFrom(a10, [freeAlt], b99)).toEqual([a10, freeAlt]);
  });

  it("asks the router with use_tolls 0 for the car", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: "x" }), { status: 400 }));
    const provider = createValhallaProvider({ url: "https://router.example", fetchImpl: fetchImpl as never });
    await provider.route({ from: { lat: 47.8, lon: 13.04 }, to: { lat: 47.13, lon: 13.81 }, mode: "driving", avoidTolls: true });
    const url = decodeURIComponent(String((fetchImpl.mock.calls[0] as unknown[])[0]));
    expect(url).toContain('"costing_options":{"auto":{"use_tolls":0}}');
  });
});
