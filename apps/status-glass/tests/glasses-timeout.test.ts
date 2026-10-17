import { afterEach, describe, expect, it, vi } from "vitest";
import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { IMAGE_CALL_MS, PAGE_CALL_MS, TEXT_CALL_MS, createCockpitPage, createTextPage, guardedTileSend, sendTile, updateTextPage } from "../src/glasses/page";
import { COCKPIT_TILES } from "../src/glasses/page";
import type { StatusView } from "../src/glasses/view";

// Draws run one after another. A call into the glasses whose answer never
// comes used to freeze the display on its last page. Every call is now bounded.

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
const view: StatusView = { header: "Status · ● live", body: ["Zeile 1"], footer: "Tippen" };

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

  it("gives up on a cockpit page that never gets an answer", async () => {
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
    const pending = sendTile(b, COCKPIT_TILES[0], new Uint8Array(1)).then(() => "answered", (error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(IMAGE_CALL_MS + 100);
    expect(await pending).toMatch(/no answer from the glasses/);
  });

  it("writes no tile while the dialog may be up or the page is gone", async () => {
    const b = bridge();
    let allowed = false;
    const send = guardedTileSend(b, () => allowed);
    expect(await send(COCKPIT_TILES[0], new Uint8Array(1))).toBe(false);
    expect((b as unknown as { updateImageRawData: ReturnType<typeof vi.fn> }).updateImageRawData).not.toHaveBeenCalled();
    allowed = true;
    expect(await send(COCKPIT_TILES[1], new Uint8Array(1))).toBe(true);
    expect((b as unknown as { updateImageRawData: ReturnType<typeof vi.fn> }).updateImageRawData).toHaveBeenCalledTimes(1);
  });
});
