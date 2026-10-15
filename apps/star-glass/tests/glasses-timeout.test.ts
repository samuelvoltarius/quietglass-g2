import { afterEach, describe, expect, it, vi } from "vitest";
import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { ICON_HEIGHT, ICON_WIDTH } from "../src/glasses/charts";
import { createBitmap } from "../src/glasses/gfx";
import { IMAGE_CALL_MS, PAGE_CALL_MS, TEXT_CALL_MS, installPage, updatePage } from "../src/glasses/render";
import type { Frames, PageView } from "../src/glasses/views";

// Draws run one after another. A call into the glasses whose answer never
// comes used to freeze the display on its last page. Every call is now bounded.

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
const view: PageView = { layout: "plain", header: "Star Glass", body: ["Zeile 1"], footer: "Tippen" };
const frames: Frames = { icon: createBitmap(ICON_WIDTH, ICON_HEIGHT) };

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
    vi.useFakeTimers();
    const b = bridge({ rebuildPageContainer: vi.fn(() => never()), createStartUpPageContainer: vi.fn(() => never()) });
    const pending = installPage(b, view, frames, null);
    await vi.advanceTimersByTimeAsync(2 * PAGE_CALL_MS + 100);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no answer from the glasses/);
  });

  it("gives up on a text write that hangs, and the next update works again", async () => {
    vi.useFakeTimers();
    const upgrade = vi.fn().mockImplementationOnce(() => never()).mockImplementation(async () => true);
    const b = bridge({ textContainerUpgrade: upgrade });
    expect((await installPage(b, view, frames, null)).ok).toBe(true);
    const pending = updatePage(b, view, frames, null, null);
    await vi.advanceTimersByTimeAsync(TEXT_CALL_MS + 100);
    const failed = await pending;
    expect(failed.ok).toBe(false);
    expect(failed.reason).toMatch(/no answer from the glasses/);
    expect((await updatePage(b, view, frames, null, null)).ok).toBe(true);
  });

  it("gives up on an image that hangs, so the next draw can go on", async () => {
    vi.useFakeTimers();
    const b = bridge({ updateImageRawData: vi.fn(() => never()) });
    const pending = installPage(b, view, frames, null);
    await vi.advanceTimersByTimeAsync(IMAGE_CALL_MS + 100);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no answer from the glasses/);
  });
});
