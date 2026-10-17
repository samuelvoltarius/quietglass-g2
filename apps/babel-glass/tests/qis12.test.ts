import { describe, expect, it } from "vitest";
import { CONFIRM_WINDOW_MS } from "../src/input/confirm";
import { menuArmedKind, menuClickStep } from "../src/input/menu-confirm";
import { menuArmedFooter, ROW_WIDTH } from "../src/glasses/footer";
import { buildView, type ViewOptions } from "../src/glasses/view";
import { createBuffer } from "../src/captions/buffer";
import { messages, t } from "../src/messages";

const chars = (text: string): number => Array.from(text).length;

describe("QIS v1.2 #3: armed side-menu items", () => {
  it("an item without arming runs at once", () => {
    expect(menuClickStep(null, 1, null, 0)).toEqual({ run: true, pending: null });
  });

  it("the first click arms, the same item within 4 s runs it", () => {
    const first = menuClickStep(null, 7, "voiceDelete", 1000);
    expect(first.run).toBe(false);
    expect(menuArmedKind(first.pending, 1000)).toBe("voiceDelete");
    const second = menuClickStep(first.pending, 7, "voiceDelete", 1000 + CONFIRM_WINDOW_MS);
    expect(second).toEqual({ run: true, pending: null });
  });

  it("too late, or a different item, only arms again", () => {
    const first = menuClickStep(null, 7, "voiceDelete", 0);
    expect(menuArmedKind(first.pending, CONFIRM_WINDOW_MS + 1)).toBeNull();
    expect(menuClickStep(first.pending, 7, "voiceDelete", CONFIRM_WINDOW_MS + 1).run).toBe(false);
    const other = menuClickStep(first.pending, 8, "restart", 10);
    expect(other.run).toBe(false);
    expect(menuArmedKind(other.pending, 10)).toBe("restart");
  });

  it("the armed footer says what the second click does and fits one row", () => {
    expect(menuArmedFooter("de", t("de", "g.a.voiceDelete"))).toBe("Nochmal = löschen · Wischen/2× = abbrechen");
    expect(menuArmedFooter("de", t("de", "g.a.restart"))).toMatch(/^Nochmal = Neustart der Mitschrift/);
    for (const locale of ["de", "en"] as const) {
      for (const key of ["g.a.voiceDelete", "g.a.restart"]) expect(chars(menuArmedFooter(locale, t(locale, key)))).toBeLessThanOrEqual(ROW_WIDTH);
    }
    expect(chars(menuArmedFooter("de", "x".repeat(80)))).toBeLessThanOrEqual(ROW_WIDTH);
  });

  it("the view shows the armed menu footer on any screen", () => {
    const base: ViewOptions = { mode: "conversation", listening: true, status: "ready", translating: false, offset: 0, mock: false, locale: "de" };
    // Without the side menu (SIDE_MENU off) the confirming step is a tap on the same row: "Nochmal tippen".
    expect(buildView(createBuffer(), { ...base, menuArmed: "restart" }).footer).toMatch(/^Nochmal tippen = Neustart/);
    expect(buildView(createBuffer(), { ...base, listening: false, menuArmed: "voiceDelete" }).footer).toMatch(/^Nochmal tippen = löschen/);
    expect(buildView(createBuffer(), base).footer).not.toMatch(/^Nochmal/);
  });
});

describe("QIS v1.2 #2 / stale texts", () => {
  it("1.0.0: nothing on the glasses or the phone promises a hold, or help on the glasses", () => {
    for (const locale of ["de", "en"] as const) {
      for (const [key, text] of Object.entries(messages[locale])) {
        if (key.startsWith("g.f.") || key.startsWith("g.start.") || key.startsWith("g.run.")) expect(text, key).not.toMatch(/Halten|Hold/);
      }
    }
  });

  it("no glasses or phone text offers help on a swipe or on a plain hold", () => {
    for (const locale of ["de", "en"] as const) {
      for (const [key, text] of Object.entries(messages[locale])) {
        expect(text, key).not.toMatch(/Wischen = Hilfe|Swipe = help|runter = Hilfe|down = help/);
      }
    }
  });
});
