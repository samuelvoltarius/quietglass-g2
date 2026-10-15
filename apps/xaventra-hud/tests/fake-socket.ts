/** A WebSocket stand-in: records what was sent, lets the test open, answer and drop it. */
export class FakeSocket {
  static last: FakeSocket | null = null;
  static all: FakeSocket[] = [];
  readyState = 0;
  binaryType = "blob";
  sent: unknown[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) { FakeSocket.last = this; FakeSocket.all.push(this); }
  send(data: unknown): void { this.sent.push(data); }
  close(): void { this.closed = true; this.readyState = 3; }
  open(): void { this.readyState = 1; this.onopen?.(); }
  say(text: string, final = false): void { this.onmessage?.({ data: JSON.stringify({ type: final ? "final" : "partial", text, final }) }); }
  drop(): void { this.readyState = 3; this.onclose?.(); }
  json(): Array<Record<string, unknown>> { return this.sent.filter((s): s is string => typeof s === "string").map((s) => JSON.parse(s) as Record<string, unknown>); }
  binary(): Uint8Array[] { return this.sent.filter((s): s is Uint8Array => s instanceof Uint8Array); }
}
