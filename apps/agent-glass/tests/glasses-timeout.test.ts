import { afterEach, describe, expect, it, vi } from "vitest";
import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { EMPTY_STATE, type AgentState } from "../src/terminal/types";
import { COCKPIT_TILES, createPage, sendTile, IMAGE_CALL_MS, PAGE_CALL_MS, TEXT_CALL_MS, updatePage } from "../src/glasses/render";
import { buildView } from "../src/glasses/view";

// Draws run one after another. A call into the glasses whose answer never
// comes used to freeze the display on its last page. Every call is now bounded.

const NOW = new Date("2026-10-13T12:00:00Z");
const session = { id: "s", title: "Improve dashboard loading state", cwd: "/w", provider: "claude", status: "idle", timestamp: NOW };
const state = (patch: Partial<AgentState> = {}): AgentState => ({ ...EMPTY_STATE, session, controllable: true, ...patch });
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

const view = buildView(state({ text: "one" }), NOW);
const nextView = buildView(state({ text: "two" }), NOW);

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
    const pending = updatePage(b, nextView, view);
    await vi.advanceTimersByTimeAsync(TEXT_CALL_MS + 100);
    const failed = await pending;
    expect(failed.ok).toBe(false);
    expect(failed.reason).toMatch(/no answer from the glasses/);
    const before = upgrade.mock.calls.length;
    expect((await updatePage(b, nextView, view)).ok).toBe(true);
    expect(upgrade.mock.calls.length).toBeGreaterThan(before);
  });

  it("gives up on a cockpit tile that hangs, so the next draw can go on", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const b = bridge({ updateImageRawData: vi.fn(() => never()) });
    const caught = sendTile(b, COCKPIT_TILES[0], new Uint8Array([1])).catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(IMAGE_CALL_MS + 100);
    expect(await caught).toMatch(/no answer from the glasses/);
  });
});
