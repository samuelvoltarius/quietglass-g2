import { describe, expect, it } from "vitest";
import { BUILD_HA_URL, buildHaUrl, defaultSettings, effectiveHaUrl, EMPTY_SETTINGS, isConfigured, parseSettings } from "../src/storage/persist";

// VITE_HA_URL: a private build may preset the Home Assistant address; the token is always typed on the phone.
const PRESET = "https://abcdef.ui.nabu.casa";

describe("build-time Home Assistant address", () => {
  it("is empty in a normal (public) build", () => {
    expect(BUILD_HA_URL).toBe("");
    expect(defaultSettings()).toEqual(EMPTY_SETTINGS);
  });

  it("accepts http, https, ws and wss and drops anything else", () => {
    expect(buildHaUrl(PRESET + "/")).toBe(PRESET);
    expect(buildHaUrl("wss://ha.example:8123")).toBe("wss://ha.example:8123");
    expect(buildHaUrl("ftp://x")).toBe("");
    expect(buildHaUrl(undefined)).toBe("");
  });

  it("with a preset: Home Assistant is preselected, the typed address wins, and a token is still required", () => {
    const fresh = parseSettings("", PRESET);
    expect(fresh.backend).toBe("ha");
    expect(effectiveHaUrl(fresh, PRESET)).toBe(PRESET);
    expect(isConfigured(fresh, PRESET)).toBe(false);
    expect(isConfigured({ ...fresh, haToken: "t" }, PRESET)).toBe(true);
    expect(effectiveHaUrl({ ...fresh, haUrl: "http://192.168.1.5:8123" }, PRESET)).toBe("http://192.168.1.5:8123");
    expect(JSON.stringify(fresh)).not.toContain("Token");
  });

  it("stores ws/wss addresses typed for Home Assistant", () => {
    expect(parseSettings(JSON.stringify({ backend: "ha", haUrl: "wss://abcdef.ui.nabu.casa" }), "").haUrl).toBe("wss://abcdef.ui.nabu.casa");
    expect(parseSettings(JSON.stringify({ backend: "bridge", bridgeUrl: "wss://x.example" }), "").bridgeUrl).toBe("");
  });
});
