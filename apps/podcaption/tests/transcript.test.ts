import { describe, expect, it } from "vitest";
import { chunkText, demoCaptions, parsePodcastFeed, parseTranscript } from "../src/podcast/parse";

describe("parsePodcastFeed", () => {
  it("decodes numeric entities in titles", () => {
    // Regression: WordPress feeds write "Don&#8217;t" and it reached the glasses verbatim.
    const xml = `<item><title>Don&#8217;t panic &#x26; carry on</title><podcast:transcript url="https://x.test/a.vtt" type="text/vtt"/></item>`;
    expect(parsePodcastFeed(xml)[0]?.title).toBe("Don’t panic & carry on");
  });
  it("decodes &amp; exactly once", () => {
    // Regression: "&amp;lt;" was decoded twice into "<".
    const xml = `<item><title>A &amp;lt; B</title><podcast:transcript url="https://x.test/a?x=1&amp;y=2"/></item>`;
    expect(parsePodcastFeed(xml)[0]).toMatchObject({ title: "A &lt; B", transcriptUrl: "https://x.test/a?x=1&y=2" });
  });
  it("reads CDATA titles, single-quoted attributes and defaults the type", () => {
    const xml = `<item><title><![CDATA[Ep <1>]]></title><podcast:transcript url='https://x.test/t.txt'></podcast:transcript></item>`;
    expect(parsePodcastFeed(xml)[0]).toMatchObject({ title: "Ep <1>", transcriptUrl: "https://x.test/t.txt", transcriptType: "text/plain" });
  });
  it("skips items without a transcript and keeps feed order", () => {
    const xml = `<rss><item><title>No transcript</title></item><item><title>Two</title><podcast:transcript url="u2" type="application/json"/></item><item><title>Three</title><podcast:transcript url="u3"/></item></rss>`;
    expect(parsePodcastFeed(xml).map((episode) => episode.title)).toEqual(["Two", "Three"]);
  });
  it("leaves unknown entities alone", () => {
    expect(parsePodcastFeed(`<item><title>&bogus; &#0;</title><podcast:transcript url="u"/></item>`)[0]?.title).toBe("&bogus; &#0;");
  });
});

describe("parseTranscript: WebVTT and SRT", () => {
  it("reads hours, settings, cue ids and multi-line cues", () => {
    const vtt = "WEBVTT - podcast\n\nintro\n01:00:02.500 --> 01:00:04.000 align:start\n<v Ana>Hello</v>\nthere\n\nNOTE skip me\n\n00:05.000 --> 00:06.000\nBye";
    expect(parseTranscript(vtt)).toEqual([{ start: 3602.5, end: 3604, text: "Hello there" }, { start: 5, end: 6, text: "Bye" }]);
  });
  it("reads SRT with commas and CRLF line ends", () => {
    const srt = "1\r\n00:00:01,000 --> 00:00:02,500\r\nOne\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nTwo &amp; three\r\n";
    expect(parseTranscript(srt, "application/srt")).toEqual([{ start: 1, end: 2.5, text: "One" }, { start: 3, end: 4, text: "Two & three" }]);
  });
  it("tolerates a byte-order mark and drops empty cues", () => {
    expect(parseTranscript("﻿WEBVTT\n\n00:01.000 --> 00:02.000\n<b></b>\n\n00:03.000 --> 00:04.000\nKept")).toEqual([{ start: 3, end: 4, text: "Kept" }]);
  });
  it("falls back to zero for unreadable timestamps", () => {
    expect(parseTranscript("WEBVTT\n\nxx --> yy\nText")[0]).toMatchObject({ start: 0, end: 0 });
  });
});

describe("parseTranscript: untimed text", () => {
  it("splits a plain-text episode into caption-sized pieces", () => {
    // Regression: a whole .txt transcript became one caption that could neither fit nor scroll.
    const text = Array.from({ length: 40 }, (_, index) => `Sentence number ${index} is here.`).join(" ");
    const captions = parseTranscript(text, "text/plain");
    expect(captions.length).toBeGreaterThan(5);
    expect(captions.every((caption) => caption.text.length <= 92)).toBe(true);
    expect(captions.map((caption) => caption.text).join(" ")).toBe(text);
  });
  it("strips HTML transcripts to text and chunks them", () => {
    const captions = parseTranscript("<html><style>p{}</style><script>x()</script><p>Hello&nbsp;world.</p><p>Bye.</p></html>", "text/html");
    expect(captions.map((caption) => caption.text).join(" ")).toBe("Hello world. Bye.");
  });
  it("returns nothing for an empty file", () => {
    expect(parseTranscript("   ", "text/plain")).toEqual([]);
  });
});

describe("parseTranscript: JSON", () => {
  it("keeps segment times and falls back to the start for a missing end", () => {
    const json = JSON.stringify({ segments: [{ startTime: 1.5, body: " Hi " }, { startTime: "3", endTime: 4, body: "Yo" }] });
    expect(parseTranscript(json, "application/json")).toEqual([{ start: 1.5, end: 1.5, text: "Hi" }, { start: 3, end: 4, text: "Yo" }]);
  });
  it("never produces NaN times", () => {
    // Regression: startTime "abc" became NaN and the glasses showed "NaN:NaN".
    const json = JSON.stringify({ segments: [{ startTime: "abc", endTime: null, body: "Hi" }] });
    expect(parseTranscript(json, "application/json")).toEqual([{ start: 0, end: 0, text: "Hi" }]);
  });
  it("survives null roots, null segments and empty bodies", () => {
    // Regression: JSON "null" or a null segment threw a TypeError.
    expect(parseTranscript("null", "application/json")).toEqual([]);
    expect(parseTranscript(JSON.stringify({ segments: [null, { body: "  " }, { body: 7 }] }), "application/json")).toEqual([]);
  });
  it("rejects malformed JSON so the caller can report it", () => {
    expect(() => parseTranscript("{", "application/json")).toThrow();
  });
});

describe("chunkText", () => {
  it("prefers sentence ends", () => { expect(chunkText("One two. Three four. Five.", 12)).toEqual(["One two.", "Three four.", "Five."]); });
  it("cuts a word longer than the budget", () => { expect(chunkText("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]); });
});

describe("demoCaptions", () => {
  it("is chronological and non-overlapping", () => {
    const demo = demoCaptions();
    expect(demo.every((caption, index) => caption.end > caption.start && (index === 0 || caption.start >= demo[index - 1]!.end))).toBe(true);
  });
});
