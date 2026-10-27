import { levelDbfs, PcmRecorder, toBytes } from "../audio/pcm";
import { formatShares, RoleTally } from "../audio/roles";
import { realTimeFactor, type Lang, type ResultB } from "./results";
import type { Device, DeviceWanted, LoadProgress, LoadStats, ModelId, WasmSource, WebGpuInfo } from "./whisper";

/** Recording window of test B. */
export const RECORD_MS = 5_000;

export type StageB =
  | { readonly kind: "recording"; readonly secondsLeft: number; readonly chunks: number }
  | { readonly kind: "loading"; readonly progress: LoadProgress | null }
  | { readonly kind: "transcribing"; readonly audioSeconds: number };

type Transcriber = unknown;

/** Everything test B touches outside itself; main.ts passes the real bridge and transformers.js, tests pass fakes. */
export interface TestBDeps {
  audioControl(open: boolean): Promise<boolean>;
  detectWebGpu(): Promise<WebGpuInfo>;
  loadWhisper(model: ModelId, device: Device, wasm: WasmSource, onProgress: (p: LoadProgress) => void): Promise<{ pipe: Transcriber; stats: LoadStats; reused: boolean }>;
  transcribe(pipe: Transcriber, audio: Float32Array, lang: Lang): Promise<{ text: string; ms: number }>;
  netReport(): { hosts: string; failures: string };
  readonly cacheApi: boolean;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface TestBOptions {
  readonly lang: Lang;
  readonly model: ModelId;
  readonly device: DeviceWanted;
  readonly wasm: WasmSource;
  readonly onStage?: (stage: StageB) => void;
  /** Ends the recording early (2× on the glasses): the run reports "cancelled". */
  readonly cancelled?: () => boolean;
}

/**
 * One run of test B: 5 s of glasses microphone, then Whisper. Audio events are
 * fed in through `feed` while recording. Never rejects; failures end up in
 * `failedAt` / `error`.
 */
export class TestBRunner {
  private recorder: PcmRecorder | null = null;
  private roles: RoleTally | null = null;

  constructor(private readonly deps: TestBDeps) {}

  get recording(): boolean {
    return this.recorder !== null;
  }

  /** One bridge event; only microphone frames during a recording count. */
  feed(event: unknown): boolean {
    const audio = (event as { audioEvent?: { audioPcm?: unknown; speakerRole?: unknown } } | null)?.audioEvent;
    if (!audio || !this.recorder || !this.roles) return false;
    const bytes = toBytes(audio.audioPcm);
    if (!bytes || bytes.length === 0) return true;
    this.recorder.push(bytes, this.deps.now());
    this.roles.add(audio.speakerRole, bytes.length);
    return true;
  }

  async run(opts: TestBOptions): Promise<ResultB> {
    const { deps } = this;
    const stage = opts.onStage ?? (() => undefined);
    const cancelled = opts.cancelled ?? (() => false);
    const at = new Date(deps.now()).toISOString();
    let failedAt = "";
    let error = "";
    let audioControl = "";

    // WebGPU check runs while recording.
    const gpuPromise = opts.device === "wasm" ? Promise.resolve<WebGpuInfo>({ available: false, detail: "not checked (wasm chosen)" }) : deps.detectWebGpu();

    const recorder = new PcmRecorder();
    const roles = new RoleTally();
    let recordMs = 0;
    const opened = await deps.audioControl(true).catch((e: unknown) => { audioControl = `threw ${String(e).slice(0, 60)}`; return false; });
    if (!audioControl) audioControl = String(opened);
    const recordStart = deps.now();
    if (opened) {
      this.recorder = recorder;
      this.roles = roles;
      try {
        while (!cancelled()) {
          const elapsed = deps.now() - recordStart;
          if (elapsed >= RECORD_MS) break;
          stage({ kind: "recording", secondsLeft: Math.ceil((RECORD_MS - elapsed) / 1000), chunks: recorder.chunkCount });
          await deps.sleep(Math.min(250, RECORD_MS - elapsed));
        }
      } finally {
        recordMs = deps.now() - recordStart;
        this.recorder = null;
        this.roles = null;
        await deps.audioControl(false).catch(() => false);
      }
    } else {
      failedAt = "mic";
      error = `audioControl(true, Glasses) returned ${audioControl}`;
    }
    if (!failedAt && cancelled()) { failedAt = "cancelled"; error = "recording cancelled"; }
    if (!failedAt && recorder.chunkCount === 0) { failedAt = "noAudio"; error = "no audio frames from the glasses microphone"; }

    const samples = recorder.toFloat32();
    const level = levelDbfs(samples);
    const shares = roles.shares();
    const gpu = await gpuPromise;

    let device: Device | "" = "";
    let stats: LoadStats | null = null;
    let reused = false;
    let fallback = "";
    let text = "";
    let transcribeMs: number | null = null;
    let pipe: Transcriber = null;

    if (!failedAt) {
      const first: Device = opts.device === "auto" ? (gpu.available ? "webgpu" : "wasm") : opts.device;
      stage({ kind: "loading", progress: null });
      const onProgress = (p: LoadProgress): void => stage({ kind: "loading", progress: p });
      try {
        const out = await deps.loadWhisper(opts.model, first, opts.wasm, onProgress);
        ({ pipe, stats, reused } = out);
        device = first;
      } catch (e) {
        if (first === "webgpu" && opts.device === "auto") {
          fallback = `webgpu failed: ${String(e).slice(0, 100)}`;
          try {
            const out = await deps.loadWhisper(opts.model, "wasm", opts.wasm, onProgress);
            ({ pipe, stats, reused } = out);
            device = "wasm";
          } catch (e2) {
            failedAt = "load";
            error = String(e2).slice(0, 180);
          }
        } else {
          failedAt = "load";
          error = String(e).slice(0, 180);
        }
      }
    }
    if (!failedAt) {
      stage({ kind: "transcribing", audioSeconds: recorder.audioSeconds });
      try {
        const out = await deps.transcribe(pipe, samples, opts.lang);
        text = out.text;
        transcribeMs = out.ms;
      } catch (e) {
        failedAt = "transcribe";
        error = String(e).slice(0, 180);
      }
    }
    const report = deps.netReport();
    if (failedAt === "load" && report.failures) error = `${error} | fetch: ${report.failures}`.slice(0, 300);

    return {
      at,
      lang: opts.lang,
      model: opts.model,
      deviceWanted: opts.device,
      device,
      dtype: stats?.dtype ?? "",
      webgpu: `${gpu.available ? "yes" : "no"} (${gpu.detail})`,
      cacheApi: deps.cacheApi,
      reused,
      modelBytes: stats?.modelBytes ?? 0,
      netBytes: reused ? 0 : stats?.netBytes ?? 0,
      netFiles: reused ? 0 : stats?.netFiles ?? 0,
      hosts: stats?.hosts || report.hosts,
      fetchMs: reused ? null : stats?.fetchMs ?? null,
      sessionMs: reused ? null : stats?.sessionMs ?? null,
      loadMs: reused ? null : stats?.loadMs ?? null,
      fallback,
      runtime: stats?.runtime ?? opts.wasm,
      audioControl,
      recordMs,
      chunks: recorder.chunkCount,
      firstChunkMs: recorder.firstChunkAt === null ? null : recorder.firstChunkAt - recordStart,
      audioSeconds: Math.round(recorder.audioSeconds * 100) / 100,
      samplesPerSecond: recorder.samplesPerSecond(recordMs),
      rmsDb: level.rms,
      peakDb: level.peak,
      roles: formatShares(shares),
      roleSelf: shares.percent.self,
      roleOther: shares.percent.other,
      roleUnknown: shares.percent.unknown,
      roleMissing: shares.percent.missing,
      transcribeMs,
      rtf: realTimeFactor(transcribeMs, recorder.audioSeconds),
      text,
      failedAt,
      error,
    };
  }
}
