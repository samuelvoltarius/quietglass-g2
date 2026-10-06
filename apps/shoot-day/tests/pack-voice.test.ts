import { describe, expect, it } from "vitest";
import { matchPackItem, packNorm, parsePackCommand } from "../src/voice/pack-voice";

// A typical crew list; the grammar must find items by their words and the
// usual short forms said on set.
const NAMES = [
  "Sony FX6 (A-Kamera)", "Sony FX3 (B-Kamera)", "Weitwinkel 14-24/2.8", "Zoom 28-135/4",
  "Tele 70-200/2.8", "Festbrennweite 85/1.8", "Polfilter 77 mm", "ND-Filter klein",
  "Drohne + Fernbedienung", "Drohnen-Akkus", "Gimbal (Ronin)", "Videostativ 1",
  "Bohnensack (Fahraufnahmen)", "LED-Panel RGB", "Aufsteckleuchte", "V-Mount-Akku 1",
  "V-Mount-Akku 2", "Tonrecorder", "Richtmikrofon", "Funkstrecke",
  "XLR-Kabel", "Kopfhörer", "Klappe", "Speicherkarten A-Kamera",
  "Speicherkarten B-Kamera", "Kartenleser", "Backup-SSD", "Gaffa", "Putztuch / Blasebalg",
  "Regenschutz", "Wasser / Verpflegung",
];

// [sentence, expected kind, expected part of the item name, expected packed]
const CASES: ReadonlyArray<readonly [string, "item" | "missing" | "all" | "unknown", string | null, boolean | null]> = [
  ["FX6 eingepackt", "item", "FX6", true],
  ["die FX3 ist dabei", "item", "FX3", true],
  ["Gimbal eingepackt", "item", "Gimbal", true],
  ["der Ronin ist drin", "item", "Gimbal", true],
  ["Stativ hab ich", "item", "Videostativ", true],
  ["Bohnensack eingepackt", "item", "Bohnensack", true],
  ["die Klappe ist drin", "item", "Klappe", true],
  ["Richtrohr eingepackt", "item", "Richtmikrofon", true],
  ["Kartenleser dabei", "item", "Kartenleser", true],
  ["Gaffa eingepackt", "item", "Gaffa", true],
  ["Regenschutz fehlt", "item", "Regenschutz", false],
  ["die Drohne brauchen wir nicht", "item", "Drohne + Fernbedienung", false],
  ["Polfilter vergessen", "item", "Polfilter", false],
  ["was fehlt noch", "missing", null, null],
  ["was fehlt", "missing", null, null],
  ["alles eingepackt", "all", null, true],
  ["Kaffee mitnehmen", "unknown", null, null],
  // English, understood alongside German
  ["the gimbal is packed", "item", "Gimbal", true],
  ["rain cover missing", "item", "Regenschutz", false],
  ["what's missing?", "missing", null, null],
  ["everything packed", "all", null, true],
];

describe("packing-list voice grammar", () => {
  for (const [sentence, kind, part, packed] of CASES) {
    it(`"${sentence}" → ${kind}${part ? " " + part : ""}`, () => {
      const command = parsePackCommand(sentence, NAMES);
      expect(command.kind).toBe(kind);
      if (command.kind === "item") {
        expect(NAMES[command.index]?.toLowerCase()).toContain(String(part).toLowerCase());
        expect(command.packed).toBe(packed);
      }
      if (command.kind === "all") expect(command.packed).toBe(packed);
    });
  }

  it("does not match an unrelated sentence to any item", () => {
    expect(matchPackItem("hallo wie geht es dir", NAMES)).toBe(-1);
    expect(matchPackItem("hello how are you", NAMES)).toBe(-1);
  });

  it("says nothing for silence", () => {
    expect(parsePackCommand("   ", NAMES)).toEqual({ kind: "unknown" });
    expect(parsePackCommand("Gimbal eingepackt", [])).toEqual({ kind: "unknown" });
  });

  it("normalises punctuation and case", () => {
    expect(packNorm("  Die FX6, bitte!  ")).toBe("die fx6 bitte");
  });

  it("\"alles … nicht\" resets everything instead of ticking it", () => {
    expect(parsePackCommand("alles wieder raus", NAMES)).toEqual({ kind: "all", packed: false });
  });
});
