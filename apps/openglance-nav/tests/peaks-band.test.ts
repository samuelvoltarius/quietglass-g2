import { describe, expect, it } from "vitest";
import {
  BAND_HEIGHT, BAND_NAME_CHARS, BAND_WIDTH, bandDistance, bandKey, bandX, COUNT_TOP, drawBand, LABEL_BOTTOM, layoutBand,
  renderBandPngs, ROW_TOPS, SCALE_BOTTOM,
} from "../src/peaks/band";
import { bandPicks, demoPeaks, sightsFrom, type Peak } from "../src/peaks/peaks";
import { bandView, listRow, LIST_ROWS, peakListView, type PeakPageState } from "../src/peaks/view";
import { createGrayCanvas } from "../src/glasses/png";
import { buildPage } from "../src/glasses/render";
import { messages } from "../src/messages";
import { locales } from "../src/i18n";
import { LINE_WIDTH } from "../src/glasses/view";

const HERE = { lat: 47.8, lon: 13.05 };

/** Deterministic pseudo-random numbers, so a failing layout can be reproduced. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
}

function randomPeaks(seed: number, count: number): Peak[] {
  const next = random(seed);
  const names = ["Gaisberg", "Untersberg Berchtesgadener Hochthron", "Hoher Göll", "Schafberg", "Großer Barmstein", "Kühstein", "Zwölferhorn", "Ö", "Watzmann-Mittelspitze"];
  return Array.from({ length: count }, (_, i) => ({
    id: i,
    name: names[i % names.length]!,
    ele: Math.round(400 + next() * 3000),
    at: { lat: HERE.lat + (next() - 0.5) * 0.6, lon: HERE.lon + (next() - 0.5) * 0.9 },
  }));
}

describe("the compass band layout", () => {
  it("puts the facing direction in the middle and ±60° at the edges", () => {
    expect(bandX(100, 100)).toBe(BAND_WIDTH / 2);
    expect(bandX(100, 40)).toBe(0);
    expect(bandX(100, 160)).toBe(BAND_WIDTH);
    expect(bandX(350, 20)).toBeCloseTo(BAND_WIDTH / 2 + 30 * 4.8);
  });

  it("writes short distances for the pixel font", () => {
    expect(bandDistance(830, "de")).toBe("830M");
    expect(bandDistance(4520, "de")).toBe("4,5KM");
    expect(bandDistance(4520, "en")).toBe("4.5KM");
    expect(bandDistance(23_400, "en")).toBe("23KM");
  });

  it("keeps every label inside the picture, in its rows, clear of the scale and the triangles, never overlapping", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const sights = sightsFrom(HERE, randomPeaks(seed, 40), 50_000);
      const facing = (seed * 37) % 360;
      for (const pick of ["near", "high"] as const) {
        const layout = layoutBand(bandPicks(sights, facing, pick, 8), facing, seed % 2 ? "de" : "en");
        for (const label of layout.labels) {
          const r = label.rect;
          expect(r.x).toBeGreaterThanOrEqual(0);
          expect(r.x + r.w).toBeLessThanOrEqual(BAND_WIDTH);
          expect(ROW_TOPS).toContain(r.y);
          expect(r.y).toBeGreaterThan(SCALE_BOTTOM);
          expect(r.y + r.h).toBeLessThanOrEqual(LABEL_BOTTOM);
          expect(label.name.length).toBeLessThanOrEqual(BAND_NAME_CHARS);
        }
        for (const [i, a] of layout.labels.entries()) {
          for (const b of layout.labels.slice(i + 1)) {
            const apart = a.rect.x + a.rect.w <= b.rect.x || b.rect.x + b.rect.w <= a.rect.x
              || a.rect.y + a.rect.h <= b.rect.y || b.rect.y + b.rect.h <= a.rect.y;
            expect(apart, `${a.name} / ${b.name}`).toBe(true);
          }
        }
        for (const x of layout.markers) { expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThan(BAND_WIDTH); }
      }
    }
  });

  it("labels the nearest peaks first and keeps a triangle for one without room", () => {
    const sights = sightsFrom(HERE, demoPeaks(HERE));
    const layout = layoutBand(bandPicks(sights, 180, "near", 8), 180, "de");
    expect(layout.markers.length).toBeGreaterThanOrEqual(layout.labels.length);
    // Facing south: the Untersberg (about 11 km) is the nearest within the band.
    expect(layout.labels[0]!.name).toBe("DEMO UNTE.");
    expect(layout.labels[0]!.detail).toBe("1973M 11KM");
  });

  it("draws only inside the band and marks the peaks outside it", () => {
    const sights = sightsFrom(HERE, demoPeaks(HERE));
    const picks = bandPicks(sights, 0, "near");
    expect(picks.left + picks.right).toBeGreaterThan(0);
    const layout = layoutBand(picks, 0, "en");
    const canvas = createGrayCanvas(BAND_WIDTH, BAND_HEIGHT);
    drawBand(canvas, layout, 0, "en");
    expect(canvas.pixels.length).toBe(BAND_WIDTH * BAND_HEIGHT);
    // The north letter sits on the scale above the middle.
    const lit = (x0: number, y0: number, x1: number, y1: number): number => {
      let n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (canvas.pixels[y * BAND_WIDTH + x]! > 0) n++;
      return n;
    };
    expect(lit(BAND_WIDTH / 2 - 8, 0, BAND_WIDTH / 2 + 8, 18)).toBeGreaterThan(10);
    // A count at an edge.
    expect(lit(0, COUNT_TOP, 60, BAND_HEIGHT) + lit(BAND_WIDTH - 60, COUNT_TOP, BAND_WIDTH, BAND_HEIGHT)).toBeGreaterThan(10);
  });

  it("changes its key when the picture changes, not otherwise", () => {
    const sights = sightsFrom(HERE, demoPeaks(HERE));
    const a = layoutBand(bandPicks(sights, 90, "near"), 90, "de");
    const b = layoutBand(bandPicks(sights, 90, "near"), 90, "de");
    const c = layoutBand(bandPicks(sights, 120, "near"), 120, "de");
    expect(bandKey(a, 90)).toBe(bandKey(b, 90));
    expect(bandKey(a, 90)).not.toBe(bandKey(c, 120));
  });

  it("renders two 288 x 144 PNG halves", async () => {
    const sights = sightsFrom(HERE, demoPeaks(HERE));
    const [left, right] = await renderBandPngs(layoutBand(bandPicks(sights, 200, "high"), 200, "de"), 200, "de");
    for (const png of [left, right]) {
      expect([...png.slice(1, 4)].map((c) => String.fromCharCode(c)).join("")).toBe("PNG");
      const view = new DataView(png.buffer, png.byteOffset);
      expect(view.getUint32(16)).toBe(288);
      expect(view.getUint32(20)).toBe(144);
    }
  });
});

describe("the peaks page on the glasses", () => {
  const sights = sightsFrom(HERE, demoPeaks(HERE));
  const ready: Extract<PeakPageState, { phase: "ready" }> = { phase: "ready", sights, pick: "near", view: "band", selected: 0 };

  it("fits the display: two band images, the text below, one container takes input", () => {
    const page = buildPage(bandView(ready, { deg: 245, source: "gps" }, 25, "de"), "peaks");
    const images = page.imageObject ?? [];
    expect(images).toHaveLength(2);
    for (const image of images) {
      expect(image.width).toBeLessThanOrEqual(288);
      expect(image.height).toBeLessThanOrEqual(144);
      expect((image.xPosition ?? 0) + (image.width ?? 0)).toBeLessThanOrEqual(576);
    }
    const texts = page.textObject ?? [];
    expect(texts.filter((t) => t.isEventCapture === 1).map((t) => t.containerName)).toEqual(["capture"]);
    for (const text of texts.filter((t) => t.containerName !== "capture")) {
      expect(text.yPosition ?? 0).toBeGreaterThanOrEqual(144);
      expect((text.yPosition ?? 0) + (text.height ?? 0)).toBeLessThanOrEqual(288);
    }
  });

  it("says where it faces, how many peaks, and the highest", () => {
    const view = bandView(ready, { deg: 245, source: "gps" }, 25, "de");
    expect(view.body[0]).toBe("Richtung 245° SW · GPS-Kurs");
    expect(view.body[1]).toBe(`${sights.length} Gipfel bis 25 km · die nächsten`);
    expect(view.body[2]).toMatch(/^Höchster: Demo Watzmann 2713 m · \d+ km$/);
    for (const line of view.body) expect(line.length).toBeLessThanOrEqual(LINE_WIDTH);
    expect(bandView({ ...ready, sights: [] }, { deg: 0, source: "north" }, 10, "en").body[2]).toBe("No named peak within 10 km.");
  });

  it("lists the peaks by distance with the cursor, within one line each", () => {
    const view = peakListView({ ...ready, view: "list", selected: 6 }, 25, "en");
    expect(view.header).toBe(`OPENGLANCE · peaks 25 km · 7/${sights.length}`);
    expect(view.body.length).toBeLessThanOrEqual(LIST_ROWS);
    expect(view.body.filter((row) => row.startsWith("→ "))).toHaveLength(1);
    for (const row of view.body) expect(row.length).toBeLessThanOrEqual(LINE_WIDTH);
    expect(listRow(sights[0]!, false, "de")).toBe("   1,1 km · NO · Demo Kapuzinerberg 636 m");
  });

  it("keeps every glasses text of the peaks page within one 46-character line", () => {
    for (const locale of locales) {
      for (const [key, text] of Object.entries(messages[locale])) {
        if (!key.startsWith("k.") && key !== "l.peaks") continue;
        // Header and footer span the full width (56), the body rows are 46.
        expect(text.length, key).toBeLessThanOrEqual(/Footer|Header/.test(key) ? 56 : 46);
      }
    }
  });
});
