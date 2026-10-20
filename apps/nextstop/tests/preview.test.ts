import { describe, expect, it } from "vitest";
import { boardModel, type CockpitModel } from "../src/cockpit/model";
import { followModel } from "../src/cockpit/follow";
import { composeCockpit } from "../src/cockpit/compose";
import { followRide } from "../src/ride/follow";
import { pixelBackend } from "../src/screen/text";
import { frameKey, type Frame } from "../src/screen/frame";
import type { Departure, Ride, RideStop, Stop } from "../src/transit/types";
import { greenPng } from "./fixtures/green-png";

/**
 * Glasses previews for review (not shipped): the cockpit frame for a demo state, green on black like the glasses.
 *
 *   QG_PREVIEW=1 npx vitest run tests/preview.test.ts
 *
 * writes store/preview-cockpit.png (departures, on time), store/preview-cockpit-late.png (the selected bus is late)
 * and store/preview-cockpit-follow.png (riding a followed bus). Node has no canvas, so these use the 5 x 7 pixel
 * font; on the glasses the system font draws the text. Without QG_PREVIEW the test only checks that the frames draw.
 */

const NOW = new Date(2026, 9, 17, 14, 5);
const at = (minutes: number): Date => new Date(NOW.getTime() + minutes * 60000);
const STOP: Stop = { id: "m", name: "Salzburg Mirabellplatz", lat: 47.8057, lon: 13.0431 };

function departure(minutes: number, over: Partial<Departure>): Departure {
  return {
    line: "3", headsign: "Salzburg Hbf", inMinutes: minutes, scheduled: at(minutes), expected: at(minutes),
    source: "realtime", track: "B", cancelled: false, tripId: `t${minutes}`, ...over,
  };
}

const onTime = [
  departure(4, {}),
  departure(9, { line: "6", headsign: "Obus Itzling", track: "A" }),
  departure(14, { line: "25", headsign: "Salzburg Süd", track: "C" }),
];
const late = [
  departure(6, { scheduled: at(2), expected: at(6), headsign: "Salzburg Hauptbahnhof via Kiesel" }),
  ...onTime.slice(1),
];

const stops: RideStop[] = ["Salzburg Hbf", "Salzburg Kiesel", "Salzburg Mirabellplatz", "Salzburg Hofwirt", "Salzburg Sterneckstraße", "Salzburg Gnigl"]
  .map((name, index) => ({
    stop: { id: String(index), name, lat: 47.8128 - index * 0.002, lon: 13.0456 + index * 0.002 },
    scheduled: at(index * 2 - 5), expected: at(index * 2 - 5), source: "realtime" as const, cancelled: false,
  }));
const ride: Ride = { line: "3", headsign: "Salzburg Gnigl", stops };

const model = (departures: Departure[]): CockpitModel =>
  boardModel({ stop: STOP, departures, selected: 0, metresAway: 120, now: NOW, locale: "de" });

function riding(): CockpitModel {
  const state = followRide(ride, 2, at(0), NOW, { lat: 47.8068, lon: 13.047 });
  if (state?.phase !== "riding") throw new Error("expected a ride in progress");
  return followModel(departure(0, {}), state, NOW, "de");
}

const frameOf = (m: CockpitModel): Frame => composeCockpit(m, pixelBackend());

const env = (globalThis as unknown as { process: { env: Record<string, string | undefined>; cwd(): string } }).process;

describe("cockpit previews", () => {
  const states: { file: string; model: CockpitModel }[] = [
    { file: "preview-cockpit.png", model: model(onTime) },
    { file: "preview-cockpit-late.png", model: model(late) },
    { file: "preview-cockpit-follow.png", model: riding() },
  ];

  it("draws every demo state to a non-empty, repeatable frame", () => {
    for (const state of states) {
      const frame = frameOf(state.model);
      expect(frame.pixels.some((level) => level > 0), state.file).toBe(true);
      expect(frameKey(frameOf(state.model)), state.file).toBe(frameKey(frame));
    }
    expect(new Set(states.map((state) => frameKey(frameOf(state.model)))).size).toBe(states.length);
  });

  it.skipIf(env.env["QG_PREVIEW"] === undefined)("writes the preview PNGs to store/", async () => {
    const fs = (await import(/* @vite-ignore */ "node:" + "fs")) as unknown as { writeFileSync(path: string, data: Uint8Array): void };
    for (const state of states) fs.writeFileSync(`${env.cwd()}/store/${state.file}`, await greenPng(frameOf(state.model)));
  });
});
