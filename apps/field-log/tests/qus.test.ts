import { describe, expect, it } from "vitest";
import {
  clockLabel, cockpitCells, cockpitHint, cockpitModel, headlineFor, lastNoteAt, modelKey, notesToday, pcmLevel, pushLevel, quantizeLevel,
  syncCell, LEVEL_HISTORY, type CockpitInput, type CockpitModel,
} from "../src/cockpit/model";
import { cellBoxes, composeCockpit } from "../src/cockpit/compose";
import { createFrame, frameKey, tiles, type Frame } from "../src/screen/frame";
import { createTileSender, tileSlots } from "../src/screen/sender";
import { pixelBackend } from "../src/screen/text";
import { addEntry, attachToLatest, startInspection, type Inspection } from "../src/log/entries";
import { newestFirst, noteRow, notesView, pickView, readPages, readView, startRows, startView } from "../src/glasses/view";
import { TABS, bannerFor, isFirstRun, nowInner, pillOf, setupInner, summarize } from "../src/ui/phone";
import { EMPTY_DATA, upsertInspection, type FieldLogData } from "../src/storage/persist";

// QUS v1: the pure parts of the cockpit and the lists - cells, headline, start rows, footer text, tile diff.
const NOW = new Date(2026, 9, 17, 14, 5).getTime();
const at = (h: number, m: number): number => new Date(2026, 9, 17, h, m).getTime();
const backend = pixelBackend();

function walk(): Inspection {
  let inspection = startInspection("i1", "Hotel", at(13, 0));
  inspection = addEntry(inspection, "Fensterdichtung beschädigt", "major", at(13, 20));
  inspection = addEntry(inspection, "Lampe flackert", "minor", at(13, 40));
  inspection = addEntry(inspection, "Rauchmelder getestet", "note", at(14, 2));
  return inspection;
}

function input(extra: Partial<CockpitInput> = {}): CockpitInput {
  const active = walk();
  return {
    phase: "idle", inspections: [active], active, now: NOW, locale: "de", severity: "note", voice: true, demo: false,
    status: "idle", live: "off", notice: null, elapsedMs: 0, lastLengthMs: null, levels: [], ...extra,
  };
}
const model = (extra: Partial<CockpitInput> = {}): CockpitModel => cockpitModel(input(extra));

describe("cockpit headline", () => {
  it("says BEREIT when resting, AUFNAHME m:ss while recording, WIRD ERKANNT while the text is made", () => {
    expect(model().headline).toEqual(["BEREIT"]);
    expect(model({ phase: "recording", elapsedMs: 42_000 }).headline).toEqual(["AUFNAHME 0:42"]);
    expect(model({ phase: "recording", elapsedMs: 75_400 }).headline).toEqual(["AUFNAHME 1:15"]);
    expect(model({ phase: "transcribing" }).headline).toEqual(["WIRD ERKANNT"]);
    expect(model({ phase: "recording", elapsedMs: 42_000, locale: "en" }).headline).toEqual(["RECORDING 0:42"]);
    expect(model({ locale: "en" }).headline).toEqual(["READY"]);
  });

  it("a notice or a server error takes the place of BEREIT, never of a running recording", () => {
    expect(headlineFor({ ...input({ notice: "micDenied" }) })).toEqual(["MIKRO GESPERRT"]);
    expect(model({ notice: "heardNothing" }).headline).toEqual(["NICHTS VERSTANDEN"]);
    expect(model({ notice: "noPhoto" }).headline).toEqual(["KEIN FOTO"]);
    expect(model({ status: "error" }).headline).toEqual(["SERVER FEHLER"]);
    expect(model({ status: "error", voice: false }).headline).toEqual(["BEREIT"]);
    expect(model({ phase: "recording", elapsedMs: 1000, notice: "micDenied" }).headline).toEqual(["AUFNAHME 0:01"]);
  });

  it("formats the clock as m:ss", () => {
    expect([0, 999, 1000, 59_999, 60_000, 600_000].map(clockLabel)).toEqual(["0:00", "0:00", "0:01", "0:59", "1:00", "10:00"]);
  });
});

describe("cockpit cells", () => {
  it("shows notes today, the time of the last one, the sync source and the length", () => {
    const cells = cockpitCells(input());
    expect(cells.map((cell) => cell.label)).toEqual(["HEUTE", "LETZTE", "SYNC", "LÄNGE"]);
    expect(cells.map((cell) => cell.value)).toEqual(["3", "14:02", "Server", "–"]);
    expect(cockpitCells(input({ locale: "en" })).map((cell) => cell.label)).toEqual(["TODAY", "LAST", "SYNC", "LENGTH"]);
  });

  it("counts only today's notes, over every walk", () => {
    const old = addEntry(startInspection("i0", "Gestern", at(9, 0) - 86_400_000), "alt", "note", at(9, 0) - 86_400_000);
    expect(notesToday([old, walk()], NOW)).toBe(3);
    expect(lastNoteAt([old, walk()])).toBe(at(14, 2));
    expect(lastNoteAt([])).toBeNull();
    expect(cockpitCells(input({ inspections: [], active: null }))[0]!.value).toBe("0");
    expect(cockpitCells(input({ inspections: [], active: null }))[1]!.value).toBe("–");
  });

  it("the length is the running recording, then the last one", () => {
    expect(cockpitCells(input({ phase: "recording", elapsedMs: 42_000 }))[3]!.value).toBe("0:42");
    expect(cockpitCells(input({ lastLengthMs: 65_000 }))[3]!.value).toBe("1:05");
  });

  it("SYNC tells where the words come from and frames a problem", () => {
    const sync = (extra: Partial<CockpitInput>) => syncCell({ ...input(extra) });
    expect(sync({ voice: false }).value).toBe("lokal");
    expect(sync({ demo: true }).value).toBe("Demo");
    expect(sync({ phase: "recording", live: "live" }).value).toBe("Live");
    expect(sync({ phase: "recording", live: "connecting" }).value).toBe("…");
    expect(sync({ phase: "recording", live: "lost" })).toMatchObject({ value: "Datei", alert: true });
    expect(sync({ status: "error" })).toMatchObject({ value: "Fehler", alert: true });
    expect(sync({ locale: "en", voice: false }).value).toBe("local");
  });
});

describe("cockpit graphic, caption and hint", () => {
  it("rests as a ring of the walk's notes (one segment per note, by type), recording as the level history", () => {
    const rest = model();
    expect(rest.graphic).toMatchObject({ kind: "ring", center: "3", sub: "RUNDGANG", segments: ["critical", "warn", "ok"] });
    const rec = model({ phase: "recording", elapsedMs: 3000, levels: [0, 0.5, 1] });
    expect(rec.graphic).toMatchObject({ kind: "wave", levels: [0, 0.5, 1] });
    expect(model({ phase: "transcribing" }).graphic).toMatchObject({ kind: "ring", center: "…" });
  });

  it("the caption names the type of the next entry; the hint lists only gestures that work", () => {
    expect(model({ severity: "major" }).caption).toBe("Art: WICHTIG");
    expect(model().hint).toBe("Tippen = sprechen · 2× = zurück");
    expect(model({ phase: "recording", elapsedMs: 1 }).hint).toBe("Tippen = fertig");
    expect(cockpitHint({ phase: "transcribing", locale: "de", status: "connecting", voice: true })).toBe("verbinde …");
    expect(model({ locale: "en" }).hint).toBe("Tap = record · 2× = back");
  });

  it("measures a microphone block's level, quantised so the picture changes only when it really moves", () => {
    expect(pcmLevel(new Uint8Array(64))).toBe(0);
    const loud = new Uint8Array(64); new DataView(loud.buffer).setInt16(0, 20000, true);
    for (let i = 0; i < 32; i += 1) new DataView(loud.buffer).setInt16(i * 2, i % 2 ? 20000 : -20000, true);
    expect(pcmLevel(loud)).toBeGreaterThan(0.9);
    expect(quantizeLevel(0.49)).toBe(quantizeLevel(0.5));
    expect(quantizeLevel(2)).toBe(1);
    let levels: number[] = [];
    for (let i = 0; i < LEVEL_HISTORY + 5; i += 1) levels = pushLevel(levels, 1);
    expect(levels).toHaveLength(LEVEL_HISTORY);
  });
});

describe("start list (at most three entries)", () => {
  it("record, notes (only when there are some), type", () => {
    expect(startRows(0).map((row) => row.kind)).toEqual(["record", "type"]);
    expect(startRows(4).map((row) => row.kind)).toEqual(["record", "notes", "type"]);
    expect(startRows(400).length).toBeLessThanOrEqual(3);
  });

  it("marks the selection with a dot and names the action in the footer", () => {
    const options = { locale: "de" as const, voice: true, demo: false, severity: "minor" as const, entryCount: 4 };
    const first = startView(0, options);
    expect(first.header).toBe("FIELDLOG · ● live");
    expect(first.body).toEqual(["● Aufnehmen", "  Notizen · 4", "  Art · Mangel"]);
    expect(first.footer).toBe("Tippen = sprechen · Wischen = wählen · 2× = Ende");
    expect(startView(1, options).footer).toBe("Tippen = öffnen · Wischen = wählen · 2× = Ende");
    expect(startView(2, options).footer).toBe("Tippen = Art ändern · Wischen = wählen · 2× = Ende");
    // Without a speech server the first row is the quick note and the header says local; demo says demo.
    const quick = startView(0, { ...options, voice: false });
    expect(quick.header).toBe("FIELDLOG · lokal");
    expect(quick.body[0]).toBe("● Schnellnotiz");
    expect(startView(0, { ...options, demo: true }).header).toBe("FIELDLOG · Demo");
    expect(startView(0, { ...options, locale: "en" }).body).toEqual(["● Record", "  Notes · 4", "  Type · minor"]);
  });
});

describe("notes list and reading view", () => {
  const many = (): Inspection => {
    let inspection = startInspection("i", "Walk", at(8, 0));
    for (let i = 0; i < 9; i += 1) inspection = addEntry(inspection, `Eintrag ${i + 1}`, i === 4 ? "major" : "note", at(9, i));
    return inspection;
  };

  it("lists the newest first, five rows at most, a dot on the selection, the list follows the cursor", () => {
    const list = many();
    expect(newestFirst(list)[0]!.text).toBe("Eintrag 9");
    const top = notesView(list, 0, "de", true, false);
    expect(top.body).toHaveLength(5);
    expect(top.body[0]).toBe("● 09:08 Eintrag 9");
    expect(top.body.filter((row) => row.startsWith("●"))).toHaveLength(1);
    expect(top.header).toBe("Notizen · ● live");
    const deep = notesView(list, 8, "de", true, false);
    expect(deep.body).toHaveLength(5);
    expect(deep.body.at(-1)).toBe("● 09:00 Eintrag 1");
    expect(top.body.join("\n")).toContain("! ");
  });

  it("a row marks important notes and photos and is cut to one line", () => {
    let list = addEntry(startInspection("i", "W", 0), "x".repeat(200), "major", at(10, 5));
    list = attachToLatest(list, { dataUri: "d", mimeType: "image/jpeg", size: 1 });
    const row = noteRow(list.entries[0]!, true, "de");
    expect(row.length).toBeLessThanOrEqual(56);
    expect(row.startsWith("● 10:05 ! ")).toBe(true);
    expect(row.endsWith("…")).toBe(true);
  });

  it("the reading view has a context header and pages for a long note", () => {
    const list = addEntry(startInspection("i", "W", 0), "Wort ".repeat(120), "minor", at(10, 5));
    const first = readView(list, 0, 0, "de");
    expect(first.header).toBe("Notiz 1/1 · 10:05 · Mangel 1/2");
    expect(first.body.length).toBeLessThanOrEqual(6);
    expect(first.footer).toBe("Tippen = nächste · Wischen = blättern · 2× = zurück");
    expect(readPages("Wort ".repeat(120)).length).toBe(2);
    const short = readView(many(), 2, 0, "de");
    expect(short.header).toBe("Notiz 3/9 · 09:06 · Notiz");
    expect(short.body).toEqual(["Eintrag 7"]);
    expect(short.footer).toBe("Tippen = nächste · 2× = zurück");
  });

  it("the quick-note list shows five rows with a dot, the cancel row last", () => {
    const view = pickView({ locale: "de", severity: "note", quickNotes: ["a", "b", "c", "d", "e", "f", "g"], pickIndex: 7 });
    expect(view.body).toHaveLength(5);
    expect(view.body.at(-1)).toBe("● Abbrechen");
  });
});

describe("tile diff", () => {
  const frameOf = (extra: Partial<CockpitInput> = {}): Frame => composeCockpit(model(extra), backend);
  const tileKeys = (frame: Frame): string[] => tiles(frame).map(frameKey);
  const changedTiles = (a: Frame, b: Frame): number[] => {
    const before = tileKeys(a); const after = tileKeys(b);
    return before.map((key, index) => (key === after[index] ? -1 : index)).filter((index) => index >= 0);
  };

  it("an unchanged state draws the same frame, tile for tile", () => {
    expect(tileKeys(frameOf())).toEqual(tileKeys(frameOf()));
    expect(modelKey(model())).toBe(modelKey(model()));
    expect(tileKeys(frameOf({ phase: "recording", elapsedMs: 5000, levels: [0.5, 1] }))).toEqual(tileKeys(frameOf({ phase: "recording", elapsedMs: 5000, levels: [0.5, 1] })));
  });

  it("the clock alone changes only the top right tile", () => {
    expect(changedTiles(frameOf(), frameOf({ now: NOW + 60_000 }))).toEqual([1]);
  });

  it("a new level changes the left half and the length counter changes the right, nothing else moves", () => {
    const base = { phase: "recording" as const, elapsedMs: 5000, levels: [0.5] };
    // Same second, louder: only the left tiles.
    expect(changedTiles(frameOf(base), frameOf({ ...base, levels: [0.5, 1] })).every((index) => index === 0 || index === 2)).toBe(true);
    // The next second: the headline (top right) and the LÄNGE cell (bottom right) change.
    const next = changedTiles(frameOf(base), frameOf({ ...base, elapsedMs: 6000 }));
    expect(next).toContain(1);
    expect(next.every((index) => index === 1 || index === 3)).toBe(true);
  });

  it("the sender sends all four tiles once, then nothing for an identical frame, then only what changed", async () => {
    const sent: string[] = [];
    const sender = createTileSender(tileSlots(21, "t"), async (slot) => { sent.push(slot.name); return true; }, () => new Uint8Array(1));
    await sender.push(frameOf());
    expect(sent).toEqual(["t-nw", "t-ne", "t-sw", "t-se"]);
    await sender.push(frameOf());
    expect(sent).toHaveLength(4);
    await sender.push(frameOf({ now: NOW + 60_000 }));
    expect(sent.slice(4)).toEqual(["t-ne"]);
    // A rebuilt page starts blank: everything goes out again.
    sender.reset();
    await sender.push(frameOf({ now: NOW + 60_000 }));
    expect(sent).toHaveLength(9);
    expect(sender.sent()).toBe(9);
  });

  it("lays the four cells out in two rows inside the right half", () => {
    const boxes = cellBoxes(model().cells);
    expect(boxes.map((box) => [box.x > 288, box.y])).toEqual([[true, 118], [true, 118], [true, 118], [true, 174]]);
    expect(boxes.every((box) => box.x + box.width <= 576)).toBe(true);
    expect(frameOf().pixels.some((level) => level > 0)).toBe(true);
    expect(createFrame().pixels.some((level) => level > 0)).toBe(false);
  });
});

describe("phone view models", () => {
  const withWalk = (): FieldLogData => ({ ...upsertInspection(EMPTY_DATA, walk()), activeId: "i1" });

  it("has exactly three tabs, Jetzt / Notizen / Einstellungen", () => {
    expect(TABS.map((tab) => tab.id)).toEqual(["now", "notes", "settings"]);
  });

  it("the hero value is the notes of today, the stats are the types of the walk and its photos", () => {
    let data = withWalk();
    data = upsertInspection(data, attachToLatest(data.inspections[0]!, { dataUri: "d", mimeType: "image/jpeg", size: 1 }));
    expect(summarize(data, NOW)).toEqual({ today: 3, walk: 3, major: 1, minor: 1, note: 1, photos: 1, lastAt: at(14, 2) });
    const html = nowInner(data, { locale: "de", canPhoto: true, now: NOW });
    expect(html).toContain("Notizen heute");
    expect(html).toContain("<strong>3</strong>");
    expect(html.match(/<button/g)).toHaveLength(2);
    expect(html).toContain('id="photo"');
    expect(html).toContain('class="strip"');
    expect(html.match(/class="host note-card/g)).toHaveLength(3);
    expect(html.match(/<b>/g)!.length).toBeGreaterThanOrEqual(4);
  });

  it("without a walk the one button starts it; the banner and the pill say what counts", () => {
    const html = nowInner(EMPTY_DATA, { locale: "de", canPhoto: true, now: NOW });
    expect(html).toContain('id="start"');
    expect(html).not.toContain('id="photo"');
    expect(bannerFor(EMPTY_DATA, "de").tone).toBe("none");
    expect(bannerFor(withWalk(), "de")).toEqual({ tone: "ok", text: "Rundgang läuft: Hotel" });
    expect(pillOf(EMPTY_DATA, "de")).toEqual({ text: "lokal", on: false });
    expect(pillOf({ ...EMPTY_DATA, sttUrl: "https://stt.test" }, "de")).toEqual({ text: "● live", on: true });
  });

  it("the first-run checklist has three steps and ticks them off", () => {
    expect(isFirstRun(EMPTY_DATA)).toBe(true);
    expect(isFirstRun(withWalk())).toBe(false);
    const none = setupInner(EMPTY_DATA, "de");
    expect(none.match(/<li/g)).toHaveLength(3);
    expect(none).not.toContain("✓");
    expect(setupInner(withWalk(), "de").match(/✓/g)).toHaveLength(2);
    expect(setupInner({ ...withWalk(), sttUrl: "https://stt.test" }, "de").match(/✓/g)).toHaveLength(3);
  });
});
