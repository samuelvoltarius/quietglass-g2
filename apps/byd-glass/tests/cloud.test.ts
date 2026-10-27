import { describe, expect, it } from "vitest";
import { deriveRaw } from "../src/car/derive";
import { demoTelemetry } from "../src/car/demo";
import { parseState } from "../src/car/model";
import { buildView, HEADER_WIDTH } from "../src/glasses/views";

// The bridge (15.10.2026) fills battery values from the BYD cloud while the car
// itself is silent, and always sends the car's last known position.
const raw = (over: Record<string, unknown>) => {
  const base = deriveRaw(demoTelemetry("parked", 1_000), 1, {}) as Record<string, unknown>;
  return { ...base, rev: 1, control: { enabled: false, lock: false, unlock: false, climate_temp: false }, ...over };
};

describe("cloud values and the car's position from the bridge", () => {
  it("reads source, cloud age, odometer and position; rejects a broken position", () => {
    const base = raw({}) as unknown as { battery: Record<string, unknown> };
    const car = parseState(raw({
      battery: { ...base.battery, soc: 60, range_km: 210, src: "cloud", cloud_age_min: 12, odometer_km: 27736 },
      position: { lat: 47.12611, lon: 13.81038, src: "cloud", age_min: 12 },
    }));
    expect(car.battery.src).toBe("cloud");
    expect(car.battery.cloudAgeMin).toBe(12);
    expect(car.battery.odometerKm).toBe(27736);
    expect(car.position).toEqual({ lat: 47.12611, lon: 13.81038, ageMin: 12 });
    expect(parseState(raw({ position: { lat: 123, lon: 13 } })).position).toBeNull();
    expect(parseState(raw({})).position).toBeNull();
    expect(parseState(raw({})).battery.src).toBeNull();
  });

  it("marks a charge level from the cloud on the glasses, within the header width", () => {
    const base = raw({}) as unknown as { battery: Record<string, unknown> };
    const car = parseState(raw({ battery: { ...base.battery, soc: 60, src: "cloud", cloud_age_min: 5 } }));
    for (const locale of ["de", "en"] as const) {
      const view = buildView({ locale, demo: false, connection: { kind: "ok" }, car, page: "status", overlay: null, now: 1_000 });
      expect(view.header).toMatch(/60 % (Cloud|cloud)/);
      expect(view.header.length).toBeLessThanOrEqual(HEADER_WIDTH);
    }
    const fromCar = parseState(raw({ battery: { ...base.battery, soc: 60, src: "car" } }));
    const view = buildView({ locale: "de", demo: false, connection: { kind: "ok" }, car: fromCar, page: "status", overlay: null, now: 1_000 });
    expect(view.header).not.toMatch(/Cloud/);
  });
});
