import { describe, expect, it, vi } from "vitest";
import {
  CLIENT_ID, DEFAULT_ROUTER_URL, clientIdFor, codeForStatus, createValhallaProvider, errorCodeOf, parseValhalla,
} from "../src/routing/provider";
import { createRequestGate, mayAutoReroute, MIN_AUTO_REROUTE_INTERVAL_MS, MIN_REQUEST_INTERVAL_MS } from "../src/routing/throttle";
import {
  DEFAULT_GEOCODER_URL, buildSearchUrl, createGeocoder, parsePhoton,
} from "../src/geocode/photon";
import { EMPTY_DATA, geocoderUrlOf, parseData, routerUrlOf } from "../src/storage/persist";

const FROM = { lat: 47.805, lon: 13.042 };
const TO = { lat: 47.815, lon: 13.048 };

describe("works right after install", () => {
  it("routes through the public FOSSGIS server when no server is entered", () => {
    expect(routerUrlOf(EMPTY_DATA)).toBe("https://valhalla1.openstreetmap.de");
    expect(routerUrlOf({ ...EMPTY_DATA, valhallaUrl: " https://my.example " })).toBe("https://my.example");
  });

  it("searches through public Photon when no search server is entered", () => {
    expect(geocoderUrlOf(EMPTY_DATA)).toBe("https://photon.komoot.io");
    expect(geocoderUrlOf({ ...EMPTY_DATA, geocoderUrl: "https://photon.mine" })).toBe("https://photon.mine");
  });

  it("starts on foot, with the turn arrow and no demo route", () => {
    expect(EMPTY_DATA.mode).toBe("walking");
    expect(EMPTY_DATA.glassView).toBe("turns");
    expect(EMPTY_DATA.demo).toBe(false);
  });

  it("reads the new settings back and ignores garbage", () => {
    const parsed = parseData(JSON.stringify({ demo: true, glassView: "overview", geocoderUrl: "https://p.example" }));
    expect(parsed).toMatchObject({ demo: true, glassView: "overview", geocoderUrl: "https://p.example" });
    const junk = parseData(JSON.stringify({ demo: "yes", glassView: "map", geocoderUrl: "ftp://x" }));
    expect(junk).toMatchObject({ demo: false, glassView: "turns", geocoderUrl: "" });
  });
});

describe("talking to the public router politely", () => {
  it("identifies OpenGlance to the FOSSGIS server only", () => {
    // A browser cannot set User-Agent; FOSSGIS allows X-Client-Id in its CORS preflight.
    expect(clientIdFor(DEFAULT_ROUTER_URL)).toBe(CLIENT_ID);
    expect(clientIdFor("https://valhalla.example")).toBeUndefined();
    expect(clientIdFor("not a url")).toBeUndefined();
  });

  it("sends the client id and the user's language", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers["X-Client-Id"]).toBe(CLIENT_ID);
      expect(JSON.parse(String(init?.body)).directions_options.language).toBe("de-DE");
      return new Response(JSON.stringify({ error: "x" }), { status: 200 });
    });
    await createValhallaProvider({ url: DEFAULT_ROUTER_URL, clientId: CLIENT_ID, language: "de-DE", fetchImpl: fetchImpl as never })
      .route({ from: FROM, to: TO, mode: "walking" });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("sends no extra header to a self-hosted server", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(Object.keys(init?.headers as Record<string, string>)).toEqual(["Content-Type"]);
      return new Response("{}", { status: 200 });
    });
    await createValhallaProvider({ url: "http://pi.local:8002", fetchImpl: fetchImpl as never }).route({ from: FROM, to: TO, mode: "driving" });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("turns a Valhalla 400 into 'no way found' and keeps the router's reason", async () => {
    const fetchImpl = async (): Promise<Response> =>
      new Response(JSON.stringify({ error_code: 442, error: "No path could be found for input" }), { status: 400 });
    const outcome = await createValhallaProvider({ url: "https://v.example", fetchImpl: fetchImpl as never }).route({ from: FROM, to: TO, mode: "walking" });
    expect(outcome.code).toBe("noRoute");
    expect(outcome.error).toContain("No path");
  });

  it("says when the destination is too far for the chosen way of travel", async () => {
    // Real answer from valhalla1.openstreetmap.de for a 3000 km walk.
    const fetchImpl = async (): Promise<Response> => new Response(JSON.stringify({
      error_code: 154, error: "Path distance exceeds the max distance limit: 100000 meters", status_code: 400,
    }), { status: 400 });
    const outcome = await createValhallaProvider({ url: "https://v.example", fetchImpl: fetchImpl as never }).route({ from: FROM, to: TO, mode: "walking" });
    expect(outcome.code).toBe("tooFar");
  });

  it("reports the rate limit as busy, not as a broken server", async () => {
    const fetchImpl = async (): Promise<Response> => new Response("Too Many Requests", { status: 429 });
    const outcome = await createValhallaProvider({ url: "https://v.example", fetchImpl: fetchImpl as never }).route({ from: FROM, to: TO, mode: "walking" });
    expect(outcome).toMatchObject({ route: null, code: "busy", error: "HTTP 429" });
  });

  it("maps statuses and transport failures to plain reasons", () => {
    expect(codeForStatus(503)).toBe("busy");
    expect(codeForStatus(504)).toBe("timeout");
    expect(codeForStatus(404)).toBe("noRoute");
    expect(codeForStatus(500)).toBe("server");
    expect(errorCodeOf(new TypeError("Failed to fetch"))).toBe("offline");
    expect(errorCodeOf(new DOMException("x", "AbortError"))).toBe("timeout");
    expect(errorCodeOf(new Error("??"))).toBe("server");
  });

  it("gives every parse failure a reason code", () => {
    expect(parseValhalla(null).code).toBe("server");
    expect(parseValhalla({ error: "No suitable edges near location" }).code).toBe("noRoute");
    expect(parseValhalla({ trip: { legs: [] } }).code).toBe("noRoute");
  });
});

describe("request pacing", () => {
  it("never sends two router requests within one second", async () => {
    let now = 0;
    const waits: number[] = [];
    const gate = createRequestGate(MIN_REQUEST_INTERVAL_MS, () => now, async (ms) => { waits.push(ms); now += ms; });
    await gate.ready();
    await gate.ready();
    now += 5_000;
    await gate.ready();
    expect(waits).toEqual([MIN_REQUEST_INTERVAL_MS]);
    expect(MIN_REQUEST_INTERVAL_MS).toBeGreaterThanOrEqual(1_000);
  });

  it("books separate slots for requests that arrive together", async () => {
    const now = 0;
    const waits: number[] = [];
    const gate = createRequestGate(1_000, () => now, async (ms) => { waits.push(ms); });
    await Promise.all([gate.ready(), gate.ready(), gate.ready()]);
    expect(waits).toEqual([1_000, 2_000]);
  });

  it("spaces automatic reroutes out", () => {
    expect(mayAutoReroute(null, 0)).toBe(true);
    expect(mayAutoReroute(1_000, 1_000 + MIN_AUTO_REROUTE_INTERVAL_MS - 1)).toBe(false);
    expect(mayAutoReroute(1_000, 1_000 + MIN_AUTO_REROUTE_INTERVAL_MS)).toBe(true);
    expect(MIN_AUTO_REROUTE_INTERVAL_MS).toBeGreaterThanOrEqual(10_000);
  });
});

const PHOTON_ANSWER = {
  type: "FeatureCollection",
  features: [
    { geometry: { coordinates: [13.0432146, 47.8051808] }, properties: { name: "Mirabellplatz", city: "Salzburg", country: "Österreich", postcode: "5020" } },
    { geometry: { coordinates: [13.04, 47.81] }, properties: { street: "Linzer Gasse", housenumber: "12", city: "Salzburg", country: "Österreich" } },
    { geometry: { coordinates: [200, 47] }, properties: { name: "Impossible" } },
    { geometry: { coordinates: [13, 47] }, properties: {} },
    { properties: { name: "No geometry" } },
  ],
};

describe("place search", () => {
  it("builds a Photon query with a rough position and a supported language", () => {
    const url = new URL(buildSearchUrl(DEFAULT_GEOCODER_URL + "/", "  Mirabellplatz ", { lang: "de", near: { lat: 47.805123, lon: 13.042987 } }));
    expect(url.origin + url.pathname).toBe("https://photon.komoot.io/api/");
    expect(url.searchParams.get("q")).toBe("Mirabellplatz");
    expect(url.searchParams.get("lang")).toBe("de");
    // Rounded to about a kilometre: enough for ranking, not a precise position.
    expect(url.searchParams.get("lat")).toBe("47.81");
    expect(url.searchParams.get("lon")).toBe("13.04");
  });

  it("leaves out languages Photon rejects", () => {
    // photon.komoot.io answers 400 to lang=it.
    expect(new URL(buildSearchUrl(DEFAULT_GEOCODER_URL, "Roma", { lang: "it" })).searchParams.has("lang")).toBe(false);
  });

  it("reads names, addresses and places, skipping anything malformed", () => {
    const places = parsePhoton(PHOTON_ANSWER);
    expect(places).toEqual([
      { label: "Mirabellplatz", detail: "5020 Salzburg, Österreich", at: { lat: 47.8051808, lon: 13.0432146 } },
      { label: "Linzer Gasse 12", detail: "Salzburg, Österreich", at: { lat: 47.81, lon: 13.04 } },
    ]);
    expect(parsePhoton(null)).toEqual([]);
    expect(parsePhoton({ features: "no" })).toEqual([]);
  });

  it("does not search for one or two letters", async () => {
    const fetchImpl = vi.fn();
    const outcome = await createGeocoder({ url: DEFAULT_GEOCODER_URL, fetchImpl: fetchImpl as never }).search("ab");
    expect(outcome.error).toBe("short");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("answers a repeated search from memory instead of asking again", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(PHOTON_ANSWER), { status: 200 }));
    const geocoder = createGeocoder({ url: DEFAULT_GEOCODER_URL, fetchImpl: fetchImpl as never, minIntervalMs: 0 });
    const first = await geocoder.search("Mirabellplatz");
    const second = await geocoder.search(" Mirabellplatz ");
    expect(first.places).toHaveLength(2);
    expect(second).toEqual(first);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("says nothing was found, rather than failing silently", async () => {
    const fetchImpl = async (): Promise<Response> => new Response(JSON.stringify({ features: [] }), { status: 200 });
    expect((await createGeocoder({ url: DEFAULT_GEOCODER_URL, fetchImpl: fetchImpl as never }).search("Xyzzyplatz")).error).toBe("empty");
  });

  it("maps search failures to plain reasons", async () => {
    const run = (fetchImpl: () => Promise<Response>) =>
      createGeocoder({ url: DEFAULT_GEOCODER_URL, fetchImpl: fetchImpl as never, minIntervalMs: 0 }).search("Salzburg");
    expect((await run(async () => new Response("", { status: 429 }))).error).toBe("busy");
    expect((await run(async () => new Response("", { status: 500 }))).error).toBe("server");
    expect((await run(async () => { throw new TypeError("Failed to fetch"); })).error).toBe("offline");
    expect((await run(async () => { throw new DOMException("x", "AbortError"); })).error).toBe("timeout");
  });
});
