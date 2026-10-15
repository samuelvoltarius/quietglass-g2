import { describe, expect, it } from "vitest";
import { bar, dec, duration, kw, warningLong, warningShort } from "../src/format";
import type { CarWarning } from "../src/car/model";

const w = (over: Partial<CarWarning>): CarWarning => ({ code: "door_open", level: "warn", wheel: null, kpa: null, volt: null, minutes: null, soc: null, ...over });

describe("numbers", () => {
  it("German uses a decimal comma", () => {
    expect(dec(15.84, 1, "de")).toBe("15,8");
    expect(dec(15.84, 1, "en")).toBe("15.8");
    expect(dec(null, 1, "de")).toBe("–");
  });
  it("tyres in bar, power rounded when large", () => {
    expect(bar(252, "de")).toBe("2,5 bar");
    expect(bar(null, "en")).toBe("– bar");
    expect(kw(37.2, "de")).toBe("37 kW");
    expect(kw(5.04, "de")).toBe("5,0 kW");
    expect(kw(-12.4, "en")).toBe("-12 kW");
  });
  it("durations", () => {
    expect(duration(49)).toBe("49 min");
    expect(duration(65)).toBe("1 h 05");
    expect(duration(null)).toBe("–");
  });
});

describe("warning texts", () => {
  it("tyre leak names the wheel, short and long", () => {
    const leak = w({ code: "tyre_leak", wheel: "rr", kpa: 171, level: "crit" });
    expect(warningShort("de", leak)).toBe("REIFEN HR VERLIERT DRUCK 1,7 bar");
    expect(warningLong("de", leak)).toBe("Reifen hinten rechts: Druckverlust (1,7 bar) – anhalten, prüfen");
    expect(warningShort("en", leak)).toBe("TYRE RR LOSING PRESSURE 1.7 bar");
  });
  it("12 V, unlocked, battery, done", () => {
    expect(warningShort("de", w({ code: "v12_low", volt: 11.8 }))).toBe("12 V SCHWACH 11,8 V");
    expect(warningLong("en", w({ code: "unlocked", minutes: 12 }))).toBe("Car not locked for 12 min");
    expect(warningShort("de", w({ code: "soc_low", soc: 9 }))).toBe("AKKU NUR 9 %");
    expect(warningLong("de", w({ code: "charge_done", soc: 80, level: "info" }))).toBe("Ladung fertig (80 %) – Kabel abziehen");
  });
  it("an unknown code from a newer bridge still shows", () => {
    expect(warningShort("de", w({ code: "brake_fluid" }))).toBe("WARNUNG brake_fluid");
  });
});
