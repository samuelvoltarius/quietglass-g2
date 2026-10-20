import { afterEach, describe, expect, it, vi } from "vitest";
import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { INITIAL_CONTROL } from "../src/pages";
import { installPage, sendTile, COCKPIT_TILES, IMAGE_CALL_MS, PAGE_CALL_MS, TEXT_CALL_MS, updatePage } from "../src/glasses/render";
import { buildView, type ViewState } from "../src/glasses/views";

// Draws run one after another. A call into the glasses whose answer never
// comes used to freeze the display on its last page. Every call is now bounded.

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
const state = (extra: Partial<ViewState> = {}): ViewState => ({
  locale: "de", demo: true, connection: { kind: "loading" }, car: null, page: "status", control: INITIAL_CONTROL, overlay: null, local: null, now: 1_000, ...extra,
});
const view = buildView(state());
const nextView = buildView(state({ connection: { kind: "error", code: "unreachable" } }));

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
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const b = bridge({ rebuildPageContainer: vi.fn(() => never()), createStartUpPageContainer: vi.fn(() => never()) });
    const pending = installPage(b, view);
    await vi.advanceTimersByTimeAsync(2 * PAGE_CALL_MS + 100);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no answer from the glasses/);
  });

  it("gives up on a text write that hangs, and the next update works again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const upgrade = vi.fn().mockImplementationOnce(() => never()).mockImplementation(async () => true);
    const b = bridge({ textContainerUpgrade: upgrade });
    expect((await installPage(b, view)).ok).toBe(true);
    const pending = updatePage(b, nextView, view);
    await vi.advanceTimersByTimeAsync(TEXT_CALL_MS + 100);
    const failed = await pending;
    expect(failed.ok).toBe(false);
    expect(failed.reason).toMatch(/no answer from the glasses/);
    const before = upgrade.mock.calls.length;
    expect((await updatePage(b, nextView, null)).ok).toBe(true);
    expect(upgrade.mock.calls.length - before).toBe(3); // nothing skipped as "already shown"
  });

  it("gives up on a cockpit tile that hangs, so the next draw can go on", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const b = bridge({ updateImageRawData: vi.fn(() => never()) });
    const caught = sendTile(b, COCKPIT_TILES[0], new Uint8Array([1])).catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(IMAGE_CALL_MS + 100);
    expect(await caught).toMatch(/no answer from the glasses/);
  });
});
