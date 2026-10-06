import { afterEach, describe, expect, it, vi } from "vitest";
import { mountPhoneUi } from "../src/ui/phone";
import { addProject, EMPTY_DATA, firstRunData, type ClockData } from "../src/storage/persist";
import { fakeRoot } from "./fake-dom";

function mount(initial: ClockData, save?: () => Promise<void>) {
  const root = fakeRoot();
  vi.stubGlobal("document", { getElementById: () => root });
  // The page follows the device language; these tests read the English copy.
  vi.stubGlobal("navigator", { language: "en-US" });
  let data = initial;
  const setData = vi.fn(async (next: ClockData) => {
    data = next;
    await save?.();
  });
  mountPhoneUi({ getData: () => data, setData });
  return {
    root,
    data: () => data,
    /** A change made on the glasses while the page is open. */
    external: (next: ClockData) => { data = next; },
  };
}

describe("phone page", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("regression: adding a project does not stop a clock started on the glasses meanwhile", () => {
    // The page computed the change from the data of its last render, which
    // had no open entry, and the save reset the running clock to stopped.
    const page = mount(addProject(EMPTY_DATA, "Client A"));
    page.external({ ...page.data(), open: { project: "Client A", startedAt: 1_000 } });

    page.root.get("#project").value = "Client B";
    page.root.get("#add").fire("click");

    expect(page.data().projects).toEqual(["Client A", "Client B"]);
    expect(page.data().open).toEqual({ project: "Client A", startedAt: 1_000 });
  });

  it("regression: entries recorded on the glasses survive removing a project", () => {
    const page = mount(addProject(addProject(EMPTY_DATA, "A"), "B"));
    const recorded = { id: "e1", project: "A", startedAt: 0, endedAt: 60_000 };
    page.external({ ...page.data(), entries: [recorded] });
    page.root.querySelectorAll(".remove")[1]!.fire("click");
    expect(page.data().entries).toEqual([recorded]);
    expect(page.data().projects).toEqual(["A"]);
  });

  it("shows an added project straight away and clears the field", () => {
    const page = mount(EMPTY_DATA);
    page.root.get("#project").value = "Client A";
    page.root.get("#add").fire("click");
    expect(page.root.innerHTML).toContain("Client A");
    expect(page.root.get("#project").value).toBe("");
  });

  it("reports a failed save instead of rejecting unhandled", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const page = mount(EMPTY_DATA, async () => { throw new Error("storage full"); });
    page.root.get("#project").value = "Client A";
    page.root.get("#add").fire("click");
    await vi.waitFor(() => expect(page.root.innerHTML).toContain("Could not save"));
  });

  it("escapes a project name on the page", () => {
    const page = mount(addProject(EMPTY_DATA, "<img src=x onerror=alert(1)>"));
    expect(page.root.innerHTML).not.toContain("<img");
  });
});

describe("phone page for beginners", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  function mountIn(language: string, initial: ClockData) {
    const root = fakeRoot();
    vi.stubGlobal("document", { getElementById: () => root });
    vi.stubGlobal("navigator", { language });
    let data = initial;
    const onLocaleChange = vi.fn();
    const ui = mountPhoneUi({ getData: () => data, setData: async (next) => { data = next; }, onLocaleChange });
    return { root, data: () => data, onLocaleChange, ui, external: (next: ClockData) => { data = next; } };
  }

  it("first run: says in one sentence how to start the default project", () => {
    const page = mountIn("de-AT", firstRunData("de"));
    expect(page.root.innerHTML).toContain("Tipp an die Brille, um die Zeit für <b>Arbeit</b> zu starten.");
    expect(page.root.innerHTML).toContain('<option value="de" selected>');
  });

  it("with no project, offers to create one in one tap", () => {
    const page = mountIn("de-AT", EMPTY_DATA);
    expect(page.root.innerHTML).toContain("Leg unten ein Projekt an");
    page.root.get("#add-default").fire("click");
    expect(page.data().projects).toEqual(["Arbeit"]);
    expect(page.root.querySelector("#add-default")).toBeNull();
  });

  it("explains an empty name and a duplicate instead of doing nothing", () => {
    const page = mountIn("de-AT", firstRunData("de"));
    page.root.get("#add").fire("click");
    expect(page.root.innerHTML).toContain("Gib dem Projekt zuerst einen Namen.");
    page.root.get("#project").value = "Arbeit";
    page.root.get("#add").fire("click");
    expect(page.root.innerHTML).toContain("Das Projekt „Arbeit“ gibt es schon.");
  });

  it("asks once before clearing the log", () => {
    const recorded = { id: "e1", project: "Arbeit", startedAt: 0, endedAt: 60_000 };
    const page = mountIn("de-AT", { ...firstRunData("de"), entries: [recorded] });
    page.root.get("#clear").fire("click");
    expect(page.data().entries).toEqual([recorded]);
    expect(page.root.innerHTML).toContain("Wirklich alle Einträge löschen?");
    page.root.get("#clear").fire("click");
    expect(page.data().entries).toEqual([]);
  });

  it("shows German decimal hours on the page and documents the CSV format", () => {
    const recorded = { id: "e1", project: "Arbeit", startedAt: 0, endedAt: 5_400_000 };
    const page = mountIn("de-AT", { ...firstRunData("de"), entries: [recorded] });
    expect(page.root.innerHTML).toContain("1,50 h");
    expect(page.root.innerHTML).toContain("Punkt bei den Stunden");
  });

  it("lets the swipe direction be inverted", () => {
    const page = mountIn("en-US", firstRunData("en"));
    page.root.get("#invert").checked = true;
    page.root.get("#invert").fire("change");
    expect(page.data().invertScroll).toBe(true);
  });

  it("switches language from the picker and tells the glasses", () => {
    const page = mountIn("de-AT", firstRunData("de"));
    page.root.get("#language").value = "en";
    page.root.get("#language").fire("change");
    expect(page.onLocaleChange).toHaveBeenCalledWith("en");
    expect(page.root.innerHTML).toContain("Tap the glasses to start the clock");
  });

  it("shows a clock started on the glasses when refreshed", () => {
    const page = mountIn("en-US", firstRunData("en"));
    page.external({ ...page.data(), open: { project: "Work", startedAt: 1_000 } });
    page.ui.refresh();
    expect(page.root.innerHTML).toContain("Running now: <b>Work</b>");
  });
});
