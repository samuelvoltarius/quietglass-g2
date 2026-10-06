import { describe, expect, it } from "vitest";
import app from "../app.json";
import { BODY_ROWS, LINE_WIDTH, errorView, loadingView } from "../src/glasses/view";
import { explainFailure, glassesText, nextStep, noStopsHint } from "../src/text";

// These tests hold the reviewed German wording; English is covered in i18n.test.ts.
const TEXT = glassesText("de");

/** Words a beginner would have to look up; they belong under "Erweitert" on the phone, never on the glasses. */
const JARGON = /proxy|cors|backend|hafas|motis|endpoint|bridge|lat\/lon|gps|client|feed|http:/i;

const failures = [
  ["oebb", "Failed to fetch"], ["oebb", "Load failed"], ["motis", "TypeError: NetworkError when attempting to fetch resource."],
  ["motis", "timed out"], ["motis", "The operation was aborted."], ["motis", "HTTP 403"], ["motis", "HTTP 502"], ["oebb", "HTTP 500"], ["motis", "Unexpected token < in JSON"],
] as const;

const fits = (rows: readonly string[]): void => {
  expect(rows.length).toBeLessThanOrEqual(BODY_ROWS);
  for (const row of rows) expect(row.length, row).toBeLessThanOrEqual(LINE_WIDTH);
};

describe("what the glasses say when something is missing", () => {
  it.each(failures)("%s / %s is plain, actionable and fits", (backend, message) => {
    const { error, hint } = explainFailure(message, backend, "de");
    expect(`${error} ${hint}`).not.toMatch(JARGON);
    // The raw browser message never reaches the glasses.
    expect(`${error} ${hint}`).not.toContain(message);
    const view = errorView(error, hint, "de");
    fits(view.body);
    expect(view.body.join(" ")).toContain(error);
    expect(view.body.join(" ").replace(/\s+/g, " ")).toContain(hint);
  });

  it("points an ÖBB user without the add-on to the setting that works", () => {
    expect(explainFailure("Failed to fetch", "oebb", "de").hint).toContain("„Überall“");
  });

  it("tells a first-time user to allow location", () => {
    const view = loadingView(TEXT.waitingForLocation, TEXT.waitingHint, "de");
    fits(view.body);
    expect(view.body.join(" ")).toContain("Erlaube den Standort in der Even-App");
    expect(view.footer).toBe("doppeltippen = beenden");
  });

  it("explains an empty area per data source", () => {
    for (const backend of ["oebb", "motis"] as const) {
      const hint = noStopsHint(backend, "de");
      expect(hint).not.toMatch(JARGON);
      fits(errorView(TEXT.noStops, hint, "de").body);
    }
    fits(errorView(TEXT.noRide, TEXT.noRideHint, "de").body);
  });

  it("keeps every fixed sentence free of jargon", () => {
    for (const text of Object.values(TEXT)) expect(text).not.toMatch(JARGON);
  });
});

describe("the phone's next step", () => {
  it("names the one thing to do in each first-run state", () => {
    expect(nextStep(false, 0, "de")).toContain("Erlaube den Standort in der Even-App");
    expect(nextStep(true, 0, "de")).toContain("Suche Haltestellen");
    expect(nextStep(true, 3, "de")).toContain("tippen = mitfahren");
    for (const text of [nextStep(false, 0, "de"), nextStep(true, 0, "de"), nextStep(true, 3, "de")]) expect(text).not.toMatch(JARGON);
  });
});

describe("app.json", () => {
  const manifest = app as unknown as { permissions: { name: string; whitelist?: string[] }[]; supported_languages: string[] };
  it("asks for location and lets the keyless default through", () => {
    // Without the location permission the app could never get past "waiting for location".
    expect(manifest.permissions.map((permission) => permission.name).sort()).toEqual(["location", "network"]);
    expect(manifest.permissions.find((permission) => permission.name === "network")?.whitelist).toContain("https://api.transitous.org");
  });
  it("declares the languages the app actually speaks", () => {
    expect(manifest.supported_languages).toEqual(["de", "en"]);
  });
});
