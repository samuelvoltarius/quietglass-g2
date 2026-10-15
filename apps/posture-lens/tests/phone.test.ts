import { afterEach, describe, expect, it, vi } from "vitest";
import { mountPhoneUi } from "../src/ui/phone";
import { EMPTY_DATA, type PostureData } from "../src/storage/persist";
import { addToStats, createStats, record, startRecording, type Recording, type SensorStats } from "../src/imu/diagnostics";
import type { SensorPorts } from "../src/ui/sensor-panel";

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

  it("splits the page into tabs with a tab bar", () => {
    const dom = fakeRoot();
    vi.stubGlobal("document", { getElementById: () => dom.root });
    mountPhoneUi({ getData: () => EMPTY_DATA, setData: async () => undefined });
    const html = dom.root.innerHTML;
    for (const tab of ["main", "warn", "more"]) {
      expect(html).toContain('data-tab="' + tab + '"');
      expect(html).toContain('data-tab-go="' + tab + '"');
    }
    expect(html).toContain('class="tabbar"');
    expect(html.indexOf('id="angle"')).toBeGreaterThan(html.indexOf('data-tab="warn"'));
    expect(html.indexOf('id="language"')).toBeGreaterThan(html.indexOf('data-tab="more"'));
  });

  it("offers the sensor test under More, with live numbers, pace and a 20 s recording as CSV", () => {
    vi.useFakeTimers();
    try {
      const dom = fakeRoot();
      vi.stubGlobal("document", { getElementById: () => dom.root });
      let on = false;
      let pace = 500;
      let stats: SensorStats = createStats();
      let rec: Recording | null = null;
      const sensor: SensorPorts = {
        isOn: () => on, setOn: (next) => { on = next; },
        getPace: () => pace, setPace: (next) => { pace = next; },
        resetStats: () => { stats = createStats(); },
        startRecording: () => { on = true; rec = startRecording(Date.now()); },
        getStats: () => stats, getRecording: () => rec,
      };
      mountPhoneUi({ getData: () => EMPTY_DATA, setData: async () => undefined, getLocale: () => "de", sensor });
      let html = dom.root.innerHTML;
      expect(html.indexOf('id="sensor-toggle"')).toBeGreaterThan(html.indexOf('data-tab="more"'));
      expect(html).toContain("Sensor-Test starten");
      expect(html).not.toContain('id="sensor-record"');

      dom.byId("sensor-toggle").fire("click");
      html = dom.root.innerHTML;
      expect(on).toBe(true);
      expect(html).toContain("Sensor-Test beenden");
      expect(html).toContain("Einheit unbekannt");
      expect(html).toContain('<option value="1000">');
      expect(html).toContain("2) Kopf nach links drehen");

      stats = addToStats(addToStats(createStats(), { x: 0, y: 0, z: 1 }, Date.now() - 100), { x: 0.5, y: 0, z: 1 }, Date.now());
      vi.advanceTimersByTime(250);
      expect(dom.byId("sensor-x").textContent).toBe("0.50");
      expect(dom.byId("sensor-axis").textContent).toBe("x");
      expect(dom.byId("sensor-rate").textContent).toBe("10.0 Hz");

      const select = dom.byId("sensor-pace");
      select.value = "100";
      select.fire("change");
      expect(pace).toBe(100);

      dom.byId("sensor-record").fire("click");
      rec = record(rec!, { x: 1, y: 2, z: 3 }, rec!.startedAt + 5);
      vi.advanceTimersByTime(20_000);
      expect(dom.byId("sensor-rec-status").textContent).toBe("");
      // The app redraws the page when the recording has ended.
      mountPhoneUi({ getData: () => EMPTY_DATA, setData: async () => undefined, getLocale: () => "de", sensor });
      html = dom.root.innerHTML;
      expect(html).toContain("Aufnahme fertig (20 s, Messwerte: 1).");
      expect(html).toContain("CSV herunterladen");
      expect(html).toContain("t_ms,step,x,y,z,magnitude");
      expect(html).toContain("5,1,1,2,3,");
    } finally {
      vi.useRealTimers();
    }
  });
});
