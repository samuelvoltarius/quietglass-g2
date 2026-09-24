import { describe, it, expect } from "vitest";
import { buildView, MODE_PRESETS, statusLabel } from "../src/glasses/view";
import { applyTranscript, applyTranslation, createBuffer } from "../src/captions/buffer";
import {
  parseData, EMPTY_DATA, maskSecret, usesMockStt, translationEnabled,
  validateWsUrl, validateHttpUrl, isPlainHttp,
} from "../src/storage/persist";

const base = {
  mode: "conversation" as const,
  listening: true,
  status: "ready" as const,
  translating: false,
  offset: 0,
  mock: false,
};

const withLine = (text: string) => applyTranscript(createBuffer(), { text, final: true }, 1);

describe("not listening", () => {
  it("says so and never implies it is capturing", () => {
    const view = buildView(createBuffer(), { ...base, listening: false });
    expect(view.body[0]).toBe("Not listening.");
    expect(view.footer).not.toContain("MIC");
  });

  it("names the mock provider when one is in use", () => {
    expect(buildView(createBuffer(), { ...base, listening: false, mock: true }).footer)
      .toContain("mock");
  });
});

describe("listening", () => {
  it("always shows the microphone indicator", () => {
    expect(buildView(createBuffer(), base).footer).toContain("MIC");
  });

  it("marks a mock provider so output is never mistaken for real", () => {
    expect(buildView(withLine("hi"), { ...base, mock: true }).footer).toContain("MOCK");
  });

  it("shows captions", () => {
    expect(buildView(withLine("hello there"), base).body[0]).toBe("hello there");
  });

  it("shows a status line while no captions have arrived", () => {
    expect(buildView(createBuffer(), base).body[0]).toBe("listening…");
  });

  it("surfaces a connection problem rather than looking idle", () => {
    const view = buildView(withLine("x"), { ...base, status: "reconnecting" });
    expect(view.footer).toContain("reconnecting");
  });

  it("marks that the user is reading history", () => {
    let buffer = createBuffer();
    for (let i = 0; i < 20; i++) buffer = applyTranscript(buffer, { text: "l" + i, final: true }, i);
    expect(buildView(buffer, { ...base, offset: 10 }).footer).toContain("history");
  });
});

describe("translation display", () => {
  it("shows the translation with the original beneath it in conversation mode", () => {
    let buffer = withLine("good morning");
    buffer = applyTranslation(buffer, "good morning", "guten Morgen");
    const body = buildView(buffer, { ...base, translating: true }).body;
    expect(body[0]).toBe("guten Morgen");
    expect(body.join(" ")).toContain("good morning");
  });

  it("shows translation only in lecture mode", () => {
    let buffer = withLine("good morning");
    buffer = applyTranslation(buffer, "good morning", "guten Morgen");
    const body = buildView(buffer, { ...base, mode: "lecture", translating: true }).body;
    expect(body[0]).toBe("guten Morgen");
    expect(body.join(" ")).not.toContain("good morning");
  });

  it("falls back to the original while the translation is in flight", () => {
    expect(buildView(withLine("pending"), { ...base, translating: true }).body[0]).toBe("pending");
  });
});

describe("modes", () => {
  it("gives each mode its own shape", () => {
    expect(MODE_PRESETS.travel.rows).toBeLessThan(MODE_PRESETS.lecture.rows);
    expect(MODE_PRESETS.captionOnly.showOriginal).toBe(true);
  });
});

describe("status labels", () => {
  it("names each state in plain words", () => {
    expect(statusLabel("connecting")).toContain("connecting");
    expect(statusLabel("error")).toContain("error");
    expect(statusLabel("idle")).toBe("idle");
  });
});

describe("configuration", () => {
  it("treats an empty speech URL as the mock", () => {
    expect(usesMockStt(EMPTY_DATA)).toBe(true);
    expect(usesMockStt({ ...EMPTY_DATA, sttUrl: "wss://x/asr" })).toBe(false);
  });

  it("enables translation only with an endpoint and outside caption-only mode", () => {
    expect(translationEnabled(EMPTY_DATA)).toBe(false);
    expect(translationEnabled({ ...EMPTY_DATA, translateUrl: "https://t" })).toBe(true);
    expect(translationEnabled({ ...EMPTY_DATA, translateUrl: "https://t", mode: "captionOnly" })).toBe(false);
  });

  it("validates URLs and allows empty ones", () => {
    expect(validateWsUrl("").valid).toBe(true);
    expect(validateWsUrl("wss://x/asr").valid).toBe(true);
    expect(validateWsUrl("https://x").valid).toBe(false);
    expect(validateHttpUrl("https://t/translate").valid).toBe(true);
    expect(validateHttpUrl("ws://t").valid).toBe(false);
  });

  it("flags unencrypted transports", () => {
    expect(isPlainHttp("ws://x")).toBe(true);
    expect(isPlainHttp("wss://x")).toBe(false);
  });

  it("never reveals a secret", () => {
    expect(maskSecret("topsecret")).toBe("set (9 chars)");
    expect(maskSecret("topsecret")).not.toContain("topsecret");
    expect(maskSecret(undefined)).toBe("none");
  });

  it("drops a stored URL that is not usable", () => {
    expect(parseData(JSON.stringify({ sttUrl: "http://wrong" })).sttUrl).toBe("");
  });

  it("falls back cleanly on corrupt data", () => {
    expect(parseData("{nope")).toEqual(EMPTY_DATA);
  });

  it("rejects an unknown mode", () => {
    expect(parseData(JSON.stringify({ mode: "hyperspeed" })).mode).toBe("conversation");
  });
});
