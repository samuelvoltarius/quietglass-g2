import { resetGestureDedupe } from "../src/input/gestures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImageRawDataUpdateResult } from "@evenrealities/even_hub_sdk";

// Boots the real app with the radar switched on (the private build) against a fake bridge and fake services.
const harness = vi.hoisted(() => ({ bridge: null as unknown }));
vi.mock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
  waitForEvenAppBridge: async () => harness.bridge,
}));
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
const radarIndex = { radar: { past: Array.from({ length: 8 }, (_, i) => ({ time: 1_790_000_000 + i * 600, path: `/v2/radar/f${i}abcd` })), nowcast: [] } };

function fakeBridge() {
  let handler: ((event: unknown) => void) | undefined;
  const images: string[] = [];
  const texts: { name: string; content: string }[] = [];
  const pages: string[][] = [];
  const calls = { create: 0, rebuild: 0 };
  type PageLike = { textObject?: { containerName?: string; content?: string }[]; imageObject?: { containerName?: string }[] };
  const names = (page: PageLike): string[] => [...(page.textObject ?? []), ...(page.imageObject ?? [])].map((part) => part.containerName ?? "");
  const shutdown = { modes: [] as (number | undefined)[] };
  const bridge = {
    getAppLocation: async () => ({ latitude: 47.68, longitude: 13.1 }),
    rebuildPageContainer: async (page: PageLike) => {
      calls.rebuild += 1; pages.push(names(page));
      texts.push(...(page.textObject ?? []).map((part) => ({ name: part.containerName ?? "", content: part.content ?? "" })));
      return true;
    },
    createStartUpPageContainer: async (page: PageLike) => {
      calls.create += 1;
      texts.push(...(page.textObject ?? []).map((part) => ({ name: part.containerName ?? "", content: part.content ?? "" })));
      return 0;
    },
    textContainerUpgrade: async (update: { containerName?: string; content?: string }) => { texts.push({ name: update.containerName ?? "", content: update.content ?? "" }); return true; },
    updateImageRawData: async (update: { containerName?: string }) => { images.push(update.containerName ?? ""); return ImageRawDataUpdateResult.success; },
    shutDownPageContainer: (mode?: number): Promise<boolean> => { shutdown.modes.push(mode); return Promise.resolve(true); },
    onEvenHubEvent: (callback: (event: unknown) => void) => { handler = callback; return () => undefined; },
    onDeviceStatusChanged: () => () => undefined,
  };
  return {
    bridge, images, texts, pages, calls, shutdown,
    emit: (eventType: number) => (resetGestureDedupe(), handler?.({ sysEvent: { eventType, eventSource: 1 } })),
    ready: () => handler !== undefined,
  };
}

describe("rainlens radar page (private build)", () => {
  let tileRequests = 0;
  let decodes = 0;
  beforeEach(() => {
    resetGestureDedupe();
    tileRequests = 0; decodes = 0;
    vi.useFakeTimers();
    const store = new Map<string, string>([["quietglass.locale", "en"]]);
    vi.stubGlobal("localStorage", { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); } });
    vi.stubGlobal("navigator", { language: "en" });
    vi.stubGlobal("createImageBitmap", async () => ({ close: () => undefined }));
    vi.stubGlobal("document", {
      querySelector: () => null, querySelectorAll: () => [],
      createElement: () => ({
        width: 0, height: 0,
        getContext: () => ({
          drawImage: () => undefined,
          getImageData: () => {
            // A rain cell whose strength depends on which tile this is, so the frames differ.
            decodes += 1;
            const data = new Uint8ClampedArray(256 * 256 * 4);
            for (let y = 100; y < 156; y += 1) for (let x = 100; x < 156; x += 1) { const at = (y * 256 + x) * 4; data.set([0, 112, 163, 255], at); if ((decodes + x) % 7 === 0) data.set([255, 210, 0, 255], at); }
            return { data };
          },
        }),
      }),
    });
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("api.rainviewer.com")) return new Response(JSON.stringify(radarIndex));
      if (String(url).includes("tilecache.rainviewer.com")) { tileRequests += 1; return new Response(new Blob([new Uint8Array(4)])); }
      return new Response(JSON.stringify(forecast));
    });
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  async function boot(radar: boolean, tweak?: (fake: ReturnType<typeof fakeBridge>) => void) {
    if (radar) vi.stubEnv("VITE_RADAR", "1");
    const fake = fakeBridge();
    tweak?.(fake);
    harness.bridge = fake.bridge;
    vi.resetModules();
    await import("../src/main");
    await vi.waitFor(() => expect(fake.ready()).toBe(true));
    await vi.advanceTimersByTimeAsync(5000);
    return fake;
  }

  const swipe = async (fake: Awaited<ReturnType<typeof boot>>, times = 1): Promise<void> => {
    for (let i = 0; i < times; i += 1) { fake.emit(2); await vi.advanceTimersByTimeAsync(300); }
  };

  it("is the fourth view: weather pages first, then a rebuild into the radar layout, never a second create", async () => {
    const fake = await boot(true);
    expect(fake.calls.create).toBe(1);
    await swipe(fake, 3);
    await vi.advanceTimersByTimeAsync(2000);
    expect(fake.calls.create).toBe(1);
    const radarPage = fake.pages.at(-1) ?? [];
    expect(radarPage).toEqual(expect.arrayContaining(["header", "radar-note", "footer", "radar-nw", "radar-ne", "radar-sw", "radar-se"]));
    expect(radarPage.filter((name) => name.startsWith("radar-") && name !== "radar-note")).toHaveLength(4);
  });

  it("shows the source credit and the frame time on the radar page", async () => {
    const fake = await boot(true);
    await swipe(fake, 3);
    const lastText = (name: string): string => fake.texts.filter((part) => part.name === name).at(-1)?.content ?? "";
    // The credit is there from the first moment, while loading as well as once the picture is up.
    expect(lastText("footer")).toContain("Radar: RainViewer");
    await vi.waitFor(() => expect(lastText("header")).toMatch(/\d{2}:\d{2}/));
    expect(lastText("footer")).toContain("Radar: RainViewer");
    expect(lastText("header")).toContain("RADAR");
  });

  it("loads the six frames once, sends only changed tiles, and keeps the loop on this page only", async () => {
    const fake = await boot(true);
    expect(tileRequests).toBe(0);
    await swipe(fake, 3);
    await vi.advanceTimersByTimeAsync(3000);
    expect(tileRequests).toBeGreaterThan(0);
    const loaded = tileRequests;
    expect(tileRequests % 6).toBe(0);
    const tileImages = (): number => fake.images.filter((name) => name.startsWith("radar-")).length;
    expect(tileImages()).toBeGreaterThanOrEqual(4);
    // One full loop later: no further loading, and no tile is sent more often than every 700 ms.
    const start = tileImages();
    await vi.advanceTimersByTimeAsync(7 * 700);
    expect(tileRequests).toBe(loaded);
    expect(tileImages() - start).toBeLessThanOrEqual(4 * 7);
    // Swiping on stops the loop and shows the weather again by rebuilding.
    const rebuilds = fake.calls.rebuild;
    await swipe(fake, 1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fake.calls.rebuild).toBeGreaterThan(rebuilds);
    expect(fake.pages.at(-1)).toEqual(expect.arrayContaining(["body", "chart-text"]));
    const after = tileImages();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tileImages()).toBe(after);
    expect(fake.calls.create).toBe(1);
  });

  it("does not load the radar before its page is opened, and a tap there reloads it", async () => {
    const fake = await boot(true);
    expect(tileRequests).toBe(0);
    await swipe(fake, 3);
    await vi.advanceTimersByTimeAsync(3000);
    const first = tileRequests;
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(3000);
    expect(tileRequests).toBe(first * 2);
  });

  it("has no radar page in the public build: three views, and no radar traffic at all", async () => {
    const fake = await boot(false);
    await swipe(fake, 4);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fake.images.some((name) => name.startsWith("radar-"))).toBe(false);
    expect(fake.pages.flat().some((name) => name.startsWith("radar-"))).toBe(false);
    expect(tileRequests).toBe(0);
  });

  it("listens to the glasses even while the page and the location never answer", async () => {
    const fake = await boot(true, (f) => {
      f.bridge.getAppLocation = () => new Promise(() => undefined);
      f.bridge.createStartUpPageContainer = () => new Promise(() => undefined);
    });
    expect(fake.ready()).toBe(true);
    fake.emit(3);
    await vi.advanceTimersByTimeAsync(100);
    expect(fake.shutdown.modes).toEqual([1]);
  });

  it("shows the base map and the nearest town while the radar is still loading", async () => {
    const fake = await boot(true);
    vi.stubGlobal("fetch", async (url: string) => (String(url).includes("rainviewer") ? new Promise(() => undefined) : new Response(JSON.stringify(forecast))));
    await swipe(fake, 3);
    await vi.advanceTimersByTimeAsync(3000);
    const header = fake.texts.filter((part) => part.name === "header").at(-1)?.content ?? "";
    expect(header).toContain("RADAR");
    expect(fake.images.filter((name) => name.startsWith("radar-")).length).toBeGreaterThanOrEqual(4);
  });
});
