import { afterEach, describe, expect, it, vi } from "vitest";
import { mountPhoneUi } from "../src/ui/phone";
import { EMPTY_DATA, type FlowListData } from "../src/storage/persist";
import { fakeRoot, type FakeRoot } from "./fake-dom";

function mount(initial: FlowListData = EMPTY_DATA, save?: () => Promise<void>) {
  const root = fakeRoot();
  vi.stubGlobal("document", { getElementById: () => root });
  let data = initial;
  const setData = vi.fn(async (next: FlowListData) => {
    data = next;
    await save?.();
  });
  mountPhoneUi({ getData: () => data, setData });
  return { root, setData, data: () => data };
}

function addList(root: FakeRoot, source: string): void {
  root.get("#source").value = source;
  root.get("#add").fire("click");
}

describe("phone page", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("regression: a setting changed after adding a checklist does not drop that checklist", () => {
    // Handlers kept the data of the first render, so the second change was
    // computed from a state without the new list and silently removed it.
    const page = mount();
    addList(page.root, "# Packing\n- [ ] Passport");
    page.root.get("#next").checked = false;
    page.root.get("#next").fire("change");

    expect(page.data().lists.map((l) => l.title)).toEqual(["Packing"]);
    expect(page.data().settings.showNext).toBe(false);
  });

  it("regression: two checklists added in a row get distinct ids and both stay", () => {
    const page = mount();
    addList(page.root, "# One\n- a");
    addList(page.root, "# Two\n- b");
    const lists = page.data().lists;
    expect(lists.map((l) => l.title)).toEqual(["One", "Two"]);
    expect(new Set(lists.map((l) => l.id)).size).toBe(2);
  });

  it("lists a checklist as soon as it is added and clears the form", () => {
    const page = mount();
    addList(page.root, "# Packing\n- [ ] Passport");
    expect(page.root.innerHTML).toContain("Packing");
    expect(page.root.get("#source").value).toBe("");
  });

  it("keeps an unsaved draft when a setting is changed", () => {
    const page = mount();
    page.root.get("#source").value = "# Half written";
    page.root.get("#invert").checked = true;
    page.root.get("#invert").fire("change");
    expect(page.root.get("#source").value).toBe("# Half written");
  });

  it("reports a failed save instead of rejecting unhandled", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const page = mount(EMPTY_DATA, async () => { throw new Error("storage full"); });
    addList(page.root, "# Packing\n- [ ] Passport");
    await vi.waitFor(() => expect(page.root.innerHTML).toContain("Could not save"));
  });

  it("escapes an imported pack title on the page", () => {
    const page = mount();
    addList(page.root, JSON.stringify({ title: '<img src=x onerror="alert(1)">', steps: [{ text: "a" }] }));
    expect(page.root.innerHTML).not.toContain("<img");
    expect(page.root.innerHTML).toContain("&lt;img");
  });
});

describe("phone page warnings", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("shows import warnings for a checklist that was still added", () => {
    const page = mount();
    addList(page.root, JSON.stringify({ title: "Pack", steps: [{ text: "a" }, { text: "" }] }));
    expect(page.data().lists).toHaveLength(1);
    expect(page.root.innerHTML).toContain("Step 2 has no text");
  });
});
