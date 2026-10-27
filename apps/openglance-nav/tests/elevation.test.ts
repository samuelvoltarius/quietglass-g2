import { describe, expect, it, vi } from "vitest";
import edges from "./fixtures/salzburg-tamsweg-edges.json";
import { buildHeightUrl, climbAhead, climbKwh, fetchProfile, profileFromEdges } from "../src/car/elevation";
import { batteryEstimate, parseCarState } from "../src/car/byd";

// Real answer of the own Valhalla (valhalla-at, trace_attributes) for Salzburg -> Tamsweg, 15.10.:
// [length km, mean height m, tunnel 0/1] per edge.
const real = (edges as [number, number | null, number][]).map(([length, mean_elevation, tunnel]) => ({ length, mean_elevation, tunnel: tunnel === 1 }));

describe("climb in the arrival battery", () => {
  it("bridges the tunnels: the road, not the mountain above the Tauern tunnel", () => {
    const profile = profileFromEdges(real)!;
    const n = profile.along.length;
    expect(profile.up[n - 1]).toBeGreaterThan(1_300);
    expect(profile.up[n - 1]).toBeLessThan(1_500);
    expect(profile.down[n - 1]).toBeGreaterThan(700);
    expect(profile.down[n - 1]).toBeLessThan(900);
    expect(profile.along[n - 1]! / 1000).toBeGreaterThan(120);
  });

  it("costs about 10 % of a Dolphin Surf battery from Salzburg, and nothing once past the top", () => {
    const profile = profileFromEdges(real)!;
    const start = climbAhead(profile, 0);
    const kwh = climbKwh(start.up, start.down);
    expect(kwh).toBeGreaterThan(4);
    expect(kwh).toBeLessThan(5);
    const end = climbAhead(profile, profile.along[profile.along.length - 1]!);
    expect(end).toEqual({ up: 0, down: 0 });
  });

  it("takes the climb off the arrival battery (60 %, 17.7 kWh/100 km: flat ~10 %, with the climb nothing left)", () => {
    const car = parseCarState({ mode: "parked", stale: true, age_s: null, drive: { cons50: 17.7 }, battery: { soc: 60, range_km: 185, src: "cloud", cloud_age_min: 1 } }, 1_000)!;
    const flat = batteryEstimate(car, 123_000, 43.2, 1_000)!;
    const profile = profileFromEdges(real)!;
    const climb = climbAhead(profile, 0);
    const steep = batteryEstimate(car, 123_000, 43.2, 1_000, climbKwh(climb.up, climb.down))!;
    expect(flat.arrival).toBeGreaterThanOrEqual(9);
    expect(steep.arrival).toBeLessThan(flat.arrival - 8);
    expect(steep.low).toBe(true);
  });

  it("asks trace_attributes with a simple request and stays flat when the server fails", async () => {
    const shape = [{ lat: 47.8, lon: 13.04 }, { lat: 47.13, lon: 13.81 }];
    const ok = vi.fn(async () => new Response(JSON.stringify({ edges: real }), { status: 200 }));
    expect(await fetchProfile("https://own.example:8481", shape, ok as never)).not.toBeNull();
    const [url, init] = (ok.mock.calls[0] as unknown) as [string, RequestInit];
    expect(url).toBe("https://own.example:8481/trace_attributes");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("text/plain");
    const down = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    expect(await fetchProfile("https://own.example:8481", shape, down as never)).toBeNull();
    expect(buildHeightUrl("")).toBe("");
    expect(buildHeightUrl("https://own.example:8481/")).toBe("https://own.example:8481");
  });
});
