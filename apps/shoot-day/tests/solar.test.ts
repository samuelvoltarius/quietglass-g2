import { describe, expect, it } from "vitest";
import { compassPoint, moonPhase, moonPhaseName, sunPosition, sunTimes } from "../src/sun/solar";
import { dayLight, lightAt, nextLight, phaseOf, place } from "../src/sun/light";

// Salzburg, 47.8° N 13.04° E. Reference values computed independently with
// astropy 8 (ERFA ephemeris, geometric altitude without refraction, 15 s grid):
// sunrise/sunset at −0.833°, golden hour +6°…−4°, blue hour −4°…−6°, noon at
// the highest point. Tolerance ±2 min for times and ±0.5° for angles.
const SALZBURG = { latitude: 47.8, longitude: 13.04 };
const MIN = 60_000;
const utc = (iso: string): number => Date.parse(iso);
// The light helpers cut days at local noon in the phone's time zone.
(globalThis as unknown as { process: { env: Record<string, string> } }).process.env.TZ = "Europe/Vienna";

function expectTime(actual: number | null, iso: string, label: string): void {
  expect(actual, label).not.toBeNull();
  expect(Math.abs((actual ?? 0) - utc(iso)) / MIN, `${label}: ${new Date(actual ?? 0).toISOString()} vs ${iso}`).toBeLessThanOrEqual(2);
}

const REFERENCE = [
  {
    day: "2026-03-20T11:00:00Z", noon: "2026-03-20T11:15:30Z", noonElevation: 42.14,
    sunrise: "2026-03-20T05:11:07Z", sunset: "2026-03-20T17:20:20Z",
    up6: "2026-03-20T05:51:50Z", down6: "2026-03-20T16:39:32Z",
    up4: "2026-03-20T04:52:16Z", down4: "2026-03-20T17:39:15Z",
    up6below: "2026-03-20T04:40:19Z", down6below: "2026-03-20T17:51:14Z",
  },
  {
    day: "2026-06-21T11:00:00Z", noon: "2026-06-21T11:09:45Z", noonElevation: 65.64,
    sunrise: "2026-06-21T03:09:08Z", sunset: "2026-06-21T19:10:09Z",
    up6: "2026-06-21T03:57:43Z", down6: "2026-06-21T18:21:34Z",
    up4: "2026-06-21T02:44:36Z", down4: "2026-06-21T19:34:42Z",
    up6below: "2026-06-21T02:28:07Z", down6below: "2026-06-21T19:51:11Z",
  },
  {
    day: "2026-10-14T11:00:00Z", noon: "2026-10-14T10:53:30Z", noonElevation: 33.96,
    sunrise: "2026-10-14T05:25:14Z", sunset: "2026-10-14T16:21:43Z",
    up6: "2026-10-14T06:07:28Z", down6: "2026-10-14T15:39:32Z",
    up4: "2026-10-14T05:06:05Z", down4: "2026-10-14T16:40:50Z",
    up6below: "2026-10-14T04:54:05Z", down6below: "2026-10-14T16:52:49Z",
  },
  {
    day: "2026-12-21T11:00:00Z", noon: "2026-12-21T11:06:00Z", noonElevation: 18.76,
    sunrise: "2026-12-21T06:53:56Z", sunset: "2026-12-21T15:17:49Z",
    up6: "2026-12-21T07:47:19Z", down6: "2026-12-21T14:24:28Z",
    up4: "2026-12-21T06:31:25Z", down4: "2026-12-21T15:40:22Z",
    up6below: "2026-12-21T06:17:40Z", down6below: "2026-12-21T15:54:06Z",
  },
];

describe("sun times against reference values (Salzburg)", () => {
  for (const ref of REFERENCE) {
    it(ref.day.slice(0, 10), () => {
      const times = sunTimes(utc(ref.day), SALZBURG.latitude, SALZBURG.longitude);
      expectTime(times.noon, ref.noon, "solar noon");
      expect(Math.abs(times.noonElevation - ref.noonElevation)).toBeLessThanOrEqual(0.5);
      expectTime(times.sunrise, ref.sunrise, "sunrise");
      expectTime(times.sunset, ref.sunset, "sunset");
      expectTime(times.blueMorning.start, ref.up6below, "blue hour morning start (−6°)");
      expectTime(times.blueMorning.end, ref.up4, "blue hour morning end (−4°)");
      expectTime(times.goldenMorning.start, ref.up4, "golden hour morning start (−4°)");
      expectTime(times.goldenMorning.end, ref.up6, "golden hour morning end (+6°)");
      expectTime(times.goldenEvening.start, ref.down6, "golden hour evening start (+6°)");
      expectTime(times.goldenEvening.end, ref.down4, "golden hour evening end (−4°)");
      expectTime(times.blueEvening.start, ref.down4, "blue hour evening start (−4°)");
      expectTime(times.blueEvening.end, ref.down6below, "blue hour evening end (−6°)");
    });
  }

  it("orders the evening: golden (+6° → −4°) runs into blue (−4° → −6°)", () => {
    const times = sunTimes(utc("2026-06-21T11:00:00Z"), SALZBURG.latitude, SALZBURG.longitude);
    const { goldenEvening, blueEvening, sunset, goldenMorning, blueMorning, sunrise } = times;
    expect(goldenEvening.start!).toBeLessThan(sunset!);
    expect(sunset!).toBeLessThan(goldenEvening.end!);
    expect(goldenEvening.end).toBe(blueEvening.start);
    expect(blueMorning.end).toBe(goldenMorning.start);
    expect(goldenMorning.start!).toBeLessThan(sunrise!);
  });

  it("returns no sunrise in polar night and in midnight sun", () => {
    const tromsoWinter = sunTimes(utc("2026-12-21T11:00:00Z"), 69.65, 18.96);
    expect(tromsoWinter.sunrise).toBeNull();
    expect(tromsoWinter.sunset).toBeNull();
    // Polar night still has a short, low golden and blue light around noon (noon elevation about −3°).
    expect(tromsoWinter.noonElevation).toBeLessThan(-0.833);
    expect(tromsoWinter.goldenMorning.start).not.toBeNull();
    const tromsoSummer = sunTimes(utc("2026-06-21T11:00:00Z"), 69.65, 18.96);
    expect(tromsoSummer.sunrise).toBeNull();
    expect(tromsoSummer.sunset).toBeNull();
    // Midnight sun: lowest about +3°, so it dips into golden light but never into blue.
    expect(tromsoSummer.blueEvening.start).toBeNull();
  });
});

describe("sun position", () => {
  it("is due south and at its highest at solar noon", () => {
    const noon = sunPosition(utc("2026-06-21T11:09:39Z"), SALZBURG.latitude, SALZBURG.longitude);
    expect(Math.abs(noon.azimuth - 180)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(noon.elevation - 65.63)).toBeLessThanOrEqual(0.5);
  });

  it("rises in the north-east and sets in the north-west at midsummer", () => {
    // astropy: 03:09:08 UTC −0.834° az 52.54°, 19:10:09 UTC −0.833° az 307.46°.
    const rise = sunPosition(utc("2026-06-21T03:09:08Z"), SALZBURG.latitude, SALZBURG.longitude);
    expect(Math.abs(rise.azimuth - 52.54)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(rise.elevation - -0.834)).toBeLessThanOrEqual(0.5);
    const set = sunPosition(utc("2026-06-21T19:10:09Z"), SALZBURG.latitude, SALZBURG.longitude);
    expect(Math.abs(set.azimuth - 307.46)).toBeLessThanOrEqual(0.5);
    // Mid-afternoon: astropy 16:00 UTC 28.63° az 274.16°; 2026-10-14 16:30 UTC −2.20° az 260.01°.
    const afternoon = sunPosition(utc("2026-06-21T16:00:00Z"), SALZBURG.latitude, SALZBURG.longitude);
    expect(Math.abs(afternoon.elevation - 28.63)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(afternoon.azimuth - 274.16)).toBeLessThanOrEqual(0.5);
    const october = sunPosition(utc("2026-10-14T16:30:00Z"), SALZBURG.latitude, SALZBURG.longitude);
    expect(Math.abs(october.elevation - -2.2)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(october.azimuth - 260.01)).toBeLessThanOrEqual(0.5);
  });

  it("is (nearly) due east on the horizon at sunrise on the equator at the equinox", () => {
    // astropy: 2026-03-20 06:07 UTC at 0°/0°: −0.13°, az 90.14°.
    const rise = sunPosition(utc("2026-03-20T06:07:00Z"), 0, 0);
    expect(Math.abs(rise.azimuth - 90.14)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(rise.elevation - -0.13)).toBeLessThanOrEqual(0.5);
  });
});

describe("compass letters", () => {
  it("names 16 points, German with O for east", () => {
    expect(compassPoint(0, "de")).toBe("N");
    expect(compassPoint(45, "de")).toBe("NO");
    expect(compassPoint(90, "de")).toBe("O");
    expect(compassPoint(112.5, "de")).toBe("OSO");
    expect(compassPoint(247.5, "de")).toBe("WSW");
    expect(compassPoint(359, "de")).toBe("N");
    expect(compassPoint(-90, "en")).toBe("W");
    expect(compassPoint(67.5, "en")).toBe("ENE");
  });
});

describe("moon", () => {
  it("is full on 2026-05-31 and new on 2026-06-15", () => {
    // Full moon 2026-05-31 08:45 UTC, new moon 2026-06-15 02:54 UTC.
    const full = moonPhase(utc("2026-05-31T08:45:00Z"));
    expect(full.fraction).toBeGreaterThan(0.98);
    expect(moonPhaseName(full.phase)).toBe("full");
    const fresh = moonPhase(utc("2026-06-15T02:54:00Z"));
    expect(fresh.fraction).toBeLessThan(0.02);
    expect(moonPhaseName(fresh.phase)).toBe("new");
  });
});

describe("light for photographers", () => {
  it("names the phase by elevation", () => {
    expect(phaseOf(20)).toBe("day");
    expect(phaseOf(6)).toBe("day");
    expect(phaseOf(5.9)).toBe("golden");
    expect(phaseOf(-4)).toBe("golden");
    expect(phaseOf(-5)).toBe("blue");
    expect(phaseOf(-7)).toBe("night");
  });

  it("finds the next golden hour in the afternoon and the running one in the evening", () => {
    const afternoon = nextLight(utc("2026-06-21T16:00:00Z"), SALZBURG);
    expect(afternoon?.window.kind).toBe("golden");
    expect(afternoon?.window.evening).toBe(true);
    expect(afternoon?.now).toBe(false);
    // 16:00 UTC → golden hour from 18:21:34 UTC (astropy): 142 minutes.
    expect(Math.abs((afternoon?.inMinutes ?? 0) - 142)).toBeLessThanOrEqual(2);

    const evening = nextLight(utc("2026-06-21T18:30:00Z"), SALZBURG);
    expect(evening?.now).toBe(true);
    expect(evening?.inMinutes).toBe(0);
    expect(lightAt(utc("2026-06-21T18:30:00Z"), SALZBURG).phase).toBe("golden");

    // After the evening blue hour the next one is tomorrow morning's blue hour.
    const night = nextLight(utc("2026-06-21T21:00:00Z"), SALZBURG);
    expect(night?.window.kind).toBe("blue");
    expect(night?.window.evening).toBe(false);
    expect(night?.window.start).toBeGreaterThan(utc("2026-06-22T00:00:00Z"));
  });

  it("lists four windows a day in time order", () => {
    const day = dayLight(utc("2026-06-21T11:00:00Z"), SALZBURG);
    expect(day.windows.map((w) => `${w.kind}${w.evening ? "E" : "M"}`)).toEqual(["blueM", "goldenM", "goldenE", "blueE"]);
  });

  it("accepts only real coordinates", () => {
    expect(place(47.8, 13.04)).toEqual(SALZBURG);
    expect(place("47.8", "13.04")).toEqual(SALZBURG);
    expect(place(91, 0)).toBeNull();
    expect(place(0, 0)).toBeNull();
    expect(place(undefined, 13)).toBeNull();
    expect(place("x", 13)).toBeNull();
  });
});
