import { afterEach, describe, expect, it, vi } from "vitest";
import { mountPhoneUi } from "../src/ui/phone";
import { EMPTY_DATA, upsertInspection, type FieldLogData } from "../src/storage/persist";
import { addEntry, startInspection } from "../src/log/entries";
import { parseChecklist } from "../src/checklist/checklist";

import { fakeRoot } from "./fake-dom";

function mount(initial: FieldLogData, save?: () => Promise<void>) {
  const root = fakeRoot();
  vi.stubGlobal("document", { getElementById: () => root });
  // The page follows the device language; these tests read the English copy.
  vi.stubGlobal("navigator", { language: "en-US" });
  let data = initial;
  const setData = vi.fn(async (next: FieldLogData) => {
    data = next;
    await save?.();
  });
  mountPhoneUi({ getData: () => data, setData });
  return {
    root,
    setData,
    data: () => data,
    /** A change made elsewhere — the glasses filing an entry. */
    external: (next: FieldLogData) => { data = next; },
  };
}

const open = (): FieldLogData => {
  const inspection = startInspection("i1", "Flat 3", 1_000_000);
  return { ...upsertInspection(EMPTY_DATA, inspection), activeId: "i1" };
};

describe("phone page", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("regression: changing the section keeps entries dictated on the glasses meanwhile", () => {
    // The handlers worked on the inspection captured at render time, so the
    // section change wrote back an inspection without the newer entries.
    const page = mount(open());
    const current = page.data().inspections[0]!;
    page.external(upsertInspection(page.data(), addEntry(current, "Window seal damaged", "major", 1_060_000)));

    page.root.get("#section").value = "Kitchen";
    page.root.get("#section").fire("change");

    const saved = page.data().inspections[0]!;
    expect(saved.section).toBe("Kitchen");
    expect(saved.entries.map((e) => e.text)).toEqual(["Window seal damaged"]);
  });

  it("regression: two severity changes in a row both stick", () => {
    let data = open();
    const inspection = addEntry(addEntry(data.inspections[0]!, "one", "note", 1), "two", "note", 2);
    data = upsertInspection(data, inspection);
    const page = mount(data);
    // The list shows the newest first: the first select belongs to "two".
    const [first, second] = page.root.querySelectorAll(".sev");
    first!.value = "major";
    first!.fire("change");
    page.root.querySelectorAll(".sev")[1]!.value = "minor";
    page.root.querySelectorAll(".sev")[1]!.fire("change");
    expect(second).toBeDefined();
    expect(page.data().inspections[0]!.entries.map((e) => e.severity)).toEqual(["minor", "major"]);
  });

  it("regression: a validation message is actually shown", () => {
    const page = mount(EMPTY_DATA);
    page.root.get("#stt").value = "wss://not-http";
    page.root.get("#save-stt").fire("click");
    expect(page.root.innerHTML).toContain("must start with https://");
  });

  it("shows a started inspection straight away", () => {
    const page = mount(EMPTY_DATA);
    page.root.get("#title").value = "Roof survey";
    page.root.get("#start").fire("click");
    expect(page.root.innerHTML).toContain("Roof survey");
    expect(page.root.querySelector("#finish")).not.toBeNull();
  });

  it("keeps a half-typed server address when another setting is committed", () => {
    const page = mount(open());
    page.root.get("#stt").value = "https://half";
    page.root.get("#section").value = "Hall";
    page.root.get("#section").fire("change");
    expect(page.root.get("#stt").value).toBe("https://half");
  });

  it("reports a failed save instead of rejecting unhandled", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const page = mount(open(), async () => { throw new Error("storage full"); });
    page.root.get("#section").value = "Hall";
    page.root.get("#section").fire("change");
    await vi.waitFor(() => expect(page.root.innerHTML).toContain("Could not save"));
  });

  it("escapes a transcript on the page", () => {
    const data = open();
    const page = mount(upsertInspection(data, addEntry(data.inspections[0]!, "<img src=x onerror=alert(1)>", "note", 1)));
    expect(page.root.innerHTML).not.toContain("<img");
  });
});

describe("phone page for beginners", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  function mountIn(language: string, initial: FieldLogData = EMPTY_DATA, takePhoto?: () => Promise<void>) {
    const root = fakeRoot();
    vi.stubGlobal("document", { getElementById: () => root });
    vi.stubGlobal("navigator", { language });
    let data = initial;
    const onLocaleChange = vi.fn();
    const ui = mountPhoneUi({
      getData: () => data,
      setData: async (next) => { data = next; },
      onLocaleChange,
      ...(takePhoto ? { takePhoto } : {}),
    });
    return { root, data: () => data, onLocaleChange, ui, external: (next: FieldLogData) => { data = next; } };
  }

  it("follows the device language and says what to do first", () => {
    const page = mountIn("de-AT");
    expect(page.root.innerHTML).toContain("Kein Rundgang offen.");
    expect(page.root.innerHTML).toContain('<option value="de" selected>');
  });

  it("starts an inspection without a name", () => {
    const page = mountIn("de-AT");
    page.root.get("#start").fire("click");
    expect(page.data().inspections[0]!.title).toMatch(/^Rundgang /);
    expect(page.root.innerHTML).toContain("Rundgang läuft");
  });

  it("files a typed note with its type, and explains an empty box", () => {
    const page = mountIn("de-AT", open());
    page.root.get("#add-note").fire("click");
    expect(page.root.innerHTML).toContain("Schreib zuerst etwas ins Feld.");
    page.root.get("#note").value = "Fliese gesprungen";
    page.root.get("#note-sev").value = "major";
    page.root.get("#add-note").fire("click");
    const entries = page.data().inspections[0]!.entries;
    expect(entries.map((e) => [e.text, e.severity])).toEqual([["Fliese gesprungen", "major"]]);
    expect(page.root.get("#note").value).toBe("");
  });

  it("offers a photo button when the camera is available", () => {
    const takePhoto = vi.fn(async () => undefined);
    const page = mountIn("en-US", open(), takePhoto);
    page.root.get("#photo").fire("click");
    expect(takePhoto).toHaveBeenCalledTimes(1);
    expect(mountIn("en-US", open()).root.querySelector("#photo")).toBeNull();
  });

  it("saves the user's own quick notes, and the defaults again when emptied", () => {
    const page = mountIn("de-AT", open());
    page.root.get("#quick").value = "Riss\n\n  Fleck  ";
    page.root.get("#save-quick").fire("click");
    expect(page.data().quickNotes).toEqual(["Riss", "Fleck"]);
    page.root.get("#quick").value = "";
    page.root.get("#save-quick").fire("click");
    expect(page.data().quickNotes).toEqual([]);
  });

  it("has exactly three tabs in one row: Now / Notes / Settings, the server in the last one", () => {
    const html = mountIn("en-US", open()).root.innerHTML;
    expect(html).toContain('<nav class="tabbar"');
    expect(html.match(/data-tab-go="/g)).toHaveLength(3);
    for (const id of ["now", "notes", "settings"]) {
      expect(html).toContain(`data-tab="${id}"`);
      expect(html).toContain(`data-tab-go="${id}"`);
    }
    expect(html).toContain('id="pill"');
    expect(html).toContain("QUIETGLASS / NOTES");
    expect(html.indexOf('data-tab="settings"')).toBeLessThan(html.indexOf('id="stt"'));
    expect(html.indexOf('data-tab="notes"')).toBeLessThan(html.indexOf('id="add-note"'));
    expect(html.indexOf('data-tab="now"')).toBeLessThan(html.indexOf("hero-card"));
  });

  it("opens Settings with the checklist on the first start, and folds the server once it is set up", () => {
    const first = mountIn("en-US").root.innerHTML;
    expect(first).toContain('class="card setup"');
    expect(first).toContain('<details class="fold card" open>');
    const done = mountIn("en-US", { ...open(), sttUrl: "https://stt.test" }).root.innerHTML;
    expect(done).not.toContain('class="card setup"');
    expect(done).toContain("Speech server · set up");
    expect(done).not.toMatch(/<details class="fold card" open>/);
  });

  it("deleting an entry takes two taps: the first asks, the second deletes", () => {
    let data = open();
    data = upsertInspection(data, addEntry(data.inspections[0]!, "one", "note", 1));
    const page = mountIn("en-US", data);
    page.root.get(".drop").fire("click");
    expect(page.data().inspections[0]!.entries).toHaveLength(1);
    expect(page.root.innerHTML).toContain("Tap again");
    page.root.get(".drop").fire("click");
    expect(page.data().inspections[0]!.entries).toHaveLength(0);
  });

  it("removing a walk takes two taps as well", () => {
    const page = mountIn("en-US", open());
    page.root.get(".remove-walk").fire("click");
    expect(page.data().inspections).toHaveLength(1);
    page.root.get(".remove-walk").fire("click");
    expect(page.data().inspections).toHaveLength(0);
  });

  it("keeps the speech server under Advanced, marked optional", () => {
    const page = mountIn("de-AT", open());
    expect(page.root.innerHTML).toContain("Erweitert: Notizen sprechen (optional)");
    expect(page.root.innerHTML).toContain("Gerade aktiv: Schnellnotizen");
    expect(page.root.innerHTML).not.toContain("MOCK");
  });

  it("switches language from the picker and tells the glasses", () => {
    const page = mountIn("de-AT", open());
    page.root.get("#language").value = "en";
    page.root.get("#language").fire("change");
    expect(page.onLocaleChange).toHaveBeenCalledWith("en");
    expect(page.root.innerHTML).toContain("Inspection running");
  });

  it("shows entries filed on the glasses when refreshed", () => {
    const page = mountIn("en-US", open());
    page.external(upsertInspection(page.data(), addEntry(page.data().inspections[0]!, "Damaged", "note", 1)));
    page.ui.refresh();
    expect(page.root.innerHTML).toContain("Damaged");
  });
});

describe("CSV format choice", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  function mountLogged(locale: "de" | "en") {
    const root = fakeRoot();
    const anchor = { href: "", download: "", click: vi.fn() };
    vi.stubGlobal("document", { getElementById: () => root, createElement: () => anchor });
    const blobs: Array<{ parts: string[]; type: string }> = [];
    vi.stubGlobal("Blob", class {
      constructor(parts: string[], options: { type: string }) { blobs.push({ parts, type: options.type }); }
    });
    vi.stubGlobal("URL", { createObjectURL: () => "blob:x", revokeObjectURL: () => undefined });
    const inspection = addEntry(startInspection("i1", "Übergabe Top 3", 1_000_000), "Riss", "minor", 1_000_100);
    let data: FieldLogData = { ...upsertInspection(EMPTY_DATA, inspection), activeId: "i1" };
    mountPhoneUi({ getData: () => data, setData: async (next) => { data = next; }, locale: () => locale });
    return { root, anchor, blobs, data: () => data };
  }

  it("offers both formats next to the CSV button, Excel preselected in German", () => {
    const page = mountLogged("de");
    const html = page.root.innerHTML;
    expect(html).toContain("Für Excel (DE/AT)");
    expect(html).toContain("Standard-CSV");
    expect(html).toContain('<option value="excel-de" selected>');
    expect(html.indexOf('id="csv-format"')).toBeLessThan(html.indexOf('id="csv"'));
  });

  it("preselects the standard CSV in English", () => {
    expect(mountLogged("en").root.innerHTML).toContain('<option value="standard" selected>');
  });

  it("exports the Excel variant in German by default, with a plain file name", () => {
    const page = mountLogged("de");
    page.root.get("#csv").fire("click");
    expect(page.anchor.download).toBe("uebergabe-top-3.excel.csv");
    expect(page.anchor.click).toHaveBeenCalled();
    expect(page.blobs[0]?.type).toBe("text/csv;charset=utf-8");
    expect(page.blobs[0]?.parts[0]?.startsWith("﻿Zeit;Abschnitt;")).toBe(true);
  });

  it("remembers the choice and exports in it", () => {
    const page = mountLogged("de");
    page.root.get("#csv-format").value = "standard";
    page.root.get("#csv-format").fire("change");
    expect(page.data().csvFormat).toBe("standard");
    expect(page.root.innerHTML).toContain('<option value="standard" selected>');
    page.root.get("#csv").fire("click");
    expect(page.anchor.download).toBe("uebergabe-top-3.csv");
    expect(page.blobs[0]?.parts[0]?.startsWith("Zeit,Abschnitt,Art,Text,Foto\n")).toBe(true);
  });
});

describe("checklist on the phone (0.10)", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  function mountWalk(locale: "de" | "en", checklistText = "") {
    const root = fakeRoot();
    const anchor = { href: "", download: "", click: vi.fn() };
    vi.stubGlobal("document", { getElementById: () => root, createElement: () => anchor });
    const blobs: Array<{ parts: string[]; type: string }> = [];
    vi.stubGlobal("Blob", class {
      constructor(parts: string[], options: { type: string }) { blobs.push({ parts, type: options.type }); }
    });
    vi.stubGlobal("URL", { createObjectURL: () => "blob:x", revokeObjectURL: () => undefined });
    let inspection = addEntry(startInspection("i1", "Übergabe Top 3", 1_000_000), "Riss", "minor", 1_000_100);
    if (checklistText) inspection = { ...inspection, checklist: parseChecklist(checklistText, locale) };
    let data: FieldLogData = { ...upsertInspection(EMPTY_DATA, inspection), activeId: "i1" };
    const takePhoto = vi.fn(async (_itemId?: string) => undefined);
    mountPhoneUi({ getData: () => data, setData: async (next) => { data = next; }, locale: () => locale, takePhoto });
    return { root, anchor, blobs, takePhoto, data: () => data, walk: () => data.inspections[0]! };
  }

  it("copies a template into the box, saves it as the walk's checklist, and empty removes it (notes kept)", () => {
    const page = mountWalk("de");
    expect(page.root.innerHTML).toContain("Keine Checkliste");
    page.root.get("#tpl-car").fire("click");
    expect(page.root.get("#checklist").value).toContain("# Außen");
    expect(page.walk().checklist).toBeUndefined(); // copying saves nothing yet
    page.root.get("#checklist").value = "# Flur\n! Rauchmelder\nBoden [foto]";
    page.root.get("#save-checklist").fire("click");
    expect(page.walk().checklist?.rooms[0]?.items.map((item) => item.text)).toEqual(["Rauchmelder", "Boden"]);
    expect(page.root.innerHTML).toContain("Checkliste gespeichert · Räume: 1 · Punkte: 2");
    expect(page.root.innerHTML).toContain("Flur 0/2 · 1 📷 fehlt · 1 ! offen");
    page.root.get("#checklist").value = "  ";
    page.root.get("#save-checklist").fire("click");
    expect(page.walk().checklist).toBeUndefined();
    expect(page.walk().entries.map((entry) => entry.text)).toEqual(["Riss"]);
  });

  it("offers a camera button per photo item, for that item", () => {
    const page = mountWalk("en", "# Hall\nFloor [photo]\nDoor");
    const buttons = page.root.querySelectorAll(".item-photo");
    expect(buttons).toHaveLength(1);
    buttons[0]!.fire("click");
    expect(page.takePhoto).toHaveBeenCalledWith("Hall/Floor");
  });

  it("warns before exporting while required photos or critical items are open: back exports nothing, anyway exports", () => {
    const page = mountWalk("de", "# Küche\n! Gashahn zu\nFenster [foto]\n# Bad\nFliesen [foto]\n# Flur\nBoden");
    page.root.get("#md").fire("click");
    expect(page.anchor.click).not.toHaveBeenCalled();
    expect(page.root.innerHTML).toContain("Vor dem Export: 2 Räume ohne Pflichtfoto, 1 kritischer Punkt offen");
    expect(page.root.innerHTML).toContain("Ohne Pflichtfoto: Küche, Bad");
    expect(page.root.innerHTML).toContain("Kritisch offen: Küche – Gashahn zu");
    page.root.get("#export-back").fire("click");
    expect(page.root.querySelector("#export-anyway")).toBeNull();
    expect(page.anchor.click).not.toHaveBeenCalled();
    page.root.get("#csv").fire("click");
    page.root.get("#export-anyway").fire("click");
    expect(page.anchor.click).toHaveBeenCalledTimes(1);
    expect(page.anchor.download).toBe("uebergabe-top-3.excel.csv");
    expect(page.root.querySelector("#export-anyway")).toBeNull();
  });

  it("exports straight away when nothing is open, and a free-form walk as before", () => {
    const free = mountWalk("de");
    free.root.get("#md").fire("click");
    expect(free.anchor.click).toHaveBeenCalledTimes(1);
    expect(free.blobs[0]?.parts[0]).not.toContain("Checkliste");
    const page = mountWalk("de", "# Flur\nBoden");
    page.root.get("#md").fire("click");
    expect(page.anchor.click).toHaveBeenCalledTimes(1);
    expect(page.blobs[0]?.parts[0]).toContain("## Flur (0/1)");
  });
});
