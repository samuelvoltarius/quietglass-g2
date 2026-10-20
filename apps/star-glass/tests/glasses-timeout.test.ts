import { afterEach, describe, expect, it, vi } from "vitest";
import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { COCKPIT_TILES, IMAGE_CALL_MS, PAGE_CALL_MS, TEXT_CALL_MS, createCockpitPage, createTextPage, sendTile, updateTextPage } from "../src/glasses/render";
import type { PageView } from "../src/glasses/views";

// Draws run one after another. A call into the glasses whose answer never
// comes used to freeze the display on its last page. Every call is bounded.

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
const view: PageView = { header: "Star Glass", body: ["Zeile 1"], footer: "Tippen" };

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
    const pending = createTextPage(b, view);
    await vi.advanceTimersByTimeAsync(2 * PAGE_CALL_MS + 100);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no answer from the glasses/);
  });

  it("gives up on the cockpit page that never gets an answer, too", async () => {
    vi.useFakeTimers();
    const b = bridge({ rebuildPageContainer: vi.fn(() => never()), createStartUpPageContainer: vi.fn(() => never()) });
    const pending = createCockpitPage(b);
    await vi.advanceTimersByTimeAsync(2 * PAGE_CALL_MS + 100);
    expect((await pending).ok).toBe(false);
  });

  it("gives up on a text write that hangs, and the next update works again", async () => {
    vi.useFakeTimers();
    const upgrade = vi.fn().mockImplementationOnce(() => never()).mockImplementation(async () => true);
    const b = bridge({ textContainerUpgrade: upgrade });
    expect((await createTextPage(b, view)).ok).toBe(true);
    const pending = updateTextPage(b, view, null);
    await vi.advanceTimersByTimeAsync(TEXT_CALL_MS + 100);
    const failed = await pending;
    expect(failed.ok).toBe(false);
    expect(failed.reason).toMatch(/no answer from the glasses/);
    expect((await updateTextPage(b, view, null)).ok).toBe(true);
  });

  it("gives up on an image tile that hangs, so the next draw can go on", async () => {
    vi.useFakeTimers();
    const b = bridge({ updateImageRawData: vi.fn(() => never()) });
    const pending = sendTile(b, COCKPIT_TILES[0], new Uint8Array(1)).catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(IMAGE_CALL_MS + 100);
    expect(await pending).toMatch(/no answer from the glasses/);
  });

  it("the cockpit page is four image tiles over one input container, within the SDK limits", () => {
    expect(COCKPIT_TILES).toHaveLength(4);
    for (const tile of COCKPIT_TILES) {
      expect(tile.width).toBe(288);
      expect(tile.height).toBe(144);
      expect(tile.x + tile.width).toBeLessThanOrEqual(576);
      expect(tile.y + tile.height).toBeLessThanOrEqual(288);
    }
    expect(new Set(COCKPIT_TILES.map((tile) => tile.id)).size).toBe(4);
  });
});
