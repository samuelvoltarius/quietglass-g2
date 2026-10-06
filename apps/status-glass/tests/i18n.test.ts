import { afterEach, describe, expect, it, vi } from "vitest";
import { getLocale, languageSelect, locales, tr, type Locale } from "../src/i18n";
import { describeIssue, messages } from "../src/messages";
import { buildView, LINE_WIDTH, type StatusView } from "../src/glasses/view";
import { availableActions, buildActionsView } from "../src/glasses/actions-view";
import {
  acknowledge, applyError, applyReport, createSource, STALE_AFTER_MS, type SourceStatus,
} from "../src/monitor/dashboard";
import { formatMetric, type Action, type Metric } from "../src/protocol/schema";
import { EMPTY_DATA, maskToken, validateUrl } from "../src/storage/persist";
import { mountPhoneUi } from "../src/ui/phone";

const vars = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? "").sort();

/** Header + 5 body rows + footer = the 7 rows of the display. */
const BODY_ROWS = 5;

describe("translations", () => {
  it("has every key in German and English", () => {
    expect(Object.keys(messages.de).sort()).toEqual(Object.keys(messages.en).sort());
  });

  it("uses the same placeholders in both languages", () => {
    for (const key of Object.keys(messages.en)) {
      expect(vars(messages.de[key] ?? ""), key).toEqual(vars(messages.en[key] ?? ""));
    }
  });

  it("leaves no placeholder behind once filled", () => {
    for (const locale of locales) {
      for (const [key, text] of Object.entries(messages[locale])) {
        const filled = tr(messages, locale, key, Object.fromEntries(vars(text).map((name) => [name, 1])));
        expect(filled, key).not.toMatch(/\{\w+\}/);
      }
    }
  });

  it("uses real umlauts and no glyph the G2 cannot draw", () => {
    const german = Object.values(messages.de).join(" ");
    expect(german).toMatch(/[äöüß]/);
    expect(german).not.toMatch(/\b(fuer|ueber|zurueck|hinzufuegen|loeschen|schliessen|Gross)\b/i);
    for (const locale of locales) {
      for (const [key, text] of Object.entries(messages[locale])) {
        if (!key.startsWith("g.")) continue;
        expect(text, key).not.toMatch(/[▸◆]/);
        // Plain text plus the glyphs the G2 renders.
        expect(text, key).toMatch(/^[\x20-\x7EäöüÄÖÜß●→…·○]*$/);
        expect(text.length, key).toBeLessThanOrEqual(LINE_WIDTH);
      }
    }
  });

  it("says the app's own failure reasons in the chosen language, and leaves foreign text alone", () => {
    expect(describeIssue("unreachable", "de")).toBe("nicht erreichbar");
    expect(describeIssue("timed out", "de")).toBe("keine Antwort");
    expect(describeIssue("HTTP 503", "de")).toBe("Fehler 503");
    expect(describeIssue("HTTP 503", "en")).toBe("HTTP 503");
    expect(describeIssue("Response was not valid JSON.", "de")).toBe("Antwort nicht lesbar");
    expect(describeIssue("ECONNRESET by peer", "de")).toBe("ECONNRESET by peer");
  });

  it("writes numbers the German way, keeping the source's label and unit", () => {
    const load: Metric = { id: "l", label: "CPU", value: 34.56, unit: "%" };
    expect(formatMetric(load, "de")).toBe("CPU 34,6%");
    expect(formatMetric(load, "en")).toBe("CPU 34.6%");
  });
});

describe("language choice", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("follows the device language and falls back to English", () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
    vi.stubGlobal("navigator", { language: "de-AT" });
    expect(getLocale()).toBe("de");
    vi.stubGlobal("navigator", { language: "it-IT" });
    expect(getLocale()).toBe("en");
  });

  it("prefers the language picked on the phone, and survives blocked storage", () => {
    vi.stubGlobal("navigator", { language: "en-US" });
    vi.stubGlobal("localStorage", { getItem: () => "de", setItem: () => undefined });
    expect(getLocale()).toBe("de");
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => undefined });
    expect(getLocale()).toBe("en");
  });

  it("offers German and English on the phone", () => {
    const html = languageSelect("de");
    expect(html).toContain("Sprache");
    expect(html).toContain('<option value="de" selected>');
    expect(html.match(/<option/g)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Glasses screens, built for real, in both languages.

const metric = (over: Partial<Metric>): Metric => ({ id: "cpu", label: "CPU", ...over });
const LONG_NAME = "living-room-raspberry-pi-4-model-b-upstairs";
const LONG_LABEL = "Temperature of the attic sensor near the chimney";

function statusScreens(locale: Locale): StatusView[] {
  const healthy = applyReport(createSource("s1", "nas"), { name: "nas", metrics: [metric({ value: 10, warn: 80 })] }, 0);
  const broken = applyReport(createSource("s2", "pi"), {
    name: "pi",
    metrics: [
      metric({ id: "disk", label: "Disk", value: 99.5, unit: "%", warn: 80, critical: 95 }),
      metric({ id: "ram", label: "RAM", value: 85, unit: "%", warn: 80, critical: 95 }),
    ],
  }, 0);
  const long = applyReport(createSource("s3", LONG_NAME), {
    name: "x", metrics: [metric({ id: "t", label: LONG_LABEL, value: 41.25, unit: "°C", warn: 30 })],
  }, 0);
  const failures: SourceStatus[] = [
    "unreachable", "timed out", "failed", "HTTP 503", "Unreadable response",
    "Response was not valid JSON.", "Response was not a JSON object.", 'Response had no "metrics" array.',
    "x".repeat(60),
  ].map((error, i) => applyError(createSource("f" + i, i === 0 ? LONG_NAME : "host" + i), error, 0));
  const never = createSource("n1", "never-answered");
  const many = applyReport(createSource("m", "nas"), {
    name: "nas",
    metrics: Array.from({ length: 120 }, (_, i) => metric({ id: "m" + i, label: "Metric " + i, value: 99, warn: 80, critical: 95 })),
  }, 0);
  const ackAll = (s: SourceStatus): SourceStatus => [...(s.report?.metrics ?? []).map((m) => m.id), "__source", "__stale"]
    .reduce(acknowledge, s);

  const at = (sources: SourceStatus[], cursor = 0, now = 0): StatusView => buildView(sources, { cursor, locale }, now);
  return [
    at([]),
    at([healthy]),
    at(Array.from({ length: 120 }, (_, i) => applyReport(createSource("h" + i, "h" + i), { name: "h", metrics: [] }, 0))),
    at([broken]),
    at([broken], 1),
    at([long, ackAll(long)]),
    at(failures),
    at(failures.map(ackAll), 4),
    at([never]),
    at([healthy], 0, STALE_AFTER_MS + 1),
    at([many], 60),
    at([many, ...failures.map(ackAll), long], 999),
  ];
}

function actionScreens(locale: Locale): StatusView[] {
  const home = (actions: Action[]): SourceStatus =>
    applyReport(createSource("s1", "home"), { name: "home", metrics: [], actions }, 0);
  const list = availableActions([
    home([
      { id: "light", label: "Kitchen light" },
      { id: "door", label: "Front door", confirm: true },
      { id: "all", label: "Switch every light in the whole house off", confirm: true },
    ]),
    applyReport(createSource("s2", LONG_NAME), {
      name: "x", metrics: [], actions: Array.from({ length: 30 }, (_, i) => ({ id: "a" + i, label: LONG_LABEL, confirm: i % 2 === 0 })),
    }, 0),
  ]);
  const base = { cursor: 0, pendingId: null, result: null, busy: false, locale };
  return [
    buildActionsView([], base),
    buildActionsView(list, base),
    buildActionsView(list, { ...base, cursor: 1 }),
    buildActionsView(list, { ...base, cursor: 1, pendingId: "door" }),
    buildActionsView(list, { ...base, cursor: 2, pendingId: "all" }),
    buildActionsView(list, { ...base, cursor: 20, pendingId: "a16" }),
    buildActionsView(list, { ...base, busy: true }),
    buildActionsView(list, { ...base, result: { label: "Kitchen light", ok: true } }),
    buildActionsView(list, { ...base, result: { label: LONG_LABEL, ok: true } }),
    buildActionsView(list, { ...base, result: { label: "HTTP 403", ok: false } }),
    buildActionsView(list, { ...base, result: { label: "timed out", ok: false } }),
    buildActionsView(list, { ...base, result: { label: "y".repeat(80), ok: false } }),
  ];
}

describe("glasses text budget", () => {
  for (const locale of locales) {
    it(`fits every ${locale} screen into 7 rows of ${LINE_WIDTH} characters`, () => {
      for (const view of [...statusScreens(locale), ...actionScreens(locale)]) {
        expect(view.header.length, view.header).toBeLessThanOrEqual(LINE_WIDTH);
        expect(view.footer.length, view.footer).toBeLessThanOrEqual(LINE_WIDTH);
        expect(view.body.length).toBeLessThanOrEqual(BODY_ROWS);
        for (const line of [view.header, view.footer, ...view.body]) {
          expect(line, line).not.toContain("\n");
          expect(line.length, line).toBeLessThanOrEqual(LINE_WIDTH);
        }
      }
    });

    it(`never cuts the app's own ${locale} words, only text from sources`, () => {
      const [empty, ok, , broken, , , failures] = statusScreens(locale);
      const [none, list, , confirm] = actionScreens(locale);
      for (const view of [empty, ok, broken, failures, none, list, confirm]) {
        for (const line of [view!.header, view!.footer]) expect(line, line).not.toContain("…");
      }
      for (const line of [...empty!.body, ...none!.body]) expect(line).not.toMatch(/…$/);
      for (const line of failures!.body.slice(1)) {
        if (!line.includes("xxxx")) expect(line, line).not.toMatch(/…$/);
      }
    });
  }

  it("speaks German on every German screen", () => {
    const [empty, ok, , broken, , , failures, acked, never] = statusScreens("de");
    expect(empty!.body).toEqual(["Keine Quellen eingerichtet.", "Füge auf dem Handy eine hinzu."]);
    expect(ok!.body).toEqual(["1 von 1 ok"]);
    expect(ok!.footer).toBe("alles ok");
    expect(broken!.header).toBe("KRITISCH  2");
    expect(broken!.body[0]).toBe("> ! pi Disk 99,5%");
    expect(broken!.footer).toBe("Tippen = gesehen");
    expect(failures!.header).toBe("KEINE DATEN  9");
    expect(failures!.body.join("\n")).toContain("host3 Fehler 503");
    expect(failures!.body.join("\n")).toContain("host2 fehlgeschlagen");
    expect(acked!.body.some((line) => line.endsWith("(gesehen)"))).toBe(true);
    expect(never!.body[0]).toBe("> ? never-answered nicht erreichbar");

    const [none, list, confirmFirst, confirm, , , busy, done, , failed] = actionScreens("de");
    expect(none!.body).toEqual(["Keine Quelle bietet Aktionen an.", "Quellen sind von sich aus nur zum Ansehen."]);
    expect(list!.header).toBe("Aktionen");
    expect(list!.footer).toBe("Tippen = ausführen  ·  Halten = zurück");
    expect(confirmFirst!.footer).toBe("Tippen = erst bestätigen  ·  Halten = zurück");
    expect(confirm!.body[1]).toBe("> ! SICHER? home Front door");
    expect(confirm!.footer).toBe("Nochmal tippen = los  ·  Wischen = abbrechen");
    expect(busy!.header).toBe("Läuft…");
    expect(done!.header).toBe("Erledigt");
    expect(failed!.header).toBe("Fehlgeschlagen");
    expect(failed!.footer).toBe("Fehler 403  ·  Halten = zurück");
  });

  it("marks a stale source as such in both languages", () => {
    const quiet = applyReport(createSource("s1", "nas"), { name: "nas", metrics: [] }, 0);
    expect(buildView([quiet], { locale: "de" }, STALE_AFTER_MS + 1).body[0]).toBe("> ? nas keine neuen Daten");
    expect(buildView([quiet], { locale: "en" }, STALE_AFTER_MS + 1).body[0]).toBe("> ? nas no data");
  });
});

describe("phone page", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  function render(locale: Locale): string {
    let html = "";
    const root = {
      set innerHTML(value: string) { html = value; },
      get innerHTML() { return html; },
      querySelector: () => null,
      querySelectorAll: () => [],
    };
    vi.stubGlobal("document", { getElementById: () => root });
    mountPhoneUi({
      getData: () => ({ ...EMPTY_DATA, sources: [{ id: "s1", name: "nas", url: "http://nas.local/status", token: "abcdef" }] }),
      setData: async () => undefined,
      getLocale: () => locale,
    });
    return html;
  }

  it("is German throughout, with the picker on top and jargon folded away", () => {
    const html = render("de");
    expect(html).toContain('<option value="de" selected>');
    expect(html.indexOf('id="language"')).toBeLessThan(html.indexOf("Quelle hinzufügen"));
    expect(html).toContain("Token: gesetzt (6 Zeichen)");
    expect(html).toContain("unverschlüsselt (http)");
    expect(html).toContain("Bedienung an der Brille");
    expect(html).toContain("Alle <output id=\"poll-out\">30</output> s nachsehen");
    // The token field and the header talk sit under "Erweitert".
    expect(html.indexOf("<summary>Erweitert</summary>")).toBeLessThan(html.indexOf('id="token"'));
    for (const english of ["Add a source", "Remove", "Controls on the glasses", "Nothing configured", "Leave Status Glass"]) {
      expect(html).not.toContain(english);
    }
  });

  it("stays English when English is chosen", () => {
    const html = render("en");
    expect(html).toContain("Add a source");
    expect(html).toContain("token: set (6 chars)");
    expect(html).toContain('<option value="en" selected>');
  });

  it("explains a bad address in the chosen language", () => {
    expect(validateUrl("", "de").errors).toEqual(["Bitte gib eine Adresse ein."]);
    expect(validateUrl("ftp://x", "de").errors.join(" ")).toContain("http:// oder https://");
    expect(validateUrl("https://a:b@x/s", "de").errors.join(" ")).toContain("„Erweitert“");
    expect(validateUrl("not a url", "en").errors).toEqual(["URL is not valid."]);
    expect(maskToken(undefined, "de")).toBe("keiner");
  });
});
