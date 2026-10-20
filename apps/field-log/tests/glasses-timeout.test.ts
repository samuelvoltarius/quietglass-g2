import { afterEach, describe, expect, it, vi } from "vitest";
import { COCKPIT_TILES, createCockpitPage, createPage, guardedTileSend, IMAGE_CALL_MS, PAGE_CALL_MS, TEXT_CALL_MS, updatePage, updateTextPage } from "../src/glasses/render";
import type { LogView } from "../src/glasses/view";

// Draws run one after another. A call into the glasses whose answer never
// comes used to freeze the display on its last page. Every call is now bounded.

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
const view: LogView = { header: "Rundgang", body: ["Eintrag 1"], footer: "" };
const nextView: LogView = { header: "Rundgang", body: ["Eintrag 2"], footer: "Tippen = fertig" };

function bridge(overrides: Record<string, unknown> = {}) {
  return {
    rebuildPageContainer: vi.fn(async () => true),
    createStartUpPageContainer: vi.fn(async () => 0),
    textContainerUpgrade: vi.fn(async () => true),
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

  it("gives up on a rebuild that hangs after the first page", async () => {
    vi.useFakeTimers();
    const rebuild = vi.fn().mockImplementationOnce(async () => true).mockImplementationOnce(() => never()).mockImplementation(async () => true);
    const b = bridge({ rebuildPageContainer: rebuild });
    expect((await createPage(b, view)).ok).toBe(true);
    const pending = createPage(b, nextView);
    await vi.advanceTimersByTimeAsync(PAGE_CALL_MS + 100);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no answer from the glasses/);
    expect((await createPage(b, nextView)).ok).toBe(true);
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
});

describe("the cockpit page and its tiles", () => {
  it("only the text containers whose text changed are written", async () => {
    const upgrade = vi.fn(async () => true);
    const b = bridge({ textContainerUpgrade: upgrade });
    await createPage(b, view);
    await updateTextPage(b, nextView, view);
    // Header unchanged, body and footer changed.
    expect(upgrade).toHaveBeenCalledTimes(2);
    await updateTextPage(b, nextView, nextView);
    expect(upgrade).toHaveBeenCalledTimes(2);
  });

  it("creates the cockpit as one input container and four image tiles", async () => {
    const create = vi.fn(async () => 0);
    expect((await createCockpitPage(bridge({ createStartUpPageContainer: create }))).ok).toBe(true);
    const page = (create.mock.calls[0] as unknown as [{ textObject: Array<{ containerID: number }>; imageObject: Array<{ containerID: number }> }])[0];
    expect(page.textObject.map((text) => text.containerID)).toEqual([20]);
    expect(page.imageObject.map((image) => image.containerID)).toEqual(COCKPIT_TILES.map((tile) => tile.id));
  });

  it("no tile is written while the exit dialog may be on screen (the sender's guard says no)", async () => {
    const update = vi.fn(async () => "success");
    const b = bridge({ updateImageRawData: update });
    let allowed = false;
    const send = guardedTileSend(b, () => allowed);
    expect(await send(COCKPIT_TILES[0], new Uint8Array(1))).toBe(false);
    expect(update).not.toHaveBeenCalled();
    allowed = true;
    expect(await send(COCKPIT_TILES[0], new Uint8Array(1))).toBe(true);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("gives up on a tile that never gets an answer", async () => {
    vi.useFakeTimers();
    const b = bridge({ updateImageRawData: vi.fn(() => never()) });
    const pending = guardedTileSend(b, () => true)(COCKPIT_TILES[1], new Uint8Array(1));
    const caught = pending.then(() => "resolved", (error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(IMAGE_CALL_MS + 100);
    expect(await caught).toMatch(/no answer from the glasses/);
  });
});
