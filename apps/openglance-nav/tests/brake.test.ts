import { describe, expect, it } from "vitest";
import {
  BRAKE_DECEL, BrakeAdvisor, brakeHintAt, brakePoint, coastPoint, COAST_DECEL, limitDrops, stoppingDistance, type LimitDrop,
} from "../src/nav/brake";
import { alertCandidates, brakeText, buildHud, ALERT_ORDER } from "../src/glasses/hud";
import type { Progress } from "../src/nav/navigator";

const kmh = (v: number): number => v / 3.6;

describe("brake maths", () => {
  it("uses d = (v² − vt²) / 2a with 0.8 m/s² rolling and 1.5 m/s² braking", () => {
    const v = kmh(100), vt = kmh(50);
    expect(stoppingDistance(100, 50, COAST_DECEL)).toBeCloseTo((v * v - vt * vt) / 1.6, 6);
    expect(stoppingDistance(100, 50, BRAKE_DECEL)).toBeCloseTo((v * v - vt * vt) / 3, 6);
    // 100 → 50: about 362 m rolling, 193 m braking.
    expect(Math.round(stoppingDistance(100, 50, COAST_DECEL))).toBe(362);
    expect(Math.round(stoppingDistance(100, 50, BRAKE_DECEL))).toBe(193);
    expect(stoppingDistance(50, 50, COAST_DECEL)).toBe(0);
    expect(stoppingDistance(40, 50, COAST_DECEL)).toBe(0);
  });

  it("adds 3 s of travel to the rolling point and 1 s to the braking point", () => {
    expect(coastPoint(100, 50)).toBeCloseTo(stoppingDistance(100, 50, 0.8) + 3 * kmh(100), 6);
    expect(brakePoint(100, 50)).toBeCloseTo(stoppingDistance(100, 50, 1.5) + kmh(100), 6);
    // Town sign at 100 km/h: "vom Gas" about 445 m before it, "BREMSEN" about 221 m before.
    expect(Math.round(coastPoint(100, 50))).toBe(445);
    expect(Math.round(brakePoint(100, 50))).toBe(221);
  });

  it("finds the drops of a route from its limit spans, skipping unknown stretches", () => {
    const along = Array.from({ length: 11 }, (_, i) => i * 100);
    const spans = [
      { from: 0, to: 3, limit: 100 },
      { from: 3, to: 4, limit: null },
      { from: 4, to: 6, limit: 50 },
      { from: 6, to: 8, limit: 70 },
      { from: 8, to: 10, limit: 30 },
    ];
    expect(limitDrops(spans, along)).toEqual([
      { along: 400, from: 100, to: 50 },
      { along: 800, from: 70, to: 30 },
    ]);
    expect(limitDrops([], along)).toEqual([]);
  });
});

describe("brake hint", () => {
  const town: LimitDrop[] = [{ along: 1000, from: 100, to: 50 }];

  it("says nothing far away, rolls, then brakes as the sign comes closer", () => {
    expect(brakeHintAt(town, 400, 100)).toBeNull(); // 600 m before: more than 445
    expect(brakeHintAt(town, 600, 100)).toEqual({ phase: "coast", target: 50, distance: 400 });
    expect(brakeHintAt(town, 800, 100)).toEqual({ phase: "brake", target: 50, distance: 200 });
    // Already slow enough (within +5): nothing.
    expect(brakeHintAt(town, 800, 55)).toBeNull();
    expect(brakeHintAt(town, 800, null)).toBeNull();
  });

  it("keeps the hint until the speed is within 5 km/h of the new limit, and never steps back from brake to coast", () => {
    const advisor = new BrakeAdvisor();
    expect(advisor.update(town, 600, 100)?.phase).toBe("coast");
    // Rolling slows the car: the rolling distance shrinks below the distance left, the hint stays.
    expect(advisor.update(town, 700, 70)).toEqual({ phase: "coast", target: 50, distance: 300 });
    expect(advisor.update(town, 900, 70)?.phase).toBe("coast"); // 100 m left, braking point at 70 km/h is 81 m
    expect(advisor.update(town, 930, 70)?.phase).toBe("brake");
    expect(advisor.update(town, 950, 60)?.phase).toBe("brake");
    // Past the sign and still too fast: "now".
    expect(advisor.update(town, 1050, 60)).toEqual({ phase: "brake", target: 50, distance: 0 });
    // 55 km/h = target + 5: cleared.
    expect(advisor.update(town, 1060, 55)).toBeNull();
    expect(advisor.update(town, 1070, 56)).toBeNull();
  });

  it("drops the hint once the sign lies 150 m behind", () => {
    const advisor = new BrakeAdvisor();
    expect(advisor.update(town, 990, 80)?.phase).toBe("brake");
    expect(advisor.update(town, 1160, 80)).toBeNull();
  });

  it("reads `▼ 50 in 300 m – vom Gas`, `BREMSEN · 50 in 120 m`, `BREMSEN · 50 jetzt` (and English)", () => {
    expect(brakeText({ phase: "coast", target: 50, distance: 300 }, "de")).toBe("▼ 50 in 300 m – vom Gas");
    expect(brakeText({ phase: "brake", target: 50, distance: 120 }, "de")).toBe("BREMSEN · 50 in 120 m");
    expect(brakeText({ phase: "brake", target: 50, distance: 0 }, "de")).toBe("BREMSEN · 50 jetzt");
    expect(brakeText({ phase: "coast", target: 70, distance: 1200 }, "en")).toBe("▼ 70 in 1.2 km – ease off");
    expect(brakeText({ phase: "brake", target: 30, distance: 80 }, "en")).toBe("BRAKE · 30 in 80 m");
  });
});

describe("alert priority (one line)", () => {
  const progress: Progress = {
    maneuver: { type: "right", instruction: "Turn right", street: "Hauptstraße", shapeIndex: 5, length: 500 } as Progress["maneuver"],
    distanceToManeuver: 400, distanceRemaining: 12_000, secondsRemaining: 900, offRoute: false, arrived: false,
  };
  const brake = { phase: "coast" as const, target: 50, distance: 300 };
  const lowFalling = { mgdl: 72, arrow: "↘", stale: false, warning: "lowFalling" as const };
  const low = { mgdl: 65, arrow: "→", stale: false, warning: "low" as const };
  const battery = { soc: 12, arrival: 4, low: true };
  const now = new Date(2026, 9, 14, 10, 0).getTime();

  it("orders glucose low & falling, brake, glucose low, traffic near, speed hint, detour, traffic far, battery, appointment, charger", () => {
    expect(ALERT_ORDER).toEqual([
      "sugarLowFalling", "brake", "sugarLow", "trafficNear", "camera", "detour", "trafficFar", "lowBattery", "appointment", "charger",
    ]);
    const all = alertCandidates(progress, {
      locale: "de", brake, sugar: lowFalling, battery, charger: "Laden in 12 km · 150 kW",
      appointment: { startMs: now + 30 * 60_000, title: "Kunde" },
    }, now).map((a) => a.kind);
    expect(all).toEqual(["sugarLowFalling", "brake", "lowBattery", "appointment", "charger"]);
  });

  it("puts glucose low & falling above the brake hint, the brake hint above glucose low", () => {
    expect(buildHud(progress, { locale: "de", brake, sugar: lowFalling }, now).alert.trim()).toBe("! 72↘ niedrig & fallend");
    expect(buildHud(progress, { locale: "de", brake, sugar: low }, now).alert.trim()).toBe("▼ 50 in 300 m – vom Gas");
    expect(buildHud(progress, { locale: "de", sugar: low }, now).alert.trim()).toBe("! 65→ niedrig");
    expect(buildHud(progress, { locale: "de", battery }, now).alert.trim()).toBe("Ankunft ~4 % – Ladestopp planen");
    expect(buildHud(progress, { locale: "de", charger: "Laden in 12 km" }, now).alert.trim()).toBe("Laden in 12 km");
  });

  it("lets the central speeding warning win over the brake hint while over the CURRENT limit", () => {
    const hud = buildHud(progress, { locale: "de", brake, speeding: { kmh: 58, limit: 50 }, charger: "Laden in 12 km" }, now);
    expect(hud.center.trim()).toBe("ZU SCHNELL  58 / 50");
    // The line falls through to the next alert instead of repeating "slow down".
    expect(hud.alert.trim()).toBe("Laden in 12 km");
    // Glucose low & falling still owns the line.
    expect(buildHud(progress, { locale: "de", brake, speeding: { kmh: 58, limit: 50 }, sugar: lowFalling }, now).alert.trim()).toBe("! 72↘ niedrig & fallend");
  });
});
