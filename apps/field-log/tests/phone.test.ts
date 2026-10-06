import { afterEach, describe, expect, it, vi } from "vitest";
import { mountPhoneUi } from "../src/ui/phone";
import { EMPTY_DATA, upsertInspection, type FieldLogData } from "../src/storage/persist";
import { addEntry, startInspection } from "../src/log/entries";

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
    const [first, second] = page.root.querySelectorAll(".sev");
    first!.value = "major";
    first!.fire("change");
    page.root.querySelectorAll(".sev")[1]!.value = "minor";
    page.root.querySelectorAll(".sev")[1]!.fire("change");
    expect(second).toBeDefined();
    expect(page.data().inspections[0]!.entries.map((e) => e.severity)).toEqual(["major", "minor"]);
  });

  it("regression: a validation message is actually shown", () => {
    const page = mount(EMPTY_DATA);
    page.root.get("#stt").value = "http://not-a-socket";
    page.root.get("#save-stt").fire("click");
    expect(page.root.innerHTML).toContain("must start with ws://");
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
    page.root.get("#stt").value = "wss://half";
    page.root.get("#section").value = "Hall";
    page.root.get("#section").fire("change");
    expect(page.root.get("#stt").value).toBe("wss://half");
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
    expect(page.root.innerHTML).toContain("Tipp an die Brille, um einen Rundgang zu starten");
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
