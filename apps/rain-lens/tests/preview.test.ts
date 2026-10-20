import { describe, expect, it } from "vitest";
import { cockpitModel, type CockpitInput } from "../src/cockpit/model";
import { composeCockpit } from "../src/cockpit/compose";
import { tr } from "../src/i18n";
import { messages } from "../src/messages";
import { demoWeather, type WeatherForecast } from "../src/rain/model";
import { frameKey } from "../src/screen/frame";
import { pixelBackend } from "../src/screen/text";
import { greenPng } from "./green-png";

/**
 * Glasses previews for review (not shipped): the cockpit frame, green on black like the glasses.
 *
 *   QG_PREVIEW=1 npx vitest run tests/preview.test.ts
 *
 * writes store/preview-cockpit.png (rain ahead) and store/preview-cockpit-warn.png (official warning).
 * Node has no canvas, so these use the 5 x 7 pixel font; on the glasses the system font draws the text.
 */
const NOW = new Date("2026-10-07T13:20:00");
const live: WeatherForecast = { ...demoWeather(NOW), source: "live" };
const t = (key: string, vars: Record<string, string | number> = {}): string => tr(messages, "de", key, vars);
const input = (patch: Partial<CockpitInput> = {}): CockpitInput => ({ forecast: live, now: NOW.valueOf(), t, locale: "de", notice: null, warning: null, gustLimit: null, place: "Salzburg", ...patch });

const states: { file: string; input: CockpitInput }[] = [
  { file: "preview-cockpit.png", input: input() },
  { file: "preview-cockpit-warn.png", input: input({ warning: { type: "wind", level: 2, start: 0, end: Infinity } }) },
];
const frameOf = (state: CockpitInput) => composeCockpit(cockpitModel(state), pixelBackend());
const env = (globalThis as unknown as { process: { env: Record<string, string | undefined>; cwd(): string } }).process;

describe("cockpit previews", () => {
  it("draws every state to a non-empty, repeatable frame", () => {
    for (const state of states) {
      const frame = frameOf(state.input);
      expect(frame.pixels.some((level) => level > 0), state.file).toBe(true);
      expect(frameKey(frameOf(state.input)), state.file).toBe(frameKey(frame));
    }
    expect(frameKey(frameOf(states[0]!.input))).not.toBe(frameKey(frameOf(states[1]!.input)));
  });

  it.skipIf(env.env["QG_PREVIEW"] === undefined)("writes the preview PNGs to store/", async () => {
    const fs = (await import(/* @vite-ignore */ "node:" + "fs")) as unknown as { writeFileSync(path: string, data: Uint8Array): void };
    for (const state of states) fs.writeFileSync(`${env.cwd()}/store/${state.file}`, await greenPng(frameOf(state.input)));
  });
});
