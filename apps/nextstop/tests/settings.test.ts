import { describe, it, expect } from "vitest";
import { DEFAULT_SETTINGS, defaultsFor, parseSettings, validateUrl } from "../src/storage/persist";
import { positionFromUrl } from "../src/main";
import { boundingBox } from "../src/transit/motis";

describe("settings", () => {
  it("starts on Transitous, the one that works without anything installed", () => {
    // ÖBB needs the CORS proxy from examples/; a fresh install must not depend on it.
    expect(DEFAULT_SETTINGS.backend).toBe("motis");
    expect(DEFAULT_SETTINGS.motisUrl).toBe("https://api.transitous.org");
  });

  it("keeps a user's explicit ÖBB choice", () => {
    expect(parseSettings(JSON.stringify({ backend: "oebb" })).backend).toBe("oebb");
    expect(parseSettings(JSON.stringify({ backend: "something" })).backend).toBe("motis");
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

describe("the build's ÖBB default", () => {
  const PROXY = "https://proxy.example.net:8458/oebb";

  it("a public build has none: Transitous, and the local proxy address as the placeholder", () => {
    for (const none of [undefined, "", "  ", "ws://bad"]) {
      const d = defaultsFor(none);
      expect(d.backend).toBe("motis");
      expect(d.oebbUrl).toBe("http://127.0.0.1:8079/oebb");
    }
    expect(DEFAULT_SETTINGS.backend).toBe("motis");
  });

  it("a private build with an address starts on ÖBB live data, pointing at it", () => {
    const d = defaultsFor(` ${PROXY} `);
    expect(d.backend).toBe("oebb");
    expect(d.oebbUrl).toBe(PROXY);
    expect(d.motisUrl).toBe("https://api.transitous.org");
  });

  it("fresh storage and corrupt storage give the build default; saved choices win", () => {
    const d = defaultsFor(PROXY);
    expect(parseSettings("", d)).toEqual(d);
    expect(parseSettings("{nope", d)).toEqual(d);
    expect(parseSettings(JSON.stringify({ refreshSeconds: 60 }), d).backend).toBe("oebb");
    expect(parseSettings(JSON.stringify({ backend: "motis" }), d).backend).toBe("motis");
    expect(parseSettings(JSON.stringify({ oebbUrl: "ws://bad" }), d).oebbUrl).toBe(PROXY);
    expect(parseSettings(JSON.stringify({ oebbUrl: "http://192.168.1.2:8079/oebb" }), d).oebbUrl).toBe("http://192.168.1.2:8079/oebb");
  });
});

describe("settings saved by an older version", async () => {
  const { parseSettings, defaultsFor, LEGACY_OEBB_PLACEHOLDER } = await import("../src/storage/persist");
  it("move to the build's own ÖBB proxy once instead of keeping the placeholder", () => {
    const defaults = defaultsFor("https://proxy.example:8458/oebb");
    const old = JSON.stringify({ backend: "motis", oebbUrl: LEGACY_OEBB_PLACEHOLDER, motisUrl: "https://api.transitous.org", refreshSeconds: 30 });
    expect(parseSettings(old, defaults)).toMatchObject({ backend: "oebb", oebbUrl: "https://proxy.example:8458/oebb" });
  });
  it("keep a proxy the user set themselves", () => {
    const defaults = defaultsFor("https://proxy.example:8458/oebb");
    const own = JSON.stringify({ backend: "motis", oebbUrl: "http://192.168.1.20:8079/oebb" });
    expect(parseSettings(own, defaults)).toMatchObject({ backend: "motis", oebbUrl: "http://192.168.1.20:8079/oebb" });
  });
});
