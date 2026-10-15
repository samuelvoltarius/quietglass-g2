import { resetGestureDedupe } from "../src/input/gestures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImageRawDataUpdateResult } from "@evenrealities/even_hub_sdk";

// Boots the real app against a fake bridge and fake services to check the cockpit view (public and private build).
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

describe("rainlens cockpit view", () => {
  let urls: string[] = [];
  beforeEach(() => {
    resetGestureDedupe();
    urls = [];
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-07T10:20:00"));
    const store = new Map<string, string>([["quietglass.locale", "de"]]);
    vi.stubGlobal("localStorage", { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); } });
    vi.stubGlobal("navigator", { language: "de" });
    vi.stubGlobal("createImageBitmap", async () => ({ close: () => undefined }));
    vi.stubGlobal("document", {
      querySelector: () => null, querySelectorAll: () => [],
      // A canvas good enough to decode radar tiles, but without text: the cockpit falls back to the pixel font.
      createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage: () => undefined, getImageData: () => { const data = new Uint8ClampedArray(256 * 256 * 4); for (let at = 100 * 256; at < 156 * 256; at += 1) data.set([0, 112, 163, 255], at * 4); return { data }; } }) }),
    });
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(String(url));
      if (String(url).includes("api.rainviewer.com")) return new Response(JSON.stringify(radarIndex));
      if (String(url).includes("tilecache.rainviewer.com")) return new Response(new Blob([new Uint8Array(4)]));
      if (String(url).includes("warnungen.zamg.at")) return new Response(JSON.stringify({ type: "Feature", properties: { location: { properties: { name: "Hallein" } }, warnings: [] } }));
      return new Response(JSON.stringify(forecast));
    });
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  async function boot(radar: boolean) {
    if (radar) vi.stubEnv("VITE_RADAR", "1");
    const fake = fakeBridge();
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
  const cockpitImages = (fake: Awaited<ReturnType<typeof boot>>): string[] => fake.images.filter((name) => name.startsWith("cockpit-"));

  it("is the last view: a rebuild into four image tiles and one input container, never a second create", async () => {
    const fake = await boot(false);
    await swipe(fake, 3);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fake.calls.create).toBe(1);
    expect(fake.pages.at(-1)).toEqual(["cockpit-input", "cockpit-nw", "cockpit-ne", "cockpit-sw", "cockpit-se"]);
    expect(cockpitImages(fake).sort()).toEqual(["cockpit-ne", "cockpit-nw", "cockpit-se", "cockpit-sw"]);
    // The official warnings were asked for this place in Austria.
    expect(urls.some((url) => url.startsWith("https://warnungen.zamg.at/wsapp/api/getWarningsForCoords?lon=13.1000&lat=47.6800&lang=de"))).toBe(true);
  });

  it("resends only the clock's tile when the minute changes", async () => {
    const fake = await boot(false);
    await swipe(fake, 3);
    await vi.advanceTimersByTimeAsync(1000);
    const before = cockpitImages(fake).length;
    await vi.advanceTimersByTimeAsync(61_000);
    const added = cockpitImages(fake).slice(before);
    expect(added.length).toBeGreaterThanOrEqual(1);
    expect(new Set(added)).toEqual(new Set(["cockpit-ne"]));
  });

  it("stops drawing once you swipe on, and comes round to the weather again", async () => {
    const fake = await boot(false);
    await swipe(fake, 3);
    await vi.advanceTimersByTimeAsync(1000);
    await swipe(fake, 1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fake.pages.at(-1)).toEqual(expect.arrayContaining(["body", "chart-text"]));
    const after = cockpitImages(fake).length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(cockpitImages(fake).length).toBe(after);
  });

  it("shows the radar on the left in the private build, and a tap plays the loop once through the left tiles only", async () => {
    const fake = await boot(true);
    await swipe(fake, 4);
    // Small steps: the radar load is a long promise chain, and the cockpit has few timers to flush it.
    for (let i = 0; i < 40; i += 1) await vi.advanceTimersByTimeAsync(100);
    expect(fake.pages.at(-1)).toEqual(["cockpit-input", "cockpit-nw", "cockpit-ne", "cockpit-sw", "cockpit-se"]);
    expect(urls.some((url) => url.includes("tilecache.rainviewer.com"))).toBe(true);
    const before = cockpitImages(fake).length;
    fake.emit(0);
    await vi.advanceTimersByTimeAsync(8 * 700);
    const played = cockpitImages(fake).slice(before);
    expect(played.length).toBeGreaterThan(0);
    expect(played.every((name) => name === "cockpit-nw" || name === "cockpit-sw")).toBe(true);
    // Back on the still picture: the loop does not go on by itself.
    await vi.advanceTimersByTimeAsync(2000);
    const settled = cockpitImages(fake).length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(cockpitImages(fake).length).toBe(settled);
  });
});
