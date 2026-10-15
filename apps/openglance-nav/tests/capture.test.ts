import { describe, expect, it } from "vitest";
import { validateEvenHubPageContainer } from "@evenrealities/even_hub_sdk";
import { buildPage, CAPTURE, type PageKind } from "../src/glasses/render";
import type { NavView } from "../src/glasses/view";

/**
 * Hardware finding 15.10. (0.17.6 step log): on the driving view swipes and
 * holds never reached the app - the capturing text line overflowed and the
 * firmware scrolled it instead. Every image page now catches input with an
 * empty full-screen text box behind everything, as the Even docs advise.
 */
const MAX_CONTAINERS_ON_HARDWARE = 8;

const view: NavView = {
  header: "OPENGLANCE",
  body: ["Mirabellplatz", "in 300 m rechts abbiegen auf die Schwarzstraße", "dann links", "noch eine Zeile"],
  footer: "Tippen = Stopp · Wischen = Karte · 2× = Ende",
  speed: "48",
};

describe("input catcher on the image pages", () => {
  for (const kind of ["turns", "hud", "overview", "peaks"] as PageKind[]) {
    it(`${kind}: only the empty full-screen catcher takes input, lowest of all, and the page is valid`, () => {
      const page = buildPage(view, kind);
      const texts = page.textObject ?? [];
      const capturing = texts.filter((t) => t.isEventCapture === 1);
      expect(capturing).toHaveLength(1);
      const catcher = capturing[0]!;
      expect(catcher).toMatchObject({ containerID: CAPTURE.id, containerName: CAPTURE.name, content: " ", xPosition: 0, yPosition: 0, width: 576, height: 288 });
      const others = [...texts.filter((t) => t !== catcher), ...(page.imageObject ?? [])];
      for (const other of others) expect(other.zOrderIndex ?? 0).toBeGreaterThan(catcher.zOrderIndex ?? 0);
      const ids = [...texts, ...(page.imageObject ?? [])].map((c) => c.containerID);
      expect(new Set(ids).size).toBe(ids.length);
      expect(page.containerTotalNum).toBe(ids.length);
      // Even docs: at most 4 image containers and 8 others per page.
      expect((page.imageObject ?? []).length).toBeLessThanOrEqual(4);
      expect(texts.length).toBeLessThanOrEqual(8);
      // Measured on the real glasses (15.10.): pages with 9 or 10 containers were refused, 8 and 7 came up.
      expect(page.containerTotalNum).toBeLessThanOrEqual(MAX_CONTAINERS_ON_HARDWARE);
      // Names well under the docs' "max 16 chars"; image sides in multiples of 8 (what the accepted pages have).
      for (const c of [...texts, ...(page.imageObject ?? [])]) expect((c.containerName ?? "").length).toBeLessThanOrEqual(13);
      for (const i of page.imageObject ?? []) expect([(i.width ?? 0) % 8, (i.height ?? 0) % 8]).toEqual([0, 0]);
      const result = validateEvenHubPageContainer(page);
      expect(result.valid, JSON.stringify(result)).toBe(true);
    });
  }

  it("text page: the body still takes input (list and help scroll in the firmware)", () => {
    const page = buildPage(view, "text");
    expect(page.textObject?.filter((t) => t.isEventCapture === 1).map((t) => t.containerName)).toEqual(["body"]);
  });
});
