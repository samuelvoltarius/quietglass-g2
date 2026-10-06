import { describe, expect, it } from "vitest";
import { fetchForecast, forecastUrl, parseCoordinate, parseCoordinates } from "../src/rain/api";

const body = {
  current: { time: "2026-10-03T11:00", temperature_2m: 14.5, apparent_temperature: 13.2, relative_humidity_2m: 72, precipitation: 0.2, weather_code: 61, cloud_cover: 80, wind_speed_10m: 18, wind_direction_10m: 225, wind_gusts_10m: 31, is_day: 1 },
  hourly: { time: ["2026-10-03T12:00"], temperature_2m: [15], precipitation_probability: [75], precipitation: [0.8], weather_code: [63], wind_speed_10m: [20] },
  daily: { time: ["2026-10-03"], temperature_2m_min: [8], temperature_2m_max: [18], precipitation_probability_max: [75], weather_code: [61], sunrise: ["2026-10-03T07:08"], sunset: ["2026-10-03T18:42"] },
};

describe("coordinates typed on the phone", () => {
  it("accepts a decimal comma", () => {
    // Regression: "47,8095" became NaN and silently fell back to the default location.
    expect(parseCoordinates("47,8095", " 13,055 ")).toEqual({ latitude: 47.8095, longitude: 13.055 });
  });
  it("rejects missing, blank, and out-of-range values", () => {
    expect(parseCoordinates(null, "13")).toBeNull();
    expect(parseCoordinates("", "13")).toBeNull();
    expect(parseCoordinates("91", "13")).toBeNull();
    expect(parseCoordinates("47", "-181")).toBeNull();
    expect(parseCoordinate("abc", 90)).toBeNull();
  });
  it("treats 0/0 as unset but keeps the equator and the antimeridian", () => {
    expect(parseCoordinates("0", "0")).toBeNull();
    expect(parseCoordinates("0", "13")).toEqual({ latitude: 0, longitude: 13 });
    expect(parseCoordinates("-33.9", "-180")).toEqual({ latitude: -33.9, longitude: -180 });
  });
});

describe("forecastUrl", () => {
  it("asks for three days in the location's own time zone", () => {
    const url = forecastUrl({ latitude: 47.8, longitude: 13.05 });
    expect(url.origin + url.pathname).toBe("https://api.open-meteo.com/v1/forecast");
    expect(url.searchParams.get("latitude")).toBe("47.8");
    expect(url.searchParams.get("forecast_days")).toBe("3");
    expect(url.searchParams.get("timezone")).toBe("auto");
    expect(url.searchParams.get("hourly")?.split(",")).toContain("precipitation_probability");
  });
});

describe("fetchForecast", () => {
  const position = { latitude: 47.8, longitude: 13.05 };

  it("parses a good response", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify(body))) as typeof fetch;
    expect((await fetchForecast(position, { fetchImpl })).current.temperature).toBe(14.5);
  });

  it("reports the HTTP status", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 503 })) as typeof fetch;
    await expect(fetchForecast(position, { fetchImpl })).rejects.toThrow("HTTP 503");
  });

  it("passes parse errors through", async () => {
    const fetchImpl = (async () => new Response("{}")) as typeof fetch;
    await expect(fetchForecast(position, { fetchImpl })).rejects.toThrow("no current weather");
  });

  it("gives up on a request that never answers", async () => {
    // Regression: a stalled fetch left the glasses on "Updating..." forever.
    const fetchImpl = ((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })) as typeof fetch;
    await expect(fetchForecast(position, { fetchImpl, timeoutMs: 10 })).rejects.toThrow("timed out");
  });
});
