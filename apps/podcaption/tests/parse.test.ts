import { describe, expect, it } from "vitest";
import { parsePodcastFeed, parseTranscript } from "../src/podcast/parse";
describe("podcast parsing", () => {
  it("finds Podcasting 2.0 transcripts", () => { const xml = `<rss><channel><item><title>Episode One</title><podcast:transcript url="https://x.test/one.vtt" type="text/vtt" /></item></channel></rss>`; expect(parsePodcastFeed(xml)[0]).toMatchObject({ title: "Episode One", transcriptType: "text/vtt" }); });
  it("parses WebVTT", () => { const captions = parseTranscript("WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello world", "text/vtt"); expect(captions[0]).toMatchObject({ start: 1, text: "Hello world" }); });
  it("parses transcript JSON", () => { const captions = parseTranscript(JSON.stringify({ segments: [{ startTime: 1, endTime: 2, body: "Hello" }] }), "application/json"); expect(captions[0]?.text).toBe("Hello"); });
});
