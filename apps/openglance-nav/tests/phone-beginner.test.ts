import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountPhoneUi, searchErrorKey } from "../src/ui/phone";
import { EMPTY_DATA, type NavData } from "../src/storage/persist";
import type { SearchOutcome } from "../src/geocode/photon";
import type { Locale } from "../src/i18n";

/**
 * A little more DOM than tests/phone.test.ts: `querySelectorAll` hands back
 * one element per `data-index` / radio value found in the rendered HTML, so
 * search results and the travel choice can be clicked.
 */
class FakeElement {
  value = "";
  checked = false;
  readonly dataset: Record<string, string> = {};
  readonly #listeners = new Map<string, ((event: unknown) => void)[]>();
  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }
  fire(type: string, extra: Record<string, unknown> = {}): void {
    for (const listener of this.#listeners.get(type) ?? []) listener({ target: this, ...extra });
  }
}

class FakeRoot {
  #html = "";
  #elements = new Map<string, FakeElement>();
  #lists = new Map<string, FakeElement[]>();
  set innerHTML(html: string) { this.#html = html; this.#elements = new Map(); this.#lists = new Map(); }
  get innerHTML(): string { return this.#html; }
  querySelector(selector: string): FakeElement {
    let element = this.#elements.get(selector);
    if (!element) { element = new FakeElement(); this.#elements.set(selector, element); }
    return element;
  }
  querySelectorAll(selector: string): FakeElement[] {
    const cached = this.#lists.get(selector);
    if (cached) return cached;
    let list: FakeElement[] = [];
    if (selector === ".pick") {
      list = [...this.#html.matchAll(/class="pick" data-index="(\d+)"/g)].map((match) => {
        const element = new FakeElement(); element.dataset["index"] = match[1]!; return element;
      });
    }
    const radio = /^input\[name="([\w-]+)"\]$/.exec(selector);
    if (radio) {
      list = [...this.#html.matchAll(new RegExp(`name="${radio[1]}" value="([\\w-]+)"`, "g"))].map((match) => {
        const element = new FakeElement(); element.value = match[1]!; return element;
      });
    }
    this.#lists.set(selector, list);
    return list;
  }
}

const FOUND: SearchOutcome = {
  places: [
    { label: "Mirabellplatz", detail: "5020 Salzburg, Österreich", at: { lat: 47.805, lon: 13.043 } },
    { label: "Mirabellgarten", detail: "Salzburg", at: { lat: 47.806, lon: 13.041 } },
  ],
  error: null,
};

describe("the phone page for a first-time user", () => {
  let root: FakeRoot;
  let data: NavData;
  let locale: Locale;
  let searches: string[];
  let answer: SearchOutcome;

  const mount = (): void => {
    mountPhoneUi({
      getData: () => data,
      setData: async (next) => { data = next; },
      getPosition: () => null,
      getLocale: () => locale,
      setLocale: (next) => { locale = next; },
      search: async (query) => { searches.push(query); return answer; },
    });
  };

  beforeEach(() => {
    root = new FakeRoot();
    data = EMPTY_DATA;
    locale = "de";
    searches = [];
    answer = FOUND;
    vi.stubGlobal("document", { getElementById: (id: string) => (id === "app" ? root : null) });
    mount();
  });

  afterEach(() => { vi.unstubAllGlobals(); });

  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  it("explains the three steps in German and credits OpenStreetMap", () => {
    expect(root.innerHTML).toContain("So geht's");
    expect(root.innerHTML).toContain("Unten dein Ziel suchen und speichern.");
    expect(root.innerHTML).toContain("OpenStreetMap-Mitwirkende");
    expect(root.innerHTML).toContain("https://www.openstreetmap.org/fixthemap");
    expect(root.innerHTML).toContain("FOSSGIS e.V.");
    expect(root.innerHTML).toContain("Photon by komoot");
  });

  it("finds a place by name and makes it the destination in one tap", async () => {
    root.querySelector("#query").value = "Mirabellplatz Salzburg";
    root.querySelector("#search").fire("click");
    await settle();
    expect(searches).toEqual(["Mirabellplatz Salzburg"]);
    expect(root.innerHTML).toContain("5020 Salzburg, Österreich");

    root.querySelectorAll(".pick")[0]!.fire("click");
    expect(data.places).toEqual([{ id: "p1", label: "Mirabellplatz", at: { lat: 47.805, lon: 13.043 } }]);
    expect(data.destinationId).toBe("p1");
    expect(root.innerHTML).toContain("Bereit. Tipp an die Brille");
    expect(root.innerHTML).not.toContain("So geht's");
  });

  it("searches on Enter too, but never while typing", async () => {
    root.querySelector("#query").value = "Hauptbahnhof";
    root.querySelector("#query").fire("keydown", { key: "a" });
    await settle();
    expect(searches).toEqual([]);
    root.querySelector("#query").fire("keydown", { key: "Enter" });
    await settle();
    expect(searches).toEqual(["Hauptbahnhof"]);
  });

  it("says plainly when nothing was found", async () => {
    answer = { places: [], error: "empty" };
    root.querySelector("#query").value = "Xyzzy";
    root.querySelector("#search").fire("click");
    await settle();
    expect(root.innerHTML).toContain("Nichts gefunden. Straße und Ort probieren.");
  });

  it("offers walking, cycling and driving as words with icons", () => {
    for (const word of ["Zu Fuß", "Fahrrad", "Auto", "🚶", "🚲", "🚗"]) expect(root.innerHTML).toContain(word);
    root.querySelectorAll('input[name="mode"]').find((radio) => radio.value === "cycling")!.checked = true;
    root.querySelectorAll('input[name="mode"]').find((radio) => radio.value === "cycling")!.fire("change");
    expect(data.mode).toBe("cycling");
  });

  it("lets the glasses view be chosen on the phone as well", () => {
    const overview = root.querySelectorAll('input[name="glass-view"]').find((radio) => radio.value === "overview")!;
    overview.checked = true;
    overview.fire("change");
    expect(data.glassView).toBe("overview");
  });

  it("keeps jargon to the advanced section", () => {
    const [everyday, advanced] = root.innerHTML.split("<summary>Erweitert</summary>");
    expect(everyday).not.toMatch(/valhalla(?!1\.openstreetmap)/i);
    expect(everyday).not.toMatch(/costing|precision/i);
    expect(advanced).toContain("Routenserver (Valhalla)");
  });

  it("switches to English", () => {
    root.querySelector("#language").value = "en";
    root.querySelector("#language").fire("change");
    expect(locale).toBe("en");
    expect(root.innerHTML).toContain("How it works");
  });

  it("names a self-hosted server instead of FOSSGIS", () => {
    data = { ...EMPTY_DATA, valhallaUrl: "http://pi.local:8002" };
    mount();
    expect(root.innerHTML).toContain("dein Server (pi.local:8002)");
  });

  it("warns that the demo route is not real", () => {
    data = { ...EMPTY_DATA, demo: true };
    mount();
    expect(root.innerHTML).toContain("erfundene Route");
  });

  it("maps every search failure to a sentence", () => {
    expect(searchErrorKey(null)).toBeNull();
    expect(searchErrorKey("short")).toBe("err.searchShort");
    expect(searchErrorKey("offline")).toBe("err.offline");
    expect(searchErrorKey("busy")).toBe("err.busy");
    expect(searchErrorKey("server")).toBe("err.server");
  });
});
