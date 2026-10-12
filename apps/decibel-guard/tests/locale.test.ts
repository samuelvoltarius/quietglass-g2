import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveLocale, type LocaleBridge } from "../src/i18n";

const bridge = (stored: string, country?: string): LocaleBridge & { saved: string[] } => {
  const saved: string[] = [];
  return { saved, getLocalStorage: async () => stored, setLocalStorage: async (_k, v) => { saved.push(v); return true; }, getUserInfo: async () => ({ country }) };
};
afterEach(() => vi.unstubAllGlobals());

describe("start language inside the Even app", () => {
  it("an explicit choice in the SDK store wins", async () => {
    expect(await resolveLocale(bridge("en", "AT"))).toBe("en");
  });
  it("a German-speaking account country means German even when the WebView says English", async () => {
    vi.stubGlobal("navigator", { language: "en-US" });
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
    expect(await resolveLocale(bridge("", "AT"))).toBe("de");
    expect(await resolveLocale(bridge("", "Österreich"))).toBe("de");
    expect(await resolveLocale(bridge("", "US"))).toBe("en");
  });
});
