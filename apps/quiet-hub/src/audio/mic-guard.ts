/**
 * The glasses microphone with the two ways it used to stay open:
 *
 * 1. Hold released before `audioControl(true)` answered: the stop ran first,
 *    then the late "on" opened the mic for good. Every start/stop gets a
 *    generation number; a start that was overtaken switches the mic off again
 *    at once and reports "cancelled".
 * 2. A recording without a release: a hard limit (`maxMs`) always ends it,
 *    whatever the page state is (`onLimit` decides how; the guard itself
 *    switches the mic off when nobody else does).
 */
export type MicStart = "on" | "refused" | "cancelled";

export interface MicGuardOptions {
  /** bridge.audioControl(on) — resolves true when the mic is (on) / was switched. */
  readonly control: (on: boolean) => Promise<boolean>;
  readonly maxMs: number;
  /** Called once when the limit hits while the mic is still on; afterwards the guard switches it off. */
  readonly onLimit?: () => void;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

export class MicGuard {
  /** True only while the mic is really on (PCM blocks belong to the recording). */
  active = false;
  private gen = 0;
  private timer: unknown = null;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly options: MicGuardOptions) {
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  async start(): Promise<MicStart> {
    const gen = ++this.gen;
    this.disarm();
    const ok = await this.options.control(true).catch(() => false);
    if (gen !== this.gen) {
      // Released (or stopped) while the mic was still being switched on.
      if (ok) await this.options.control(false).catch(() => false);
      return "cancelled";
    }
    if (!ok) return "refused";
    this.active = true;
    this.timer = this.setTimer(() => {
      this.timer = null;
      if (gen !== this.gen || !this.active) return;
      this.options.onLimit?.();
      // Whatever onLimit did: after the limit the mic is off.
      if (gen === this.gen && this.active) void this.stop();
    }, this.options.maxMs);
    return "on";
  }

  async stop(): Promise<void> {
    this.gen += 1;
    this.disarm();
    this.active = false;
    await this.options.control(false).catch(() => false);
  }

  private disarm(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }
}
