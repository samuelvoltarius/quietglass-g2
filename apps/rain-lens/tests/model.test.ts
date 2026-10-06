import { describe, expect, it } from "vitest";
import { clock, dayName, demoWeather, parseOpenMeteo, weatherKind, windCompass } from "../src/rain/model";

function response() {
  return {
    current: { time: "2026-10-03T11:00", temperature_2m: 14.5, apparent_temperature: 13.2, relative_humidity_2m: 72, precipitation: 0.2, weather_code: 61, cloud_cover: 80, wind_speed_10m: 18, wind_direction_10m: 225, wind_gusts_10m: 31, is_day: 1 } as Record<string, unknown>,
    hourly: { time: ["2026-10-03T10:00", "2026-10-03T11:00", "2026-10-03T12:00"], temperature_2m: [13, 14.5, 15], precipitation_probability: [20, 60, 75], precipitation: [0, 0.2, 0.8], weather_code: [3, 61, 63], wind_speed_10m: [15, 18, 20] } as Record<string, unknown>,
    daily: { time: ["2026-10-03", "2026-10-04"], temperature_2m_min: [8, 9], temperature_2m_max: [18, 19], precipitation_probability_max: [75, 10], weather_code: [61, 1], sunrise: ["2026-10-03T07:08", "2026-10-04T07:09"], sunset: ["2026-10-03T18:42", "2026-10-04T18:40"] } as Record<string, unknown>,
  };
}

describe("parseOpenMeteo", () => {
  it("reads every current field and the day flag", () => {
    const weather = parseOpenMeteo(response());
    expect(weather.current).toMatchObject({ feelsLike: 13.2, humidity: 72, weatherCode: 61, windDirection: 225, windGusts: 31, isDay: true });
    expect(weather.source).toBe("live");
  });

  it("treats is_day 0 as night", () => {
    const value = response(); value.current.is_day = 0;
    expect(parseOpenMeteo(value).current.isDay).toBe(false);
  });

  it("rejects a response without current weather", () => {
    expect(() => parseOpenMeteo({})).toThrow("no current weather");
    expect(() => parseOpenMeteo(null)).toThrow("no current weather");
  });

  it("names the missing current field", () => {
    const value = response(); delete value.current.wind_gusts_10m;
    expect(() => parseOpenMeteo(value)).toThrow("wind_gusts_10m");
  });

  it("does not turn a null current field into zero degrees", () => {
    // Regression: Number(null) === 0 made a missing temperature read as 0°.
    const value = response(); value.current.temperature_2m = null;
    expect(() => parseOpenMeteo(value)).toThrow("temperature_2m");
  });

  it("skips an hour whose rain chance is null instead of showing 0%", () => {
    // Regression: Open-Meteo sends null outside a model's range; it used to pass as 0.
    const value = response(); value.hourly.precipitation_probability = [20, null, 75];
    expect(parseOpenMeteo(value).hourly.map((hour) => hour.time)).toEqual(["2026-10-03T12:00"]);
  });

  it("accepts numeric strings", () => {
    const value = response(); value.current.temperature_2m = "14.5";
    expect(parseOpenMeteo(value).current.temperature).toBe(14.5);
  });

  it("caps the hourly list at twelve entries", () => {
    const value = response();
    const times = Array.from({ length: 20 }, (_, index) => `2026-10-0${3 + Math.floor((11 + index) / 24)}T${String((11 + index) % 24).padStart(2, "0")}:00`);
    value.hourly = { time: times, temperature_2m: times.map(() => 10), precipitation_probability: times.map(() => 0), precipitation: times.map(() => 0), weather_code: times.map(() => 0), wind_speed_10m: times.map(() => 5) };
    expect(parseOpenMeteo(value).hourly).toHaveLength(12);
  });

  it("fails when no hour lies in the future", () => {
    const value = response(); value.hourly = { ...value.hourly, time: ["2026-10-03T09:00", "2026-10-03T10:00"] };
    expect(() => parseOpenMeteo(value)).toThrow("no hourly weather");
  });

  it("skips malformed days and fails when none remain", () => {
    const value = response(); value.daily.temperature_2m_min = [null, 9];
    expect(parseOpenMeteo(value).daily.map((day) => day.date)).toEqual(["2026-10-04"]);
    value.daily.temperature_2m_min = [null, null];
    expect(() => parseOpenMeteo(value)).toThrow("no daily weather");
  });

  it("keeps at most three days", () => {
    const value = response();
    value.daily = { time: ["a", "b", "c", "d"], temperature_2m_min: [1, 2, 3, 4], temperature_2m_max: [5, 6, 7, 8], precipitation_probability_max: [0, 0, 0, 0], weather_code: [0, 0, 0, 0], sunrise: ["s", "s", "s", "s"], sunset: ["t", "t", "t", "t"] };
    expect(parseOpenMeteo(value).daily.map((day) => day.date)).toEqual(["a", "b", "c"]);
  });
});

describe("weatherKind", () => {
  it("covers drizzle, freezing rain and showers as rain", () => {
    expect([51, 56, 67, 80, 82].map(weatherKind)).toEqual(["rain", "rain", "rain", "rain", "rain"]);
  });
  it("covers snow showers and hail storms", () => {
    expect([71, 77, 85, 86, 96, 99].map(weatherKind)).toEqual(["snow", "snow", "snow", "snow", "storm", "storm"]);
  });
  it("falls back to cloud for unknown codes", () => {
    expect([4, 50, 68, 90, -1].map(weatherKind)).toEqual(["cloud", "cloud", "cloud", "cloud", "cloud"]);
  });
});

describe("windCompass", () => {
  it("rounds to the nearest point at the boundaries", () => {
    expect([22, 23, 337, 338, 359, 720].map(windCompass)).toEqual(["N", "NE", "NW", "N", "N", "N"]);
  });
  it("survives NaN", () => { expect(windCompass(Number.NaN)).toBe("N"); });
});

describe("clock and dayName", () => {
  it("formats a local time and degrades on garbage", () => {
    expect(clock("2026-10-03T07:08", "de-AT")).toBe("07:08");
    expect(clock("not a time")).toBe("--:--");
  });
  it("names the weekday of a calendar date", () => {
    expect(dayName("2026-10-05", "en")).toBe("Mon");
    expect(dayName("garbage")).toBe("---");
  });
});

describe("demoWeather", () => {
  it("offers twelve whole hours starting at the current hour", () => {
    const demo = demoWeather(new Date(2026, 9, 3, 14, 37));
    expect(demo.source).toBe("demo");
    expect(demo.hourly).toHaveLength(12);
    const first = new Date(demo.hourly[0]!.time);
    expect([first.getHours(), first.getMinutes()]).toEqual([14, 0]);
  });
});
