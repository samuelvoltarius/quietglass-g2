import { describe, expect, it } from "vitest";
import { parseTakeCommand } from "../src/voice/take-voice";

const SHOTS = [
  { scene: "1", shot: "A" }, { scene: "1", shot: "B" },
  { scene: "2", shot: "A" }, { scene: "2", shot: "B" },
  { scene: "3", shot: "A" },
];
const DE_NOTES = ["unscharf", "Ton", "Spiel", "Licht", "Anschluss", "super", "(keine)"];
const EN_NOTES = ["out of focus", "sound", "performance", "light", "continuity", "great", "(none)"];

describe("take voice grammar", () => {
  it("jumps to scene and shot and logs OK with a note", () => {
    expect(parseTakeCommand("Szene 2 B OK unscharf", SHOTS, 0, DE_NOTES)).toEqual({ index: 3, status: "OK", note: "unscharf" });
  });

  it("understands spoken numbers and the word 'Shot'", () => {
    expect(parseTakeCommand("Szene zwei Shot A passt", SHOTS, 0, DE_NOTES)).toEqual({ index: 2, status: "OK", note: "" });
  });

  it("a short 'NG nochmal' logs NG on the current shot", () => {
    expect(parseTakeCommand("NG, nochmal", SHOTS, 4, DE_NOTES)).toEqual({ index: null, status: "NG", note: "" });
  });

  it("'nicht ok' is NG even though it contains 'ok'", () => {
    expect(parseTakeCommand("das war nicht ok, Ton", SHOTS, 1, DE_NOTES)).toEqual({ index: null, status: "NG", note: "Ton" });
  });

  it("next and previous move without logging", () => {
    expect(parseTakeCommand("nächster", SHOTS, 4, DE_NOTES)).toEqual({ index: 0, status: null, note: "" });
    expect(parseTakeCommand("zurück", SHOTS, 0, DE_NOTES)).toEqual({ index: 4, status: null, note: "" });
  });

  it("understands English", () => {
    expect(parseTakeCommand("scene 3 shot A good, great", SHOTS, 0, EN_NOTES)).toEqual({ index: 4, status: "OK", note: "great" });
    expect(parseTakeCommand("no good, out of focus", SHOTS, 2, EN_NOTES)).toEqual({ index: null, status: "NG", note: "out of focus" });
  });

  it("an unknown scene leaves the position alone", () => {
    expect(parseTakeCommand("Szene 9 OK", SHOTS, 1, DE_NOTES).index).toBeNull();
  });

  it("returns nothing for silence or an empty shot list", () => {
    expect(parseTakeCommand("", SHOTS, 0, DE_NOTES)).toEqual({ index: null, status: null, note: "" });
    expect(parseTakeCommand("OK", [], 0, DE_NOTES)).toEqual({ index: null, status: null, note: "" });
  });
});
