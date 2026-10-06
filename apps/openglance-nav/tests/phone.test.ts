import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountPhoneUi } from "../src/ui/phone";
import { EMPTY_DATA, type NavData } from "../src/storage/persist";

/**
 * Just enough DOM for the phone page: assigning innerHTML throws away every
 * element, as a real rebuild would.
 */
class FakeElement {
  value = "";
  readonly dataset: Record<string, string> = {};
  readonly #listeners = new Map<string, ((event: unknown) => void)[]>();
  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }
  fire(type: string): void { for (const listener of this.#listeners.get(type) ?? []) listener({ target: this }); }
}

class FakeRoot {
  #html = "";
  #elements = new Map<string, FakeElement>();
  set innerHTML(html: string) { this.#html = html; this.#elements = new Map(); }
  get innerHTML(): string { return this.#html; }
  querySelector(selector: string): FakeElement {
    let element = this.#elements.get(selector);
    if (!element) { element = new FakeElement(); this.#elements.set(selector, element); }
    return element;
  }
  querySelectorAll(): FakeElement[] { return []; }
}

describe("the phone page", () => {
  let root: FakeRoot;
  let data: NavData;

  beforeEach(() => {
    root = new FakeRoot();
    data = EMPTY_DATA;
    vi.stubGlobal("document", { getElementById: (id: string) => (id === "app" ? root : null) });
    mountPhoneUi({
      getData: () => data,
      setData: async (next) => { data = next; },
      getPosition: () => null,
    });
  });

  afterEach(() => { vi.unstubAllGlobals(); });

  const addPlace = (label: string, coords: string): void => {
    root.querySelector("#label").value = label;
    root.querySelector("#coords").value = coords;
    root.querySelector("#add").fire("click");
  };

  it("keeps the first place when a second one is added", () => {
    // Regression: the page was never redrawn after a change, so its handlers
    // still held the data from first render — the second place replaced the
    // first, under the same id.
    addPlace("Home", "47.1, 13.1");
    addPlace("Work", "47.2, 13.2");

    expect(data.places.map((place) => place.label)).toEqual(["Home", "Work"]);
    expect(new Set(data.places.map((place) => place.id)).size).toBe(2);
    expect(root.innerHTML).toContain("Home");
    expect(root.innerHTML).toContain("Work");
  });

  it("does not lose a half-typed router address when another control redraws", () => {
    root.querySelector("#url").value = "https://valhalla.exa";
    addPlace("Home", "47.1, 13.1");
    expect(root.querySelector("#url").value).toBe("https://valhalla.exa");
    expect(root.querySelector("#label").value).toBe("");
  });

  it("escapes place names on the page", () => {
    addPlace("<img src=x onerror=alert(1)>", "47.1, 13.1");
    expect(root.innerHTML).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(root.innerHTML).not.toContain("<img");
  });
});
