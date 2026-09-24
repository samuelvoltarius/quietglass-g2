import { describe, it, expect } from "vitest";
import { arrowFor, buildView, roadLabel } from "../src/glasses/view";
import { createMockProvider } from "../src/routing/provider";
import { progressOf, startNavigation, update } from "../src/nav/navigator";
import {
  parseCoordinates, parseData, EMPTY_DATA, validateRouterUrl, usesMockRouter,
  addPlace, removePlace, nextPlaceId, destinationOf,
} from "../src/storage/persist";

const options = {
  mode: "driving" as const,
  navigating: true,
  rerouting: false,
  error: null,
  mock: false,
  waitingForFix: false,
};

async function navigating() {
  const { route } = await createMockProvider().route({
    from: { lat: 52, lon: 13 }, to: { lat: 53, lon: 14 }, mode: "driving",
  });
  return update(startNavigation(route!), route!.shape[2]!);
}

describe("idle and error states", () => {
  it("asks for a destination when there is no route", () => {
    const view = buildView(null, { ...options, navigating: false });
    expect(view.body.join(" ")).toContain("phone app");
  });

  it("shows an error and offers a retry", () => {
    const view = buildView(null, { ...options, error: "router unreachable" });
    expect(view.body[0]).toBe("router unreachable");
    expect(view.footer).toContain("retry");
  });

  it("says it is waiting rather than showing a stale direction", () => {
    const view = buildView(null, { ...options, waitingForFix: true, navigating: false });
    expect(view.body.join(" ")).toContain("destination");
  });
});

describe("driving display is deliberately bare", () => {
  it("shows the arrow and the distance on one line", async () => {
    const view = buildView(progressOf(await navigating()), options);
    expect(view.body[0]).toMatch(/[\u2190-\u21FF\u2934]/);
    expect(view.body[0]).toMatch(/\d|now/);
  });

  it("names the road being joined", async () => {
    const view = buildView(progressOf(await navigating()), options);
    expect(view.body.join(" ")).toContain("Example Road");
  });

  it("carries no footer at all while driving", async () => {
    expect(buildView(progressOf(await navigating()), options).footer).toBe("");
  });

  it("adds distance and arrival time when walking", async () => {
    const view = buildView(progressOf(await navigating()), { ...options, mode: "walking" });
    expect(view.footer).not.toBe("");
    expect(view.footer).toMatch(/\d/);
  });

  it("marks a mock route even in driving mode", async () => {
    expect(buildView(progressOf(await navigating()), { ...options, mock: true }).footer).toBe("MOCK");
  });
});

describe("off route and arrival", () => {
  it("says off route and offers a reroute", async () => {
    let state = await navigating();
    const strayed = { lat: state.route.shape[5]!.lat + 0.01, lon: state.route.shape[5]!.lon };
    for (let i = 0; i < 3; i++) state = update(state, strayed);

    const view = buildView(progressOf(state), options);
    expect(view.body[0]).toBe("Off route");
    expect(view.footer).toContain("reroute");
  });

  it("says it is rerouting while fetching", async () => {
    const view = buildView(progressOf(await navigating()), { ...options, rerouting: true });
    expect(view.body.join(" ")).toContain("Rerouting");
  });

  it("announces arrival", async () => {
    let state = await navigating();
    state = update(state, state.route.shape[state.route.shape.length - 1]!);
    expect(buildView(progressOf(state), options).body[0]).toContain("Arrived");
  });
});

describe("labels", () => {
  it("prefers the street name", () => {
    expect(roadLabel("Example Road", "Turn right onto Something Else")).toBe("Example Road");
  });

  it("extracts the road from an instruction when no street is given", () => {
    expect(roadLabel(undefined, "Turn right onto Example Road.")).toBe("Example Road");
    expect(roadLabel(undefined, "Continue on Main Street")).toBe("Main Street");
  });

  it("falls back to the instruction itself", () => {
    expect(roadLabel(undefined, "Keep left at the fork")).toContain("fork");
    expect(roadLabel(undefined, undefined)).toBe("");
  });

  it("gives every manoeuvre a distinct arrow", () => {
    expect(arrowFor("left")).not.toBe(arrowFor("right"));
    expect(arrowFor("roundabout")).not.toBe(arrowFor("straight"));
  });
});

describe("configuration", () => {
  it("treats an empty router URL as the mock", () => {
    expect(usesMockRouter(EMPTY_DATA)).toBe(true);
    expect(usesMockRouter({ ...EMPTY_DATA, valhallaUrl: "https://v" })).toBe(false);
  });

  it("validates the router URL", () => {
    expect(validateRouterUrl("").valid).toBe(true);
    expect(validateRouterUrl("https://valhalla.example").valid).toBe(true);
    expect(validateRouterUrl("ws://v").valid).toBe(false);
  });

  it("parses coordinates in common formats", () => {
    expect(parseCoordinates("52.52, 13.405")).toEqual({ lat: 52.52, lon: 13.405 });
    expect(parseCoordinates("52.52 13.405")).toEqual({ lat: 52.52, lon: 13.405 });
    expect(parseCoordinates("-33.9, 18.4")).toEqual({ lat: -33.9, lon: 18.4 });
  });

  it("rejects impossible coordinates rather than routing into the sea", () => {
    expect(parseCoordinates("91, 0")).toBeNull();
    expect(parseCoordinates("0, 181")).toBeNull();
    expect(parseCoordinates("north, east")).toBeNull();
    expect(parseCoordinates("")).toBeNull();
  });

  it("adds, selects and removes places", () => {
    let data = addPlace(EMPTY_DATA, { id: nextPlaceId(EMPTY_DATA), label: "Home", at: { lat: 52, lon: 13 } });
    data = { ...data, destinationId: "p1" };
    expect(destinationOf(data)?.label).toBe("Home");

    data = removePlace(data, "p1");
    expect(data.places).toEqual([]);
    expect(data.destinationId).toBeNull();
  });

  it("drops a stored place with impossible coordinates", () => {
    const parsed = parseData(JSON.stringify({
      places: [{ id: "a", label: "bad", at: { lat: 999, lon: 0 } },
               { id: "b", label: "good", at: { lat: 52, lon: 13 } }],
    }));
    expect(parsed.places.map((p) => p.id)).toEqual(["b"]);
  });

  it("clears a destination that no longer exists", () => {
    expect(parseData(JSON.stringify({ destinationId: "gone" })).destinationId).toBeNull();
  });

  it("falls back cleanly on corrupt data", () => {
    expect(parseData("{nope")).toEqual(EMPTY_DATA);
  });
});
