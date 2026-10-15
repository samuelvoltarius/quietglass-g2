import { describe, expect, it } from "vitest";
import {
  BUDGET, DIGEST_OVER, analyseProject, resolveSource, analysisMessages, cleanAnalysis, fallbackAnalysis, fitSources, materialHash, needsDigest, projectSources,
} from "../examples/shoot-day-brain.mjs";

// invented project, no real customer data
const customer = { name: "Max Beispiel", company: "Beispiel Café GmbH", notes: "Mag ruhige Bilder." };
const project = () => ({
  name: "Imagefilm", date: "2026-10-20", place: "Beispielgasse 1",
  dispo: { call: "08:00", location: "Gastgarten", contact: "Frau Test", notes: "", schedule: [{ time: "09:00", what: "Barista" }] },
  talks: [{ id: "t_000000000001", at: Date.UTC(2026, 9, 14), summary: "- Drohne über den Gastgarten\n- Praktikantin Lena Probe hilft mit", cues: [] }],
  ideas: [
    { id: "i_000000000001", text: "14.10.: Vordrucke Einverständniserklärung Mitarbeitende vorbereiten", tags: ["todo"], done: false },
    { id: "i_000000000002", text: "14.10.: Unterlagen senden: Praktikumsvereinbarung, Mitarbeiterinfo", tags: ["todo"], done: false },
    { id: "i_000000000003", text: "Alte Idee", tags: [], done: true },
  ],
  storyboards: [{ id: "s_000000000001", title: "Reel", scenes: [{ title: "Ankunft", content: "Gäste kommen", camera: "", overlay: "", goal: "" }] }],
  scenes: [], prompter: "",
});

const reply = (content) => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) });

describe("project understanding (shoot-day-brain.mjs)", () => {
  it("collects every source with a stable id; done ideas are left out", () => {
    const sources = projectSources(project(), customer, [{ id: "f_000000000001", name: "Angebot.pdf", text: "Angebot für zwei Drehtage" }]);
    expect(sources.map((s) => s.id)).toEqual(["kunde", "projekt", "talk:t_000000000001", "idea:i_000000000001", "idea:i_000000000002", "board:s_000000000001", "file:f_000000000001"]);
    expect(sources.find((s) => s.id === "projekt").text).toContain("Tagesplan: 09:00 Barista");
    expect(sources.find((s) => s.id === "idea:i_000000000001").title).toBe("To-do: Vordrucke Einverständniserklärung Mitarbeitende vorbereiten");
    expect(materialHash(sources)).toBe(materialHash(projectSources(project(), customer, [{ id: "f_000000000001", name: "Angebot.pdf", text: "Angebot für zwei Drehtage" }])));
  });

  it("any amount of material: long sources use their digest, the rest is cut to the budget", () => {
    const long = { id: "file:x", title: "Datei", text: "a".repeat(DIGEST_OVER + 10) };
    const short = { id: "kunde", title: "Kunde", text: "Max" };
    expect(needsDigest([long, short]).map((s) => s.id)).toEqual(["file:x"]);
    const huge = Array.from({ length: 50 }, (_, i) => ({ id: "file:" + i, title: "D" + i, text: "b".repeat(5000) }));
    const fitted = fitSources(huge, {});
    expect(fitted.reduce((n, s) => n + s.text.length, 0)).toBeLessThanOrEqual(BUDGET);
    expect(fitted.every((s) => s.text.length >= 1500)).toBe(true);
  });

  it("checks the answer: catalogue only, real sources, one item per template, facts must be in the material", () => {
    const sources = projectSources(project(), customer);
    const analysis = cleanAnalysis({
      lage: "Imagefilm für ein Café.",
      zusammenhaenge: ["Drohne über dem Gastgarten → Gäste im Bild → Hinweisschild"],
      unterlagen: [
        { vorlage: "praktikum", warum: "Praktikantin hilft", quellen: ["idea:i_000000000002", "talk:t_000000000001", "erfunden:1"],
          angaben: { praktikant: "Lena Probe", schule: "HTL Nirgendwo", zweck: "Mitarbeit beim Imagefilm am 20.10.2026 im Gastgarten." } },
        { vorlage: "praktikum", quellen: ["idea:i_000000000001"], angaben: { betreuer: "Frau Test" } },
        { vorlage: "kaffeemaschine", quellen: ["kunde"] },
        { vorlage: "einverstaendnis", quellen: ["idea:i_000000000001"], angaben: { zweck: "{kaputt}" } },
      ],
      offen: ["Drehtag bestätigen"],
    }, sources);
    expect(analysis.unterlagen.map((u) => u.template)).toEqual(["praktikum", "einverstaendnis", "teambestaetigung"]);   // the internship brings the customer's confirmation
    const praktikum = analysis.unterlagen[0];
    expect(praktikum.quellen).toEqual(["idea:i_000000000002", "talk:t_000000000001", "idea:i_000000000001"]);
    expect(praktikum.angaben).toEqual({ zweck: "Mitarbeit beim Imagefilm am 20.10.2026 im Gastgarten.", praktikant: "Lena Probe", betreuer: "Frau Test" }); // "HTL Nirgendwo" is not in the material
    expect(analysis.unterlagen[1].angaben).toEqual({});
    expect(analysis.zusammenhaenge).toHaveLength(1);
    expect(cleanAnalysis(null, sources)).toBeNull();
    expect(cleanAnalysis({ lage: "", unterlagen: [] }, sources)).toBeNull();
  });

  it("source names in any form the model writes them; the internship always brings the customer's team confirmation", () => {
    const sources = projectSources(project(), customer);
    expect(resolveSource("[idea:i_000000000002]", sources)).toBe("idea:i_000000000002");
    expect(resolveSource("idea:i_000000000002 To-do: Unterlagen senden", sources)).toBe("idea:i_000000000002");
    expect(resolveSource("To-do: Unterlagen senden: Praktikumsvereinbarung, Mitarbeiterinfo", sources)).toBe("idea:i_000000000002");
    expect(resolveSource("Kunde", sources)).toBe("kunde");
    expect(resolveSource("idea:i_999999999999", sources)).toBe("");
    expect(resolveSource("irgendwas", sources)).toBe("");
    const a = cleanAnalysis({ lage: "x", unterlagen: [{ vorlage: "praktikum", quellen: ["[idea:i_000000000002]"], angaben: { schule: "", zweck: "Mitarbeit beim Imagefilm am 20.10.2026 im Gastgarten." } }] }, sources);
    expect(a.unterlagen.map((u) => [u.template, u.quellen])).toEqual([["praktikum", ["idea:i_000000000002"]], ["teambestaetigung", ["idea:i_000000000002"]]]);
    expect(a.unterlagen[1].angaben).toEqual({ zweck: "Mitarbeit beim Imagefilm am 20.10.2026 im Gastgarten." });
  });

  it("without a model: paperwork from the words of open to-dos and needed talk points", () => {
    const p = project();
    p.talks[0].points = { needed: [{ key: "needed:x", text: "Drohnengenehmigung" }] };
    const a = fallbackAnalysis(p);
    expect(a.fallback).toBe(true);
    expect(a.unterlagen.map((u) => [u.template, u.quellen])).toEqual([
      ["einverstaendnis", ["idea:i_000000000001"]],
      ["praktikum", ["idea:i_000000000002"]],
      ["teambestaetigung", ["idea:i_000000000002"]],
      ["mitarbeiterinfo", ["idea:i_000000000002"]],
      ["drohne", ["talk:t_000000000001"]],
    ]);
  });

  it("the prompt names the catalogue and every source with its id", () => {
    const [system, user] = analysisMessages(projectSources(project(), customer), { today: new Date(Date.UTC(2026, 9, 15)) });
    expect(system.content).toContain("- praktikum: Praktikumsvereinbarung (INTERN)");
    expect(system.content).toContain("geht NIE an den Kunden");
    expect(system.content).toContain("- teambestaetigung: Bestätigung Team am Drehort (für den Kunden)");
    expect(system.content).toContain("- hinweisschild: Hinweisschild für Gäste");
    expect(system.content).toContain("nichts erfinden");
    expect(user.content).toContain("[idea:i_000000000002] To-do: Unterlagen senden: Praktikumsvereinbarung, Mitarbeiterinfo");
  });

  it("a run: new long material is digested once, then analysed; failures never throw", async () => {
    const asked = [];
    const fetchImpl = async (url, init) => {
      const body = JSON.parse(init.body);
      asked.push(body.messages[0].content.slice(0, 20));
      if (body.messages[0].content.startsWith("Fasse")) return reply("Kurzfassung des Angebots: zwei Drehtage.");
      return reply(JSON.stringify({ lage: "Imagefilm.", zusammenhaenge: [], unterlagen: [{ vorlage: "einverstaendnis", quellen: ["idea:i_000000000001"], angaben: {} }], offen: [] }));
    };
    const pdf = { id: "f_000000000001", name: "Angebot.pdf", text: "Angebot ".repeat(1000) };
    const sources = projectSources(project(), customer, [pdf]);
    const first = await analyseProject(sources, { url: "http://llm.invalid/v1", fetchImpl });
    expect(first.ok).toBe(true);
    expect(asked).toEqual(["Fasse das Dokument e", "Du bist die Projekta"]);
    expect(Object.values(first.digests)).toEqual(["Kurzfassung des Angebots: zwei Drehtage."]);
    asked.length = 0;
    const second = await analyseProject(sources, { url: "http://llm.invalid/v1", fetchImpl, digests: first.digests });
    expect(second.ok).toBe(true);
    expect(asked).toEqual(["Du bist die Projekta"]);   // the digest is reused
    expect(await analyseProject(sources, { url: "http://x/v1", fetchImpl: async () => reply("weiß nicht"), digests: first.digests })).toMatchObject({ ok: false, error: "unreadable" });
    expect(await analyseProject(sources, { url: "http://x/v1", fetchImpl: async () => { throw new Error("down"); } })).toMatchObject({ ok: false, error: "down" });
  });
});
