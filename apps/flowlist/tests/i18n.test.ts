import { afterEach, describe, expect, it, vi } from "vitest";
import { getLocale, languageSelect, locales, setLocale, tr, type Messages } from "../src/i18n";
import { messages, t } from "../src/messages";
import { buildView, FOOTER_WIDTH, HEADER_WIDTH, MAX_BODY_ROWS } from "../src/glasses/view";
import { complete, currentStep, moveChoice, skip, startRun, type RunState } from "../src/checklist/run";
import { danglingJumps, type Checklist } from "../src/checklist/model";
import { parseMarkdown, parsePack } from "../src/checklist/parse";
import { sampleChecklists, SAMPLE_IDS } from "../src/checklist/sample";
import { addSamples, firstRunData, removeList, samplesMissing } from "../src/storage/persist";
import { dispatch } from "../src/input/dispatch";
import { fileName } from "../src/ui/phone";

const GLASSES_WIDTH = 46;
const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? "").sort();

/** Worst-case values for every placeholder that reaches the glasses. */
const WORST: Record<string, string | number> = { done: 99, total: 99, skipped: 99, time: "999:59", text: "" };

describe("message catalogue", () => {
  it("has every key in German and English, none empty", () => {
    expect(Object.keys(messages.de).sort()).toEqual(Object.keys(messages.en).sort());
    for (const locale of locales) {
      for (const [key, value] of Object.entries(messages[locale])) {
        expect(value.trim(), `${locale}:${key}`).not.toBe("");
      }
    }
  });

  it("uses the same placeholders in both languages", () => {
    for (const key of Object.keys(messages.en)) {
      expect(placeholders(messages.de[key] ?? ""), key).toEqual(placeholders(messages.en[key] ?? ""));
    }
  });

  it("keeps every glasses string within one display row, in both languages", () => {
    for (const locale of locales) {
      for (const key of Object.keys(messages[locale]).filter((k) => k.startsWith("g."))) {
        expect(t(locale, key, WORST).length, `${locale}:${key}`).toBeLessThanOrEqual(GLASSES_WIDTH);
      }
    }
  });

  it("uses glyphs the G2 can draw and real umlauts in German", () => {
    const all = locales.flatMap((l) => Object.values(messages[l])).join("\n");
    expect(all).not.toContain("▸");
    const german = Object.values(messages.de).join(" ");
    expect(german).toMatch(/[äöüß]/);
    expect(german).not.toMatch(/\b(fuer|ueber|zurueck|waehle|loeschen)\b/i);
  });
});

describe("i18n helpers", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  const sample: Messages = { de: { hi: "Hallo {name}, {name}!" }, en: { hi: "Hi {name}", only: "English only" } };

  it("substitutes every occurrence and falls back to English, then the key", () => {
    expect(tr(sample, "de", "hi", { name: "Ada" })).toBe("Hallo Ada, Ada!");
    expect(tr(sample, "de", "only")).toBe("English only");
    expect(tr(sample, "de", "missing")).toBe("missing");
  });

  it("follows the device language with English as the fallback", () => {
    vi.stubGlobal("localStorage", undefined);
    vi.stubGlobal("navigator", { language: "de-AT" });
    expect(getLocale()).toBe("de");
    vi.stubGlobal("navigator", { language: "fr-FR" });
    expect(getLocale()).toBe("en");
  });

  it("prefers the language picked on the phone, and survives broken storage", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } });
    vi.stubGlobal("navigator", { language: "de-DE" });
    setLocale("en");
    expect(getLocale()).toBe("en");

    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    expect(() => setLocale("de")).not.toThrow();
    expect(getLocale()).toBe("de");
  });

  it("marks the active language in the selector", () => {
    const html = languageSelect("de");
    expect(html).toContain("Sprache");
    expect(html).toContain('<option value="de" selected>');
    expect(html.match(/<option/g)).toHaveLength(2);
  });
});

/** Walks a checklist from start to finish, collecting every view on the way. */
function walk(list: Checklist, locale: "de" | "en"): ReturnType<typeof buildView>[] {
  const views: ReturnType<typeof buildView>[] = [];
  const opts = { showNext: true, locale } as const;
  let state: RunState = startRun(list, 0);
  for (let guard = 0; guard < 100; guard++) {
    views.push(buildView(list, state, opts, 3_599_000));
    const step = currentStep(list, state);
    if (step?.detail) views.push(buildView(list, state, { ...opts, showDetail: true }, 0));
    if (!step) break;
    if (step.kind === "choice") views.push(buildView(list, moveChoice(list, state, 1), opts, 0));
    if (step.kind === "optional") { state = skip(list, state, 1000); continue; }
    state = complete(list, state, "done", 1000);
    if (state.awaitingConfirm) {
      views.push(buildView(list, state, opts, 0));
      state = complete(list, state, "done", 1000);
    }
  }
  return views;
}

describe("glasses copy fits the display", () => {
  for (const locale of locales) {
    it(`${locale}: every screen of both example lists stays within 7 rows × 46 characters`, () => {
      for (const list of sampleChecklists(locale)) {
        const views = walk(list, locale);
        expect(views.length).toBeGreaterThan(list.steps.length);
        for (const view of views) {
          expect(view.body.length).toBeLessThanOrEqual(MAX_BODY_ROWS);
          for (const row of view.body) expect(row.length, row).toBeLessThanOrEqual(GLASSES_WIDTH);
          expect(view.header.length, view.header).toBeLessThanOrEqual(HEADER_WIDTH);
          expect(view.footer.length, view.footer).toBeLessThanOrEqual(FOOTER_WIDTH);
          expect(view.footer).not.toBe("");
        }
      }
    });

    it(`${locale}: the empty screen says what to do and how to leave`, () => {
      const empty: Checklist = { id: "", title: "", steps: [] };
      const view = buildView(empty, startRun(empty), { locale });
      expect(view.body.length).toBeGreaterThanOrEqual(2);
      expect(view.footer).toBe(t(locale, "g.empty.footer"));
    });
  }

  it("shows German hints in plain words", () => {
    const list: Checklist = { id: "x", title: "T", steps: [
      { id: "a", text: "Herd aus", kind: "critical" },
      { id: "b", text: "Sonnencreme", kind: "optional" },
    ] };
    const start = startRun(list, 0);
    expect(buildView(list, start, { locale: "de" }, 0).footer).toContain("tippen = erledigt");
    const armed = complete(list, start, "done", 0);
    const view = buildView(list, armed, { locale: "de" }, 0);
    expect(view.body[0]).toBe("WICHTIG – nochmal tippen:");
    expect(view.footer).toContain("nochmal tippen = bestätigen");
    const optional = complete(list, armed, "done", 0);
    expect(buildView(list, optional, { locale: "de" }, 0).footer).toBe("tippen = erledigt · runterwischen = auslassen");
    const done = skip(list, optional, 65_000);
    const finished = buildView(list, done, { locale: "de" }, 65_000);
    expect(finished.body).toContain("Fertig!");
    expect(finished.body).toContain("1 von 1 erledigt");
    expect(finished.footer).toBe("tippen = neu starten · doppeltippen = beenden");
  });
});

describe("first run", () => {
  it("installs both example lists in the device language, the first one active", () => {
    const de = firstRunData("de");
    expect(de.lists.map((l) => l.title)).toEqual(["Haus verlassen", "Reise packen"]);
    expect(de.activeId).toBe("sample-home");
    expect(firstRunData("en").lists.map((l) => l.title)).toEqual(["Leaving the house", "Packing for a trip"]);
  });

  it("keeps the German and English examples structurally identical", () => {
    const [de, en] = [sampleChecklists("de"), sampleChecklists("en")];
    expect(de.map((l) => l.id)).toEqual([...SAMPLE_IDS]);
    de.forEach((list, i) => {
      const other = en[i]!;
      expect(list.steps.map((s) => [s.id, s.kind, s.choices?.map((c) => c.goto)]))
        .toEqual(other.steps.map((s) => [s.id, s.kind, s.choices?.map((c) => c.goto)]));
      expect(danglingJumps(list)).toEqual([]);
    });
  });

  it("shows every feature of the format between the two examples", () => {
    const steps = sampleChecklists("de").flatMap((l) => l.steps);
    for (const kind of ["normal", "optional", "critical", "choice"]) {
      expect(steps.some((s) => s.kind === kind), kind).toBe(true);
    }
    expect(steps.some((s) => s.detail)).toBe(true);
    expect(steps.some((s) => s.section)).toBe(true);
  });

  it("lets the user bring the examples back after removing them", () => {
    const removed = removeList(firstRunData("de"), "sample-trip");
    expect(samplesMissing(removed)).toBe(true);
    const restored = addSamples(removed, "de");
    expect(restored.lists.map((l) => l.id)).toEqual(["sample-home", "sample-trip"]);
    expect(samplesMissing(restored)).toBe(false);
    // Lists already there are left alone.
    expect(restored.lists[0]).toBe(removed.lists[0]);
  });

  it("starts a finished list again on a tap", () => {
    const list = sampleChecklists("en")[0]!;
    let state = startRun(list, 0);
    while (state.currentId) {
      const step = currentStep(list, state)!;
      state = step.kind === "optional" ? skip(list, state) : complete(list, complete(list, state));
    }
    const again = dispatch(list, state, "click").state;
    expect(again.currentId).toBe(list.steps[0]!.id);
    expect(again.status).toEqual({});
  });
});

describe("German import messages", () => {
  it("reports problems in German", () => {
    expect(parseMarkdown("nur Text", "x", "de").warnings).toContain("Keine Schritte gefunden.");
    expect(parseMarkdown("- eins", "x", "de").checklist.title).toBe("Checkliste ohne Namen");
    expect(parsePack("{", "de").warnings[0]).toContain("kein gültiges");
    expect(parsePack(JSON.stringify({ steps: [{ text: "a", choices: [{ label: "x", goto: "nix" }] }] }), "de").warnings[0])
      .toBe("Ein Schritt springt zu „nix“ – den gibt es nicht.");
  });

  it("keeps German titles readable in export file names", () => {
    expect(fileName("Reise packen")).toBe("reise-packen");
    expect(fileName("Größe prüfen")).toBe("groesse-pruefen");
    expect(fileName("!!!")).toBe("checklist");
  });
});
