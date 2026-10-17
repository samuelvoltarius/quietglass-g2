import { describe, expect, it, vi } from "vitest";
import { createExitRequest, EXIT_MODE_DIALOG, isBackSignal, isSystemExitEvent } from "../src/exit";

function bridgeAnswering(answer: () => Promise<boolean>) {
  const modes: (number | undefined)[] = [];
  return {
    modes,
    bridge: { shutDownPageContainer: (mode?: number): Promise<boolean> => { modes.push(mode); return answer(); } },
  };
}

describe("root-page exit", () => {
  it("asks for the system exit dialog (mode 1), never an immediate exit", async () => {
    const fake = bridgeAnswering(async () => false);
    await createExitRequest(fake.bridge)();
    expect(EXIT_MODE_DIALOG).toBe(1);
    expect(fake.modes).toEqual([1]);
  });

  it("resolving true means the dialog is shown, not that the user confirmed: nothing is torn down", async () => {
    const onBack = vi.fn();
    const request = createExitRequest(bridgeAnswering(async () => true).bridge, { onBack });
    await request();
    // No redraw while the dialog may still be on screen.
    expect(onBack).not.toHaveBeenCalled();
    expect(request.asked()).toBe(true);
  });

  it("restores once, on the next signal that the app is back (not on the promise result)", async () => {
    const onBack = vi.fn();
    const request = createExitRequest(bridgeAnswering(async () => false).bridge, { onBack });
    request.back();
    expect(onBack).not.toHaveBeenCalled();
    await request();
    expect(onBack).not.toHaveBeenCalled();
    request.back();
    request.back();
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(request.asked()).toBe(false);
  });

  it("a rejected call also leaves the app running and restores on the next signal", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const onBack = vi.fn();
    const request = createExitRequest(bridgeAnswering(async () => { throw new Error("ble gone"); }).bridge, { onBack });
    await expect(request()).resolves.toBeUndefined();
    expect(onBack).not.toHaveBeenCalled();
    request.back();
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("a second double tap before any restore restores first, then asks again", async () => {
    const order: string[] = [];
    const bridge = { shutDownPageContainer: async (): Promise<boolean> => { order.push("ask"); return true; } };
    const request = createExitRequest(bridge, { onBack: () => { order.push("restore"); } });
    await request();
    await request();
    expect(order).toEqual(["ask", "restore", "ask"]);
  });

  it("asks once when the user double-taps again while the call is still open", async () => {
    let answer: (value: boolean) => void = () => undefined;
    const fake = bridgeAnswering(() => new Promise<boolean>((resolve) => { answer = resolve; }));
    const request = createExitRequest(fake.bridge);
    const first = request();
    const second = request();
    answer(true);
    await Promise.all([first, second]);
    expect(fake.modes).toEqual([1]);
    const third = request();
    answer(true);
    await third;
    expect(fake.modes).toEqual([1, 1]);
  });

  it("a failing restore is caught", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const request = createExitRequest(bridgeAnswering(async () => true).bridge, { onBack: () => { throw new Error("draw failed"); } });
    await request();
    expect(() => request.back()).not.toThrow();
    warn.mockRestore();
  });
});

describe("exit signals", () => {
  it("system exit is sysEvent 6 or 7 only", () => {
    expect(isSystemExitEvent({ sysEvent: { eventType: 7 } })).toBe(true);
    expect(isSystemExitEvent({ sysEvent: { eventType: 6 } })).toBe(true);
    expect(isSystemExitEvent({ sysEvent: { eventType: 4 } })).toBe(false);
    expect(isSystemExitEvent({ sysEvent: { eventType: 3 } })).toBe(false);
    expect(isSystemExitEvent(undefined)).toBe(false);
  });

  it("gestures and foreground-enter mean the app is back; leaving events and sensor streams do not", () => {
    expect(isBackSignal({ sysEvent: { eventType: 3 } })).toBe(true);
    expect(isBackSignal({ sysEvent: { eventType: 4 } })).toBe(true);
    expect(isBackSignal({ listEvent: { currentSelectItemIndex: 1 } })).toBe(true);
    expect(isBackSignal({ textEvent: {} })).toBe(true);
    expect(isBackSignal({ sysEvent: { eventType: 5 } })).toBe(false);
    expect(isBackSignal({ sysEvent: { eventType: 6 } })).toBe(false);
    expect(isBackSignal({ sysEvent: { eventType: 7 } })).toBe(false);
    expect(isBackSignal({ sysEvent: { eventType: 8 } })).toBe(false);
    expect(isBackSignal({ audioEvent: { audioPcm: new Uint8Array(2) } })).toBe(false);
  });

  it("the 4/5 after an exit call are the dialog's own show/close (hardware step log): 4 draws nothing, 5 restores once", async () => {
    const onBack = vi.fn();
    const request = createExitRequest(bridgeAnswering(async () => true).bridge, { onBack });
    expect(request.onLifecycle({ sysEvent: { eventType: 4 } })).toBeNull(); // a 4 without an exit call is a normal foreground
    await request();
    expect(request.onLifecycle({ audioEvent: { audioPcm: new Uint8Array(2) } })).toBeNull(); // sensor streams change nothing
    expect(request.onLifecycle({ sysEvent: { eventType: 8 } })).toBeNull();
    expect(request.onLifecycle({ sysEvent: { eventType: 4 } })).toBe("dialogShown");
    expect(onBack).not.toHaveBeenCalled();
    expect(request.asked()).toBe(true);
    expect(request.onLifecycle({ sysEvent: { eventType: 5 } })).toBe("dialogClosed");
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(request.asked()).toBe(false);
    // The dialog is gone: a later 5 is an ordinary leave, a later 4 an ordinary foreground.
    expect(request.onLifecycle({ sysEvent: { eventType: 5 } })).toBeNull();
    expect(request.onLifecycle({ sysEvent: { eventType: 4 } })).toBeNull();
  });

  it("any other event between the exit call and the 4 ends the dialog tracking", async () => {
    const request = createExitRequest(bridgeAnswering(async () => true).bridge, { onBack: vi.fn() });
    await request();
    expect(request.onLifecycle({ sysEvent: { eventType: 3 } })).toBeNull();
    expect(request.onLifecycle({ sysEvent: { eventType: 4 } })).toBeNull();
    expect(request.onLifecycle({ sysEvent: { eventType: 7 } })).toBeNull();
  });
});
