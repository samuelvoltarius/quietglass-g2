import { describe, expect, it } from "vitest";
import { buildView, fitLines, LINE_WIDTH, MAX_ROWS, OVERVIEW_ROWS, ROAD_WIDTH } from "../src/glasses/view";
import { buildPage } from "../src/glasses/render";
import { formatDistance } from "../src/geo/geometry";
import { createMockProvider } from "../src/routing/provider";
import { progressOf, startNavigation, update } from "../src/nav/navigator";
import { pixelArrowFor } from "../src/glasses/icons";

const options = {
  mode: "walking" as const,
  navigating: true,
  rerouting: false,
  error: null,
  mock: false,
  waitingForFix: false,
};

async function progress() {
  const { route } = await createMockProvider().route({ from: { lat: 52, lon: 13 }, to: { lat: 53, lon: 14 }, mode: "walking" });
  return progressOf(update(startNavigation(route!), route!.shape[2]!));
}

describe("first run on the glasses", () => {
  it("tells a new user, in German, to enter the destination on the phone", () => {
    const view = buildView(null, { ...options, navigating: false, locale: "de" });
    expect(view.body).toEqual(["Noch kein Ziel.", "Ziel am Handy eingeben."]);
  });

  it("names the chosen destination and says how to start", () => {
    const en = buildView(null, { ...options, navigating: false, destination: "Office" });
    expect(en.body).toEqual(["To: Office", "Tap to start."]);
    const de = buildView(null, { ...options, navigating: false, destination: "Büro", locale: "de" });
    expect(de.body).toEqual(["Ziel: Büro", "Tippen zum Starten."]);
  });

  it("cuts a very long destination name to fit beside the arrow", () => {
    const view = buildView(null, { ...options, navigating: false, destination: "A".repeat(80) });
    expect(view.body[0]!.length).toBeLessThanOrEqual(ROAD_WIDTH);
    expect(view.body[0]!.endsWith("…")).toBe(true);
  });
});

describe("German on the glasses", () => {
  it("translates states and keeps umlauts", async () => {
    const p = await progress();
    expect(buildView(p, { ...options, rerouting: true, locale: "de" }).body).toEqual(["Abseits der Route", "Neue Route…"]);
    expect(buildView(p, { ...options, mock: true, mode: "driving", locale: "de" }).footer).toBe("DEMO");
    expect(buildView(null, { ...options, error: "Kein GPS — geh ins Freie", locale: "de" }).footer).toBe("tippen = nochmal");
  });

  it("writes distances the German way", () => {
    expect(formatDistance(1400, "de")).toBe("1,4 km");
    expect(formatDistance(10, "de")).toBe("jetzt");
    expect(formatDistance(1400)).toBe("1.4 km");
    expect(formatDistance(250, "de")).toBe("250 m");
  });
});

describe("text limits", () => {
  it("never exceeds 7 rows of 46 characters", () => {
    const lines = fitLines(Array.from({ length: 12 }, () => "x".repeat(80)));
    expect(lines).toHaveLength(MAX_ROWS);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(LINE_WIDTH);
    expect([MAX_ROWS, LINE_WIDTH]).toEqual([7, 46]);
  });

  it("keeps an error message to the limits too", () => {
    const view = buildView(null, { ...options, error: "e".repeat(200) });
    expect(view.body[0]!.length).toBeLessThanOrEqual(LINE_WIDTH);
  });
});

describe("overview layout", () => {
  it("labels the overview and keeps the text below the map to three rows", async () => {
    const p = { ...(await progress()), maneuver: { type: "roundabout" as const, instruction: "", street: "S".repeat(60), length: 1, time: 1, shapeIndex: 0, exitNumber: 2 } };
    const view = buildView(p, { ...options, layout: "overview", locale: "de" });
    expect(view.header).toBe("Übersicht");
    expect(view.body.length).toBeLessThanOrEqual(OVERVIEW_ROWS);
    // Full width below the map: the street may use all 46 characters.
    expect(view.body[1]!.length).toBe(LINE_WIDTH);
    expect(view.body[2]).toBe("Ausfahrt 2");
  });

  it("builds a page with the 288 x 144 map image and the text beneath", async () => {
    const view = buildView(await progress(), { ...options, layout: "overview" });
    const page = buildPage(view, undefined, "overview");
    const image = page.imageObject?.[0];
    expect(image).toMatchObject({ containerName: "overview-map", width: 288, height: 144, xPosition: 144, yPosition: 0 });
    const body = page.textObject?.find((text) => text.containerName === "body");
    expect(body?.isEventCapture).toBe(1);
    expect(body?.yPosition).toBeGreaterThanOrEqual(144);
    // Exactly one container captures input, as the SDK requires.
    expect(page.textObject?.filter((text) => text.isEventCapture === 1)).toHaveLength(1);
    const z = [...(page.textObject ?? []), ...(page.imageObject ?? [])].map((c) => c.zOrderIndex);
    expect(new Set(z).size).toBe(z.length);
  });

  it("keeps the turn layout as it was", async () => {
    const page = buildPage(buildView(await progress(), options), pixelArrowFor("right"));
    expect(page.imageObject?.[0]).toMatchObject({ containerName: "pixel-icon", width: 96, height: 144 });
  });
});
