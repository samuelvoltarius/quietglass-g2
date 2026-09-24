import { isFollowingLive, visibleLines, wrap, type CaptionBuffer } from "../captions/buffer";
import type { SttStatus } from "../stt/provider";

/**
 * What the glasses show.
 *
 * Captions need the whole display, so everything else is compressed into one
 * status line. The microphone indicator is part of that line and is never
 * suppressed while the mic is open.
 */
export interface CaptionView {
  readonly header: string;
  readonly body: readonly string[];
  readonly footer: string;
}

/** Shown whenever the microphone is open. Not suppressible. */
const MIC_ON = "● MIC";

export type CaptionMode = "conversation" | "lecture" | "travel" | "captionOnly";

export interface ModePreset {
  /** Caption rows on screen. */
  readonly rows: number;
  /** Characters per row before wrapping. */
  readonly width: number;
  /** Show the translation instead of, or beneath, the original. */
  readonly showOriginal: boolean;
}

export const MODE_PRESETS: Readonly<Record<CaptionMode, ModePreset>> = {
  // Back and forth: few lines, both languages, so you can check a word.
  conversation: { rows: 4, width: 44, showOriginal: true },
  // One speaker at length: more history, translation only.
  lecture: { rows: 6, width: 46, showOriginal: false },
  // Signs and short exchanges: big and brief.
  travel: { rows: 3, width: 40, showOriginal: true },
  // No translation at all — accessibility captions in one language.
  captionOnly: { rows: 6, width: 46, showOriginal: true },
};

export interface ViewOptions {
  readonly mode: CaptionMode;
  readonly listening: boolean;
  readonly status: SttStatus;
  readonly translating: boolean;
  /** Scroll-back distance; 0 follows the live edge. */
  readonly offset: number;
  /** True when the provider in use is a mock. */
  readonly mock: boolean;
}

export function buildView(buffer: CaptionBuffer, options: ViewOptions): CaptionView {
  const preset = MODE_PRESETS[options.mode];

  if (!options.listening) {
    return {
      header: "Babel Glass",
      body: ["Not listening.", "Tap to start captions."],
      footer: options.mock ? "mock provider" : "tap = start",
    };
  }

  const lines = visibleLines(buffer, preset.rows, options.offset);
  const body: string[] = [];

  for (const line of lines) {
    const primary = options.translating && line.translated !== undefined
      ? line.translated
      : line.text;
    body.push(...wrap(primary, preset.width));

    // In conversation and travel modes the original is kept below the
    // translation, because checking a single word is the common need.
    if (options.translating && preset.showOriginal && line.translated !== undefined) {
      body.push(...wrap("  " + line.text, preset.width));
    }
  }

  if (body.length === 0) body.push(statusLabel(options.status));

  return {
    header: "",
    body: body.slice(-preset.rows * 2),
    footer: footerText(buffer, options, preset.rows),
  };
}

function footerText(
  buffer: CaptionBuffer,
  options: ViewOptions,
  rows: number,
): string {
  const parts: string[] = [MIC_ON];

  if (options.mock) parts.push("MOCK");
  if (options.status !== "ready") parts.push(statusLabel(options.status));
  if (!isFollowingLive(buffer, rows, options.offset)) parts.push("history");

  parts.push("tap = stop");
  return parts.join("  ·  ");
}

export function statusLabel(status: SttStatus): string {
  switch (status) {
    case "connecting": return "connecting…";
    case "reconnecting": return "reconnecting…";
    case "error": return "speech server error";
    case "ready": return "listening…";
    default: return "idle";
  }
}
