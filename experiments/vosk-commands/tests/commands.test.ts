import { describe, expect, it } from "vitest";
import { levenshtein, matchCommand, normalise, phraseScore, tokens, voskGrammar, wordSimilarity, type CommandDef } from "../src/commands";

const COMMANDS: readonly CommandDef[] = [
  { id: "light.kitchen.on", phrases: ["licht küche an", "küchenlicht an"] },
  { id: "light.kitchen.off", phrases: ["licht küche aus", "küchenlicht aus"] },
  { id: "light.living.on", phrases: ["licht wohnzimmer an"] },
  { id: "light.living.off", phrases: ["licht wohnzimmer aus"] },
  { id: "music.stop", phrases: ["musik stopp", "musik aus"] },
  { id: "timer.ten", phrases: ["timer zehn minuten"] },
  { id: "next", phrases: ["weiter", "nächste"] },
];

describe("normalise", () => {
  it("folds umlauts, case and punctuation, drops [unk]", () => {
    expect(normalise("Licht KÜCHE aus!")).toBe("licht kueche aus");
    expect(normalise("[unk] straße")).toBe("strasse");
    expect(normalise("  nächste,  bitte ")).toBe("naechste bitte");
  });

  it("drops filler words but keeps command words like 'an'", () => {
    expect(tokens("mach bitte das licht in der küche an")).toEqual(["mach", "licht", "kueche", "an"]);
  });
});

describe("word similarity", () => {
  it("is Levenshtein based", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshtein("", "abc")).toBe(3);
    expect(wordSimilarity("kueche", "kuche")).toBeGreaterThan(0.8);
  });

  it("never lets short words be fuzzy: an is not aus", () => {
    expect(wordSimilarity("an", "aus")).toBe(0);
    expect(wordSimilarity("aus", "aus")).toBe(1);
  });
});

describe("matchCommand", () => {
  const id = (text: string): string | null => matchCommand(text, COMMANDS)?.id ?? null;

  it("matches the exact phrase", () => {
    expect(id("licht küche aus")).toBe("light.kitchen.off");
    expect(matchCommand("licht küche aus", COMMANDS)?.score).toBe(1);
  });

  it("tolerates word order, fillers and articles", () => {
    expect(id("küche licht aus")).toBe("light.kitchen.off");
    expect(id("bitte das licht in der küche aus")).toBe("light.kitchen.off");
    expect(id("äh licht im wohnzimmer an")).toBe("light.living.on");
  });

  it("tolerates small recognition errors and spelling", () => {
    expect(id("licht kueche aus")).toBe("light.kitchen.off");
    expect(id("licht kuche aus")).toBe("light.kitchen.off");
    expect(id("licht wohnzimer aus")).toBe("light.living.off");
    expect(id("musik stop")).toBe("music.stop");
  });

  it("keeps an and aus apart", () => {
    expect(id("licht küche an")).toBe("light.kitchen.on");
    expect(id("licht küche aus")).toBe("light.kitchen.off");
  });

  it("catches compounds said either way", () => {
    expect(id("küchenlicht aus")).toBe("light.kitchen.off");
    expect(id("küchen licht aus")).toBe("light.kitchen.off");
  });

  it("rejects unrelated speech and Vosk's [unk]", () => {
    expect(id("wie wird das wetter morgen")).toBeNull();
    expect(id("[unk]")).toBeNull();
    expect(id("")).toBeNull();
  });

  it("refuses to guess when the room is missing", () => {
    // "licht aus" fits kitchen and living room equally.
    expect(id("licht aus")).toBeNull();
  });

  it("matches single-word commands", () => {
    expect(id("weiter")).toBe("next");
    expect(id("nächste")).toBe("next");
  });

  it("respects a custom threshold", () => {
    expect(matchCommand("licht kuche aus", COMMANDS, { threshold: 0.99 })).toBeNull();
  });

  it("scores missing words lower than extra words", () => {
    const phrase = tokens("licht küche aus");
    expect(phraseScore(tokens("licht küche aus jetzt sofort"), phrase)).toBeGreaterThan(phraseScore(tokens("küche aus"), phrase));
  });
});

describe("voskGrammar", () => {
  it("lists every phrase once, lower case with umlauts, plus [unk]", () => {
    const grammar = JSON.parse(voskGrammar([...COMMANDS, { id: "dup", phrases: ["Licht Küche AN!"] }])) as string[];
    expect(grammar).toContain("licht küche an");
    expect(grammar).toContain("nächste");
    expect(grammar.filter((p) => p === "licht küche an")).toHaveLength(1);
    expect(grammar.at(-1)).toBe("[unk]");
  });
});
