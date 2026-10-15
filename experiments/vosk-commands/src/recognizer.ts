import { matchCommand, voskGrammar, type CommandDef, type CommandMatch, type MatchOptions } from "./commands";
import { pcmBytes, resample, s16leToFloat32, VOSK_RATE } from "./pcm";

/**
 * The part of vosk-browser 0.0.8 this module uses (see dist/model.d.ts there):
 *
 *   const model = await createModel(url);               // spawns a Web Worker
 *   const rec = new model.KaldiRecognizer(16000, grammarJson);
 *   rec.on("result", (m) => m.result.text);
 *   rec.acceptWaveformFloat(float32, 16000);             // floats in [-1, 1)
 *   rec.retrieveFinalResult();
 *
 * Kept as a small interface so the prototype builds and tests without the
 * 5.8 MB library or a model; a real app passes `createVoskEngine(model)`.
 */
export interface SpeechEngine {
  /** Feed 16 kHz mono float samples in [-1, 1). */
  accept(samples: Float32Array): void;
  /** Ask for the final result of the current utterance (e.g. when the user lets go). */
  finish(): void;
  /** Final texts arrive here. */
  onText(listener: (text: string) => void): void;
  /** Frees the recogniser (the model stays loaded). */
  dispose(): void;
}

/** Structural type of a vosk-browser Model, so no import of the library is needed here. */
export interface VoskModelLike {
  KaldiRecognizer: new (sampleRate: number, grammar?: string) => {
    on(event: "result" | "partialresult", listener: (message: { result?: { text?: string; partial?: string } }) => void): void;
    acceptWaveformFloat(buffer: Float32Array, sampleRate: number): void;
    retrieveFinalResult(): void;
    remove(): void;
  };
}

/** Adapter from a loaded vosk-browser model to SpeechEngine, restricted to the command grammar. */
export function createVoskEngine(model: VoskModelLike, commands: readonly CommandDef[], useGrammar = true): SpeechEngine {
  const recognizer = new model.KaldiRecognizer(VOSK_RATE, useGrammar ? voskGrammar(commands) : undefined);
  const listeners: ((text: string) => void)[] = [];
  recognizer.on("result", (message) => {
    const text = message.result?.text ?? "";
    for (const listener of listeners) listener(text);
  });
  return {
    // acceptWaveformFloat transfers the buffer to the worker; hand it a copy.
    accept: (samples) => recognizer.acceptWaveformFloat(samples.slice(), VOSK_RATE),
    finish: () => recognizer.retrieveFinalResult(),
    onText: (listener) => { listeners.push(listener); },
    dispose: () => recognizer.remove(),
  };
}

export interface CommandRecognizerOptions extends MatchOptions {
  /** Rate of the incoming PCM; the glasses deliver 16 kHz. */
  readonly inputRate?: number;
}

export interface CommandRecognizer {
  /** One `audioEvent.audioPcm` as delivered by the SDK (Uint8Array, number[] or base64). */
  pushPcm(raw: unknown): void;
  /** End of utterance (button released, silence): forces the final result. */
  finish(): void;
  /** Recognised commands; `text` is what Vosk heard (also when nothing matched, with `match: null`). */
  onResult(listener: (result: { text: string; match: CommandMatch | null }) => void): void;
  dispose(): void;
}

export function createCommandRecognizer(engine: SpeechEngine, commands: readonly CommandDef[], options: CommandRecognizerOptions = {}): CommandRecognizer {
  const inputRate = options.inputRate ?? VOSK_RATE;
  const listeners: ((result: { text: string; match: CommandMatch | null }) => void)[] = [];
  let disposed = false;
  engine.onText((text) => {
    if (disposed) return;
    const trimmed = text.trim();
    // Vosk sends an empty final result for silence; that is not worth an event.
    if (trimmed === "") return;
    const match = matchCommand(trimmed, commands, options);
    for (const listener of listeners) listener({ text: trimmed, match });
  });
  return {
    pushPcm(raw) {
      if (disposed) return;
      const bytes = pcmBytes(raw);
      if (!bytes || bytes.length < 2) return;
      engine.accept(resample(s16leToFloat32(bytes), inputRate));
    },
    finish() { if (!disposed) engine.finish(); },
    onResult(listener) { listeners.push(listener); },
    dispose() { disposed = true; engine.dispose(); },
  };
}
