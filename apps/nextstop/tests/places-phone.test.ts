import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountPhoneUi } from "../src/ui/phone";
import { DEFAULT_SETTINGS } from "../src/storage/persist";
import { addFavorite, EMPTY_PLACES, setNow, targetsOf, type Places } from "../src/route/places";
import { placesView, ROUTE_ROWS, ROUTE_WIDTH } from "../src/route/view";
import type { GeoResult } from "../src/route/geocode";

/** Just enough DOM for the destinations card, same idea as phone.test.ts. */
class FakeElement {
  value = "";
  textContent = "";
  innerHTML = "";
  hidden = false;
  readonly #listeners = new Map<string, ((event: unknown) => void)[]>();
  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }
  fire(type: string, event: unknown = {}): void { for (const listener of this.#listeners.get(type) ?? []) listener(event); }
  setCustomValidity(): void { /* not needed */ }
  reportValidity(): boolean { return true; }
}

class FakeRoot {
  #elements = new Map<string, FakeElement>();
  set innerHTML(html: string) { this.html = html; this.#elements = new Map(); }
  get innerHTML(): string { return this.html; }
  html = "";
  querySelector(selector: string): FakeElement {
    let element = this.#elements.get(selector);
    if (!element) { element = new FakeElement(); this.#elements.set(selector, element); }
    return element;
  }
  querySelectorAll(): FakeElement[] { return []; }
}

const flush = async (): Promise<void> => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };

describe("the destinations card on the phone", () => {
  let root: FakeRoot;
  let places: Places;
  let searches: string[];
  let found: readonly GeoResult[];
  let failing: boolean;

  beforeEach(() => {
    vi.useFakeTimers();
    root = new FakeRoot();
    places = EMPTY_PLACES;
    searches = [];
    failing = false;
    found = [{ name: "Salzburg Hauptbahnhof", detail: "5020 Salzburg, AT", kind: "stop", lat: 47.813, lon: 13.046 }];
    vi.stubGlobal("document", { getElementById: (id: string) => (id === "app" ? root : null) });
    mountPhoneUi({
      getSettings: () => DEFAULT_SETTINGS,
      setSettings: async () => undefined,
      getPosition: () => null,
      isSeeded: () => false,
      getStops: () => [],
      refresh: () => undefined,
      getLocale: () => "de",
      getPlaces: () => places,
      setPlaces: async (next) => { places = next; },
      searchPlaces: async (text) => {
        searches.push(text);
        if (failing) throw new Error("offline");
        return found;
      },
      isDemo: () => false,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const click = (act: string, extra: Record<string, string> = {}): void => {
    const target = { dataset: { act, ...extra } };
    root.querySelector("#places-card").fire("click", { target: { closest: () => target } });
  };

  it("shows the destinations card with search, favourites and the destination of now", () => {
    expect(root.html).toContain('id="places-card"');
    expect(root.html).toContain("Ziele");
    expect(root.html).toContain("Favoriten");
    expect(root.html).toContain("Ziel jetzt");
    expect(root.querySelector("#place-favs").innerHTML).toContain("Noch keine Favoriten.");
  });

  it("searches, lists the result, and saves it as a favourite", async () => {
    root.querySelector("#place-q").value = "  Hauptbahnhof ";
    root.querySelector("#place-go").fire("click");
    await flush();
    expect(searches).toEqual(["Hauptbahnhof"]);
    expect(root.querySelector("#place-results").innerHTML).toContain("Salzburg Hauptbahnhof");

    click("save", { i: "0" });
    await flush();
    expect(places.favorites.map((place) => place.name)).toEqual(["Salzburg Hauptbahnhof"]);
    expect(root.querySelector("#place-favs").innerHTML).toContain('value="Salzburg Hauptbahnhof"');
  });

  it("sets the destination of now, and clears it", async () => {
    root.querySelector("#place-q").value = "Hauptbahnhof";
    root.querySelector("#place-go").fire("click");
    await flush();
    click("now", { i: "0" });
    await flush();
    expect(places.now?.name).toBe("Salzburg Hauptbahnhof");
    expect(places.favorites).toHaveLength(0);
    click("clear-now");
    await flush();
    expect(places.now).toBeNull();
  });

  it("renames, reorders and removes favourites", async () => {
    places = addFavorite(addFavorite(EMPTY_PLACES, { name: "Heim", lat: 47.796, lon: 13.016 }, "h"), { name: "Arbeit", lat: 47.8, lon: 13.04 }, "w");
    click("down", { id: "h" });
    await flush();
    expect(places.favorites.map((place) => place.id)).toEqual(["w", "h"]);

    root.querySelector("#places-card").fire("change", {
      target: { classList: { contains: () => true }, dataset: { id: "w" }, value: "Büro" },
    });
    await flush();
    expect(places.favorites[0]?.name).toBe("Büro");

    click("remove", { id: "h" });
    await flush();
    expect(places.favorites.map((place) => place.id)).toEqual(["w"]);
  });

  it("says so when the search cannot be made, and when nothing is found", async () => {
    failing = true;
    root.querySelector("#place-q").value = "Hauptbahnhof";
    root.querySelector("#place-go").fire("click");
    await flush();
    expect(root.querySelector("#place-note").textContent).toBe("Suche nicht möglich. Internet prüfen und nochmal versuchen.");

    failing = false;
    found = [];
    root.querySelector("#place-go").fire("click");
    await flush();
    expect(root.querySelector("#place-note").textContent).toBe("Nichts gefunden.");
  });

  it("does not search for a single letter", async () => {
    root.querySelector("#place-q").value = "H";
    root.querySelector("#place-go").fire("click");
    await flush();
    expect(searches).toEqual([]);
  });

  it("warns when the favourites are full instead of ignoring the click", async () => {
    for (let i = 0; i < 8; i += 1) places = addFavorite(places, { name: `Ort ${i}`, lat: 47 + i * 0.01, lon: 13 }, `i${i}`);
    root.querySelector("#place-q").value = "Hauptbahnhof";
    root.querySelector("#place-go").fire("click");
    await flush();
    click("save", { i: "0" });
    await flush();
    expect(root.querySelector("#place-note").textContent).toBe("Höchstens 8 Favoriten – entferne zuerst einen.");
    expect(places.favorites).toHaveLength(8);
  });
});

describe("the goal list on the glasses", () => {
  const NOW = new Date(2026, 9, 13, 14, 29);
  const places = setNow(
    addFavorite(addFavorite(EMPTY_PLACES, { name: "Heim", lat: 47.796, lon: 13.016 }, "h"), { name: "Arbeit", lat: 47.8, lon: 13.04 }, "w"),
    { name: "Getreidegasse 10", lat: 47.8, lon: 13.04 },
  );

  it("lists the goal of now first, then the favourites, and marks the selected one", () => {
    const view = placesView(targetsOf(places), 1, NOW, "de");
    expect(view).toEqual({
      header: "NEXTSTOP · Wohin? · 14:29",
      body: ["  Jetzt: Getreidegasse 10", "> Heim", "  Arbeit"],
      footer: "Tippen = los · Halten = sprechen · 2× = zurück",
    });
    expect(placesView(targetsOf(places), 0, NOW, "en").body[0]).toBe("> Now: Getreidegasse 10");
  });

  it("explains how to add a goal when there is none", () => {
    const view = placesView([], 0, NOW, "de");
    expect(view.body).toEqual(["", "Noch keine Ziele.", "", "Öffne NextStop am Handy und lege", "unter „Ziele“ einen Favoriten an.", "", "halten = Ziel sprechen"]);
    expect(view.footer).toBe("Halten = sprechen · 2× = zurück");
  });

  it("scrolls with the selection when there are more goals than rows", () => {
    let many: Places = EMPTY_PLACES;
    for (let i = 0; i < 8; i += 1) many = addFavorite(many, { name: `Ort ${i}`, lat: 47 + i * 0.01, lon: 13 }, `i${i}`);
    many = setNow(many, { name: "Jetzt-Ziel", lat: 47.5, lon: 13 });
    const last = placesView(targetsOf(many), 8, NOW, "de");
    expect(last.body).toHaveLength(ROUTE_ROWS);
    expect(last.body.at(-1)).toBe("> Ort 7");
    expect(last.body[0]).toBe("  Ort 1");
    for (const line of last.body) expect(line.length).toBeLessThanOrEqual(ROUTE_WIDTH);
  });
});
