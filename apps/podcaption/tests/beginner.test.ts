import { describe, expect, it } from "vitest";
import { locales, tr } from "../src/i18n";
import { messages } from "../src/messages";
import { failureFor } from "../src/podcast/errors";
import { demoCaptions, readTranscript } from "../src/podcast/parse";
import { BODY_ROWS, LINE_WIDTH, captionRows, errorRow } from "../src/podcast/view";

const vars = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? "").sort();
const ERRORS = ["errEmpty", "errUnreadable", "errNoTranscript", "errTimeout", "errServer", "errOffline", "errPasteEmpty", "errUnknown"];

describe("messages", () => {
  const keys = Object.keys(messages.de).sort();
  it.each(locales)("%s has every key, nothing extra, no blanks", (locale) => {
    expect(Object.keys(messages[locale]).sort()).toEqual(keys);
    for (const key of keys) expect(messages[locale][key]?.trim(), `${locale}.${key}`).toBeTruthy();
  });
  it.each(locales)("%s uses the same placeholders as German", (locale) => {
    for (const key of keys) expect(vars(messages[locale][key] ?? ""), `${locale}.${key}`).toEqual(vars(messages.de[key] ?? ""));
  });
  it.each(locales)("%s glasses header, footer and error rows fit one row", (locale) => {
    expect(tr(messages, locale, "controls").length).toBeLessThanOrEqual(LINE_WIDTH);
    for (const play of ["tagPlay", "tagPause"]) for (const source of ["tagDemo", "tagFile", "tagFeed"]) expect(`PODCAPTION  ${tr(messages, locale, play)}  ${tr(messages, locale, source)}`.length).toBeLessThanOrEqual(LINE_WIDTH);
    for (const key of ERRORS) { const row = errorRow(tr(messages, locale, key, { status: "503" })); expect(row.endsWith("…"), `${locale}.${key}`).toBe(false); expect(row.length).toBeLessThanOrEqual(LINE_WIDTH); }
  });
  it("keeps jargon out of the German main screen", () => {
    const advanced = new Set(["advanced", "bridge", "bridgeHelp", "endpoint", "connect", "tagFeed", "errNoTranscript", "errOffline"]);
    for (const [key, text] of Object.entries(messages.de)) if (!advanced.has(key)) expect(text, key).not.toMatch(/bridge|cors|rss|endpoint|server-adresse|podcast:transcript|demo/i);
  });
  it("names the obvious first step on the phone", () => {
    expect(messages.de.nextDemo).toMatch(/^Öffne unten eine Untertiteldatei/);
  });
});

describe("first run on the glasses", () => {
  it.each(locales)("%s shows a how-to that starts with opening a file on the phone", (locale) => {
    const demo = demoCaptions(["demo1", "demo2", "demo3", "demo4"].map((key) => tr(messages, locale, key)));
    expect(demo.every((caption, index) => caption.end > caption.start && (index === 0 || caption.start >= demo[index - 1]!.end))).toBe(true);
    const rows = captionRows(tr(messages, locale, "demoTitle"), demo, 0);
    expect(rows.length).toBeLessThanOrEqual(BODY_ROWS);
    expect(rows.every((row) => row.length <= LINE_WIDTH)).toBe(true);
    // The second caption — "open a file on your phone" — is on the first screen, not behind a swipe.
    expect(rows.join(" ")).toContain(tr(messages, locale, "demo2").split(" ").slice(0, 3).join(" "));
  });
});

describe("errors in plain words", () => {
  it("maps causes to keys a user can act on", () => {
    expect(failureFor(new Error("transcript is empty"))).toEqual({ key: "errEmpty" });
    expect(failureFor(new Error("unreadable transcript (Unexpected token)"))).toEqual({ key: "errUnreadable" });
    expect(failureFor(new Error("feed has no podcast:transcript"))).toEqual({ key: "errNoTranscript" });
    expect(failureFor(new Error("feed timed out"))).toEqual({ key: "errTimeout" });
    expect(failureFor(new Error("transcript HTTP 403"))).toEqual({ key: "errServer", status: "403" });
    expect(failureFor(new TypeError("Failed to fetch"))).toEqual({ key: "errOffline" });
    expect(failureFor("weird")).toEqual({ key: "errUnknown" });
  });
});

describe("pasted text, the no-file path", () => {
  it("reads pasted WebVTT with timing and plain text without", () => {
    expect(readTranscript("WEBVTT\n\n00:01.000 --> 00:03.000\nHallo", "text/vtt")).toEqual([{ start: 1, end: 3, text: "Hallo" }]);
    expect(readTranscript("Erster Satz. Zweiter Satz.", "text/vtt")[0]?.text).toBe("Erster Satz. Zweiter Satz.");
    expect(() => readTranscript("   ", "text/vtt")).toThrow("transcript is empty");
  });
});
