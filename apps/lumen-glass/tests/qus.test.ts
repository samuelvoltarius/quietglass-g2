import { afterEach, describe, expect, it, vi } from "vitest";
import { footer, GESTURE_WORDS } from "../src/glasses/footer";
import { BODY_COLS, HEADER_COLS, LINE_COLS, MAX_BODY_ROWS, buildView, startRows, type LumenView, type ViewOptions } from "../src/glasses/view";
import { cockpitHint, cockpitModel, mothCells, mothGraphic, mothTone, windowTime } from "../src/cockpit/model";
import { cellBoxes, composeCockpit, modelKey, type CockpitModel } from "../src/cockpit/compose";
import { createTileSender, tileSlots } from "../src/screen/sender";
import { frameKey, tiles } from "../src/screen/frame";
import { pixelBackend } from "../src/screen/text";
import { locales, type Locale } from "../src/i18n";
import { messages } from "../src/messages";
import { parseStatus, type LumenStatus } from "../src/lumen/client";
import { TABS, bannerFor, isFirstRun, mountPhoneUi, nowInner, pillOf, questInner, setupInner, type PhoneView } from "../src/ui/phone";
import { EMPTY_DATA } from "../src/storage/persist";

/**
 * QUS v1 (docs/UI-STANDARD.md): header `Mode · ● live`, ONE footer line in the order Tippen/Wischen/Halten/2×
 * ending in back/exit, every row within the display budget in German and English; the moth as a cockpit
 * image whose model is pure (headline, cells, graphic, hint), the tile diff, the phone with exactly three tabs.
 */
const NOW = new Date(2026, 9, 17, 14, 5).getTime();
const backend = pixelBackend();

function status(over: { quest?: Record<string, unknown> | null; zustand?: string; licht?: number; window?: Record<string, unknown> | null; streak?: number } = {}): LumenStatus {
  return parseStatus({
    kreatur: { licht: over.licht ?? 95, zustand: over.zustand ?? "leuchtet", geste: "kreist unermüdlich und strahlend im allerletzten Abendlicht über dem See", streak: over.streak ?? 365 },
    quest: over.quest === null ? null : {
      id: 7, titel: "Bird's Eye Pattern", aufgabe: "Finde ein wiederkehrendes Muster von oben, zum Beispiel einen Acker, einen Parkplatz oder ein Dach.",
      medium: "video", dauer_min: 120, ...over.quest,
    },
    ...(over.window === null ? {} : { naechstes_lichtfenster: { art: "golden_frueh", in_minuten: 1439, ...over.window } }),
  });
}

function views(locale: Locale): { name: string; view: LumenView }[] {
  const base: Omit<ViewOptions, "phase"> = { result: null, error: null, locale };
  const idle: ViewOptions = { ...base, phase: "idle" };
  const out: { name: string; view: LumenView }[] = [];
  const add = (name: string, view: LumenView): void => { out.push({ name, view }); };
  add("start", buildView(status(), { ...idle, screen: "start" }));
  add("start-demo", buildView(status(), { ...idle, screen: "start", demo: true }));
  add("start-no-quest", buildView(status({ quest: null }), { ...idle, screen: "start", startCursor: 1 }));
  add("start-error", buildView(null, { ...idle, screen: "start", error: "LUMEN unreachable" }));
  add("quest", buildView(status(), idle));
  add("quest-no-quest", buildView(status({ quest: null }), idle));
  add("quest-demo", buildView(status(), { ...idle, demo: true }));
  add("quest-demo-no-quest", buildView(status({ quest: null }), { ...idle, demo: true }));
  add("armed", buildView(status(), { ...idle, confirmQuest: true }));
  add("shooting", buildView(status(), { ...base, phase: "shooting" }));
  add("submitting", buildView(status(), { ...base, phase: "submitting" }));
  add("accepted", buildView(status(), { ...base, phase: "result", result: { ok: true, text: "done" } }));
  add("rejected", buildView(status(), { ...base, phase: "result", result: { ok: false, text: "Foto passt nicht zur Aufgabe ".repeat(8) } }));
  add("connecting", buildView(null, idle));
  for (const key of Object.keys(messages.en).filter((name) => name.startsWith("g.err."))) add(key, buildView(null, { ...idle, error: messages.en[key] ?? "" }));
  add("error-raw", buildView(status(), { ...idle, error: "HTTP 500" }));
  return out;
}

const order = (locale: Locale): string[] => [GESTURE_WORDS[locale].tap, GESTURE_WORDS[locale].swipe, GESTURE_WORDS[locale].hold, "2×"];

describe("text pages: header `Mode · state`, one footer line", () => {
  for (const locale of locales) {
    it(`${locale}: header, footer and body fit`, () => {
      for (const { name, view } of views(locale)) {
        expect(view.header, name).toMatch(/^[^·]+ · .+/);
        expect(view.header.length, name).toBeLessThanOrEqual(HEADER_COLS);
        expect(view.footer.length, name).toBeLessThanOrEqual(LINE_COLS);
        expect(view.body.length, name).toBeLessThanOrEqual(MAX_BODY_ROWS);
        for (const row of view.body) expect(row.length, `${name}: ${row}`).toBeLessThanOrEqual(BODY_COLS);
      }
    });

    it(`${locale}: footers keep the gesture order and end in back, exit or cancel`, () => {
      const end = locale === "de" ? /2× = (zurück|Ende|abbrechen)$/ : /2× = (back|exit|cancel)$/;
      const armed = locale === "de" ? /^Nochmal tippen = / : /^Tap again = /;
      for (const { name, view } of views(locale)) {
        // While the photo is on its way no gesture is offered at all.
        if (name === "submitting") { expect(view.footer).toBe(""); continue; }
        expect(view.footer, name).toMatch(end);
        if (armed.test(view.footer)) continue;
        const positions = order(locale).map((word) => view.footer.indexOf(word)).filter((i) => i >= 0);
        expect(positions, `${name}: ${view.footer}`).toEqual([...positions].sort((a, b) => a - b));
        expect(view.footer.indexOf("2×"), name).toBeGreaterThanOrEqual(0);
      }
    });
  }

  it("the start page has two entries with a dot on the cursor; the first start says how to connect in one line", () => {
    expect(startRows()).toEqual([{ kind: "quest" }, { kind: "moth" }]);
    const start = buildView(status(), { phase: "idle", result: null, error: null, locale: "de", screen: "start" });
    expect(start.header).toBe("Lumen · ● live");
    expect(start.body).toEqual(["● Quest · Bird's Eye Pattern", "  Motte · 95 %"]);
    expect(start.footer).toBe("Tippen = öffnen · Wischen = wählen · 2× = Ende");
    const demo = buildView(status(), { phase: "idle", result: null, error: null, locale: "de", screen: "start", demo: true, startCursor: 1 });
    expect(demo.header).toBe("Lumen · Demo");
    expect(demo.body).toEqual(["  Quest · Bird's Eye Pattern", "● Motte · 95 %", "Demo · Verbindung am Handy einrichten"]);
    const offline = buildView(null, { phase: "idle", result: null, error: "LUMEN unreachable", locale: "en", screen: "start" });
    expect(offline.header).toBe("Lumen · offline");
    expect(offline.body).toContain("LUMEN unreachable");
  });

  it("the quest is a reading view: heading, instruction, medium and duration, `Quest · ● live`, tap = photo", () => {
    const de = buildView(status(), { phase: "idle", result: null, error: null, locale: "de" });
    expect(de.header).toBe("Quest · ● live");
    expect(de.body[0]).toBe("Bird's Eye Pattern");
    expect(de.footer).toBe("Tippen = Foto · Halten = Quest · 2× = zurück");
    const en = buildView(status({ quest: null }), { phase: "idle", result: null, error: null, locale: "en" });
    expect(en.footer).toBe("Hold = quest · 2× = back");
  });

  it("the armed new quest says what the next tap does and how to cancel it", () => {
    const idle = { phase: "idle" as const, result: null, error: null, confirmQuest: true };
    const de = buildView(status(), { ...idle, locale: "de" });
    expect(de.header).toBe("Quest · Neue Quest?");
    expect(de.footer).toBe("Nochmal tippen = neue Quest · Wischen/2× = abbrechen");
    const en = buildView(status(), { ...idle, locale: "en" });
    expect(en.header).toBe("Quest · New quest?");
    expect(en.footer).toBe("Tap again = new quest · Swipe/2× = cancel");
  });

  it("QIS v1.2 no. 7: the demo says in one line how to connect and still fits", () => {
    const de = buildView(status(), { phase: "idle", result: null, error: null, locale: "de", demo: true });
    expect(de.body).toContain("Demo · Verbindung am Handy einrichten");
    expect(de.body.length).toBeLessThanOrEqual(MAX_BODY_ROWS);
    const en = buildView(status(), { phase: "idle", result: null, error: null, locale: "en", demo: true });
    expect(en.body).toContain("Demo · set up the connection on your phone");
    expect(buildView(status(), { phase: "idle", result: null, error: null, locale: "de" }).body.join("\n")).not.toContain("Demo");
  });

  it("drops the swipe part first when the row would be too wide, never the 2×", () => {
    expect(footer("de", { tap: "Foto", swipe: "Hilfe", hold: "neue Quest holen" }, "exit")).toBe("Tippen = Foto · Halten = neue Quest holen · 2× = Ende");
  });

  it("uses the glossary: German has no Tap, Wisch, 2x or Doppeltipp; English no 2x, Double tap; no help page", () => {
    const glasses = (locale: Locale): string => [
      ...Object.entries(messages[locale]).filter(([key]) => /^(g\.|p\.(tap|hold|swipe|doubleTap))/.test(key)).map(([, text]) => text),
      ...views(locale).flatMap(({ view }) => [view.header, view.footer, ...view.body]),
    ].join("\n");
    expect(glasses("de")).not.toMatch(/\bTap\b|\bWisch\b|\b2x\b|Doppeltipp/);
    expect(glasses("en")).not.toMatch(/\b2x\b|Double tap|Doppeltipp/);
    for (const locale of locales) expect(Object.keys(messages[locale]).filter((key) => /help|^m\./.test(key))).toEqual([]);
  });
});

describe("moth cockpit: headline, cells, graphic, hint", () => {
  const input = (s: LumenStatus | null, over: Partial<{ error: string | null; demo: boolean; locale: Locale }> = {}) =>
    ({ status: s, error: over.error ?? null, demo: over.demo ?? false, locale: over.locale ?? "de", now: NOW });

  it("the headline is LUMEN's own word for the moth's state, upper case", () => {
    expect(cockpitModel(input(status({ zustand: "leuchtet" }))).headline).toEqual(["LEUCHTET"]);
    expect(cockpitModel(input(status({ zustand: "eingerollt", licht: 5 }))).headline).toEqual(["EINGEROLLT"]);
    expect(cockpitModel(input(null)).headline).toEqual(["VERBINDE"]);
    expect(cockpitModel(input(null, { error: "LUMEN unreachable" })).headline).toEqual(["OFFLINE"]);
    expect(cockpitModel(input(null, { error: "x", locale: "en" })).headline).toEqual(["OFFLINE"]);
  });

  it("the tone: awake is fine, tired warns, curled up and no connection are offline", () => {
    expect(mothTone({ status: status({ zustand: "wach" }), error: null })).toBe("ok");
    expect(mothTone({ status: status({ zustand: "matt" }), error: null })).toBe("warn");
    expect(mothTone({ status: status({ zustand: "schläfrig" }), error: null })).toBe("warn");
    expect(mothTone({ status: status({ zustand: "eingerollt" }), error: null })).toBe("offline");
    expect(mothTone({ status: null, error: null })).toBe("offline");
  });

  it("the cells: streak, the next light window with its name, open quests", () => {
    const cells = mothCells(status({ streak: 6, window: { art: "golden", in_minuten: 24 } }), "de");
    expect(cells.map((c) => c.label)).toEqual(["Serie", "Gold", "Offen"]);
    expect(cells.map((c) => c.value)).toEqual(["6 T", "24 min", "1"]);
    expect(mothCells(status({ streak: 0, window: null }), "en").map((c) => c.value)).toEqual(["–", "–", "1"]);
    expect(mothCells(status({ window: { art: "blau", in_minuten: 90 } }), "en")[1]).toEqual({ label: "blue", value: "1 h 30" });
    expect(mothCells(null, "de")).toEqual([]);
    expect(cellBoxes(mothCells(status(), "de")).length).toBeLessThanOrEqual(6);
    expect(windowTime(0, "de")).toBe("jetzt");
    expect(windowTime(119.7, "en")).toBe("2 h 00");
  });

  it("the graphic is a ring filled to the moth's light; the centre says it in percent", () => {
    expect(mothGraphic(status({ licht: 72 }), "ok", "de")).toEqual({ kind: "gauge", value: 0.72, center: "72%", sub: "Licht", tone: "ok" });
    expect(mothGraphic(null, "offline", "en")).toMatchObject({ kind: "gauge", value: null, center: "–" });
  });

  it("the caption is LUMEN's own word for what the moth does; the demo says so; one footer hint line", () => {
    expect(cockpitModel(input(status())).caption).toContain("kreist");
    expect(cockpitModel(input(status(), { demo: true })).caption).toBe("Demo");
    expect(cockpitHint("de")).toBe("Tippen = neu laden · 2× = zurück");
    expect(cockpitHint("en")).toBe("Tap = refresh · 2× = back");
    const model = cockpitModel(input(status()));
    expect(model.title).toBe("LUMEN");
    expect(model.clock).toBe("14:05");
  });
});

describe("tile diff", () => {
  const slots = tileSlots(21, "lumen");
  const frameOf = (m: CockpitModel) => composeCockpit(m, backend);
  const model = (): CockpitModel => cockpitModel({ status: status({ licht: 72, zustand: "wach", streak: 6, window: { art: "golden", in_minuten: 24 } }), error: null, demo: false, locale: "de", now: NOW });
  it("an unchanged state draws the same frame, tile for tile", () => {
    expect(tiles(frameOf(model())).map(frameKey)).toEqual(tiles(frameOf(model())).map(frameKey));
  });
  it("the clock alone changes only the top right tile", () => {
    const a = tiles(frameOf(model())).map(frameKey); const b = tiles(frameOf({ ...model(), clock: "14:06" })).map(frameKey);
    expect(b.map((key, i) => (key === a[i] ? 0 : 1))).toEqual([0, 1, 0, 0]);
  });
  it("the sender sends all four tiles once, then nothing for an identical frame, then only what changed", async () => {
    const sent: number[] = [];
    const sender = createTileSender(slots, async (slot) => { sent.push(slot.id); return true; }, (frame) => new Uint8Array(frame.pixels));
    await sender.push(frameOf(model()));
    expect(sent).toHaveLength(4);
    await sender.push(frameOf(model()));
    expect(sent).toHaveLength(4);
    await sender.push(frameOf({ ...model(), clock: "14:06" }));
    expect(sent.slice(4)).toEqual([slots[1].id]);
  });
  it("modelKey changes exactly with what is drawn", () => {
    expect(modelKey(model())).toBe(modelKey(model()));
    expect(modelKey(model())).not.toBe(modelKey({ ...model(), clock: "14:06" }));
  });
});

describe("words", () => {
  it("both languages have every key", () => {
    const keys = Object.keys(messages.de).sort();
    for (const locale of locales) expect(Object.keys(messages[locale]).sort(), locale).toEqual(keys);
  });
});

describe("phone view models", () => {
  const live: PhoneView = { status: status({ licht: 72, zustand: "wach", streak: 6, window: { art: "golden", in_minuten: 24 } }), demo: false, lastError: null };
  it("has exactly three tabs, Jetzt / Quest / Einstellungen", () => {
    expect(TABS.map((tab) => tab.id)).toEqual(["now", "quest", "settings"]);
    expect(TABS.map((tab) => messages.de[tab.key])).toEqual(["Jetzt", "Quest", "Einstellungen"]);
  });
  it("the hero value is the moth's light, one photo button, a card with the quest", () => {
    const html = nowInner(live, "de");
    expect(html).toContain("hero-card");
    expect(html).toContain("<strong>72</strong>");
    expect(html).toContain('id="shoot"');
    expect(html).toContain('class="strip"');
    expect(nowInner({ ...live, status: status({ quest: null }) }, "de")).not.toContain('id="shoot"');
  });
  it("the banner carries the one message that counts", () => {
    expect(bannerFor(live, "de")).toMatchObject({ tone: "ok" });
    expect(bannerFor({ ...live, demo: true }, "de").tone).toBe("none");
    expect(bannerFor({ status: null, demo: false, lastError: "LUMEN unreachable" }, "de").tone).toBe("offline");
    expect(bannerFor({ status: status({ quest: null }), demo: false, lastError: null }, "de").text).toContain("Keine offene Quest");
  });
  it("the pill: connected, offline or demo", () => {
    expect(pillOf(live, "de")).toEqual({ text: "● verbunden", on: true });
    expect(pillOf({ ...live, status: null }, "de").text).toBe("offline");
    expect(pillOf({ ...live, demo: true }, "en").text).toBe("Demo");
  });
  it("the quest tab shows the open quest in full", () => {
    const html = questInner(live, "de");
    expect(html).toContain("Bird&#39;s Eye Pattern");
    expect(html).toContain("Finde ein wiederkehrendes Muster");
    expect(questInner({ ...live, status: status({ quest: null }) }, "de")).toContain("Keine offene Quest.");
  });
  it("the first-run checklist has three steps and ticks them off", () => {
    expect(isFirstRun(true)).toBe(true);
    expect(isFirstRun(false)).toBe(false);
    expect(setupInner(true, false, "de").match(/<li/g)).toHaveLength(3);
    expect(setupInner(false, true, "de").match(/class="done"/g)).toHaveLength(3);
    expect(setupInner(true, false, "de")).toContain("Demo");
  });
});

describe("phone page", () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const mount = (ports: Partial<Parameters<typeof mountPhoneUi>[0]> = {}): string => {
    let html = "";
    const root = { set innerHTML(value: string) { html = value; }, get innerHTML() { return html; }, querySelector: () => null, querySelectorAll: () => [] };
    vi.stubGlobal("document", { getElementById: () => root });
    vi.stubGlobal("setInterval", () => 0);
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
    mountPhoneUi({ getData: () => EMPTY_DATA, setData: async () => undefined, shoot: () => undefined, getStatus: () => null, getLocale: () => "de", ...ports });
    return html;
  };

  it("QIS v1.2: the demo says so on the phone, and the last technical message sits behind Mehr", () => {
    const html = mount({ isDemo: () => true, getLastError: () => "HTTP 500" });
    expect(html).toContain("Demo mit Beispieldaten");
    expect(html).toContain("HTTP 500");
    expect(html.slice(html.indexOf('data-tab="settings"'))).toContain("HTTP 500");
  });

  it("exactly three tabs in the bar, Jetzt / Quest / Einstellungen; the invert switch sits in the settings; a demo opens on them", () => {
    const html = mount({ isDemo: () => true });
    expect([...html.matchAll(/data-tab-go="(\w+)"/g)].map((m) => m[1])).toEqual(["now", "quest", "settings"]);
    expect([...html.matchAll(/<\/span>([^<]+)<\/button>/g)].map((m) => m[1])).toEqual(["Jetzt", "Quest", "Einstellungen"]);
    expect(html.slice(html.indexOf('data-tab="settings"'))).toContain('id="invert"');
    expect(html.slice(0, html.indexOf('data-tab="settings"'))).not.toContain('id="invert"');
    expect(html).toContain("QUIETGLASS / KREATIV");
    expect(html).toContain("In drei Schritten");
  });
});
