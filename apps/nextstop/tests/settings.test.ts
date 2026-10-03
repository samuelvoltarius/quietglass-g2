import { describe, it, expect } from "vitest";
import { DEFAULT_SETTINGS, parseSettings, validateUrl } from "../src/storage/persist";
import { positionFromUrl } from "../src/main";
import { boundingBox } from "../src/transit/motis";

describe("settings", () => {
  it("starts on ÖBB, the only one with live data here", () => {
    expect(DEFAULT_SETTINGS.backend).toBe("oebb");
  });

  it("falls back cleanly on corrupt storage", () => {
    expect(parseSettings("{nope")).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings("")).toEqual(DEFAULT_SETTINGS);
  });

  it("refuses an address that could never answer", () => {
    expect(parseSettings(JSON.stringify({ oebbUrl: "ws://bad" })).oebbUrl)
      .toBe(DEFAULT_SETTINGS.oebbUrl);
    expect(validateUrl("ws://x").valid).toBe(false);
    expect(validateUrl("http://127.0.0.1:8079/oebb").valid).toBe(true);
  });

  it("accepts plain http, because the proxy runs at home without a certificate", () => {
    expect(validateUrl("http://192.168.1.20:8079/oebb").valid).toBe(true);
  });

  it("will not let the refresh rate hammer a volunteer-run service", () => {
    expect(parseSettings(JSON.stringify({ refreshSeconds: 1 })).refreshSeconds)
      .toBe(DEFAULT_SETTINGS.refreshSeconds);
    expect(parseSettings(JSON.stringify({ refreshSeconds: 9999 })).refreshSeconds)
      .toBe(DEFAULT_SETTINGS.refreshSeconds);
    expect(parseSettings(JSON.stringify({ refreshSeconds: 60 })).refreshSeconds).toBe(60);
  });

  it("keeps nothing about where anyone travelled", () => {
    const stored = JSON.stringify(parseSettings(JSON.stringify({
      backend: "oebb", lastStop: "Mirabellplatz", history: ["Hbf"],
    })));
    expect(stored).not.toContain("Mirabellplatz");
    expect(stored).not.toContain("Hbf");
  });
});

describe("the development position override", () => {
  it("reads a coordinate pair", () => {
    expect(positionFromUrl("?at=47.8060,13.0430")).toEqual({ lat: 47.806, lon: 13.043 });
  });

  it("stays off unless asked for", () => {
    expect(positionFromUrl("")).toBeNull();
    expect(positionFromUrl("?other=1")).toBeNull();
  });

  it("rejects anything that is not a real place on Earth", () => {
    expect(positionFromUrl("?at=999,13")).toBeNull();
    expect(positionFromUrl("?at=hier,dort")).toBeNull();
    expect(positionFromUrl("?at=47.8")).toBeNull();
  });
});

describe("the MOTIS search box", () => {
  it("widens with latitude, so a box near the pole is not a sliver", () => {
    const salzburg = boundingBox(47.8, 13.04, 800);
    const tromso = boundingBox(69.6, 18.9, 800);
    const width = (b: { min: string; max: string }): number =>
      Number(b.max.split(",")[1]) - Number(b.min.split(",")[1]);
    expect(width(tromso)).toBeGreaterThan(width(salzburg));
  });

  it("covers the distance asked for", () => {
    const box = boundingBox(47.8, 13.04, 800);
    const latSpan = Number(box.max.split(",")[0]) - Number(box.min.split(",")[0]);
    expect(latSpan * 111320).toBeGreaterThan(1500);
  });
});
