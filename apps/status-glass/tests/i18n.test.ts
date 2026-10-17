import { afterEach, describe, expect, it, vi } from "vitest";
import { getLocale, languageSelect, locales, tr, type Locale } from "../src/i18n";
import { describeIssue, messages } from "../src/messages";
import { LINE_WIDTH, VISIBLE_ROWS, problemsView, startView, type StatusView } from "../src/glasses/view";
import { availableActions, buildActionsView } from "../src/glasses/actions-view";
import {
  acknowledge, applyError, applyReport, createSource, problems, STALE_AFTER_MS, type SourceStatus,
} from "../src/monitor/dashboard";
import { formatMetric, type Action, type Metric } from "../src/protocol/schema";
import { EMPTY_DATA, maskToken, validateUrl } from "../src/storage/persist";
import { mountPhoneUi } from "../src/ui/phone";
import { cockpitModel, cockpitPages } from "../src/cockpit/model";
import { CELL_WIDTH, cellValueLayout, headlineLayout } from "../src/cockpit/compose";
import { pixelBackend } from "../src/screen/text";
import { DEMO_FLEET, demoFleetReport, demoStartFleet } from "../src/monitor/demo";

const vars = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? "").sort();

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
        expect(text, key).not.toMatch(/[▸◆‖]/);
        // Plain text plus the glyphs the G2 renders (QUS 1.3).
        expect(text, key).toMatch(/^[\x20-\x7EäöüÄÖÜß●→…·○×–|]*$/);
        expect(text.length, key).toBeLessThanOrEqual(LINE_WIDTH);
      }
    }
  });

  it("says the app's own failure reasons in the chosen language, and leaves foreign text alone", () => {
    expect(describeIssue("unreachable", "de")).toBe("nicht erreichbar");
    expect(describeIssue("timed out", "de")).toBe("keine Antwort");
    // QIS v1.2: no HTTP code on the glasses, the phone keeps it.
    expect(describeIssue("HTTP 503", "de")).toBe("Server meldet einen Fehler");
    expect(describeIssue("HTTP 503", "en")).toBe("Server reports an error");
    expect(describeIssue("HTTP 503", "de", { detail: true })).toBe("Fehler 503");
    expect(describeIssue("HTTP 503", "en", { detail: true })).toBe("HTTP 503");
    expect(describeIssue("Response was not valid JSON.", "de")).toBe("Antwort nicht lesbar");
    // Exception text never reaches the glasses; the phone still shows it.
    expect(describeIssue("ECONNRESET by peer", "de")).toBe("fehlgeschlagen");
    expect(describeIssue("ECONNRESET by peer", "de", { detail: true })).toBe("ECONNRESET by peer");
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

function textScreens(locale: Locale): StatusView[] {
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
  const hundred = Array.from({ length: 120 }, (_, i) => applyReport(createSource("h" + i, LONG_NAME + i), { name: "h", metrics: [] }, 0));

  const start = (sources: SourceStatus[], cursor = 0, now = 0, demo = false, actions = 3): StatusView =>
    startView(sources, cursor, now, { locale, demo, problemCount: problems(sources, now).length, actionCount: actions });
  const list = (sources: SourceStatus[], cursor = 0, now = 0, armed = false): StatusView =>
    problemsView(sources, problems(sources, now), cursor, now, { locale, demo: false, armed });
  return [
    start([]),
    start([healthy], 0, 0, false, 0),
    start([healthy, broken]),
    start(hundred, 60),
    start([healthy, broken], 1, 0, true),
    start([long, ackAll(long)], 2),
    start(failures, 4),
    start([never]),
    start([healthy], 0, STALE_AFTER_MS + 1),
    list([broken]),
    list([broken], 1),
    list([broken], 0, 0, true),
    list([long, ackAll(long)]),
    list(failures),
    list(failures.map(ackAll), 4),
    list([never]),
    list([healthy], 0, STALE_AFTER_MS + 1),
    list([many], 60),
    list([many, ...failures.map(ackAll), long], 999),
    list([healthy]),
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
    it(`fits every ${locale} text page into ${VISIBLE_ROWS} rows of ${LINE_WIDTH} characters`, () => {
      for (const view of [...textScreens(locale), ...actionScreens(locale)]) {
        expect(view.header.length, view.header).toBeLessThanOrEqual(LINE_WIDTH);
        expect(view.footer.length, view.footer).toBeLessThanOrEqual(LINE_WIDTH);
        expect(view.body.length).toBeLessThanOrEqual(VISIBLE_ROWS);
        for (const line of [view.header, view.footer, ...view.body]) {
          expect(line, line).not.toContain("\n");
          expect(line.length, line).toBeLessThanOrEqual(LINE_WIDTH);
        }
      }
    });

    it(`never cuts the app's own ${locale} words in header and footer`, () => {
      for (const view of [...textScreens(locale), ...actionScreens(locale)]) {
        for (const line of [view.header, view.footer]) {
          // Text from a source may be cut; "Läuft…" / "Running…" carry the ellipsis as part of the word.
          if (line.includes("y".repeat(20)) || line.includes("Temperature") || /Läuft…|Running…/.test(line)) continue;
          expect(line, line).not.toContain("…");
        }
      }
    });
  }

  it("speaks German on every German page", () => {
    const [empty, ok, two, , demo, , , never, , broken, , armed, , failures] = textScreens("de");
    expect(empty!.body).toEqual(["Keine Quellen eingerichtet.", "Füge auf dem Handy eine hinzu."]);
    expect(empty!.header).toBe("Status · offline");
    expect(ok!.body).toEqual(["● nas"]);
    expect(ok!.header).toBe("Status · ● live");
    expect(ok!.footer).toBe("Tippen = öffnen · Wischen = wählen · 2× = Ende");
    // The overview first, the servers indented under it, then the problem list and the actions.
    expect(two!.body).toEqual([
      "● Alle Server · 1/2 ok", "    nas · ok", "    pi · KRITISCH", "  Probleme · 2", "  Aktionen",
    ]);
    expect(demo!.body.at(-1)).toBe("Demo · Verbindung am Handy einrichten");
    expect(demo!.header).toBe("Status · Demo");
    expect(never!.body[0]).toBe("● never-answered");
    expect(broken!.header).toBe("Probleme · ● live");
    expect(broken!.body[0]).toBe("● ! pi Disk 99,5%");
    expect(armed!.footer).toBe("Nochmal tippen = gesehen · Wischen/2× = abbrechen");
    expect(failures!.body.join("\n")).toContain("host3 Server meldet einen Fehler");
    expect(failures!.body.join("\n")).toContain("host2 fehlgeschlagen");

    const [none, list, confirmFirst, confirm, , , busy, done, , failed] = actionScreens("de");
    expect(none!.body).toEqual(["Keine Aktionen angeboten."]);
    expect(list!.header).toBe("Aktionen · ● live");
    expect(list!.footer).toBe("Tippen = wählen · Wischen = Liste · 2× = zurück");
    expect(confirmFirst!.footer).toBe("Tippen = wählen · Wischen = Liste · 2× = zurück");
    expect(confirm!.body[1]).toBe("● ! SICHER? home Front door");
    expect(confirm!.footer).toBe("Nochmal tippen = ausführen · Wischen/2× = abbrechen");
    expect(busy!.header).toBe("Aktionen · Läuft…");
    expect(done!.header).toBe("Aktionen · Erledigt");
    expect(failed!.header).toBe("Aktionen · Fehlgeschlagen");
    expect(failed!.footer).toBe("Server meldet einen Fehler · 2× = zurück");
  });

  it("marks a stale source as such in both languages", () => {
    const quiet = applyReport(createSource("s1", "nas"), { name: "nas", metrics: [] }, 0);
    const now = STALE_AFTER_MS + 1;
    const row = (locale: Locale): string => problemsView([quiet], problems([quiet], now), 0, now, { locale, demo: false, armed: false }).body[0]!;
    expect(row("de")).toBe("● ? nas keine neuen Daten");
    expect(row("en")).toBe("● ? nas no data");
  });
});

describe("cockpit text budget", () => {
  const backend = pixelBackend();
  const NOW = 100_000;
  const sources = (machines = demoStartFleet(true)): SourceStatus[] =>
    machines.map((machine) => applyReport(createSource(machine.id, machine.name), demoFleetReport(machine, 11), NOW));

  for (const locale of locales) {
    it(`draws the app's own ${locale} words whole: headline, labels and values are never cut`, () => {
      for (const list of [sources(), sources(DEMO_FLEET.map((m) => ({ ...m, offlineMinutes: 0 }))), [], [createSource("x", "never")]]) {
        for (const page of cockpitPages(list)) {
          const model = cockpitModel({ sources: list, page, now: NOW, locale, demo: false });
          const headline = headlineLayout(backend, model.headline.filter((_, index) => !(page.kind === "host" && index === 0)));
          for (const line of headline.lines) expect(line, line).not.toContain("…");
          for (const cell of model.cells) {
            expect(cell.label.length, cell.label).toBeLessThanOrEqual(10);
            expect(cellValueLayout(backend, cell.value, CELL_WIDTH).text, cell.value).toBe(cell.value);
          }
          expect(model.hint.length).toBeLessThanOrEqual(LINE_WIDTH);
          expect(model.hint.endsWith(locale === "de" ? "2× = zurück" : "2× = back")).toBe(true);
        }
      }
    });
  }
});

describe("phone page", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  function render(locale: Locale, sources = [{ id: "s1", name: "nas", url: "http://nas.local/status", token: "abcdef" }]): string {
    let html = "";
    const root = {
      set innerHTML(value: string) { html = value; },
      get innerHTML() { return html; },
      querySelector: () => null,
      querySelectorAll: () => [],
    };
    vi.stubGlobal("document", { getElementById: () => root });
    mountPhoneUi({
      getData: () => ({ ...EMPTY_DATA, sources }),
      setData: async () => undefined,
      getLocale: () => locale,
    });
    return html;
  }

  it("is German throughout, with exactly three tabs in one bar and jargon folded away", () => {
    const html = render("de");
    expect(html).toContain('<option value="de" selected>');
    expect(html).toContain('id="language"');
    expect(html).toContain('<nav class="tabbar"');
    expect(html.match(/data-tab-go=/g)).toHaveLength(3);
    for (const label of ["Jetzt", "Server", "Einstellungen"]) expect(html).toContain("</span>" + label + "</button>");
    expect(html).toContain("QUIETGLASS / STATUS");
    expect(html).toContain("Token: gesetzt (6 Zeichen)");
    expect(html).toContain("unverschlüsselt (http)");
    expect(html).toContain("Bedienung an der Brille");
    expect(html).toContain("Alle <output id=\"poll-out\">30</output> s nachsehen");
    // The token field sits under "Erweitert".
    expect(html.indexOf("<summary>Erweitert</summary>")).toBeLessThan(html.indexOf('id="token"'));
    for (const english of ["Add a source", "Controls on the glasses", "Nothing configured", "Leave Status Glass"]) {
      expect(html).not.toContain(english);
    }
  });

  it("stays English when English is chosen", () => {
    const html = render("en");
    expect(html).toContain("Sources · 1");
    expect(html).toContain("token: set (6 chars)");
    expect(html).toContain('<option value="en" selected>');
    expect(html.match(/data-tab-go=/g)).toHaveLength(3);
  });

  it("folds the source card once a source is set up, and opens it with a checklist on the first run", () => {
    const configured = render("de");
    expect(configured).toContain('<details class="fold card">');
    expect(configured).not.toContain('class="steps"');
    const first = render("de", []);
    expect(first).toContain('<details class="fold card" open>');
    expect(first).toContain('class="steps"');
    expect(first).toContain("In drei Schritten");
    expect(first).toContain("Bis dahin zeigt die Brille Demo-Daten.");
  });

  it("explains a bad address in the chosen language", () => {
    expect(validateUrl("", "de").errors).toEqual(["Bitte gib eine Adresse ein."]);
    expect(validateUrl("ftp://x", "de").errors.join(" ")).toContain("http:// oder https://");
    expect(validateUrl("https://a:b@x/s", "de").errors.join(" ")).toContain("„Erweitert“");
    expect(validateUrl("not a url", "en").errors).toEqual(["URL is not valid."]);
    expect(maskToken(undefined, "de")).toBe("keiner");
  });
});
