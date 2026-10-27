import type { AppEntry, DpadKey, TvState } from "./model";

/**
 * One way to reach the TV. Every method either resolves or throws an
 * ApiError (see errors.ts); nothing here draws or stores.
 */
export interface TvBackend {
  readonly kind: "ha" | "bridge" | "demo";
  /** True when the D-pad (arrows, OK, back, home) can be sent. */
  readonly dpad: boolean;
  state(): Promise<TvState>;
  playPause(): Promise<void>;
  /** One volume step up (+1) or down (-1). */
  volumeStep(direction: 1 | -1): Promise<void>;
  /** Mute on (true) or off (false). */
  mute(on: boolean): Promise<void>;
  power(on: boolean): Promise<void>;
  /** Switches to a source of `TvState.sources` or launches an app of the configured list. */
  launch(entry: AppEntry): Promise<void>;
  key(key: DpadKey): Promise<void>;
}
