/**
 * Quietglass Interaction Standard (QIS v1, docs/BEDIENSTANDARD.md) for Shoot Day:
 * arm-and-confirm for everything that cancels or resets, 2× only goes back,
 * footers in the fixed order and glossary, the Hilfe page, invertScroll in the
 * lists, phone tabs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardScene, Brief } from "../src/api/types";
import { locales, type Locale } from "../src/i18n";
import { armedFooter, footer } from "../src/glasses/footer";
import { ROW_WIDTH, wrap, type ScreenView } from "../src/glasses/screen";
import { buildView, helpView, MENU, ROOT_MENU, SIDE_MENU, type ArmKind, type LoadStatus, type Mode, type TakeScreen, type ViewState } from "../src/glasses/views";
import { lightModel } from "../src/sun/model";
import { messages, takeNotes } from "../src/messages";
import { resetGestureDedupe } from "../src/input/gestures";
import { VERSION } from "../src/version";
import { fakeRoot } from "./fake-dom";
import { mountPhoneUi } from "../src/ui/phone";

// ---- footers, headers, glossary on every view --------------------------------------------------

const ORDER: Record<Locale, string[]> = { de: ["Tippen", "Wischen", "Halten", "2×"], en: ["Tap", "Swipe", "Hold", "2×"] };
const RETIRED: Record<Locale, RegExp> = {
  de: /\bTap\b|\bWisch\b|\b2x\b|Doppeltipp|doppeltipp/,
  en: /\b2x\b|Doppeltipp|double-tap/i,
};

const LONG = "Außenaufnahme am Fluss bei Gegenlicht mit Drohne, Gimbal und zweiter Kamera auf dem Dach";
const SCENES: BoardScene[] = Array.from({ length: 12 }, (_, i) => ({
  n: i + 1, from: i * 3605, to: i * 3605 + 59, title: LONG, content: LONG, camera: LONG, overlay: LONG, goal: LONG, done: i % 2 === 0,
}));
const BRIEF: Brief = {
  id: "c_000000000001", name: LONG, company: LONG, phone: "+43 000 0000000000", email: "someone@example.invalid", notes: LONG.repeat(3),
  updated: Date.UTC(2026, 9, 14), ideas: Array.from({ length: 8 }, () => ({ text: LONG, tags: ["drohne"], project: LONG })),
  memory: [{ date: "2026-10-01T10:00:00", title: LONG, summary: LONG }], memoryError: false,
};

function state(locale: Locale, patch: Partial<ViewState> = {}): ViewState {
  return {
    locale,
    demo: true,
    configured: true,
    now: new Date(2026, 9, 7, 12, 0),
    mode: "menu",
    menuCursor: 0,
    project: LONG,
    pendingCount: 999,
    load: { kind: "ready" },
    message: LONG,
    rec: null,
    takes: {
      shots: Array.from({ length: 20 }, (_, i) => ({ scene: "12A" + i, shot: "B" + i, desc: LONG, size: "Insert" })),
      cursor: 5, screen: "card", actionCursor: 0, rollingSince: null, noteCursor: 6, ok: 999, ng: 999,
      last: { n: 999, status: "NG", note: LONG, ts: Date.now(), pending: false }, nextN: 1000, notes: takeNotes(locale),
    },
    prompter: { lines: wrap(LONG.repeat(5)), pos: 3.6, speed: 2.9, playing: false },
    schedule: {
      sheet: {
        date: LONG, call: LONG, location: LONG, contact: LONG, notes: LONG,
        schedule: Array.from({ length: 30 }, (_, i) => ({ time: `${String(8 + (i % 12)).padStart(2, "0")}:00`, what: LONG })),
      },
      scroll: 3,
    },
    pack: { items: Array.from({ length: 40 }, (_, i) => ({ group: "G", name: `${LONG} ${i}`, need: true, packed: i % 3 === 0 })), cursor: 3, missing: false },
    customerMode: false,
    customers: {
      list: Array.from({ length: 30 }, (_, i) => ({ id: `c_${String(i).padStart(12, "0")}`, name: `${LONG} ${i}`, company: LONG, projectCount: 9 })),
      cursor: 3, pending: null,
    },
    projects: {
      customer: { id: "c_000000000001", name: LONG, company: LONG, projectCount: 9 },
      list: Array.from({ length: 20 }, (_, i) => ({ id: `p_${String(i).padStart(12, "0")}`, name: `${LONG} ${i}`, date: "2026-10-14", place: LONG })),
      cursor: 2, active: "p_000000000002",
    },
    brief: { data: BRIEF, page: 0 },
    board: { boards: [{ id: "s_000000000001", title: LONG, scenes: SCENES }, { id: "s_000000000002", title: LONG, scenes: SCENES }], board: 0, cursor: 3, picking: false },
    ...patch,
  };
}

interface Named { readonly name: string; readonly view: ScreenView; readonly end: "back" | "exit" | "armed" | "none" }

function views(locale: Locale): Named[] {
  const out: Named[] = [];
  const add = (name: string, patch: Partial<ViewState>, end: Named["end"] = "back"): void => { out.push({ name, view: buildView(state(locale, patch)), end }); };
  const loads: LoadStatus[] = [{ kind: "ready" }, { kind: "loading" }, { kind: "error", code: "http", status: 503 }];
  const modes: Mode[] = ["customers", "projects", "brief", "menu", "board", "takes", "prompter", "schedule", "pack", "light"];

  for (const load of loads) {
    for (const mode of modes) {
      // The root of the app: the menu on a server without customers, the customer list otherwise.
      const root = (mode === "menu" && true) || mode === "customers";
      for (const customerMode of mode === "menu" ? [false, true] : [true]) {
        const exit = mode === "customers" || (mode === "menu" && !customerMode);
        add(`${mode} ${load.kind}${customerMode ? " customers" : ""}`, { mode, load, customerMode, demo: !root }, exit ? "exit" : "back");
      }
    }
  }
  add("menu unconfigured", { configured: false, demo: false, project: "" }, "exit");
  add("menu demo without project", { project: "", pendingCount: 0 }, "exit");
  add("menu last entry selected", { menuCursor: ROOT_MENU.length - 1 }, "exit");
  add("menu demo hint", { project: "", pendingCount: 0, message: "" }, "exit");
  add("customers empty", { mode: "customers", customerMode: true, customers: { list: [], cursor: 0, pending: null } }, "exit");
  add("customers last selected", { mode: "customers", customerMode: true, customers: { ...state(locale).customers, cursor: 30 } }, "exit");
  add("customers new (confirm)", { mode: "customers", customerMode: true, customers: { ...state(locale).customers, pending: LONG } }, "none");
  add("customers new, discard armed", { mode: "customers", customerMode: true, armed: "discardName", customers: { ...state(locale).customers, pending: LONG } }, "armed");
  add("takes card, delete last armed", { mode: "takes", armed: "delTake" }, "armed");
  add("takes actions, delete last armed", { mode: "takes", armed: "delTake", takes: { ...state(locale).takes, screen: "actions" } }, "armed");
  add("projects empty", { mode: "projects", customerMode: true, projects: { ...state(locale).projects, list: [], cursor: 0 } });
  add("brief last page", { mode: "brief", brief: { data: BRIEF, page: 99 } });
  add("brief loading", { mode: "brief", brief: { data: null, page: 0 } });
  add("board picking", { mode: "board", board: { ...state(locale).board, picking: true } });
  add("board empty", { mode: "board", board: { ...state(locale).board, boards: [] } });
  add("board open scene", { mode: "board", board: { ...state(locale).board, cursor: 1 } });
  add("board done scene", { mode: "board", board: { ...state(locale).board, cursor: 0 } });
  for (const screen of ["actions", "notes"] as TakeScreen[]) {
    add(`takes ${screen}`, { mode: "takes", takes: { ...state(locale).takes, screen } });
    add(`takes ${screen} rolling`, { mode: "takes", takes: { ...state(locale).takes, screen, rollingSince: Date.now() - 5000 } });
  }
  add("takes actions, cancel armed", { mode: "takes", armed: "roll", takes: { ...state(locale).takes, screen: "actions", rollingSince: Date.now() - 5000 } }, "armed");
  add("takes actions, nicht ok armed", { mode: "takes", armed: "ng", takes: { ...state(locale).takes, screen: "actions", actionCursor: 2 } }, "armed");
  add("takes empty", { mode: "takes", takes: { ...state(locale).takes, shots: [], cursor: 0 } });
  add("takes rolling card", { mode: "takes", takes: { ...state(locale).takes, rollingSince: Date.now() - 5000 } });
  add("prompter playing", { mode: "prompter", prompter: { ...state(locale).prompter, playing: true } });
  add("prompter empty", { mode: "prompter", prompter: { lines: [], pos: 0, speed: 0.4, playing: false } });
  add("pack missing", { mode: "pack", pack: { ...state(locale).pack, missing: true } });
  add("pack missing none", { mode: "pack", pack: { items: [], cursor: 0, missing: true } });
  add("pack empty", { mode: "pack", pack: { items: [], cursor: 0, missing: false } });
  for (const armed of ["packAll", "packReset"] as ArmKind[]) add(`pack ${armed} armed`, { mode: "pack", armed }, "armed");
  for (const target of ["takes", "pack", "customer"] as const) {
    for (const via of ["tap", "hold"] as const) {
      for (const busy of [false, true]) {
        for (const live of [undefined, LONG.repeat(4)]) {
          add(`rec ${target} ${via}${busy ? " busy" : ""}${live ? " live" : ""}`, { rec: { target, via, busy, ...(live ? { live } : {}) } }, busy && SIDE_MENU ? "none" : "back");
        }
      }
    }
  }
  add("rec, discard armed", { armed: "discardRec", rec: { target: "takes", via: "tap", busy: false } }, "armed");
  add("kept recording shows in the message row", { mode: "menu", customerMode: true, project: "", pendingCount: 0, message: locale === "de" ? "Aufnahme gemerkt · Menü: senden/verwerfen" : "Recording kept · menu: send/discard" }, "back");
  out.push({ name: "help", view: helpView(locale), end: "back" });
  return out;
}

describe("QIS footers, headers and glossary", () => {
  for (const locale of locales) {
    it(`${locale}: every footer is one row wide, in the order Tippen, Wischen, Halten, 2× and ends in 2× = back/exit`, () => {
      const all = views(locale);
      expect(all.length).toBeGreaterThan(80);
      for (const { name, view, end } of all) {
        const label = `${name}: ${view.footer}`;
        expect(view.footer.length, label).toBeLessThanOrEqual(ROW_WIDTH);
        if (end === "armed") {
          expect(view.footer, label).toMatch(locale === "de" ? /^Nochmal tippen = .+ · (Wischen\/)?2× = abbrechen$/ : /^Tap again = .+ · (Swipe\/)?2× = cancel$/);
          continue;
        }
        if (end === "none") {
          // A job or a pending decision: 2× does nothing (or only asks), so the footer does not list it.
          expect(view.footer, label).not.toContain("2×");
          const none = view.footer.split(" · ").map((part) => ORDER[locale].findIndex((w) => part.startsWith(`${w} =`))).filter((i) => i >= 0);
          expect(none, label).toEqual([...none].sort((a, b) => a - b));
          continue;
        }
        const parts = view.footer.split(" · ");
        const word = locale === "de" ? (end === "exit" ? "Ende" : "zurück") : (end === "exit" ? "exit" : "back");
        expect(parts.at(-1), label).toBe(`2× = ${word}`);
        const index = parts.map((part) => ORDER[locale].findIndex((w) => part.startsWith(`${w} =`)));
        const used = index.filter((i) => i >= 0);
        expect(used, label).toEqual([...used].sort((a, b) => a - b));
        expect(index.at(-1), label).toBe(3);
        expect(view.footer, label).not.toMatch(RETIRED[locale]);
      }
    });

    it(`${locale}: every header names the app first and fits the row; every row fits`, () => {
      for (const { name, view } of views(locale)) {
        expect(view.header.startsWith("SHOOT DAY · "), `${name}: ${view.header}`).toBe(true);
        for (const row of [view.header, view.footer, ...view.body]) expect(row.length, `${name}: ${row}`).toBeLessThanOrEqual(ROW_WIDTH);
        expect(view.header.length, name).toBeLessThanOrEqual(46);
      }
    });

    it(`${locale}: the light view's own footer follows the standard too`, () => {
      const text = lightModel({ at: Date.now(), now: Date.now(), place: null, source: null, locale, sheet: null }).hint;
      expect(text).toBe(locale === "de" ? "Tippen = jetzt · Wischen = Zeit ±30 min · 2× = zurück" : "Tap = now · Swipe = time ±30 min · 2× = back");
      const placed = lightModel({ at: Date.now(), now: Date.now(), place: { latitude: 47.8, longitude: 13.04 }, source: "phone", locale, sheet: null }).hint;
      expect(placed).toBe(text);
    });
  }

  it("the shared builder drops the swipe, then the hold - never the 2×", () => {
    expect(footer("de", { tap: "ok", swipe: "hoch", hold: "an" }, "exit")).toBe("Tippen = ok · Wischen = hoch · Halten = an · 2× = Ende");
    expect(footer("de", { tap: "öffnen", swipe: "wählen", hold: "neuer Kunde" }, "exit")).toBe("Tippen = öffnen · Halten = neuer Kunde · 2× = Ende");
    expect(footer("en", { swipe: "scroll" }, "back", "1/2")).toBe("1/2 · Swipe = scroll · 2× = back");
    expect(footer("de", { tap: "x".repeat(60) }, "back").endsWith("2× = zurück")).toBe(true);
    expect(footer("de", { tap: "x".repeat(60) }, "back").length).toBeLessThanOrEqual(ROW_WIDTH);
  });

  it("the armed row says what the next tap does and keeps the cancel hint", () => {
    expect(armedFooter("de", "Take abbrechen")).toBe("Nochmal tippen = Take abbrechen · Wischen/2× = abbrechen");
    expect(armedFooter("en", "cancel take")).toBe("Tap again = cancel take · Swipe/2× = cancel");
    expect(armedFooter("de", "x".repeat(80)).length).toBeLessThanOrEqual(ROW_WIDTH);
  });

  it("no German glasses string uses the retired words", () => {
    for (const [key, value] of Object.entries(messages["de"] ?? {})) {
      if (key.startsWith("p.")) continue; // the phone page is not the glasses
      expect(value, key).not.toMatch(/\bTap\b|\bWisch\b|\b2x\b|Doppeltipp|doppeltipp/);
    }
    for (const [key, value] of Object.entries(messages["en"] ?? {})) {
      if (key.startsWith("p.")) continue;
      expect(value, key).not.toMatch(/\b2x\b|double-tap/i);
    }
  });

  it("both languages have the same message keys", () => {
    expect(Object.keys(messages["en"] ?? {}).sort()).toEqual(Object.keys(messages["de"] ?? {}).sort());
  });
});

describe("QIS help page", () => {
  it("lists the four gestures in footer order, then what the app needs, in both languages", () => {
    for (const locale of locales) {
      const view = helpView(locale);
      expect(view.header).toBe(`SHOOT DAY · ${locale === "de" ? "Hilfe" : "Help"}`);
      expect(view.body.length).toBeLessThanOrEqual(7);
      for (const row of view.body) expect(row.length, row).toBeLessThanOrEqual(ROW_WIDTH);
      const idx = ORDER[locale].map((w) => view.body.findIndex((row) => row.startsWith(w)));
      expect(idx.every((i) => i >= 0)).toBe(true);
      expect(idx).toEqual([...idx].sort((a, b) => a - b));
      expect(view.body.at(-1)).toMatch(locale === "de" ? /^Braucht/ : /^Needs/);
    }
  });

  it("with the side menu off Hilfe is the last row of the menu and of the customer list again", () => {
    expect(SIDE_MENU).toBe(false);
    expect(ROOT_MENU).toEqual([...MENU, "help"]);
    expect(buildView(state("de", { project: "", menuCursor: 5 })).body.slice(0, 6)).toEqual(["  Takes", "  Teleprompter", "  Tagesplan", "  Packliste", "  Licht & Sonne", "> Hilfe"]);
    const customers = buildView(state("de", { mode: "customers", customerMode: true, customers: { ...state("de").customers, cursor: 30 } }));
    expect(customers.body.join("\n")).toContain("Hilfe");
    // The help page says how to delete a take.
    expect(helpView("de").body.join("\n")).toContain("Take löschen: im Take-Menü");
    expect(helpView("en").body.join("\n")).toContain("Delete take: in the take menu");
  });

  it("QIS v1.2: first start shows a one-line demo hint, in both languages", () => {
    expect(buildView(state("de", { project: "", pendingCount: 0, message: "" })).body).toContain("Demo · Verbindung am Handy einrichten");
    expect(buildView(state("en", { project: "", pendingCount: 0, message: "" })).body).toContain("Demo · set up the connection on your phone");
    expect(buildView(state("de", { project: "", pendingCount: 0, message: "", demo: false })).body.join("\n")).not.toContain("Demo ·");
  });

  it("QIS v1.2 no. 8: no HTTP code on the glasses", () => {
    const failing = buildView(state("de", { mode: "takes", load: { kind: "error", code: "http", status: 503 } }));
    expect(failing.body.join("\n")).toContain("Server meldet einen Fehler");
    for (const locale of locales) {
      for (const [key, value] of Object.entries(messages[locale] ?? {})) {
        if (key.startsWith("g.")) expect(value, key).not.toMatch(/HTTP/);
        if (key.startsWith("g.err.")) expect(value, key).not.toMatch(/\{status\}/);
      }
    }
  });
});

// ---- the glasses against the real app, demo data ------------------------------------------------

const harness = vi.hoisted(() => ({ bridge: null as unknown }));
vi.mock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
  waitForEvenAppBridge: async () => harness.bridge,
}));

const SETTINGS_KEY = "quietglass.shootday.v1";
const CLICK = 0, UP = 1, DOWN = 2, DOUBLE = 3, HOLD = 9, RELEASE = 10;

function fakeBridge(stored: Record<string, string> = {}) {
  let handler: ((event: unknown) => void) | undefined;
  const screen = new Map<number, string>();
  const state = { shutdowns: 0, mics: 0 };
  type Page = { textObject?: Array<{ containerID?: number; content?: string }>; menuObject?: { menuItems?: Array<{ itemID: number; itemName: string }> } };
  const menus: Array<Array<[number, string]>> = [];
  const adopt = (page?: Page): void => {
    for (const text of page?.textObject ?? []) screen.set(text.containerID ?? 0, text.content ?? "");
    menus.push((page?.menuObject?.menuItems ?? []).map((item): [number, string] => [item.itemID, item.itemName]));
  };
  const bridge = {
    getLocalStorage: async (key: string) => stored[key] ?? "",
    setLocalStorage: async () => true,
    rebuildPageContainer: async (page?: Page) => { adopt(page); return true; },
    createStartUpPageContainer: async (page: Page) => { adopt(page); return 0; },
    updateImageRawData: async () => "success",
    textContainerUpgrade: async (update: { containerID?: number; content?: string }) => { screen.set(update.containerID ?? 0, update.content ?? ""); return true; },
    audioControl: async (on: boolean) => { if (on) state.mics += 1; return true; },
    shutDownPageContainer: async () => { state.shutdowns += 1; return false; },
    onEvenHubEvent: (callback: (event: unknown) => void) => { handler = callback; return () => undefined; },
    onDeviceStatusChanged: () => () => undefined,
  };
  return {
    bridge, state, menus: () => menus,
    header: () => screen.get(1) ?? "", body: () => screen.get(2) ?? "", footer: () => screen.get(3) ?? "",
    ready: () => handler !== undefined,
    gesture: (eventType: number) => { resetGestureDedupe(); handler?.({ sysEvent: { eventType, eventSource: 1 } }); },
    menu: (itemID: number) => handler?.({ menuItemClickEvent: { itemID } }),
    audio: (bytes: number) => handler?.({ audioEvent: { audioPcm: new Uint8Array(bytes) } }),
  };
}

describe("QIS on the glasses", () => {
  beforeEach(() => {
    vi.stubGlobal("document", { getElementById: () => null });
    vi.stubGlobal("navigator", { language: "de-AT" });
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
    vi.stubGlobal("location", { search: "?demo=1&lang=de" });
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("the demo must not touch the network"))));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function boot(fake: ReturnType<typeof fakeBridge>): Promise<void> {
    harness.bridge = fake.bridge;
    vi.resetModules();
    await import("../src/main");
    await vi.waitFor(() => expect(fake.ready()).toBe(true));
    // The demo server knows customers: the app opens on the customer list.
    await vi.waitFor(() => expect(fake.header()).toBe("SHOOT DAY · KUNDEN · 3 · DEMO"));
  }

  /** Customer list → customer → active project: the project menu, Storyboard first. */
  async function toProject(fake: ReturnType<typeof fakeBridge>): Promise<void> {
    fake.gesture(CLICK); // the cursor stands on the customer of the active project
    await vi.waitFor(() => expect(fake.header()).toMatch(/^SHOOT DAY · KUNDE · /));
    fake.gesture(CLICK); // the cursor stands on the active project
    await vi.waitFor(() => expect(fake.header()).toMatch(/^SHOOT DAY · Beispiel-Dreh/));
  }

  /** Project menu → Takes → the actions list on "Take starten". */
  async function toTakeActions(fake: ReturnType<typeof fakeBridge>): Promise<void> {
    await toProject(fake);
    fake.gesture(DOWN); // Takes (Storyboard is first)
    fake.gesture(CLICK);
    await vi.waitFor(() => expect(fake.header()).toMatch(/^SHOOT DAY · TAKES · 1 von 5/));
    fake.gesture(CLICK);
    await vi.waitFor(() => expect(fake.body()).toContain("> Take OK"));
    fake.gesture(UP); // Take starten
    await vi.waitFor(() => expect(fake.body()).toContain("> Take starten"));
  }

  it("pages carry no side menu while its clicks do not arrive on the real glasses (step log 15.10.)", async () => {
    const fake = fakeBridge();
    await boot(fake);
    await toProject(fake);
    expect(fake.menus().length).toBeGreaterThan(1);
    expect(fake.menus().every((menu) => menu.length === 0)).toBe(true);
  });

  it("Hilfe is the last row of the customer list: a swipe gets there, a tap opens it, 2× or a tap goes back (not out)", async () => {
    const fake = fakeBridge();
    await boot(fake);
    fake.gesture(DOWN); // the cursor stands on the customer of the active project ...
    fake.gesture(DOWN); // ... and then goes on to Hilfe
    await vi.waitFor(() => expect(fake.body()).toContain("> Hilfe"));
    expect(fake.footer()).toBe("Tippen = öffnen · Halten = neuer Kunde · 2× = Ende");
    fake.gesture(CLICK);
    await vi.waitFor(() => expect(fake.header()).toBe("SHOOT DAY · Hilfe"));
    await vi.waitFor(() => expect(fake.footer()).toBe("Tippen = schließen · 2× = zurück"));
    fake.gesture(DOWN);
    fake.gesture(HOLD);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(fake.header()).toBe("SHOOT DAY · Hilfe");
    expect(fake.state.mics).toBe(0);
    fake.gesture(DOUBLE);
    await vi.waitFor(() => expect(fake.header()).toBe("SHOOT DAY · KUNDEN · 3 · DEMO"));
    await vi.waitFor(() => expect(fake.body()).toContain("> Hilfe"));
    expect(fake.state.shutdowns).toBe(0);
    fake.gesture(CLICK);
    await vi.waitFor(() => expect(fake.header()).toBe("SHOOT DAY · Hilfe"));
    fake.gesture(CLICK); // a tap closes it as well
    await vi.waitFor(() => expect(fake.header()).toBe("SHOOT DAY · KUNDEN · 3 · DEMO"));
  });

  it("the help opens over a module and goes back to exactly that module", async () => {
    const fake = fakeBridge();
    await boot(fake);
    await toProject(fake);
    fake.gesture(DOWN); // Takes
    fake.gesture(CLICK);
    await vi.waitFor(() => expect(fake.header()).toMatch(/^SHOOT DAY · TAKES · 1 von 5/));
    fake.menu(1);
    await vi.waitFor(() => expect(fake.header()).toBe("SHOOT DAY · Hilfe"));
    fake.gesture(DOUBLE);
    await vi.waitFor(() => expect(fake.header()).toMatch(/^SHOOT DAY · TAKES · 1 von 5/));
    expect(fake.state.shutdowns).toBe(0);
  });

  it("a recognised customer name: 2× only asks to discard it, a tap discards, a swipe or 2× keep it; nothing is created", async () => {
    const fake = fakeBridge();
    await boot(fake);
    fake.gesture(HOLD);
    await vi.waitFor(() => expect(fake.header()).toBe("SHOOT DAY · ● MIC · sprich jetzt"));
    await vi.waitFor(() => expect(fake.footer()).toBe("Loslassen = fertig · 2× = zurück"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    for (let i = 0; i < 10; i += 1) fake.audio(3200);
    fake.gesture(RELEASE);
    await vi.waitFor(() => expect(fake.header()).toBe("SHOOT DAY · NEUER KUNDE"));
    expect(fake.footer()).toBe("Tippen = anlegen · Halten = neu sprechen");
    fake.gesture(DOWN); // a swipe does nothing
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(fake.header()).toBe("SHOOT DAY · NEUER KUNDE");
    fake.gesture(DOUBLE); // 2× only asks
    await vi.waitFor(() => expect(fake.footer()).toBe("Nochmal tippen = Name verwerfen · Wischen/2× = abbrechen"));
    expect(fake.header()).toBe("SHOOT DAY · NEUER KUNDE");
    fake.gesture(DOUBLE); // 2× again cancels the question and keeps the name
    await vi.waitFor(() => expect(fake.footer()).toBe("Tippen = anlegen · Halten = neu sprechen"));
    fake.gesture(DOUBLE);
    await vi.waitFor(() => expect(fake.footer()).toMatch(/^Nochmal tippen/));
    fake.gesture(CLICK); // the confirming tap discards
    await vi.waitFor(() => expect(fake.header()).toBe("SHOOT DAY · KUNDEN · 3 · DEMO"));
    expect(fake.state.shutdowns).toBe(0);
  });

  it("cancelling a running take is armed: a tap asks, swipe / 2× / hold / 4 s cancel, the second tap carries it out", async () => {
    const fake = fakeBridge();
    await boot(fake);
    await toTakeActions(fake);
    fake.gesture(CLICK); // starts the take (not risky)
    await vi.waitFor(() => expect(fake.body()).toMatch(/Take 3 läuft/));
    fake.gesture(CLICK); // actions again
    await vi.waitFor(() => expect(fake.body()).toContain("> Take OK"));
    fake.gesture(UP);
    await vi.waitFor(() => expect(fake.body()).toContain("> Take abbrechen"));
    expect(fake.footer()).toBe("Tippen = ok · Wischen = wählen · 2× = zurück");

    fake.gesture(CLICK); // arms - the take runs on
    await vi.waitFor(() => expect(fake.footer()).toBe("Nochmal tippen = Take abbrechen · Wischen/2× = abbrechen"));
    fake.gesture(DOWN); // a swipe cancels - and does not move the selection
    await vi.waitFor(() => expect(fake.footer()).toBe("Tippen = ok · Wischen = wählen · 2× = zurück"));
    expect(fake.body()).toContain("> Take abbrechen");

    fake.gesture(CLICK);
    await vi.waitFor(() => expect(fake.footer()).toMatch(/^Nochmal tippen/));
    fake.gesture(DOUBLE); // 2× only cancels: still on the actions list
    await vi.waitFor(() => expect(fake.footer()).toBe("Tippen = ok · Wischen = wählen · 2× = zurück"));
    expect(fake.body()).toContain("> Take abbrechen");
    expect(fake.state.shutdowns).toBe(0);

    fake.gesture(CLICK);
    await vi.waitFor(() => expect(fake.footer()).toMatch(/^Nochmal tippen/));
    fake.gesture(HOLD); // a hold cancels as well and records nothing
    await vi.waitFor(() => expect(fake.footer()).toBe("Tippen = ok · Wischen = wählen · 2× = zurück"));
    expect(fake.state.mics).toBe(0);

    fake.gesture(CLICK);
    await vi.waitFor(() => expect(fake.footer()).toMatch(/^Nochmal tippen/));
    await vi.waitFor(() => expect(fake.footer()).toBe("Tippen = ok · Wischen = wählen · 2× = zurück"), { timeout: 6000 }); // 4 s without input
    fake.gesture(CLICK); // the stale arm is gone: this only arms again
    await vi.waitFor(() => expect(fake.footer()).toMatch(/^Nochmal tippen/));

    fake.gesture(CLICK); // the confirming tap
    await vi.waitFor(() => expect(fake.body()).not.toMatch(/läuft/));
    await vi.waitFor(() => expect(fake.footer()).toMatch(/^Tippen = Take/)); // back on the card, no take is running any more
    expect(fake.body()).not.toMatch(/läuft/);
  }, 20_000);

  it("marking NG is armed: first tap asks, swipe / 2× / hold / 4 s cancel without logging, the second tap logs it; OK stays one tap", async () => {
    const fake = fakeBridge();
    await boot(fake);
    await toTakeActions(fake);
    fake.gesture(DOWN); // Take OK
    await vi.waitFor(() => expect(fake.body()).toContain("> Take OK"));
    fake.gesture(DOWN); // Take NG
    await vi.waitFor(() => expect(fake.body()).toContain("> Take NG"));
    const idle = "Tippen = ok · Wischen = wählen · 2× = zurück";
    const asking = "Nochmal tippen = nicht ok · Wischen/2× = abbrechen";
    const quiet = async (): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(fake.body()).not.toMatch(/gespeichert|vorgemerkt/);
    };

    fake.gesture(CLICK);
    await vi.waitFor(() => expect(fake.footer()).toBe(asking));
    expect(fake.body()).toContain("> Take NG");
    fake.gesture(DOWN); // swipe cancels and does not move the selection
    await vi.waitFor(() => expect(fake.footer()).toBe(idle));
    expect(fake.body()).toContain("> Take NG");
    await quiet();

    fake.gesture(CLICK);
    await vi.waitFor(() => expect(fake.footer()).toBe(asking));
    fake.gesture(DOUBLE); // 2× only cancels
    await vi.waitFor(() => expect(fake.footer()).toBe(idle));
    expect(fake.body()).toContain("> Take NG");
    expect(fake.state.shutdowns).toBe(0);
    await quiet();

    fake.gesture(CLICK);
    await vi.waitFor(() => expect(fake.footer()).toBe(asking));
    fake.gesture(HOLD); // hold cancels, no microphone
    await vi.waitFor(() => expect(fake.footer()).toBe(idle));
    expect(fake.state.mics).toBe(0);
    await quiet();

    fake.gesture(CLICK);
    await vi.waitFor(() => expect(fake.footer()).toBe(asking));
    await vi.waitFor(() => expect(fake.footer()).toBe(idle), { timeout: 6000 }); // 4 s without input
    await quiet();
    fake.gesture(CLICK); // the stale arm is gone: this only arms again
    await vi.waitFor(() => expect(fake.footer()).toBe(asking));
    await quiet();

    fake.gesture(CLICK); // the confirming tap
    await vi.waitFor(() => expect(fake.body()).toMatch(/gespeichert: .* NG/));

    // OK is a single action: no question.
    fake.gesture(CLICK); // card -> actions
    await vi.waitFor(() => expect(fake.footer()).toBe(idle));
    for (let i = 0; i < 6 && !fake.body().includes("> Take OK"); i += 1) { // wherever the cursor opened, walk to Take OK
      fake.gesture(DOWN);
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    await vi.waitFor(() => expect(fake.body()).toContain("> Take OK"));
    fake.gesture(CLICK);
    await vi.waitFor(() => expect(fake.body()).toMatch(/gespeichert: .* OK/));
    expect(fake.footer()).not.toMatch(/^Nochmal tippen/);
  }, 20_000);

  it("a swipe and a 2× leave a running take running", async () => {
    const fake = fakeBridge();
    await boot(fake);
    await toTakeActions(fake);
    fake.gesture(CLICK); // starts the take on shot 1A
    await vi.waitFor(() => expect(fake.body()).toMatch(/Take 3 läuft/));
    fake.gesture(DOWN); // another shot: it has no running take
    await vi.waitFor(() => expect(fake.header()).toMatch(/TAKES · 2 von 5/));
    await vi.waitFor(() => expect(fake.body()).not.toMatch(/läuft/));
    fake.gesture(UP); // back: still running
    await vi.waitFor(() => expect(fake.header()).toMatch(/TAKES · 1 von 5/));
    await vi.waitFor(() => expect(fake.body()).toMatch(/Take 3 läuft/));
    fake.gesture(DOUBLE); // 2× to the menu and back in: the same
    await vi.waitFor(() => expect(fake.header()).toMatch(/^SHOOT DAY · Beispiel-Dreh/));
    fake.gesture(CLICK);
    await vi.waitFor(() => expect(fake.header()).toMatch(/TAKES · 1 von 5/));
    await vi.waitFor(() => expect(fake.body()).toMatch(/Take 3 läuft/));
  });

  it("invertScroll from the phone setting swaps the swipe direction in the customer list and in the menu", async () => {
    const inverted = fakeBridge({ [SETTINGS_KEY]: JSON.stringify({ serverUrl: "", invertScroll: true }) });
    await boot(inverted);
    inverted.gesture(DOWN); // SCROLL_BOTTOM is "up" when inverted: from the active customer to the one above
    await vi.waitFor(() => expect(inverted.body()).toContain("> Anna Beispiel"));
    inverted.gesture(UP);
    inverted.gesture(UP); // "down" when inverted: back, then Studio Nordlicht
    await vi.waitFor(() => expect(inverted.body()).toContain("> Studio Nordlicht"));
    inverted.gesture(UP);
    await vi.waitFor(() => expect(inverted.body()).toContain("> Hilfe"));
    inverted.gesture(UP);
    await vi.waitFor(() => expect(inverted.body()).toContain("> + Neuer Kunde (sprechen)"));
    inverted.gesture(DOWN);
    inverted.gesture(DOWN);
    inverted.gesture(DOWN); // back up to the active customer
    await vi.waitFor(() => expect(inverted.body()).toContain("> Bäckerei Sonnenschein"));
    await toProject(inverted);
    inverted.gesture(UP); // "down" when inverted: Storyboard -> Takes
    await vi.waitFor(() => expect(inverted.body()).toContain("> Takes"));
  });

  it("without the setting the directions are as before", async () => {
    const fake = fakeBridge();
    await boot(fake);
    fake.gesture(UP);
    await vi.waitFor(() => expect(fake.body()).toContain("> Anna Beispiel"));
    fake.gesture(DOWN); // and back to the active customer
    await vi.waitFor(() => expect(fake.body()).toContain("> Bäckerei Sonnenschein"));
    await toProject(fake);
    fake.gesture(DOWN);
    await vi.waitFor(() => expect(fake.body()).toContain("> Takes"));
  });
});

// ---- the phone page ------------------------------------------------------------------------------

describe("QIS phone tabs and the swipe-direction switch", () => {
  beforeEach(() => { vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined }); vi.stubGlobal("navigator", { language: "de-AT" }); });
  afterEach(() => { vi.unstubAllGlobals(); });

  function mount(locale: Locale) {
    const root = fakeRoot();
    vi.stubGlobal("document", { getElementById: () => root });
    mountPhoneUi({
      getSettings: () => ({ serverUrl: "", invertScroll: false }),
      saveSettings: async () => undefined,
      connection: () => ({ kind: "none" }),
      pendingCount: () => 0,
      locale: () => locale,
    });
    return root;
  }

  it("tabs run Drehtag, Licht, Brille, Verbindung, Mehr (content first, then Brille, Verbindung, Mehr last)", () => {
    const html = mount("de").innerHTML;
    const order = [...html.matchAll(/data-tab-go="(\w+)"/g)].map((match) => match[1]);
    expect(order).toEqual(["day", "light", "glasses", "connection", "more"]);
    const labels = [...html.matchAll(/<\/span>([^<]+)<\/button>/g)].map((match) => match[1]);
    expect(labels).toEqual(["Drehtag", "Licht", "Brille", "Verbindung", "Mehr"]);
    // The swipe switch lives under Brille, the address under Verbindung, language and version under Mehr.
    const glasses = html.slice(html.indexOf('data-tab="glasses"'), html.indexOf('data-tab="connection"'));
    expect(glasses).toContain('id="invert"');
    const connection = html.slice(html.indexOf('data-tab="connection"'), html.indexOf('data-tab="more"'));
    expect(connection).toContain('id="url"');
    expect(connection).not.toContain('id="language"');
    const more = html.slice(html.indexOf('data-tab="more"'));
    expect(more).toContain('id="language"');
    expect(more).toContain(`Version ${VERSION}`);
  });

  it("the English tabs read the same way", () => {
    const labels = [...mount("en").innerHTML.matchAll(/<\/span>([^<]+)<\/button>/g)].map((match) => match[1]);
    expect(labels).toEqual(["Shoot day", "Light", "Glasses", "Connection", "More"]);
  });

  it("the version is the one of this release", () => {
    expect(VERSION).toBe("0.7.6");
  });
});


