import { describe, expect, it, vi } from "vitest";
import { buildOverpassUrl, overpassUrlsFor } from "../src/overpass/own";
import { createStreetSource } from "../src/overview/streets";

const OWN = "https://own.example:8477/api/interpreter";
const PUBLIC = ["https://public.example/api/interpreter"];

describe("own Overpass server (private build)", () => {
  it("takes only http(s) and points at the interpreter", () => {
    expect(buildOverpassUrl("https://own.example:8477/")).toBe(OWN);
    expect(buildOverpassUrl(OWN)).toBe(OWN);
    expect(buildOverpassUrl("")).toBe("");
    expect(buildOverpassUrl("ftp://x")).toBe("");
    expect(buildOverpassUrl(undefined)).toBe("");
  });

  it("is asked first inside Austria, Germany and Italy, never outside", () => {
    const salzburg = { lat: 47.8, lon: 13.04 };
    const hamburg = { lat: 53.55, lon: 9.99 };
    const rome = { lat: 41.9, lon: 12.5 };
    const paris = { lat: 48.86, lon: 2.35 };
    expect(overpassUrlsFor([salzburg, hamburg, rome], PUBLIC, OWN)).toEqual([OWN, ...PUBLIC]);
    expect(overpassUrlsFor([salzburg, paris], PUBLIC, OWN)).toEqual(PUBLIC);
    expect(overpassUrlsFor([salzburg], PUBLIC, "")).toEqual(PUBLIC);
  });

  it("streets: an empty own answer (a corner the boxes cover but the data not) asks the public server", async () => {
    const own = { elements: [] };
    const pub = { elements: [{ type: "way", tags: { highway: "primary", name: "X" }, geometry: [{ lat: 47.8, lon: 13.04 }, { lat: 47.801, lon: 13.041 }] }] };
    const fetchImpl = vi.fn(async (url: string) => new Response(JSON.stringify(url.startsWith("https://own") ? own : pub), { status: 200 }));
    const source = createStreetSource({ fetchImpl: fetchImpl as never, urls: [OWN, ...PUBLIC] });
    const outcome = await source.load({ south: 47.79, west: 13.03, north: 47.81, east: 13.05 }, ["major"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(outcome.error).toBeNull();
  });

  it("the street source falls back to the public list without an own server (public build, tests)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ elements: [] }), { status: 200 }));
    const source = createStreetSource({ fetchImpl: fetchImpl as never });
    await source.load({ south: 47.79, west: 13.03, north: 47.81, east: 13.05 }, ["major"]);
    expect(String((fetchImpl.mock.calls[0] as unknown[])[0])).toContain("overpass-api.de");
  });
});

describe("own Overpass server not reachable (tailnet down, being rebuilt)", () => {
  it("still asks the public servers instead of giving up as offline", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.startsWith("https://own")) throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify({ elements: [] }), { status: 200 });
    });
    const outcome = await createStreetSource({ fetchImpl: fetchImpl as never, ownUrl: OWN }).load({ south: 47.79, west: 13.03, north: 47.81, east: 13.05 }, ["major"]);
    expect(String((fetchImpl.mock.calls[0] as unknown[])[0])).toBe(OWN);
    expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(outcome.error).toBeNull();
  });
});

describe("place search of the private build", () => {
  it("uses the build's own geocoder unless the phone names one", async () => {
    const { geocoderUrlOf, EMPTY_DATA } = await import("../src/storage/persist");
    expect(geocoderUrlOf(EMPTY_DATA, "https://own.example:8479")).toBe("https://own.example:8479");
    expect(geocoderUrlOf({ ...EMPTY_DATA, geocoderUrl: "https://mine.example" }, "https://own.example:8479")).toBe("https://mine.example");
    expect(geocoderUrlOf(EMPTY_DATA, "")).toBe("https://photon.komoot.io");
  });
});
