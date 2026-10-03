import { describe, expect, it } from "vitest";
import { joinPcm, parseReply, wrap } from "../src/assistant/audio";
describe("assistant transport", () => {
  it("joins PCM without gaps", () => { expect([...joinPcm([new Uint8Array([1, 2]), new Uint8Array([3])])]).toEqual([1, 2, 3]); });
  it("validates replies", () => { expect(parseReply({ answer: "Hallo", actions: ["Licht"] }).actions).toEqual(["Licht"]); });
  it("wraps readable lines", () => { expect(wrap("eins zwei drei vier", 9)).toEqual(["eins zwei", "drei vier"]); });
});
