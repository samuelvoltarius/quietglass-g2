import { describe, expect, it } from "vitest";
import { locales, tr } from "../src/i18n";
import { messages } from "../src/messages";
import { geocodeUrl, parsePlaces, parseSavedPlace, searchPlaces, usableQuery } from "../src/rain/geocode";
import { errorKey, noticeKey, resolveLocation, storedMode, storedSources, type LocationSources } from "../src/rain/location";
import { BODY_ROWS, LINE_WIDTH, glassesBody } from "../src/rain/model";
import app from "../app.json";

const vars = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? "").sort();
const width = (text: string): number => Array.from(text).length;

describe("messages", () => {
  const keys = Object.keys(messages.de).sort();
  it.each(locales)("%s has every key, nothing extra, no blanks", (locale) => {
    expect(Object.keys(messages[locale]).sort()).toEqual(keys);
    for (const key of keys) expect(messages[locale][key]?.trim(), `${locale}.${key}`).toBeTruthy();
  });
  it.each(locales)("%s uses the same placeholders as German", (locale) => {
    for (const key of keys) expect(vars(messages[locale][key] ?? ""), `${locale}.${key}`).toEqual(vars(messages.de[key] ?? ""));
  });
  it.each(locales)("%s glasses notices fit seven rows of the icon column", (locale) => {
    for (const key of ["glassLoading", "glassNoLocation", "glassOffline"]) {
      const lines = tr(messages, locale, key).split("\n");
      expect(lines.length, `${locale}.${key}`).toBeLessThanOrEqual(BODY_ROWS);
      for (const line of lines) expect(width(line), `${locale}.${key}: ${line}`).toBeLessThanOrEqual(LINE_WIDTH);
      expect(glassesBody(lines)).toEqual(lines);
    }
  });
  it.each(locales)("%s error rows fit one glasses row uncut", (locale) => {
    for (const key of ["errorTimeout", "errorServer", "errorOffline", "errorData"]) expect(width(`! ${tr(messages, locale, key, { status: "503" })}`), `${locale}.${key}`).toBeLessThanOrEqual(LINE_WIDTH);
  });
  it.each(locales)("%s header and footer fit the full width", (locale) => {
    for (const page of ["now", "hourly", "days"]) expect(width(`RAINLENS  ${tr(messages, locale, page)}  ${tr(messages, locale, "sampleTag")}`)).toBeLessThanOrEqual(46);
    expect(width(tr(messages, locale, "controls"))).toBeLessThanOrEqual(46);
  });
  it("keeps jargon out of the German main screen", () => {
    const advanced = new Set(["latitude", "longitude", "useCoords", "help", "badCoords", "credits", "advanced"]);
    for (const [key, text] of Object.entries(messages.de)) if (!advanced.has(key)) expect(text, key).not.toMatch(/lat\/lon|Koordinat|Breitengrad|Längengrad|Endpoint|API|CORS|Fallback|Demo/i);
  });
  it("writes real umlauts in German", () => {
    const all = Object.values(messages.de).join(" ");
    expect(all).toMatch(/ü|ö|ä/); expect(all).not.toMatch(/\b(fuer|Groesse|Laengengrad|Boeen|pruefe)\b/i);
  });
  it("tells a first-time user without location what to do", () => {
    expect(messages.de.nextNoLocation).toContain("erlaube den Standort in der Even-App oder gib unten einen Ort ein");
  });
});

describe("place search", () => {
  const hallein = { results: [{ id: 2776951, name: "Hallein", latitude: 47.68333, longitude: 13.1, country: "Österreich", admin1: "Land Salzburg" }, { name: "broken" }] };
  it("builds a keyless request in the user's language", () => {
    const url = geocodeUrl("Hallein", "de");
    expect(url.origin + url.pathname).toBe("https://geocoding-api.open-meteo.com/v1/search");
    expect(Object.fromEntries(url.searchParams)).toEqual({ name: "Hallein", count: "5", language: "de", format: "json" });
  });
  it("labels results so places with the same name can be told apart", () => {
    expect(parsePlaces(hallein)).toEqual([{ name: "Hallein", label: "Hallein, Land Salzburg, Österreich", latitude: 47.68333, longitude: 13.1 }]);
    expect(parsePlaces({ generationtime_ms: 0.4 })).toEqual([]);
    expect(parsePlaces(null)).toEqual([]);
  });
  it("searches with a mocked fetch and skips one-letter queries", async () => {
    const asked: string[] = [];
    const fetchImpl = (async (url: URL | RequestInfo) => { asked.push(String(url)); return new Response(JSON.stringify(hallein)); }) as typeof fetch;
    expect((await searchPlaces("  Hallein ", "de", { fetchImpl }))[0]?.label).toBe("Hallein, Land Salzburg, Österreich");
    expect(await searchPlaces("H", "de", { fetchImpl })).toEqual([]);
    expect(asked).toHaveLength(1);
    expect(usableQuery(" 50 ")).toBe("50");
  });
  it("throws on HTTP errors and timeouts instead of claiming nothing was found", async () => {
    await expect(searchPlaces("Wien", "de", { fetchImpl: (async () => new Response("", { status: 502 })) as typeof fetch })).rejects.toThrow("HTTP 502");
    const stalled = ((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))); })) as typeof fetch;
    await expect(searchPlaces("Wien", "de", { fetchImpl: stalled, timeoutMs: 5 })).rejects.toThrow("timed out");
  });
  it("reads a saved place and ignores junk", () => {
    expect(parseSavedPlace(JSON.stringify({ name: "Hallein", label: "Hallein, Österreich", latitude: 47.68, longitude: 13.1 }))?.label).toBe("Hallein, Österreich");
    expect(parseSavedPlace("{nope")).toBeNull();
    expect(parseSavedPlace(JSON.stringify({ name: "x" }))).toBeNull();
    expect(parseSavedPlace(null)).toBeNull();
  });
});

describe("where the forecast is for", () => {
  const place = { name: "Hallein", label: "Hallein, Österreich", latitude: 47.68, longitude: 13.1 };
  const sources = (over: Partial<LocationSources>): LocationSources => ({ mode: "phone", phoneFix: async () => null, place: null, manual: null, ...over });
  it("uses the phone first by default", async () => {
    expect(await resolveLocation(sources({ phoneFix: async () => ({ latitude: 48.2, longitude: 16.37 }), place }))).toEqual({ position: { latitude: 48.2, longitude: 16.37 }, kind: "phone", label: null });
  });
  it("falls back to the typed place when location is denied", async () => {
    expect((await resolveLocation(sources({ phoneFix: async () => { throw new Error("denied"); }, place })))?.kind).toBe("place");
  });
  it("prefers a chosen place over the phone", async () => {
    let asked = false;
    expect((await resolveLocation(sources({ mode: "place", place, phoneFix: async () => { asked = true; return { latitude: 1, longitude: 1 }; } })))?.label).toBe("Hallein");
    expect(asked).toBe(false);
  });
  it("never invents a location", async () => {
    // Regression: with no location the app silently showed Salzburg as LIVE.
    expect(await resolveLocation(sources({}))).toBeNull();
    expect(await resolveLocation(sources({ mode: "manual" }))).toBeNull();
  });
  it("migrates the old automatic/coordinates switch", () => {
    const store = (values: Record<string, string>) => ({ getItem: (key: string) => values[key] ?? null });
    expect(storedMode(store({}))).toBe("phone");
    expect(storedMode(store({ "rainlens.auto": "false" }))).toBe("manual");
    expect(storedMode(store({ "rainlens.mode": "place", "rainlens.auto": "false" }))).toBe("place");
    expect(storedSources(store({ "rainlens.lat": "47,8", "rainlens.lon": "13,05" }), async () => null).manual).toEqual({ latitude: 47.8, longitude: 13.05 });
  });
});

describe("first-run and error states", () => {
  it("shows an instruction instead of sample numbers until there is a real forecast", () => {
    expect(noticeKey("loading", "demo")).toBe("glassLoading");
    expect(noticeKey("noLocation", "demo")).toBe("glassNoLocation");
    expect(noticeKey("offline", "demo")).toBe("glassOffline");
    expect(noticeKey("offline", "live")).toBeNull();
    expect(noticeKey("live", "live")).toBeNull();
  });
  it("turns failures into something a user can act on", () => {
    expect(errorKey(new Error("timed out"))).toEqual({ key: "errorTimeout" });
    expect(errorKey(new Error("HTTP 503"))).toEqual({ key: "errorServer", status: "503" });
    expect(errorKey(new TypeError("Failed to fetch"))).toEqual({ key: "errorOffline" });
    expect(errorKey(new Error("forecast has no current weather"))).toEqual({ key: "errorData" });
  });
});

describe("app.json", () => {
  const manifest = app as unknown as { permissions: { name: string; whitelist?: string[] }[]; supported_languages: string[] };
  it("asks for location and allows both Open-Meteo hosts", () => {
    expect(manifest.permissions.map((permission) => permission.name).sort()).toEqual(["location", "network"]);
    expect(manifest.permissions.find((permission) => permission.name === "network")?.whitelist).toEqual(["https://api.open-meteo.com", "https://geocoding-api.open-meteo.com"]);
    expect(manifest.supported_languages).toEqual([...locales]);
  });
});
