import { describe, expect, it } from "vitest";
import { curveLabels } from "../src/cockpit/model";
import { DEFAULT_LIMITS } from "../src/ns/alerts";
import { demoPump, demoReadings, demoTreatments } from "../src/ns/demo";
import type { ViewState } from "../src/glasses/views";

const NOW = new Date(2026, 9, 17, 14, 5).getTime();

function state(count: number, unit: "mgdl" | "mmol" = "mgdl"): ViewState {
  return {
    locale: "de", demo: false, connection: { kind: "ok" }, page: "glucose", unit, limits: DEFAULT_LIMITS, now: NOW,
    data: { readings: demoReadings("normal", NOW, count), pump: demoPump("normal", NOW), treatments: demoTreatments(NOW) },
  };
}

describe("numbers on the glucose curve", () => {
  it("labels the target band, the highest and lowest reading and the hours of a full curve", () => {
    const labels = curveLabels(state(60));
    expect(labels.bandLow).toBe("70");
    expect(labels.bandHigh).toBe("180");
    expect(Number(labels.max)).toBeGreaterThan(Number(labels.min));
    expect(labels.ticks).toEqual(["-3h", "-2h", "-1h", "jetzt"]);
  });

  it("leaves the hour marks out when the curve covers too little time to place them honestly", () => {
    const labels = curveLabels(state(12));
    expect(labels.ticks).toBeUndefined();
    expect(labels.max).toBeDefined();
  });

  it("formats in the chosen unit", () => {
    expect(curveLabels(state(60, "mmol")).bandLow).toBe("3,9");
  });
});
