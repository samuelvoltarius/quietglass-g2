import { describe, expect, it, vi } from "vitest";
import { locales, type Locale } from "../src/i18n";
import { parseStatus, type StationWeather } from "../src/nina/status";
import { alerts } from "../src/nina/alerts";
import { fetchForecast, forecastUrl, parseForecast, samePlace, type Forecast, type HourPoint } from "../src/weather/forecast";
import { demoForecast } from "../src/weather/demo";
import {
  DEFAULT_THRESHOLDS, POPUP_COOLDOWN_MS, EMPTY_TRACKER, clampThresholds, clockText, evaluateWeather, inMinutes, skyWindow, trackWarnings, valueAt, cloudOf,
  type WeatherInput, type WeatherWarning,
} from "../src/weather/warnings";
import { cloudChart, CLOUD_CHART_HEIGHT, CLOUD_CHART_WIDTH } from "../src/glasses/charts";
import { bitmapKey } from "../src/glasses/gfx";
import { NO_WEATHER, warningText, type ViewState, type WeatherView } from "../src/glasses/views";
import { cockpitModel } from "../src/cockpit/model";
import { CELL_WIDTH, cellValueLayout, headlineLayout } from "../src/cockpit/compose";
import { pixelBackend } from "../src/screen/text";
import { parseSettings } from "../src/storage/persist";

const H = 3_600_000;
const MIN = 60_000;
/** 13 Oct 2026, 20:00 UTC (22:00 in Salzburg). */
const T0 = Date.UTC(2026, 9, 13, 20, 0);
const NOW = T0 + 20 * MIN;

const hour = (i: number, over: Partial<HourPoint> = {}): HourPoint => ({
  time: T0 + (i - 1) * H, cloud: 10, cloudLow: 0, cloudMid: 5, cloudHigh: 10, rainProb: 0, rain: 0,
  humidity: 60, dewPoint: 0, temp: 8, wind: 8, gust: 12, ...over,
});

/** 19:00 .. 08:00 UTC, clear unless changed. */
const forecastOf = (changes: Record<number, Partial<HourPoint>> = {}): Forecast => ({
  fetchedAt: NOW, position: { latitude: 47.8, longitude: 13.04 },
  hours: Array.from({ length: 14 }, (_, i) => hour(i, changes[i] ?? {})),
});

const input = (forecast: Forecast | null, station: StationWeather | null = null, now = NOW): WeatherInput => ({ now, forecast, station, thresholds: DEFAULT_THRESHOLDS });

const station = (over: Partial<StationWeather> = {}): StationWeather => ({
  name: "AAG", cloudCover: null, rainRate: null, humidity: null, dewPoint: null, temperature: null, windSpeed: null, windGust: null, skyQuality: null, ...over,
});

/** An Open-Meteo answer as the API sends it with timeformat=unixtime. */
const openMeteo = {
  latitude: 47.8, longitude: 13.04, utc_offset_seconds: 0, timezone: "GMT",
  hourly_units: { time: "unixtime", cloud_cover: "%" },
  hourly: {
    time: [T0 / 1000 - 3600, T0 / 1000, T0 / 1000 + 3600, T0 / 1000 + 7200],
    cloud_cover: [5, 20, 75, 90],
    cloud_cover_low: [0, 0, 40, 60],
    cloud_cover_mid: [0, 10, 50, 70],
    cloud_cover_high: [5, 20, 30, 40],
    precipitation_probability: [0, 5, 20, 45],
    precipitation: [0, 0, 0, 0.4],
    relative_humidity_2m: [70, 75, 80, 90],
    dew_point_2m: [2, 2.5, 3, 4],
    temperature_2m: [8, 7, 6, 5],
    wind_speed_10m: [5, 8, 12, 20],
    wind_gusts_10m: [10, 15, 25, 38],
  },
};

describe("Open-Meteo request and answer", () => {
  it("asks for the hourly fields of the next hours at coordinates rounded to 2 decimals", () => {
    const url = new URL(forecastUrl({ latitude: 47.809512, longitude: 13.055021 }));
    expect(url.origin).toBe("https://api.open-meteo.com");
    expect(url.pathname).toBe("/v1/forecast");
    expect(url.searchParams.get("latitude")).toBe("47.81");
    expect(url.searchParams.get("longitude")).toBe("13.06");
    expect(url.searchParams.get("hourly")?.split(",")).toEqual([
      "cloud_cover", "cloud_cover_low", "cloud_cover_mid", "cloud_cover_high", "precipitation_probability", "precipitation",
      "relative_humidity_2m", "dew_point_2m", "temperature_2m", "wind_speed_10m", "wind_gusts_10m",
    ]);
    expect(url.searchParams.get("timeformat")).toBe("unixtime");
    expect(url.toString()).not.toContain("47.8095");
  });

  it("reads the answer defensively", () => {
    const f = parseForecast(openMeteo, { latitude: 47.8, longitude: 13.04 }, NOW);
    expect(f.hours).toHaveLength(4);
    expect(f.hours[1]).toMatchObject({ time: T0, cloud: 20, cloudLow: 0, rainProb: 5, dewPoint: 2.5, temp: 7, wind: 8, gust: 15 });
    expect(parseForecast(null, { latitude: 1, longitude: 1 }, 0).hours).toEqual([]);
    const odd = parseForecast({ hourly: { time: [T0 / 1000, "x"], cloud_cover: ["a"] } }, { latitude: 1, longitude: 1 }, 0);
    expect(odd.hours).toHaveLength(1);
    expect(odd.hours[0]!.cloud).toBeNull();
    expect(samePlace({ latitude: 47.801, longitude: 13.04 }, { latitude: 47.8, longitude: 13.039 })).toBe(true);
    expect(samePlace({ latitude: 47.81, longitude: 13.04 }, { latitude: 47.8, longitude: 13.04 })).toBe(false);
  });

  it("fetches without custom headers (no preflight) and names failures", async () => {
    const ok = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(openMeteo)));
    const f = await fetchForecast({ latitude: 47.8, longitude: 13.04 }, { fetchImpl: ok as unknown as typeof fetch, now: () => NOW });
    expect(f.hours).toHaveLength(4);
    expect(ok.mock.calls[0]![1]?.headers).toBeUndefined();
    const down = vi.fn(async () => new Response("{}", { status: 503 }));
    await expect(fetchForecast({ latitude: 1, longitude: 1 }, { fetchImpl: down as unknown as typeof fetch })).rejects.toThrow("HTTP 503");
    const offline = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    await expect(fetchForecast({ latitude: 1, longitude: 1 }, { fetchImpl: offline as unknown as typeof fetch })).rejects.toThrow("unreachable");
    const empty = vi.fn(async () => new Response("{}"));
    await expect(fetchForecast({ latitude: 1, longitude: 1 }, { fetchImpl: empty as unknown as typeof fetch })).rejects.toThrow("bad-reply");
  });
});

describe("weather warnings", () => {
  it("a clear night gives no warning", () => {
    expect(evaluateWeather(input(forecastOf()))).toEqual([]);
    expect(evaluateWeather(input(null))).toEqual([]);
  });

  it("clouds coming: when they cross the limit and how thick they get", () => {
    // 20:00 20 %, 21:00 75 %: 60 % is crossed at ~20:44, i.e. the 20:50 step = in 30 minutes.
    const warnings = evaluateWeather(input(forecastOf({ 1: { cloud: 20 }, 2: { cloud: 75 } })));
    expect(warnings).toEqual([{ kind: "clouds", level: "warn", minutes: 30, value: 75, source: "forecast" }]);
    expect(warningText(warnings[0]!, "de")).toBe("Wolken in ~30 min (75 %)");
    expect(warningText(warnings[0]!, "en")).toBe("Clouds in ~30 min (75 %)");
    // Beyond the two-hour lead: nothing yet.
    expect(evaluateWeather(input(forecastOf({ 4: { cloud: 90 } })))).toEqual([]);
  });

  it("N.I.N.A.'s station speaks for now, the forecast for later", () => {
    const now = evaluateWeather(input(forecastOf(), station({ cloudCover: 82 })));
    expect(now).toEqual([{ kind: "clouds", level: "warn", minutes: 0, value: 82, source: "station" }]);
    expect(warningText(now[0]!, "de")).toBe("Bewölkt: 82 %");
    // The station sees a clear sky although the forecast says cloudy: no "cloudy now", the forecast only speaks for later.
    const clearStation = evaluateWeather(input(forecastOf({ 1: { cloud: 90 }, 2: { cloud: 90 } }), station({ cloudCover: 5 })));
    expect(clearStation).toEqual([{ kind: "clouds", level: "warn", minutes: 10, value: 90, source: "forecast" }]);
    const clearing = evaluateWeather(input(forecastOf({ 1: { cloud: 90 }, 2: { cloud: 10 } }), station({ cloudCover: 5 })));
    expect(clearing).toEqual([]);
  });

  it("hysteresis: an active warning stays until the value is clearly back", () => {
    const hovering = forecastOf({ 1: { cloud: 55 }, 2: { cloud: 55 }, 3: { cloud: 55 } });
    expect(evaluateWeather(input(hovering))).toEqual([]);
    expect(evaluateWeather(input(hovering), new Set(["clouds"])).map((w) => w.kind)).toEqual(["clouds"]);
    const back = forecastOf({ 1: { cloud: 45 }, 2: { cloud: 45 }, 3: { cloud: 45 } });
    expect(evaluateWeather(input(back), new Set(["clouds"]))).toEqual([]);
    // Dew the other way round: on at 2 °C spread, off only above 3 °C.
    const damp = forecastOf({ 1: { temp: 5, dewPoint: 2.5 }, 2: { temp: 5, dewPoint: 2.5 }, 3: { temp: 5, dewPoint: 2.5 } });
    expect(evaluateWeather(input(damp))).toEqual([]);
    expect(evaluateWeather(input(damp), new Set(["dew"])).map((w) => w.kind)).toEqual(["dew"]);
  });

  it("rain: a high chance, measurable rain, and the rain sensor", () => {
    const risk = evaluateWeather(input(forecastOf({ 2: { rainProb: 45 } })));
    expect(risk).toHaveLength(1);
    expect(risk[0]).toMatchObject({ kind: "rain", level: "warn", value: 45 });
    expect(risk[0]!.minutes).toBeGreaterThan(0);
    expect(warningText(risk[0]!, "de")).toMatch(/^Regen 45 % in ~\d+ min$/);
    const wet = evaluateWeather(input(forecastOf({ 1: { rain: 0.8, rainProb: 80 } })));
    expect(wet[0]).toMatchObject({ kind: "rain", minutes: 0, raining: true });
    const sensor = evaluateWeather(input(forecastOf(), station({ rainRate: 0.4 })));
    expect(sensor[0]).toEqual({ kind: "rain", level: "critical", minutes: 0, value: 0, source: "station", raining: true });
    expect(warningText(sensor[0]!, "de")).toBe("! Regen (Sensor)");
  });

  it("dew: temperature close to the dew point", () => {
    const dew = evaluateWeather(input(forecastOf({ 1: { temp: 4, dewPoint: 2.6 }, 2: { temp: 4, dewPoint: 2.6 } })));
    expect(dew).toEqual([{ kind: "dew", level: "warn", minutes: 0, value: 1.4, source: "forecast" }]);
    expect(warningText(dew[0]!, "de")).toBe("Taugefahr: 1,4 °C");
    // The station's own temperature and dew point count for now.
    const fromStation = evaluateWeather(input(forecastOf(), station({ temperature: 3.1, dewPoint: 2.2 })));
    expect(fromStation[0]).toMatchObject({ kind: "dew", minutes: 0, source: "station", value: 0.9 });
  });

  it("wind and gusts", () => {
    const gusty = evaluateWeather(input(forecastOf({ 3: { gust: 42 } })));
    expect(gusty[0]).toMatchObject({ kind: "wind", value: 42 });
    expect(gusty[0]!.minutes).toBeGreaterThan(30);
    expect(warningText(gusty[0]!, "de")).toMatch(/^Wind 42 km\/h in ~(\d+ min|1 h \d\d)$/);
    const station36 = evaluateWeather(input(forecastOf(), station({ windSpeed: 20, windGust: 36 })));
    expect(station36[0]).toMatchObject({ kind: "wind", minutes: 0, value: 36, source: "station" });
  });

  it("worst first: rain on the sensor before clouds", () => {
    const list = evaluateWeather(input(forecastOf({ 1: { cloud: 90 } }), station({ rainRate: 2 })));
    expect(list.map((w) => w.kind)).toEqual(["rain", "clouds"]);
  });
});

describe("popups", () => {
  const clouds: WeatherWarning = { kind: "clouds", level: "warn", minutes: 40, value: 75, source: "forecast" };
  const rainRisk: WeatherWarning = { kind: "rain", level: "warn", minutes: 30, value: 50, source: "forecast" };
  const raining: WeatherWarning = { ...rainRisk, minutes: 0, raining: true, level: "critical", source: "station" };

  it("a warning pops up once when it starts, not again within 30 minutes", () => {
    let step = trackWarnings(EMPTY_TRACKER, [clouds], NOW);
    expect(step.popups).toEqual([clouds]);
    step = trackWarnings(step.tracker, [{ ...clouds, minutes: 30 }], NOW + 4_000);
    expect(step.popups).toEqual([]);
    // Gone and back after 10 minutes: no second popup.
    step = trackWarnings(step.tracker, [], NOW + 5 * MIN);
    step = trackWarnings(step.tracker, [clouds], NOW + 10 * MIN);
    expect(step.popups).toEqual([]);
    // Gone and back after more than 30 minutes: it pops up again.
    step = trackWarnings(step.tracker, [], NOW + 20 * MIN);
    step = trackWarnings(step.tracker, [clouds], NOW + POPUP_COOLDOWN_MS + 1);
    expect(step.popups).toEqual([clouds]);
  });

  it("rain that starts is a new warning after a rain risk", () => {
    let step = trackWarnings(EMPTY_TRACKER, [rainRisk], NOW);
    expect(step.popups).toHaveLength(1);
    step = trackWarnings(step.tracker, [raining], NOW + MIN);
    expect(step.popups).toEqual([raining]);
    // Hysteresis knows "rainNow" means rain.
    expect(evaluateWeather(input(forecastOf({ 1: { rainProb: 35 }, 2: { rainProb: 35 } })), step.tracker.active).map((w) => w.kind)).toEqual(["rain"]);
  });
});

describe("clear-sky window and times", () => {
  it("clear until the clouds come, cloudy until it clears", () => {
    const f = forecastOf({ 4: { cloud: 30 }, 5: { cloud: 90 }, 6: { cloud: 90 }, 7: { cloud: 40 } });
    const clear = skyWindow(input(f));
    expect(clear.kind).toBe("clear");
    if (clear.kind !== "clear" || clear.until === null) throw new Error("expected an end");
    // 23:00 30 % -> 24:00 90 %: 60 % at 23:30 UTC = 01:30 in Salzburg (UTC+2).
    expect(clockText(clear.until, 120)).toBe("01:30");
    const cloudy = skyWindow(input(f, null, T0 + 4 * H + 30 * MIN));
    expect(cloudy.kind).toBe("cloudy");
    if (cloudy.kind !== "cloudy" || cloudy.from === null) throw new Error("expected a clearing");
    // 01:00 90 % -> 02:00 40 %: below 60 % from ~01:36, the 01:40 step = 03:40 local.
    expect(clockText(cloudy.from, 120)).toBe("03:40");
    expect(skyWindow(input(forecastOf()))).toEqual({ kind: "clear", until: null });
    expect(skyWindow(input(null))).toEqual({ kind: "unknown" });
  });

  it("interpolates between the hours and words the time", () => {
    const f = forecastOf({ 1: { cloud: 20 }, 2: { cloud: 80 } });
    expect(valueAt(f.hours, cloudOf, T0 + 30 * MIN)).toBeCloseTo(50);
    expect(valueAt(f.hours, cloudOf, T0 - 3 * H)).toBeNull();
    expect(inMinutes(0)).toBe("~10 min");
    expect(inMinutes(40)).toBe("~40 min");
    expect(inMinutes(100)).toBe("~1 h 40");
    expect(inMinutes(120)).toBe("~2 h");
    expect(clockText(Date.UTC(2026, 9, 13, 0, 26), 120)).toBe("02:30");
  });
});

describe("settings", () => {
  it("thresholds are clamped and typed numbers with a comma are fine", () => {
    expect(clampThresholds({ cloud: "75", rainProb: 500, dewSpread: "1,5", wind: "x" })).toEqual({ cloud: 75, rainProb: 100, dewSpread: 1.5, wind: 30 });
    expect(clampThresholds(null)).toEqual(DEFAULT_THRESHOLDS);
    const s = parseSettings(JSON.stringify({ weather: { enabled: false, thresholds: { cloud: 70 }, latitude: 47.8, longitude: 13.04 } }));
    expect(s.weather).toEqual({ enabled: false, thresholds: { ...DEFAULT_THRESHOLDS, cloud: 70 }, latitude: 47.8, longitude: 13.04 });
    expect(parseSettings(JSON.stringify({ weather: { latitude: 0, longitude: 0 } })).weather).toEqual({ enabled: true, thresholds: DEFAULT_THRESHOLDS });
  });
});

describe("N.I.N.A. weather in the status", () => {
  it("reads station, safety monitor and site; unsafe is a critical alert", () => {
    const s = parseStatus({
      online: true, weather: { connected: true, cloudCover: 140, rainRate: 0, windSpeed: 12, skyQuality: 20.4 },
      safety: { connected: true, safe: false }, site: { lat: 47.8123, lon: 13.0456 },
    });
    if (!s.online) throw new Error("online");
    expect(s.weather).toMatchObject({ cloudCover: 100, rainRate: 0, windSpeed: 12, skyQuality: 20.4, dewPoint: null });
    expect(s.safety).toEqual({ connected: true, safe: false });
    expect(s.site).toEqual({ latitude: 47.81, longitude: 13.05 });
    expect(alerts(s)[0]).toEqual({ kind: "unsafe", level: "critical", vars: {} });
    const none = parseStatus({ online: true, weather: { connected: false }, site: { lat: 0, lon: 0 } });
    if (!none.online) throw new Error("online");
    expect(none.weather).toBeNull();
    expect(none.site).toBeNull();
    expect(none.safety).toEqual({ connected: false, safe: null });
  });
});

describe("the weather cockpit page", () => {
  const weather = (over: Partial<WeatherView> = {}): WeatherView => ({ ...NO_WEATHER, location: "manual", forecast: forecastOf({ 1: { cloud: 20 }, 2: { cloud: 75 }, 3: { cloud: 90 }, 5: { cloud: 30 } }), ...over });
  const view = (over: Partial<ViewState> = {}): ViewState => ({
    locale: "de", demo: false, connection: { kind: "setup" }, status: null, ageSeconds: 0, screen: "run", page: "weather", startCursor: 0,
    cursor: 0, armed: null, sending: false, message: "", hasPreview: false, now: NOW, utcOffset: 120, weather: weather(), ...over,
  });

  it("works without a bridge: the cloud chart at the left, the night in the headline", () => {
    const plain = view();
    const calm = cockpitModel(plain);
    expect(calm.headline).toEqual(["KLAR BIS", "~22:50"]);
    expect(calm.graphic.kind).toBe("cloud");
    expect(calm.cells.map((cell) => cell.label)).toEqual(["WOLKEN", "REGEN", "TAU", "WIND km/h", "BÖEN km/h", "SQM"]);
    expect(calm.cells[0]).toEqual({ label: "WOLKEN", value: "38%" });
    const s = view({ weather: weather({ warnings: evaluateWeather(input(plain.weather!.forecast)) }) });
    const model = cockpitModel(s);
    expect(model.headline).toEqual(["WOLKEN IN ~30", "MIN (90 %)"]);
    expect(model.cells[0]).toEqual({ label: "WOLKEN", value: "38%", alert: true });
    const spec = model.graphic.kind === "cloud" ? model.graphic.spec : null;
    expect(spec?.clouds).toHaveLength(49);
    const picture = cloudChart(spec!);
    expect(picture.width).toBe(CLOUD_CHART_WIDTH);
    expect(picture.height).toBe(CLOUD_CHART_HEIGHT);
  });

  it("a warning is the headline of the imaging page, and every other page carries a mark in its title", async () => {
    const { createDemoNina } = await import("../src/nina/demo");
    const status = await createDemoNina(() => 0).status();
    const warning: WeatherWarning = { kind: "clouds", level: "warn", minutes: 40, value: 75, source: "forecast" };
    const w = weather({ warnings: [warning] });
    const overview = cockpitModel(view({ page: "overview", status, connection: { kind: "ok" }, weather: w }));
    expect(overview.headline).toEqual(["WOLKEN IN ~40", "MIN (75 %)"]);
    expect(cockpitModel(view({ page: "guiding", status, connection: { kind: "ok" }, weather: w })).title).toBe("STAR !");
    expect(cockpitModel(view({ page: "overview", status, connection: { kind: "ok" }, weather: weather() })).title).toBe("STAR");
  });

  it("says why there is no forecast", () => {
    expect(cockpitModel(view({ weather: { ...NO_WEATHER, location: "none" } })).headline).toEqual(["KEIN", "STANDORT"]);
    expect(cockpitModel(view({ weather: { ...NO_WEATHER, location: "none" } })).caption).toBe("Am Handy eintragen.");
    const failed = cockpitModel(view({ weather: { ...NO_WEATHER, error: "HTTP 503" } }));
    expect(failed.headline).toEqual(["KEINE", "WETTERDATEN"]);
    expect(failed.caption).toBe("Serverfehler");
    expect(cockpitModel(view({ weather: { ...NO_WEATHER, enabled: false } })).headline).toEqual(["WETTER AUS"]);
  });

  it("every weather text fits in both languages: a headline of at most two lines, cells within their box", () => {
    const worstStation = { connected: true, cloudCover: 100, rainRate: 12.5, humidity: 100, dewPoint: -10.5, temperature: 35.5, windSpeed: 120, windGust: 150, skyQuality: 21.55 };
    const status = parseStatus({ online: true, sequence: { state: "running" }, weather: worstStation, safety: { connected: true, safe: false } });
    const worstWarnings: WeatherWarning[] = [
      { kind: "clouds", level: "warn", minutes: 110, value: 100, source: "forecast" },
      { kind: "rain", level: "warn", minutes: 110, value: 100, source: "forecast" },
      { kind: "dew", level: "warn", minutes: 110, value: 10.5, source: "forecast" },
      { kind: "wind", level: "warn", minutes: 110, value: 150, source: "forecast" },
      { kind: "rain", level: "critical", minutes: 0, value: 100, source: "station", raining: true },
      { kind: "rain", level: "warn", minutes: 0, value: 100, source: "forecast", raining: true },
      { kind: "dew", level: "warn", minutes: 0, value: 10.5, source: "station" },
      { kind: "wind", level: "warn", minutes: 0, value: 150, source: "station" },
      { kind: "clouds", level: "warn", minutes: 0, value: 100, source: "station" },
    ];
    const heavy = forecastOf(Object.fromEntries(Array.from({ length: 14 }, (_, i) => [i, { cloud: 100, cloudLow: 100, cloudMid: 100, cloudHigh: 100, rainProb: 100, wind: 120, gust: 150 }])));
    const backend = pixelBackend();
    for (const locale of locales as Locale[]) {
      for (const w of worstWarnings) {
        const model = cockpitModel(view({ locale, status, connection: { kind: "ok" }, weather: weather({ warnings: [w, ...worstWarnings] }) }));
        expect(model.headline.length).toBeLessThanOrEqual(2);
        expect(headlineLayout(backend, model.headline).lines.join(" ")).not.toMatch(/…/);
      }
      for (const forecast of [heavy, forecastOf(), null]) {
        for (const error of [null, "HTTP 503", "bad-reply"]) {
          const model = cockpitModel(view({ locale, status, connection: { kind: "ok" }, weather: weather({ forecast, error, warnings: worstWarnings }) }));
          expect(model.cells).toHaveLength(6);
          for (const cell of model.cells) expect(cellValueLayout(backend, cell.value, CELL_WIDTH).text, `${locale} ${cell.label}`).not.toMatch(/…/);
          expect(model.hint.length).toBeLessThanOrEqual(56);
        }
      }
    }
  });
});

describe("the cloud chart", () => {
  const spec = { clouds: [10, 20, 75, 90, 60, 30, 10], rain: [0, 0, 20, 50, 10, 0, 0], threshold: 60, rainThreshold: 40, hours: 12, startHour: 21.5, now: 10 };

  it("is a pure picture of its input", () => {
    expect(bitmapKey(cloudChart(spec))).toBe(bitmapKey(cloudChart({ ...spec })));
    expect(bitmapKey(cloudChart(spec))).not.toBe(bitmapKey(cloudChart({ ...spec, threshold: 40 })));
    expect(bitmapKey(cloudChart(spec))).not.toBe(bitmapKey(cloudChart({ ...spec, clouds: [] })));
  });

  it("the demo night has clouds coming and clears again", () => {
    const f = demoForecast(NOW);
    const list = evaluateWeather(input(f));
    expect(list[0]?.kind).toBe("clouds");
    expect(skyWindow(input(f)).kind).toBe("clear");
  });
});
