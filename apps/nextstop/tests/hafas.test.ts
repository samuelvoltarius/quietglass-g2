import { afterEach, describe, expect, it, vi } from "vitest";
import { HafasBackend, hafasDay } from "../src/transit/hafas";

/** A fetch that answers every HAFAS call with the given `res`. */
function answering(res: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify({ svcResL: [{ err: "OK", res }] }), { status: 200 })) as typeof fetch;
}

describe("HAFAS times across midnight", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("counts a departure's time from its journey's own day", async () => {
    // Regression: "01001500" on a journey that started yesterday was counted
    // from today, so at 00:10 the bus due at 00:15 showed as 24 hours away.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 2, 10, 0, 10, 0));
    const backend = new HafasBackend({
      fetchImpl: answering({
        common: { prodL: [{ name: "Bus 840" }] },
        jnyL: [{ jid: "j1", prodX: 0, date: "20260309", dirTxt: "Flughafen", stbStop: { dTimeS: "01001500" } }],
      }),
    });
    const [departure] = await backend.departures("123", 5);
    expect(departure?.scheduled).toEqual(new Date(2026, 2, 10, 0, 15, 0));
    expect(departure?.inMinutes).toBe(5);
  });

  it("tracks a ride that started yesterday on the right day", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 2, 10, 0, 10, 0));
    const backend = new HafasBackend({
      fetchImpl: answering({
        common: { prodL: [{ name: "N1" }], locL: [{ name: "A", extId: "1" }, { name: "B", extId: "2" }] },
        journey: {
          date: "20260309", prodX: 0, dirTxt: "B",
          stopL: [{ locX: 0, dTimeS: "235500" }, { locX: 1, aTimeS: "01002000" }],
        },
      }),
    });
    const ride = await backend.ride("j1");
    expect(ride?.stops[0]?.scheduled).toEqual(new Date(2026, 2, 9, 23, 55, 0));
    expect(ride?.stops[1]?.scheduled).toEqual(new Date(2026, 2, 10, 0, 20, 0));
  });

  it("falls back to today when a journey carries no date", () => {
    const today = new Date(2026, 5, 1, 12, 0, 0);
    expect(hafasDay(undefined, today)).toBe(today);
    expect(hafasDay("garbage", today)).toBe(today);
    expect(hafasDay("20260601", today)).toEqual(new Date(2026, 5, 1));
  });
});
