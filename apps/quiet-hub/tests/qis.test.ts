/** Quietglass Interaction Standard (QIS v1): safety, footers, help, scroll direction. */
import { beforeEach, describe, expect, it } from "vitest";
import { applyMenu, buildView, CONFIRM_MS, createModel, decide, menuFor, MENU, ROOT_ITEMS, type HubGesture, type HubModel, type Screen } from "../src/hub/model";
import { demoReport } from "../src/api/demo";
import type { AgentInfo, Approval, HubReport } from "../src/api/types";
import { gestureFromEvent, resetGestureDedupe } from "../src/input/gestures";
import { footer } from "../src/glasses/footer";
import { ROW_WIDTH } from "../src/glasses/screen";
import { messages } from "../src/messages";
import type { Locale } from "../src/i18n";

const T0 = 30_000_000;
const card: Approval = { id: "c1", agentId: "claude-win", tool: "Bash", title: "Bash: npm test -- --run", detail: "npm test -- --run", createdAt: "", expiresAt: T0 + 120_000 };

const model = (screen: Screen = "root", report: HubReport = demoReport()): HubModel => ({ ...createModel(report), screen });
const busyAgents = (report: HubReport): HubReport => ({ ...report, agents: report.agents.map((a: AgentInfo, i) => (i === 0 ? { ...a, busy: true } : a)) });
const busyAsk = (): HubModel => ({ ...model("agent", busyAgents(demoReport())), agentView: "ask" });
const withCard = (): HubModel => model("agent", { ...demoReport(), approvals: [card] });
const legacy = (report: HubReport): HubReport => { const { homeView: _drop, ...rest } = report; void _drop; return rest; };

const RISKY = new Set(["cancel", "approve", "ask", "printer", "toggle", "homeAction", "homeConfirm", "newSession", "readAll", "quietSetting"]);

describe("QIS safety: double tap only goes back", () => {
  const states: Array<[string, () => HubModel]> = [
    ["agent chat, agent running", busyAsk],
    ["agent chat, agent running, armed", () => decide(busyAsk(), "click", T0).model],
    ["agent chat, idle", () => ({ ...model("agent"), agentView: "ask" })],
    ["agent list", () => ({ ...model("agent"), agentView: "list" })],
    ["sessions", () => ({ ...model("agent"), agentView: "sessions" })],
    ["permission card", withCard],
    ["permission card, armed", () => decide(withCard(), "click", T0).model],
    ["printer", () => model("printer")],
    ["printer, armed cancel", () => decide({ ...model("printer"), report: { ...demoReport(), printer: { ...demoReport().printer, selected: 1 } } }, "click", T0).model],
    ["home (old daemon)", () => model("home", legacy(demoReport()))],
    ["home (view)", () => model("home")],
    ["inbox", () => model("inbox")],
    ["tagesstart", () => model("brief")],
  ];
  for (const [name, make] of states) {
    it(`${name}: 2× never produces a stop / answer / send / switch`, () => {
      const out = decide(make(), "doubleClick", T0 + 1);
      if (out.effect !== undefined) expect(RISKY.has(out.effect.kind)).toBe(false);
      expect(out.model.confirm).toBeNull();
    });
  }

  it("the agent keeps running after a 2× in the open chat", () => {
    const out = decide(busyAsk(), "doubleClick", T0);
    expect(out.model.report.agents[0]?.busy).toBe(true);
    expect(out.model.agentView).toBe("sessions");
  });
});

describe("QIS arm-and-confirm: stopping the agent", () => {
  it("a tap arms (footer says so), the second tap within 4 s stops", () => {
    const armed = decide(busyAsk(), "click", T0);
    expect(armed.effect).toBeUndefined();
    expect(buildView(armed.model, "de", T0 + 100).footer).toBe("Nochmal tippen = stoppen · Wischen/2× = abbrechen");
    expect(buildView(decide(busyAsk(), "click", T0, "en").model, "en", T0 + 100).footer).toBe("Tap again = stop · Swipe/2× = cancel");
    const stop = decide(armed.model, "click", T0 + CONFIRM_MS - 1);
    expect(stop.effect).toEqual({ kind: "cancel", agentId: "hermes-spark" });
  });

  it("swipe, 2× and the 4 s timeout cancel and restore the footer", () => {
    const armed = decide(busyAsk(), "click", T0).model;
    for (const gesture of ["scrollUp", "scrollDown", "doubleClick"] as const) {
      const out = decide(armed, gesture, T0 + 500);
      expect(out.effect?.kind).not.toBe("cancel");
      expect(out.model.confirm).toBeNull();
    }
    // after a cancel a tap starts over: it arms again, it does not stop
    const swiped = decide(armed, "scrollDown", T0 + 500).model;
    expect(decide(swiped, "click", T0 + 600).effect).toBeUndefined();
    const late = decide(armed, "click", T0 + CONFIRM_MS + 1);
    expect(late.effect).toBeUndefined();
    expect(buildView(armed, "de", T0 + CONFIRM_MS + 1).footer).toBe("Tippen = stoppen · 2× = zurück");
  });

  it("the menu entry Stoppen arms the same way", () => {
    const armed = applyMenu(busyAsk(), MENU.stop, T0);
    expect(armed.effect).toBeUndefined();
    expect(buildView(armed.model, "de", T0 + 1).footer).toContain("Nochmal tippen = stoppen");
    expect(decide(armed.model, "click", T0 + 1000).effect).toEqual({ kind: "cancel", agentId: "hermes-spark" });
  });

  it("an armed stop does nothing once the agent has finished meanwhile", () => {
    const armed = decide(busyAsk(), "click", T0).model;
    const done = { ...armed, report: { ...armed.report, agents: armed.report.agents.map((a) => ({ ...a, busy: false })) } };
    expect(decide(done, "click", T0 + 100).effect?.kind).not.toBe("cancel");
  });
});

describe("QIS arm-and-confirm: answering a permission card", () => {
  it("allow / deny / replies need a second tap on the same row; a swipe disarms", () => {
    const armed = decide(withCard(), "click", T0).model;
    expect(buildView(armed, "de", T0 + 1).footer).toBe("Nochmal tippen = Erlauben · Wischen/2× = abbrechen");
    const swiped = decide(armed, "scrollDown", T0 + 100).model;
    expect(swiped.confirm).toBeNull();
    // the next tap lands on another row (Ablehnen) and only arms it
    const second = decide(swiped, "click", T0 + 200);
    expect(second.effect).toBeUndefined();
    expect(decide(second.model, "click", T0 + 300).effect).toEqual({ kind: "approve", cardId: "c1", decision: "deny" });
  });

  it("2× leaves the card open and unanswered, the timeout disarms", () => {
    const armed = decide(withCard(), "click", T0).model;
    const back = decide(armed, "doubleClick", T0 + 100);
    expect(back.effect).toBeUndefined();
    expect(back.model.confirm).toBeNull();
    expect(decide(armed, "click", T0 + CONFIRM_MS + 1).effect).toBeUndefined();
  });
});

describe("QIS footers", () => {
  const ORDER: Record<Locale, string[]> = { de: ["Tippen", "Wischen", "Halten", "2×"], en: ["Tap", "Swipe", "Hold", "2×"] };

  const screens: Array<[string, () => HubModel, "back" | "exit"]> = [
    ["overview", () => model("root"), "exit"],
    ["agent list", () => ({ ...model("agent"), agentView: "list" }), "back"],
    ["sessions", () => ({ ...model("agent"), agentView: "sessions" }), "back"],
    ["chat idle", () => ({ ...model("agent"), agentView: "ask" }), "back"],
    ["chat running", busyAsk, "back"],
    ["chat scrolled", () => ({ ...model("agent"), agentView: "ask", chatScroll: 3 }), "back"],
    ["permission card", withCard, "back"],
    ["home", () => model("home"), "back"],
    ["home (old daemon)", () => model("home", legacy(demoReport())), "back"],
    ["printer", () => model("printer"), "back"],
    ["alerts", () => model("inbox"), "back"],
    ["tagesstart", () => model("brief"), "back"],
    ["help", () => ({ ...model("root"), help: true }), "back"],
    ["page picker", () => ({ ...model("root"), picker: 0 }), "back"],
    ["voice note", () => ({ ...model("agent"), voice: { state: "confirm", agentId: "hermes-spark", text: "Wie spät ist es" } }), "back"],
    ["link missing", () => ({ ...model("agent"), link: { problem: "missing", host: "", fails: 0, hadData: false } }), "back"],
    ["link unreachable", () => ({ ...model("agent"), link: { problem: "unreachable", host: "pi", fails: 2, hadData: true } }), "back"],
  ];

  for (const locale of ["de", "en"] as const) {
    for (const [name, make, end] of screens) {
      it(`${name} (${locale}): Tippen, Wischen, Halten, then 2× = ${end}, one row wide`, () => {
        const view = buildView(make(), locale, T0);
        expect(view.footer.length).toBeLessThanOrEqual(ROW_WIDTH);
        expect(view.footer.endsWith(`2× = ${locale === "de" ? (end === "exit" ? "Ende" : "zurück") : end}`)).toBe(true);
        const words = ORDER[locale];
        const at = view.footer.split(" · ").map((part) => words.findIndex((w) => part.startsWith(`${w} =`)));
        const used = at.filter((i) => i >= 0);
        expect(used).toEqual([...used].sort((a, b) => a - b));
        expect(view.footer).not.toMatch(locale === "de" ? /\bTap\b|\bWisch\b|\b2x\b|Doppeltipp/ : /\b2x\b/);
      });
    }
  }

  it("the header is APPNAME · state on every page", () => {
    for (const [, make] of screens) {
      expect(buildView(make(), "de", T0).header).toMatch(/^QUIET HUB( · |$)/);
      expect(buildView(make(), "en", T0).header.length).toBeLessThanOrEqual(ROW_WIDTH);
    }
  });

  it("the shared builder keeps the order and drops swipe, then hold, when the row is too wide", () => {
    expect(footer("de", { tap: "senden", swipe: "wählen", hold: "sprechen" })).toBe("Tippen = senden · Halten = sprechen · 2× = zurück");
    expect(footer("en", { tap: "send", swipe: "select", hold: "speak" })).toBe("Tap = send · Swipe = select · Hold = speak · 2× = back");
    expect(footer("de", { tap: "öffnen", swipe: "wählen" }, "exit")).toBe("Tippen = öffnen · Wischen = wählen · 2× = Ende");
  });

  it("no German string uses the retired words", () => {
    for (const [key, text] of Object.entries(messages["de"] ?? {})) {
      expect(text, key).not.toMatch(/\bTap\b|\bWisch\b|\b2x\b|Doppeltipp/);
    }
    for (const [key, text] of Object.entries(messages["en"] ?? {})) expect(text, key).not.toMatch(/\b2x\b|Doppeltipp/);
  });
});

describe("QIS help page", () => {
  it("is the last row of the overview list again while the side menu is off (step log 15.10.)", () => {
    expect(ROOT_ITEMS.at(-1)).toBe("help");
    const root = model("root");
    expect(buildView(root, "de", T0).body.join("\n")).toContain("Hilfe");
    // tapping the last row opens the help overlay
    const last = decide({ ...root, rootSelected: ROOT_ITEMS.length - 1 }, "click", T0).model;
    expect(last.help).toBe(true);
    // any gesture closes it again
    expect(decide(last, "click", T0).model.help).toBe(false);
    // the side menu code is kept and still has it when switched on
    expect(menuFor(root, "de", true).items.map((i) => i.id)).toContain(MENU.help);
    expect(applyMenu(root, MENU.help, T0).model.help).toBe(true);
  });

  it("is also in the menu of every page, and no menu has more than 6 entries", () => {
    for (const screen of ["root", "agent", "home", "printer", "inbox", "brief"] as const) {
      for (const m of [model(screen), screen === "agent" ? withCard() : model(screen), screen === "agent" ? busyAsk() : model(screen)]) {
        const menu = menuFor(m, "de", true);
        expect(menu.items.length).toBeLessThanOrEqual(6);
        expect(menu.items.some((item) => item.id === MENU.help)).toBe(true);
      }
    }
  });

  it("lists Tippen, Wischen, Halten, 2× in that order plus what the app needs, in both languages", () => {
    for (const locale of ["de", "en"] as const) {
      const rows = buildView({ ...model("root"), help: true }, locale, T0).body;
      expect(rows.length).toBeLessThanOrEqual(7);
      for (const row of rows) expect(row.length).toBeLessThanOrEqual(ROW_WIDTH);
      const words = locale === "de" ? ["Tippen", "Wischen", "Halten", "2×"] : ["Tap", "Swipe", "Hold", "2×"];
      const idx = words.map((w) => rows.findIndex((row) => row.startsWith(w)));
      expect(idx.every((i) => i > 0)).toBe(true);
      expect([...idx].sort((a, b) => a - b)).toEqual(idx);
      expect(rows.at(-1)).toMatch(locale === "de" ? /^Braucht/ : /^Needs/);
    }
  });

  it("any gesture closes it", () => {
    const helped = { ...model("root"), help: true };
    for (const g of ["click", "doubleClick", "scrollDown"] as HubGesture[]) expect(decide(helped, g, T0).model.help).toBe(false);
  });
});

describe("invertScroll is honoured for every list", () => {
  beforeEach(() => resetGestureDedupe());

  it("swaps swipe up and down in the one place all pages read gestures from", () => {
    expect(gestureFromEvent({ sysEvent: { eventType: 1 } })?.gesture).toBe("scrollUp");
    resetGestureDedupe();
    expect(gestureFromEvent({ sysEvent: { eventType: 1 } }, { invertScroll: true })?.gesture).toBe("scrollDown");
    resetGestureDedupe();
    expect(gestureFromEvent({ sysEvent: { eventType: 2 } }, { invertScroll: true })?.gesture).toBe("scrollUp");
  });

  it("every list moves only on scrollUp / scrollDown (no second, raw scroll path)", () => {
    const lists: HubModel[] = [model("root"), { ...model("agent"), agentView: "list" }, { ...model("agent"), agentView: "sessions" }, model("home"), model("printer"), model("inbox"), withCard()];
    for (const m of lists) {
      const moved = decide(m, "scrollDown", T0).model;
      const back = decide(moved, "scrollUp", T0).model;
      const key = (x: HubModel): string => JSON.stringify([x.rootSelected, x.agentIndex, x.sessionIndex, x.cardIndex ?? 0, x.report.home.selected, x.report.inbox.selected, x.report.printer.selected, x.zh?.index ?? 0]);
      expect(key(back)).toBe(key(m));
    }
  });
});
