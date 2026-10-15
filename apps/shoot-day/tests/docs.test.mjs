import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TEMPLATE_IDS, cleanPurpose, matchTemplates, withoutProjectName, docContext, draftDocuments, findChrome, germanDate, loadBrand, matchTemplate, printPdf, purposeMessages, writePurpose,
} from "../examples/shoot-day-docs.mjs";

// invented data only
const brand = { name: "Beispiel Film", owner: "Erika Muster", address: "Musterweg 1, 1010 Wien", phone: "+43 000 000", email: "office@example.com", web: "example.com", uid: "ATU00000000" };
const customer = { name: "Max Beispiel", company: "Beispiel Café GmbH" };
const project = { name: "Imagefilm <Herbst>", date: "2026-10-20", place: "Beispielgasse 1", dispo: { call: "08:00", location: "", contact: "Frau Test" } };
const LOCAL_CHROME = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => existsSync(p)) ?? "";

describe("paperwork drafts (shoot-day-docs.mjs)", () => {
  it("finds the template a needed point asks for", () => {
    expect(matchTemplate("Drohnengenehmigung")).toBe("drohne");
    expect(matchTemplate("Freigabe für Luftaufnahmen")).toBe("drohne");
    expect(matchTemplate("Einverständnis der Mitarbeiter")).toBe("einverstaendnis");
    expect(matchTemplate("Model Release für die Barista")).toBe("einverstaendnis");
    expect(matchTemplate("Zustimmung der Personen im Bild")).toBe("einverstaendnis");
    expect(matchTemplate("Drehgenehmigung Gemeinde")).toBe("drehgenehmigung");
    expect(matchTemplate("Genehmigung für den Drehort im Park")).toBe("drehgenehmigung");
    expect(matchTemplate("Logo als Vektor")).toBeNull();
    expect(matchTemplate("Akkus laden")).toBeNull();
  });

  it("fills only what Shoot Day knows, escapes it, and leaves lines for the rest", () => {
    const ctx = docContext({ brand, customer, project, purpose: "Wir drehen einen kurzen Imagefilm." });
    const docs = draftDocuments("drohne", ctx, { brand, logoDataUri: "data:image/png;base64,AAAA" });
    expect(docs.map((d) => d.name)).toEqual(["Zustimmung Grundeigentümer Drohnenflug", "INTERN Checkliste Drohnenflug"]);
    expect(docs[1].html).toContain('<p class="intern-band">INTERN');   // never for the customer
    expect(docs[0].html).not.toContain('<p class="intern-band">');
    const html = docs[0].html;
    // never the internal project name, never an automatic date (Sarah: it confused readers)
    for (const doc of docs) {
      expect(doc.html).not.toContain("20.10.2026");
      expect(doc.html).not.toContain("Herbst");
      expect(doc.html).not.toContain("Stand:");
    }
    expect(html).toContain("Beispielgasse 1");
    expect(html).toContain("Beispiel Café GmbH, Max Beispiel");
    expect(html).toContain("Beispiel Film, Inh. Erika Muster");
    expect(html).toContain("Wir drehen einen kurzen Imagefilm.");
    expect(html).toContain("ATU00000000");
    expect(html).toContain('src="data:image/png;base64,AAAA"');
    expect(html).toContain('<span class="blank"></span>'); // owner, UAS number: unknown → line
    const odd = draftDocuments("drohne", docContext({ customer: { company: "Café <Test>" } }));
    expect(odd[1].html).toContain("Café &lt;Test&gt;");
    expect(odd[1].html).not.toContain("<Test>");
    expect(draftDocuments("drehgenehmigung", ctx).map((d) => d.name)).toEqual(["Drehgenehmigung"]);
    expect(draftDocuments("drehgenehmigung", ctx)[0].html).not.toContain("08:00");
    expect(draftDocuments("einverstaendnis", ctx)[0].html).toContain("Art. 7 Abs. 3 DSGVO");
    expect(draftDocuments("nix", ctx)).toEqual([]);
    expect(TEMPLATE_IDS).toEqual(["drohne", "drehgenehmigung", "einverstaendnis", "praktikum", "teambestaetigung", "mitarbeiterinfo", "hinweisschild"]);
    // the internship contract is internal; for the customer there is the team confirmation (no personal data)
    const [contract] = draftDocuments("praktikum", ctx);
    expect(contract.name).toBe("INTERN Praktikumsvereinbarung");
    expect(contract.html).toContain('<p class="intern-band">INTERN');
    const [confirm] = draftDocuments("teambestaetigung", docContext({ brand, customer, project, facts: { schule: "FH Beispielstadt" } }));
    expect(confirm.name).toBe("Bestätigung Team am Drehort");
    expect(confirm.html).not.toContain('<p class="intern-band">');
    expect(confirm.html).toContain("Pflichtpraktikum der FH Beispielstadt");
    expect(confirm.html).not.toMatch(/Geburtsdatum|Matrikel|Vergütung/);
    expect(matchTemplates("Unterlagen senden: Praktikumsvereinbarung, Mitarbeiterinfo")).toEqual(["praktikum", "teambestaetigung", "mitarbeiterinfo"]);
  });

  it("without purpose, brand or logo: still a whole document with lines to fill in", () => {
    const [doc] = draftDocuments("einverstaendnis", docContext({ project: { name: "X" } }));
    expect(doc.html).toContain("<h1>Einverständniserklärung zu Bild- und Tonaufnahmen</h1>");
    expect(doc.html).not.toContain("<img");
    expect(doc.html).not.toContain("<footer>");
    expect(doc.html).not.toContain("undefined");
    expect(germanDate("2026-01-05")).toBe("05.01.2026");
    expect(germanDate("irgendwann")).toBe("irgendwann");
  });

  it("the model writes only the purpose paragraph; anything odd is dropped", async () => {
    const messages = purposeMessages({ templateId: "drohne", customer, project, point: "Drohnengenehmigung", summary: "- Garten von oben" });
    expect(messages[0].content).toContain("nichts erfinden");
    expect(messages[1].content).toContain("Unterlage: Drohnenflug");
    expect(messages[1].content).not.toContain("20.10.2026");
    expect(messages[1].content).not.toContain("Imagefilm <Herbst>");
    expect(messages[0].content).toContain("NIE den internen Projektnamen");
    // and if a model still writes it, it is taken out
    expect(withoutProjectName("Wir drehen im Rahmen des Projekts „Imagefilm <Herbst>“ einen Film.", project.name)).toBe("Wir drehen im Rahmen des Projekts einen Film.");
    expect(docContext({ project, purpose: "Für Imagefilm <Herbst> drehen wir im Garten." }).purpose).not.toContain("Herbst");
    expect(cleanPurpose("Vorhaben: Wir filmen den Gastgarten von oben für die Website.")).toBe("Wir filmen den Gastgarten von oben für die Website.");
    expect(cleanPurpose("kurz")).toBe("");
    expect(cleanPurpose("Wir drehen am [DATUM] bei ______ im Garten.")).toBe("");
    const fetchImpl = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "Wir drehen am 20.10.2026 einen Imagefilm im Gastgarten." } }] }) });
    expect(await writePurpose({ templateId: "drohne", project }, { url: "http://llm.invalid/v1", fetchImpl })).toBe("Wir drehen am 20.10.2026 einen Imagefilm im Gastgarten.");
    expect(await writePurpose({ templateId: "drohne", project }, { url: "" })).toBe("");
    expect(await writePurpose({ templateId: "drohne", project }, { url: "http://x/v1", fetchImpl: async () => { throw new Error("down"); } })).toBe("");
  });

  it("reads the private brand file with its logo next to it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shootday-brand-"));
    try {
      writeFileSync(join(dir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      writeFileSync(join(dir, "brand.json"), JSON.stringify({ ...brand, logo: "logo.png", extra: "nein", uid: 5 }));
      const { brand: loaded, logoDataUri } = await loadBrand(join(dir, "brand.json"));
      expect(loaded).toMatchObject({ name: "Beispiel Film", email: "office@example.com" });
      expect(loaded).not.toHaveProperty("extra");
      expect(loaded).not.toHaveProperty("uid");
      expect(logoDataUri).toBe("data:image/png;base64,iVBORw==");
      writeFileSync(join(dir, "brand.json"), JSON.stringify({ name: "X", logo: "../../etc/passwd" }));
      expect((await loadBrand(join(dir, "brand.json"))).logoDataUri).toBe("");
      expect(await loadBrand("")).toEqual({ brand: null, logoDataUri: "" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("finds no chrome where there is none", () => {
    expect(findChrome("/does/not/exist")).toBe("");
    expect(findChrome("", "")).toBe("");
  });

  it.skipIf(!LOCAL_CHROME)("prints a real PDF with a local Chrome", async () => {
    const [doc] = draftDocuments("einverstaendnis", docContext({ brand, customer, project, purpose: "Test." }), { brand });
    const pdf = await printPdf(doc.html, { chrome: LOCAL_CHROME });
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(5000);
    await expect(printPdf("<p>x</p>", { chrome: "" })).rejects.toThrow(/no chrome/);
  }, 60000);
});
