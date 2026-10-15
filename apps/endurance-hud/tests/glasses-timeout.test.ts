import { afterEach, describe, expect, it, vi } from "vitest";
import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { createTextPage, IMAGE_CALL_MS, PAGE_CALL_MS, TEXT_CALL_MS, updateTextPage, type TextView } from "../src/glasses/text";

// Canvas is unavailable in node; the icon encoder is replaced.
vi.mock("../src/glasses/pixel", () => ({ renderPixelIcon: async () => new Uint8Array([1]) }));

// Draws run one after another. A call into the glasses whose answer never
// comes used to freeze the display on its last page. Every call is now bounded.

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
const view: TextView = { header: "Endurance", body: ["HR 140"], footer: "" };
const nextView: TextView = { header: "Endurance", body: ["HR 150"], footer: "" };
const icon = ["#.#", ".#."];

function bridge(overrides: Record<string, unknown> = {}): EvenAppBridge {
  return {
    rebuildPageContainer: vi.fn(async () => true),
    createStartUpPageContainer: vi.fn(async () => 0),
    textContainerUpgrade: vi.fn(async () => true),
    updateImageRawData: vi.fn(async () => "success"),
    ...overrides,
  } as unknown as EvenAppBridge;
}

afterEach(() => { vi.useRealTimers(); });

describe("calls into the glasses are bounded", () => {
  it("gives up on a page that never gets an answer, instead of waiting for ever", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const b = bridge({ rebuildPageContainer: vi.fn(() => never()), createStartUpPageContainer: vi.fn(() => never()) });
    let settled: boolean | null = null;
    void createTextPage(b, view, icon).then((ok) => { settled = ok; });
    await vi.advanceTimersByTimeAsync(2 * PAGE_CALL_MS + 100);
    expect(settled).toBe(false);
  });

  it("gives up on a text write that hangs, and the next update works again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const upgrade = vi.fn().mockImplementationOnce(() => never()).mockImplementation(async () => true);
    const b = bridge({ textContainerUpgrade: upgrade });
    expect(await createTextPage(b, view, icon)).toBe(true);
    let settled: boolean | null = null;
    void updateTextPage(b, nextView, icon).then((ok) => { settled = ok; });
    await vi.advanceTimersByTimeAsync(TEXT_CALL_MS + 100);
    expect(settled).toBe(false);
    const before = upgrade.mock.calls.length;
    expect(await updateTextPage(b, nextView, icon)).toBe(true);
    expect(upgrade.mock.calls.length - before).toBe(3);
  });

  it("gives up on an image that hangs, so the next draw can go on", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const image = vi.fn().mockImplementationOnce(() => never()).mockImplementation(async () => "success");
    const b = bridge({ updateImageRawData: image });
    let settled: boolean | null = null;
    void createTextPage(b, view, icon).then((ok) => { settled = ok; });
    await vi.advanceTimersByTimeAsync(IMAGE_CALL_MS + 100);
    expect(settled).toBe(false);
    expect(await createTextPage(b, view, icon)).toBe(true);
  });
});
