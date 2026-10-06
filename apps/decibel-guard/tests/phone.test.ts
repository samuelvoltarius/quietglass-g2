import { afterEach, describe, expect, it, vi } from "vitest";
import { mountPhoneUi } from "../src/ui/phone";
import { EMPTY_DATA, type NoiseData } from "../src/storage/persist";

type Listener = (event: { target: FakeElement }) => void;

interface FakeElement {
  value: string;
  textContent: string;
  addEventListener(type: string, listener: Listener): void;
  fire(type: string): void;
}

function element(): FakeElement {
  const listeners = new Map<string, Listener[]>();
  const el: FakeElement = {
    value: "",
    textContent: "",
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

  it("does not undo one change with the next one made before the save finished", async () => {
    // Regression: wire() captured the data at draw time, so a second slider change made
    // while the first was still saving wrote the old calibration offset back.
    const dom = fakeRoot();
    vi.stubGlobal("document", { getElementById: () => dom.root });
    vi.stubGlobal("setInterval", () => 0);
    let store: NoiseData = EMPTY_DATA;
    const writes: NoiseData[] = [];
    let release: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    mountPhoneUi({
      getData: () => store,
      // Like main.ts: the new data is applied at once, the save takes a while.
      setData: async (next) => { store = next; writes.push(next); await pending; },
      getLevel: () => ({ dbfs: null, listening: false }),
    });

    const offset = dom.byId("offset");
    offset.value = "112";
    offset.fire("change");
    const criterion = dom.byId("criterion");
    criterion.value = "80";
    criterion.fire("change");

    expect(writes).toHaveLength(2);
    expect(store.calibrationOffset).toBe(112);
    expect(store.dose.criterionDb).toBe(80);

    // After the save the page is redrawn with both values.
    release();
    await vi.waitFor(() => expect(dom.root.innerHTML).toContain('id="offset-out">112<'));
    expect(dom.root.innerHTML).toContain('id="criterion-out">80<');
  });
});
