import { afterEach, describe, expect, it, vi } from "vitest";
import { createPage, IMAGE_CALL_MS, PAGE_CALL_MS, TEXT_CALL_MS, updatePage } from "../src/glasses/render";
import { createModel, buildView, menuFor } from "../src/hub/model";
import { demoReport } from "../src/api/demo";
import { pixelIconFor } from "../src/glasses/icons";

vi.mock("../src/glasses/pixel", () => ({ ICON_WIDTH: 64, ICON_HEIGHT: 30, renderPixelIcon: async () => new Uint8Array([1, 2, 3]) }));

// Draws run one after another. A call into the glasses whose answer never
// comes used to freeze the display on its last page. Every call is now bounded.

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
const model = createModel(demoReport());
const T0 = 20_000_000;
const view = buildView(model, "de", T0);
const icon = pixelIconFor(model);
const menu = menuFor(model, "de");

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
    const pending = createPage(b, view, icon, menu);
    await vi.advanceTimersByTimeAsync(2 * PAGE_CALL_MS + 100);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no answer from the glasses/);
  });

  it("gives up on a text write that hangs, and writes every box again on the next update", async () => {
    vi.useFakeTimers();
    const upgrade = vi.fn().mockImplementationOnce(() => never()).mockImplementation(async () => true);
    const b = bridge({ textContainerUpgrade: upgrade });
    const pending = updatePage(b, view, icon, null);
    await vi.advanceTimersByTimeAsync(TEXT_CALL_MS + 100);
    const failed = await pending;
    expect(failed.ok).toBe(false);
    expect(failed.reason).toMatch(/no answer from the glasses/);
    const before = upgrade.mock.calls.length;
    expect((await updatePage(b, view, icon, null)).ok).toBe(true);
    expect(upgrade.mock.calls.length - before).toBeGreaterThanOrEqual(3); // nothing skipped as "already shown"
  });

  it("gives up on an image that hangs, and sends the icon again on the next update", async () => {
    vi.useFakeTimers();
    const image = vi.fn().mockImplementationOnce(() => never()).mockImplementation(async () => "success");
    const b = bridge({ updateImageRawData: image });
    const other = ["image-test-icon"]; // the icon key is module state; this one was never shown
    const pending = updatePage(b, view, other, null);
    await vi.advanceTimersByTimeAsync(IMAGE_CALL_MS + 100);
    const failed = await pending;
    expect(failed.ok).toBe(false);
    expect(failed.reason).toMatch(/no answer from the glasses/);
    expect((await updatePage(b, view, other, view)).ok).toBe(true);
    expect(image).toHaveBeenCalledTimes(2);
  });
});
