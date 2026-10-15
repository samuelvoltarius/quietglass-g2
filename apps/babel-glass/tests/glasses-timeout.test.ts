import { afterEach, describe, expect, it, vi } from "vitest";
import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { createPage, IMAGE_CALL_MS, PAGE_CALL_MS, TEXT_CALL_MS, updateIcon, updatePage } from "../src/glasses/render";
import { iconFrame } from "../src/glasses/icon";
import type { CaptionView } from "../src/glasses/view";

// The sign is a PNG drawn on a canvas; the test has none, so the encoder is replaced.
vi.mock("../src/glasses/icon", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/glasses/icon")>()),
  iconPng: async () => new Uint8Array([1, 2, 3]),
}));

// Draws run one after another. A call into the glasses whose answer never
// comes used to freeze the display on its last page. Every call is now bounded.

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
const view: CaptionView = { header: "Babel", body: ["hello"], footer: "" };
const nextView: CaptionView = { header: "Babel", body: ["world"], footer: "" };

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
    const pending = createPage(b, view);
    await vi.advanceTimersByTimeAsync(2 * PAGE_CALL_MS + 100);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no answer from the glasses/);
  });

  it("gives up on a text write that hangs, and the next update works again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
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

  it("gives up on an icon that hangs, so the next draw can go on", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const b = bridge({ updateImageRawData: vi.fn(() => never()) });
    const pending = updateIcon(b, iconFrame("listening", 0));
    await vi.advanceTimersByTimeAsync(IMAGE_CALL_MS + 100);
    expect(await pending).toBe(false);
  });
});
