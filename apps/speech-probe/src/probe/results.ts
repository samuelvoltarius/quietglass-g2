/**
 * What the two probes measured, and how it is shown (phone table, glasses
 * lines, "Copy results" text) and logged (one flat step-log event per test).
 * Pure: no DOM, no bridge.
 */

export type Lang = "de" | "en";

/** Test A: the platform speech recognition inside the Even app WebView (phone microphone). */
export interface ResultA {
  readonly at: string;
  readonly lang: Lang;
  readonly userAgent: string;
  readonly secureContext: boolean;
  readonly protocol: string;
  readonly hasSpeechRecognition: boolean;
  readonly hasWebkitSpeechRecognition: boolean;
  readonly hasGetUserMedia: boolean;
  /** start() was called without throwing. */
  readonly started: boolean;
  /** Microphone permission state via navigator.permissions, before and after ("n/a" if not queryable). */
  readonly permissionBefore: string;
  readonly permissionAfter: string;
  /** What the tester said on the phone page: did iOS show a permission prompt? */
  readonly promptSeen: "yes" | "no" | "?";
  /** Event names with ms since start(), e.g. "start@40 audiostart@900 result@2300 end@2600". */
  readonly events: string;
  /** ms from start() to the first "audiostart" (a long gap usually means a permission prompt was open). */
  readonly audioStartMs: number | null;
  readonly transcript: string;
  readonly confidence: number | null;
  readonly isFinal: boolean;
  /** Exact SpeechRecognitionErrorEvent.error names (or the exception name), comma separated. */
  readonly errors: string;
  readonly errorMessage: string;
  readonly durationMs: number;
  readonly voices: number;
  readonly voiceLangs: string;
  readonly deVoices: number;
  readonly enVoices: number;
}

/** Test B: Whisper in the WebView on 5 s of glasses microphone audio. */
export interface ResultB {
  readonly at: string;
  readonly lang: Lang;
  readonly model: string;
  readonly deviceWanted: string;
  /** Device the model actually runs on ("webgpu" | "wasm"), or "" if it never loaded. */
  readonly device: string;
  readonly dtype: string;
  readonly webgpu: string;
  readonly cacheApi: boolean;
  /** The model was already in memory from an earlier run: no load numbers this time. */
  readonly reused: boolean;
  readonly modelBytes: number;
  /** Bytes that really came over the network (0 = everything from the browser cache). */
  readonly netBytes: number;
  readonly netFiles: number;
  /** Origins the model and runtime files came from (after redirects). */
  readonly hosts: string;
  readonly fetchMs: number | null;
  readonly sessionMs: number | null;
  readonly loadMs: number | null;
  readonly fallback: string;
  /** ONNX runtime files: "bundled" (app package) or "cdn" (cdn.jsdelivr.net). */
  readonly runtime: string;
  readonly audioControl: string;
  readonly recordMs: number;
  readonly chunks: number;
  readonly firstChunkMs: number | null;
  readonly audioSeconds: number;
  readonly samplesPerSecond: number;
  readonly rmsDb: number;
  readonly peakDb: number;
  readonly roles: string;
  readonly roleSelf: number;
  readonly roleOther: number;
  readonly roleUnknown: number;
  readonly roleMissing: number;
  readonly transcribeMs: number | null;
  readonly rtf: number | null;
  readonly text: string;
  /** Stage that failed ("" = none): "mic" | "noAudio" | "load" | "transcribe". */
  readonly failedAt: string;
  readonly error: string;
}

export function fmtMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "–";
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;
}

export function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} kB`;
  return `${bytes} B`;
}

/** Real-time factor: processing time / audio time (below 1 = faster than real time). */
export function realTimeFactor(transcribeMs: number | null, audioSeconds: number): number | null {
  if (transcribeMs === null || !(audioSeconds > 0)) return null;
  return Math.round((transcribeMs / 1000 / audioSeconds) * 100) / 100;
}

const yesNo = (v: boolean): string => (v ? "yes" : "no");

export function rowsA(r: ResultA): Array<[string, string]> {
  const available = r.hasSpeechRecognition || r.hasWebkitSpeechRecognition;
  return [
    ["Available", available ? `yes (${[r.hasSpeechRecognition ? "SpeechRecognition" : "", r.hasWebkitSpeechRecognition ? "webkitSpeechRecognition" : ""].filter(Boolean).join(", ")})` : "no"],
    ["Language", r.lang],
    ["Started", yesNo(r.started)],
    ["Prompt seen", r.promptSeen],
    ["Permission", `${r.permissionBefore} → ${r.permissionAfter}`],
    ["Audio start", fmtMs(r.audioStartMs)],
    ["Result", r.transcript ? `${r.transcript}${r.isFinal ? "" : " (interim)"}` : "–"],
    ["Confidence", r.confidence === null ? "–" : r.confidence.toFixed(2)],
    ["Errors", r.errors || "none"],
    ["Error text", r.errorMessage || "–"],
    ["Events", r.events || "–"],
    ["Duration", fmtMs(r.durationMs)],
    ["Voices", `${r.voices} (de ${r.deVoices}, en ${r.enVoices})`],
    ["Voice langs", r.voiceLangs || "–"],
    ["getUserMedia", yesNo(r.hasGetUserMedia)],
    ["Context", `${r.protocol} secure=${yesNo(r.secureContext)}`],
    ["User agent", r.userAgent],
  ];
}

export function rowsB(r: ResultB): Array<[string, string]> {
  return [
    ["Text", r.text || "–"],
    ["Error", r.error ? `${r.failedAt}: ${r.error}` : "none"],
    ["Model", `${r.model} · ${r.dtype}`],
    ["Device", `${r.device || "–"} (wanted ${r.deviceWanted})${r.fallback ? ` · ${r.fallback}` : ""}`],
    ["WebGPU", r.webgpu],
    ["Runtime", r.runtime === "cdn" ? "ONNX runtime from cdn.jsdelivr.net" : "ONNX runtime from app package"],
    ["Language", r.lang],
    ["Model size", fmtBytes(r.modelBytes)],
    ["Transferred", r.reused ? "in memory" : `${fmtBytes(r.netBytes)} in ${r.netFiles} files (content-length, may be compressed; 0 = browser cache)`],
    ["Fetch", r.reused ? "–" : fmtMs(r.fetchMs)],
    ["Session", r.reused ? "–" : fmtMs(r.sessionMs)],
    ["Load total", r.reused ? "–" : fmtMs(r.loadMs)],
    ["Transcribe", fmtMs(r.transcribeMs)],
    ["RTF", r.rtf === null ? "–" : String(r.rtf)],
    ["Audio", `${r.audioSeconds.toFixed(2)} s · ${r.chunks} chunks · ${r.samplesPerSecond} samples/s`],
    ["Level", `rms ${r.rmsDb} dBFS · peak ${r.peakDb} dBFS`],
    ["First chunk", fmtMs(r.firstChunkMs)],
    ["Speaker role", r.roles],
    ["audioControl", r.audioControl],
    ["Cache API", yesNo(r.cacheApi)],
    ["Hosts", r.hosts || "–"],
  ];
}

/** The glasses' result lines for test B (short; the full table is on the phone). */
export function glassesLinesB(r: ResultB): string[] {
  if (r.error) return [`Failed at ${r.failedAt || "?"}:`, r.error.slice(0, 160)];
  return [
    r.text || "(no text)",
    "",
    `${fmtMs(r.transcribeMs)} for ${r.audioSeconds.toFixed(1)} s · RTF ${r.rtf ?? "–"} · ${r.device}`,
    r.reused ? `${r.model} · model in memory` : `load ${fmtMs(r.loadMs)} · ${fmtBytes(r.modelBytes)} · net ${fmtBytes(r.netBytes)}`,
    `role: ${r.roles}`,
  ];
}

/** One-line summary of test A for the glasses' info screen. */
export function summaryA(r: ResultA): string {
  const available = r.hasSpeechRecognition || r.hasWebkitSpeechRecognition;
  if (!available) return "Last run: not available";
  if (r.errors) return `Last run: error ${r.errors}`;
  return `Last run: "${r.transcript.slice(0, 60) || "no text"}"`;
}

/** Plain text for "Copy results". */
export function copyText(a: ResultA | null, b: ResultB | null, version: string): string {
  const lines = [`Speech Probe ${version}`];
  const table = (title: string, rows: Array<[string, string]>, at: string): void => {
    lines.push("", `${title} (${at})`);
    for (const [k, v] of rows) lines.push(`${k}: ${v}`);
  };
  if (a) table("Test A · platform speech recognition", rowsA(a), a.at);
  else lines.push("", "Test A: not run");
  if (b) table("Test B · Whisper on glasses mic", rowsB(b), b.at);
  else lines.push("", "Test B: not run");
  return lines.join("\n");
}

type Flat = Record<string, string | number | boolean | null>;

/** Every field as one step-log event (numbers stay numbers; strings are clipped by the log to 200 chars). */
export function diagFields(r: ResultA | ResultB): Flat {
  const out: Flat = {};
  for (const [k, v] of Object.entries(r)) {
    out[k] = typeof v === "number" || typeof v === "boolean" || typeof v === "string" || v === null ? v : String(v);
  }
  return out;
}
