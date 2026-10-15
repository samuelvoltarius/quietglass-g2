import { afterEach, describe, expect, it, vi } from "vitest";
import { createRadarPage, createTextPage, IMAGE_CALL_MS, PAGE_CALL_MS, sendImage, TEXT_CALL_MS, updateRadarText, updateTextPage, type RadarView, type TextView } from "../src/glasses/text";

// Draws run one after another. A call into the glasses whose answer never
// comes used to freeze the display on its last page. Every call is now bounded.

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
const view: TextView = { header: "REGEN", body: ["trocken"], side: [], footer: "" };
const nextView: TextView = { header: "REGEN", body: ["Regen in 10 min"], side: [], footer: "" };
const radar: RadarView = { header: "RADAR", note: "", footer: "" };
const nextRadar: RadarView = { header: "RADAR 12:00", note: "", footer: "" };

function bridge(overrides: Record<string, unknown> = {}) {
  return {
    rebuildPageContainer: vi.fn(async () => true),
    createStartUpPageContainer: vi.fn(async () => 0),
    textContainerUpgrade: vi.fn(async () => true),
    updateImageRawData: vi.fn(async () => "success"),
    ...overrides,
  } as never;
}

afterEach(() => { vi.useRealTimers(); });

describe("calls into the glasses are bounded", () => {
  it("gives up on a page that never gets an answer, instead of waiting for ever", async () => {
    vi.useFakeTimers();
    const b = bridge({ rebuildPageContainer: vi.fn(() => never()), createStartUpPageContainer: vi.fn(() => never()) });
    const pending = createTextPage(b, view);
    await vi.advanceTimersByTimeAsync(2 * PAGE_CALL_MS + 100);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no answer from the glasses/);
  });

  it("gives up on a radar page that never gets an answer", async () => {
    vi.useFakeTimers();
    const b = bridge({ rebuildPageContainer: vi.fn(() => never()), createStartUpPageContainer: vi.fn(() => never()) });
    const pending = createRadarPage(b, radar);
    await vi.advanceTimersByTimeAsync(2 * PAGE_CALL_MS + 100);
    expect((await pending).ok).toBe(false);
  });

  it("gives up on a text write that hangs, and the next update works again", async () => {
    vi.useFakeTimers();
    const upgrade = vi.fn().mockImplementationOnce(() => never()).mockImplementation(async () => true);
    const b = bridge({ textContainerUpgrade: upgrade });
    expect((await createTextPage(b, view)).ok).toBe(true);
    const pending = updateTextPage(b, nextView, view);
    await vi.advanceTimersByTimeAsync(TEXT_CALL_MS + 100);
    const failed = await pending;
    expect(failed.ok).toBe(false);
    expect(failed.reason).toMatch(/no answer from the glasses/);
    // The app then rebuilds the page (pageReady = false) and writes it all again.
    expect((await createTextPage(b, nextView)).ok).toBe(true);
    expect((await updateTextPage(b, view, nextView)).ok).toBe(true);
  });

  it("gives up on a radar text write that hangs, and the next update works again", async () => {
    vi.useFakeTimers();
    const upgrade = vi.fn().mockImplementationOnce(() => never()).mockImplementation(async () => true);
    const b = bridge({ textContainerUpgrade: upgrade });
    const pending = updateRadarText(b, nextRadar, radar);
    await vi.advanceTimersByTimeAsync(TEXT_CALL_MS + 100);
    expect((await pending).ok).toBe(false);
    expect((await updateRadarText(b, nextRadar, radar)).ok).toBe(true);
  });

  it("gives up on an image that hangs, so the lane can go on", async () => {
    vi.useFakeTimers();
    const b = bridge({ updateImageRawData: vi.fn(() => never()) });
    const outcome = sendImage(b, { id: 4, name: "icons" }, new Uint8Array([1])).then(() => "resolved", (error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(IMAGE_CALL_MS + 100);
    expect(await outcome).toMatch(/no answer from the glasses/);
  });
});
