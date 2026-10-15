import { describe, expect, it, vi } from "vitest";
import {
  arrivalSoc, batteryEstimate, buildBydUrl, carAgeMs, chooseSpeed, clampUsableKwh, consumptionOf, fetchCar, freshCarSpeed, parseCarState,
  CAR_BATTERY_MAX_MS, CAR_FRESH_MS, DEFAULT_CONSUMPTION, DEFAULT_USABLE_KWH, type CarSnapshot,
} from "../src/car/byd";
import { speedColumn, speedLine } from "../src/nav/speed";
import { buildView, LINE_WIDTH } from "../src/glasses/view";
import { createMockProvider } from "../src/routing/provider";
import { progressOf, startNavigation, update } from "../src/nav/navigator";
import { EMPTY_DATA, parseData } from "../src/storage/persist";
import { carLineText } from "../src/ui/phone";

/** A /state answer as the byd-bridge sends it (only the fields OpenGlance reads, plus noise). */
const bridgeState = (over: Record<string, unknown> = {}) => ({
  v: 1, rev: 7, mode: "driving", online: true, stale: false, age_s: 2, car_on: true,
  drive: { speed: 87.4, cons50: 15.8, gear: "D" },
  battery: { soc: 87, range_km: 296, soh: 100 },
  ...over,
});

const snap = (over: Partial<CarSnapshot> = {}): CarSnapshot => ({ ...parseCarState(bridgeState(), 1_000)!, ...over });

describe("car link: reading the bridge", () => {
  it("takes only a valid http(s) address from the build", () => {
    expect(buildBydUrl("https://car.example:8471/")).toBe("https://car.example:8471");
    expect(buildBydUrl("")).toBe("");
    expect(buildBydUrl(undefined)).toBe("");
    expect(buildBydUrl("ftp://car.example")).toBe("");
    expect(buildBydUrl("not a url")).toBe("");
  });

  it("parses speed, battery and age; anything that is not a car state is ignored", () => {
    expect(parseCarState(bridgeState(), 5)).toEqual({
      fetchedAt: 5, stale: false, ageS: 2, mode: "driving", speed: 87.4, soc: 87, rangeKm: 296, cons50: 15.8, batterySource: "car", cloudAgeMin: null, position: null,
    });
    expect(parseCarState({ error: "x" }, 5)).toBeNull();
    expect(parseCarState(null, 5)).toBeNull();
    // A missing "stale" counts as stale: never trust what the bridge did not vouch for.
    expect(parseCarState({ ...bridgeState(), stale: undefined }, 5)?.stale).toBe(true);
  });

  it("asks with a plain GET (no custom headers, no preflight) and survives failures", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const ok = vi.fn(async (url: string, init?: RequestInit) => { calls.push({ url, init }); return new Response(JSON.stringify(bridgeState())); });
    const car = await fetchCar("https://car.example:8471/", () => 42, ok as unknown as typeof fetch);
    expect(car?.soc).toBe(87);
    expect(car?.fetchedAt).toBe(42);
    expect(calls[0]!.url).toBe("https://car.example:8471/state");
    expect(calls[0]!.init?.headers).toBeUndefined();
    expect(calls[0]!.init?.method).toBeUndefined();
    const down = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    expect(await fetchCar("https://car.example:8471", () => 0, down as unknown as typeof fetch)).toBeNull();
    const err = vi.fn(async () => new Response("{}", { status: 502 }));
    expect(await fetchCar("https://car.example:8471", () => 0, err as unknown as typeof fetch)).toBeNull();
  });
});

describe("car link: which speed the glasses show", () => {
  it("the car's speed when fresh, rounded", () => {
    expect(freshCarSpeed(snap(), 1_000)).toBe(87);
    expect(chooseSpeed(snap(), 80, 1_000, true)).toEqual({ kmh: 87, source: "car" });
  });

  it("falls back to the GPS when the bridge says stale", () => {
    expect(chooseSpeed(snap({ stale: true }), 80, 1_000, true)).toEqual({ kmh: 80, source: "gps" });
  });

  it("falls back to the GPS when the value is 10 s or older (car age + time since the answer)", () => {
    const car = snap({ ageS: 2, fetchedAt: 1_000 });
    expect(carAgeMs(car, 1_000)).toBe(2_000);
    expect(chooseSpeed(car, 80, 1_000 + CAR_FRESH_MS - 2_001, true).source).toBe("car");
    expect(chooseSpeed(car, 80, 1_000 + CAR_FRESH_MS - 2_000, true)).toEqual({ kmh: 80, source: "gps" });
    expect(chooseSpeed(snap({ ageS: null }), 80, 1_000, true).source).toBe("gps");
    expect(chooseSpeed(snap({ ageS: 12 }), 80, 1_000, true).source).toBe("gps");
  });

  it("GPS when the car has no speed or nothing answered; no marker at all without a link", () => {
    expect(chooseSpeed(snap({ speed: null }), 33, 1_000, true)).toEqual({ kmh: 33, source: "gps" });
    expect(chooseSpeed(null, null, 1_000, true)).toEqual({ kmh: null, source: "gps" });
    expect(chooseSpeed(snap(), 33, 1_000, false)).toEqual({ kmh: 33 });
  });

  it("marks the GPS fallback subtly, keeping the narrow column", () => {
    expect(speedColumn({ kmh: 87, limit: 100, source: "car" })).toBe("87\nkm/h\n\n[100]");
    expect(speedColumn({ kmh: 80, limit: 100, source: "gps" })).toBe("80\nkm/h\nGPS\n[100]");
    expect(speedColumn({ kmh: 80, limit: null, source: "gps" })).toBe("80\nkm/h\nGPS");
    for (const text of [speedColumn({ kmh: 188, limit: 130, source: "gps" })]) {
      for (const row of text.split("\n")) expect(row.length).toBeLessThanOrEqual(5);
    }
    expect(speedLine({ kmh: 87, limit: 100, source: "car" })).toBe("87 | 100 km/h");
    expect(speedLine({ kmh: 80, limit: 100, source: "gps" })).toBe("80 | 100 km/h·GPS");
  });
});

describe("car link: battery at arrival", () => {
  it("soc − remaining km × consumption ÷ 100 ÷ usable kWh × 100", () => {
    // 100 km at 16 kWh/100 km = 16 kWh = 37.04 % of 43.2 kWh.
    expect(arrivalSoc(87, 100, 16, 43.2)).toBeCloseTo(87 - 37.037, 2);
    expect(arrivalSoc(50, 0, 16, 43.2)).toBe(50);
    expect(arrivalSoc(50, 10, 20, 40)).toBe(45);
  });

  it("uses the car's 50-km consumption, 16 kWh/100 km when it has none", () => {
    expect(consumptionOf(snap({ cons50: 15.8 }))).toBe(15.8);
    expect(consumptionOf(snap({ cons50: 0 }))).toBe(DEFAULT_CONSUMPTION);
    expect(consumptionOf(snap({ cons50: null }))).toBe(DEFAULT_CONSUMPTION);
    expect(consumptionOf(null)).toBe(16);
  });

  it("estimate: whole %, never below 0, low under 10 %", () => {
    const car = snap({ soc: 87, cons50: 16 });
    expect(batteryEstimate(car, 100_000, 43.2, 1_000)).toEqual({ soc: 87, arrival: 50, low: false });
    const far = batteryEstimate(car, 220_000, 43.2, 1_000)!;
    expect(far.arrival).toBe(6);
    expect(far.low).toBe(true);
    expect(batteryEstimate(car, 400_000, 43.2, 1_000)).toEqual({ soc: 87, arrival: 0, low: true });
  });

  it("no estimate without a battery value or when the last answer is too old (stale car still counts)", () => {
    expect(batteryEstimate(snap({ soc: null }), 1_000, 43.2, 1_000)).toBeNull();
    expect(batteryEstimate(null, 1_000, 43.2, 1_000)).toBeNull();
    expect(batteryEstimate(snap({ stale: true }), 1_000, 43.2, 1_000)?.soc).toBe(87);
    expect(batteryEstimate(snap(), 1_000, 43.2, 1_000 + CAR_BATTERY_MAX_MS + 1)).toBeNull();
  });

  it("usable capacity: a phone setting, 43.2 kWh by default, kept within 10–150", () => {
    expect(EMPTY_DATA.carUsableKwh).toBe(DEFAULT_USABLE_KWH);
    expect(DEFAULT_USABLE_KWH).toBe(43.2);
    expect(parseData(JSON.stringify({})).carUsableKwh).toBe(43.2);
    expect(parseData(JSON.stringify({ carUsableKwh: 44.9 })).carUsableKwh).toBe(44.9);
    expect(parseData(JSON.stringify({ carUsableKwh: 5000 })).carUsableKwh).toBe(150);
    expect(clampUsableKwh("38,5")).toBe(38.5);
    expect(clampUsableKwh("abc")).toBe(43.2);
  });
});

describe("car link: on the glasses and the phone", () => {
  async function progress(km: number) {
    const { route } = await createMockProvider().route({ from: { lat: 52, lon: 13 }, to: { lat: 52 + km / 111, lon: 13 }, mode: "driving" });
    return progressOf(update(startNavigation(route!), route!.shape[1]!));
  }
  const base = { navigating: true, rerouting: false, error: null, mock: false, waitingForFix: false, locale: "de" as const, bigDistance: true } as const;

  it("battery now and at arrival in the footer of the turn page, driving only", async () => {
    const p = await progress(50);
    const battery = { soc: 87, arrival: 62, low: false };
    const view = buildView(p, { ...base, mode: "driving", battery });
    expect(view.footer).toContain("87 % → ~62 %");
    expect(view.footer.length).toBeLessThanOrEqual(LINE_WIDTH);
    expect(buildView(p, { ...base, mode: "cycling", battery }).footer).not.toContain("→");
  });

  it("arriving under 10 %: warning under the road instead of the next charger, tap hint in the footer", async () => {
    const p = await progress(50);
    const view = buildView(p, { ...base, mode: "driving", battery: { soc: 30, arrival: 6, low: true }, charger: "Laden in 12 km · 150 kW" });
    expect(p.distanceToManeuver).toBeGreaterThanOrEqual(200);
    {
      expect(view.body).toContain("Ankunft ~6 % – Ladestopp planen");
      expect(view.body.join("\n")).not.toContain("Laden in 12 km");
      expect(view.footer).toBe("Tippen = Laden in der Nähe  ·  30 % → ~6 %");
    }
    expect(view.footer.length).toBeLessThanOrEqual(LINE_WIDTH);
  });

  it("phone line: \"Auto verbunden: 87 % · 296 km\"", () => {
    expect(carLineText({ status: "ok", soc: 87, rangeKm: 296 }, "de")).toBe("Auto verbunden: 87 % · 296 km");
    expect(carLineText({ status: "ok", soc: 87, rangeKm: 296 }, "en")).toBe("Car connected: 87 % · 296 km");
    expect(carLineText({ status: "offline", soc: null, rangeKm: null }, "de")).toBe("Auto: Bridge antwortet nicht");
  });
});

describe("car link: battery from the BYD cloud (bridge since 15.10.)", () => {
  const cloudState = (ageMin: number) => bridgeState({
    mode: "parked", online: false, stale: true, age_s: 360, car_on: false,
    battery: { soc: 60, range_km: 185, src: "cloud", cloud_age_min: ageMin, odometer_km: 27736 },
    position: { lat: 47.8, lon: 13.04, src: "cloud", age_min: ageMin },
  });

  it("reads source, age and the car's last place", () => {
    const car = parseCarState(cloudState(1), 1_000)!;
    expect(car).toMatchObject({ batterySource: "cloud", cloudAgeMin: 1, soc: 60, rangeKm: 185, position: { lat: 47.8, lon: 13.04, ageMin: 1 } });
    expect(parseCarState(bridgeState(), 1_000)).toMatchObject({ batterySource: "car", cloudAgeMin: null, position: null });
  });

  it("shows cloud values marked while the car is silent, and drops them when too old", async () => {
    const { batteryRange, CLOUD_BATTERY_MAX_MIN } = await import("../src/car/byd");
    const { batteryLine } = await import("../src/glasses/hud");
    const fresh = parseCarState(cloudState(5), 1_000)!;
    expect(batteryRange(fresh, DEFAULT_USABLE_KWH, 1_000)).toEqual({ km: 185, estimated: false, cloud: true });
    const estimate = batteryEstimate(fresh, 50_000, DEFAULT_USABLE_KWH, 1_000)!;
    expect(estimate.cloud).toBe(true);
    expect(batteryLine(estimate, batteryRange(fresh, DEFAULT_USABLE_KWH, 1_000), "de", 40)).toMatch(/Cloud/);
    const old = parseCarState(cloudState(CLOUD_BATTERY_MAX_MIN + 1), 1_000)!;
    expect(batteryRange(old, DEFAULT_USABLE_KWH, 1_000)).toBeNull();
    expect(batteryEstimate(old, 50_000, DEFAULT_USABLE_KWH, 1_000)).toBeNull();
  });
});
