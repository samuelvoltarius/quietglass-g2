import { describe, it, expect, vi } from "vitest";
import {
  applyTranscript, applyTranslation, createBuffer, isFollowingLive, visibleLines, wrap,
} from "../src/captions/buffer";
import { parseTranscript, reconnectDelay, createMockStt } from "../src/stt/provider";
import {
  createHttpTranslator, createMockTranslator, createPassthroughTranslator, describeError,
} from "../src/translate/provider";

const partial = (text: string) => ({ text, final: false });
const final = (text: string) => ({ text, final: true });

describe("caption buffer", () => {
  it("starts empty", () => {
    const buffer = createBuffer();
    expect(buffer.lines).toEqual([]);
    expect(buffer.pending).toBeNull();
  });

  it("replaces the pending line instead of appending, so text does not stutter", () => {
    let buffer = createBuffer();
    buffer = applyTranscript(buffer, partial("the qui"), 1);
    buffer = applyTranscript(buffer, partial("the quick bro"), 2);
    buffer = applyTranscript(buffer, partial("the quick brown fox"), 3);

    expect(buffer.lines).toEqual([]);
    expect(buffer.pending?.text).toBe("the quick brown fox");
  });

  it("commits only on a final transcript", () => {
    let buffer = createBuffer();
    buffer = applyTranscript(buffer, partial("hello wor"), 1);
    buffer = applyTranscript(buffer, final("hello world"), 2);

    expect(buffer.lines.map((l) => l.text)).toEqual(["hello world"]);
    expect(buffer.pending).toBeNull();
  });

  it("clears a pending line when the final result is empty", () => {
    let buffer = applyTranscript(createBuffer(), partial("umm"), 1);
    buffer = applyTranscript(buffer, final("  "), 2);
    expect(buffer.pending).toBeNull();
    expect(buffer.lines).toEqual([]);
  });

  it("ignores empty partials", () => {
    const buffer = createBuffer();
    expect(applyTranscript(buffer, partial("   "), 1)).toBe(buffer);
  });

  it("trims whitespace from captions", () => {
    const buffer = applyTranscript(createBuffer(), final("  spaced  "), 1);
    expect(buffer.lines[0]?.text).toBe("spaced");
  });

  it("bounds history so memory cannot grow without limit", () => {
    let buffer = createBuffer();
    for (let i = 0; i < 20; i++) buffer = applyTranscript(buffer, final("line " + i), i, { keep: 5 });
    expect(buffer.lines).toHaveLength(5);
    expect(buffer.lines[0]?.text).toBe("line 15");
  });
});

describe("translation attachment", () => {
  it("attaches a translation to its source line", () => {
    let buffer = applyTranscript(createBuffer(), final("good morning"), 1);
    buffer = applyTranslation(buffer, "good morning", "guten Morgen");
    expect(buffer.lines[0]?.translated).toBe("guten Morgen");
  });

  it("attaches to the most recent match when a phrase repeats", () => {
    let buffer = applyTranscript(createBuffer(), final("yes"), 1);
    buffer = applyTranscript(buffer, final("yes"), 2);
    buffer = applyTranslation(buffer, "yes", "ja");

    expect(buffer.lines[0]?.translated).toBeUndefined();
    expect(buffer.lines[1]?.translated).toBe("ja");
  });

  it("ignores a translation whose source has scrolled away", () => {
    const buffer = applyTranscript(createBuffer(), final("hello"), 1);
    expect(applyTranslation(buffer, "gone", "weg")).toBe(buffer);
  });
});

describe("visible window", () => {
  const filled = () => {
    let buffer = createBuffer();
    for (let i = 0; i < 10; i++) buffer = applyTranscript(buffer, final("line " + i), i);
    return buffer;
  };

  it("shows the newest lines by default", () => {
    expect(visibleLines(filled(), 3).map((l) => l.text)).toEqual(["line 7", "line 8", "line 9"]);
  });

  it("includes the pending line at the live edge", () => {
    const buffer = applyTranscript(filled(), partial("in progress"), 99);
    expect(visibleLines(buffer, 2).map((l) => l.text)).toEqual(["line 9", "in progress"]);
  });

  it("scrolls back through history", () => {
    expect(visibleLines(filled(), 3, 3).map((l) => l.text)).toEqual(["line 4", "line 5", "line 6"]);
  });

  it("clamps scrolling at the oldest line", () => {
    expect(visibleLines(filled(), 3, 999).map((l) => l.text)).toEqual(["line 0", "line 1", "line 2"]);
  });

  it("knows whether it is following the live edge", () => {
    expect(isFollowingLive(filled(), 3, 0)).toBe(true);
    expect(isFollowingLive(filled(), 3, 4)).toBe(false);
    // Short buffers are always live, regardless of offset.
    expect(isFollowingLive(createBuffer(), 3, 5)).toBe(true);
  });

  it("returns nothing for an empty buffer", () => {
    expect(visibleLines(createBuffer(), 5)).toEqual([]);
  });
});

describe("wrapping", () => {
  it("breaks on word boundaries", () => {
    expect(wrap("aaa bbb ccc", 7)).toEqual(["aaa bbb", "ccc"]);
  });

  it("keeps an over-long word rather than dropping it", () => {
    expect(wrap("donaudampfschifffahrt", 5).join("")).toContain("donaudampfschifffahrt");
  });

  it("returns nothing for blank text", () => {
    expect(wrap("  ", 10)).toEqual([]);
  });
});

describe("STT reply parsing", () => {
  it("reads the common shapes", () => {
    expect(parseTranscript('{"text":"hello","final":true}')).toEqual({ text: "hello", final: true });
    expect(parseTranscript('{"transcript":"hi","is_final":true}')).toMatchObject({ text: "hi", final: true });
    expect(parseTranscript('{"text":"x","type":"final"}')?.final).toBe(true);
  });

  it("treats anything else as non-final", () => {
    expect(parseTranscript('{"text":"partial"}')?.final).toBe(false);
  });

  it("keeps a detected language when present", () => {
    expect(parseTranscript('{"text":"bonjour","final":true,"language":"fr"}')?.language).toBe("fr");
  });

  it("ignores rubbish instead of throwing", () => {
    expect(parseTranscript("not json")).toBeNull();
    expect(parseTranscript('{"nothing":1}')).toBeNull();
    expect(parseTranscript(123)).toBeNull();
  });

  it("backs off between reconnect attempts, with a ceiling", () => {
    expect(reconnectDelay(1)).toBe(500);
    expect(reconnectDelay(2)).toBe(1000);
    expect(reconnectDelay(99)).toBe(10_000);
  });
});

describe("mock providers are clearly mock", () => {
  it("names itself mock and emits fixed text", async () => {
    vi.useFakeTimers();
    const seen: string[] = [];
    const stt = createMockStt({ onTranscript: (t) => seen.push(t.text) });
    expect(stt.name).toBe("mock");

    await stt.start();
    vi.advanceTimersByTime(3100);
    expect(seen[0]).toContain("mock recogniser");
    await stt.stop();
    vi.useRealTimers();
  });

  it("marks translated text as mock output", async () => {
    const result = await createMockTranslator().translate({ text: "hi", from: "en", to: "de" });
    expect(result.text).toBe("[de] hi");
  });
});

describe("HTTP translator", () => {
  it("posts the LibreTranslate body and reads the reply", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ q: "hello", source: "en", target: "de" });
      return new Response(JSON.stringify({ translatedText: "hallo" }), { status: 200 });
    });
    const result = await createHttpTranslator({ url: "https://t/translate", fetchImpl: fetchImpl as never })
      .translate({ text: "hello", from: "en", to: "de" });
    expect(result).toEqual({ text: "hallo", error: null });
  });

  it("skips the request for empty text", async () => {
    const fetchImpl = vi.fn();
    const result = await createHttpTranslator({ url: "https://t", fetchImpl: fetchImpl as never })
      .translate({ text: "   ", from: "en", to: "de" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.error).toBeNull();
  });

  it("reports an HTTP failure without throwing", async () => {
    const fetchImpl = vi.fn(async () => new Response("no", { status: 500 }));
    const result = await createHttpTranslator({ url: "https://t", fetchImpl: fetchImpl as never })
      .translate({ text: "hi", from: "en", to: "de" });
    expect(result.error).toBe("HTTP 500");
  });

  it("describes failures without leaking internals", () => {
    expect(describeError(new TypeError("Failed to fetch"))).toBe("unreachable");
    expect(describeError(new DOMException("x", "AbortError"))).toBe("timed out");
    expect(describeError(null)).toBe("failed");
  });

  it("passes text through when translation is off", async () => {
    const result = await createPassthroughTranslator().translate({ text: "same", from: "en", to: "de" });
    expect(result.text).toBe("same");
  });
});
