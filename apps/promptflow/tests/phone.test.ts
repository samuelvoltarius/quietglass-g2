import { afterEach, describe, expect, it, vi } from "vitest";
import { mountPhoneUi } from "../src/ui/phone";
import { EMPTY_DATA, type PromptFlowData } from "../src/storage/persist";
import { fakeRoot, type FakeRoot } from "./fake-dom";

function mount(initial: PromptFlowData = EMPTY_DATA, save?: () => Promise<void>) {
  const root = fakeRoot();
  vi.stubGlobal("document", { getElementById: () => root });
  let data = initial;
  const setData = vi.fn(async (next: PromptFlowData) => {
    data = next;
    await save?.();
  });
  mountPhoneUi({ getData: () => data, setData });
  return { root, setData, data: () => data };
}

function addScript(root: FakeRoot, title: string, source: string): void {
  root.get("#title").value = title;
  root.get("#source").value = source;
  root.get("#add").fire("click");
}

describe("phone page", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("regression: a setting changed after saving a script does not drop that script", () => {
    // The handlers used the data captured at the first render, so the second
    // commit was computed from a state that did not contain the new script yet.
    const page = mount();
    addScript(page.root, "Keynote", "Hello there.");
    page.root.get("#cursor").checked = true;
    page.root.get("#cursor").fire("change");

    expect(page.data().scripts.map((s) => s.title)).toEqual(["Keynote"]);
    expect(page.data().settings.showCursor).toBe(true);
  });

  it("lists a script as soon as it is saved", () => {
    const page = mount();
    addScript(page.root, "Keynote", "Hello there.");
    expect(page.root.innerHTML).toContain("Keynote");
    expect(page.root.querySelectorAll(".remove")).toHaveLength(1);
  });

  it("keeps an unsaved draft when a setting is changed", () => {
    const page = mount();
    page.root.get("#title").value = "Half typed";
    page.root.get("#source").value = "Still writing";
    page.root.get("#invert").checked = true;
    page.root.get("#invert").fire("change");

    expect(page.root.get("#title").value).toBe("Half typed");
    expect(page.root.get("#source").value).toBe("Still writing");
  });

  it("clears the form once the script is saved", () => {
    const page = mount();
    addScript(page.root, "Keynote", "Hello there.");
    expect(page.root.get("#title").value).toBe("");
    expect(page.root.get("#source").value).toBe("");
  });

  it("reports a failed save instead of rejecting unhandled", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const page = mount(EMPTY_DATA, async () => { throw new Error("storage full"); });
    addScript(page.root, "Keynote", "Hello there.");
    await vi.waitFor(() => expect(page.root.innerHTML).toContain("Could not save"));
    warn.mockRestore();
  });

  it("escapes a script title on the page", () => {
    const page = mount();
    addScript(page.root, '<img src=x onerror="alert(1)">', "Hello.");
    expect(page.root.innerHTML).not.toContain("<img");
  });
});
