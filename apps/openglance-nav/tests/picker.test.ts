import { describe, expect, it } from "vitest";
import { CAR_DESTINATION_ID, clampCursor, cursorFor, listItems, listView, nextMode, rowCount, setCarSpot, VISIBLE_ITEMS, voiceView } from "../src/glasses/picker";
import { chooseDestination, destinationOf, EMPTY_DATA, MAX_RECENT, parseData, saveFavorite, type NavData } from "../src/storage/persist";

const place = (id: string, label: string, lat = 47, lon = 13) => ({ id, label, at: { lat, lon } });

describe("destination list on the glasses", () => {
  const data: NavData = {
    ...EMPTY_DATA,
    places: [place("p1", "Zuhause", 47.1), place("p2", "Tamsweg", 47.2)],
    recent: [place("r1", "Mirabellplatz", 47.3)],
    destinationId: "p2",
  };

  it("marks the cursor and the active destination and the travel mode; recent places are no rows (favourites instead)", () => {
    const view = listView(data, cursorFor(data), "de");
    expect(view.header).toBe("OPENGLANCE · wohin?");
    expect(view.body).toEqual([
      "    ○ Zuhause",
      "→ ● Tamsweg",
      "",
      "    Unterwegs: zu Fuß (tippen = ändern)",
    ]);
    expect(view.footer).toBe("Tippen = los · Halten = sprechen · 2× = Ende");
  });

  it("keeps only the active recent destination (a spoken one can be started again)", () => {
    const view = listView({ ...data, destinationId: "r1" }, 2, "de");
    expect(view.body).toContain("→ ● Mirabellplatz · zuletzt");
  });

  it("offers \"Wo ist mein Auto\" when the car link knows its place, never the car destination itself as a recent row", () => {
    setCarSpot({ at: { lat: 47.8, lon: 13.04 }, ageMin: 12 });
    try {
      const withCar: NavData = { ...data, recent: [place(CAR_DESTINATION_ID, "Mein Auto", 47.8, 13.04), ...data.recent], destinationId: CAR_DESTINATION_ID };
      const items = listItems(withCar);
      expect(items.map((item) => item.kind)).toEqual(["place", "place", "car"]);
      expect(listView(withCar, 2, "de").body).toContain("→ ● Wo ist mein Auto · vor 12 min");
    } finally {
      setCarSpot(null);
    }
    expect(listItems(data).some((item) => item.kind === "car")).toBe(false);
  });

  it("shows at most five destinations around the cursor and counts them", () => {
    const many: NavData = { ...EMPTY_DATA, places: Array.from({ length: 9 }, (_, i) => place("p" + i, "Ort " + i, 47 + i / 100)) };
    const view = listView(many, 7, "en");
    const rows = view.body.filter((line) => line.includes("Ort"));
    expect(rows).toHaveLength(VISIBLE_ITEMS);
    expect(view.body.join("\n")).toContain("→ ○ Ort 7");
    expect(view.header).toContain("(8/9)");
  });

  it("asks for a destination by voice when the list is empty", () => {
    const view = listView(EMPTY_DATA, 0, "de");
    expect(view.body.join(" ")).toContain("Halten und Ziel sagen");
    expect(rowCount(EMPTY_DATA)).toBe(1);
    expect(clampCursor(EMPTY_DATA, 5)).toBe(0);
  });

  it("cycles car, bike, on foot", () => {
    expect(nextMode("driving")).toBe("cycling");
    expect(nextMode("cycling")).toBe("walking");
    expect(nextMode("walking")).toBe("driving");
  });
});

describe("recent and saved destinations", () => {
  it("puts a new destination first, replaces the same place and keeps five", () => {
    let data: NavData = EMPTY_DATA;
    for (let i = 0; i < 7; i++) data = chooseDestination(data, { id: "", label: "Ort " + i, at: { lat: 47 + i / 10, lon: 13 } });
    expect(data.recent).toHaveLength(MAX_RECENT);
    expect(data.recent[0]?.label).toBe("Ort 6");
    data = chooseDestination(data, { id: "", label: "Ort vier", at: { lat: 47.4, lon: 13 } });
    expect(data.recent.map((r) => r.label)).toEqual(["Ort vier", "Ort 6", "Ort 5", "Ort 3", "Ort 2"]);
    expect(destinationOf(data)?.label).toBe("Ort vier");
    // Same name, another place: both stay.
    data = chooseDestination(data, { id: "", label: "Ort 6", at: { lat: 48.5, lon: 13 } });
    expect(data.recent.filter((r) => r.label === "Ort 6")).toHaveLength(2);
  });

  it("selects a saved place instead of adding it to the recent list", () => {
    const data = chooseDestination({ ...EMPTY_DATA, places: [place("p1", "Tamsweg", 47.128, 13.81)] }, { id: "", label: "Tamsweg", at: { lat: 47.128, lon: 13.81 } });
    expect(data.recent).toEqual([]);
    expect(data.destinationId).toBe("p1");
  });

  it("saving a favourite moves it out of the recent list", () => {
    let data = chooseDestination(EMPTY_DATA, { id: "", label: "Tamsweg", at: { lat: 47.128, lon: 13.81 } });
    data = saveFavorite(data, { label: "Tamsweg", at: { lat: 47.128, lon: 13.81 } });
    expect(data.places.map((p) => p.label)).toEqual(["Tamsweg"]);
    expect(data.recent).toEqual([]);
    expect(destinationOf(data)?.label).toBe("Tamsweg");
  });

  it("reads the recent list back and keeps a recent destination selected", () => {
    const data = parseData(JSON.stringify({ recent: [place("r1", "Tamsweg")], destinationId: "r1" }));
    expect(destinationOf(data)?.label).toBe("Tamsweg");
  });
});

describe("speaking a destination", () => {
  it("shows what was heard and up to three places", () => {
    const view = voiceView({
      phase: "results", heard: "Tamsweg", selected: 1, saved: false,
      results: [{ label: "Tamsweg", detail: "5580 Tamsweg, Österreich", at: { lat: 47.1, lon: 13.8 } }, { label: "Tamsweg Bahnhof", detail: "", at: { lat: 47.1, lon: 13.8 } }],
    }, "de");
    expect(view.header).toBe("OPENGLANCE · gehört: „Tamsweg“");
    expect(view.body).toEqual(["    Tamsweg", "      5580 Tamsweg, Österreich", "→ Tamsweg Bahnhof"]);
    expect(view.footer).toBe("Tippen = los · Halten = merken · 2× = zurück");
  });

  it("explains a failure with what to do", () => {
    const view = voiceView({ phase: "error", key: "v.sttFailed" }, "de");
    expect(view.body).toEqual(["Sprach-Server nicht erreichbar.", "", "Tailscale am Handy an?"]);
    expect(view.footer).toBe("Halten = nochmal · 2× = zurück");
  });
});
