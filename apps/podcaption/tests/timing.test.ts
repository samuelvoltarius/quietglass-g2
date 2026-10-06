import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parsePodcastFeed, readTranscript, transcriptRank, type Caption } from "../src/podcast/parse";
import { captionDelay, createPlayer } from "../src/podcast/player";
import { BODY_ROWS, LINE_WIDTH, captionRows, errorRow } from "../src/podcast/view";

describe("transcript choice", () => {
  it("prefers a timed format over an HTML transcript listed first", () => {
    // Regression: only the first podcast:transcript was read, so an HTML file won over VTT and captions had no timing.
    const xml = `<item><title>Ep</title><podcast:transcript url="https://x.test/t.html" type="text/html"/><podcast:transcript url="https://x.test/t.json" type="application/json"/><podcast:transcript url="https://x.test/t.vtt" type="text/vtt" language="en"/></item>`;
    const [episode] = parsePodcastFeed(xml);
    expect(episode).toMatchObject({ transcriptUrl: "https://x.test/t.vtt", transcriptType: "text/vtt" });
    expect(episode?.transcripts.map((transcript) => transcript.type)).toEqual(["text/vtt", "application/json", "text/html"]);
  });
  it("ranks VTT, SRT, JSON, captions, HTML, then plain text", () => {
    const ranks = [{ type: "text/plain" }, { type: "text/html" }, { type: "text/plain", rel: "captions" }, { type: "application/json" }, { type: "application/x-subrip" }, { type: "text/vtt; charset=utf-8" }].map(transcriptRank);
    expect(ranks).toEqual([5, 4, 3, 2, 1, 0]);
  });
  it("keeps feed order between equal formats and reads rel", () => {
    const xml = `<item><title>Ep</title><podcast:transcript url='a.srt' type='application/srt'/><podcast:transcript url="b.srt" type="application/x-subrip" rel="captions"></podcast:transcript></item>`;
    expect(parsePodcastFeed(xml)[0]?.transcripts).toEqual([{ url: "a.srt", type: "application/srt" }, { url: "b.srt", type: "application/x-subrip", rel: "captions" }]);
  });
});

describe("readTranscript", () => {
  it("names an empty or unreadable transcript instead of returning nothing", () => {
    // Regression: these only reached console.warn, so the phone and glasses showed no reason.
    expect(() => readTranscript("  ", "text/plain")).toThrow("transcript is empty");
    expect(() => readTranscript("{", "application/json")).toThrow(/^unreadable transcript/);
    expect(readTranscript("WEBVTT\n\n00:01.000 --> 00:02.000\nHi", "text/vtt")).toHaveLength(1);
  });
});

describe("caption timing", () => {
  const timed: Caption[] = [{ start: 0, end: 1.5, text: "a" }, { start: 1.5, end: 9, text: "b" }, { start: 9, end: 10, text: "c" }];
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("derives the step from the next caption's start, and falls back for untimed text", () => {
    expect([captionDelay(timed, 0), captionDelay(timed, 1), captionDelay(timed, 2)]).toEqual([1500, 7500, 4000]);
    expect(captionDelay([{ start: 0, end: 0, text: "x" }, { start: 0, end: 0, text: "y" }], 0)).toBe(4000);
    expect(captionDelay([{ start: 5, end: 6, text: "x" }, { start: 2, end: 3, text: "y" }], 0, 1000)).toBe(1000);
  });

  it("follows the caption timestamps instead of a fixed 4 s beat", () => {
    // Regression: playback advanced every 4 s regardless of the transcript's timing.
    const state = { cursor: 0 };
    const player = createPlayer({ length: () => timed.length, cursor: () => state.cursor, setCursor: (next) => { state.cursor = next; }, onChange: () => undefined, delayMs: (index) => captionDelay(timed, index) });
    player.toggle();
    vi.advanceTimersByTime(1499); expect(state.cursor).toBe(0);
    vi.advanceTimersByTime(1); expect(state.cursor).toBe(1);
    vi.advanceTimersByTime(7000); expect(state.cursor).toBe(1);
    vi.advanceTimersByTime(500); expect([state.cursor, player.playing]).toEqual([2, false]);
  });

  it("re-times after a manual scroll and restarts from the top at the end", () => {
    const state = { cursor: 0 };
    const player = createPlayer({ length: () => timed.length, cursor: () => state.cursor, setCursor: (next) => { state.cursor = next; }, onChange: () => undefined, delayMs: (index) => captionDelay(timed, index) });
    player.toggle(); state.cursor = 1; player.resync();
    vi.advanceTimersByTime(1500); expect(state.cursor).toBe(1);
    vi.advanceTimersByTime(6000); expect(state.cursor).toBe(2);
    player.toggle(); expect([state.cursor, player.playing]).toEqual([0, true]);
    player.stop(); expect(vi.getTimerCount()).toBe(0);
  });
});

describe("error row on the glasses", () => {
  it("cuts a long error to one row and keeps the body within the display", () => {
    const row = errorRow("feed HTTP 503 Service Unavailable from the configured podcast bridge at http://127.0.0.1:8789");
    expect(row.length).toBe(LINE_WIDTH);
    expect(row.startsWith("! feed HTTP 503")).toBe(true);
    expect(row.endsWith("…")).toBe(true);
    const body = [...captionRows("Episode", [{ start: 0, end: 1, text: "word ".repeat(60) }], 0, BODY_ROWS - 1), row];
    expect(body).toHaveLength(BODY_ROWS);
  });
  it("leaves a short error alone", () => { expect(errorRow("transcript\nis empty")).toBe("! transcript is empty"); });
});
