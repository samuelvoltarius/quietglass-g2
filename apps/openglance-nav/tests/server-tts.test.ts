import { afterEach, describe, expect, it, vi } from "vitest";
import { ServerTts, type AudioLike, type BrowserVoice, type TtsLang } from "../src/speech/server-tts";

class FakeAudio implements AudioLike {
  src = "";
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  played: string[] = [];
  paused = 0;
  rejectPlay = false;
  play(): Promise<void> {
    if (this.rejectPlay) return Promise.reject(new Error("NotAllowedError"));
    this.played.push(this.src);
    return Promise.resolve();
  }
  pause(): void { this.paused += 1; }
  /** The clip reaches its end. */
  end(): void { this.onended?.(); }
}

function setup(over: { url?: string; fetchImpl?: typeof fetch; browserAvailable?: boolean; now?: () => number; timeoutMs?: number } = {}) {
  const audio = new FakeAudio();
  const spoken: string[] = [];
  const requests: { voice: string; input: string }[] = [];
  const browser: BrowserVoice = {
    available: over.browserAvailable ?? true,
    speak: (text, _lang: TtsLang, done) => { spoken.push(text); done(); },
    cancel: () => undefined,
  };
  const fetchImpl: typeof fetch = over.fetchImpl ?? ((_url, init) => {
    requests.push(JSON.parse(String(init?.body)) as { voice: string; input: string });
    return Promise.resolve({ ok: true, status: 200, blob: () => Promise.resolve(new Blob([new Uint8Array(200)])) } as Response);
  });
  const tts = new ServerTts(
    { url: over.url ?? "https://tts.example:8459/", voices: { de: "de-DE-thorsten", en: "" }, ...(over.timeoutMs ? { timeoutMs: over.timeoutMs } : {}) },
    { fetch: fetchImpl, createAudio: () => audio, createObjectUrl: () => `blob:${requests.length}-${Math.random()}`, revokeObjectUrl: () => undefined, browser, ...(over.now ? { now: over.now } : {}) },
  );
  return { tts, audio, spoken, requests };
}
const flush = async (): Promise<void> => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };

afterEach(() => { vi.useRealTimers(); });

describe("server voice queue", () => {
  it("asks the server for the German voice and plays announcements one after the other", async () => {
    const { tts, audio, requests } = setup();
    tts.speak("Erste Ansage.");
    tts.speak("Zweite Ansage.");
    await flush();
    expect(requests[0]).toMatchObject({ voice: "de-DE-thorsten", input: "Erste Ansage." });
    expect(audio.played.length).toBe(1);
    audio.end();
    await flush();
    expect(audio.played.length).toBe(2);
    expect(tts.speaking).toBe(true);
    audio.end();
    await flush();
    expect(tts.speaking).toBe(false);
    expect(tts.lastSource).toBe("server");
  });

  it("falls back to the browser voice when the server fails", async () => {
    const { tts, spoken, audio } = setup({ fetchImpl: () => Promise.reject(new Error("offline")) });
    const ended = vi.fn();
    tts.speak("In 200 Metern links.", { onEnd: ended });
    await flush();
    expect(spoken).toEqual(["In 200 Metern links."]);
    expect(audio.played.length).toBe(0);
    expect(ended).toHaveBeenCalledTimes(1);
    expect(tts.lastSource).toBe("browser");
  });

  it("gives up on a hanging server after the timeout", async () => {
    vi.useFakeTimers();
    const hang: typeof fetch = (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
    const { tts, spoken } = setup({ fetchImpl: hang, timeoutMs: 8000 });
    tts.speak("Nächster Halt.");
    await vi.advanceTimersByTimeAsync(7900);
    expect(spoken).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(spoken).toEqual(["Nächster Halt."]);
  });

  it("uses the browser voice when the audio may not start (no tap yet)", async () => {
    const { tts, audio, spoken } = setup();
    audio.rejectPlay = true;
    tts.speak("Hallo.");
    await flush();
    expect(spoken).toEqual(["Hallo."]);
  });

  it("a more important announcement drops queued ones and interrupts the playing one", async () => {
    const { tts, audio, requests } = setup();
    const ends: string[] = [];
    tts.speak("In 200 Metern links.", { priority: 1, onEnd: () => ends.push("200") });
    tts.speak("Dann rechts.", { priority: 1, onEnd: () => ends.push("dann") });
    await flush();
    expect(audio.played.length).toBe(1);
    tts.speak("Jetzt links abbiegen.", { priority: 2, onEnd: () => ends.push("jetzt") });
    await flush();
    expect(ends).toContain("dann");
    expect(audio.paused).toBeGreaterThan(0);
    expect(audio.played.length).toBe(2);
    expect(requests.map((r) => r.input)).toContain("Jetzt links abbiegen.");
    audio.end();
    await flush();
    expect(ends.sort()).toEqual(["200", "dann", "jetzt"]);
    expect(tts.speaking).toBe(false);
  });

  it("an equal priority never drops anything (spoken answers keep their order)", async () => {
    const { tts, audio, requests } = setup();
    for (const s of ["Eins.", "Zwei.", "Drei."]) tts.speak(s);
    await flush();
    audio.end(); await flush();
    audio.end(); await flush();
    expect(audio.played.length).toBe(3);
    expect(requests.map((r) => r.input)).toEqual(["Eins.", "Zwei.", "Drei."]);
  });

  it("a newer announcement with the same key replaces the queued one", async () => {
    const { tts, audio, requests } = setup();
    tts.speak("Läuft.");
    tts.speak("In 200 m.", { key: "turn-1" });
    tts.speak("In 100 m.", { key: "turn-1" });
    await flush();
    audio.end(); await flush();
    audio.end(); await flush();
    expect(audio.played.length).toBe(2);
    expect(requests.map((r) => r.input)).toContain("In 100 m.");
  });

  it("does not play an announcement that waited too long", async () => {
    let t = 0;
    const { tts, audio, spoken } = setup({ now: () => t });
    const ended = vi.fn();
    tts.speak("Lang.");
    tts.speak("Veraltet.", { maxAgeMs: 10_000, onEnd: ended });
    await flush();
    t = 20_000;
    audio.end();
    await flush();
    expect(audio.played.length).toBe(1);
    expect(spoken).toEqual([]);
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it("stops asking a server that failed twice, for a minute", async () => {
    let t = 0;
    const calls = vi.fn(() => Promise.reject(new Error("down")));
    const { tts, spoken } = setup({ fetchImpl: calls as unknown as typeof fetch, now: () => t });
    tts.speak("A."); await flush();
    tts.speak("B."); await flush();
    expect(calls).toHaveBeenCalledTimes(2);
    tts.speak("C."); await flush();
    expect(calls).toHaveBeenCalledTimes(2);
    expect(spoken).toEqual(["A.", "B.", "C."]);
    t = 61_000;
    tts.speak("D."); await flush();
    expect(calls).toHaveBeenCalledTimes(3);
  });

  it("speaks English with the browser voice when no English server voice exists", async () => {
    const { tts, spoken, requests } = setup();
    tts.speak("Turn left.", { lang: "en" });
    await flush();
    expect(requests).toEqual([]);
    expect(spoken).toEqual(["Turn left."]);
  });

  it("without a server address only the browser voice speaks", async () => {
    const { tts, spoken, requests } = setup({ url: "" });
    expect(tts.configured).toBe(false);
    tts.speak("Hallo.");
    await flush();
    expect(requests).toEqual([]);
    expect(spoken).toEqual(["Hallo."]);
  });

  it("stop() silences everything and reports the end of each announcement once", async () => {
    const { tts, audio } = setup();
    const a = vi.fn(); const b = vi.fn();
    tts.speak("Eins.", { onEnd: a });
    tts.speak("Zwei.", { onEnd: b });
    await flush();
    tts.stop();
    await flush();
    expect(audio.paused).toBeGreaterThan(0);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(tts.speaking).toBe(false);
  });

  it("unlock() plays a silent clip once from a tap", () => {
    const { tts, audio } = setup();
    expect(tts.unlocked).toBe(false);
    expect(tts.unlock()).toBe(true);
    expect(tts.unlocked).toBe(true);
    expect(audio.played.length).toBe(1);
    tts.unlock();
    expect(audio.played.length).toBe(1);
  });
});
