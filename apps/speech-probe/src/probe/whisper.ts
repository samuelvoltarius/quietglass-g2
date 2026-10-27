/**
 * Test B, model side: Whisper through transformers.js inside the WebView.
 *
 * transformers.js is imported dynamically, so the app's own bundle stays small
 * and the library is only fetched from the app package when test B runs.
 * Network (app.json whitelist, exact origins):
 *  - model files:   https://huggingface.co/<model>/resolve/main/... ; small JSON files are
 *                   307-redirected on the same host, the ONNX weights 302 to the Xet CDN
 *                   https://us.aws.cdn.hf.co (seen from Austria, 23.10.2026; older repos/regions
 *                   use https://cas-bridge.xethub.hf.co or https://cdn-lfs.hf.co);
 *  - ONNX runtime:  https://cdn.jsdelivr.net/npm/onnxruntime-web@<ver>/dist/ort-wasm-simd-threaded[.asyncify].{mjs,wasm}
 *                   (transformers.js default `wasmPaths`).
 * Every fetch goes through `env.fetch`, which is wrapped here to record the
 * origins actually used and the bytes that really came over the network.
 */

export type ModelId = "whisper-tiny" | "whisper-base";
export type DeviceWanted = "auto" | "webgpu" | "wasm";
export type Device = "webgpu" | "wasm";
/** Where the ONNX runtime (.wasm + loader) comes from: shipped in the app package, or transformers.js' default CDN. */
export type WasmSource = "bundled" | "cdn";

export const MODELS: Readonly<Record<ModelId, string>> = {
  "whisper-tiny": "Xenova/whisper-tiny",
  "whisper-base": "Xenova/whisper-base",
};

/** Per device: WASM runs the 8-bit files; WebGPU fp32 encoder + 4-bit decoder (the transformers.js Whisper WebGPU demo's choice). */
export function dtypeFor(device: Device): string | Record<string, string> {
  return device === "webgpu" ? { encoder_model: "fp32", decoder_model_merged: "q4" } : "q8";
}

export function dtypeLabel(dtype: string | Record<string, string>): string {
  return typeof dtype === "string" ? dtype : Object.entries(dtype).map(([k, v]) => `${k.replace(/_model.*$/, "")}:${v}`).join(" ");
}

export function whisperLanguage(lang: "de" | "en"): string {
  return lang === "de" ? "german" : "english";
}

export interface WebGpuInfo {
  readonly available: boolean;
  readonly detail: string;
}

/** navigator.gpu plus a real adapter request (bounded): the API can exist without a usable adapter. */
export async function detectWebGpu(nav: { gpu?: unknown } = navigator as unknown as { gpu?: unknown }, timeoutMs = 3000): Promise<WebGpuInfo> {
  const gpu = nav.gpu as { requestAdapter?: () => Promise<unknown> } | undefined;
  if (!gpu || typeof gpu.requestAdapter !== "function") return { available: false, detail: "no navigator.gpu" };
  try {
    const adapter = await Promise.race([
      gpu.requestAdapter(),
      new Promise<"timeout">((done) => setTimeout(() => done("timeout"), timeoutMs)),
    ]);
    if (adapter === "timeout") return { available: false, detail: "requestAdapter timeout" };
    if (!adapter) return { available: false, detail: "no adapter" };
    const info = (adapter as { info?: { vendor?: string; architecture?: string } }).info;
    return { available: true, detail: `adapter ${info?.vendor ?? "?"}/${info?.architecture ?? "?"}` };
  } catch (error) {
    return { available: false, detail: `requestAdapter failed: ${String(error).slice(0, 80)}` };
  }
}

export interface NetStats {
  files: number;
  bytes: number;
  readonly origins: Set<string>;
  readonly failures: string[];
}

export interface LoadStats {
  readonly device: Device;
  readonly dtype: string;
  readonly modelBytes: number;
  readonly netBytes: number;
  readonly netFiles: number;
  readonly hosts: string;
  readonly fetchMs: number;
  readonly sessionMs: number;
  readonly loadMs: number;
  readonly fallback: string;
  /** Runtime source actually in effect (fixed by the first load of this app run). */
  readonly runtime: string;
}

export interface LoadProgress {
  /** 0..100 over all files whose size is known. */
  readonly percent: number;
  readonly loaded: number;
  readonly total: number;
}

type Transcriber = (audio: Float32Array, options: Record<string, unknown>) => Promise<{ text?: string } | Array<{ text?: string }>>;

interface Loaded {
  readonly key: string;
  readonly pipe: Transcriber;
  readonly stats: LoadStats;
}

let loaded: Loaded | null = null;
const net: NetStats = { files: 0, bytes: 0, origins: new Set(), failures: [] };
let fetchWrapped = false;
/** The ONNX runtime initialises once per page: the first load decides where its files come from. */
let runtimeUsed: WasmSource | null = null;

function originOf(url: string): string {
  try { return new URL(url).origin; } catch { return "?"; }
}

/** Wraps transformers.js' fetch once: every response's final origin and its size are counted. */
function trackFetch(env: { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> }): void {
  if (fetchWrapped) return;
  fetchWrapped = true;
  const inner = env.fetch;
  env.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    try {
      const response = await inner(input, init);
      // Both ends of a redirect: the whitelist needs the first host and the CDN it sends to.
      net.origins.add(originOf(url));
      if (response.url) net.origins.add(originOf(response.url));
      if (response.ok && (init?.method ?? "GET") === "GET") {
        net.files += 1;
        net.bytes += Number(response.headers.get("content-length") ?? 0) || 0;
      } else if (!response.ok) {
        net.failures.push(`${response.status} ${originOf(url)}`);
      }
      return response;
    } catch (error) {
      net.failures.push(`${originOf(url)}: ${String(error).slice(0, 60)}`);
      throw error;
    }
  };
}

export function loadedModel(): { key: string; stats: LoadStats } | null {
  return loaded ? { key: loaded.key, stats: loaded.stats } : null;
}

/**
 * Loads (or reuses) the Whisper pipeline. Download/cache read and ONNX session
 * creation overlap inside transformers.js; `fetchMs` is start -> last file
 * "done", `sessionMs` is the rest until the pipeline is ready.
 */
export async function loadWhisper(model: ModelId, device: Device, wasm: WasmSource, onProgress: (p: LoadProgress) => void = () => undefined): Promise<{ pipe: Transcriber; stats: LoadStats; reused: boolean }> {
  const key = `${model}|${device}`;
  if (loaded?.key === key) return { pipe: loaded.pipe, stats: loaded.stats, reused: true };
  const transformers = await import("@huggingface/transformers");
  const env = transformers.env as unknown as {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    allowLocalModels: boolean;
    backends: { onnx: { wasm?: { wasmPaths?: unknown } } };
  };
  env.allowLocalModels = false;
  trackFetch(env);
  if (runtimeUsed === null) {
    runtimeUsed = wasm;
    // transformers.js points wasmPaths at cdn.jsdelivr.net on import; without it onnxruntime-web falls back to
    // the .wasm Vite emitted next to the bundle (dist/assets), i.e. inside the app package.
    if (wasm === "bundled" && env.backends.onnx.wasm) env.backends.onnx.wasm.wasmPaths = undefined;
  }
  const netBefore = { files: net.files, bytes: net.bytes };
  const files = new Map<string, { loaded: number; total: number }>();
  const started = performance.now();
  let lastDone = started;
  const dtype = dtypeFor(device);
  const pipe = await (transformers.pipeline as unknown as (task: string, model: string, options: Record<string, unknown>) => Promise<Transcriber>)(
    "automatic-speech-recognition",
    MODELS[model],
    {
      device,
      dtype,
      progress_callback: (info: { status?: string; file?: string; loaded?: number; total?: number }) => {
        if (info.status === "progress" && info.file) {
          files.set(info.file, { loaded: info.loaded ?? 0, total: info.total ?? 0 });
          let l = 0;
          let t = 0;
          for (const f of files.values()) { l += f.loaded; t += f.total; }
          onProgress({ percent: t > 0 ? Math.round((l / t) * 100) : 0, loaded: l, total: t });
        }
        if (info.status === "done") lastDone = performance.now();
      },
    },
  );
  const ready = performance.now();
  let modelBytes = 0;
  for (const f of files.values()) modelBytes += f.total;
  const stats: LoadStats = {
    device,
    dtype: dtypeLabel(dtype),
    modelBytes,
    netBytes: net.bytes - netBefore.bytes,
    netFiles: net.files - netBefore.files,
    hosts: [...net.origins].join(" "),
    fetchMs: Math.round(lastDone - started),
    sessionMs: Math.round(ready - lastDone),
    loadMs: Math.round(ready - started),
    fallback: "",
    runtime: runtimeUsed ?? wasm,
  };
  loaded = { key, pipe, stats };
  return { pipe, stats, reused: false };
}

/** Origins seen so far and fetch failures, for an error report when loading fails. */
export function netReport(): { hosts: string; failures: string } {
  return { hosts: [...net.origins].join(" "), failures: net.failures.slice(-5).join("; ") };
}

export async function transcribe(pipe: Transcriber, audio: Float32Array, lang: "de" | "en"): Promise<{ text: string; ms: number }> {
  const started = performance.now();
  const out = await pipe(audio, { language: whisperLanguage(lang), task: "transcribe" });
  const ms = Math.round(performance.now() - started);
  const text = Array.isArray(out) ? out.map((o) => o.text ?? "").join(" ") : out.text ?? "";
  return { text: text.trim(), ms };
}
