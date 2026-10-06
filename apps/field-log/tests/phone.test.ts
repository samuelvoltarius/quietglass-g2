import { afterEach, describe, expect, it, vi } from "vitest";
import { mountPhoneUi } from "../src/ui/phone";
import { EMPTY_DATA, upsertInspection, type FieldLogData } from "../src/storage/persist";
import { addEntry, startInspection } from "../src/log/entries";

import { fakeRoot } from "./fake-dom";

function mount(initial: FieldLogData, save?: () => Promise<void>) {
  const root = fakeRoot();
  vi.stubGlobal("document", { getElementById: () => root });
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
    page.root.get("#start").fire("click");
    expect(page.root.innerHTML).toContain("Give the inspection a title.");
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
