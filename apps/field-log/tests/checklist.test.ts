import { describe, expect, it } from "vitest";
import {
  checklistProgress, checklistText, exportWarning, firstOpenItem, firstOpenRoom, itemDone, parseChecklist,
  roomProgress, setCheck, templateText, warningSummary, type Checklist,
} from "../src/checklist/checklist";
import { afterAnswer, tapOk, walkStart, walkSwipe } from "../src/checklist/walk";
import { CONFIRM_WINDOW_MS } from "../src/input/confirm";
import { addEntry, attachToLatest, startInspection, toCsv, toMarkdown, type Inspection } from "../src/log/entries";
import { parseData } from "../src/storage/persist";
import {
  FOOTER_WIDTH, HEADER_WIDTH, LINE_WIDTH, MAX_BODY_ROWS, itemView, pickView, roomsView, startRows, startView,
} from "../src/glasses/view";
import { locales } from "../src/i18n";
import { quickNotes } from "../src/messages";

const PHOTO = { dataUri: "data:image/jpeg;base64,AA", mimeType: "image/jpeg", size: 2048 };

const TEXT = `# Küche
Herd sauber
! Gashahn zu
Fenster dicht [foto]

# Bad
- [ ] Fliesen
* ! Zähler abgelesen 📷`;

function walkWith(text = TEXT): Inspection {
  return { ...startInspection("i1", "Übergabe Top 3", 0), checklist: parseChecklist(text, "de") };
}

function list(inspection: Inspection): Checklist {
  if (!inspection.checklist) throw new Error("no checklist");
  return inspection.checklist;
}

describe("checklist text syntax", () => {
  it("reads rooms, items, critical marks and photo markers", () => {
    const checklist = parseChecklist(TEXT, "de");
    expect(checklist.rooms.map((room) => room.name)).toEqual(["Küche", "Bad"]);
    expect(checklist.rooms[0]!.items.map((item) => [item.text, item.critical, item.photo])).toEqual([
      ["Herd sauber", false, false],
      ["Gashahn zu", true, false],
      ["Fenster dicht", false, true],
    ]);
    // List bullets and task boxes are dropped, "!" after a bullet still counts, 📷 works like [foto].
    expect(checklist.rooms[1]!.items.map((item) => [item.text, item.critical, item.photo])).toEqual([
      ["Fliesen", false, false],
      ["Zähler abgelesen", true, true],
    ]);
  });

  it("accepts [photo] and [Foto] anywhere, ignores empty lines and empty rooms, puts loose items into General", () => {
    const checklist = parseChecklist("Keys [Photo] handed over\n\n# Empty\n#\n# Garage\n[photo]\n!\nDoor", "en");
    expect(checklist.rooms.map((room) => room.name)).toEqual(["General", "Garage"]);
    expect(checklist.rooms[0]!.items[0]).toMatchObject({ text: "Keys handed over", photo: true, critical: false });
    expect(checklist.rooms[1]!.items.map((item) => item.text)).toEqual(["Door"]);
    expect(parseChecklist("Schlüssel", "de").rooms[0]!.name).toBe("Allgemein");
    expect(parseChecklist("", "de").rooms).toEqual([]);
  });

  it("gives stable ids (room + text), numbering duplicates, so an edit keeps the ticks", () => {
    const first = parseChecklist("# Bad\nFliesen\nFliesen", "de");
    expect(first.rooms[0]!.items.map((item) => item.id)).toEqual(["Bad/Fliesen", "Bad/Fliesen#2"]);
    let walk: Inspection = { ...startInspection("i", "x", 0), checklist: parseChecklist("# Bad\nFliesen\nWC", "de") };
    walk = setCheck(walk, "Bad/Fliesen", "ok", 1);
    walk = { ...walk, checklist: parseChecklist("# Bad\nWC\nFliesen\nDusche", "de") };
    expect(roomProgress(walk, list(walk).rooms[0]!)).toMatchObject({ done: 1, total: 3 });
  });

  it("writes the text back so that parsing it again gives the same checklist", () => {
    for (const locale of locales) {
      for (const id of ["flat", "car"] as const) {
        const checklist = parseChecklist(templateText(id, locale), locale);
        expect(checklist.rooms.length).toBeGreaterThan(2);
        expect(parseChecklist(checklistText(checklist, locale), locale)).toEqual(checklist);
      }
    }
    expect(checklistText(parseChecklist(TEXT, "de"), "de")).toContain("! Zähler abgelesen [foto]");
  });

  it("ships two templates in both languages with critical and photo items", () => {
    for (const locale of locales) {
      for (const id of ["flat", "car"] as const) {
        const items = parseChecklist(templateText(id, locale), locale).rooms.flatMap((room) => room.items);
        expect(items.some((item) => item.critical)).toBe(true);
        expect(items.some((item) => item.photo)).toBe(true);
      }
    }
  });
});

describe("progress counting", () => {
  it("counts an item as done when it is checked and, where required, has a photo", () => {
    let walk = walkWith();
    const [kitchen] = list(walk).rooms;
    expect(roomProgress(walk, kitchen!)).toEqual({ done: 0, total: 3, missingPhotos: 1, criticalOpen: 1, defects: 0 });
    walk = setCheck(walk, "Küche/Herd sauber", "ok", 1);
    walk = setCheck(walk, "Küche/Fenster dicht", "ok", 2);
    // OK but without the required photo: still open.
    expect(itemDone(walk, kitchen!.items[2]!)).toBe(false);
    expect(roomProgress(walk, kitchen!)).toMatchObject({ done: 1, missingPhotos: 1, criticalOpen: 1 });
    walk = attachToLatest(addEntry(walk, "Fenster dicht: Foto", "note", 3, { section: "Küche", itemId: "Küche/Fenster dicht" }), PHOTO);
    expect(roomProgress(walk, kitchen!)).toMatchObject({ done: 2, missingPhotos: 0 });
    walk = setCheck(walk, "Küche/Gashahn zu", "defect", 4);
    expect(roomProgress(walk, kitchen!)).toEqual({ done: 3, total: 3, missingPhotos: 0, criticalOpen: 0, defects: 1 });
    expect(checklistProgress(walk)).toMatchObject({ done: 3, total: 5, missingPhotos: 1, criticalOpen: 1 });
  });

  it("a photo attached to an item's defect entry counts for the item", () => {
    let walk = walkWith();
    walk = addEntry(walk, "Zähler abgelesen: Fehlt", "major", 1, { section: "Bad", itemId: "Bad/Zähler abgelesen" });
    walk = attachToLatest(walk, PHOTO);
    expect(roomProgress(walk, list(walk).rooms[1]!).missingPhotos).toBe(0);
  });

  it("picks up where something is left: first open room, first open item", () => {
    let walk = walkWith();
    expect(firstOpenRoom(walk)).toBe(0);
    walk = setCheck(setCheck(walk, "Küche/Herd sauber", "ok", 1), "Küche/Gashahn zu", "ok", 2);
    expect(firstOpenItem(walk, list(walk).rooms[0]!)).toBe(2);
    walk = attachToLatest(addEntry(setCheck(walk, "Küche/Fenster dicht", "ok", 3), "Foto", "note", 4, { section: "Küche", itemId: "Küche/Fenster dicht" }), PHOTO);
    expect(firstOpenRoom(walk)).toBe(1);
    expect(firstOpenItem(walk, list(walk).rooms[0]!)).toBe(0);
  });
});

describe("export warning", () => {
  it("names rooms without a required photo and open critical items", () => {
    const walk = walkWith();
    const warning = exportWarning(walk);
    expect(warning).toEqual({
      roomsWithoutPhoto: ["Küche", "Bad"],
      criticalOpen: [{ room: "Küche", item: "Gashahn zu" }, { room: "Bad", item: "Zähler abgelesen" }],
    });
    expect(warningSummary(warning!, "de")).toBe("2 Räume ohne Pflichtfoto, 2 kritische Punkte offen");
    expect(warningSummary(warning!, "en")).toBe("2 rooms without a required photo, 2 critical items open");
  });

  it("uses the singular, leaves out what is fine, and is null when nothing is open", () => {
    let walk = walkWith("# Küche\n! Gashahn zu\nFenster [foto]");
    walk = setCheck(walk, "Küche/Gashahn zu", "ok", 1);
    expect(warningSummary(exportWarning(walk)!, "de")).toBe("1 Raum ohne Pflichtfoto");
    walk = attachToLatest(addEntry(walk, "Fenster: Foto", "note", 2, { section: "Küche", itemId: "Küche/Fenster" }), PHOTO);
    expect(exportWarning(walk)).toBeNull();
    const critical = walkWith("# Flur\n! Rauchmelder\n! Tür");
    expect(warningSummary(exportWarning(setCheck(critical, "Flur/Tür", "defect", 1))!, "de")).toBe("1 kritischer Punkt offen");
    // A free-form walk never warns.
    expect(exportWarning(startInspection("i", "frei", 0))).toBeNull();
  });
});

describe("walking a room (second tap on critical items)", () => {
  const room = parseChecklist(TEXT, "de").rooms[0]!;

  it("a swipe moves OK -> Defect -> next item and back, wrapping inside the room", () => {
    let cursor = walkStart();
    const seen: string[] = [];
    for (let i = 0; i < 7; i++) { seen.push(cursor.item + ":" + cursor.choice); cursor = walkSwipe(room, cursor, 1); }
    expect(seen).toEqual(["0:0", "0:1", "1:0", "1:1", "2:0", "2:1", "0:0"]);
    expect(walkSwipe(room, walkStart(), -1)).toEqual({ item: 2, choice: 1 });
  });

  it("OK on a plain item is confirmed at once", () => {
    expect(tapOk(room.items[0]!, null, 1000)).toEqual({ confirmed: true, pending: null });
  });

  it("OK on a critical item is armed by the first tap and confirmed by a second within 4 s", () => {
    const critical = room.items[1]!;
    const first = tapOk(critical, null, 1000);
    expect(first.confirmed).toBe(false);
    expect(first.pending).toEqual({ kind: "ok:Küche/Gashahn zu", until: 1000 + CONFIRM_WINDOW_MS });
    expect(tapOk(critical, first.pending, 1000 + CONFIRM_WINDOW_MS)).toEqual({ confirmed: true, pending: null });
  });

  it("a second tap too late, or one armed for another item, only arms again", () => {
    const critical = room.items[1]!;
    const first = tapOk(critical, null, 1000);
    const late = tapOk(critical, first.pending, 1000 + CONFIRM_WINDOW_MS + 1);
    expect(late.confirmed).toBe(false);
    const other = tapOk(critical, { kind: "ok:Bad/Zähler abgelesen", until: 99_999 }, 2000);
    expect(other.confirmed).toBe(false);
  });

  it("after an answer the walk goes to the next item, and to the overview at the end of the room", () => {
    expect(afterAnswer(room, walkStart(0))).toEqual(walkStart(1));
    expect(afterAnswer(room, walkStart(2))).toBeNull();
  });
});

describe("export grouped by room", () => {
  function sample(): Inspection {
    let walk = walkWith();
    walk = setCheck(walk, "Küche/Herd sauber", "ok", 1);
    walk = addEntry(walk, "Gashahn zu: Beschädigt", "major", new Date(2026, 9, 25, 9, 16).getTime(), { section: "Küche", itemId: "Küche/Gashahn zu" });
    walk = attachToLatest(setCheck(walk, "Küche/Gashahn zu", "defect", 2), PHOTO);
    walk = addEntry({ ...walk, section: "Keller" }, "Licht flackert", "minor", new Date(2026, 9, 25, 9, 30).getTime());
    return walk;
  }

  it("lists every room with its progress, every item with state, flags, defects and photos", () => {
    const md = toMarkdown(sample(), false, "de");
    expect(md).toContain("Checkliste: 2/5 erledigt");
    expect(md).toContain("## Küche (2/3)\n\n- OK — Herd sauber\n- **MANGEL** — Gashahn zu (kritisch)\n  - [09:16] **WICHTIG** — Gashahn zu: Beschädigt\n    (Foto angehängt, 2 kB)\n- **OFFEN** — Fenster dicht (Pflichtfoto fehlt)");
    expect(md).toContain("## Bad (0/2)\n\n- **OFFEN** — Fliesen\n- **OFFEN** — Zähler abgelesen (kritisch, Pflichtfoto fehlt)");
    // Notes outside the checklist follow, grouped by section.
    expect(md).toContain("## Weitere Notizen\n\n### Keller\n\n- [09:30] *Mangel* — Licht flackert");
    expect(md.indexOf("## Küche")).toBeLessThan(md.indexOf("## Bad"));
    expect(md.indexOf("## Bad")).toBeLessThan(md.indexOf("## Weitere Notizen"));
    // A defect is listed once, under its item.
    expect(md.match(/Gashahn zu: Beschädigt/g)).toHaveLength(1);
  });

  it("embeds photos under the item with images on, and keeps English labels in English", () => {
    expect(toMarkdown(sample(), true, "de")).toContain("    ![Foto](data:image/jpeg;base64,AA)");
    const en = toMarkdown(sample(), false, "en");
    expect(en).toContain("Checklist: 2/5 done");
    expect(en).toContain("- **DEFECT** — Gashahn zu (critical)");
    expect(en).toContain("(required photo missing)");
  });

  it("leaves a free-form walk exactly as before", () => {
    const walk = addEntry({ ...startInspection("i", "Frei", 0), section: "Küche" }, "Riss", "minor", new Date(2026, 9, 25, 10, 0).getTime());
    const md = toMarkdown(walk, false, "de");
    expect(md).not.toContain("Checkliste");
    expect(md).toContain("## Küche\n\n- [10:00] *Mangel* — Riss\n");
  });

  it("CSV keeps one row per note, the room as the section", () => {
    const csv = toCsv(sample(), "de");
    expect(csv.split("\n")[1]).toContain(",Küche,Wichtig,Gashahn zu: Beschädigt,ja");
  });
});

describe("storage", () => {
  it("keeps checklist and ticks across a save, drops malformed parts, and loads old walks unchanged", () => {
    const walk = setCheck(walkWith(), "Küche/Herd sauber", "ok", 5);
    const loaded = parseData(JSON.stringify({ inspections: [walk], activeId: "i1" }));
    expect(loaded.inspections[0]!.checklist).toEqual(walk.checklist);
    expect(loaded.inspections[0]!.checks).toEqual({ "Küche/Herd sauber": { status: "ok", at: 5 } });
    const broken = parseData(JSON.stringify({ inspections: [{ ...walk, checklist: { rooms: [{ name: 1 }, { name: "Bad", items: [{ id: "x" }] }] }, checks: { a: { status: "maybe", at: 1 } } }] }));
    expect(broken.inspections[0]!.checklist).toBeUndefined();
    expect(broken.inspections[0]!.checks).toBeUndefined();
    const old = parseData(JSON.stringify({ inspections: [{ id: "i9", title: "Alt", startedAt: 1, finishedAt: null, entries: [], section: "" }] }));
    expect(old.inspections[0]).toEqual({ id: "i9", title: "Alt", startedAt: 1, finishedAt: null, entries: [], section: "" });
  });
});

describe("glasses screens of the checklist", () => {
  it("start list: the checklist first, no type row, still at most three entries", () => {
    expect(startRows(0, { done: 0, total: 5 }).map((row) => row.kind)).toEqual(["checklist", "record"]);
    expect(startRows(4, { done: 1, total: 5 }).map((row) => row.kind)).toEqual(["checklist", "record", "notes"]);
    expect(startRows(4).map((row) => row.kind)).toEqual(["record", "notes", "type"]);
    const view = startView(0, { locale: "de", voice: false, demo: false, severity: "note", entryCount: 0, checklist: { done: 3, total: 30 } });
    expect(view.body).toEqual(["● Checkliste · 3/30", "  Schnellnotiz"]);
    expect(view.footer).toBe("Tippen = öffnen · Wischen = wählen · 2× = Ende");
  });

  it("room overview: `Küche 5/7 · 1 [Foto] fehlt`", () => {
    let walk = walkWith();
    walk = setCheck(walk, "Küche/Herd sauber", "ok", 1);
    const view = roomsView(walk, 0, "de");
    expect(view.header).toBe("Checkliste · 1/5");
    expect(view.body).toEqual(["● Küche 1/3 · 1 [Foto] fehlt · 1 ! offen", "  Bad 0/2 · 1 [Foto] fehlt · 1 ! offen"]);
    expect(view.footer).toBe("Tippen = öffnen · Wischen = wählen · 2× = zurück");
  });

  it("item: room header, the item, its state, the photo it needs, OK / Mangel, armed state", () => {
    const walk = walkWith();
    const room = list(walk).rooms[0]!;
    const plain = itemView(walk, room, walkStart(0), false, "de");
    expect(plain.header).toBe("Küche · 1/3");
    expect(plain.body).toEqual(["Herd sauber", "Status: offen", "● OK", "  Mangel"]);
    expect(plain.footer).toBe("Tippen = OK · Wischen = wählen · 2× = zurück");
    const critical = itemView(walk, room, walkStart(1), false, "de");
    expect(critical.header).toBe("Küche · 2/3 · kritisch");
    expect(critical.body[0]).toBe("! Gashahn zu");
    expect(critical.footer).toBe("Tippen = OK (kritisch) · Wischen = wählen · 2× = zurück");
    const armed = itemView(walk, room, walkStart(1), true, "de");
    expect(armed.body).toContain("● SICHER? OK");
    expect(armed.footer).toBe("Nochmal tippen = OK bestätigen · Wischen/2× = abbrechen");
    const photo = itemView(walk, room, { item: 2, choice: 1 }, false, "de");
    expect(photo.body).toEqual(["Fenster dicht", "Status: offen", "[Foto] am Handy", "  OK", "● Mangel"]);
    expect(photo.footer).toBe("Tippen = Mangel wählen · Wischen = wählen · 2× = zurück");
    expect(pickView({ locale: "de", severity: "note", quickNotes: ["Fehlt"], pickIndex: 0, forItem: "Fenster dicht" }).header).toBe("Mangel · Fenster dicht");
  });

  it("every checklist screen fits the display with long names, in both languages", () => {
    const long = "# Badezimmer im Obergeschoss mit Dachschräge und Fenster zum Hof\n! Silikonfugen an der Dusche und Wanne ohne Schimmel, Risse oder Lücken bis zur Decke [foto]\nWC";
    for (const locale of locales) {
      const walk = walkWith(long + "\n" + templateText("flat", locale));
      const rooms = list(walk).rooms;
      const views = [roomsView(walk, 0, locale), roomsView(walk, 99, locale)];
      for (const room of rooms) {
        for (let item = 0; item < room.items.length; item++) {
          for (const choice of [0, 1] as const) for (const armed of [false, true]) views.push(itemView(walk, room, { item, choice }, armed, locale));
        }
      }
      views.push(pickView({ locale, severity: "major", quickNotes: quickNotes(locale, []), pickIndex: 0, forItem: rooms[0]!.items[0]!.text }));
      views.push(startView(0, { locale, voice: true, demo: false, severity: "major", entryCount: 999, checklist: { done: 999, total: 999 } }));
      for (const view of views) {
        expect(view.body.length, view.header).toBeLessThanOrEqual(MAX_BODY_ROWS);
        for (const row of view.body) expect(row.length, row).toBeLessThanOrEqual(LINE_WIDTH);
        expect(view.header.length, view.header).toBeLessThanOrEqual(HEADER_WIDTH);
        expect(view.footer.length, view.footer).toBeLessThanOrEqual(FOOTER_WIDTH);
        expect(view.footer + view.body.join(" ")).not.toMatch(/Halten|Hold|📷/);
      }
    }
  });
});
