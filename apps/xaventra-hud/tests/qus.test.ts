import { describe, expect, it } from "vitest";
import { captionFor, cockpitHint, cockpitModel, statusCells, statusGraphic, statusLines, statusTone } from "../src/cockpit/model";
import { cellBoxes, composeCockpit, modelKey, type CockpitModel } from "../src/cockpit/compose";
import { createTileSender, tileSlots } from "../src/screen/sender";
import { frameKey, tiles } from "../src/screen/frame";
import { pixelBackend } from "../src/screen/text";
import { EMPTY_MODEL, type HudModel } from "../src/hud/model";
import type { HudCard } from "../src/api/types";
import { messages } from "../src/messages";
import { locales } from "../src/i18n";
import { EMPTY_SETTINGS } from "../src/storage/persist";
import { TABS, bannerFor, cardsInner, isFirstRun, nowInner, pillOf, setupInner, type PhoneView } from "../src/ui/phone";

// QUS v1: the pure parts of the status cockpit - headline, cells, graphic, hint, tile diff - and the phone view models.
const NOW = new Date(2026, 9, 17, 14, 5);
const backend = pixelBackend();
const card = (id: string, effect = "intern"): HudCard => ({ id, title: "Drucker starten?", text: "Testdruck bereit.", effect });

const base: HudModel = { ...EMPTY_MODEL, configured: true, online: true, screen: "status", feedAt: NOW.getTime() - 30_000 };
const idle: HudModel = { ...base, feed: { version: "v", status: "Alles ruhig", cards: [] } };
const working: HudModel = { ...base, feed: { version: "v", status: "Prüft Drucker — Schritt 1/2", cards: [] } };
const asking: HudModel = { ...base, feed: { version: "v", status: "Prüft Drucker", cards: [card("a", "physisch"), card("b")] } };
const offline: HudModel = { ...EMPTY_MODEL, configured: true, screen: "status", problem: "Xaventra nicht erreichbar" };
const fault: HudModel = { ...offline, fault: true, problem: "Token abgelehnt" };

describe("status cockpit: headline", () => {
  it("says what needs you, then what Xaventra does", () => {
    expect(statusLines(asking, "de")).toEqual(["2 FRAGEN"]);
    expect(statusLines({ ...asking, feed: { version: "v", status: "x", cards: [card("a")] } }, "de")).toEqual(["1 FRAGE"]);
    expect(statusLines(idle, "de")).toEqual(["BEREIT"]);
    expect(statusLines(working, "de")).toEqual(["ARBEITET"]);
    expect(statusLines(offline, "de")).toEqual(["OFFLINE"]);
    expect(statusLines(fault, "de")).toEqual(["FEHLER"]);
    expect(statusLines({ ...EMPTY_MODEL, configured: true }, "en")).toEqual(["CONNECTING"]);
    expect(statusLines(asking, "en")).toEqual(["2 QUESTIONS"]);
  });
  it("the tone: questions warn, offline is offline, a server fault is critical", () => {
    expect(statusTone(idle)).toBe("ok");
    expect(statusTone(asking)).toBe("warn");
    expect(statusTone(offline)).toBe("offline");
    expect(statusTone(fault)).toBe("critical");
  });
});

describe("status cockpit: cells, graphic, caption, hint", () => {
  it("cells: questions, server, age of the data and what the next question does outside", () => {
    const cells = statusCells(asking, "de");
    expect(cells.map((c) => c.label)).toEqual(["Fragen", "Server", "Stand", "Wirkung"]);
    expect(cells.map((c) => c.value)).toEqual(["2", "online", "14:04", "physisch"]);
    expect(cells[0]?.alert).toBe(true);
    expect(statusCells(idle, "de").map((c) => c.value)).toEqual(["0", "online", "14:04", "–"]);
    const down = statusCells(offline, "de");
    expect(down.map((c) => c.value)).toEqual(["–", "offline", "–", "–"]);
    expect(down[1]?.alert).toBe(true);
    expect(statusCells({ ...idle, demo: true }, "de")[1]?.value).toBe("Demo");
    expect(statusCells({ ...asking, feed: { version: "v", status: "", cards: [card("a")] } }, "de")[3]?.value).toBe("intern");
    expect(cellBoxes(statusCells(asking, "de")).length).toBeLessThanOrEqual(6);
  });
  it("the graphic is a ring with one arc per open question, the centre is their number", () => {
    expect(statusGraphic(asking, "de")).toEqual({ kind: "ring", segments: ["warn", "warn"], center: "2", sub: "Fragen" });
    expect(statusGraphic(idle, "de")).toMatchObject({ segments: ["ok"], center: "0" });
    expect(statusGraphic(offline, "de")).toMatchObject({ segments: ["offline"], center: "–" });
  });
  it("the caption is a feedback line, else what Xaventra does, else the problem", () => {
    expect(captionFor({ ...asking, message: "Erledigt." })).toBe("Erledigt.");
    expect(captionFor(working)).toBe("Prüft Drucker — Schritt 1/2");
    expect(captionFor(offline)).toBe("Xaventra nicht erreichbar");
  });
  it("the hint is one footer line: tap reloads, hold speaks, 2× goes back", () => {
    expect(cockpitHint("de")).toBe("Tippen = neu laden · Halten = Sprache · 2× = zurück");
    expect(cockpitHint("en")).toBe("Tap = reload · Hold = speak · 2× = back");
  });
  it("the whole model", () => {
    const model = cockpitModel(asking, "de", NOW);
    expect(model.title).toBe("XAVENTRA");
    expect(model.clock).toBe("14:05");
    expect(model.headline).toEqual(["2 FRAGEN"]);
    expect(model.tone).toBe("warn");
  });
});

describe("tile diff", () => {
  const slots = tileSlots(21, "xav");
  const frameOf = (m: CockpitModel) => composeCockpit(m, backend);
  it("an unchanged state draws the same frame, tile for tile", () => {
    const a = frameOf(cockpitModel(asking, "de", NOW)); const b = frameOf(cockpitModel(asking, "de", NOW));
    expect(tiles(a).map(frameKey)).toEqual(tiles(b).map(frameKey));
  });
  it("the clock alone changes only the top right tile", () => {
    const m = cockpitModel(asking, "de", NOW);
    const a = tiles(frameOf(m)).map(frameKey); const b = tiles(frameOf({ ...m, clock: "14:06" })).map(frameKey);
    expect(b.map((key, i) => (key === a[i] ? 0 : 1))).toEqual([0, 1, 0, 0]);
  });
  it("the sender sends all four tiles once, then nothing for an identical frame, then only what changed", async () => {
    const sent: number[] = [];
    const sender = createTileSender(slots, async (slot) => { sent.push(slot.id); return true; }, (frame) => new Uint8Array(frame.pixels));
    const m = cockpitModel(asking, "de", NOW);
    await sender.push(frameOf(m));
    expect(sent).toHaveLength(4);
    await sender.push(frameOf(cockpitModel(asking, "de", NOW)));
    expect(sent).toHaveLength(4);
    await sender.push(frameOf({ ...m, clock: "14:06" }));
    expect(sent.slice(4)).toEqual([slots[1].id]);
  });
  it("modelKey changes exactly with what is drawn", () => {
    const m = cockpitModel(asking, "de", NOW);
    expect(modelKey(m)).toBe(modelKey(cockpitModel(asking, "de", NOW)));
    expect(modelKey(m)).not.toBe(modelKey({ ...m, clock: "14:06" }));
  });
});

describe("words", () => {
  it("both languages have every key and the same placeholders", () => {
    const keys = Object.keys(messages.de).sort();
    for (const locale of locales) expect(Object.keys(messages[locale]).sort(), locale).toEqual(keys);
  });
});

describe("phone view models", () => {
  const view = (model: HudModel, connection: PhoneView["connection"] = { kind: "ok" }): PhoneView => ({ model, connection });
  it("has exactly three tabs, Jetzt / Fragen / Einstellungen", () => {
    expect(TABS.map((tab) => tab.id)).toEqual(["now", "cards", "settings"]);
    expect(TABS.map((tab) => messages.de[tab.key])).toEqual(["Jetzt", "Fragen", "Einstellungen"]);
  });
  it("the hero value is the number of open questions, one refresh button, a card per question", () => {
    const html = nowInner(view(asking), "de");
    expect(html).toContain("hero-card");
    expect(html).toContain('id="refresh"');
    expect((html.match(/<div class="host/g) ?? []).length).toBe(2);
    expect(html).toContain("physisch");
  });
  it("the banner carries the one message that counts", () => {
    expect(bannerFor(view(asking), "de")).toMatchObject({ tone: "warn" });
    expect(bannerFor(view(idle), "de")).toMatchObject({ tone: "ok", text: "Alles ruhig. Keine offenen Fragen." });
    expect(bannerFor(view(working), "de").text).toContain("Prüft Drucker");
    expect(bannerFor(view(offline, { kind: "error", reason: "nicht erreichbar" }), "de")).toMatchObject({ tone: "offline" });
    expect(bannerFor(view(fault, { kind: "error", reason: "Token abgelehnt" }), "de").tone).toBe("critical");
    expect(bannerFor(view(idle, { kind: "demo" }), "de").tone).toBe("none");
  });
  it("the pill is the connection in a word", () => {
    expect(pillOf({ kind: "ok" }, "de")).toEqual({ text: "● verbunden", on: true });
    expect(pillOf({ kind: "none" }, "de").text).toBe("kein Server");
  });
  it("the questions tab lists the open questions and says answers are given on the glasses", () => {
    expect(cardsInner(view(asking), "de").match(/class="card server/g)).toHaveLength(2);
    expect(cardsInner(view(asking), "de")).toContain("auf der Brille");
    expect(cardsInner(view(idle), "de")).toContain("Keine offenen Fragen.");
  });
  it("the first-run checklist has three steps and ticks them off", () => {
    expect(isFirstRun(EMPTY_SETTINGS)).toBe(true);
    expect(isFirstRun({ ...EMPTY_SETTINGS, serverUrl: "https://x.example" })).toBe(false);
    expect(setupInner(EMPTY_SETTINGS, false, "de").match(/<li/g)).toHaveLength(3);
    expect(setupInner({ ...EMPTY_SETTINGS, serverUrl: "https://x.example" }, true, "de").match(/class="done"/g)).toHaveLength(3);
    expect(setupInner(EMPTY_SETTINGS, false, "de")).toContain("Demo");
  });
});
