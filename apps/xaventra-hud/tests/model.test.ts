import { describe, expect, it } from "vitest";
import { locales } from "../src/i18n";
import { MAX_BODY_ROWS, ROW_WIDTH } from "../src/glasses/screen";
import { EMPTY_MODEL, buildView, decide, needsConfirm, type HudModel } from "../src/hud/model";
import type { HudCard } from "../src/api/types";

const NOW = new Date("2026-10-08T14:32:00");
const inner: HudCard = { id: "a", title: "Neues Modell testen?", text: "Modell Z war schneller.", effect: "intern" };
const outer: HudCard = { id: "b", title: "Drucker starten?", text: "Testdruck bereit.", effect: "physisch" };

const withCards = (cards: HudCard[], extra: Partial<HudModel> = {}): HudModel => ({
  ...EMPTY_MODEL, configured: true, online: true,
  feed: { version: "v", status: "Prüft Drucker — Schritt 1/2", cards }, ...extra,
});

describe("what a gesture means", () => {
  it("tap answers an internal card with yes, double tap with no", () => {
    expect(decide(withCards([inner]), "click")).toEqual({ kind: "answer", cardId: "a", answer: "ja" });
    expect(decide(withCards([inner]), "doubleClick")).toEqual({ kind: "answer", cardId: "a", answer: "nein" });
  });

  it("an outward card needs a confirming second tap, and only for that card", () => {
    expect(needsConfirm(outer)).toBe(true);
    expect(decide(withCards([outer]), "click")).toEqual({ kind: "confirm", cardId: "b" });
    expect(decide(withCards([outer], { confirm: "b" }), "click")).toEqual({ kind: "answer", cardId: "b", answer: "ja" });
    // A confirmation armed for another card does not carry over.
    expect(decide(withCards([outer], { confirm: "zzz" }), "click")).toEqual({ kind: "confirm", cardId: "b" });
  });

  it("no needs no confirmation, even for an outward card", () => {
    expect(decide(withCards([outer]), "doubleClick")).toEqual({ kind: "answer", cardId: "b", answer: "nein" });
  });

  it("with no card: tap does nothing, double tap leaves", () => {
    expect(decide(withCards([]), "click")).toEqual({ kind: "none" });
    expect(decide(withCards([]), "doubleClick")).toEqual({ kind: "exit" });
    expect(decide(EMPTY_MODEL, "doubleClick")).toEqual({ kind: "exit" });
  });

  it("swiping wraps around and does nothing for a single card", () => {
    expect(decide(withCards([inner, outer]), "scrollDown")).toEqual({ kind: "move", index: 1 });
    expect(decide(withCards([inner, outer], { index: 1 }), "scrollDown")).toEqual({ kind: "move", index: 0 });
    expect(decide(withCards([inner, outer]), "scrollUp")).toEqual({ kind: "move", index: 1 });
    expect(decide(withCards([inner]), "scrollDown")).toEqual({ kind: "none" });
  });

  it("while a voice reply is shown, every gesture only closes it", () => {
    const model = withCards([inner], { voice: { transcript: "x", reply: "y" } });
    for (const gesture of ["click", "doubleClick", "scrollUp", "scrollDown"] as const) {
      expect(decide(model, gesture)).toEqual({ kind: "dismiss" });
    }
  });
});

describe("what the glasses show", () => {
  it("shows status, position, title and text of the card, with the effect", () => {
    const view = buildView(withCards([inner, outer], { index: 1 }), "de", NOW);
    expect(view.header).toBe("Xaventra · 14:32");
    expect(view.body.join("\n")).toContain("> Prüft Drucker — Schritt 1/2");
    expect(view.body.join("\n")).toContain("Frage 2/2 (physisch)");
    expect(view.body.join("\n")).toContain("Drucker starten?");
    expect(view.footer).toBe("Ja · 2x Nein · Wischen · Halten sprechen");
  });

  it("asks for the second tap on the footer, and names the effect in English", () => {
    const view = buildView(withCards([outer], { confirm: "b" }), "en", NOW);
    expect(view.footer).toBe("Tap again = confirm YES");
    expect(view.body.join("\n")).toContain("Question 1/1 (physical)");
  });

  it("marks offline and shows the problem when there is no feed yet", () => {
    const view = buildView({ ...EMPTY_MODEL, configured: true, problem: "Token abgelehnt (401)" }, "de", NOW);
    expect(view.header).toContain("(offline)");
    expect(view.body.join("\n")).toContain("Token abgelehnt (401)");
  });

  it("shows ● MIC and the hold hints while recording", () => {
    const view = buildView(withCards([inner], { rec: "listening" }), "de", NOW);
    expect(view.header).toContain("● MIC");
    expect(view.body.join("\n")).toContain("Loslassen = senden");
    expect(view.body.join("\n")).toContain("2x Tap = abbrechen");
  });

  it("shows the transcript and the reply, and offers to close", () => {
    const view = buildView(withCards([inner], { voice: { transcript: "Wie ist der Stand?", reply: "Alles ruhig." } }), "de", NOW);
    expect(view.body.join("\n")).toContain("Du: Wie ist der Stand?");
    expect(view.body.join("\n")).toContain("Xaventra: Alles ruhig.");
    expect(view.footer).toBe("Tippen = schließen");
  });

  it("never exceeds seven rows of 46 characters, with worst-case server text, in both languages", () => {
    const long = "Wort ".repeat(120);
    const wide: HudCard = { id: "w", title: long, text: long, effect: "nach außen und sonst noch etwas Langes" };
    const models: HudModel[] = [
      withCards([wide, wide, wide, wide, wide], { index: 4, message: long }),
      withCards([wide], { confirm: "w" }),
      withCards([], { message: long, problem: long }),
      withCards([wide], { voice: { transcript: long, reply: long } }),
      withCards([wide], { rec: "sending" }),
      { ...EMPTY_MODEL, configured: true, problem: long },
      EMPTY_MODEL,
      { ...EMPTY_MODEL, configured: true, feed: { version: "v", status: long, cards: [] } },
    ];
    for (const locale of locales) {
      for (const model of models) {
        const view = buildView(model, locale, NOW);
        expect(view.body.length).toBeLessThanOrEqual(MAX_BODY_ROWS);
        for (const row of [view.header, view.footer, ...view.body]) expect(row.length, row).toBeLessThanOrEqual(ROW_WIDTH);
      }
    }
  });
});
