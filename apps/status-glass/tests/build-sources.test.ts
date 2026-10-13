import { describe, expect, it } from "vitest";
import { EMPTY_DATA, parseBuildSources, withBuildSources } from "../src/storage/persist";

describe("sources a private build ships with", () => {
  it("parses name|url entries, ignores rubbish, keeps an optional token", () => {
    const sources = parseBuildSources("Spark|https://spark.example/status; Pi|http://pi.example:8099/status|tok\nbad|not a url;|;");
    expect(sources.map((s) => [s.name, s.url, s.token])).toEqual([
      ["Spark", "https://spark.example/status", undefined],
      ["Pi", "http://pi.example:8099/status", "tok"],
    ]);
    expect(new Set(sources.map((s) => s.id)).size).toBe(2);
    expect(parseBuildSources(undefined)).toEqual([]);
    expect(parseBuildSources("")).toEqual([]);
  });

  it("fills an empty install and leaves a build without sources alone", () => {
    const defaults = parseBuildSources("Spark|https://spark.example/status");
    expect(withBuildSources(EMPTY_DATA, defaults).sources).toHaveLength(1);
    expect(withBuildSources(EMPTY_DATA, [])).toBe(EMPTY_DATA);
  });

  it("keeps the user's own entries and does not duplicate a source already stored", () => {
    const defaults = parseBuildSources("Spark|https://spark.example/status");
    const own = { id: "s1", name: "NAS", url: "http://nas.local/status" };
    const stored = withBuildSources({ ...EMPTY_DATA, sources: [own] }, defaults);
    expect(stored.sources.map((s) => s.name)).toEqual(["Spark", "NAS"]);
    const again = withBuildSources({ ...EMPTY_DATA, sources: [{ id: "s7", name: "Mine", url: "https://spark.example/status/" }] }, defaults);
    expect(again.sources).toHaveLength(1);
  });
});
