import { afterEach, describe, expect, it, vi } from "vitest";
import { createTextPage, PAGE_CALL_MS, TEXT_CALL_MS, updateTextPage, type TextView } from "../src/glasses/text";

// Draws run one after another. A call into the glasses whose answer never
// comes used to freeze the display on its last page. Every call is now bounded.

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
const view: TextView = { header: "Märkte", body: ["Position 1"], footer: "" };
const nextView: TextView = { header: "Märkte", body: ["Position 2"], footer: "Tippen = laden" };

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
    const pending = createTextPage(b, view);
    await vi.advanceTimersByTimeAsync(2 * PAGE_CALL_MS + 100);
    expect(await pending).toBe(false);
  });

  it("gives up on a text write that hangs, and the next update works again", async () => {
    vi.useFakeTimers();
    const upgrade = vi.fn().mockImplementationOnce(() => never()).mockImplementation(async () => true);
    const b = bridge({ textContainerUpgrade: upgrade });
    expect(await createTextPage(b, view)).toBe(true);
    const pending = updateTextPage(b, nextView);
    await vi.advanceTimersByTimeAsync(TEXT_CALL_MS + 100);
    expect(await pending).toBe(false);
    const before = upgrade.mock.calls.length;
    expect(await updateTextPage(b, nextView)).toBe(true);
    expect(upgrade.mock.calls.length - before).toBe(3);
  });
});
