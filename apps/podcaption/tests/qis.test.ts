/** Quietglass Interaction Standard (QIS v1): footers, glossary, help page, 2× only goes back, scroll direction, phone tabs. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { footer, ROW_WIDTH } from "../src/glasses/footer";
import { captionFooter, helpView } from "../src/glasses/help";
import { locales, type Locale } from "../src/i18n";
import { resetGestureDedupe } from "../src/input/gestures";
import { messages } from "../src/messages";
import { LINE_WIDTH } from "../src/podcast/view";

const ORDER: Record<"de" | "en", string[]> = { de: ["Tippen", "Wischen", "Halten", "2×"], en: ["Tap", "Swipe", "Hold", "2×"] };
const RETIRED: Record<"de" | "en", RegExp> = {
  de: /\bTap\b|\bWisch\b|\b2x\b|Doppeltipp|doppeltipp/,
  en: /\b2x\b|Doppeltipp|double-tap/i,
};

interface Named { readonly name: string; readonly header: string; readonly footer: string; readonly end: "exit" | "back" }
function views(locale: Locale): Named[] {
  const out: Named[] = [];
  for (const playing of [true, false]) out.push({ name: playing ? "captions playing" : "captions paused", header: "", footer: captionFooter(locale, playing), end: "exit" });
  const help = helpView(locale);
  out.push({ name: "help", header: help.header, footer: help.footer, end: "back" });
  return out;
}

describe("QIS footers", () => {
  for (const locale of locales) {
    it(`${locale}: every footer fits one row and ends with 2×`, () => {
      for (const view of views(locale)) {
        expect(view.footer.length, `${view.name}: ${view.footer}`).toBeLessThanOrEqual(ROW_WIDTH);
        expect(view.footer.split(" · ").at(-1)?.startsWith("2× = "), view.name).toBe(true);
      }
    });
  }

  for (const locale of ["de", "en"] as const) {
    it(`${locale}: Tippen, Wischen, Halten, then 2× = ${locale === "de" ? "Ende|zurück" : "exit|back"}, glossary respected`, () => {
      for (const view of views(locale)) {
        const parts = view.footer.split(" · ");
        const word = locale === "de" ? (view.end === "exit" ? "Ende" : "zurück") : view.end === "exit" ? "exit" : "back";
        expect(parts.at(-1), view.name).toBe(`2× = ${word}`);
        const words = ORDER[locale];
        const at = parts.map((part) => words.findIndex((w) => part.startsWith(`${w} =`)));
        expect(at.every((i) => i >= 0), `${view.name}: ${view.footer}`).toBe(true);
        expect(at, view.name).toEqual([...at].sort((a, b) => a - b));
        expect(view.footer, view.name).not.toMatch(RETIRED[locale]);
      }
    });

    it(`${locale}: the help page names the app, lists the four gestures in order and what the app needs`, () => {
      const view = helpView(locale);
      expect(view.header.startsWith("PODCAPTION · ")).toBe(true);
      expect(view.header.length).toBeLessThanOrEqual(ROW_WIDTH);
      expect(view.body.length).toBeLessThanOrEqual(7);
      for (const row of view.body) expect(row.length, row).toBeLessThanOrEqual(LINE_WIDTH);
      const words = ORDER[locale];
      const idx = words.map((w) => view.body.findIndex((row) => row.startsWith(w)));
      expect(idx.every((i) => i > 0)).toBe(true);
      expect(idx).toEqual([...idx].sort((a, b) => a - b));
      expect(view.body.at(-1)).toMatch(locale === "de" ? /^Braucht/ : /^Needs/);
    });
  }

  it("menu labels fit 32 bytes in every language", () => {
    for (const locale of locales) for (const key of ["mHelp", "mSwipeNormal", "mSwipeInverted"]) {
      const label = messages[locale]?.[key] ?? "";
      expect(new TextEncoder().encode(label).length, `${locale}.${key}`).toBeLessThanOrEqual(32);
    }
  });

  it("no status code reaches the glasses: the glasses text of a server error has no digits", () => {
    for (const locale of locales) expect(messages[locale]?.["errServerGlasses"] ?? "", locale).not.toMatch(/\d|HTTP|\{status\}/);
  });

  it("the caption header is APPNAME · state in every language", () => {
    for (const locale of locales) for (const play of ["tagPlay", "tagPause"]) for (const source of ["tagDemo", "tagFile", "tagFeed"]) {
      const header = `PODCAPTION · ${messages[locale]?.[play]} · ${messages[locale]?.[source]}`;
      expect(header.length, header).toBeLessThanOrEqual(LINE_WIDTH);
    }
  });

  it("the shared builder drops the swipe first, then the hold, never the 2×", () => {
    expect(footer("de", { tap: "Pause", swipe: "blättern", hold: "Hilfe" }, "exit")).toBe("Tippen = Pause · Halten = Hilfe · 2× = Ende");
    expect(footer("en", { tap: "play", swipe: "scroll" }, "exit")).toBe("Tap = play · Swipe = scroll · 2× = exit");
    expect(footer("de", { tap: "x".repeat(60) }, "back").endsWith("2× = zurück")).toBe(true);
    expect(footer("de", { tap: "x".repeat(60) }, "back").length).toBeLessThanOrEqual(ROW_WIDTH);
  });

  it("no German string uses the retired words", () => {
    for (const [key, text] of Object.entries(messages["de"] ?? {})) expect(text, key).not.toMatch(/\bTap\b|\bWisch\b|\b2x\b|Doppeltipp|doppeltipp/);
    for (const [key, text] of Object.entries(messages["en"] ?? {})) expect(text, key).not.toMatch(/\b2x\b|double-tap/i);
  });
});

// ---- against the real app, fake bridge and fake phone DOM --------------------------------------

const harness = vi.hoisted(() => ({ bridge: null as unknown }));
vi.mock("@evenrealities/even_hub_sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@evenrealities/even_hub_sdk")>()),
  waitForEvenAppBridge: async () => harness.bridge,
}));

function fakeBridge() {
  let handler: ((event: unknown) => void) | undefined;
  const text: Record<string, string> = {};
  const menus: string[][] = [];
  const rebuilds: string[][] = [];
  const shutdown = { modes: [] as (number | undefined)[], answer: (): Promise<boolean> => Promise.resolve(false) };
  const bridge = {
    rebuildPageContainer: async (page: { textObject?: { containerName?: string; content?: string }[]; menuObject?: { menuItems?: { itemName?: string; itemID?: number }[] } }) => { rebuilds.push((page.menuObject?.menuItems ?? []).map((item) => item.itemID + ":" + item.itemName)); for (const o of page.textObject ?? []) text[o.containerName ?? ""] = o.content ?? ""; return true; },
    createStartUpPageContainer: async (page: { textObject?: { containerName?: string; content?: string }[]; menuObject?: { menuItems?: { itemName?: string; itemID?: number }[] } }) => { menus.push((page.menuObject?.menuItems ?? []).map((item) => item.itemID + ":" + item.itemName)); for (const o of page.textObject ?? []) text[o.containerName ?? ""] = o.content ?? ""; return 0; },
    textContainerUpgrade: async (u: { containerName?: string; content?: string }) => { text[u.containerName ?? ""] = u.content ?? ""; return true; },
    shutDownPageContainer: (mode?: number): Promise<boolean> => { shutdown.modes.push(mode); return shutdown.answer(); },
    onEvenHubEvent: (callback: (event: unknown) => void) => { handler = callback; return () => undefined; },
    onDeviceStatusChanged: () => () => undefined,
  };
  return { bridge, text, menus, rebuilds, shutdown, menu: (itemID: number) => handler?.({ menuItemClickEvent: { itemID } }), emit: (eventType: number) => { resetGestureDedupe(); handler?.({ sysEvent: { eventType, eventSource: 1 } }); }, ready: () => handler !== undefined };
}

const CLICK = 0, UP = 1, DOWN = 2, DOUBLE = 3, HOLD = 9;

describe("QIS on the glasses", () => {
  let store: Map<string, string>;
  const app = { innerHTML: "" };
  const buttons: Array<{ dataset: Record<string, string>; fire: () => void }> = [];
  const listeners: Record<string, (event?: unknown) => void> = {};
  beforeEach(() => {
    resetGestureDedupe();
    vi.useFakeTimers();
    store = new Map([["quietglass.locale", "de"]]);
    app.innerHTML = "";
    buttons.length = 0;
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } });
    vi.stubGlobal("navigator", { language: "de-AT" });
    vi.stubGlobal("document", {
      querySelector: (selector: string) => {
        if (selector === "#app") return app;
        if (selector === "#invert" || selector === "#language" || selector === "#toggle") return { addEventListener: (_t: string, fn: () => void) => { listeners[selector] = fn; } };
        return null;
      },
      querySelectorAll: () => ({ forEach: (fn: (button: unknown) => void) => { for (const b of [...app.innerHTML.matchAll(/data-tab-go="(\w+)"/g)]) fn({ dataset: { tabGo: b[1] }, addEventListener: (_t: string, l: () => void) => { listeners[`tab:${b[1]}`] = l; } }); } }),
      activeElement: null,
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
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

  it("a hold opens the help, a swipe in it changes nothing, tap and 2× go back - 2× never exits from the help", async () => {
    const fake = await boot();
    expect(fake.text["footer"]).toBe("Tippen = Start · Halten = Hilfe · 2× = Ende");
    expect(fake.text["header"]).toBe("PODCAPTION · PAUSE · BEISPIEL");
    fake.emit(HOLD); await tick();
    expect(fake.text["header"]).toBe("PODCAPTION · Hilfe");
    expect(fake.text["footer"]).toBe("Tippen = schließen · 2× = zurück");
    fake.emit(DOWN); await tick();
    expect(fake.text["header"]).toBe("PODCAPTION · Hilfe");
    fake.emit(DOUBLE); await tick();
    expect(fake.shutdown.modes).toEqual([]);
    expect(fake.text["header"]).toBe("PODCAPTION · PAUSE · BEISPIEL");
    fake.emit(HOLD); await tick();
    fake.emit(CLICK); await tick();
    expect(fake.text["header"]).toBe("PODCAPTION · PAUSE · BEISPIEL");
    expect(fake.shutdown.modes).toEqual([]);
    fake.emit(DOUBLE); await tick(); // on the captions page: the system exit dialog
    expect(fake.shutdown.modes).toEqual([1]);
  });

  it("a running caption session keeps running through the help and a cancelled exit", async () => {
    const fake = await boot();
    fake.emit(CLICK); await tick();
    expect(fake.text["header"]).toBe("PODCAPTION · LÄUFT · BEISPIEL");
    expect(fake.text["footer"]).toBe("Tippen = Pause · Halten = Hilfe · 2× = Ende");
    fake.emit(HOLD); await tick();
    fake.emit(DOUBLE); await tick(); // 2× in the help: back to the captions, still playing
    expect(fake.shutdown.modes).toEqual([]);
    expect(fake.text["header"]).toBe("PODCAPTION · LÄUFT · BEISPIEL");
    const before = fake.text["body"];
    await vi.advanceTimersByTimeAsync(9000);
    expect(fake.text["body"]).not.toBe(before); // the captions moved on
    fake.emit(DOUBLE); await tick(); // exit dialog, declined: playback carries on
    expect(fake.shutdown.modes).toEqual([1]);
    const afterCancel = fake.text["body"];
    await vi.advanceTimersByTimeAsync(5000);
    expect(fake.text["body"]).not.toBe(afterCancel);
  });

  it("pages carry no side menu while its clicks do not arrive on the real glasses (step log 15.10.)", async () => {
    const fake = await boot();
    expect(fake.menus).toEqual([[]]); // created without a menuObject
    fake.emit(HOLD); await tick();
    fake.emit(DOUBLE); await tick();
    fake.emit(CLICK); await tick();
    for (const rebuilt of fake.rebuilds) expect(rebuilt).toEqual([]);
    expect(fake.menus).toHaveLength(1);
  });

  it("a hold opens the help (the swipe direction is a phone setting), a menu click still works when the menu is switched on again", async () => {
    const fake = await boot();
    fake.emit(HOLD); await tick();
    expect(fake.text["header"]).toBe("PODCAPTION · Hilfe");
    fake.emit(10); await tick(); // the release changes nothing
    expect(fake.text["header"]).toBe("PODCAPTION · Hilfe");
    fake.emit(CLICK); await tick();
    expect(fake.text["header"]).toBe("PODCAPTION · PAUSE · BEISPIEL");
    fake.menu(2); await tick(); // the handler is kept
    expect(store.get("podcaption.invert")).toBe("1");
  });

  it("swipes only move the cursor (the caption text is never changed) and honour invertScroll", async () => {
    store.set("podcaption.invert", "1");
    const fake = await boot();
    const first = fake.text["body"];
    fake.emit(UP); await tick(); // SCROLL_TOP is "down" when inverted
    expect(fake.text["body"]).not.toBe(first);
    expect(fake.text["body"]).not.toContain("Willkommen");
    fake.emit(DOWN); await tick(); // and back
    expect(fake.text["body"]).toBe(first);
  });

  it("without the setting SCROLL_BOTTOM moves down", async () => {
    const fake = await boot();
    const first = fake.text["body"];
    fake.emit(DOWN); await tick();
    expect(fake.text["body"]).not.toBe(first);
  });

  it("phone tabs run Untertitel, Brille, Verbindung, Mehr; the swipe switch is under Brille", async () => {
    await boot();
    const order = [...app.innerHTML.matchAll(/data-tab-go="(\w+)"/g)].map((m) => m[1]);
    expect(order).toEqual(["captions", "glasses", "connection", "more"]);
    expect([...app.innerHTML.matchAll(/aria-selected="\w+">([^<]+)<\/button>/g)].map((m) => m[1])).toEqual(["Untertitel", "Brille", "Verbindung", "Mehr"]);
    expect(app.innerHTML).not.toContain('id="invert"');
    listeners["tab:glasses"]?.();
    expect(app.innerHTML).toContain('id="invert"');
    listeners["tab:connection"]?.();
    expect(app.innerHTML).toContain('id="endpoint"');
    expect(app.innerHTML).not.toContain('id="invert"');
  });
});
