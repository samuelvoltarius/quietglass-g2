import { describe, expect, it } from "vitest";
import { EMPTY_SETTINGS, withDefaultServer } from "../src/storage/persist";

describe("build-time default server", () => {
  it("fills an empty address", () => {
    expect(withDefaultServer(EMPTY_SETTINGS, "https://hud.example.ts.net:8790/").serverUrl).toBe("https://hud.example.ts.net:8790");
  });
  it("never overrides a stored address", () => {
    const stored = { ...EMPTY_SETTINGS, serverUrl: "https://other.example.ts.net:8790" };
    expect(withDefaultServer(stored, "https://hud.example.ts.net:8790")).toBe(stored);
  });
  it("keeps the token and ignores an empty or invalid default", () => {
    const withToken = { ...EMPTY_SETTINGS, token: "t" };
    expect(withDefaultServer(withToken, "")).toBe(withToken);
    expect(withDefaultServer(withToken, "not a url")).toBe(withToken);
    expect(withDefaultServer(withToken, "https://hud.example.ts.net:8790").token).toBe("t");
  });
});
