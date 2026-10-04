import { describe, expect, it } from "vitest";
import { parseOpenMeteo, weatherKind, windCompass } from "../src/rain/model";

const response = {
  current: { time: "2026-10-03T11:00", temperature_2m: 14.5, apparent_temperature: 13.2, relative_humidity_2m: 72, precipitation: 0.2, weather_code: 61, cloud_cover: 80, wind_speed_10m: 18, wind_direction_10m: 225, wind_gusts_10m: 31, is_day: 1 },
  hourly: { time: ["2026-10-03T10:00", "2026-10-03T11:00", "2026-10-03T12:00"], temperature_2m: [13, 14.5, 15], precipitation_probability: [20, 60, 75], precipitation: [0, 0.2, 0.8], weather_code: [3, 61, 63], wind_speed_10m: [15, 18, 20] },
  daily: { time: ["2026-10-03"], temperature_2m_min: [8], temperature_2m_max: [18], precipitation_probability_max: [75], weather_code: [61], sunrise: ["2026-10-03T07:08"], sunset: ["2026-10-03T18:42"] },
};

describe("weather model", () => {
  it("parses current, future hourly, and daily weather", () => { const weather = parseOpenMeteo(response); expect(weather.current.temperature).toBe(14.5); expect(weather.hourly.map((hour) => hour.time)).toEqual(["2026-10-03T11:00", "2026-10-03T12:00"]); expect(weather.daily[0]?.maximum).toBe(18); });
  it("maps WMO weather codes to useful groups", () => { expect([weatherKind(0), weatherKind(45), weatherKind(63), weatherKind(75), weatherKind(95)]).toEqual(["clear", "fog", "rain", "snow", "storm"]); });
  it("normalizes wind direction to eight compass points", () => { expect(windCompass(225)).toBe("SW"); expect(windCompass(370)).toBe("N"); expect(windCompass(-90)).toBe("W"); });
});
