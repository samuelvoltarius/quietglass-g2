import { describe, expect, it } from "vitest";
import { defaultCsvFormat, toCsv, type TimeEntry } from "../src/tracking/clock";

const at = (h: number, m = 0): number => new Date(2026, 9, 7, h, m).getTime();
const entry = (over: Partial<TimeEntry> = {}): TimeEntry => ({
  id: "e1", project: "Küche", startedAt: at(14, 5), endedAt: at(15, 35), ...over,
});
const BOM = "\uFEFF";

describe("CSV for Excel (Germany/Austria)", () => {
  const excel = (entries: TimeEntry[], locale: "de" | "en" = "de") => toCsv(entries, locale, "excel-de");

  it("starts with a UTF-8 byte order mark, so Excel reads umlauts", () => {
    const csv = excel([entry()]);
    expect(csv.startsWith(BOM)).toBe(true);
    expect(csv.indexOf(BOM, 1)).toBe(-1);
    // Encoded as the three bytes Excel looks for.
    expect([...new TextEncoder().encode(csv).slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(csv).toContain("Küche");
  });

  it("separates with semicolons and ends every line with CRLF", () => {
    const csv = excel([entry(), entry({ id: "e2" })]);
    expect(csv.slice(1).split("\r\n")).toEqual([
      "Datum;Projekt;Beginn;Ende;Sekunden;Stunden",
      "07.10.2026;Küche;07.10.2026 14:05;07.10.2026 15:35;5400;1,50",
      "07.10.2026;Küche;07.10.2026 14:05;07.10.2026 15:35;5400;1,50",
      "",
    ]);
    expect(csv.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
  });

  it("writes hours with a decimal comma, unquoted, so Excel sees a number", () => {
    const row = excel([entry({ endedAt: at(14, 5) + 2_700_000 })]).split("\r\n")[1] ?? "";
    expect(row.endsWith(";2700;0,75")).toBe(true);
  });

  it("writes local date and time the way German Excel reads them", () => {
    const row = excel([entry({ startedAt: at(0, 30), endedAt: at(9, 0) })]).split("\r\n")[1] ?? "";
    expect(row).toMatch(/^07\.10\.2026;Küche;07\.10\.2026 00:30;07\.10\.2026 09:00;/);
  });

  it("quotes a text field holding a semicolon, a quote or a line break, and nothing else", () => {
    const csv = excel([
      entry({ project: "Müller; Söhne" }),
      entry({ project: 'Halle "B"' }),
      entry({ project: "Zeile\neins" }),
      entry({ project: "Smith, John" }),
    ]);
    expect(csv).toContain(';"Müller; Söhne";');
    expect(csv).toContain(';"Halle ""B""";');
    expect(csv).toContain(';"Zeile\neins";');
    // A comma is not special with semicolons between fields.
    expect(csv).toContain(";Smith, John;");
  });

  it("keeps the formula guard on the project, and only there", () => {
    for (const name of ["=HYPERLINK(\"http://x\")", "+cmd", "-1", "@SUM(A1)"]) {
      const row = excel([entry({ project: name })]).split("\r\n")[1] ?? "";
      const field = row.split(";")[1] ?? "";
      expect(field.replace(/^"/, "").startsWith("'"), name).toBe(true);
    }
    const row = excel([entry()]).split("\r\n")[1] ?? "";
    // Seconds and hours are numbers: never prefixed, never quoted.
    expect(row.split(";").slice(4)).toEqual(["5400", "1,50"]);
  });

  it("translates only the header", () => {
    expect(excel([entry()], "en").slice(1).split("\r\n")[0]).toBe("date;project;start;end;seconds;hours");
  });

  it("is just the header for an empty log", () => {
    expect(excel([])).toBe(BOM + "Datum;Projekt;Beginn;Ende;Sekunden;Stunden\r\n");
  });
});

describe("standard CSV", () => {
  it("stays as before: comma, decimal point, ISO times, LF, no BOM", () => {
    const csv = toCsv([entry()], "de", "standard");
    expect(csv.startsWith(BOM)).toBe(false);
    expect(csv).not.toContain("\r");
    const [header, row] = csv.trim().split("\n");
    expect(header).toBe("Datum,Projekt,Beginn,Ende,Sekunden,Stunden");
    expect(row).toMatch(/^2026-10-07,Küche,\d{4}-\d{2}-\d{2}T[\d:.]+Z,\d{4}-\d{2}-\d{2}T[\d:.]+Z,5400,1\.50$/);
  });

  it("quotes a comma but not a semicolon", () => {
    expect(toCsv([entry({ project: "Smith, John" })])).toContain('"Smith, John"');
    expect(toCsv([entry({ project: "A; B" })])).toContain(",A; B,");
  });

  it("is the format when none is given", () => {
    expect(toCsv([entry()])).toBe(toCsv([entry()], "en", "standard"));
  });
});

describe("default format", () => {
  it("is Excel (Germany/Austria) in German and standard CSV in English", () => {
    expect(defaultCsvFormat("de")).toBe("excel-de");
    expect(defaultCsvFormat("en")).toBe("standard");
  });
});
