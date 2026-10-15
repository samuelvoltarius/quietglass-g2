import { afterEach, describe, expect, it, vi } from "vitest";
import { createPage, IMAGE_CALL_MS, PAGE_CALL_MS, sendProgressBar, TEXT_CALL_MS, updatePage } from "../src/glasses/render";
import { BAR_IMAGE_HEIGHT, BAR_IMAGE_WIDTH, createBitmap } from "../src/glasses/progressbar";
import type { FlowView } from "../src/glasses/view";

// Draws run one after another. A call into the glasses whose answer never
// comes used to freeze the display on its last page. Every call is now bounded.

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
const view: FlowView = { header: "Aufbau", headline: "Kabel anschließen", body: ["Schritt 1"], footer: "" };
const nextView: FlowView = { header: "Aufbau", headline: "Gerät einschalten", body: ["Schritt 2"], footer: "Tippen = fertig" };

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

  it("gives up on an image that hangs, so the next draw can go on", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const b = bridge({ updateImageRawData: vi.fn(() => never()) });
    let settled: { ok: boolean } | null = null;
    void sendProgressBar(b, createBitmap(BAR_IMAGE_WIDTH, BAR_IMAGE_HEIGHT)).then((r) => { settled = r; });
    // The PNG is encoded first (real async work), then the bounded send starts.
    for (let i = 0; i < 50 && settled === null; i++) {
      await new Promise<void>((resolve) => (globalThis as unknown as { setImmediate(cb: () => void): void }).setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(IMAGE_CALL_MS / 4);
    }
    expect(settled).toEqual(expect.objectContaining({ ok: false }));
  });
});
