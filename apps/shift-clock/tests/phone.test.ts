import { afterEach, describe, expect, it, vi } from "vitest";
import { mountPhoneUi } from "../src/ui/phone";
import { addProject, EMPTY_DATA, type ClockData } from "../src/storage/persist";
import { fakeRoot } from "./fake-dom";

function mount(initial: ClockData, save?: () => Promise<void>) {
  const root = fakeRoot();
  vi.stubGlobal("document", { getElementById: () => root });
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
