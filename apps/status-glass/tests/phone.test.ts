import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountPhoneUi } from "../src/ui/phone";
import { EMPTY_DATA, type StatusData } from "../src/storage/persist";

/**
 * Just enough DOM for the phone page: assigning innerHTML throws away every
 * element, as a real rebuild would.
 */
class FakeElement {
  value = "";
  textContent = "";
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
  let data: StatusData;

  beforeEach(() => {
    root = new FakeRoot();
    data = EMPTY_DATA;
    vi.stubGlobal("document", { getElementById: (id: string) => (id === "app" ? root : null) });
    mountPhoneUi({ getData: () => data, setData: async (next) => { data = next; } });
  });

  afterEach(() => { vi.unstubAllGlobals(); });

  const addSource = (name: string, url: string, token = ""): void => {
    root.querySelector("#name").value = name;
    root.querySelector("#url").value = url;
    root.querySelector("#token").value = token;
    root.querySelector("#add").fire("click");
  };

  it("keeps the first source when a second one is added", () => {
    // Regression: the page kept the data from its first render, so the second
    // source got the same id ("s1") and replaced the first.
    addSource("nas", "https://nas.local/status");
    addSource("pi", "https://pi.local/status");

    expect(data.sources.map((source) => source.name)).toEqual(["nas", "pi"]);
    expect(root.innerHTML).toContain("pi.local");
  });

  it("does not keep the token in the form, and never shows it on the page", () => {
    addSource("nas", "https://nas.local/status", "tok-do-not-show");
    expect(root.querySelector("#token").value).toBe("");
    expect(root.innerHTML).not.toContain("tok-do-not-show");
    expect(root.innerHTML).toContain("set (15 chars)");
  });

  it("escapes source names on the page", () => {
    addSource("<img src=x onerror=alert(1)>", "https://nas.local/status");
    expect(root.innerHTML).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(root.innerHTML).not.toContain("<img");
  });
});
