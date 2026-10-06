import { describe, expect, it } from "vitest";
import { BODY_ROWS, LINE_WIDTH, escapeHtml, fit, glassesBody, parseOpenMeteo } from "../src/rain/model";

function response(currentTime: string) {
  return {
    current: { time: currentTime, temperature_2m: 14.5, apparent_temperature: 13.2, relative_humidity_2m: 72, precipitation: 0.2, weather_code: 61, cloud_cover: 80, wind_speed_10m: 18, wind_direction_10m: 225, wind_gusts_10m: 31, is_day: 1 },
    hourly: { time: ["2026-10-03T10:00", "2026-10-03T11:00", "2026-10-03T12:00"], temperature_2m: [13, 14.5, 15], precipitation_probability: [20, 60, 75], precipitation: [0, 0.2, 0.8], weather_code: [3, 61, 63], wind_speed_10m: [15, 18, 20] },
    daily: { time: ["2026-10-03"], temperature_2m_min: [8], temperature_2m_max: [18], precipitation_probability_max: [75], weather_code: [61], sunrise: ["2026-10-03T07:08"], sunset: ["2026-10-03T18:42"] },
  };
}

describe("hourly list with quarter-hour current times", () => {
  it("keeps the current hour when current.time is 11:15", () => {
    // Regression: "2026-10-03T11:00" < "2026-10-03T11:15" dropped the 11:00 hour.
    expect(parseOpenMeteo(response("2026-10-03T11:15")).hourly.map((hour) => hour.time)).toEqual(["2026-10-03T11:00", "2026-10-03T12:00"]);
    expect(parseOpenMeteo(response("2026-10-03T11:45")).hourly[0]?.time).toBe("2026-10-03T11:00");
  });
});

describe("glasses body", () => {
  const page = ["CLOUDY  15°", "Feels 13°   Humidity 72%", "Wind SW 18 km/h   Gusts 31", "Rain 0.2 mm   Clouds 80%", "High / Low 18° / 8°", "Sun 07:08 - 18:42"];
  it("keeps a long error on one row within seven rows", () => {
    // Regression: a long error wrapped into an eighth row and was clipped.
    const body = glassesBody(page, "Failed to fetch because the network connection was lost while loading api.open-meteo.com");
    expect(body).toHaveLength(BODY_ROWS);
    expect(body.every((line) => Array.from(line).length <= LINE_WIDTH)).toBe(true);
    expect(body.at(-1)?.startsWith("! Failed to fetch")).toBe(true);
    expect(body.at(-1)?.endsWith("…")).toBe(true);
  });
  it("gives the error row priority over a seventh page line", () => {
    const body = glassesBody([...page, "extra"], "timed out");
    expect(body).toEqual([...page, "! timed out"]);
  });
  it("leaves short lines and their column spacing untouched", () => {
    expect(glassesBody(["14:00  15°  Cloudy     60%"])).toEqual(["14:00  15°  Cloudy     60%"]);
    expect(fit("abcdef", 4)).toBe("abc…");
  });
});

describe("escapeHtml", () => {
  it("neutralises markup in errors and stored coordinates", () => {
    // Regression: the error message and stored lat/lon went into the phone HTML unescaped.
    expect(escapeHtml(`47"><img src=x onerror=alert(1)>&'`)).toBe("47&quot;&gt;&lt;img src=x onerror=alert(1)&gt;&amp;&#39;");
  });
});
