import { afterEach, describe, expect, it, vi } from "vitest";
import { availableCommands, duration, parseStatus, progressBar } from "../src/printer/status";
import { ApiError, createClient, createDemoPrinter, validateBridgeUrl } from "../src/printer/client";
import { parseSettings } from "../src/storage/persist";

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

describe("bridge status", () => {
  it("reads an online status and clamps nonsense", () => {
    const status = parseStatus({
      online: true, state: "printing", file: "a\nb.gcode", progress: 140, layer: "12", layers: 180,
      minutesLeft: -5, nozzle: { now: 219.6, target: 220 }, bed: null, speed: "x", message: 7, controllable: true,
    });
    expect(status).toEqual({
      online: true, state: "printing", file: "a b.gcode", progress: 100, layer: 12, layers: 180,
      minutesLeft: 0, nozzle: { now: 220, target: 220 }, bed: null, speed: 100, message: "", controllable: true,
    });
  });

  it("anything unreadable is offline, with a known reason or 'unknown'", () => {
    expect(parseStatus(null)).toEqual({ online: false, reason: "unknown", nextScanSeconds: null, controllable: false });
    expect(parseStatus({ online: false, reason: "no-printer", nextScanSeconds: 30 })).toMatchObject({ reason: "no-printer", nextScanSeconds: 30 });
    expect(parseStatus({ online: true, state: "<script>" })).toMatchObject({ online: true, state: "unknown" });
  });

  it("offers only the commands that make sense, cancel last, and none without permission", () => {
    const with_ = (patch: Record<string, unknown>) => parseStatus({ online: true, state: "printing", controllable: true, ...patch });
    expect(availableCommands(with_({}))).toEqual(["pause", "cancel"]);
    expect(availableCommands(with_({ state: "paused" }))).toEqual(["resume", "cancel"]);
    expect(availableCommands(with_({ state: "complete" }))).toEqual([]);
    expect(availableCommands(with_({ controllable: false }))).toEqual([]);
    expect(availableCommands(parseStatus({ online: false, controllable: true }))).toEqual([]);
    expect(availableCommands(null)).toEqual([]);
  });

  it("formats time and progress with drawable glyphs", () => {
    expect(duration(null)).toBe("–");
    expect(duration(42)).toBe("42 min");
    expect(duration(65)).toBe("1 h 05 min");
    expect(progressBar(50, 10)).toBe("●●●●●○○○○○");
    expect(progressBar(150, 4)).toBe("●●●●");
  });
});

describe("bridge client", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("sends the token as a header and the command in the body", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => json({ ok: true }));
    await createClient({ baseUrl: "https://b.example/", token: "tok", fetchImpl }).command("pause");
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://b.example/api/printer/cmd");
    expect((init?.headers as Record<string, string>)["Authorization"]).toBe("Bearer tok");
    expect(init?.body).toBe(JSON.stringify({ command: "pause" }));
  });

  it("maps failures to short codes, including a refused command", async () => {
    const code = async (reply: () => Promise<Response>): Promise<string> =>
      createClient({ baseUrl: "https://b.example", fetchImpl: reply }).command("cancel").then(() => "ok", (e: ApiError) => e.code);
    expect(await code(async () => json({ ok: false, error: "control-off" }, 403))).toBe("refused");
    expect(await code(async () => json({ error: "unauthorized" }, 401))).toBe("auth");
    expect(await code(async () => json({ ok: false, error: "printer-error" }, 502))).toBe("http");
    expect(await code(async () => { throw new TypeError("Failed to fetch"); })).toBe("unreachable");
    expect(await code(async () => json({ ok: true }))).toBe("ok");
  });

  it("gives up after the timeout", async () => {
    vi.useFakeTimers();
    const hang: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
    const pending = createClient({ baseUrl: "https://b.example", fetchImpl: hang, timeoutMs: 500 }).status().catch((e: ApiError) => e.code);
    await vi.advanceTimersByTimeAsync(501);
    expect(await pending).toBe("timeout");
  });

  it("validates the bridge address and stored settings", () => {
    expect(validateBridgeUrl("https://b.example").valid).toBe(true);
    expect(validateBridgeUrl("ftp://b").errors).toEqual(["p.err.urlScheme"]);
    expect(validateBridgeUrl("https://u:p@b.example").errors).toEqual(["p.err.urlCredentials"]);
    expect(parseSettings(JSON.stringify({ bridgeUrl: "javascript:x", invertScroll: true }))).toEqual({ bridgeUrl: "", invertScroll: true });
  });

  it("the demo printer pauses, resumes and cancels", async () => {
    let now = 0;
    const printer = createDemoPrinter(() => now);
    expect((await printer.status())).toMatchObject({ online: true, state: "printing", controllable: true });
    await printer.command("pause");
    now += 60_000;
    expect((await printer.status())).toMatchObject({ state: "paused" });
    await printer.command("resume");
    expect((await printer.status())).toMatchObject({ state: "printing" });
    await printer.command("cancel");
    expect((await printer.status())).toMatchObject({ state: "cancelled" });
  });
});
