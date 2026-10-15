/** A WebSocket stand-in that records what was sent and lets the test drive it. */
export class FakeSocket {
  static last: FakeSocket | null = null;
  readyState = 0;
  binaryType = "blob";
  sent: unknown[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) { FakeSocket.last = this; }
  send(data: unknown): void { this.sent.push(data); }
  close(): void { if (this.closed) return; this.closed = true; this.readyState = 3; this.onclose?.(); }
  open(): void { this.readyState = 1; this.onopen?.(); }
  reply(value: Record<string, unknown>): void { this.onmessage?.({ data: JSON.stringify(value) }); }
  drop(): void { this.readyState = 3; this.onclose?.(); }
}
