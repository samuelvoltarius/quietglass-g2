import { afterEach, describe, expect, it, vi } from "vitest";
import { validateEvenHubPageContainer, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { buildCockpitPage, COCKPIT_TILES, createCockpitPage, guardedTileSend, IMAGE_CALL_MS, PAGE_CALL_MS, sendTile } from "../src/glasses/page";

// Draws run one after another. A call into the glasses whose answer never
// comes used to freeze the display on its last page. Every call is bounded.

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

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

describe("the cockpit page", () => {
  it("is four image tiles over one input container and passes the SDK validation", () => {
    const page = buildCockpitPage();
    expect(page.imageObject ?? []).toHaveLength(4);
    expect((page.textObject ?? []).filter((c) => c.isEventCapture === 1)).toHaveLength(1);
    expect(validateEvenHubPageContainer(page).valid).toBe(true);
    expect(COCKPIT_TILES.map((tile) => [tile.x, tile.y, tile.width, tile.height])).toEqual([[0, 0, 288, 144], [288, 0, 288, 144], [0, 144, 288, 144], [288, 144, 288, 144]]);
  });

  it("is created once (after one first rebuild) and rebuilt afterwards", async () => {
    const calls: string[] = [];
    const b = bridge({
      createStartUpPageContainer: async () => { calls.push("create"); return 0; },
      rebuildPageContainer: async () => { calls.push("rebuild"); return true; },
    });
    await createCockpitPage(b);
    await createCockpitPage(b);
    expect(calls).toEqual(["rebuild", "create", "rebuild"]);
  });
});

describe("calls into the glasses are bounded", () => {
  it("gives up on a page that never gets an answer, instead of waiting for ever", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const b = bridge({ rebuildPageContainer: vi.fn(() => never()), createStartUpPageContainer: vi.fn(() => never()) });
    const pending = createCockpitPage(b);
    await vi.advanceTimersByTimeAsync(2 * PAGE_CALL_MS + 100);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no answer from the glasses/);
  });

  it("gives up on an image tile that hangs, and the next one works again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const image = vi.fn().mockImplementationOnce(() => never()).mockImplementation(async () => "success");
    const b = bridge({ updateImageRawData: image });
    const pending = sendTile(b, COCKPIT_TILES[0], new Uint8Array(1));
    const caught = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(IMAGE_CALL_MS + 100);
    expect(String(await caught)).toMatch(/no answer from the glasses/);
    expect(await sendTile(b, COCKPIT_TILES[0], new Uint8Array(1))).toBe(true);
  });

  it("writes no tile while the exit dialog may be up", async () => {
    const b = bridge();
    let allowed = true;
    const send = guardedTileSend(b, () => allowed);
    expect(await send(COCKPIT_TILES[1], new Uint8Array(1))).toBe(true);
    allowed = false;
    expect(await send(COCKPIT_TILES[1], new Uint8Array(1))).toBe(false);
    expect(b.updateImageRawData).toHaveBeenCalledTimes(1);
  });
});
