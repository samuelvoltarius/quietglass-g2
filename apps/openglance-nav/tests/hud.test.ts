import { describe, expect, it } from "vitest";
import { validateEvenHubPageContainer } from "@evenrealities/even_hub_sdk";
import { LIMIT_STALE_MS, reckonDistance, RECKON_MAX_MS, SpeedingWatch, speedingTolerance } from "../src/nav/speeding";
import { batteryLine, buildHud, hudChars, hudView, HUD_BOXES, HUD_IMAGES, HUD_WIDTH, speedBig, speedBigKey, type HudOptions } from "../src/glasses/hud";
import { drawHudArrow, drawHudSpeed, drawLimitSign, hudArrowPngs, hudSpeedPng, HUD_ARROW_SIZE, limitSignPng } from "../src/glasses/hud-images";
import { buildPage } from "../src/glasses/render";
import { batteryRange, CAR_BATTERY_MAX_MS, type CarSnapshot } from "../src/car/byd";
import { parseData } from "../src/storage/persist";
import type { Progress } from "../src/nav/navigator";
import type { ManeuverType } from "../src/routing/provider";

describe("speeding warning in the centre", () => {
  it("allows +3 km/h up to a limit of 50 and +5 above", () => {
    expect(speedingTolerance(30)).toBe(3);
    expect(speedingTolerance(50)).toBe(3);
    expect(speedingTolerance(60)).toBe(5);
    expect(speedingTolerance(130)).toBe(5);
  });

  it("appears only after 2 s over limit + tolerance without a break", () => {
    const w = new SpeedingWatch();
    expect(w.update(53, 50, 0, 0)).toBeNull(); // 50 + 3: not over
    expect(w.update(54, 50, 0, 100)).toBeNull(); // over, but just now
    expect(w.update(58, 50, 0, 1_500)).toBeNull();
    // A single jitter back under the line restarts the count.
    expect(w.update(52, 50, 0, 1_900)).toBeNull();
    expect(w.update(58, 50, 0, 2_000)).toBeNull();
    expect(w.update(58, 50, 0, 3_999)).toBeNull();
    expect(w.update(58, 50, 0, 4_000)).toEqual({ kmh: 58, limit: 50 });
    // 100 limit: 105 is fine, 106 is over.
    const fast = new SpeedingWatch();
    fast.update(105, 100, 0, 0);
    expect(fast.update(105, 100, 0, 5_000)).toBeNull();
    fast.update(106, 100, 0, 5_000);
    expect(fast.update(106, 100, 0, 7_000)).toEqual({ kmh: 106, limit: 100 });
  });

  it("goes only after 2 s back at or under the line, and shows the current value meanwhile", () => {
    const w = new SpeedingWatch();
    w.update(60, 50, 0, 0);
    expect(w.update(60, 50, 0, 2_000)).not.toBeNull();
    expect(w.update(52, 50, 0, 2_500)).toEqual({ kmh: 52, limit: 50 });
    // Over again before the 2 s are up: the leave count starts afresh.
    expect(w.update(55, 50, 0, 3_000)).not.toBeNull();
    expect(w.update(50, 50, 0, 3_500)).not.toBeNull();
    expect(w.update(50, 50, 0, 5_499)).not.toBeNull();
    expect(w.update(50, 50, 0, 5_500)).toBeNull();
  });

  it("never warns with an unknown or stale limit (and forgets at once)", () => {
    const w = new SpeedingWatch();
    expect(w.update(90, null, 0, 0)).toBeNull();
    expect(w.update(90, null, 0, 5_000)).toBeNull();
    w.update(90, 50, 0, 10_000);
    expect(w.update(90, 50, 0, 12_000)).not.toBeNull();
    expect(w.update(90, 50, LIMIT_STALE_MS + 1, 12_500)).toBeNull();
    // Fresh again: the 2 s start over.
    expect(w.update(90, 50, 0, 13_000)).toBeNull();
    expect(w.update(null, 50, 0, 14_000)).toBeNull();
  });
});

describe("dead reckoning of the distance to the turn", () => {
  it("counts down with the speed between fixes, never below 0 and at most 4 s ahead", () => {
    expect(reckonDistance(800, 36, 0)).toBe(800);
    expect(reckonDistance(800, 36, 1_000)).toBeCloseTo(790, 6);
    expect(reckonDistance(800, 72, 2_500)).toBeCloseTo(750, 6);
    expect(reckonDistance(800, 72, 60_000)).toBeCloseTo(800 - 20 * RECKON_MAX_MS / 1000, 6);
    expect(reckonDistance(30, 100, 3_000)).toBe(0);
    expect(reckonDistance(800, null, 3_000)).toBe(800);
    expect(reckonDistance(800, 0, 3_000)).toBe(800);
  });
});

describe("battery range", () => {
  const snap = (over: Partial<CarSnapshot> = {}): CarSnapshot => ({
    fetchedAt: 1_000, stale: false, ageS: 5, mode: "driving", speed: 50, soc: 72, rangeKm: 180, cons50: null, batterySource: "car", cloudAgeMin: null, position: null, ...over,
  });

  it("takes the car's own range when the bridge has one", () => {
    expect(batteryRange(snap(), 43.2, 1_000)).toEqual({ km: 180, estimated: false });
  });

  it("estimates from SoC × usable kWh ÷ consumption otherwise, marked as estimate", () => {
    // 72 % of 43.2 kWh = 31.1 kWh at 16 kWh/100 km = 194 km.
    expect(batteryRange(snap({ rangeKm: null }), 43.2, 1_000)).toEqual({ km: 194, estimated: true });
    // The car's 50-km consumption when it has one.
    expect(batteryRange(snap({ rangeKm: null, cons50: 14.4 }), 43.2, 1_000)).toEqual({ km: 216, estimated: true });
    expect(batteryRange(snap({ rangeKm: null, soc: null }), 43.2, 1_000)).toBeNull();
    expect(batteryRange(null, 43.2, 1_000)).toBeNull();
    expect(batteryRange(snap(), 43.2, 1_000 + CAR_BATTERY_MAX_MS + 1)).toBeNull();
  });

  it("reads `Akku 72% → 41% · 180 km`, `≈194 km` for an estimate, in German and English", () => {
    const battery = { soc: 72, arrival: 41, low: false };
    expect(batteryLine(battery, { km: 180, estimated: false }, "de", HUD_WIDTH.status)).toBe("Akku 72% → 41% · 180 km");
    expect(batteryLine(battery, { km: 194, estimated: true }, "de", HUD_WIDTH.status)).toBe("Akku 72% → 41% · ≈194 km");
    expect(batteryLine(battery, { km: 180, estimated: false }, "en", HUD_WIDTH.status)).toBe("Batt 72% → 41% · 180 km");
    expect(batteryLine(null, { km: 180, estimated: false }, "de", HUD_WIDTH.status)).toBe("Reichweite 180 km");
    expect(batteryLine(battery, null, "de", HUD_WIDTH.status)).toBe("Akku 72% → 41%");
    expect(batteryLine(null, null, "de", HUD_WIDTH.status)).toBe("");
    // Too narrow for the range: it gives way first.
    expect(batteryLine(battery, { km: 1180, estimated: true }, "de", 18)).toBe("Akku 72% → 41%");
  });
});

const TYPES: ManeuverType[] = ["depart", "arrive", "left", "slightLeft", "sharpLeft", "right", "slightRight", "sharpRight", "straight", "uturn", "roundabout", "merge", "fork", "exit"];

function progress(type: ManeuverType, street: string, extra: Partial<Progress> = {}): Progress {
  return {
    maneuver: { type, instruction: "Turn", street, length: 900, time: 60, shapeIndex: 4, ...(type === "roundabout" ? { exitNumber: 3 } : {}) },
    distanceToManeuver: 1250, distanceRemaining: 123_400, secondsRemaining: 5_400, offRoute: false, arrived: false, ...extra,
  };
}

/** The busiest HUD there can be: every field at its longest. */
function fullOptions(locale: "de" | "en"): HudOptions {
  return {
    locale, mock: true,
    speed: { kmh: 188, limit: 130, source: "gps" },
    battery: { soc: 100, arrival: 4, low: true },
    range: { km: 1188, estimated: true },
    sugar: { mgdl: 388, arrow: "⇊", stale: false, warning: "lowFalling" },
    brake: { phase: "coast", target: 100, distance: 2400 },
    speeding: { kmh: 188, limit: 130 },
    charger: "Laden in 123 km · 350 kW",
    appointment: { startMs: Date.now() + 3_600_000, title: "Sehr langer Termin mit Kunde" },
  };
}

describe("HUD layout on the glasses", () => {
  it("stays within the G2 page limits: ≤ 4 images of ≤ 288 × 144, ≤ 8 texts, ≤ 12 containers, one input capture", () => {
    const page = buildPage(hudView(buildHud(progress("right", "Vogelweiderstraße"), fullOptions("de"))), "hud");
    const images = page.imageObject ?? [];
    const texts = page.textObject ?? [];
    expect(images.length).toBeLessThanOrEqual(4);
    expect(texts.length).toBeLessThanOrEqual(8);
    expect(images.length + texts.length).toBeLessThanOrEqual(12);
    expect(page.containerTotalNum).toBe(images.length + texts.length);
    for (const image of images) {
      expect(image.width!).toBeLessThanOrEqual(288);
      expect(image.height!).toBeLessThanOrEqual(144);
    }
    expect(texts.filter((text) => text.isEventCapture === 1)).toHaveLength(1);
    const ids = [...images, ...texts].map((c) => c.containerID);
    expect(new Set(ids).size).toBe(ids.length);
    const z = [...images, ...texts].map((c) => c.zOrderIndex);
    expect(new Set(z).size).toBe(z.length);
    const result = validateEvenHubPageContainer(page as never);
    expect(result.valid, JSON.stringify(result)).toBe(true);
  });

  it("keeps every box on the 576 × 288 display, the arrow right of centre, the limit sign and speed on the left", () => {
    for (const box of [...Object.values(HUD_BOXES), ...Object.values(HUD_IMAGES)]) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(576);
      expect(box.y + box.height).toBeLessThanOrEqual(288);
    }
    expect(HUD_IMAGES.arrowTop.x).toBeGreaterThan(288);
    expect(HUD_IMAGES.arrowTop.height + HUD_IMAGES.arrowBottom.height).toBe(HUD_ARROW_SIZE);
    expect(HUD_IMAGES.limit.x + HUD_IMAGES.limit.width).toBeLessThan(288);
    expect(HUD_IMAGES.speed.x + HUD_IMAGES.speed.width).toBeLessThan(288);
    // The middle stays empty except for the speeding warning.
    const middle = { x: 184, y: 62, width: 184, height: 138 };
    const overlaps = (a: { x: number; y: number; width: number; height: number }) =>
      a.x < middle.x + middle.width && a.x + a.width > middle.x && a.y < middle.y + middle.height && a.y + a.height > middle.y;
    const inMiddle = Object.entries({ ...HUD_BOXES, ...HUD_IMAGES }).filter(([, box]) => overlaps(box)).map(([name]) => name);
    expect(inMiddle).toEqual(["center"]);
  });

  it("fits every line into its box in German and English, for every turn, with all fields at their longest", () => {
    const streets = ["Vogelweiderstraße", "Sehr lange Bundesstraße mit Namen und Zusatz Nummer 158", ""];
    for (const locale of ["de", "en"] as const) {
      for (const type of TYPES) {
        for (const street of streets) {
          const hud = buildHud(progress(type, street), fullOptions(locale));
          const lines = (text: string) => text.split("\n");
          expect(lines(hud.status).length).toBeLessThanOrEqual(2);
          for (const line of lines(hud.status)) expect(line.length, line).toBeLessThanOrEqual(HUD_WIDTH.status);
          expect(hud.center.length, hud.center).toBeLessThanOrEqual(HUD_WIDTH.center);
          expect(hud.center).not.toContain("…");
          expect(hud.distance.length, hud.distance).toBeLessThanOrEqual(HUD_WIDTH.distance);
          expect(hud.street.length, hud.street).toBeLessThanOrEqual(HUD_WIDTH.street);
          expect(hud.alert.length, hud.alert).toBeLessThanOrEqual(HUD_WIDTH.alert);
          expect(hud.alert).not.toContain("\n");
        }
      }
    }
  });

  it("shows what the owner asked for: ETA, km left, battery top left; speed and limit left; distance and street right", () => {
    const now = new Date(2026, 9, 14, 13, 2).getTime();
    const hud = buildHud(progress("right", "Vogelweiderstraße", { distanceRemaining: 23_000, secondsRemaining: 30 * 60 }), {
      locale: "de",
      speed: { kmh: 52, limit: 50 },
      battery: { soc: 72, arrival: 41, low: false },
      range: { km: 180, estimated: false },
      sugar: { mgdl: 128, arrow: "↗", stale: false, warning: null },
      distanceToTurn: 250,
    }, now);
    expect(hud.status).toBe("13:32 · 23 km · 128↗\nAkku 72% → 41% · 180 km");
    expect(hud.speed).toBe("52 km/h");
    expect(hud.limit).toBe(50);
    expect(hud.distance).toBe("250 m");
    expect(hud.street).toBe("Vogelweiderstraße");
    expect(hud.arrow).toBe("right");
    expect(hud.alert).toBe("");
    expect(hud.center).toBe("");
    expect(hudChars(576)).toBe(HUD_WIDTH.alert);
  });

  it("keeps navigation states on the same page: armed stop in the centre, off route in the line", () => {
    const armed = buildHud(progress("left", "A"), { locale: "de", state: "armed" });
    expect(armed.center.trim()).toBe("Nochmal tippen = Stopp");
    expect(armed.alert.trim()).toBe("Nochmal tippen = stoppen · Wischen/2× = abbrechen");
    expect(buildHud(progress("left", "A"), { locale: "en", state: "offRoute" }).alert.trim()).toBe("Off route · Tap = reroute");
    expect(buildHud(progress("left", "A"), { locale: "de", state: "waitingFix" }).distance).toBe("--");
  });

  it("draws a 200 px arrow for every manoeuvre in two halves, and the limit sign with its number", async () => {
    for (const type of TYPES) {
      const canvas = drawHudArrow(type);
      expect(canvas.pixels.some((p) => p > 0), type).toBe(true);
    }
    expect(drawHudArrow(undefined).pixels.every((p) => p === 0)).toBe(true);
    const [top, bottom] = await hudArrowPngs("right");
    expect([...top.slice(1, 4)].map((c) => String.fromCharCode(c)).join("")).toBe("PNG");
    expect(bottom.length).toBeGreaterThan(0);
    const sign = drawLimitSign(50);
    expect(sign.pixels.filter((p) => p > 0).length).toBeGreaterThan(500);
    expect(drawLimitSign(null).pixels.every((p) => p === 0)).toBe(true);
    expect((await limitSignPng(130)).length).toBeGreaterThan(0);
  });
});

describe("HUD layout setting", () => {
  it("defaults to the new layout and remembers classic", () => {
    expect(parseData(JSON.stringify({})).hudLayout).toBe("new");
    expect(parseData(JSON.stringify({ hudLayout: "classic" })).hudLayout).toBe("classic");
    expect(parseData(JSON.stringify({ hudLayout: "fancy" })).hudLayout).toBe("new");
  });
});

describe("large speed digits (an image: the glasses have one text size)", () => {
  const lit = (canvas: { pixels: Uint8Array }) => canvas.pixels.filter((v) => v === 255).length;
  /** Lit pixels in columns [x0, x1). */
  const litIn = (canvas: { width: number; height: number; pixels: Uint8Array }, x0: number, x1: number) => {
    let n = 0;
    for (let y = 0; y < canvas.height; y++) for (let x = x0; x < x1; x++) if (canvas.pixels[y * canvas.width + x] === 255) n++;
    return n;
  };

  it("is the fourth HUD picture, left below the sign, inside the page limits", () => {
    const page = buildPage(hudView(buildHud(progress("right", "A"), { locale: "de", speed: { kmh: 52, limit: 50 } })), "hud");
    const names = (page.imageObject ?? []).map((image) => image.containerName);
    expect(names).toEqual(["hud-arr-top", "hud-arr-bot", "hud-limit", "hud-speed"]);
    expect((page.textObject ?? []).map((text) => text.containerName)).not.toContain("hud-speed");
    expect(HUD_IMAGES.speed.y).toBeGreaterThanOrEqual(HUD_IMAGES.limit.y + HUD_IMAGES.limit.height);
  });

  it("draws the digits 49 px high with a small km/h, and keeps 3 digits plus unit inside 184 px", () => {
    const canvas = drawHudSpeed({ kmh: 188, fast: false, gps: false });
    expect(canvas.width).toBe(184);
    expect(canvas.height).toBe(64);
    let top = canvas.height, bottom = 0;
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < 130; x++) if (canvas.pixels[y * canvas.width + x] === 255) { top = Math.min(top, y); bottom = Math.max(bottom, y); }
    expect(bottom - top + 1).toBe(49);
    expect(litIn(canvas, 130, 184)).toBeGreaterThan(0); // the unit
    expect(litIn(canvas, 182, 184)).toBe(0); // nothing touches the right edge
  });

  it("turns round when too fast (white plate, dark digits), stays black without a reading, shows gps small", () => {
    const normal = drawHudSpeed({ kmh: 72, fast: false, gps: false });
    const fast = drawHudSpeed({ kmh: 72, fast: true, gps: false });
    expect(lit(fast)).toBeGreaterThan(fast.pixels.length / 2);
    expect(lit(fast) + lit(normal)).toBe(normal.pixels.length);
    expect(lit(drawHudSpeed(null))).toBe(0);
    expect(lit(drawHudSpeed({ kmh: 72, fast: false, gps: true }))).toBeGreaterThan(lit(normal));
    expect(lit(drawHudSpeed({ kmh: null, fast: false, gps: false }))).toBeGreaterThan(0); // "--"
  });

  it("follows the reading: key changes with km/h, too fast and gps only", () => {
    expect(speedBig(null)).toBeNull();
    expect(speedBig({ kmh: 72, limit: 50 })).toEqual({ kmh: 72, fast: true, gps: false });
    expect(speedBig({ kmh: 48, limit: 50, source: "gps" })).toEqual({ kmh: 48, fast: false, gps: true });
    expect(speedBigKey(speedBig({ kmh: 48, limit: 50 }))).toBe(speedBigKey(speedBig({ kmh: 48, limit: 70 })));
    expect(speedBigKey(speedBig({ kmh: 48, limit: 50 }))).not.toBe(speedBigKey(speedBig({ kmh: 49, limit: 50 })));
    expect(buildHud(progress("right", "A"), { speed: { kmh: 52, limit: 50 } }).speedBig).toEqual({ kmh: 52, fast: false, gps: false });
  });

  it("is a small PNG (mostly black), cheap over Bluetooth", async () => {
    const png = await hudSpeedPng({ kmh: 130, fast: false, gps: false });
    expect([...png.slice(1, 4)].map((c) => String.fromCharCode(c)).join("")).toBe("PNG");
    expect(png.length).toBeLessThan(2000);
  });
});
