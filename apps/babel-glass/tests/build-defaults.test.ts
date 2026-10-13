import { describe, expect, it } from "vitest";
import { EMPTY_DATA, translationConfigured, usesMockStt, withBuildDefaults } from "../src/storage/persist";

describe("a private build ships its own servers", () => {
  const defaults = { stt: "wss://stt.example:8449", llm: "https://llm.example:8448/v1", model: "qwen" };
  it("fills empty server fields, so nothing has to be typed in", () => {
    const data = withBuildDefaults(EMPTY_DATA, defaults);
    expect(usesMockStt(data)).toBe(false);
    expect(data.sttUrl).toBe(defaults.stt);
    expect(translationConfigured(data)).toBe(true);
    expect(data).toMatchObject({ translateProvider: "openai", llmUrl: defaults.llm, llmModel: "qwen" });
  });
  it("never overrides what the user set", () => {
    const own = { ...EMPTY_DATA, sttUrl: "wss://mine:1", translateUrl: "https://libre.example" };
    expect(withBuildDefaults(own, defaults)).toEqual(own);
  });
  it("the public build (no defaults) keeps asking for a server", () => {
    expect(withBuildDefaults(EMPTY_DATA, {})).toEqual(EMPTY_DATA);
  });
});
