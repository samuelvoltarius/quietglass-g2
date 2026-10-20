/** QUS v1: start page, captions as a reading view, the status cockpit (pure model, tile diff), footers, glossary, phone tabs. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { footer, ROW_WIDTH } from "../src/glasses/footer";
import { captionsView, headerLine, progress, startRows, startView, type PodState } from "../src/glasses/view";
import { cockpitHint, cockpitModel, statusCells, statusGraphic, statusTone } from "../src/cockpit/model";
import { cellBoxes, composeCockpit, modelKey, type CockpitModel } from "../src/cockpit/compose";
import { createTileSender, tileSlots } from "../src/screen/sender";
import { frameKey, tiles } from "../src/screen/frame";
import { pixelBackend } from "../src/screen/text";
import { locales, type Locale } from "../src/i18n";
import { messages } from "../src/messages";
import { LINE_WIDTH } from "../src/podcast/view";
import type { Caption } from "../src/podcast/parse";
import { TABS, bannerFor, captionsInner, isFirstRun, mountPhoneUi, nowInner, pillOf, setupInner, type PhoneView } from "../src/ui/phone";

const NOW = new Date(2026, 9, 17, 14, 5).getTime();
const backend = pixelBackend();
const captions: Caption[] = Array.from({ length: 5 }, (_, i) => ({ start: i * 60, end: i * 60 + 55, text: `Satz ${i + 1} des Gesprächs über die Folge.` }));
const state = (over: Partial<PodState> = {}): PodState => ({ locale: "de", captions, episode: "Folge 12: Neues vom Land", cursor: 2, source: "FILE", playing: false, failure: "", ...over });
const ORDER: Record<"de" | "en", string[]> = { de: ["Tippen", "Wischen", "Halten", "2×"], en: ["Tap", "Swipe", "Hold", "2×"] };

describe("start page and captions page", () => {
  it("the start page has two entries with a dot on the cursor; header `PodCaption · state`, one footer line", () => {
    expect(startRows()).toEqual([{ kind: "captions" }, { kind: "status" }]);
    const view = startView(state({ playing: true }), 1);
    expect(view.header).toBe("PodCaption · ● läuft");
    expect(view.body).toEqual(["  Untertitel · Folge 12: Neues vom Land", "● Übersicht · 50 %"]);
    expect(view.footer).toBe("Tippen = öffnen · Wischen = wählen · 2× = Ende");
    expect(startView(state({ failure: "Download fehlgeschlagen." }), 0).body.at(-1)).toBe("! Download fehlgeschlagen.");
  });
  it("the captions page is a reading view: the episode as the head, the captions below, `Untertitel · ● läuft · Datei`", () => {
    const view = captionsView(state({ playing: true }));
    expect(view.header).toBe("Untertitel · ● läuft · DATEI");
    expect(view.body[0]).toBe("FOLGE 12: NEUES VOM LAND");
    expect(view.body.join("\n")).toContain("02:00  Satz 3");
    expect(view.body.length).toBeLessThanOrEqual(7);
    expect(view.footer).toBe("Tippen = Pause · 2× = zurück");
    expect(captionsView(state()).footer).toBe("Tippen = Start · 2× = zurück");
  });
  it("a failure is one row under the captions", () => {
    const view = captionsView(state({ failure: "Abruf fehlgeschlagen." }));
    expect(view.body.at(-1)).toBe("! Abruf fehlgeschlagen.");
    expect(view.body.length).toBeLessThanOrEqual(7);
  });
  it("progress counts the way through the captions", () => {
    expect(progress({ captions, cursor: 0 })).toBe(0);
    expect(progress({ captions, cursor: 2 })).toBe(50);
    expect(progress({ captions, cursor: 99 })).toBe(100);
    expect(progress({ captions: [], cursor: 0 })).toBe(0);
  });
  for (const locale of locales) {
    it(`${locale}: header, footer and rows fit one row on every page, 2× is never dropped`, () => {
      for (const playing of [true, false]) for (const source of ["DEMO", "FILE", "RSS"] as const) {
        const s = state({ locale, playing, source, failure: messages[locale]?.["errServerGlasses"] ?? "" });
        for (const view of [startView(s, 0), captionsView(s)]) {
          expect(view.header.length, view.header).toBeLessThanOrEqual(LINE_WIDTH);
          expect(view.footer.length, view.footer).toBeLessThanOrEqual(ROW_WIDTH);
          expect(view.footer.split(" · ").at(-1)?.startsWith("2× = "), view.footer).toBe(true);
          expect(view.body.length).toBeLessThanOrEqual(7);
          for (const row of view.body) expect(row.length, row).toBeLessThanOrEqual(LINE_WIDTH);
        }
        expect(cockpitHint(locale, playing).length).toBeLessThanOrEqual(ROW_WIDTH);
      }
    });
  }
  for (const locale of ["de", "en"] as const) {
    it(`${locale}: footers keep Tippen, Wischen, Halten, 2× in order and end in Ende/zurück`, () => {
      for (const view of [startView(state({ locale }), 0), captionsView(state({ locale })), captionsView(state({ locale, playing: true }))]) {
        const parts = view.footer.split(" · ");
        const at = parts.map((part) => ORDER[locale].findIndex((w) => part.startsWith(`${w} =`)));
        expect(at.every((i) => i >= 0), view.footer).toBe(true);
        expect(at).toEqual([...at].sort((a, b) => a - b));
      }
    });
  }
  it("headerLine adds the source only when asked", () => {
    expect(headerLine("en", "Captions", state({ locale: "en", source: "DEMO" }), true)).toBe("Captions · paused · SAMPLE");
    expect(headerLine("en", "PodCaption", state({ locale: "en" }))).toBe("PodCaption · paused");
  });
});

describe("status cockpit", () => {
  it("the headline is playing or paused; the tone follows", () => {
    expect(cockpitModel(state({ playing: true }), NOW).headline).toEqual(["LÄUFT"]);
    expect(cockpitModel(state(), NOW).headline).toEqual(["PAUSE"]);
    expect(statusTone({ playing: true })).toBe("ok");
    expect(statusTone({ playing: false })).toBe("offline");
  });
  it("cells: line, time, length, source", () => {
    const cells = statusCells(state());
    expect(cells.map((c) => c.label)).toEqual(["Zeile", "Zeit", "Dauer", "Quelle"]);
    expect(cells.map((c) => c.value)).toEqual(["3/5", "02:00", "04:55", "DATEI"]);
    expect(statusCells(state({ captions: [] })).map((c) => c.value)).toEqual(["–", "–", "–", "DATEI"]);
    expect(cellBoxes(cells).length).toBeLessThanOrEqual(6);
  });
  it("the graphic is a ring filled to the progress; the centre says it in percent", () => {
    expect(statusGraphic(state())).toEqual({ kind: "gauge", value: 0.5, center: "50%", sub: "Fortschritt", tone: "offline" });
    expect(statusGraphic(state({ captions: [] }))).toMatchObject({ value: null, center: "–" });
  });
  it("the caption is the episode (a failure takes its place); one hint line", () => {
    expect(cockpitModel(state(), NOW).caption).toBe("Folge 12: Neues vom Land");
    expect(cockpitModel(state({ failure: "Abruf fehlgeschlagen." }), NOW).caption).toBe("Abruf fehlgeschlagen.");
    expect(cockpitHint("de", false)).toBe("Tippen = Start · 2× = zurück");
    expect(cockpitHint("en", true)).toBe("Tap = pause · 2× = back");
    expect(cockpitModel(state(), NOW).title).toBe("PODCAPTION");
    expect(cockpitModel(state(), NOW).clock).toBe("14:05");
  });
});

describe("tile diff", () => {
  const slots = tileSlots(21, "pod");
  const frameOf = (m: CockpitModel) => composeCockpit(m, backend);
  it("an unchanged state draws the same frame, tile for tile", () => {
    expect(tiles(frameOf(cockpitModel(state(), NOW))).map(frameKey)).toEqual(tiles(frameOf(cockpitModel(state(), NOW))).map(frameKey));
  });
  it("the clock alone changes only the top right tile", () => {
    const m = cockpitModel(state(), NOW);
    const a = tiles(frameOf(m)).map(frameKey); const b = tiles(frameOf({ ...m, clock: "14:06" })).map(frameKey);
    expect(b.map((key, i) => (key === a[i] ? 0 : 1))).toEqual([0, 1, 0, 0]);
  });
  it("the sender sends all four tiles once, then nothing for an identical frame, then only what changed", async () => {
    const sent: number[] = [];
    const sender = createTileSender(slots, async (slot) => { sent.push(slot.id); return true; }, (frame) => new Uint8Array(frame.pixels));
    const m = cockpitModel(state(), NOW);
    await sender.push(frameOf(m));
    expect(sent).toHaveLength(4);
    await sender.push(frameOf(cockpitModel(state(), NOW)));
    expect(sent).toHaveLength(4);
    await sender.push(frameOf({ ...m, clock: "14:06" }));
    expect(sent.slice(4)).toEqual([slots[1].id]);
  });
  it("modelKey changes exactly with what is drawn", () => {
    const m = cockpitModel(state(), NOW);
    expect(modelKey(m)).toBe(modelKey(cockpitModel(state(), NOW)));
    expect(modelKey(m)).not.toBe(modelKey({ ...m, clock: "14:06" }));
  });
});

describe("words", () => {
  it("there is no help page any more: no help keys, no Hilfe-Seite in the demo text", () => {
    for (const locale of locales) expect(Object.keys(messages[locale] ?? {}).filter((key) => /^(h[1-5]|helpTitle|actHelp|mHelp|mSwipe)/.test(key)), locale).toEqual([]);
    expect(messages["de"]?.["demo4"]).not.toMatch(/Hilfe/);
  });
  it("German never says Tap, Wisch, 2x or Doppeltipp; English never 2x or double-tap", () => {
    for (const [key, text] of Object.entries(messages["de"] ?? {})) expect(text, key).not.toMatch(/\bTap\b|\bWisch\b|\b2x\b|Doppeltipp|doppeltipp/);
    for (const [key, text] of Object.entries(messages["en"] ?? {})) expect(text, key).not.toMatch(/\b2x\b|double-tap/i);
  });
  it("no status code reaches the glasses", () => {
    for (const locale of locales as readonly Locale[]) expect(messages[locale]?.["errServerGlasses"] ?? "", locale).not.toMatch(/\d|HTTP|\{status\}/);
  });
  it("the shared footer builder drops the swipe first, then the hold, never the 2×", () => {
    expect(footer("de", { tap: "Pause", swipe: "blättern", hold: "x".repeat(40) }, "exit").endsWith("2× = Ende")).toBe(true);
    expect(footer("en", { tap: "play", swipe: "scroll" }, "exit")).toBe("Tap = play · Swipe = scroll · 2× = exit");
    expect(footer("de", { tap: "x".repeat(60) }, "back").length).toBeLessThanOrEqual(ROW_WIDTH);
  });
});

describe("phone view models", () => {
  const view = (over: Partial<PodState> = {}, detail = ""): PhoneView => ({ state: state(over), detail });
  it("has exactly three tabs, Jetzt / Untertitel / Einstellungen", () => {
    expect(TABS.map((tab) => tab.id)).toEqual(["now", "captions", "settings"]);
    expect(TABS.map((tab) => messages["de"]?.[tab.key])).toEqual(["Jetzt", "Untertitel", "Einstellungen"]);
  });
  it("the hero value is the progress, one play/pause button, the next captions as a card strip", () => {
    const html = nowInner(view());
    expect(html).toContain("hero-card");
    expect(html).toContain("<strong>50%</strong>");
    expect(html).toContain('id="toggle"');
    expect(html).toContain("Abspielen");
    expect(nowInner(view({ playing: true }))).toContain("Pause");
    expect((html.match(/<div class="host/g) ?? []).length).toBe(3);
  });
  it("the banner carries the one message that counts", () => {
    expect(bannerFor(view({ source: "DEMO" })).tone).toBe("none");
    expect(bannerFor(view()).tone).toBe("ok");
    expect(bannerFor(view({}, "Abruf fehlgeschlagen (Code 503).")).tone).toBe("critical");
    expect(bannerFor(view({}, "Abruf fehlgeschlagen (Code 503).")).text).toContain("503");
  });
  it("the pill: playing or paused", () => {
    expect(pillOf(state({ playing: true }))).toEqual({ text: "● läuft", on: true });
    expect(pillOf(state())).toEqual({ text: "Pause", on: false });
  });
  it("the captions tab lists what comes next as cards", () => {
    expect((captionsInner(view()).match(/<div class="host/g) ?? []).length).toBe(3);
  });
  it("the first-run checklist has three steps and ticks them off", () => {
    expect(isFirstRun({ source: "DEMO" })).toBe(true);
    expect(isFirstRun({ source: "FILE" })).toBe(false);
    expect(setupInner({ source: "DEMO", cursor: 0, locale: "de" }).match(/<li/g)).toHaveLength(3);
    expect(setupInner({ source: "FILE", cursor: 2, locale: "de" }).match(/class="done"/g)).toHaveLength(3);
    expect(setupInner({ source: "DEMO", cursor: 0, locale: "de" })).toContain("Beispiel");
  });
});

describe("phone page", () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  it("three tabs in the bar, Jetzt / Untertitel / Einstellungen; the swipe switch is in the settings; a first run opens on them", () => {
    let html = "";
    const root = { set innerHTML(value: string) { html = value; }, get innerHTML() { return html; }, querySelector: () => null, querySelectorAll: () => [] };
    vi.stubGlobal("document", { querySelector: (selector: string) => (selector === "#app" ? root : null) });
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
    mountPhoneUi({ getView: () => ({ state: state({ source: "DEMO" }), detail: "" }), toggle: () => undefined, openFile: () => undefined, usePaste: () => undefined, connect: () => undefined, setLocale: () => undefined, getInvert: () => false, setInvert: () => undefined, getEndpoint: () => "http://127.0.0.1:8789" });
    expect([...html.matchAll(/data-tab-go="(\w+)"/g)].map((m) => m[1])).toEqual(["now", "captions", "settings"]);
    expect([...html.matchAll(/<\/span>([^<]+)<\/button>/g)].map((m) => m[1])).toEqual(["Jetzt", "Untertitel", "Einstellungen"]);
    expect(html.slice(html.indexOf('data-tab="settings"'))).toContain('id="invert"');
    expect(html.slice(html.indexOf('data-tab="settings"'))).toContain('id="endpoint"');
    expect(html).toContain("In drei Schritten");
    expect(html).toContain('id="transcript-file"');
  });
});
