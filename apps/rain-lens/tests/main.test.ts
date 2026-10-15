import { resetGestureDedupe } from "../src/input/gestures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImageRawDataUpdateResult } from "@evenrealities/even_hub_sdk";

// Boots the real app against a fake bridge and a fake forecast service, to check how images reach the glasses.
const harness = vi.hoisted(() => ({ bridge: null as unknown }));
vi.mock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
  waitForEvenAppBridge: async () => harness.bridge,
}));
// Canvas is unavailable in node; the PNG bytes are not what these tests are about.
vi.mock("../src/glasses/pixel", () => ({ encodePng: async () => new Uint8Array([1]) }));

const forecast = {
  current: { time: "2026-10-07T10:15", temperature_2m: 14.5, apparent_temperature: 13.2, relative_humidity_2m: 72, precipitation: 0.2, weather_code: 61, cloud_cover: 80, wind_speed_10m: 18, wind_direction_10m: 225, wind_gusts_10m: 31, is_day: 1 },
  hourly: {
    time: Array.from({ length: 12 }, (_, i) => `2026-10-07T${String(10 + i).padStart(2, "0")}:00`),
    temperature_2m: [13, 14, 15, 16, 16, 15, 14, 13, 12, 12, 11, 11], precipitation_probability: [10, 20, 40, 70, 75, 50, 30, 20, 10, 5, 5, 5],
    precipitation: Array.from({ length: 12 }, () => 0), weather_code: [3, 3, 61, 61, 63, 61, 3, 3, 2, 1, 1, 0], wind_speed_10m: Array.from({ length: 12 }, () => 12),
  },
  daily: { time: ["2026-10-07"], temperature_2m_min: [8], temperature_2m_max: [18], precipitation_probability_max: [75], weather_code: [61], sunrise: ["2026-10-07T07:08"], sunset: ["2026-10-07T18:42"] },
};

/** The app's SDK storage; shared between two boots of one test, as on the phone. */
const kv = new Map<string, string>();

function fakeBridge(imageDelayMs = 0) {
  let handler: ((event: unknown) => void) | undefined;
  const images: string[] = [];
  const texts: { name: string; content: string }[] = [];
  const shutdown = { confirm: true, fail: false, modes: [] as (number | undefined)[] };
  const bridge = {
    getAppLocation: async () => ({ latitude: 47.68, longitude: 13.1 }),
    getLocalStorage: async (key: string) => kv.get(key) ?? "",
    setLocalStorage: async (key: string, value: string) => { kv.set(key, value); return true; },
    rebuildPageContainer: async () => true,
    createStartUpPageContainer: async (page: { textObject?: { containerName?: string; content?: string }[] }) => { texts.push(...(page.textObject ?? []).map((part) => ({ name: part.containerName ?? "", content: part.content ?? "" }))); return 0; },
    textContainerUpgrade: async (update: { containerName?: string; content?: string }) => { texts.push({ name: update.containerName ?? "", content: update.content ?? "" }); return true; },
    updateImageRawData: async (update: { containerName?: string }) => {
      if (imageDelayMs) await new Promise((resolve) => setTimeout(resolve, imageDelayMs));
      images.push(update.containerName ?? "");
      return ImageRawDataUpdateResult.success;
    },
    shutDownPageContainer: (mode?: number): Promise<boolean> => { shutdown.modes.push(mode); return shutdown.fail ? Promise.reject(new Error("ble gone")) : Promise.resolve(shutdown.confirm); },
    onEvenHubEvent: (callback: (event: unknown) => void) => { handler = callback; return () => undefined; },
    onDeviceStatusChanged: () => () => undefined,
  };
  return {
    bridge, images, texts, shutdown,
    emit: (eventType: number) => (resetGestureDedupe(), handler?.({ sysEvent: { eventType, eventSource: 1 } })),
    ready: () => handler !== undefined,
  };
}

describe("rainlens images", () => {
  beforeEach(() => {
  resetGestureDedupe();
    kv.clear();
    vi.useFakeTimers();
    const store = new Map<string, string>([["quietglass.locale", "en"]]);
    vi.stubGlobal("localStorage", { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); } });
    vi.stubGlobal("navigator", { language: "en" });
    vi.stubGlobal("document", { querySelector: () => null, querySelectorAll: () => [] });
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(forecast)));
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  async function boot(imageDelayMs = 0) {
    const fake = fakeBridge(imageDelayMs);
    harness.bridge = fake.bridge;
    vi.resetModules();
    await import("../src/main");
    await vi.waitFor(() => expect(fake.ready()).toBe(true));
    await vi.advanceTimersByTimeAsync(5000);
    return fake;
  }

  it("shows the phone page in tabs with every control still on it", async () => {
    const app = { innerHTML: "", querySelectorAll: () => [] };
    vi.stubGlobal("document", { querySelector: (selector: string) => (selector === "#app" ? app : null), querySelectorAll: () => [] });
    await boot();
    expect(app.innerHTML).toContain('<nav class="tabbar"');
    for (const tab of ["weather", "place", "glasses", "more"]) expect(app.innerHTML).toContain(`data-tab="${tab}"`);
    expect(app.innerHTML).toContain("</span>Weather</button>");
    for (const id of ["refresh", "automatic", "place", "search", "lat", "lon", "coords", "language"]) expect(app.innerHTML, id).toContain(`id="${id}"`);
  });

  it("draws the chart once the real forecast is in, and never for the loading notice", async () => {
    const fake = await boot();
    expect(fake.images.filter((name) => name === "rain-chart")).toHaveLength(1);
    expect(fake.texts.filter((part) => part.name === "chart-text").at(-1)?.content).toBe("Rain chance\n75% 02:00 PM\n16° / 11°");
  });

  it("swipes between views without sending the chart again", async () => {
    const fake = await boot();
    for (let i = 0; i < 3; i += 1) { fake.emit(2); await vi.advanceTimersByTimeAsync(4000); }
    expect(fake.images.filter((name) => name === "rain-chart")).toHaveLength(1);
    // The icon column follows the view: hourly, daily, back to now.
    expect(fake.images.filter((name) => name === "weather-icons").length).toBeGreaterThanOrEqual(3);
    expect(fake.texts.filter((part) => part.name === "chart-text")).toHaveLength(2);
  });

  it("does not send the chart again when a refresh brings the same forecast", async () => {
    const fake = await boot();
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fake.images.filter((name) => name === "rain-chart")).toHaveLength(1);
  });

  it("switches views at once even while an image transfer is slow", async () => {
    const fake = await boot(60_000);
    const before = fake.texts.length;
    fake.emit(2);
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.texts.slice(before).some((part) => part.name === "header" && part.content.includes("HOURLY"))).toBe(true);
    expect(fake.images.filter((name) => name === "weather-icons")).toHaveLength(0);
  });

  it("asks for the system exit dialog (mode 1) and stops drawing once confirmed", async () => {
    const fake = await boot();
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.shutdown.modes).toEqual([1]);
    const textsAtClose = fake.texts.length;
    fake.emit(2);
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fake.texts.length).toBe(textsAtClose);
  });

  it("keeps reacting to swipes when the exit dialog is cancelled", async () => {
    const fake = await boot();
    fake.shutdown.confirm = false;
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.shutdown.modes).toEqual([1]);
    const textsAtCancel = fake.texts.length;
    fake.emit(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fake.texts.length).toBeGreaterThan(textsAtCancel);
  });

  it("keeps running when the exit call rejects, without an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    const nodeProcess = (globalThis as unknown as { process: { on(event: string, listener: (reason: unknown) => void): void; off(event: string, listener: (reason: unknown) => void): void } }).process;
    nodeProcess.on("unhandledRejection", onUnhandled);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fake = await boot();
    fake.shutdown.fail = true;
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(10);
    const textsAtFailure = fake.texts.length;
    fake.emit(2);
    await vi.advanceTimersByTimeAsync(5000);
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 20));
    nodeProcess.off("unhandledRejection", onUnhandled);
    vi.restoreAllMocks();
    expect(unhandled).toEqual([]);
    expect(fake.texts.length).toBeGreaterThan(textsAtFailure);
  });

  const header = (fake: ReturnType<typeof fakeBridge>): string => fake.texts.filter((part) => part.name === "header").at(-1)?.content ?? "";
  const footer = (fake: ReturnType<typeof fakeBridge>): string => fake.texts.filter((part) => part.name === "footer").at(-1)?.content ?? "";

  it("says how old the forecast is", async () => {
    const fake = await boot();
    expect(footer(fake)).toMatch(/^as of \d\d:\d\d · Tap = refresh/);
  });

  it("comes back on the same page after a restart", async () => {
    const first = await boot();
    first.emit(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(header(first)).toContain("HOURLY");
    const second = await boot();
    expect(header(second)).toContain("HOURLY");
  });

  it("draws nothing in the background and rebuilds, with a fresh forecast, on return", async () => {
    let fetches = 0;
    vi.stubGlobal("fetch", async () => { fetches += 1; return new Response(JSON.stringify(forecast)); });
    const fake = await boot();
    const before = fetches;
    fake.emit(5);
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    const texts = fake.texts.length;
    expect(fetches).toBe(before);
    fake.emit(4);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fake.texts.length).toBeGreaterThan(texts);
    expect(fetches).toBeGreaterThan(before);
  });

  it("fetches the forecast again on its own every 15 minutes", async () => {
    let fetches = 0;
    vi.stubGlobal("fetch", async () => { fetches += 1; return new Response(JSON.stringify(forecast)); });
    await boot();
    const before = fetches;
    await vi.advanceTimersByTimeAsync(16 * 60_000);
    expect(fetches).toBeGreaterThan(before);
  });
});
