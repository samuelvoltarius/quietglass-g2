import { afterEach, describe, expect, it, vi } from "vitest";
import { createPage, IMAGE_CALL_MS, PAGE_CALL_MS, rebuildPage, TEXT_CALL_MS, updatePage } from "../src/glasses/render";
import { WALK_IMAGES } from "../src/glasses/layout";
import { plainScene, type Scene } from "../src/route/scene";
import type { StopView } from "../src/glasses/view";

// Draws run one after another. A call into the glasses whose answer never
// comes used to freeze the display on its last page. Every call is now bounded.

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
const view: StopView = { header: "Abfahrten", body: ["Bus 3 · 4 min"], footer: "" };
const nextView: StopView = { header: "Abfahrten", body: ["Bus 3 · 3 min"], footer: "Tippen = laden" };
const scene = plainScene(view);
const nextScene = plainScene(nextView);
const walkScene: Scene = {
  view, kind: "walk", animated: false,
  images: [{ id: WALK_IMAGES[0]!.id, key: "a", render: async () => new Uint8Array(4) }],
};

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
    const pending = createPage(b, scene);
    await vi.advanceTimersByTimeAsync(2 * PAGE_CALL_MS + 100);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no answer from the glasses/);
  });

  it("gives up on a rebuild that hangs, so the caller can create the page afresh", async () => {
    vi.useFakeTimers();
    const rebuild = vi.fn().mockImplementationOnce(async () => true).mockImplementationOnce(() => never()).mockImplementation(async () => true);
    const b = bridge({ rebuildPageContainer: rebuild });
    expect((await createPage(b, scene)).ok).toBe(true);
    const pending = rebuildPage(b, nextScene, null);
    await vi.advanceTimersByTimeAsync(PAGE_CALL_MS + 100);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no answer from the glasses/);
    expect((await createPage(b, nextScene)).ok).toBe(true);
  });

  it("gives up on a text write that hangs, and the next update works again", async () => {
    vi.useFakeTimers();
    const upgrade = vi.fn().mockImplementationOnce(() => never()).mockImplementation(async () => true);
    const b = bridge({ textContainerUpgrade: upgrade });
    expect((await createPage(b, scene)).ok).toBe(true);
    const pending = updatePage(b, nextScene);
    await vi.advanceTimersByTimeAsync(TEXT_CALL_MS + 100);
    const failed = await pending;
    expect(failed.ok).toBe(false);
    expect(failed.reason).toMatch(/no answer from the glasses/);
    const before = upgrade.mock.calls.length;
    expect((await updatePage(b, nextScene)).ok).toBe(true);
    expect(upgrade.mock.calls.length - before).toBe(3); // header, body and footer of a text page
  });

  it("gives up on a picture that hangs; the page stands and the picture is sent again next time", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const image = vi.fn().mockImplementationOnce(() => never()).mockImplementation(async () => "success");
    const b = bridge({ updateImageRawData: image });
    const pending = updatePage(b, walkScene);
    await vi.advanceTimersByTimeAsync(TEXT_CALL_MS + IMAGE_CALL_MS + 100);
    expect(await pending).toEqual({ ok: true, partial: true });
    const second = updatePage(b, walkScene);
    await vi.advanceTimersByTimeAsync(TEXT_CALL_MS);
    expect(await second).toEqual({ ok: true });
    expect(image).toHaveBeenCalledTimes(2);
  });
});
