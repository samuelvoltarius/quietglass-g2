import { afterEach, describe, expect, it, vi } from "vitest";
import { mountPhoneUi } from "../src/ui/phone";
import { EMPTY_DATA, type PostureData } from "../src/storage/persist";

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

  it("keeps a calibration made on the glasses after the page was drawn", async () => {
    // Regression: wire() captured the data at mount (reference: null), so moving any slider
    // after tapping to calibrate wrote reference: null back and threw the calibration away.
    const dom = fakeRoot();
    vi.stubGlobal("document", { getElementById: () => dom.root });
    let store: PostureData = EMPTY_DATA;
    const writes: PostureData[] = [];
    mountPhoneUi({ getData: () => store, setData: async (next) => { store = next; writes.push(next); } });
    expect(dom.root.innerHTML).toContain("Not calibrated yet");

    // A tap on the glasses calibrates while the page is open.
    store = { ...store, reference: { x: 0, y: 0, z: 1 } };

    const angle = dom.byId("angle");
    angle.value = "30";
    angle.fire("change");
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    expect(store.reference).toEqual({ x: 0, y: 0, z: 1 });
    expect(store.settings.warnAngle).toBe(30);

    // The page now says so and offers to clear it.
    await vi.waitFor(() => expect(dom.root.innerHTML).toContain("Clear calibration"));
  });
});
