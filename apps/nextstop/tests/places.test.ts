import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addFavorite, cleanName, EMPTY_PLACES, loadPlaces, MAX_FAVORITES, MAX_NAME, moveFavorite, parsePlaces,
  PLACES_KEY, removeFavorite, renameFavorite, savePlaces, serializePlaces, setNow, targetsOf,
  type Places,
} from "../src/route/places";
import { escapeHtml, favoritesHtml, nowHtml, resultsHtml } from "../src/ui/places-ui";

const HOME = { name: "Heim", lat: 47.796, lon: 13.016 };
const WORK = { name: "Arbeit", lat: 47.8058, lon: 13.0427 };

function filled(): Places {
  return addFavorite(addFavorite(EMPTY_PLACES, HOME, "h"), WORK, "w");
}

describe("favourites", () => {
  it("adds, renames, moves and removes", () => {
    let places = filled();
    expect(places.favorites.map((place) => place.name)).toEqual(["Heim", "Arbeit"]);

    places = renameFavorite(places, "w", "  Büro   Nord ");
    expect(places.favorites[1]?.name).toBe("Büro Nord");

    places = moveFavorite(places, "w", -1);
    expect(places.favorites.map((place) => place.id)).toEqual(["w", "h"]);
    expect(moveFavorite(places, "w", -1)).toBe(places);
    expect(moveFavorite(places, "h", 1)).toBe(places);

    places = removeFavorite(places, "w");
    expect(places.favorites.map((place) => place.id)).toEqual(["h"]);
  });

  it("keeps a name short enough for the glasses and refuses an empty one", () => {
    expect(cleanName("x".repeat(60))).toHaveLength(MAX_NAME);
    expect(cleanName("x".repeat(60)).endsWith("…")).toBe(true);
    const places = filled();
    expect(renameFavorite(places, "h", "   ")).toBe(places);
  });

  it("renames the old favourite instead of adding the very same spot twice", () => {
    const places = addFavorite(filled(), { name: "Zuhause", lat: 47.79601, lon: 13.01601 }, "z");
    expect(places.favorites).toHaveLength(2);
    expect(places.favorites[0]?.name).toBe("Zuhause");
  });

  it("stops at the maximum and says nothing was added", () => {
    let places: Places = EMPTY_PLACES;
    for (let i = 0; i < MAX_FAVORITES + 3; i += 1) {
      places = addFavorite(places, { name: `Ort ${i}`, lat: 47 + i * 0.01, lon: 13 }, `id${i}`);
    }
    expect(places.favorites).toHaveLength(MAX_FAVORITES);
    expect(addFavorite(places, { name: "Noch einer", lat: 10, lon: 10 }, "x")).toBe(places);
  });

  it("refuses coordinates that cannot exist", () => {
    expect(addFavorite(EMPTY_PLACES, { name: "Nirgends", lat: 123, lon: 13 })).toBe(EMPTY_PLACES);
    expect(addFavorite(EMPTY_PLACES, { name: "Nirgends", lat: Number.NaN, lon: 13 })).toBe(EMPTY_PLACES);
  });
});

describe("the destination of right now", () => {
  it("is set, replaced and cleared without touching the favourites", () => {
    let places = filled();
    places = setNow(places, { name: "Getreidegasse 10", lat: 47.8, lon: 13.04 });
    expect(places.now?.name).toBe("Getreidegasse 10");
    expect(places.favorites).toHaveLength(2);
    places = setNow(places, null);
    expect(places.now).toBeNull();
  });

  it("is listed first on the glasses, marked as such", () => {
    const places = setNow(filled(), { name: "Getreidegasse 10", lat: 47.8, lon: 13.04 });
    const targets = targetsOf(places);
    expect(targets.map((target) => target.name)).toEqual(["Getreidegasse 10", "Heim", "Arbeit"]);
    expect(targets.map((target) => target.isNow)).toEqual([true, false, false]);
    expect(targetsOf(filled()).map((target) => target.isNow)).toEqual([false, false]);
  });
});

describe("storing places", () => {
  it("round-trips through the text form", () => {
    const places = setNow(filled(), { name: "Jetzt", lat: 47.8, lon: 13.04 });
    expect(parsePlaces(serializePlaces(places))).toEqual(places);
  });

  it("reads garbage as no places, and drops the bad entries only", () => {
    expect(parsePlaces("")).toEqual(EMPTY_PLACES);
    expect(parsePlaces("{not json")).toEqual(EMPTY_PLACES);
    expect(parsePlaces(JSON.stringify({ favorites: "x", now: 5 }))).toEqual(EMPTY_PLACES);
    const mixed = parsePlaces(JSON.stringify({
      favorites: [
        { id: "a", name: "Gut", lat: 47.8, lon: 13 },
        { id: "a", name: "Doppelt", lat: 47.8, lon: 13 },
        { id: "b", name: "", lat: 47.8, lon: 13 },
        { id: "c", name: "Weit", lat: 99, lon: 13 },
        { name: "Ohne Id", lat: 47.8, lon: 13 },
        null,
      ],
    }));
    expect(mixed.favorites.map((place) => place.name)).toEqual(["Gut"]);
  });

  it("does not accept the settings blob in its place", () => {
    const settings = JSON.stringify({ backend: "motis", motisUrl: "https://x.test", refreshSeconds: 30 });
    expect(parsePlaces(settings)).toEqual(EMPTY_PLACES);
  });
});

describe("the SDK store and its localStorage mirror", () => {
  let mirror: Map<string, string>;

  beforeEach(() => {
    mirror = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => mirror.get(key) ?? null,
      setItem: (key: string, value: string) => { mirror.set(key, value); },
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  const sdk = (initial = "") => {
    const store = new Map<string, string>(initial ? [[PLACES_KEY, initial]] : []);
    return {
      store,
      getLocalStorage: async (key: string) => store.get(key) ?? "",
      setLocalStorage: async (key: string, value: string) => { store.set(key, value); return true; },
    };
  };

  it("writes both copies and reads the SDK one first", async () => {
    const bridge = sdk();
    const places = filled();
    expect(await savePlaces(bridge, places)).toBe(true);
    expect(bridge.store.get(PLACES_KEY)).toBe(serializePlaces(places));
    expect(mirror.get(PLACES_KEY)).toBe(serializePlaces(places));
    expect(await loadPlaces(bridge)).toEqual(places);
  });

  it("falls back to the mirror when the SDK store is empty or broken", async () => {
    mirror.set(PLACES_KEY, serializePlaces(filled()));
    expect((await loadPlaces(sdk())).favorites).toHaveLength(2);
    const broken = { getLocalStorage: async () => { throw new Error("no store"); }, setLocalStorage: async () => false };
    expect((await loadPlaces(broken)).favorites).toHaveLength(2);
  });

  it("still saves when one of the two stores refuses", async () => {
    const refusing = { getLocalStorage: async () => "", setLocalStorage: async () => { throw new Error("full"); } };
    expect(await savePlaces(refusing, filled())).toBe(true);
    expect(mirror.has(PLACES_KEY)).toBe(true);

    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    const bridge = sdk();
    expect(await savePlaces(bridge, filled())).toBe(true);
    expect(await loadPlaces(bridge)).toEqual(filled());
    expect(await savePlaces({ ...refusing }, filled())).toBe(false);
    expect(await loadPlaces({ getLocalStorage: async () => "", setLocalStorage: async () => false })).toEqual(EMPTY_PLACES);
  });
});

describe("the destination lists on the phone", () => {
  it("escapes everything that came from outside", () => {
    expect(escapeHtml(`<b onclick="x">'&`)).toBe("&lt;b onclick=&quot;x&quot;&gt;&#39;&amp;");
    const html = resultsHtml([{ name: "<img src=x>", detail: "5020 \"Salzburg\"", kind: "place", lat: 1, lon: 1 }], "de");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x&gt;");
    const hostile = addFavorite(EMPTY_PLACES, { name: "\"><script>", lat: 47.8, lon: 13 }, "evil\"id");
    expect(favoritesHtml(hostile, "de")).not.toContain("<script>");
    expect(favoritesHtml(hostile, "de")).toContain("evil&quot;id");
  });

  it("disables the arrows at the ends of the list", () => {
    const html = favoritesHtml(filled(), "de");
    expect(html.match(/disabled/g)).toHaveLength(2);
    expect(favoritesHtml(EMPTY_PLACES, "de")).toContain("Noch keine Favoriten.");
  });

  it("shows the destination of right now, or says there is none", () => {
    expect(nowHtml(EMPTY_PLACES, "de")).toContain("Kein Ziel gesetzt.");
    expect(nowHtml(setNow(EMPTY_PLACES, { name: "Jetzt", lat: 47.8, lon: 13 }), "en")).toContain("Jetzt");
  });
});
