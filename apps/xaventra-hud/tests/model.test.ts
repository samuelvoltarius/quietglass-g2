import { describe, expect, it } from "vitest";
import { locales } from "../src/i18n";
import { MAX_BODY_ROWS, ROW_WIDTH } from "../src/glasses/screen";
import { EMPTY_MODEL, buildView, decide, elapsed, lastRows, spokenAnswer, startRows, type HudModel } from "../src/hud/model";
import { armedFooter, footer } from "../src/glasses/footer";
import type { HudCard } from "../src/api/types";

const NOW = new Date("2026-10-08T14:32:00");
const inner: HudCard = { id: "a", title: "Neues Modell testen?", text: "Modell Z war schneller.", effect: "intern" };
const outer: HudCard = { id: "b", title: "Drucker starten?", text: "Testdruck bereit.", effect: "physisch" };

const withCards = (cards: HudCard[], extra: Partial<HudModel> = {}): HudModel => ({
  ...EMPTY_MODEL, configured: true, online: true, screen: "cards",
  feed: { version: "v", status: "Prüft Drucker — Schritt 1/2", cards }, ...extra,
});

describe("what a gesture means", () => {
  it("a swipe never answers: it only moves the cursor", () => {
    for (const model of [withCards([inner]), withCards([outer], { nein: "b" }), withCards([inner, outer], { confirm: "a" })]) {
      for (const gesture of ["scrollUp", "scrollDown"] as const) {
        const action = decide(model, gesture);
        expect(["move", "none"]).toContain(action.kind);
      }
    }
  });

  it("tap only arms, for Ja and for Nein, on internal and outward cards", () => {
    expect(decide(withCards([inner]), "click")).toEqual({ kind: "confirm", cardId: "a" });
    expect(decide(withCards([outer]), "click")).toEqual({ kind: "confirm", cardId: "b" });
    expect(decide(withCards([inner], { nein: "a" }), "click")).toEqual({ kind: "confirm", cardId: "a" });
  });

  it("the second tap sends the armed answer, Ja or Nein", () => {
    expect(decide(withCards([inner], { confirm: "a" }), "click")).toEqual({ kind: "answer", cardId: "a", answer: "ja" });
    expect(decide(withCards([inner], { confirm: "a", nein: "a" }), "click")).toEqual({ kind: "answer", cardId: "a", answer: "nein" });
  });

  it("an armed answer for another card does not carry over", () => {
    expect(decide(withCards([inner, outer], { index: 1, confirm: "a", nein: "a" }), "click")).toEqual({ kind: "confirm", cardId: "b" });
  });

  it("a double tap cancels an armed answer; unarmed it goes back to the start page", () => {
    expect(decide(withCards([inner], { confirm: "a" }), "doubleClick")).toEqual({ kind: "disarm" });
    expect(decide(withCards([inner]), "doubleClick")).toEqual({ kind: "back" });
    expect(decide(withCards([]), "doubleClick")).toEqual({ kind: "back" });
  });

  it("with no card: a tap and a swipe do nothing", () => {
    expect(decide(withCards([]), "click")).toEqual({ kind: "none" });
    expect(decide(withCards([]), "scrollDown")).toEqual({ kind: "none" });
  });

  it("swiping walks Ja, Nein of each card and wraps around", () => {
    const two = [inner, outer];
    expect(decide(withCards(two), "scrollDown")).toEqual({ kind: "move", index: 0, nein: "a" });
    expect(decide(withCards(two, { nein: "a" }), "scrollDown")).toEqual({ kind: "move", index: 1, nein: null });
    expect(decide(withCards(two, { index: 1, nein: "b" }), "scrollDown")).toEqual({ kind: "move", index: 0, nein: null });
    expect(decide(withCards(two), "scrollUp")).toEqual({ kind: "move", index: 1, nein: "b" });
  });

  it("start page: tap opens the entry under the cursor, swipe moves it, 2× leaves", () => {
    const start = withCards([inner], { screen: "start" });
    expect(startRows(start)).toEqual([{ kind: "cards", count: 1 }, { kind: "status" }]);
    expect(decide(start, "click")).toEqual({ kind: "open", screen: "cards" });
    expect(decide({ ...start, startCursor: 1 }, "click")).toEqual({ kind: "open", screen: "status" });
    expect(decide(start, "scrollDown")).toEqual({ kind: "startMove", cursor: 1 });
    expect(decide({ ...start, startCursor: 1 }, "scrollDown")).toEqual({ kind: "startMove", cursor: 1 });
    expect(decide(start, "scrollUp")).toEqual({ kind: "startMove", cursor: 0 });
    expect(decide(start, "doubleClick")).toEqual({ kind: "exit" });
    expect(decide(EMPTY_MODEL, "doubleClick")).toEqual({ kind: "exit" });
  });

  it("status cockpit: tap asks again, 2× goes back, a swipe does nothing", () => {
    const status = withCards([inner], { screen: "status" });
    expect(decide(status, "click")).toEqual({ kind: "refresh" });
    expect(decide(status, "doubleClick")).toEqual({ kind: "back" });
    expect(decide(status, "scrollDown")).toEqual({ kind: "none" });
  });

  it("recognised text waits: tap sends it, 2× discards it, a swipe does nothing", () => {
    const model = withCards([inner], { draft: "Wie ist der Stand?" });
    expect(decide(model, "click")).toEqual({ kind: "sendDraft" });
    expect(decide(model, "doubleClick")).toEqual({ kind: "discardDraft" });
    expect(decide(model, "scrollUp")).toEqual({ kind: "none" });
    expect(decide(model, "scrollDown")).toEqual({ kind: "none" });
  });

  it("only a bare yes or no counts as a spoken answer", () => {
    for (const yes of ["ja", "Ja.", "JA!", "okay", "Yes", "ja bitte"]) expect(spokenAnswer(yes), yes).toBe("ja");
    for (const no of ["nein", "Nein!", "no", "stopp", "nee"]) expect(spokenAnswer(no), no).toBe("nein");
    for (const other of ["ja aber erst morgen", "Wie ist der Stand?", "", "nein, starte stattdessen B"]) expect(spokenAnswer(other), other).toBeNull();
  });

  it("while a voice reply is shown, every gesture only closes it", () => {
    const model = withCards([inner], { voice: { transcript: "x", reply: "y" } });
    for (const gesture of ["click", "doubleClick", "scrollUp", "scrollDown"] as const) {
      expect(decide(model, gesture)).toEqual({ kind: "dismiss" });
    }
  });
});

describe("what the glasses show", () => {
  it("shows header `Frage 2/2 · ● live`, status, card (with what it does outside) and the Ja / Nein list with the cursor on Ja", () => {
    const view = buildView(withCards([inner, outer], { index: 1 }), "de", NOW);
    expect(view.header).toBe("Frage 2/2 · ● live");
    expect(view.body.join("\n")).toContain("> Prüft Drucker — Schritt 1/2");
    expect(view.body.join("\n")).toContain("physisch: Drucker starten?");
    expect(view.body.slice(-2)).toEqual(["● Ja", "○ Nein"]);
    expect(view.footer).toBe("Tippen = wählen · Halten = Sprache · 2× = zurück");
  });

  it("start page: two entries with a dot on the cursor, the demo says so in one line", () => {
    const view = buildView(withCards([inner], { screen: "start", demo: true }), "de", NOW);
    expect(view.header).toBe("Xaventra · Demo");
    expect(view.body).toEqual(["● Fragen · 1", "  Status", "Demo · Verbindung am Handy einrichten"]);
    expect(view.footer).toBe("Tippen = öffnen · Wischen · Halten = Sprache · 2× = Ende");
    expect(buildView(withCards([], { screen: "start", startCursor: 1 }), "en", NOW).body).toEqual(["  Questions · 0", "● Status"]);
    expect(buildView(withCards([], { screen: "start" }), "de", NOW).header).toBe("Xaventra · ● live");
  });

  it("with Nein chosen the cursor is on Nein", () => {
    const view = buildView(withCards([inner], { nein: "a" }), "de", NOW);
    expect(view.body.slice(-2)).toEqual(["○ Ja", "● Nein"]);
  });

  it("armed: the footer says what the second tap sends and how to cancel", () => {
    const ja = buildView(withCards([outer], { confirm: "b" }), "en", NOW);
    expect(ja.footer).toBe("Tap again = send Yes · Swipe/2× = cancel");
    expect(ja.header).toBe("Question 1/1 · confirm");
    const nein = buildView(withCards([outer], { confirm: "b", nein: "b" }), "de", NOW);
    expect(nein.footer).toBe("Nochmal tippen = Nein senden · Wischen/2× = abbrechen");
    expect(nein.footer).toBe(armedFooter("de", "Nein senden"));
  });

  it("a feedback line goes into the body, the footer stays the gesture row", () => {
    const view = buildView(withCards([inner], { message: "Gehört: Ja. Nochmal tippen = senden." }), "de", NOW);
    expect(view.body).toContain("Gehört: Ja. Nochmal tippen = senden.");
    expect(view.footer).toBe("Tippen = wählen · Halten = Sprache · 2× = zurück");
    const idle = buildView(withCards([], { message: "Abgebrochen." }), "de", NOW);
    expect(idle.body).toContain("Abgebrochen.");
    expect(idle.footer).toBe("Halten = Sprache · 2× = zurück");
  });

  it("every screen has a footer built by footer(): none is empty", () => {
    const models: HudModel[] = [
      EMPTY_MODEL,
      withCards([inner], { screen: "start" }),
      withCards([inner], { screen: "start", demo: true }),
      { ...EMPTY_MODEL, configured: true },
      { ...EMPTY_MODEL, configured: true, problem: "Xaventra nicht erreichbar" },
      withCards([]),
      withCards([inner]),
      withCards([inner], { rec: "opening" }),
      withCards([inner], { rec: "listening" }),
      withCards([inner], { rec: "listening", live: "Wie" }),
      withCards([inner], { rec: "sending" }),
      withCards([inner], { rec: "sending", live: "Wie ist der Stand?" }),
      withCards([inner], { draft: "Wie ist der Stand?" }),
    ];
    for (const locale of locales) {
      for (const model of models) {
        const row = buildView(model, locale, NOW).footer;
        expect(row.trim(), JSON.stringify(model)).not.toBe("");
        expect(row).toMatch(/2× = \S+$/);
      }
    }
    expect(buildView(EMPTY_MODEL, "de", NOW).footer).toBe(footer("de", {}, "exit"));
  });

  it("recognised text is shown first with Tippen = senden · 2× = verwerfen", () => {
    const view = buildView(withCards([inner], { draft: "Wie ist der Stand?" }), "de", NOW);
    expect(view.header).toBe("Xaventra · senden?");
    expect(view.body).toContain("Du: Wie ist der Stand?");
    expect(view.footer).toBe("Tippen = senden · 2× = verwerfen");
    expect(buildView(withCards([inner], { draft: "x" }), "en", NOW).footer).toBe("Tap = send · 2× = discard");
  });

  it("English footer uses Tap/Swipe/Hold and 2× = exit", () => {
    expect(buildView(withCards([inner]), "en", NOW).footer).toBe("Tap = choose · Swipe · Hold = speak · 2× = back");
    expect(buildView(withCards([inner], { screen: "start" }), "en", NOW).footer).toBe("Tap = open · Swipe · Hold = speak · 2× = exit");
  });

  it("marks offline and shows the problem when there is no feed yet", () => {
    const view = buildView({ ...EMPTY_MODEL, configured: true, screen: "cards", problem: "Token abgelehnt" }, "de", NOW);
    expect(view.header).toBe("Xaventra · offline");
    expect(view.body.join("\n")).toContain("Token abgelehnt");
    expect(view.footer).toBe("2× = zurück");
    const start = buildView({ ...EMPTY_MODEL, configured: true, problem: "Token abgelehnt" }, "de", NOW);
    expect(start.header).toBe("Xaventra · offline");
    expect(start.body).toContain("Token abgelehnt");
  });

  it("shows ● MIC and the hold hints (footer) while recording", () => {
    const view = buildView(withCards([inner], { rec: "listening" }), "de", NOW);
    expect(view.header).toContain("● MIC");
    expect(view.footer).toBe("Loslassen = fertig · 2× = abbrechen");
  });

  it("shows the transcript and the reply, and offers to close", () => {
    const view = buildView(withCards([inner], { voice: { transcript: "Wie ist der Stand?", reply: "Alles ruhig." } }), "de", NOW);
    expect(view.body.join("\n")).toContain("Du: Wie ist der Stand?");
    expect(view.body.join("\n")).toContain("Xaventra: Alles ruhig.");
    expect(view.footer).toBe("Tippen = schließen · 2× = zurück");
  });

  it("never exceeds seven rows of 56 characters, with worst-case server text, in both languages", () => {
    const long = "Wort ".repeat(120);
    const wide: HudCard = { id: "w", title: long, text: long, effect: "nach außen und sonst noch etwas Langes" };
    const models: HudModel[] = [
      withCards([wide, wide, wide, wide, wide], { index: 4, message: long }),
      withCards([wide], { confirm: "w" }),
      withCards([wide, wide], { nein: "w" }),
      withCards([wide], { confirm: "w", nein: "w" }),
      withCards([wide], { draft: long }),
      withCards([wide], { rec: "sending", live: long }),
      withCards([wide], { screen: "start", message: long }),
      withCards([wide], { screen: "start", problem: long, online: false, demo: true }),
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

describe("live text while speaking", () => {
  const long = Array.from({ length: 80 }, (_, i) => `wort${i}`).join(" ");

  it("shows the newest words, the running time and how to send or cancel", () => {
    const view = buildView(withCards([inner], { rec: "listening", live: long, recSince: NOW.getTime() - 75_000 }), "de", NOW);
    expect(view.header).toContain("1:15");
    expect(view.body.length).toBeLessThanOrEqual(MAX_BODY_ROWS);
    expect(view.body.at(-1)).toContain("wort79");
    expect(view.body[0]?.startsWith("…")).toBe(true);
    expect(view.footer).toBe("Loslassen = fertig · 2× = abbrechen");
    for (const row of [view.header, ...view.body, view.footer]) expect(row.length).toBeLessThanOrEqual(ROW_WIDTH);
  });

  it("without live text it keeps the old prompt", () => {
    const view = buildView(withCards([inner], { rec: "listening", recSince: NOW.getTime() }), "de", NOW);
    expect(view.body).toContain("Sprich jetzt …");
  });

  it("while sending, what was said stays and the status line shows progress", () => {
    const view = buildView(withCards([inner], { rec: "sending", live: "Wie ist der Stand?" }), "de", NOW);
    expect(view.body.join(" ")).toContain("Du: Wie ist der Stand?");
    expect(view.body.join(" ")).toContain("> Prüft Drucker");
    expect(view.body.join(" ")).toContain("Verstehe und sende …");
    expect(view.footer).toBe("2× = abbrechen");
  });

  it("helpers: last rows with a marked cut, m:ss", () => {
    expect(lastRows(["a", "b", "c"], 2)).toEqual(["…b", "c"]);
    expect(lastRows(["a"], 2)).toEqual(["a"]);
    expect(elapsed(0)).toBe("0:00");
    expect(elapsed(119_999)).toBe("1:59");
  });
});
