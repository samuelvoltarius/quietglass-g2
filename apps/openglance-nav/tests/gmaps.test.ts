import { describe, expect, it } from "vitest";
import { googleMapsDirUrl, parseLatLng, parseMapsInput, withMapsLinks } from "../src/geocode/gmaps";
import { googleUrlOf } from "../src/ui/planner";

describe("reading a pasted Google Maps link or coordinates", () => {
  it("takes plain coordinates in the usual spellings", () => {
    expect(parseLatLng("47.80949, 13.05501")).toEqual({ lat: 47.80949, lon: 13.05501 });
    expect(parseLatLng("47.8 13.04")).toEqual({ lat: 47.8, lon: 13.04 });
    expect(parseLatLng("-33.9;-70.1")).toEqual({ lat: -33.9, lon: -70.1 });
    expect(parseLatLng("95.1, 13.0")).toBeNull();
    expect(parseLatLng("12, 3")).toBeNull();
    expect(parseMapsInput("Mirabellplatz Salzburg")).toBeNull();
  });

  it("reads ?q= and ?ll= and ?query= links", () => {
    expect(parseMapsInput("https://maps.google.com/?q=47.80949,13.05501")).toEqual({ kind: "place", at: { lat: 47.80949, lon: 13.05501 } });
    expect(parseMapsInput("https://maps.google.com/maps?ll=47.8,13.04&z=15")).toEqual({ kind: "place", at: { lat: 47.8, lon: 13.04 } });
    expect(parseMapsInput("https://www.google.com/maps/search/?api=1&query=47.5%2C13.1")).toEqual({ kind: "place", at: { lat: 47.5, lon: 13.1 } });
    expect(parseMapsInput("https://www.google.com/maps/search/?api=1&query=Salzburg+Hauptbahnhof")).toEqual({ kind: "query", text: "Salzburg Hauptbahnhof" });
  });

  it("prefers the place pin (!3d!4d) over the map view (@) and keeps the name", () => {
    const link = "https://www.google.com/maps/place/Mirabellgarten/@47.8059,13.0410,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d47.8061234!4d13.0418765!16s";
    expect(parseMapsInput(link)).toEqual({ kind: "place", at: { lat: 47.8061234, lon: 13.0418765 }, label: "Mirabellgarten" });
    expect(parseMapsInput("https://www.google.de/maps/place/Salzburger+Dom/@47.79784,13.04717,17z")).toEqual({
      kind: "place", at: { lat: 47.79784, lon: 13.04717 }, label: "Salzburger Dom",
    });
    expect(parseMapsInput("google.com/maps/@47.1,13.2,12z")).toEqual({ kind: "place", at: { lat: 47.1, lon: 13.2 } });
    expect(parseMapsInput("https://www.google.com/maps/place/Linz")).toEqual({ kind: "query", text: "Linz" });
  });

  it("takes the destination of a directions link", () => {
    expect(parseMapsInput("https://www.google.com/maps/dir/?api=1&origin=47,13&destination=48.2082,16.3738")).toEqual({ kind: "place", at: { lat: 48.2082, lon: 16.3738 } });
    expect(parseMapsInput("https://www.google.com/maps/dir/47.8,13.04/48.30694,14.28583/@48,14,9z")).toEqual({ kind: "place", at: { lat: 48.30694, lon: 14.28583 } });
    const named = "https://www.google.com/maps/dir/Salzburg/Linz/@48,13.6,9z/data=!3m1!4b1!4m13!4m12!1m5!1m1!1s0x0:0x0!2m2!1d13.04!2d47.8!1m5!1m1!1s0x0:0x1!2m2!1d14.2858!2d48.3069";
    expect(parseMapsInput(named)).toEqual({ kind: "place", at: { lat: 48.3069, lon: 14.2858 }, label: "Linz" });
    expect(parseMapsInput("https://www.google.com/maps/dir/Salzburg/Wien+Westbahnhof/")).toEqual({ kind: "query", text: "Wien Westbahnhof" });
  });

  it("recognises short links, which cannot be followed without a server", () => {
    expect(parseMapsInput("https://maps.app.goo.gl/AbCdEf123")).toEqual({ kind: "short" });
    expect(parseMapsInput("https://goo.gl/maps/xyz")).toEqual({ kind: "short" });
  });

  it("leaves other links to the ordinary search", () => {
    expect(parseMapsInput("https://www.openstreetmap.org/#map=15/47.8/13.04")).toBeNull();
    expect(parseMapsInput("https://www.google.com/search?q=47.8,13.04")).toBeNull();
  });
});

describe("search with links", () => {
  it("answers coordinates without asking the search server, searches names, refuses short links", async () => {
    const asked: string[] = [];
    const search = withMapsLinks(async (query) => { asked.push(query); return { places: [], error: "empty" }; });
    const hit = await search("https://maps.google.com/?q=47.80949,13.05501");
    expect(hit).toEqual({ places: [{ label: "47.80949, 13.05501", detail: "", at: { lat: 47.80949, lon: 13.05501 } }], error: null });
    expect((await search("https://www.google.com/maps/place/Salzburger+Dom/@47.79784,13.04717,17z")).places[0]).toMatchObject({ label: "Salzburger Dom", detail: "47.79784, 13.04717" });
    expect(await search("https://maps.app.goo.gl/x")).toEqual({ places: [], error: "shortLink" });
    await search("https://www.google.com/maps/place/Linz");
    await search("Mirabellplatz");
    expect(asked).toEqual(["Linz", "Mirabellplatz"]);
  });
});

describe("opening in Google Maps", () => {
  it("builds a documented Maps URL with stops and the way of travel", () => {
    expect(googleMapsDirUrl({ destination: { lat: 47.8, lon: 13.04 }, mode: "driving" }))
      .toBe("https://www.google.com/maps/dir/?api=1&destination=47.800000,13.040000&travelmode=driving");
    expect(googleMapsDirUrl({
      origin: { lat: 47, lon: 13 }, destination: { lat: 48, lon: 14 }, waypoints: [{ lat: 47.5, lon: 13.5 }, { lat: 47.6, lon: 13.6 }], mode: "cycling",
    })).toBe("https://www.google.com/maps/dir/?api=1&origin=47.000000,13.000000&destination=48.000000,14.000000&waypoints=47.500000,13.500000%7C47.600000,13.600000&travelmode=bicycling");
    const many = Array.from({ length: 12 }, (_, i) => ({ lat: 47 + i / 100, lon: 13 }));
    expect(googleMapsDirUrl({ destination: { lat: 48, lon: 14 }, waypoints: many, mode: "walking" }).split("%7C")).toHaveLength(9);
  });

  it("starts a saved route without a start where the phone is", () => {
    const to = { label: "Ziel", at: { lat: 48, lon: 14 } };
    expect(googleUrlOf(null, [], to, "walking")).toBe("https://www.google.com/maps/dir/?api=1&destination=48.000000,14.000000&travelmode=walking");
  });
});
