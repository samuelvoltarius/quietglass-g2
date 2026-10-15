import { describe, expect, it } from "vitest";
import { buildView, LINE_WIDTH, MAX_ROWS, OVERVIEW_WIDTH_CHARS, ROW_WIDTH, type NavView, type ViewOptions } from "../src/glasses/view";
import { chargerView, helpView, listView, voiceView, type ListAppt, type VoiceState } from "../src/glasses/picker";
import { bandView, peakListView, type PeakPageState } from "../src/peaks/view";
import { bandPicks, demoPeaks, sightsFrom } from "../src/peaks/peaks";
import { createMockProvider } from "../src/routing/provider";
import { progressOf, startNavigation, update } from "../src/nav/navigator";
import { EMPTY_DATA, type NavData } from "../src/storage/persist";
import { locales, type Locale } from "../src/i18n";
import { messages } from "../src/messages";
import { armedFooter, footer, ft, FOOTER_WIDTH } from "../src/glasses/footer";

/**
 * QIS v1 (docs/BEDIENSTANDARD.md): header `OPENGLANCE · state`, footer in the
 * order Tippen/Wischen/Halten/2× ending in back/exit, every row within the
 * full-width budget in German and English, plus the wording glossary.
 */

const base: ViewOptions = { mode: "walking", navigating: true, rerouting: false, error: null, mock: false, waitingForFix: false };

async function progress(arrived = false, offRoute = false) {
  const { route } = await createMockProvider().route({ from: { lat: 52, lon: 13 }, to: { lat: 53, lon: 14 }, mode: "walking" });
  const p = progressOf(update(startNavigation(route!), route!.shape[2]!));
  return { ...p, arrived, offRoute };
}

const HERE = { lat: 47.8, lon: 13.05 };
const sights = sightsFrom(HERE, demoPeaks(HERE));
const ready: Extract<PeakPageState, { phase: "ready" }> = { phase: "ready", sights, pick: "near", view: "band", selected: 0 };
const data: NavData = {
  ...EMPTY_DATA,
  places: [{ id: "p1", label: "Zuhause", at: { lat: 47, lon: 13 } }],
  chargers: true,
  peaks: true,
};
const results = [{ label: "Tamsweg", detail: "Salzburg", at: { lat: 47.1, lon: 13.8 } }];
const voiceStates: VoiceState[] = [
  { phase: "recording" },
  { phase: "working" },
  { phase: "results", heard: "Tamsweg", results, selected: 0, saved: false },
  { phase: "results", heard: "Tamsweg", results, selected: 0, saved: true },
  { phase: "error", key: "v.noMic" },
];

const appts: ListAppt[] = [
  { appt: { key: "a1", title: "Testkunde Kaffeehaus – Vorgespraech", time: "10:30", startMs: 0, at: { lat: 47.9, lon: 13.12 }, placeLabel: "Musterdorf am See" }, leave: "los in 12 min" },
  { appt: { key: "a2", title: "Werkstatt", time: "15:00", startMs: 0, at: { lat: 48.3, lon: 14.29 }, placeLabel: "Linz" }, leave: "leave in 85 min" },
];

async function allViews(locale: Locale): Promise<{ name: string; view: NavView; full: boolean }[]> {
  const turn = await progress();
  const out: { name: string; view: NavView; full: boolean }[] = [];
  const add = (name: string, view: NavView, full = true): void => { out.push({ name, view, full }); };
  for (const canSpeak of [true, false]) add("list" + canSpeak, listView(data, 0, locale, canSpeak));
  add("list-empty", listView(EMPTY_DATA, 0, locale));
  // Today's appointments head the list (private build); each row within the width, any cursor position.
  for (const cursor of [0, 1, 2]) add("list-appts" + cursor, listView(data, cursor, locale, true, appts));
  add("arrived-appt", buildView({ ...turn, arrived: true }, { ...base, locale, appointment: { startMs: 0, title: "Testkunde Kaffeehaus Vorgespraech" } }));
  add("help", helpView(locale));
  for (const state of voiceStates) add("voice-" + state.phase, voiceView(state, locale));
  add("chargers-loading", chargerView({ phase: "loading", key: "c.loading" }, locale));
  add("chargers-error", chargerView({ phase: "error", key: "c.none" }, locale));
  add("peaks-band", bandView(ready, { deg: 0, source: "north" }, 25, locale), false);
  add("peaks-list", peakListView({ ...ready, view: "list" }, 25, locale));
  add("peaks-error", bandView({ phase: "error", key: "k.none" }, { deg: 0, source: "north" }, 25, locale), false);
  add("idle", buildView(null, { ...base, navigating: false, destination: "Büro", locale }));
  add("error", buildView(null, { ...base, error: "x", locale }));
  add("starting", buildView(null, { ...base, status: "…", destination: "Büro", locale }));
  add("arrived", buildView({ ...turn, arrived: true }, { ...base, locale }));
  add("off-route", buildView({ ...turn, offRoute: true }, { ...base, locale }));
  add("armed-turns", buildView(turn, { ...base, locale, armedStop: true, destination: "Büro" }));
  add("armed-overview", buildView(turn, { ...base, locale, armedStop: true, layout: "overview" }), false);
  return out;
}

const order = (locale: Locale): string[] => (locale === "de" ? ["Tippen", "Wischen", "Halten", "2×"] : ["Tap", "Swipe", "Hold", "2×"]);

describe("QIS v1 on the glasses", () => {
  for (const locale of locales) {
    it(`${locale}: header, footer and rows fit; footers keep the gesture order`, async () => {
      for (const { name, view, full } of await allViews(locale)) {
        expect(view.header.length, name + " header").toBeLessThanOrEqual(ROW_WIDTH);
        expect(view.footer.length, name + " footer").toBeLessThanOrEqual(ROW_WIDTH);
        expect(view.body.length, name).toBeLessThanOrEqual(MAX_ROWS);
        for (const row of view.body) expect(row.length, name + ": " + row).toBeLessThanOrEqual(LINE_WIDTH);
        if (!full) continue;
        // A page with a header names the app first.
        if (view.header !== "") expect(view.header.startsWith("OPENGLANCE · "), name).toBe(true);
        if (view.footer !== "" && !/^(demo|Demo)/.test(view.footer)) {
          const positions = order(locale).map((word) => view.footer.indexOf(word)).filter((i) => i >= 0);
          expect(positions, name + ": " + view.footer).toEqual([...positions].sort((a, b) => a - b));
        }
      }
    });

    it(`${locale}: every gesture footer ends in back, exit or cancel`, async () => {
      const end = locale === "de" ? /2× = (zurück|Ende|abbrechen)$/ : /2× = (back|exit|cancel)$/;
      for (const { name, view } of await allViews(locale)) {
        if (view.footer === "") continue;
        // The voice recording footer and similar single-purpose pages end the same way.
        expect(view.footer, name).toMatch(end);
      }
    });
  }

  it("the armed stop is readable over the map: one short line", async () => {
    const turn = await progress();
    for (const locale of locales) {
      const view = buildView(turn, { ...base, locale, armedStop: true, layout: "overview" });
      expect(view.body[0]!.length).toBeLessThanOrEqual(OVERVIEW_WIDTH_CHARS);
      expect(view.body[0]).toBe(locale === "de" ? "Nochmal tippen = Stopp" : "Tap again = stop");
    }
    const text = buildView(turn, { ...base, locale: "de", armedStop: true, destination: "Büro" });
    expect(text.header).toBe("OPENGLANCE · Stopp?");
    expect(text.footer).toBe("Nochmal tippen = stoppen · Wischen/2× = abbrechen");
  });

  it("QIS v1.2: the root list has no help row (the side menu holds it); the travel mode is the last row", () => {
    expect(listView(data, 0, "de").body.at(-1)).toMatch(/^ {4}Unterwegs:/);
    expect(listView(data, 0, "en").body.at(-1)).toMatch(/^ {4}Travel:/);
    expect(listView(data, 0, "de").body.join(" ")).not.toContain("Hilfe");
    expect(helpView("de").header).toBe("OPENGLANCE · Hilfe");
    expect(helpView("en").body).toHaveLength(7);
  });

  it("uses the glossary on the glasses: German has no Tap, Wisch or 2x; nobody writes Doppeltipp or Double tap", () => {
    const glasses = (locale: Locale): string =>
      Object.entries(messages[locale]).filter(([key]) => /^(g|l|v|c|k|h)\./.test(key)).map(([, text]) => text).join("\n");
    expect(glasses("de")).not.toMatch(/\bTap\b|\bWisch\b|\b2x\b|Doppeltipp/);
    expect(glasses("en")).not.toMatch(/\b2x\b|Double tap|Doppeltipp/);
  });

  it("picks the near peaks without a change (sanity for the band footer test data)", () => {
    expect(bandPicks(sights, 0, "near").shown.length).toBeGreaterThan(0);
  });

  it("QIS v1.2: footers come from the shared footer() helper - no footer sentence is hand-built in the message table", () => {
    for (const locale of locales) {
      for (const key of Object.keys(messages[locale])) expect(key, key).not.toMatch(/Footer$/);
    }
    expect(FOOTER_WIDTH).toBe(ROW_WIDTH);
    expect(footer("de", { tap: "los", swipe: "wählen", hold: "sprechen" }, "exit")).toBe("Tippen = los · Halten = sprechen · 2× = Ende");
    expect(footer("de", { tap: "los", swipe: "wählen", hold: "merken" }, "back", "Gemerkt ●")).toBe("Gemerkt ● · Tippen = los · Halten = merken · 2× = zurück");
    expect(footer("en", { tap: "go" }, "back")).toBe("Tap = go · 2× = back");
    expect(footer("de", { tap: "x".repeat(80) }, "back").length).toBeLessThanOrEqual(FOOTER_WIDTH);
    expect(armedFooter("de", "stoppen")).toBe("Nochmal tippen = stoppen · Wischen/2× = abbrechen");
    expect(armedFooter("en", "stop")).toBe("Tap again = stop · Swipe/2× = cancel");
    expect(armedFooter("de", "x".repeat(80)).length).toBeLessThanOrEqual(FOOTER_WIDTH);
    expect(ft("de", "exit", { tap: "go", hold: "speak" })).toBe("Tippen = los · Halten = sprechen · 2× = Ende");
    expect(ft("en", "back", { tap: "goThere", swipe: "choose", hold: "band" })).toBe("Tap = go · Swipe = choose · Hold = band · 2× = back");
  });

  it("QIS v1.2: the side menu labels fit the firmware's 32 bytes, in both languages", () => {
    for (const locale of locales) {
      const labels = Object.entries(messages[locale]).filter(([key]) => key.startsWith("m.")).map(([, text]) => text);
      expect(labels.length).toBe(6);
      for (const label of labels) expect(new TextEncoder().encode(label).length, label).toBeLessThanOrEqual(32);
    }
  });
});
