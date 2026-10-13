import { describe, expect, it } from "vitest";
import { decodePolyline, type LatLng } from "../src/geo/geometry";
import { buildTraceUrl, createRouteStreetSource, encodePolyline6, parseTrace } from "../src/overview/route-streets";
import {
  buildCorridorUrl, buildNearbyUrl, corridorBoxes, createChargerSource, parseChargers, priceText,
} from "../src/chargers/chargers";

/** A straight line north from Salzburg, `km` long, one point every 100 m. */
const north = (km: number): LatLng[] => Array.from({ length: km * 10 + 1 }, (_, i) => ({ lat: 47.8 + (i * 100) / 111_320, lon: 13.04 }));

describe("street names from your own routing server (trace_attributes)", () => {
  it("encodes the route shape with six decimals, as Valhalla expects", () => {
    const shape = [{ lat: 47.809721, lon: 13.054262 }, { lat: 47.8, lon: 13.06 }, { lat: -33.9, lon: -70.1 }];
    expect(decodePolyline(encodePolyline6(shape), 6)).toEqual(shape);
  });

  it("asks with a plain GET (no preflight) for names, road class and shape indices", () => {
    const url = buildTraceUrl("https://valhalla.test", north(1), "walking");
    expect(url.startsWith("https://valhalla.test/trace_attributes?json=")).toBe(true);
    const request = JSON.parse(decodeURIComponent(url.split("?json=")[1]!));
    expect(request).toMatchObject({ costing: "pedestrian", shape_match: "walk_or_snap" });
    expect(request.filters.attributes).toContain("edge.names");
    expect(decodePolyline(request.encoded_polyline, 6)).toHaveLength(11);
  });

  it("joins consecutive edges of one street and names a road by its ref when it has no name", () => {
    const shape = north(1);
    const answer = { edges: [
      { begin_shape_index: 0, end_shape_index: 2, road_class: "primary", names: ["Vogelweiderstraße", "B150"] },
      { begin_shape_index: 2, end_shape_index: 4, road_class: "primary", names: ["Vogelweiderstraße", "B150"] },
      { begin_shape_index: 4, end_shape_index: 6, road_class: "residential", names: ["Rupertgasse"] },
      { begin_shape_index: 6, end_shape_index: 8, road_class: "service_other", names: [] },
      { begin_shape_index: 8, end_shape_index: 10, road_class: "motorway", names: ["A1"] },
    ] };
    const streets = parseTrace(answer, shape, "driving")!;
    expect(streets.map((s) => [s.cls, s.name ?? null, s.points.length])).toEqual([
      ["major", "Vogelweiderstraße", 5],
      ["minor", "Rupertgasse", 3],
      ["minor", null, 3],
      ["major", "A1", 3],
    ]);
    // On foot, unnamed service ways are paths (never labelled).
    expect(parseTrace(answer, shape, "walking")![2]!.cls).toBe("path");
    expect(parseTrace({ error: "no" }, shape, "driving")).toBeNull();
    // Indices outside the shape are skipped, not guessed at.
    expect(parseTrace({ edges: [{ begin_shape_index: 5, end_shape_index: 99, road_class: "primary", names: ["X"] }] }, shape, "driving")).toEqual([]);
  });

  it("reports failures in the same words as the street source", async () => {
    const source = (status: number | Error) => createRouteStreetSource({
      url: "https://valhalla.test",
      fetchImpl: async () => { if (status instanceof Error) throw status; return new Response("{}", { status }); },
    });
    expect((await source(503).load(north(1), "driving")).error).toBe("busy");
    expect((await source(400).load(north(1), "driving")).error).toBe("server");
    expect((await source(200).load(north(1), "driving")).error).toBe("invalid");
    expect((await source(new TypeError("offline")).load(north(1), "driving")).error).toBe("offline");
    expect(await createRouteStreetSource({ url: "" }).load(north(1), "driving")).toEqual({ streets: [], error: null });
  });
});

describe("charging stations from your own server", () => {
  it("builds GET addresses for nearby and the route corridor", () => {
    expect(buildNearbyUrl("https://ev.test", { lat: 47.80951, lon: 13.05504 })).toBe("https://ev.test/chargers?lat=47.8095&lon=13.0550&radius=15000");
    const url = buildCorridorUrl("https://ev.test", north(50))!;
    // No literal ";" or "," in the query: tailscale serve drops a parameter with a raw ";".
    expect(url.split("?boxes=")[1]).not.toMatch(/[;,]/);
    const boxes = decodeURIComponent(url.split("?boxes=")[1]!).split(";").map((b) => b.split(",").map(Number));
    expect(boxes.length).toBe(corridorBoxes(north(50))!.length);
    // Rounded outwards: never smaller than the exact corridor.
    corridorBoxes(north(50))!.forEach(([s, w, n, e], i) => {
      const [rs, rw, rn, re] = boxes[i]!;
      expect(rs).toBeLessThanOrEqual(s); expect(rw).toBeLessThanOrEqual(w);
      expect(rn).toBeGreaterThanOrEqual(n); expect(re).toBeGreaterThanOrEqual(e);
    });
    expect(buildCorridorUrl("https://ev.test", [])).toBeNull();
  });

  it("asks only the own server, with a plain GET, and reads the price", async () => {
    const asked: Array<{ url: string; init?: RequestInit | undefined }> = [];
    let now = 0;
    const source = createChargerSource({
      endpoint: "https://ev.test/",
      urls: ["https://overpass.test/api/interpreter"],
      clock: () => now,
      fetchImpl: async (url, init) => {
        asked.push({ url: String(url), init });
        return new Response(JSON.stringify({ elements: [{ type: "node", id: "AT*X*E1", lat: 47.8, lon: 13.05, tags: {
          amenity: "charging_station", name: "Ladepark", "charging_station:output": "300 kW", "socket:type2_combo": "4", "x:price_eur_kwh": "0.59",
        } }] }), { status: 200 });
      },
    });
    const outcome = await source.nearby({ lat: 47.8, lon: 13.05 });
    expect(outcome.error).toBeNull();
    expect(outcome.chargers[0]).toMatchObject({ name: "Ladepark", powerKw: 300, combo: 4, priceKwh: 0.59 });
    expect(asked[0]!.url).toBe("https://ev.test/chargers?lat=47.8000&lon=13.0500&radius=15000");
    expect(asked[0]!.init?.method).toBeUndefined();
    expect(asked[0]!.init?.body).toBeUndefined();
    expect(asked[0]!.init?.headers).toBeUndefined();
    // Own server: the next request may go out after 5 s, not 30 s.
    now += 6_000;
    expect((await source.along(north(5))).error).toBeNull();
    expect(asked[1]!.url.startsWith("https://ev.test/chargers?boxes=")).toBe(true);
    expect(asked.every((a) => !a.url.includes("overpass"))).toBe(true);
  });

  it("keeps the error words when the own server fails", async () => {
    const source = (status: number) => createChargerSource({ endpoint: "https://ev.test", fetchImpl: async () => new Response("", { status }) });
    expect((await source(503).nearby({ lat: 1, lon: 1 })).error).toBe("busy");
    expect((await source(401).nearby({ lat: 1, lon: 1 })).error).toBe("server");
  });

  it("prints the price, and ignores a price that cannot be one", () => {
    const [c] = parseChargers({ elements: [{ type: "node", id: 1, lat: 1, lon: 1, tags: { amenity: "charging_station", "x:price_eur_kwh": "0.69" } }] })!;
    expect(priceText(c!, "de")).toBe("0,69 €/kWh");
    expect(priceText(c!, "en")).toBe("0.69 €/kWh");
    const [bad] = parseChargers({ elements: [{ type: "node", id: 2, lat: 1, lon: 1, tags: { amenity: "charging_station", "x:price_eur_kwh": "abc" } }] })!;
    expect(bad!.priceKwh).toBeUndefined();
    expect(priceText(bad!, "de")).toBe("");
  });
});
