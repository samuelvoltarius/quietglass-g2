import { describe, expect, it } from "vitest";
import { deriveRaw, modeOf, parseValue, type Memo } from "../src/car/derive";
import { parseState, sortWarnings, warningKey } from "../src/car/model";
import { demoTelemetry } from "../src/car/demo";

// The same samples as `byd_bridge.py --selftest`, so app (demo) and bridge agree.
const WHEELS = ["fl", "fr", "rl", "rr"];
function sample(over: Record<string, string | number> = {}): Record<string, string | number> {
  const base: Record<string, string | number> = {
    speed: "0.0", gear: "P", is_parked: "1", is_charging: "0", is_dcfc: "0", power: "0.0", soc: "64.0",
    ev_range_km: "190", consumption_50km: "15.8", locked: "1", door_open: "0", volt_12v: "12.6", soh: "97.0",
    cell_t_min: "18.0", cell_t_max: "20.0", ext_temp: "12.0", ac_on: "0", climate_setpoint: "21",
    speed_limit_warning: "0", light_left_turn: "-10011", light_right_turn: "-10011", light_high_beam: "0",
    charging_eta_hours: "0", charging_eta_minutes: "0", charging_capacity_kwh: "0", charge_power: "0.0",
    _age: 3, _online: "online",
  };
  for (const w of WHEELS) { base["tyre_p_" + w] = "250"; base["tyre_leak_" + w] = "0"; base["tyre_p_state_" + w] = "0"; }
  return { ...base, ...Object.fromEntries(Object.entries(over).map(([k, v]) => [k, typeof v === "number" && !k.startsWith("_") ? String(v) : v])) };
}
const NOW = 1_000_000;
const state = (over: Record<string, string | number> = {}, memo: Memo = {}, now = NOW) => parseState({ ...deriveRaw(sample(over), now, memo), rev: 1, at: now * 1000 });
const codes = (s: ReturnType<typeof state>) => s.warnings.map((w) => warningKey(w));

describe("telemetry values", () => {
  it("reads Overdrive's placeholders as missing", () => {
    expect(parseValue("NULL")).toBeNull();
    expect(parseValue("-10011")).toBeNull();
    expect(parseValue("65535")).toBeNull();
    expect(parseValue("1048575")).toBeNull();
    expect(parseValue("P")).toBe("P");
    expect(parseValue("13.7")).toBe(13.7);
  });
});

describe("mode", () => {
  it("parked, driving, charging", () => {
    expect(modeOf(sample())).toBe("parked");
    expect(modeOf(sample({ speed: 87.5, gear: "D", is_parked: 0 }))).toBe("driving");
    expect(modeOf(sample({ speed: 0, gear: "R", is_parked: 0 }))).toBe("driving");
    expect(modeOf(sample({ is_charging: 1 }))).toBe("charging");
    // A car rolling while plugged in is impossible, but driving wins anyway.
    expect(modeOf(sample({ speed: 20, gear: "D", is_charging: 1 }))).toBe("driving");
  });
});

describe("derived state", () => {
  it("parked and healthy: no warnings, locked, no blinker from placeholders", () => {
    const s = state();
    expect(s.mode).toBe("parked");
    expect(s.warnings).toEqual([]);
    expect(s.body.locked).toBe(true);
    expect(s.drive.turnLeft).toBe(false);
    expect(s.stale).toBe(false);
  });

  it("driving: speed, blinker, speed-limit flag", () => {
    const s = state({ speed: 87.5, gear: "D", is_parked: 0, power: 23.4, light_left_turn: 1, speed_limit_warning: 1 });
    expect(s.mode).toBe("driving");
    expect(s.drive.speed).toBe(87.5);
    expect(s.drive.turnLeft).toBe(true);
    expect(s.drive.limitWarn).toBe(true);
    expect(s.drive.powerKw).toBe(23.4);
  });

  it("charging: power comes from -power, not the unreliable charge_power", () => {
    const s = state({ is_charging: 1, is_dcfc: 1, power: -37, charge_power: 1.3, charging_eta_minutes: 49, charging_capacity_kwh: 8.82, locked: 0 });
    expect(s.mode).toBe("charging");
    expect(s.charge).toMatchObject({ active: true, dc: true, kw: 37, etaMin: 49, kwh: 8.8 });
    expect(codes(s)).not.toContain("unlocked");
  });

  it("charge done after charging stops", () => {
    const memo: Memo = {};
    state({ is_charging: 1, power: -5 }, memo);
    const s = state({ soc: 80 }, memo, NOW + 60);
    expect(s.charge.done).toBe(true);
    expect(codes(s)).toContain("charge_done");
    expect(s.warnings.find((w) => w.code === "charge_done")?.level).toBe("info");
  });

  it("warnings: tyre leak, tyre low, 12 V, door, battery", () => {
    const s = state({ tyre_leak_fl: 1, tyre_p_rr: 180, volt_12v: 11.8, door_open: 1, soc: 9 });
    expect(codes(s)).toEqual(expect.arrayContaining(["tyre_leak:fl", "tyre_low:rr", "v12_low", "door_open", "soc_low"]));
    expect(s.tyres.fl.leak).toBe(true);
    expect(s.tyres.rr.low).toBe(true);
    expect(sortWarnings(s.warnings)[0]?.level).toBe("crit");
  });

  it("an open door while driving is critical", () => {
    const s = state({ speed: 40, gear: "D", is_parked: 0, door_open: 1 });
    expect(s.warnings.find((w) => w.code === "door_open")?.level).toBe("crit");
  });

  it("unlocked while parked becomes a warning after 10 minutes", () => {
    const memo: Memo = {};
    expect(codes(state({ locked: 0 }, memo))).not.toContain("unlocked");
    const s = state({ locked: 0 }, memo, NOW + 11 * 60);
    expect(codes(s)).toContain("unlocked");
    expect(s.warnings.find((w) => w.code === "unlocked")?.minutes).toBe(11);
  });

  it("old data is stale", () => {
    expect(state({ _age: 3600 }).stale).toBe(true);
  });
});

describe("parseState", () => {
  it("rejects a reply without a mode", () => {
    expect(() => parseState({})).toThrow();
    expect(() => parseState(null)).toThrow();
  });

  it("odd fields become null instead of breaking the page", () => {
    const s = parseState({ mode: "parked", drive: { speed: "fast" }, tyres: { fl: { kpa: "x" } }, warnings: [{ code: 3 }, { code: "door_open", level: "huh" }], command: { id: "c1", action: "honk" } });
    expect(s.drive.speed).toBeNull();
    expect(s.tyres.fl.kpa).toBeNull();
    expect(s.tyres.rr).toEqual({ kpa: null, leak: false, low: false });
    expect(s.warnings).toHaveLength(1);
    expect(s.warnings[0]?.level).toBe("warn");
    expect(s.command).toBeNull();
    expect(s.stale).toBe(true);
  });
});

describe("demo", () => {
  it("the tour passes through all three modes", () => {
    const modes = [0, 40_000, 80_000].map((at) => modeOf(demoTelemetry("tour", at + 1_000)));
    expect(modes).toEqual(["driving", "charging", "parked"]);
  });
  it("the warn scene raises the warnings", () => {
    const s = parseState({ ...deriveRaw(demoTelemetry("warn", 0), 0, {}), rev: 1 });
    expect(s.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(["tyre_leak", "tyre_low", "door_open", "v12_low"]));
  });
});
