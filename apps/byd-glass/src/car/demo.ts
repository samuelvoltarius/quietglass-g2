import type { CarApi, CommandReply } from "./client";
import { deriveRaw, type Memo, type Telemetry } from "./derive";
import { parseState, type CarState } from "./model";

/**
 * A pretend car for the simulator and for builds without a bridge: plausible
 * telemetry with the Panoptes field names over time, run through the same
 * evaluation as the bridge. Read only: no control page, nothing is ever sent. Everything is labelled DEMO.
 */

export type DemoScene = "tour" | "drive" | "charge" | "parked" | "warn";
export const DEMO_SCENES: readonly DemoScene[] = ["tour", "drive", "charge", "parked", "warn"];

/** The tour shows every mode: 40 s driving, 40 s charging, 40 s parked. */
const TOUR_MS = 40_000;

const BASE: Record<string, string> = {
  speed: "0", gear: "P", is_parked: "1", is_charging: "0", is_dcfc: "0", power: "0",
  soc: "64", ev_range_km: "190", consumption_50km: "15.8", trip_km: "0", trip_kwh: "0", odometer: "28015.9",
  unlocked_lf: "0", door_open_lf: "0", door_open_rf: "0", door_open_lr: "0", door_open_rr: "0", trunk_open: "0", hood_open: "0",
  volt_12v: "12.6", soh: "97", cell_t_min: "18", cell_t_max: "20",
  ext_temp: "12", ac_on: "0", ac_fan: "0", climate_setpoint: "25", speed_limit_warning: "0",
  light_left_turn: "0", light_right_turn: "0", light_high_beam: "0", light_hazard: "0",
  charging_eta_hours: "0", charging_eta_minutes: "0", charging_capacity_kwh: "0", charge_power: "0",
  tyre_p_fl: "250", tyre_p_fr: "248", tyre_p_rl: "252", tyre_p_rr: "250",
  tyre_t_fl: "18", tyre_t_fr: "19", tyre_t_rl: "17", tyre_t_rr: "17",
  tyre_leak_fl: "0", tyre_leak_fr: "0", tyre_leak_rl: "0", tyre_leak_rr: "0",
  tyre_p_state_fl: "0", tyre_p_state_fr: "0", tyre_p_state_rl: "0", tyre_p_state_rr: "0",
};

export function demoTelemetry(scene: DemoScene, now: number, overrides: Record<string, string> = {}): Telemetry {
  const t: Record<string, string | number> = { ...BASE, _online: "online", _age: 2 };
  const sec = now / 1000;
  let kind: DemoScene = scene;
  if (scene === "tour") {
    const phase = Math.floor(now / TOUR_MS) % 3;
    kind = phase === 0 ? "drive" : phase === 1 ? "charge" : "parked";
  }
  if (kind === "drive") {
    // A town-and-country loop: speed swings 30..100 km/h, regen when slowing.
    const speed = 65 + 35 * Math.sin(sec / 9);
    const accel = Math.cos(sec / 9);
    Object.assign(t, {
      speed: speed.toFixed(1), gear: "D", is_parked: "0", unlocked_lf: "0",
      power: (accel > -0.2 ? 8 + 30 * accel + speed / 5 : -25 * -accel).toFixed(1),
      soc: "58", ev_range_km: "172", trip_km: (12 + (sec % 600) / 40).toFixed(1), trip_kwh: "1.9",
      speed_limit_warning: speed > 92 ? "1" : "0",
      light_left_turn: Math.floor(sec / 12) % 4 === 1 ? "1" : "0",
      light_right_turn: Math.floor(sec / 12) % 4 === 3 ? "1" : "0",
      light_high_beam: Math.floor(sec / 20) % 3 === 2 ? "1" : "0",
      volt_12v: "13.8", ac_on: "1", ac_fan: "2", tyre_t_fl: "27", tyre_t_fr: "28", tyre_t_rl: "25", tyre_t_rr: "25",
    });
  } else if (kind === "charge") {
    const soc = 40 + Math.floor((sec / 3) % 50);
    Object.assign(t, {
      is_charging: "1", is_dcfc: "1", power: (-(48 - soc / 3)).toFixed(1), charge_power: "1.3",
      soc: String(soc), ev_range_km: String(Math.round(soc * 2.95)),
      charging_eta_minutes: String(Math.max(1, Math.round((90 - soc) * 0.9))),
      charging_capacity_kwh: ((soc - 40) * 0.43).toFixed(2), cell_t_min: "26", cell_t_max: "29", volt_12v: "13.8",
    });
  } else if (kind === "warn") {
    Object.assign(t, { tyre_leak_rr: "1", tyre_p_rr: "171", tyre_p_fl: "205", volt_12v: "11.9", door_open_rr: "1", unlocked_lf: "1" });
  }
  return { ...t, ...overrides };
}

export function createDemo(clock: () => number, scene: DemoScene): CarApi {
  const memo: Memo = {};
  let rev = 0;
  let lastKey = "";

  const snapshot = (): CarState => {
    const now = clock();
    const raw = deriveRaw(demoTelemetry(scene, now), now / 1000, memo);
    const key = JSON.stringify(raw);
    if (key !== lastKey) { lastKey = key; rev += 1; }
    return parseState({ ...raw, rev, at: now });
  };

  // The demo offers no control (its state has no `control`, so the page stays hidden) and never sends anything.
  const refuse = async (): Promise<CommandReply> => ({
    ok: false, error: "demo", message: { de: "Demo – nichts gesendet", en: "Demo – nothing sent" }, armed: null, id: null,
  });
  return {
    demo: true,
    state: async () => snapshot(),
    arm: refuse,
    confirm: refuse,
  };
}
