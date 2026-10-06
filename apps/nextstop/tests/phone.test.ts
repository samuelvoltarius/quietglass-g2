import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountPhoneUi } from "../src/ui/phone";
import { DEFAULT_SETTINGS, type Settings } from "../src/storage/persist";
import type { Position } from "../src/ride/tracker";

/**
 * Just enough DOM for the settings page: assigning innerHTML throws away every
 * element, as a real rebuild would, so a value typed into the old field is gone.
 */
class FakeElement {
  value = "";
  textContent = "";
  hidden = false;
  readonly #listeners = new Map<string, (() => void)[]>();
  addEventListener(type: string, listener: () => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }
  fire(type: string): void { for (const listener of this.#listeners.get(type) ?? []) listener(); }
  setCustomValidity(): void { /* not needed */ }
  reportValidity(): boolean { return true; }
}

class FakeRoot {
  rebuilds = 0;
  #html = "";
  #elements = new Map<string, FakeElement>();
  set innerHTML(html: string) { this.#html = html; this.rebuilds += 1; this.#elements = new Map(); }
  get innerHTML(): string { return this.#html; }
  querySelector(selector: string): FakeElement {
    let element = this.#elements.get(selector);
    if (!element) { element = new FakeElement(); this.#elements.set(selector, element); }
    return element;
  }
}

describe("the phone settings page", () => {
  let root: FakeRoot;
  let settings: Settings;
  let position: Position | null;

  beforeEach(() => {
    vi.useFakeTimers();
    root = new FakeRoot();
    settings = DEFAULT_SETTINGS;
    position = null;
    vi.stubGlobal("document", { getElementById: (id: string) => (id === "app" ? root : null) });
    mountPhoneUi({
      getSettings: () => settings,
      setSettings: async (next) => { settings = next; },
      getPosition: () => position,
      isSeeded: () => false,
      getStops: () => [],
      refresh: () => undefined,
      getLocale: () => "de",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps what is being typed while the status line updates", () => {
    // Regression: the whole page was rebuilt every five seconds, wiping a proxy
    // address half typed into its field.
    root.querySelector("#oebb-url").value = "http://192.168.1.";
    position = { lat: 47.8, lon: 13.04 };
    vi.advanceTimersByTime(5000);

    expect(root.rebuilds).toBe(1);
    expect(root.querySelector("#oebb-url").value).toBe("http://192.168.1.");
    expect(root.querySelector("#status").textContent).toContain("Standort gefunden");
    expect(root.querySelector("#next").textContent).toContain("Haltestellen");
  });

  it("does not undo one setting when the next is changed", () => {
    // Regression: every handler spread the settings captured at render time,
    // so saving the refresh interval put the old proxy address back.
    const url = root.querySelector("#oebb-url");
    url.value = "http://192.168.1.20:8079/oebb";
    url.fire("change");

    const refresh = root.querySelector("#refresh");
    refresh.value = "60";
    refresh.fire("change");

    expect(settings.oebbUrl).toBe("http://192.168.1.20:8079/oebb");
    expect(settings.refreshSeconds).toBe(60);
  });
});
