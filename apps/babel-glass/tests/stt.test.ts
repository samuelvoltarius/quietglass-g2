import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebSocketStt } from "../src/stt/provider";

/** A socket whose handshake never finishes; close() fires onclose like a real one. */
class StuckSocket {
  static created = 0;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: unknown = null;
  onerror: unknown = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) { StuckSocket.created += 1; }
  send(): void { /* not connected */ }
  close(): void { this.onclose?.(); }
}

describe("WebSocket recogniser connection", () => {
  afterEach(() => { vi.useRealTimers(); StuckSocket.created = 0; });

  it("abandons a handshake that never completes and retries by itself", async () => {
    vi.useFakeTimers();
    const statuses: string[] = [];
    const stt = createWebSocketStt({
      url: "wss://speech.example", language: "auto", onTranscript: () => undefined,
      onStatus: (s) => statuses.push(s), WS: StuckSocket as unknown as typeof WebSocket,
    });
    const started = stt.start();
    await vi.advanceTimersByTimeAsync(9_000);
    await started; // start() resolves after the timeout instead of hanging
    expect(statuses).toContain("reconnecting");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(StuckSocket.created).toBeGreaterThan(1);
    await stt.stop();
  });
});
