import { describe, expect, it } from "vitest";
import { spokenMeters, thresholdsFor, TurnAnnouncer, type AnnounceContext } from "../src/speech/announcer";
import type { Progress } from "../src/nav/navigator";
import type { Maneuver } from "../src/routing/provider";

const turn = (patch: Partial<Maneuver> = {}): Maneuver => ({ type: "left", instruction: "", length: 500, time: 60, shapeIndex: 10, ...patch });
const progress = (distance: number, maneuver: Maneuver | null = turn(), patch: Partial<Progress> = {}): Progress => ({
  maneuver, distanceToManeuver: distance, distanceRemaining: 2000, secondsRemaining: 300, offRoute: false, arrived: false, ...patch,
});
const ctx = (patch: Partial<AnnounceContext> = {}): AnnounceContext => ({ routeId: 1, mode: "driving", locale: "de", hasFix: true, ...patch });

describe("turn announcements", () => {
  it("says the far announcement once at 200 m and the near one once at 30 m while driving", () => {
    const a = new TurnAnnouncer();
    expect(a.next(progress(450), ctx())).toBeNull();
    const far = a.next(progress(198), ctx());
    expect(far?.text).toBe("In 200 Metern links abbiegen.");
    expect(far?.priority).toBe(1);
    expect(a.next(progress(150), ctx())).toBeNull();
    expect(a.next(progress(60), ctx())).toBeNull();
    const near = a.next(progress(28), ctx());
    expect(near?.text).toBe("Jetzt links abbiegen.");
    expect(near?.priority).toBe(2);
    expect(near?.key).toBe(far?.key);
    expect(a.next(progress(12), ctx())).toBeNull();
    expect(a.next(progress(35), ctx())).toBeNull();
  });

  it("announces the next turn afresh", () => {
    const a = new TurnAnnouncer();
    a.next(progress(190), ctx());
    a.next(progress(20), ctx());
    const second = turn({ type: "right", shapeIndex: 30, street: "Hauptstraße" });
    expect(a.next(progress(180, second), ctx())?.text).toBe("In 200 Metern rechts abbiegen auf Hauptstraße.");
  });

  it("skips the far announcement when the turn is first seen close by", () => {
    const a = new TurnAnnouncer();
    expect(a.next(progress(25), ctx())?.text).toBe("Jetzt links abbiegen.");
    expect(a.next(progress(20), ctx())).toBeNull();
  });

  it("uses shorter distances on foot and by bike, and English when asked", () => {
    expect(thresholdsFor("walking")).toEqual({ far: 60, near: 15 });
    expect(thresholdsFor("cycling").far).toBe(100);
    const a = new TurnAnnouncer();
    expect(a.next(progress(150), ctx({ mode: "walking", locale: "en" }))).toBeNull();
    expect(a.next(progress(58), ctx({ mode: "walking", locale: "en" }))?.text).toBe("In 60 meters turn left.");
    expect(a.next(progress(14), ctx({ mode: "walking", locale: "en" }))?.text).toBe("Turn left now.");
  });

  it("rounds spoken distances", () => {
    expect(spokenMeters(187)).toBe(200);
    expect(spokenMeters(140)).toBe(150);
    expect(spokenMeters(87)).toBe(90);
    expect(spokenMeters(3)).toBe(10);
  });

  it("stays silent without a GPS fix, for straight and depart, and says nothing twice after a new route only once more", () => {
    const a = new TurnAnnouncer();
    expect(a.next(progress(100), ctx({ hasFix: false }))).toBeNull();
    expect(a.next(progress(100, turn({ type: "straight" })), ctx())).toBeNull();
    expect(a.next(progress(100, turn({ type: "depart" })), ctx())).toBeNull();
    expect(a.next(progress(100), ctx())).not.toBeNull();
    expect(a.next(progress(100), ctx())).toBeNull();
    // A reroute produces a new route id: the same turn is announced again.
    expect(a.next(progress(100), ctx({ routeId: 2 }))).not.toBeNull();
  });

  it("announces arrival once and a left route once", () => {
    const a = new TurnAnnouncer();
    expect(a.next(progress(400, turn(), { offRoute: true }), ctx())?.text).toContain("Route verlassen");
    expect(a.next(progress(400, turn(), { offRoute: true }), ctx())).toBeNull();
    expect(a.next(progress(0, null, { arrived: true }), ctx({ routeId: 2 }))?.text).toBe("Sie haben Ihr Ziel erreicht.");
    expect(a.next(progress(0, null, { arrived: true }), ctx({ routeId: 2 }))).toBeNull();
  });

  it("warns before the destination but not with a near message", () => {
    const a = new TurnAnnouncer();
    const arrive = turn({ type: "arrive", shapeIndex: 99 });
    expect(a.next(progress(180, arrive), ctx())?.text).toBe("In 200 Metern erreichen Sie Ihr Ziel.");
    expect(a.next(progress(20, arrive), ctx())).toBeNull();
  });
});
