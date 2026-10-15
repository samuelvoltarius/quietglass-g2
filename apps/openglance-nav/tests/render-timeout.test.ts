import { afterEach, describe, expect, it, vi } from "vitest";
import { IMAGE_CALL_MS, PAGE_CALL_MS, REBUILD_REFUSED_RECREATE, showPage, TEXT_CALL_MS, updatePage } from "../src/glasses/render";
import type { NavView } from "../src/glasses/view";

// Draws run one after another. A call into the glasses whose answer never
// comes used to freeze the display on its last page ("Route wird berechnet…"
// on 14.10. while the route had arrived). Every call is now bounded.

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
const view: NavView = { header: "Route wird berechnet…", body: [], footer: "" };
const nextView: NavView = { header: "Salzburg → St. Michael", body: ["250 m"], footer: "" };

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
    const pending = showPage(b, view, "text");
    await vi.advanceTimersByTimeAsync(2 * PAGE_CALL_MS + 100);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no answer from the glasses/);
  });

  it("gives up on a text write that hangs, and writes every box again on the next update", async () => {
    vi.useFakeTimers();
    const upgrade = vi.fn().mockImplementationOnce(() => never()).mockImplementation(async () => true);
    const b = bridge({ textContainerUpgrade: upgrade });
    expect((await showPage(b, view, "text")).ok).toBe(true);
    const pending = updatePage(b, nextView, "text");
    await vi.advanceTimersByTimeAsync(TEXT_CALL_MS + 100);
    expect((await pending).ok).toBe(false);
    const before = upgrade.mock.calls.length;
    expect((await updatePage(b, nextView, "text")).ok).toBe(true);
    expect(upgrade.mock.calls.length - before).toBeGreaterThanOrEqual(2); // nothing skipped as "already shown"
  });

  it("gives up on an image that hangs, so the next draw can go on", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const b = bridge({ updateImageRawData: vi.fn(() => never()) });
    let settled: { ok: boolean } | null = null;
    void showPage(b, view, "hud", { hud: { arrow: "right" } }).then((r) => { settled = r; });
    // The PNG is encoded first (real async work), then the bounded send starts.
    for (let i = 0; i < 2000 && settled === null; i++) {
      await new Promise<void>((resolve) => (globalThis as unknown as { setImmediate(cb: () => void): void }).setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(IMAGE_CALL_MS / 4);
    }
    expect(settled).toEqual(expect.objectContaining({ ok: false }));
  });
});

describe("a page change the glasses keep refusing", () => {
  it(`after ${REBUILD_REFUSED_RECREATE} refused rebuilds in a row the next page is created afresh (hardware 15.10.: refused for good)`, async () => {
    const rebuild = vi.fn(async () => true);
    const create = vi.fn(async () => 0);
    const b = bridge({ rebuildPageContainer: rebuild, createStartUpPageContainer: create });
    expect((await showPage(b, view, "text")).ok).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
    rebuild.mockImplementation(async () => false);
    for (let i = 0; i < REBUILD_REFUSED_RECREATE; i++) expect((await showPage(b, nextView, "text")).reason).toBe("rebuild refused");
    expect(create).toHaveBeenCalledTimes(1);
    rebuild.mockImplementation(async () => true);
    expect((await showPage(b, nextView, "text")).ok).toBe(true);
    expect(create).toHaveBeenCalledTimes(2);
    // Afterwards pages are rebuilt again, not created.
    expect((await showPage(b, view, "text")).ok).toBe(true);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("a refusal between successes does not count up", async () => {
    const rebuild = vi.fn(async () => true);
    const create = vi.fn(async () => 0);
    const b = bridge({ rebuildPageContainer: rebuild, createStartUpPageContainer: create });
    await showPage(b, view, "text");
    for (let i = 0; i < REBUILD_REFUSED_RECREATE + 2; i++) {
      rebuild.mockImplementationOnce(async () => false);
      await showPage(b, nextView, "text");
      await showPage(b, view, "text");
    }
    expect(create).toHaveBeenCalledTimes(1);
  });
});
