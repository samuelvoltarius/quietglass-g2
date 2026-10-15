import { afterEach, describe, expect, it, vi } from "vitest";
import { createPage, IMAGE_CALL_MS, PAGE_CALL_MS, sendDayBar, TEXT_CALL_MS, updatePage } from "../src/glasses/render";
import type { ClockView } from "../src/glasses/view";

// The PNG encoder needs a canvas, which node does not have; the timeout is not about the picture.
vi.mock("../src/glasses/pixel", () => ({ encodeBitmap: async () => new Uint8Array([1]) }));

// Draws run one after another. A call into the glasses whose answer never
// comes used to freeze the display on its last page. Every call is now bounded.

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
const view: ClockView = { header: "SHIFT CLOCK", body: ["first"], footer: "" };
const nextView: ClockView = { header: "SHIFT CLOCK", body: ["second"], footer: "" };

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
    const pending = createPage(b, view);
    await vi.advanceTimersByTimeAsync(2 * PAGE_CALL_MS + 100);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no answer from the glasses/);
  });

  it("gives up on a text write that hangs, and the next update works again", async () => {
    vi.useFakeTimers();
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

  it("gives up on a day bar that hangs, so the image lane can retry", async () => {
    vi.useFakeTimers();
    const b = bridge({ updateImageRawData: vi.fn(() => never()) });
    const pending = sendDayBar(b, {} as never);
    await vi.advanceTimersByTimeAsync(IMAGE_CALL_MS + 100);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no answer from the glasses/);
  });
});
