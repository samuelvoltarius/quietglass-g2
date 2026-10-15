import { afterEach, describe, expect, it, vi } from "vitest";
import { curveFrame, ringFrame } from "../src/glasses/charts";
import { IMAGE_CALL_MS, PAGE_CALL_MS, TEXT_CALL_MS } from "../src/glasses/images";
import { createPage, updatePage } from "../src/glasses/render";
import { demoTempSamples } from "../src/printer/history";
import type { ScreenView } from "../src/glasses/screen";

// Draws run one after another. A call into the glasses whose answer never
// comes used to freeze the display on its last page. Every call is now bounded.

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
const view: ScreenView = { header: "Drucker", body: ["bereit"], footer: "" };
const nextView: ScreenView = { header: "Drucker", body: ["druckt"], footer: "Tippen = Menü" };
const frames = { ring: ringFrame(42), curve: curveFrame(demoTempSamples(0)) };

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
    const pending = createPage(b, view, "plain", frames);
    await vi.advanceTimersByTimeAsync(2 * PAGE_CALL_MS + 100);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no answer from the glasses/);
  });

  it("gives up on a text write that hangs, and the next update works again", async () => {
    vi.useFakeTimers();
    const upgrade = vi.fn().mockImplementationOnce(() => never()).mockImplementation(async () => true);
    const b = bridge({ textContainerUpgrade: upgrade });
    expect((await createPage(b, view, "plain", frames)).ok).toBe(true);
    const pending = updatePage(b, nextView, "plain", frames, view);
    await vi.advanceTimersByTimeAsync(TEXT_CALL_MS + 100);
    const failed = await pending;
    expect(failed.ok).toBe(false);
    expect(failed.reason).toMatch(/no answer from the glasses/);
    // The caller treats a failure like a lost page: no previous view, so every box is written again.
    const before = upgrade.mock.calls.length;
    expect((await updatePage(b, nextView, "plain", frames, null)).ok).toBe(true);
    expect(upgrade.mock.calls.length - before).toBe(3);
  });

  it("gives up on an image that hangs, so the next draw can go on", async () => {
    vi.useFakeTimers();
    const b = bridge({ updateImageRawData: vi.fn(() => never()) });
    const pending = createPage(b, view, "print", frames);
    await vi.advanceTimersByTimeAsync(IMAGE_CALL_MS + 100);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no answer from the glasses/);
  });
});
