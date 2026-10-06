import { describe, it, expect, vi } from "vitest";
import {
  chatCompletionsUrl, cleanLlmOutput, createHttpTranslator, createOpenAiTranslator,
  translationPrompt,
} from "../src/translate/provider";
import { selectTranslator, translationRequestFor } from "../src/translate/select";
import { EMPTY_DATA, type BabelData } from "../src/storage/persist";

const chatReply = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }), { status: 200 });

/** A fetch that never answers on its own, only rejects when aborted. */
const hangingFetch = vi.fn((_url: string, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () =>
      reject(new DOMException("The operation was aborted.", "AbortError")));
  }));

describe("OpenAI-compatible translator", () => {
  it("posts a strict chat-completions request and reads the answer", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      seenUrl = url;
      seenInit = init;
      return chatReply("Guten Tag, wie geht es dir?");
    });
    const translator = createOpenAiTranslator({
      url: "http://spark:8000/v1/", model: "qwen2.5-7b-instruct", fetchImpl: fetchImpl as never,
    });

    const result = await translator.translate({ text: "Добры дзень, як справы?", from: "be", to: "de" });

    expect(result).toEqual({ text: "Guten Tag, wie geht es dir?", error: null });
    expect(seenUrl).toBe("http://spark:8000/v1/chat/completions");
    const body = JSON.parse(String(seenInit?.body));
    expect(body.model).toBe("qwen2.5-7b-instruct");
    expect(body.temperature).toBeLessThanOrEqual(0.2);
    expect(body.stream).toBe(false);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toContain("from Belarusian (be) to German (de)");
    expect(body.messages[0].content).toContain("Output only the German translation");
    expect(body.messages[1]).toEqual({ role: "user", content: "Добры дзень, як справы?" });
    // No token configured: no Authorization header at all.
    expect((seenInit?.headers as Record<string, string>)["Authorization"]).toBeUndefined();
  });

  it("sends the optional bearer token as a header, never in the body", async () => {
    let headers: Record<string, string> = {};
    let body = "";
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      headers = init?.headers as Record<string, string>;
      body = String(init?.body);
      return chatReply("Hallo");
    });
    await createOpenAiTranslator({ url: "https://x/v1", model: "m", apiKey: "sekret", fetchImpl: fetchImpl as never })
      .translate({ text: "Привет", from: "ru", to: "de" });
    expect(headers["Authorization"]).toBe("Bearer sekret");
    expect(body).not.toContain("sekret");
  });

  it("keeps German umlauts and ß intact", async () => {
    const fetchImpl = vi.fn(async () => chatReply("Schöne Grüße aus Weißrussland, Mädchen!"));
    const result = await createOpenAiTranslator({ url: "https://x/v1", model: "m", fetchImpl: fetchImpl as never })
      .translate({ text: "…", from: "be", to: "de" });
    expect(result.text).toBe("Schöne Grüße aus Weißrussland, Mädchen!");
  });

  it("times out instead of hanging", async () => {
    vi.useFakeTimers();
    try {
      const pending = createOpenAiTranslator({
        url: "https://x/v1", model: "m", timeoutMs: 1000, fetchImpl: hangingFetch as never,
      }).translate({ text: "Привет", from: "ru", to: "de" });
      await vi.advanceTimersByTimeAsync(1001);
      expect(await pending).toEqual({ text: "", error: "timed out" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports HTTP errors", async () => {
    const fetchImpl = vi.fn(async () => new Response("model not found", { status: 404 }));
    const result = await createOpenAiTranslator({ url: "https://x/v1", model: "m", fetchImpl: fetchImpl as never })
      .translate({ text: "Привет", from: "ru", to: "de" });
    expect(result).toEqual({ text: "", error: "HTTP 404" });
  });

  it("reports an unreachable server", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    const result = await createOpenAiTranslator({ url: "https://x/v1", model: "m", fetchImpl: fetchImpl as never })
      .translate({ text: "Привет", from: "ru", to: "de" });
    expect(result.error).toBe("unreachable");
  });

  it("survives bad JSON and unexpected shapes", async () => {
    for (const body of ["<html>proxy error</html>", "null", "[]", '{"choices":[]}', '{"choices":[{"message":{}}]}']) {
      const fetchImpl = vi.fn(async () => new Response(body, { status: 200 }));
      const result = await createOpenAiTranslator({ url: "https://x/v1", model: "m", fetchImpl: fetchImpl as never })
        .translate({ text: "Привет", from: "ru", to: "de" });
      expect(result).toEqual({ text: "", error: "unreadable response" });
    }
  });

  it("treats an empty answer as an error rather than a blank caption", async () => {
    const fetchImpl = vi.fn(async () => chatReply("  <think>hmm</think>  "));
    const result = await createOpenAiTranslator({ url: "https://x/v1", model: "m", fetchImpl: fetchImpl as never })
      .translate({ text: "Привет", from: "ru", to: "de" });
    expect(result.error).toBe("empty response");
  });

  it("skips the request for empty text", async () => {
    const fetchImpl = vi.fn();
    const result = await createOpenAiTranslator({ url: "https://x/v1", model: "m", fetchImpl: fetchImpl as never })
      .translate({ text: "  ", from: "ru", to: "de" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.error).toBeNull();
  });

  it("asks for a concrete source language", () => {
    expect(createOpenAiTranslator({ url: "https://x/v1", model: "m" }).needsConcreteSource).toBe(true);
    expect(createHttpTranslator({ url: "https://x" }).needsConcreteSource).toBeFalsy();
  });
});

describe("chat-completions URL", () => {
  it("accepts a base URL or the full endpoint", () => {
    expect(chatCompletionsUrl("http://h:11434/v1")).toBe("http://h:11434/v1/chat/completions");
    expect(chatCompletionsUrl("http://h:11434/v1///")).toBe("http://h:11434/v1/chat/completions");
    expect(chatCompletionsUrl(" http://h:1234/v1/chat/completions ")).toBe("http://h:1234/v1/chat/completions");
  });
});

describe("translation prompt", () => {
  it("names both languages", () => {
    expect(translationPrompt("ru", "de")).toContain("from Russian (ru) to German (de)");
  });

  it("still works for auto and unknown codes", () => {
    expect(translationPrompt("auto", "de")).toContain("whatever language");
    expect(translationPrompt("ka", "de")).toContain("from ka (ka)");
  });
});

describe("cleaning LLM output", () => {
  it("strips quotes, preambles and reasoning", () => {
    expect(cleanLlmOutput('"Guten Morgen."')).toBe("Guten Morgen.");
    expect(cleanLlmOutput("„Guten Morgen.“")).toBe("Guten Morgen.");
    expect(cleanLlmOutput("«Guten Morgen.»")).toBe("Guten Morgen.");
    expect(cleanLlmOutput("Translation: Guten Morgen.")).toBe("Guten Morgen.");
    expect(cleanLlmOutput("Here is the German translation: Guten Morgen.")).toBe("Guten Morgen.");
    expect(cleanLlmOutput("Sure! Here's the translation:\n\nGuten Morgen.")).toBe("Guten Morgen.");
    expect(cleanLlmOutput("Übersetzung: „Guten Morgen.“")).toBe("Guten Morgen.");
    expect(cleanLlmOutput("<think>\nThe user wants German.\n</think>\nGuten Morgen.")).toBe("Guten Morgen.");
    expect(cleanLlmOutput("```\nGuten Morgen.\n```")).toBe("Guten Morgen.");
  });

  it("keeps quotes the speaker actually used", () => {
    expect(cleanLlmOutput("„Nein“, sagte er.", "«Нет», сказал он.")).toBe("„Nein“, sagte er.");
    expect(cleanLlmOutput('"Ja"', '"Да"')).toBe('"Ja"');
  });

  it("leaves ordinary text alone, including umlauts", () => {
    expect(cleanLlmOutput("Größe ändern über Straße")).toBe("Größe ändern über Straße");
    expect(cleanLlmOutput("Die Übersetzung ist schwierig.")).toBe("Die Übersetzung ist schwierig.");
  });

  it("composes decomposed umlauts", () => {
    expect(cleanLlmOutput("Grüße")).toBe("Grüße");
  });
});

describe("LibreTranslate translator robustness", () => {
  it("reports bad JSON as unreadable instead of leaking a parser message", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>502</html>", { status: 200 }));
    const result = await createHttpTranslator({ url: "https://t", fetchImpl: fetchImpl as never })
      .translate({ text: "hi", from: "en", to: "de" });
    expect(result).toEqual({ text: "", error: "unreadable response" });
  });

  it("times out", async () => {
    vi.useFakeTimers();
    try {
      const pending = createHttpTranslator({ url: "https://t", timeoutMs: 500, fetchImpl: hangingFetch as never })
        .translate({ text: "hi", from: "en", to: "de" });
      await vi.advanceTimersByTimeAsync(501);
      expect((await pending).error).toBe("timed out");
    } finally {
      vi.useRealTimers();
    }
  });

  it("still sends the unchanged LibreTranslate body, including auto", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = vi.fn(async (_u: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ translatedText: "Grüß Gott" }), { status: 200 });
    });
    const result = await createHttpTranslator({ url: "https://t", apiKey: "k", fetchImpl: fetchImpl as never })
      .translate({ text: "Привет", from: "auto", to: "de" });
    expect(body).toEqual({ q: "Привет", source: "auto", target: "de", format: "text", api_key: "k" });
    expect(result.text).toBe("Grüß Gott");
  });
});

describe("provider selection", () => {
  const openai: BabelData = {
    ...EMPTY_DATA, translateProvider: "openai", llmUrl: "http://h:11434/v1", llmModel: "m",
    sttUrl: "ws://h:9000", targetLanguage: "de",
  };
  const libre: BabelData = {
    ...EMPTY_DATA, translateUrl: "http://h:5000/translate", sttUrl: "ws://h:9000", targetLanguage: "de",
  };

  it("builds the provider the settings select", () => {
    expect(selectTranslator(openai).name).toBe("openai");
    expect(selectTranslator(libre).name).toBe("http");
    expect(selectTranslator({ ...openai, llmModel: "" }).name).toBe("none");
    expect(selectTranslator({ ...libre, mode: "captionOnly" }).name).toBe("none");
  });

  it("routes to the LLM server when selected", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => chatReply("Hallo"));
    await selectTranslator(openai, fetchImpl as never).translate({ text: "Привет", from: "ru", to: "de" });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://h:11434/v1/chat/completions");
  });
});

describe("source language per caption (auto → detected)", () => {
  const llm = createOpenAiTranslator({ url: "https://x/v1", model: "m" });
  const libre = createHttpTranslator({ url: "https://x" });
  const auto: BabelData = { ...EMPTY_DATA, sourceLanguage: "auto", targetLanguage: "de" };

  it("passes Whisper's detected language to a provider that needs one", () => {
    expect(translationRequestFor(auto, llm, "Прывітанне", "be")).toEqual({ text: "Прывітанне", from: "be", to: "de" });
    expect(translationRequestFor(auto, llm, "Привет", "ru")?.from).toBe("ru");
  });

  it("keeps auto for LibreTranslate, whose behaviour is unchanged", () => {
    expect(translationRequestFor(auto, libre, "Привет", "ru")?.from).toBe("auto");
  });

  it("uses auto when nothing was detected", () => {
    expect(translationRequestFor(auto, llm, "Привет", undefined)?.from).toBe("auto");
    expect(translationRequestFor(auto, llm, "Привет", "auto")?.from).toBe("auto");
  });

  it("lets a fixed source language win over detection", () => {
    // Whisper labelling Belarusian as Russian must not override the user.
    expect(translationRequestFor({ ...auto, sourceLanguage: "be" }, llm, "x", "ru")?.from).toBe("be");
  });

  it("skips captions already in the target language", () => {
    expect(translationRequestFor(auto, llm, "Guten Tag", "de")).toBeNull();
    expect(translationRequestFor({ ...auto, sourceLanguage: "de-AT" }, libre, "Servus", undefined)).toBeNull();
  });
});
