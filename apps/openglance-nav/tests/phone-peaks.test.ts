import { describe, expect, it } from "vitest";
import { peaksTemplate, type PeakListState } from "../src/ui/phone";
import { EMPTY_DATA } from "../src/storage/persist";
import { demoPeaks, sightsFrom } from "../src/peaks/peaks";

const HERE = { lat: 47.8, lon: 13.05 };

describe("the peaks tab on the phone", () => {
  const empty: PeakListState = { busy: false, sights: null, errorKey: null, fromCache: false, radiusKm: 25 };

  it("offers radius, facing and the load button, and always credits OpenStreetMap", () => {
    const html = peaksTemplate(EMPTY_DATA, empty, "de");
    for (const r of [10, 25, 50]) expect(html).toContain(`<option value="${r}"`);
    expect(html).toContain('<option value="25" selected>');
    expect(html).toContain('<option value="" selected>Norden oben</option>');
    expect(html).toContain("Gipfel laden");
    expect(html).toContain("© OpenStreetMap-Mitwirkende");
    expect(peaksTemplate(EMPTY_DATA, empty, "en")).toContain("© OpenStreetMap contributors");
  });

  it("lists the peaks with distance, bearing and elevation, each with a button to go there", () => {
    const sights = sightsFrom(HERE, [...demoPeaks(HERE), { id: 9, name: "<b>Bad</b>", ele: 999, at: { lat: 47.81, lon: 13.05 } }], 25_000);
    const html = peaksTemplate({ ...EMPTY_DATA, peakFacing: 90 }, { ...empty, sights, fromCache: true }, "de");
    expect(html).toContain(`${sights.length} Gipfel bis 25 km`);
    expect(html).toContain("keine Anfrage");
    expect(html).toContain("Demo Kapuzinerberg · 636 m<br /><small>1,1 km · NO");
    expect(html).toContain('data-peak="0"');
    expect(html).toContain('<option value="90" selected>O · 90°</option>');
    expect(html).not.toContain("<b>Bad</b>");
    expect(html).toContain("&lt;b&gt;Bad&lt;/b&gt;");
  });

  it("explains a failure in words", () => {
    const html = peaksTemplate(EMPTY_DATA, { ...empty, errorKey: "k.cooldown", waitS: 12 }, "en");
    expect(html).toContain("Asked a moment ago.");
  });
});
