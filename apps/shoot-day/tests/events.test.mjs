import { describe, expect, it } from "vitest";
import {
  checkProposal, cleanEventProposals, closedDays, dateRequest, matchCandidate, parseEvent, parseMessages, resolveDate, resolveTimes, weekdayOf,
} from "../examples/shoot-day-events.mjs";
import { analysisMessages, cleanAnalysis, projectSources } from "../examples/shoot-day-brain.mjs";

// a Tuesday; every name and place below is made up
const TODAY = "2026-10-20";
const candidates = [
  { wdProjectId: 41, customer: "Gasthof Musterwirt", project: "Sommerreel", notes: "Ruhetag Mo/Di. Mag ruhige Bilder.", location: "Hauptplatz 3", date: "" },
  { wdProjectId: 42, customer: "Café Beispiel", project: "Imagefilm", notes: "", location: "Beispielgasse 1", date: "2026-10-23" },
  { wdProjectId: null, customer: "Café Beispiel", project: "Herbstaktion", notes: "", location: "", date: "" },
];
const reply = (content) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) });

describe("dates from words (deterministic, fixed today)", () => {
  it("relative dates", () => {
    expect(weekdayOf(TODAY)).toBe(2);
    const date = (text) => resolveDate(text, TODAY).date;
    expect(date("heute")).toBe("2026-10-20");
    expect(date("morgen um 9")).toBe("2026-10-21");
    expect(date("übermorgen")).toBe("2026-10-22");
    expect(date("heute morgen")).toBe("2026-10-20");
    expect(date("nächsten Donnerstag")).toBe("2026-10-22");
    expect(date("am Freitag")).toBe("2026-10-23");
    expect(date("Dienstag")).toBe("2026-10-27");          // today's weekday means next week
    expect(date("diesen Dienstag")).toBe("2026-10-20");
    expect(date("übernächsten Donnerstag")).toBe("2026-10-29");
    expect(date("Donnerstag nächste Woche")).toBe("2026-10-29");
    expect(date("in 2 Wochen")).toBe("2026-11-03");
    expect(date("in zwei Wochen")).toBe("2026-11-03");
    expect(date("in 3 Tagen")).toBe("2026-10-23");
    expect(date("in einem Monat")).toBe("2026-11-20");
    expect(date("irgendwann")).toBe("");
  });

  it("written dates; a date without year is the next one; a wrong weekday empties it", () => {
    const date = (text) => resolveDate(text, TODAY).date;
    expect(date("23.10.")).toBe("2026-10-23");
    expect(date("23.10.2026")).toBe("2026-10-23");
    expect(date("2026-11-02")).toBe("2026-11-02");
    expect(date("23. Oktober")).toBe("2026-10-23");
    expect(date("5.1.")).toBe("2027-01-05");
    expect(date("31.2.")).toBe("");
    expect(date("Freitag, 23.10.")).toBe("2026-10-23");
    const wrong = resolveDate("Donnerstag, 24.10.", TODAY);
    expect(wrong.date).toBe("");
    expect(wrong.conflict).toContain("Samstag");
  });

  it("times: ranges, single times, end after start", () => {
    expect(resolveTimes("von 9 bis 12 Uhr")).toEqual({ start: "09:00", end: "12:00" });
    expect(resolveTimes("9–12 Uhr")).toEqual({ start: "09:00", end: "12:00" });
    expect(resolveTimes("14:30-16:00")).toEqual({ start: "14:30", end: "16:00" });
    expect(resolveTimes("um 14.30 Uhr")).toEqual({ start: "14:30", end: "" });
    expect(resolveTimes("ab 9 Uhr")).toEqual({ start: "09:00", end: "" });
    expect(resolveTimes("10-8 Uhr")).toEqual({ start: "10:00", end: "" });
    expect(resolveTimes("in 2-3 Wochen")).toEqual({ start: "", end: "" });
    expect(resolveTimes("am 23.10. um 10 Uhr", TODAY)).toEqual({ start: "10:00", end: "" });
    expect(resolveTimes("25:00 Uhr")).toEqual({ start: "", end: "" });
  });

  it("closing days from customer notes", () => {
    expect(closedDays("Ruhetag Mo/Di").label).toBe("Mo/Di");
    expect(closedDays("Mo–Mi geschlossen").days).toEqual([1, 2, 3]);
    // opening hours in the same sentence are not closing days (invented example)
    expect(closedDays("Mi-So 8:30-17:00, Mo+Di Ruhetag. Reservierung nur telefonisch.").days).toEqual([1, 2]);
    expect(closedDays("Täglich 9:00-18:00 geöffnet, Mi geschlossen").days).toEqual([3]);
    expect(closedDays("montags und dienstags Ruhetag").label).toBe("Mo/Di");
    expect(closedDays("So geht das nicht, Ruhetag gibt es keinen").days).toEqual([]);
    expect(closedDays("Mag ruhige Bilder.").days).toEqual([]);
  });
});

describe("an appointment typed in", () => {
  it("rules only: date, times, project by name, closing-day hint", () => {
    const p = checkProposal(null, { text: "Dreh bei Musterwirt nächsten Donnerstag 9 bis 12 Uhr", today: TODAY, candidates });
    expect(p).toEqual({
      title: "Dreh bei Musterwirt", wdProjectId: 41, customer: "Gasthof Musterwirt", project: "Sommerreel",
      date: "2026-10-22", start: "09:00", end: "12:00", location: "Hauptplatz 3",
      hints: ["Gasthof Musterwirt hat Mo/Di Ruhetag – Donnerstag passt"],
    });
    const monday = checkProposal(null, { text: "Musterwirt Besprechung Montag 10:00", today: TODAY, candidates });
    expect(monday.date).toBe("2026-10-26");
    expect(monday.hints[0]).toBe("Gasthof Musterwirt hat Mo/Di Ruhetag – Montag fällt auf einen Ruhetag");
    // a whole day; another project already on that day
    const allDay = checkProposal(null, { text: "Imagefilm Schnittabnahme 23.10.", today: TODAY, candidates });
    expect(allDay).toMatchObject({ wdProjectId: 42, date: "2026-10-23", start: "", end: "" });
    expect(allDay.hints.join(" ")).toContain("Am 23.10.2026 ist schon „Imagefilm“");
    // two projects of the same customer: no project, but the customer and a hint
    const unclear = checkProposal(null, { text: "Café Beispiel anrufen morgen", today: TODAY, candidates });
    expect(unclear).toMatchObject({ wdProjectId: null, customer: "Café Beispiel", project: "", date: "2026-10-21" });
    expect(unclear.hints[0]).toContain("mehrere Projekte");
    // nothing known
    expect(checkProposal(null, { text: "Zahnarzt", today: TODAY, candidates })).toMatchObject({ title: "Zahnarzt", wdProjectId: null, customer: "", date: "" });
  });

  it("the model's answer is checked: weekday corrected, project only from the candidates, end after start", () => {
    // the words leave the date open, the model's date is a Wednesday although the text says Thursday
    const wrongDay = checkProposal({ title: "Dreh", wdProjectId: 41, date: "2026-10-28", start: "09:00", end: "08:00", hints: ["Bitte Parkplatz klären"] },
      { text: "Dreh Musterwirt Donnerstag in der Früh", today: TODAY, candidates });
    expect(wrongDay.date).toBe("2026-10-22");   // the words decide ("Donnerstag" = next Thursday)
    expect(wrongDay.hints).toContain("Datum nachgerechnet: Donnerstag, 22.10.2026");
    expect(wrongDay.end).toBe("");
    expect(wrongDay.hints).toContain("Bitte Parkplatz klären");
    // a date only the model knows, on the wrong weekday → moved to the weekday the text names
    const modelOnly = checkProposal({ title: "Dreh", wdProjectId: 41, date: "2026-11-04", start: "", end: "" },
      { text: "Dreh Musterwirt am Donnerstag nach Allerheiligen", today: TODAY, candidates });
    // "Donnerstag" alone is computed by the words: next Thursday
    expect(modelOnly.date).toBe("2026-10-22");
    const noWords = checkProposal({ title: "Dreh", wdProjectId: 999, project: "Imagefilm", customer: "Café Beispiel", date: "2026-11-05", start: "9", end: "17:30" },
      { text: "Dreh im November, Tag steht im Mail", today: TODAY, candidates });
    expect(noWords).toMatchObject({ wdProjectId: 42, date: "2026-11-05", start: "09:00", end: "17:30", location: "Beispielgasse 1" });
    const invented = checkProposal({ title: "X", wdProjectId: 999, date: "kein Datum" }, { text: "X", today: TODAY, candidates });
    expect(invented).toMatchObject({ wdProjectId: null, date: "" });
  });

  it("asks the local model with today's weekday and the candidates; falls back to the rules; never throws", async () => {
    const asked = [];
    const fetchImpl = async (url, init) => {
      asked.push({ url, body: JSON.parse(init.body) });
      return reply("```json\n{\"title\":\"Drehtag Sommerreel\",\"wdProjectId\":41,\"date\":\"2026-10-22\",\"start\":\"09:00\",\"end\":\"12:00\",\"location\":\"\",\"hints\":[]}\n```");
    };
    const result = await parseEvent({ text: "Dreh bei Musterwirt nächsten Donnerstag 9 bis 12 Uhr", today: TODAY, tz: "Europe/Vienna", candidates }, { url: "http://llm.invalid/v1", fetchImpl });
    expect(result).toMatchObject({ ok: true, source: "model", proposal: { title: "Drehtag Sommerreel", wdProjectId: 41, date: "2026-10-22", start: "09:00", end: "12:00", location: "Hauptplatz 3" } });
    expect(asked[0].url).toBe("http://llm.invalid/v1/chat/completions");
    expect(asked[0].body.messages[0].content).toContain("Heute ist Dienstag, 2026-10-20");
    expect(asked[0].body.messages[1].content).toContain("wdProjectId: 41 | Kunde: Gasthof Musterwirt | Projekt: Sommerreel");
    expect(asked[0].body.messages[1].content).toContain("Kundennotizen: Ruhetag Mo/Di");
    const broken = await parseEvent({ text: "Musterwirt morgen 10 Uhr", today: TODAY, candidates }, { url: "http://llm.invalid/v1", fetchImpl: async () => { throw new Error("down"); } });
    expect(broken).toMatchObject({ ok: true, source: "rules", proposal: { wdProjectId: 41, date: "2026-10-21", start: "10:00" } });
    expect(broken.proposal.hints[0]).toContain("Sprachmodell nicht erreichbar");
    const garbage = await parseEvent({ text: "Musterwirt morgen", today: TODAY, candidates }, { url: "http://llm.invalid/v1", fetchImpl: async () => reply("weiß nicht") });
    expect(garbage.source).toBe("rules");
    expect(await parseEvent({ text: "", today: "kaputt", tz: "Mars/Olympus", candidates: null })).toMatchObject({ ok: true, source: "rules", proposal: { title: "Termin", date: "" } });
    expect(parseMessages({ text: "x", today: TODAY, candidates: [] })[1].content).toContain("(keine)");
    expect(matchCandidate("Gasthof Musterwirt", candidates).candidate.wdProjectId).toBe(41);
  });
});

describe("appointments the project understanding proposes", () => {
  const customer = { name: "Gasthof Musterwirt", company: "", notes: "Ruhetag Mo/Di" };
  const project = (text) => ({ name: "Sommerreel", date: "", place: "Hauptplatz 3", ideas: [{ id: "i_000000000001", text, tags: ["todo"], done: false }], talks: [] });

  it("only when the material asks for dates; max 3, never in the past, weekday enforced, closing days dropped", () => {
    const asking = projectSources(project("Terminvorschläge Drehtage (2 Donnerstage) binnen 48 h an den Kunden"), customer);
    expect(dateRequest(asking.map((s) => s.text).join("\n"))).toContain("Donnerstage");
    const raw = {
      lage: "Reel für einen Gasthof.",
      termine: [
        { titel: "Drehtag 1", datum: "2026-10-22", von: "08:00", bis: "16:00", ort: "Hauptplatz 3", grund: "Donnerstag, kein Ruhetag", quellen: ["idea:i_000000000001"] },
        { titel: "Drehtag 2", datum: "2026-10-28", von: "", bis: "", grund: "Woche darauf" },          // a Wednesday → the Thursday after
        { titel: "Drehtag alt", datum: "2026-10-01", grund: "vorbei" },                                  // the past
        { titel: "Drehtag Montag", datum: "2026-10-26", grund: "Montag", von: "10:00", bis: "09:00" },   // names Monday: a closing day
        { titel: "Drehtag 1", datum: "2026-10-22", grund: "doppelt" },
        { titel: "Reserve", datum: "2026-11-05", von: "9:00", bis: "12:00" },
        { titel: "Zu viel", datum: "2026-11-12" },
      ],
    };
    const analysis = cleanAnalysis(raw, asking, { today: TODAY });
    expect(analysis.termine).toEqual([
      { titel: "Drehtag 1", datum: "2026-10-22", von: "08:00", bis: "16:00", ort: "Hauptplatz 3", grund: "Donnerstag, kein Ruhetag", quellen: ["idea:i_000000000001"] },
      { titel: "Drehtag 2", datum: "2026-10-29", von: "", bis: "", ort: "", grund: "Woche darauf", quellen: [] },
      { titel: "Reserve", datum: "2026-11-05", von: "09:00", bis: "12:00", ort: "", grund: "", quellen: [] },
    ]);
    // material that does not ask: no appointments, whatever the model says
    const quiet = projectSources(project("Logo als Vektor anfragen"), customer);
    expect(cleanAnalysis(raw, quiet, { today: TODAY }).termine).toEqual([]);
    expect(cleanEventProposals("kaputt", { material: "Terminvorschläge bitte", today: TODAY })).toEqual([]);
  });

  it("the prompt asks for termine only when the material does, with today's weekday", () => {
    const asking = projectSources(project("Terminvorschläge Drehtage (2 Donnerstage) binnen 48 h"), customer);
    const [system] = analysisMessages(asking, { today: new Date(Date.UTC(2026, 9, 20, 8)) });
    expect(system.content).toContain("Heute ist Dienstag, 2026-10-20.");
    expect(system.content).toContain("\"termine\":[{\"titel\"");
    expect(system.content).toContain("termine: NUR weil das Material ausdrücklich nach Terminen fragt");
    const [plain] = analysisMessages(projectSources(project("Logo anfragen"), customer), { today: new Date(Date.UTC(2026, 9, 20, 8)) });
    expect(plain.content).toContain("termine: [] – das Material fragt nicht nach Terminen.");
  });
});
