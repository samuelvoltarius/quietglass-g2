import { describe, expect, it } from "vitest";
import { locales, type Locale } from "../src/i18n";
import { createDemoNina, type DemoScene } from "../src/nina/demo";
import { parseStatus, type StarStatus } from "../src/nina/status";
import { messages } from "../src/messages";
import { countdown, panelFrame, ringFrame, starField, telescopeFrame, ICON_STEP_MS } from "../src/glasses/charts";
import { bitmapKey } from "../src/glasses/gfx";
import { slotsFor } from "../src/glasses/render";
import { IMAGE_LIMITS } from "../src/glasses/images";
import {
  HEADER_WIDTH, PAGES, ROW_WIDTH, SIDE_NARROW, SIDE_WIDE, buildFrames, buildView, layoutFor, moodFor, shownRemaining,
  type Connection, type Page, type ViewState,
} from "../src/glasses/views";

const state = (status: StarStatus | null, over: Partial<ViewState> = {}): ViewState => ({
  locale: "de", demo: false, connection: { kind: "ok" }, status, ageSeconds: 0, page: "overview", screen: "pages",
  cursor: 0, armed: null, sending: false, message: "", hasPreview: false, now: 1_000_000, ...over,
});

const demo = async (scene: DemoScene = "run"): Promise<StarStatus> => createDemoNina(() => 0, scene).status();

const widthFor = (layout: string): number => (layout === "overview" ? SIDE_WIDE : layout === "plain" ? ROW_WIDTH : SIDE_NARROW);

/** A status with every text at its longest. */
const worst = parseStatus({
  online: true, version: "2.2.15.2-very-long-build",
  sequence: { state: "running", target: "NGC 7000 North America Nebula Wide Field Mosaic Panel 12", step: "Smart Exposure With A Long Plugin Name", frame: 1234, frames: 9999 },
  exposure: { active: true, total: 1800, remaining: 1799.9, progress: 0 },
  filter: "Hydrogen-Alpha 3nm Custom", camera: { connected: true, temp: -25.5, setpoint: -25, cooler: true, power: 100, canCool: true, atTarget: false },
  mount: { connected: true, tracking: true, alt: -88.8, az: 359.9, flipMinutes: 1439, pier: "west" },
  focuser: { connected: true, position: 1234567, temp: -18.25, moving: false },
  guider: { connected: true, guiding: false, rms: 12.34, ra: 10.11, dec: 11.22 },
  last: { index: 9999, at: "2026-10-13T01:00:00Z", type: "LIGHT", filter: "Hydrogen-Alpha 3nm Custom", exposure: 1800, hfr: 12.34, stars: 99999, target: "NGC 7000 North America Nebula Wide Field" },
  images: 99999, history: { hfr: [1, 2], temp: [], rms: [3] },
  events: [{ name: "ERROR-PLATESOLVE-WITH-LONG-NAME", ageSeconds: 1 }, { name: "SEQUENCE-FINISHED", ageSeconds: 2 }],
  preview: "k", controllable: true,
});

describe("every page fits its rows in both languages", () => {
  const connections: Connection[] = [{ kind: "setup" }, { kind: "loading" }, { kind: "ok" }, { kind: "error", code: "http", status: 503 }];
  it("worst-case texts", async () => {
    const statuses: Array<StarStatus | null> = [null, worst, await demo(), await demo("done"), await demo("lost"), parseStatus({ online: false, reason: "nina-silent" })];
    for (const locale of locales as Locale[]) {
      for (const connection of connections) {
        for (const status of statuses) {
          for (const page of PAGES) {
            for (const screen of ["pages", "control"] as const) {
              const s = state(status, { locale, connection, page, screen, demo: true, ageSeconds: 99, message: "nicht gesendet: Fehler (HTTP 503) und noch mehr Text dazu" });
              const view = buildView(s);
              expect(view.layout).toBe(layoutFor(s));
              expect(view.header.length, view.header).toBeLessThanOrEqual(HEADER_WIDTH);
              expect(view.footer.length, view.footer).toBeLessThanOrEqual(ROW_WIDTH);
              expect(view.body.length).toBeLessThanOrEqual(7);
              for (const row of view.body) expect(row.length, `${locale} ${page} ${row}`).toBeLessThanOrEqual(widthFor(view.layout));
            }
          }
        }
      }
    }
  });

  it("German and English have the same keys", () => {
    expect(Object.keys(messages.de).sort()).toEqual(Object.keys(messages.en).sort());
  });
});

describe("the pages", () => {
  it("overview: target, filter, frame, countdown, camera and guiding", async () => {
    const view = buildView(state(await demo()));
    expect(view.layout).toBe("overview");
    expect(view.header).toBe("STARGLASS · ÜBERSICHT · läuft");
    expect(view.body.slice(0, 3)).toEqual(["M 31 Andromeda", "Ha · 180 s · Bild 23/60", "noch 1:05 · Smart Exposure"]);
    expect(view.body[4]).toBe('Kamera -10,0 °C · Guiding 0,52"');
    expect(view.body[5]).toBe("Flip in 41 min · Höhe 64°");
    expect(view.footer).toBe("1/5 · Tippen = steuern · Halten = Hilfe · 2× = Ende");
  });

  it("an alert takes the header on every page", async () => {
    for (const page of PAGES) {
      expect(buildView(state(await demo("lost"), { page })).header).toBe("STARGLASS · ! Guiding verloren");
      expect(buildView(state(await demo("flip"), { page, locale: "en" })).header).toBe("STARGLASS · Meridian flip in 6 min");
    }
    expect(buildView(state(worst)).header).toBe("! Fehler: PLATESOLVE-WITH-LONG-NAME (+1)");
  });

  it("guiding, equipment and image pages", async () => {
    const s = await demo();
    expect(buildView(state(s, { page: "guiding" })).body.slice(0, 2)).toEqual(["Guiding läuft", 'RA 0,41" · Dec 0,47"']);
    const eq = buildView(state(s, { page: "equipment", locale: "en" })).body;
    expect(eq[0]).toBe("Camera -10.0 °C → -10 °C · cooler 38 %");
    expect(eq[1]).toBe("Mount: tracking · alt 64° · az 119°");
    expect(eq[2]).toBe("Meridian flip in 41 min · pier east");
    const img = buildView(state(s, { page: "image" }));
    expect(img.layout).toBe("image");
    expect(img.body.slice(0, 3)).toEqual(["M 31 Andromeda", "LIGHT · Ha", "180 s belichtet"]);
  });

  it("no guider says so instead of inventing numbers", async () => {
    const s = await demo();
    if (!s.online) throw new Error("x");
    const noGuider = { ...s, guider: { connected: false, guiding: null, rms: null, ra: null, dec: null } };
    expect(buildView(state(noGuider, { page: "guiding" })).body.slice(0, 2)).toEqual(["Kein Guider", "(PHD2 verbinden)"]);
    expect(buildView(state(noGuider)).body[4]).toBe("Kamera -10,0 °C · kein Guider");
  });

  it("control lists only what the sequence can do, and asks for confirmation", async () => {
    const s = await demo();
    const view = buildView(state(s, { screen: "control", armed: "stop" }));
    expect(view.body[0]).toBe("> Sequenz anhalten");
    expect(view.footer).toBe("Nochmal tippen = anhalten · Wischen/2× = abbrechen");
    expect(view.header).toBe("STARGLASS · Anhalten?");
  });
});

describe("pictures", () => {
  it("at most four image containers per page, each inside the SDK limits", () => {
    for (const layout of ["overview", "guiding", "image", "plain"] as const) {
      const slots = slotsFor(layout);
      expect(slots.length).toBeLessThanOrEqual(IMAGE_LIMITS.maxContainers);
      expect(new Set(slots.map((s) => s.id)).size).toBe(slots.length);
      for (const s of slots) {
        expect(s.width).toBeGreaterThanOrEqual(IMAGE_LIMITS.minWidth);
        expect(s.width).toBeLessThanOrEqual(IMAGE_LIMITS.maxWidth);
        expect(s.height).toBeLessThanOrEqual(IMAGE_LIMITS.maxHeight);
        expect(s.x + s.width).toBeLessThanOrEqual(576);
        expect(s.y + s.height).toBeLessThanOrEqual(252);
      }
    }
  });

  it("the ring changes only every few seconds on long frames", () => {
    expect(shownRemaining(63.2)).toBe(65);
    expect(shownRemaining(61)).toBe(65);
    expect(shownRemaining(12.2)).toBe(13);
    expect(bitmapKey(ringFrame(40, 65, 180))).toBe(bitmapKey(ringFrame(40, 65, 180)));
    expect(bitmapKey(ringFrame(40, 65, 180))).not.toBe(bitmapKey(ringFrame(42, 60, 180)));
    expect(countdown(65)).toBe("1:05");
    expect(countdown(9)).toBe("9");
    expect(countdown(3700)).toBe("1:01H");
  });

  it("the telescope animates while exposing and keeps still when idle", () => {
    const working = new Set([0, 1, 2, 3].map((i) => bitmapKey(telescopeFrame("working", i * ICON_STEP_MS))));
    expect(working.size).toBe(4);
    const idle = new Set([0, 1, 2, 3].map((i) => bitmapKey(telescopeFrame("idle", i * ICON_STEP_MS))));
    expect(idle.size).toBe(1);
    expect(bitmapKey(telescopeFrame("error", 0))).not.toBe(bitmapKey(telescopeFrame("error", ICON_STEP_MS)));
  });

  it("mood follows the night", async () => {
    expect(moodFor(state(await demo()))).toBe("working");
    expect(moodFor(state(await demo("lost")))).toBe("error");
    expect(moodFor(state(await demo("done")))).toBe("idle");
    expect(moodFor(state(null, { connection: { kind: "setup" } }))).toBe("offline");
  });

  it("frames per layout", async () => {
    const s = await demo();
    const pages: Array<[Page, string[]]> = [["overview", ["icon", "ring"]], ["guiding", ["icon", "panelA", "panelB"]], ["equipment", ["icon"]], ["image", ["icon"]]];
    for (const [page, keys] of pages) {
      const st = state(s, { page });
      expect(Object.keys(buildFrames(st, layoutFor(st))).sort()).toEqual(keys.sort());
    }
    expect(panelFrame({ label: "RMS", value: null, unit: '"', series: [] }).width).toBe(288);
    const sky = starField(3);
    expect([sky.width, sky.height]).toEqual([288, 144]);
    expect(bitmapKey(sky)).toBe(bitmapKey(starField(3)));
  });
});
