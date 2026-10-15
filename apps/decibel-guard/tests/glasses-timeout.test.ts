import { afterEach, describe, expect, it, vi } from "vitest";
import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { createImageLane } from "../src/glasses/lane";
import { createPage, IMAGE_CALL_MS, PAGE_CALL_MS, sendImage, TEXT_CALL_MS, updatePage } from "../src/glasses/render";
import type { NoiseView } from "../src/glasses/view";

// Draws run one after another. A call into the glasses whose answer never
// comes used to freeze the display on its last page. Every call is now bounded.

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
const view: NoiseView = { header: "Decibel Guard", body: ["72 dB"], footer: "" };
const nextView: NoiseView = { header: "Decibel Guard", body: ["85 dB"], footer: "" };

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
    const pending = createPage(b, view);
    await vi.advanceTimersByTimeAsync(2 * PAGE_CALL_MS + 100);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no answer from the glasses/);
  });

  it("gives up on a text write that hangs, and the next update works again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const upgrade = vi.fn().mockImplementationOnce(() => never()).mockImplementation(async () => true);
    const b = bridge({ textContainerUpgrade: upgrade });
    expect((await createPage(b, view)).ok).toBe(true);
    const pending = updatePage(b, nextView);
    await vi.advanceTimersByTimeAsync(TEXT_CALL_MS + 100);
    const failed = await pending;
    expect(failed.ok).toBe(false);
    expect(failed.reason).toMatch(/no answer from the glasses/);
    const before = upgrade.mock.calls.length;
    expect((await updatePage(b, nextView)).ok).toBe(true);
    expect(upgrade.mock.calls.length - before).toBe(3);
  });

  it("gives up on an image that hangs", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const b = bridge({ updateImageRawData: vi.fn(() => never()) });
    const pending = sendImage(b, { id: 6, name: "level-digits" }, new Uint8Array([1]));
    const outcome = pending.then(() => "resolved", (error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(IMAGE_CALL_MS + 100);
    expect(await outcome).toMatch(/no answer from the glasses/);
  });

  it("an image that never answers makes the lane retry after the limit", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const image = vi.fn().mockImplementationOnce(() => never()).mockImplementation(async () => "success");
    const b = bridge({ updateImageRawData: image });
    const lane = createImageLane((target, data) => sendImage(b, target, data), 700);
    lane.request({ id: 6, name: "level-digits" }, "a", () => new Uint8Array([2]));
    await vi.advanceTimersByTimeAsync(IMAGE_CALL_MS + 100); // the first send times out
    await vi.advanceTimersByTimeAsync(1_000); // retry after the interval
    await lane.settled();
    expect(image).toHaveBeenCalledTimes(2);
    lane.close();
  });
});
