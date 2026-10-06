import { describe, expect, it, vi } from "vitest";
import { createExitRequest, EXIT_MODE_DIALOG } from "../src/exit";

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
    await createExitRequest(fake.bridge, { onConfirmed: () => undefined })();
    expect(EXIT_MODE_DIALOG).toBe(1);
    expect(fake.modes).toEqual([1]);
  });

  it("tears down only after the user confirmed", async () => {
    const onConfirmed = vi.fn();
    const onStayed = vi.fn();
    const fake = bridgeAnswering(async () => true);
    await expect(createExitRequest(fake.bridge, { onConfirmed, onStayed })()).resolves.toBe(true);
    expect(onConfirmed).toHaveBeenCalledTimes(1);
    expect(onStayed).not.toHaveBeenCalled();
  });

  it("keeps the app running when the user cancels", async () => {
    const onConfirmed = vi.fn();
    const onStayed = vi.fn();
    const fake = bridgeAnswering(async () => false);
    await expect(createExitRequest(fake.bridge, { onConfirmed, onStayed })()).resolves.toBe(false);
    expect(onConfirmed).not.toHaveBeenCalled();
    expect(onStayed).toHaveBeenCalledTimes(1);
  });

  it("catches a rejected call and treats it as staying", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const onConfirmed = vi.fn();
    const onStayed = vi.fn();
    const fake = bridgeAnswering(async () => { throw new Error("ble gone"); });
    await expect(createExitRequest(fake.bridge, { onConfirmed, onStayed })()).resolves.toBe(false);
    expect(onConfirmed).not.toHaveBeenCalled();
    expect(onStayed).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("asks once when the user double-taps again while the dialog is open", async () => {
    let answer: (value: boolean) => void = () => undefined;
    const fake = bridgeAnswering(() => new Promise<boolean>((resolve) => { answer = resolve; }));
    const request = createExitRequest(fake.bridge, { onConfirmed: () => undefined });
    const first = request();
    const second = request();
    answer(false);
    await Promise.all([first, second]);
    expect(fake.modes).toEqual([1]);
    // Once answered, the next double tap asks again.
    const third = request();
    answer(false);
    await third;
    expect(fake.modes).toEqual([1, 1]);
  });
});
