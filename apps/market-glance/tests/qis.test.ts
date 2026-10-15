/** Quietglass Interaction Standard (QIS v1): footers, glossary, help page, scroll direction, 2x only goes back. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { footer, ROW_WIDTH } from "../src/glasses/footer";
import { helpView, listFooter, viewWords } from "../src/glasses/help";
import { glassesView, LINE_WIDTH, type ViewLabels } from "../src/glasses/view";
import { locales, type Locale } from "../src/i18n";
import { resetGestureDedupe } from "../src/input/gestures";
import { demoPositions, type Position } from "../src/markets/model";

const long = (over: Partial<Position> = {}): Position => ({ provider: "polymarket", title: "T".repeat(80), outcome: "O".repeat(80), quantity: 1, currentValue: 1, pnl: 12345.67, price: 0.5, ...over });
const many = Array.from({ length: 6 }, (_, i) => long({ title: `Market ${i}` }));

function labels(locale: Locale): ViewLabels {
  const w = viewWords[locale];
  return { mode: "STALE 99h  KP? ERR", title: "POSITIONS", empty: "No open positions", controls: listFooter(locale), help: w.help, helpControls: listFooter(locale, true), demoHint: w.demoHint };
}

const ORDER: Record<"de" | "en", string[]> = { de: ["Tippen", "Wischen", "Halten", "2×"], en: ["Tap", "Swipe", "Hold", "2×"] };

function views(locale: Locale) {
  const l = labels(locale);
  return [
    ["list (position selected)", glassesView(many, 0, l), "exit"],
    ["list (last position selected)", glassesView(many, many.length - 1, l), "exit"],
    ["list (Hilfe row selected)", glassesView(many, many.length, l), "exit"],
    ["list (empty)", glassesView([], 0, l), "exit"],
    ["list (demo)", glassesView(demoPositions(), 1, l), "exit"],
    ["help", helpView(locale), "back"],
  ] as const;
}

describe("QIS footers and headers", () => {
  for (const locale of locales) {
    it(`${locale}: every view fits one row, ends with 2x and keeps the gesture order`, () => {
      for (const [name, view, end] of views(locale)) {
        expect(view.header.length, `${name} header`).toBeLessThanOrEqual(ROW_WIDTH);
        expect(view.footer.length, `${name} footer`).toBeLessThanOrEqual(ROW_WIDTH);
        expect(view.header.startsWith("MARKET GLANCE · "), name).toBe(true);
        expect(view.body.length, name).toBeLessThanOrEqual(7);
        for (const row of view.body) expect(row.length, `${name}: ${row}`).toBeLessThanOrEqual(LINE_WIDTH);
        const last = view.footer.split(" · ").at(-1) ?? "";
        expect(last.startsWith("2× = "), `${name}: ${view.footer}`).toBe(true);
        if (locale === "de" || locale === "en") {
          const words = ORDER[locale];
          expect(last, name).toBe(`2× = ${locale === "de" ? (end === "exit" ? "Ende" : "zurück") : end === "exit" ? "exit" : "back"}`);
          const at = view.footer.split(" · ").map((part) => words.findIndex((w) => part.startsWith(`${w} =`)));
          expect(at.every((i) => i >= 0), `${name}: ${view.footer}`).toBe(true);
          expect(at, name).toEqual([...at].sort((a, b) => a - b));
        }
      }
    });
  }

  it("glossary: German never says Tap/Wisch/2x/Doppeltipp, English never 2x", () => {
    for (const [, view] of views("de")) {
      for (const text of [view.header, view.footer, ...view.body]) expect(text).not.toMatch(/\bTap\b|\bWisch\b|\b2x\b|Doppeltipp/);
    }
    for (const [, view] of views("en")) {
      for (const text of [view.header, view.footer, ...view.body]) expect(text).not.toMatch(/\b2x\b|Doppeltipp/);
    }
  });

  it("the shared builder drops swipe, then hold, never the 2x", () => {
    expect(footer("de", { tap: "neu", swipe: "wählen" }, "exit")).toBe("Tippen = neu · Wischen = wählen · 2× = Ende");
    expect(footer("de", { tap: "x".repeat(10), swipe: "y".repeat(20), hold: "z" }, "exit")).toBe(`Tippen = ${"x".repeat(10)} · Halten = z · 2× = Ende`);
    expect(footer("en", { tap: "x".repeat(34) }, "back").endsWith("2× = back")).toBe(true);
  });
});

describe("QIS help page", () => {
  it("is the last list row again (no side menu) and lists the four gestures plus what the app needs, in order", () => {
    for (const locale of ["de", "en"] as const) {
      const l = labels(locale);
      const last = glassesView(many, many.length, l);
      expect(last.body.join("\n"), locale).toContain(`> ${viewWords[locale].help}`);
      expect(last.footer.split(" · ")[0], locale).toBe(`${ORDER[locale][0]} = ${viewWords[locale].open}`);
      expect(glassesView(many, 0, l).footer.split(" · ")[0], locale).toBe(`${ORDER[locale][0]} = ${viewWords[locale].refresh}`);
      const rows = helpView(locale).body.filter((row) => row !== "");
      const words = ORDER[locale];
      const idx = words.map((w) => rows.findIndex((row) => row.startsWith(w)));
      expect(idx.every((i) => i >= 0)).toBe(true);
      expect(idx).toEqual([...idx].sort((a, b) => a - b));
      expect(rows.at(-1)).toMatch(locale === "de" ? /^Braucht/ : /^Needs/);
    }
  });
});

// ---- glasses behaviour against the real app, fake bridge ----

const harness = vi.hoisted(() => ({ bridge: null as unknown }));
vi.mock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
  waitForEvenAppBridge: async () => harness.bridge,
}));

function fakeBridge() {
  let handler: ((event: unknown) => void) | undefined;
  const text: Record<string, string> = {};
  const shutdown: (number | undefined)[] = [];
  const menus: string[][] = [];
  const bridge = {
    rebuildPageContainer: async () => true,
    createStartUpPageContainer: async (page: { menuObject?: { menuItems?: { itemName: string }[] }; textObject?: { containerName?: string; content?: string }[] }) => { if (page.menuObject) menus.push((page.menuObject.menuItems ?? []).map((item) => item.itemName)); for (const o of page.textObject ?? []) text[o.containerName ?? ""] = o.content ?? ""; return 0; },
    textContainerUpgrade: async (u: { containerName?: string; content?: string }) => { text[u.containerName ?? ""] = u.content ?? ""; return true; },
    shutDownPageContainer: async (mode?: number) => { shutdown.push(mode); return false; },
    onEvenHubEvent: (callback: (event: unknown) => void) => { handler = callback; return () => undefined; },
    onDeviceStatusChanged: () => () => undefined,
  };
  return { bridge, text, shutdown, menus, menu: (itemID: number) => { handler?.({ menuItemClickEvent: { itemID } }); }, emit: (eventType: number) => { resetGestureDedupe(); handler?.({ sysEvent: { eventType, eventSource: 1 } }); }, ready: () => handler !== undefined };
}

describe("QIS gestures on the glasses", () => {
  let fetches: string[];
  let store: Map<string, string>;
  beforeEach(() => {
    resetGestureDedupe();
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 0, 1, 12));
    fetches = [];
    store = new Map([["quietglass.locale", "en"]]);
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } });
    vi.stubGlobal("navigator", { language: "en-US" });
    vi.stubGlobal("document", { activeElement: null, querySelectorAll: () => ({ forEach: () => undefined }), querySelector: () => null });
    vi.stubGlobal("fetch", vi.fn((url: string) => { fetches.push(url); return new Promise<Response>(() => undefined); }));
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  async function boot() {
    const fake = fakeBridge();
    harness.bridge = fake.bridge;
    vi.resetModules();
    await import("../src/main");
    await vi.waitFor(() => expect(fake.ready()).toBe(true));
    await vi.advanceTimersByTimeAsync(10);
    return fake;
  }
  const tick = () => vi.advanceTimersByTimeAsync(10);

  it("pages carry no side menu while its clicks do not arrive on the real glasses (step log 15.10.)", async () => {
    const fake = await boot();
    expect(fake.menus).toEqual([]);
    fake.emit(2); await tick(); fake.emit(2); await tick(); fake.emit(2); await tick();
    fake.emit(0); await tick(); // tap on the Hilfe row -> help page
    expect(fake.text["header"]).toBe("MARKET GLANCE · Help");
    expect(fake.menus).toEqual([]);
  });

  it("demo list: the Hilfe row opens the help, a swipe never reloads, a hold does nothing, 2x closes it and does not exit", async () => {
    const fake = await boot();
    expect(fake.text["header"]).toBe("MARKET GLANCE · DEMO");
    expect(fake.text["footer"]).toBe("Tap = reload · Swipe = select · 2× = exit");
    expect(fake.text["body"]).toContain("Demo · set up the connection on the phone");
    const before = fetches.length;
    fake.emit(2); await tick(); fake.emit(2); await tick(); fake.emit(2); await tick();
    expect(fake.text["body"]).toContain("> Help");
    expect(fake.text["footer"]).toBe("Tap = open · Swipe = select · 2× = exit");
    expect(fetches.length).toBe(before); // a swipe never refreshes or changes data
    fake.emit(9); await tick();          // a hold does nothing
    expect(fake.text["header"]).toBe("MARKET GLANCE · DEMO");
    fake.emit(0); await tick();
    expect(fake.text["header"]).toBe("MARKET GLANCE · Help");
    expect(fake.text["footer"]).toBe("Tap = close · 2× = back");
    fake.emit(2); await tick(); // a swipe in the help does nothing
    expect(fake.text["header"]).toBe("MARKET GLANCE · Help");
    fake.emit(3); await tick();
    expect(fake.shutdown).toEqual([]); // 2x in the help only goes back
    expect(fake.text["header"]).toBe("MARKET GLANCE · DEMO");
    fake.emit(3); await tick();
    expect(fake.shutdown).toEqual([1]); // on the root list it opens the system exit dialog
  });

  it("invertScroll from the phone setting reverses the swipe direction", async () => {
    store.set("markets.invert", "1");
    const fake = await boot();
    fake.emit(1); await tick(); // SCROLL_TOP normally moves up (nothing above the first row); inverted it moves down
    expect(fake.text["body"]).toContain("> K DEMO-TEMP-80");
  });

  it("without the setting SCROLL_BOTTOM moves down", async () => {
    const fake = await boot();
    fake.emit(2); await tick();
    expect(fake.text["body"]).toContain("> K DEMO-TEMP-80");
  });
});
