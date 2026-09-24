import { describe, it, expect } from "vitest";
import { buildView, percent } from "../src/glasses/view";
import { createDose, DEFAULT_DOSE } from "../src/noise/dose";
import { parseData, EMPTY_DATA, isCalibrated } from "../src/storage/persist";

const quiet = createDose();

describe("not listening", () => {
  it("says so and never implies it is measuring", () => {
    const view = buildView(quiet, DEFAULT_DOSE, { listening: false, level: null, calibrated: true });
    expect(view.body[0]).toBe("Not listening.");
    expect(view.footer).toContain("tap = start");
    expect(view.footer).not.toContain("MIC");
  });

  it("points at calibration when there is none", () => {
    const view = buildView(quiet, DEFAULT_DOSE, { listening: false, level: null, calibrated: false });
    expect(view.body.join(" ")).toContain("Calibrate");
  });

  it("keeps the accumulated dose visible while paused", () => {
    const dose = { ...quiet, fraction: 0.4 };
    expect(buildView(dose, DEFAULT_DOSE, { listening: false, level: null, calibrated: true }).footer)
      .toContain("40%");
  });
});

describe("listening", () => {
  const listening = { listening: true, level: 75, calibrated: true };

  it("always shows the microphone indicator", () => {
    expect(buildView(quiet, DEFAULT_DOSE, listening).footer).toContain("MIC");
  });

  it("shows the microphone indicator even when quiet", () => {
    const view = buildView(quiet, DEFAULT_DOSE, { ...listening, level: 30 });
    expect(view.footer).toContain("MIC");
  });

  it("marks an uncalibrated reading so it is not mistaken for SPL", () => {
    const view = buildView(quiet, DEFAULT_DOSE, { ...listening, calibrated: false });
    expect(view.body[0]).toContain("uncal.");
  });

  it("shows a plain level once calibrated", () => {
    expect(buildView(quiet, DEFAULT_DOSE, listening).body[0]).toBe("75 dB");
  });

  it("waits for audio rather than showing a fake zero", () => {
    expect(buildView(quiet, DEFAULT_DOSE, { ...listening, level: null }).body[0]).toBe("listening…");
  });

  it("stays minimal while the dose is zero", () => {
    expect(buildView(quiet, DEFAULT_DOSE, listening).body).toHaveLength(1);
    expect(buildView(quiet, DEFAULT_DOSE, listening).header).toBe("");
  });
});

describe("dose escalation", () => {
  it("shows the dose once it starts accruing", () => {
    const dose = { ...quiet, fraction: 0.2 };
    const view = buildView(dose, DEFAULT_DOSE, { listening: true, level: 85, calibrated: true });
    expect(view.body.join(" ")).toContain("20%");
    expect(view.body.join(" ")).toContain("left at this level");
  });

  it("warns at halfway, before the limit is passed", () => {
    const dose = { ...quiet, fraction: 0.6 };
    expect(buildView(dose, DEFAULT_DOSE, { listening: true, level: 85, calibrated: true }).header)
      .toBe("HALFWAY");
  });

  it("becomes unmissable once the dose is full", () => {
    const dose = { ...quiet, fraction: 1.2 };
    const view = buildView(dose, DEFAULT_DOSE, { listening: true, level: 90, calibrated: true });
    expect(view.header).toBe("DAILY DOSE REACHED");
    expect(view.body.join(" ")).not.toContain("left at this level");
  });

  it("caps the displayed percentage so it stays readable", () => {
    expect(percent(50)).toBe("999%");
    expect(percent(0.155)).toBe("16%");
  });
});

describe("storage", () => {
  it("falls back cleanly on corrupt data", () => {
    expect(parseData("{nope")).toEqual(EMPTY_DATA);
  });

  it("treats a zero offset as uncalibrated", () => {
    expect(isCalibrated(EMPTY_DATA)).toBe(false);
    expect(isCalibrated({ ...EMPTY_DATA, calibrationOffset: 110 })).toBe(true);
  });

  it("clamps an absurd calibration offset", () => {
    expect(parseData(JSON.stringify({ calibrationOffset: 9999 })).calibrationOffset).toBe(200);
  });

  it("only accepts the two real exchange rates", () => {
    expect(parseData(JSON.stringify({ dose: { exchangeRateDb: 7 } })).dose.exchangeRateDb).toBe(3);
    expect(parseData(JSON.stringify({ dose: { exchangeRateDb: 5 } })).dose.exchangeRateDb).toBe(5);
  });

  it("clamps dose thresholds into a sane band", () => {
    const parsed = parseData(JSON.stringify({
      dose: { criterionDb: 500, criterionHours: 0, thresholdDb: 5 },
    }));
    expect(parsed.dose.criterionDb).toBe(100);
    expect(parsed.dose.criterionHours).toBe(1);
    expect(parsed.dose.thresholdDb).toBe(40);
  });
});
