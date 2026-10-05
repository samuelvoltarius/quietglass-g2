import { describe, expect, it } from "vitest";
import {
  AgentNarrator, SentenceBuffer, sanitizeForSpeech, type SpeechEngine,
} from "../src/speech/narrator";
import { parseEvent } from "../src/terminal/types";

class FakeSpeechEngine implements SpeechEngine {
  readonly available = true;
  readonly spoken: string[] = [];
  paused = false;
  voices() { return [{ name: "Test Voice", lang: "en-US" }]; }
  speak(request: Parameters<SpeechEngine["speak"]>[0]): void {
    this.spoken.push(request.text);
    request.onStart();
    request.onEnd();
  }
  cancel(): void { this.spoken.length = 0; }
  pause(): void { this.paused = true; }
  resume(): void { this.paused = false; }
}

const preferences = () => ({
  spokenOutput: true,
  speechLanguage: "en-US",
  speechVoice: "Test Voice",
  speechRate: 1,
});

describe("safe spoken text", () => {
  it("omits code, links and token-looking values", () => {
    const input = "Done. ```sh\nrm -rf /tmp/x\n``` Visit https://example.com and use sk-test_12345678901234567890.";
    const spoken = sanitizeForSpeech(input);
    expect(spoken).toContain("Done");
    expect(spoken).toContain("Code block omitted");
    expect(spoken).toContain("link omitted");
    expect(spoken).toContain("sensitive value omitted");
    expect(spoken).not.toContain("rm -rf");
    expect(spoken).not.toContain("example.com");
  });

  it("keeps link labels but not their destination", () => {
    expect(sanitizeForSpeech("Read [the guide](https://example.com/secret)."))
      .toBe("Read the guide.");
  });
});

describe("stream sentence buffering", () => {
  it("waits for a sentence boundary instead of reading tokens", () => {
    const buffer = new SentenceBuffer();
    expect(buffer.append("I am check")).toEqual([]);
    expect(buffer.append("ing this. Next ")).toEqual(["I am checking this."]);
    expect(buffer.finish()).toEqual(["Next"]);
  });

  it("does not repeat a final full message after deltas", () => {
    const buffer = new SentenceBuffer();
    expect(buffer.append("Done. ")).toEqual(["Done."]);
    expect(buffer.replace("Done. ")).toEqual([]);
    expect(buffer.finish()).toEqual([]);
  });
});

describe("agent narrator", () => {
  it("requires explicit activation before speaking", () => {
    const engine = new FakeSpeechEngine();
    const narrator = new AgentNarrator(engine, preferences);
    narrator.accept(parseEvent({ type: "text", text: "Before activation." }));
    expect(engine.spoken).toEqual([]);
    expect(narrator.status()).toBe("needs-activation");

    expect(narrator.activate()).toBe(true);
    expect(engine.spoken).toEqual(["Spoken output ready."]);
  });

  it("speaks completed prose and a safe permission alert", () => {
    const engine = new FakeSpeechEngine();
    const narrator = new AgentNarrator(engine, preferences);
    narrator.activate();
    narrator.accept(parseEvent({ type: "text_delta", text: "The tests pass. " }));
    narrator.accept(parseEvent({
      type: "permission_request", tool: "Bash", input: { command: "secret command" },
    }));
    expect(engine.spoken).toContain("The tests pass.");
    expect(engine.spoken).toContain("Permission required for Bash. Check the glasses.");
    expect(engine.spoken.join(" ")).not.toContain("secret command");
  });

  it("replays the last safe prose on demand", () => {
    const engine = new FakeSpeechEngine();
    const narrator = new AgentNarrator(engine, preferences);
    narrator.activate();
    narrator.remember("A useful answer.");
    narrator.replay();
    expect(engine.spoken.at(-1)).toBe("A useful answer.");
  });
});
