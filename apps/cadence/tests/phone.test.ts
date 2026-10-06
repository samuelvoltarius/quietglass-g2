import { afterEach, describe, expect, it, vi } from "vitest";
import { mountPhoneUi } from "../src/ui/phone";
import { EMPTY_DATA, setSettings, type CadenceData } from "../src/storage/persist";

type Listener = (event: { target: FakeElement }) => void;

interface FakeElement {
  value: string;
  checked: boolean;
  textContent: string;
  dataset: Record<string, string>;
  addEventListener(type: string, listener: Listener): void;
  fire(type: string): void;
}

function element(): FakeElement {
  const listeners = new Map<string, Listener[]>();
  const el: FakeElement = {
    value: "",
    checked: false,
    textContent: "",
    dataset: {},
    addEventListener: (type, listener) => { listeners.set(type, [...(listeners.get(type) ?? []), listener]); },
    fire: (type) => { for (const listener of listeners.get(type) ?? []) listener({ target: el }); },
  };
  return el;
}

/** Just enough DOM for the phone page: every render hands out fresh elements, as innerHTML would. */
function fakeRoot() {
  let elements = new Map<string, FakeElement>();
  let html = "";
  const root = {
    get innerHTML() { return html; },
    set innerHTML(value: string) { html = value; elements = new Map(); },
    querySelector: (selector: string) => {
      const id = selector.replace(/^#/, "");
      if (!html.includes('id="' + id + '"')) return null;
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    },
    querySelectorAll: () => [],
  };
  return { root, byId: (id: string) => root.querySelector("#" + id) as FakeElement };
}

describe("phone page", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("builds every change on the current data, not on the copy it was drawn with", async () => {
    // Regression: wire() captured the data at mount, so adding an item after a tempo
    // swipe on the glasses wrote the old tempo back (and dropped sessions logged since).
    const dom = fakeRoot();
    vi.stubGlobal("document", { getElementById: () => dom.root });
    let store: CadenceData = EMPTY_DATA;
    const writes: CadenceData[] = [];
    mountPhoneUi({ getData: () => store, setData: async (next) => { store = next; writes.push(next); } });

    // The glasses change the tempo while the page is open.
    store = setSettings(store, { bpm: 140 });

    dom.byId("item").value = "Scales";
    dom.byId("add").fire("click");
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    expect(store.settings.bpm).toBe(140);
    expect(store.items).toEqual(["Scales"]);

    // And the page shows the new item after the change.
    await vi.waitFor(() => expect(dom.root.innerHTML).toContain("Scales"));
  });

  it("escapes the user's practice items", () => {
    const dom = fakeRoot();
    vi.stubGlobal("document", { getElementById: () => dom.root });
    const store: CadenceData = { ...EMPTY_DATA, items: ['<img src=x onerror="alert(1)">'], activeItem: '<img src=x onerror="alert(1)">' };
    mountPhoneUi({ getData: () => store, setData: async () => undefined });
    expect(dom.root.innerHTML).not.toContain("<img");
    expect(dom.root.innerHTML).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });
});
