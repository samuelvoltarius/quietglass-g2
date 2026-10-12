import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EvenAppBridge,
  utf8ByteLength,
  validateEvenHubPageContainer,
  type CreateStartUpPageContainer,
  type RebuildPageContainer,
} from "@evenrealities/even_hub_sdk";
import {
  applyMenu, buildView, createModel, decide, menuFor, MENU, mergeReport, pageCount, paginate, PAGE_ROWS,
  pickerEntries, statusLine, withVoiceFailed, withVoiceHeard, type HubModel, type Screen,
} from "../src/hub/model";
import { demoReport } from "../src/api/demo";
import type { AgentInfo, Approval, HubReport } from "../src/api/types";
import { gestureFromEvent, listIndexFromEvent, menuItemIdFromEvent, resetGestureDedupe } from "../src/input/gestures";
import { hubGesture, startScreen } from "../src/hub/entry";
import { MAX_BODY_ROWS, ROW_WIDTH } from "../src/glasses/screen";
import { buildPage, rebuildPage, renderStats, updatePage } from "../src/glasses/render";
import { pixelIconFor } from "../src/glasses/icons";

vi.mock("../src/glasses/pixel", () => ({ renderPixelIcon: async () => new Uint8Array([1, 2, 3]) }));

const T0 = 20_000_000;
const card: Approval = { id: "c1", agentId: "claude-win", tool: "Bash", title: "Bash: npm test -- --run", detail: "npm test -- --run", createdAt: "", expiresAt: T0 + 120_000 };

const model = (screen: Screen = "root", report: HubReport = demoReport()): HubModel => ({ ...createModel(report), screen });
const patchAgents = (report: HubReport, patch: (a: AgentInfo, i: number) => Partial<AgentInfo>): HubReport => ({
  ...report, agents: report.agents.map((a, i) => ({ ...a, ...patch(a, i) })),
});
const LONG = "Das ist eine lange Antwort mit vielen Wörtern, die sich über mehrere Seiten erstreckt. ".repeat(8);

describe("overview shows everything at a glance", () => {
  it("counts online agents, marks busy and waiting ones, unread alerts, lights and printer", () => {
    const report: HubReport = {
      ...patchAgents(demoReport(), (a) => (a.id === "claude-win" ? { busy: true, activity: "Edit: foo.ts" } : {})),
      approvals: [{ ...card, agentId: "hermes-spark" }],
    };
    const body = buildView(model("root", report), "de", T0).body;
    expect(body[0]).toContain("2/3 online");
    expect(body[0]).toContain("!*○"); // hermes waits, claude busy, codex offline
    expect(body[0]).toContain("1 aktiv");
    expect(body[0]).toContain("1 wartet");
    expect(body[1]).toContain("1 Licht an");
    expect(body[1]).toContain("5 Geräte");
    expect(body[2]).toContain("72 %");
    expect(body[2]).toContain("41 min");
    expect(body[3]).toContain("1 neu");
    expect(body.join("\n")).toContain("claude-win: Edit: foo.ts");
    expect(body.join("\n")).toContain("hermes-spark fragt");
  });

  it("explains in one line what is missing", () => {
    const empty: HubReport = { ...demoReport(), agents: [], home: { selected: 0, devices: [] }, inbox: { selected: 0, events: [] }, printer: { ...demoReport().printer, job: null, state: "ready" } };
    const de = buildView(model("root", empty), "de", T0).body;
    expect(de[0]).toContain("keiner verbunden");
    expect(de[1]).toContain("keine Geräte");
    expect(de.join("\n")).toContain("Relay auf dem PC starten");
    expect(buildView(model("root", empty), "en", T0).body.join("\n")).toContain("Start the relay");
    expect(buildView(model("home", empty), "de", T0).body[0]).toContain("HA_DEVICES");
    expect(buildView(model("inbox", empty), "en", T0).body.join(" ")).toContain("No alerts yet");
    const demo = { ...demoReport(), home: { ...demoReport().home, demo: true }, printer: { ...demoReport().printer, demo: true } };
    expect(buildView(model("root", demo), "de", T0).body[1]).toContain("Demo");
    expect(buildView(model("root", demo), "de", T0).body[2]).toContain("Demo");
  });

  it("agents come from the report alone — an empty list stays empty (no phantom agent)", () => {
    const merged = mergeReport(model(), { ...demoReport(), agents: [] });
    expect(merged.report.agents).toEqual([]);
  });
});

describe("fixed status line", () => {
  it("shows page, connection, unread and busy agents on every page, within the width", () => {
    const report = patchAgents(demoReport(), (a) => (a.id === "claude-win" ? { busy: true } : {}));
    for (const locale of ["de", "en"] as const) {
      for (const screen of ["root", "agent", "home", "printer", "inbox"] as const) {
        const line = statusLine(model(screen, report), locale);
        expect(line.length).toBeLessThanOrEqual(ROW_WIDTH);
        expect(line).toMatch(/1 (neu|new)/);
        expect(line).toMatch(/1 (aktiv|busy)/);
        expect(line).not.toContain("…");
      }
    }
    expect(statusLine(model("printer", report), "de")).toBe("Drucker · Demo · 1 neu · 1 aktiv");
  });

  it("is the header and counts pending approvals", () => {
    const withCard = { ...demoReport(), approvals: [card] };
    expect(buildView(model("agent", withCard), "en", T0).header).toContain("1 waiting");
  });
});

describe("native contextual menu", () => {
  const screens: Screen[] = ["root", "agent", "home", "printer", "inbox"];
  it("respects the SDK limits for every page, with and without a card", () => {
    for (const locale of ["de", "en"] as const) {
      for (const screen of screens) {
        for (const report of [demoReport(), { ...demoReport(), approvals: [card] }]) {
          const spec = menuFor(model(screen, report), locale);
          expect(spec.items.length).toBeGreaterThan(0);
          expect(spec.items.length).toBeLessThanOrEqual(6);
          const ids = spec.items.map((item) => item.id);
          expect(new Set(ids).size).toBe(ids.length);
          for (const item of spec.items) {
            expect(item.id).toBeGreaterThan(0);
            expect(utf8ByteLength(item.label)).toBeLessThanOrEqual(32);
            expect(item.label).not.toMatch(/\?$/); // verbs, not questions
          }
        }
      }
    }
  });

  it("offers the page's actions: agent stop / new session / switch, alerts mark-all, card allow / deny", () => {
    const labels = (screen: Screen, report?: HubReport) => menuFor(model(screen, report), "de").items.map((item) => item.label);
    expect(labels("agent")).toEqual(expect.arrayContaining(["Stoppen", "Neue Sitzung", "Agent wechseln"]));
    expect(labels("inbox")).toContain("Alle gelesen");
    expect(labels("agent", { ...demoReport(), approvals: [card] })).toEqual(["Erlauben", "Ablehnen", "Hilfe"]);
    expect(labels("printer")).toContain("Druck abbrechen");
  });

  it("changes its key (= one rebuild) only when the page or card state changes", () => {
    const a = menuFor(model("agent"), "de").key;
    expect(menuFor({ ...model("agent"), agentView: "ask", questionIndex: 2 }, "de").key).toBe(a);
    expect(menuFor(model("home"), "de").key).not.toBe(a);
    expect(menuFor(model("agent", { ...demoReport(), approvals: [card] }), "de").key).not.toBe(a);
  });

  it("Stoppen stops a running agent, otherwise says nothing runs", () => {
    const busy = model("agent", patchAgents(demoReport(), (_a, i) => (i === 0 ? { busy: true } : {})));
    const out = applyMenu(busy, MENU.stop, T0);
    expect(out.effect).toEqual({ kind: "cancel", agentId: "hermes-spark" });
    expect(applyMenu(model("agent"), MENU.stop, T0).model.message?.text).toBe("Es läuft nichts");
  });

  it("Neue Sitzung starts one for the selected agent; Agent wechseln returns to the list", () => {
    const ask = { ...model("agent"), agentView: "ask" as const };
    const out = applyMenu(ask, MENU.newSession, T0);
    expect(out.effect).toEqual({ kind: "newSession", agentId: "hermes-spark" });
    expect(out.model.agentView).toBe("ask");
    expect(applyMenu(ask, MENU.switchAgent, T0).model.agentView).toBe("list");
    const single = model("agent", { ...demoReport(), agents: demoReport().agents.slice(0, 1) });
    expect(applyMenu(single, MENU.switchAgent, T0).model.message?.text).toBe("Nur ein Agent verbunden");
  });

  it("Erlauben / Ablehnen answer the card; Alle gelesen marks every unread alert", () => {
    const withCard = model("agent", { ...demoReport(), approvals: [card] });
    expect(applyMenu(withCard, MENU.allow, T0).effect).toEqual({ kind: "approve", cardId: "c1", decision: "allow" });
    expect(applyMenu(withCard, MENU.deny, T0).effect).toEqual({ kind: "approve", cardId: "c1", decision: "deny" });
    expect(applyMenu(model("inbox"), MENU.markAll, T0).effect).toEqual({ kind: "readAll", ids: ["demo-codex-1"] });
  });

  it("risky page actions from the menu still need the confirming tap", () => {
    const armed = applyMenu(model("printer"), MENU.cancelPrint, T0);
    expect(armed.effect).toBeUndefined();
    expect(armed.model.confirm?.what).toBe("printer:cancel");
    expect(decide(armed.model, "click", T0 + 100).effect).toEqual({ kind: "printer", action: "cancel" });
    const pause = applyMenu(model("printer"), MENU.pauseResume, T0);
    expect(pause.model.confirm?.what).toBe("printer:pause");
    const toggle = applyMenu(model("home"), MENU.toggle, T0);
    expect(toggle.effect).toBeUndefined();
    expect(toggle.model.confirm?.what).toBe("light_office");
  });

  it("navigation entries open the page and the help item shows the controls", () => {
    expect(applyMenu(model("root"), MENU.home, T0).model.screen).toBe("home");
    expect(applyMenu(model("home"), MENU.overview, T0).model.screen).toBe("root");
    const help = applyMenu(model("home"), MENU.help, T0).model;
    expect(buildView(help, "de", T0).body.join("\n")).toContain("Wischen");
    expect(decide(help, "scrollDown", T0).model.help).toBe(false);
  });

  it("is ignored while a voice note is in progress", () => {
    const rec = decide({ ...model("agent"), agentView: "ask" }, "longPress", T0).model;
    expect(applyMenu(rec, MENU.stop, T0).model.recording).toBe(true);
    expect(applyMenu(rec, MENU.stop, T0).effect).toBeUndefined();
  });

  it("the SDK accepts the page with the menu and a rebuild re-supplies it", () => {
    const view = buildView(model("agent"), "de", T0);
    const spec = menuFor(model("agent"), "de");
    const page = buildPage(view, spec);
    expect(page.menuObject?.menuItems?.map((item) => item.itemName)).toEqual(spec.items.map((item) => item.label));
    expect(validateEvenHubPageContainer(page).valid).toBe(true);
  });
});

describe("session picker", () => {
  it("lists agents with online / busy / offline dots and 'Neue Sitzung' first on the next page", () => {
    const report = patchAgents(demoReport(), (a) => (a.id === "claude-win" ? { busy: true } : {}));
    const list = buildView({ ...model("agent", report), agentView: "list" }, "de", T0).body;
    expect(list[0]).toMatch(/^> ● hermes-spark/);
    expect(list[1]).toMatch(/^ {2}\* claude-win · läuft/);
    expect(list[2]).toMatch(/^ {2}○ codex-win · offline/);
    const opened = decide({ ...model("agent"), agentView: "list" }, "click", T0).model;
    expect(buildView(opened, "de", T0).body[1]).toContain("+ Neue Sitzung");
  });
});

describe("voice with confirmation", () => {
  const ask = (): HubModel => ({ ...model("agent"), agentView: "ask" });

  it("hold -> recording line -> release -> transcribing -> 'Verstanden' -> tap sends", () => {
    const rec = decide(ask(), "longPress", T0);
    expect(rec.effect).toEqual({ kind: "recordStart" });
    expect(buildView(rec.model, "de", T0).body.join(" ")).toContain("Aufnahme");
    const stop = decide(rec.model, "longPressRelease", T0 + 2000);
    expect(stop.effect).toEqual({ kind: "recordStop", agentId: "hermes-spark" });
    expect(stop.model.voice).toEqual({ state: "transcribing", agentId: "hermes-spark" });
    expect(buildView(stop.model, "de", T0).footer).toContain("Verarbeite");
    const heard = withVoiceHeard(stop.model, "hermes-spark", "Wie spät ist es", false, T0 + 3000);
    const view = buildView(heard, "de", T0 + 3000);
    expect(view.body[1]).toBe("Verstanden:");
    expect(view.body[2]).toBe("Wie spät ist es");
    expect(view.footer).toBe("Tippen = senden · 2× = verwerfen");
    const sent = decide(heard, "click", T0 + 4000);
    expect(sent.effect).toEqual({ kind: "ask", agentId: "hermes-spark", question: "Wie spät ist es" });
    expect(sent.model.voice).toBeNull();
    expect(sent.model.report.agents[0]?.busy).toBe(true);
  });

  it("double tap discards the transcript without asking", () => {
    const heard = withVoiceHeard(decide(decide(ask(), "longPress", T0).model, "longPressRelease", T0).model, "hermes-spark", "Test", false, T0);
    const out = decide(heard, "doubleClick", T0);
    expect(out.effect).toBeUndefined();
    expect(out.model.voice).toBeNull();
    expect(out.model.message?.text).toBe("Verworfen");
  });

  it("swipes and long presses cannot leave the confirmation; tapping while transcribing does nothing", () => {
    const stop = decide(decide(ask(), "longPress", T0).model, "longPressRelease", T0).model;
    expect(decide(stop, "click", T0).effect).toBeUndefined();
    const heard = withVoiceHeard(stop, "hermes-spark", "Test", false, T0);
    expect(decide(heard, "scrollDown", T0).model.voice).toEqual(heard.voice);
    expect(decide(heard, "longPress", T0).model.recording).toBe(false);
  });

  it("auto-send (setting on) just reports what was sent; a discarded note is not resurrected", () => {
    const stop = decide(decide(ask(), "longPress", T0).model, "longPressRelease", T0).model;
    const sent = withVoiceHeard(stop, "hermes-spark", "Test", true, T0);
    expect(sent.voice).toBeNull();
    expect(sent.message?.text).toBe("Gesendet: Test");
    const discarded = decide(stop, "doubleClick", T0).model;
    expect(withVoiceHeard(discarded, "hermes-spark", "Test", false, T0).voice).toBeNull();
  });

  it("a failed transcription clears the state with its own words", () => {
    const stop = decide(decide(ask(), "longPress", T0).model, "longPressRelease", T0).model;
    const failed = withVoiceFailed(stop, "Nichts verstanden", T0);
    expect(failed.voice).toBeNull();
    expect(buildView(failed, "de", T0).footer).toBe("Nichts verstanden");
  });

  it("the confirmation never sends to an agent that went offline or is busy", () => {
    const heard = withVoiceHeard(decide(decide(ask(), "longPress", T0).model, "longPressRelease", T0).model, "hermes-spark", "Test", false, T0);
    const busy = { ...heard, report: patchAgents(heard.report, (_a, i) => (i === 0 ? { busy: true } : {})) };
    expect(decide(busy, "click", T0).effect).toBeUndefined();
    const offline = { ...heard, report: patchAgents(heard.report, (_a, i) => (i === 0 ? { online: false } : {})) };
    expect(decide(offline, "click", T0).effect).toBeUndefined();
  });
});

describe("visible feedback and help", () => {
  it("acknowledges asking, allowing, denying, stopping and session choices in the footer", () => {
    const ask = { ...model("agent"), agentView: "ask" as const };
    expect(buildView(decide(ask, "click", T0).model, "de", T0 + 1).footer).toMatch(/^Gesendet: /);
    const withCard = model("agent", { ...demoReport(), approvals: [card] });
    expect(buildView(decide(withCard, "click", T0).model, "de", T0 + 1).footer).toBe("Erlaubt");
    expect(buildView(decide(withCard, "doubleClick", T0, "en").model, "en", T0 + 1).footer).toBe("Denied");
    const running = { ...ask, report: patchAgents(ask.report, (_a, i) => (i === 0 ? { busy: true } : {})) };
    expect(buildView(decide(running, "doubleClick", T0).model, "de", T0 + 1).footer).toContain("gestoppt");
    expect(decide({ ...model("inbox"), report: { ...demoReport(), inbox: { selected: 0, events: [] } } }, "click", T0).model.message?.text).toBe("Nichts ausgewählt");
    expect(decide(model("home", { ...demoReport(), home: { selected: 0, devices: [] } }), "click", T0).model.message?.text).toBe("Kein schaltbares Gerät");
  });

  it("every page keeps a short gesture hint in the footer (no feedback pending)", () => {
    for (const screen of ["root", "agent", "home", "printer", "inbox"] as const) {
      for (const locale of ["de", "en"] as const) {
        const footer = buildView(model(screen), locale, T0).footer;
        expect(footer.length).toBeGreaterThan(8);
        expect(footer).not.toContain("…");
      }
    }
  });

  it("feedback expires back to the hint", () => {
    const out = decide({ ...model("agent"), agentView: "ask" }, "click", T0).model;
    expect(buildView(out, "de", T0 + 6000).footer).not.toMatch(/^Gesendet/);
  });
});

describe("R1 ring", () => {
  it("maps source 2 double tap to the page picker, glasses double tap stays back/exit", () => {
    expect(hubGesture("doubleClick", "ring")).toBe("ringDoubleClick");
    expect(hubGesture("doubleClick", "glassesRight")).toBe("doubleClick");
    expect(hubGesture("scrollDown", "ring")).toBe("scrollDown");
    expect(hubGesture("click", "ring")).toBe("click");
    resetGestureDedupe();
    expect(gestureFromEvent({ sysEvent: { eventType: 3, eventSource: 2 } })).toEqual({ gesture: "doubleClick", source: "ring" });
  });

  it("ring double tap opens a picker (never the exit dialog); swipe selects, tap opens, double tap closes", () => {
    const root = model("root");
    const open = decide(root, "ringDoubleClick", T0);
    expect(open.effect).toBeUndefined();
    expect(open.model.picker).toBe(0);
    expect(buildView(open.model, "de", T0).body[0]).toBe("Seite wählen");
    const next = decide(decide(open.model, "scrollDown", T0).model, "scrollDown", T0).model;
    expect(next.picker).toBe(2);
    const chosen = decide(next, "click", T0);
    expect(chosen.model.screen).toBe("home");
    expect(chosen.model.picker).toBeNull();
    expect(chosen.model.message?.text).toBe("Zuhause geöffnet");
    expect(decide(open.model, "ringDoubleClick", T0).model.picker).toBeNull();
    expect(decide(open.model, "doubleClick", T0).effect).toBeUndefined();
  });

  it("the picker starts on the current page and lists waiting cards first", () => {
    const withCard = model("printer", { ...demoReport(), approvals: [card] });
    const open = decide(withCard, "ringDoubleClick", T0).model;
    const entries = pickerEntries(open, "de");
    expect(entries[0]?.label).toContain("Freigabe");
    expect(entries[open.picker ?? -1]?.screen).toBe("printer");
  });

  it("opening the picker leaves a permission card reachable afterwards", () => {
    const withCard = model("agent", { ...demoReport(), approvals: [card] });
    const open = decide(withCard, "ringDoubleClick", T0).model;
    const home = decide(decide(open, "scrollDown", T0).model, "click", T0);
    expect(home.effect).toBeUndefined();
  });
});

describe("robust input", () => {
  beforeEach(() => resetGestureDedupe());
  afterEach(() => vi.useRealTimers());

  it("a missing eventType means CLICK", () => {
    expect(gestureFromEvent({ sysEvent: { eventSource: 1 } })?.gesture).toBe("click");
    expect(gestureFromEvent({ textEvent: {} })?.gesture).toBe("click");
  });

  it("a missing currentSelectItemIndex means 0", () => {
    expect(listIndexFromEvent({ listEvent: { containerID: 1 } })).toBe(0);
    expect(listIndexFromEvent({ listEvent: { currentSelectItemIndex: 3 } })).toBe(3);
    expect(listIndexFromEvent({})).toBe(0);
  });

  it("reads the native menu event; itemID 0 is not an item", () => {
    expect(menuItemIdFromEvent({ menuItemClickEvent: { itemID: 11 } })).toBe(11);
    expect(menuItemIdFromEvent({ menuItemClickEvent: {} })).toBeNull();
    expect(menuItemIdFromEvent({ sysEvent: { eventType: 0 } })).toBeNull();
    expect(gestureFromEvent({ menuItemClickEvent: { itemID: 11 } })).toBeNull();
  });

  it("a scroll cooldown of about 300 ms swallows the burst of one swipe", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    expect(gestureFromEvent({ sysEvent: { eventType: 2 } })?.gesture).toBe("scrollDown");
    vi.setSystemTime(1_000_150);
    expect(gestureFromEvent({ sysEvent: { eventType: 2 } })).toBeNull();
    vi.setSystemTime(1_000_320);
    expect(gestureFromEvent({ sysEvent: { eventType: 2 } })?.gesture).toBe("scrollDown");
  });

  it("selected indices live in the model and survive a report refresh", () => {
    let m = model("agent");
    m = { ...m, agentView: "list" };
    m = decide(m, "scrollDown", T0).model;
    const refreshed = mergeReport(m, demoReport());
    expect(refreshed.agentIndex).toBe(1);
  });
});

describe("pagination of long answers", () => {
  const longReport = (): HubReport => patchAgents(demoReport(), (_a, i) => (i === 0 ? { answer: LONG, suggestions: [] } : {}));
  const ask = (): HubModel => ({ ...model("agent", longReport()), agentView: "ask" });

  it("splits into pages of PAGE_ROWS rows, none wider than a row", () => {
    const pages = paginate(LONG);
    expect(pages.length).toBeGreaterThan(2);
    for (const page of pages) {
      expect(page.length).toBeLessThanOrEqual(PAGE_ROWS);
      for (const row of page) expect(row.length).toBeLessThanOrEqual(ROW_WIDTH);
    }
    expect(pages.flat().join(" ").replace(/\s+/g, " ")).toContain("Das ist eine lange Antwort");
  });

  it("swipe turns the page, the last page is the question list, tap on text goes to the questions", () => {
    let m = ask();
    const agent = m.report.agents[0]!;
    const pages = pageCount(agent);
    expect(pages).toBeGreaterThan(2);
    const first = buildView(m, "de", T0);
    expect(first.body.length).toBeLessThanOrEqual(MAX_BODY_ROWS);
    expect(first.body[first.body.length - 1]).toContain(`1/${pages + 1}`);
    expect(first.footer).toContain("Wischen: Seite");
    m = decide(m, "scrollDown", T0).model;
    expect(m.answerPage).toBe(1);
    expect(buildView(m, "de", T0).body.at(-1)).toContain(`2/${pages + 1}`);
    m = decide(m, "scrollUp", T0).model;
    m = decide(m, "click", T0).model; // from text page -> questions page
    expect(m.answerPage).toBe(pages);
    const last = buildView(m, "de", T0 + 6000);
    expect(last.body.at(-1)).toContain(`${pages + 1}/${pages + 1}`);
    expect(last.body.some((row) => row.startsWith("> "))).toBe(true);
    expect(last.footer).toContain("fragen");
    // the question page asks
    expect(decide(m, "click", T0).effect?.kind).toBe("ask");
  });

  it("wraps from the last page to the first and resets for a new answer", () => {
    let m = ask();
    const pages = pageCount(m.report.agents[0]!);
    m = { ...m, answerPage: pages };
    expect(decide(m, "scrollDown", T0).model.answerPage).toBe(0);
    const next = mergeReport({ ...m, answerPage: 2 }, patchAgents(m.report, (_a, i) => (i === 0 ? { lastQuestion: "neu", answer: LONG } : {})));
    expect(next.answerPage).toBe(0);
    const streaming = mergeReport({ ...m, answerPage: 2 }, patchAgents(m.report, (_a, i) => (i === 0 ? { busy: true } : {})));
    expect(streaming.answerPage).toBe(0);
  });

  it("short answers stay inline next to the questions (no paging)", () => {
    expect(pageCount(demoReport().agents[0]!)).toBe(0);
  });
});

describe("tool lines and permission cards", () => {
  it("shows the running tool as one line while the agent works", () => {
    const report = patchAgents(demoReport(), (_a, i) => (i === 0 ? { busy: true, activity: "Bash: npm test", answer: null, lastQuestion: "Teste" } : {}));
    const rows = buildView({ ...model("agent", report), agentView: "ask" }, "de", T0).body;
    expect(rows).toContain("» Bash: npm test");
    const thinking = patchAgents(report, (_a, i) => (i === 0 ? { activity: "" } : {}));
    expect(buildView({ ...model("agent", thinking), agentView: "ask" }, "de", T0).body).toContain("» denkt nach …");
  });

  it("a card shows who asks, the tool, the command and the choice", () => {
    const withCard = model("agent", { ...demoReport(), approvals: [{ ...card, suggestions: ["Ja", "Nein"] }] });
    const view = buildView(withCard, "de", T0);
    expect(view.body[0]).toBe("! Freigabe · claude-win");
    expect(view.body[1]).toBe("Tool: Bash");
    expect(view.body[2]).toBe("npm test -- --run");
    expect(view.footer).toBe("Tippen = erlauben · 2× = ablehnen");
    expect(buildView(withCard, "en", T0).footer).toBe("Tap = allow · 2× = deny");
  });

  it("older daemons (no tool field) still split tool and command from the title", () => {
    const old: Approval = { id: "c2", agentId: "x", title: "Edit: src/app.ts", detail: null, createdAt: "", expiresAt: 0 };
    const view = buildView(model("agent", { ...demoReport(), approvals: [old] }), "de", T0);
    expect(view.body[1]).toBe("Tool: Edit");
    expect(view.body[2]).toBe("src/app.ts");
  });
});

describe("fast entry", () => {
  it("glassesMenu opens the Overview directly, the app menu resumes the saved page", () => {
    expect(startScreen("glassesMenu", "printer")).toBe("root");
    expect(startScreen("appMenu", "printer")).toBe("printer");
    expect(startScreen(null, null)).toBe("root");
    expect(startScreen(null, "bogus" as Screen)).toBe("root");
  });
});

describe("page building and rebuilds", () => {
  function fakeBridge() {
    const calls: string[] = [];
    let rebuilt: RebuildPageContainer | null = null;
    const bridge = {
      textContainerUpgrade: async (c: { containerName?: string }) => { calls.push(`text:${c.containerName}`); return true; },
      updateImageRawData: async () => { calls.push("image"); return "success"; },
      rebuildPageContainer: async (c: RebuildPageContainer) => { calls.push("rebuild"); rebuilt = c; return true; },
    } as unknown as EvenAppBridge;
    return { bridge, calls, rebuilt: () => rebuilt };
  }

  it("stays inside the container limits: <= 4 images, <= 8 text, exactly one event capture", () => {
    const page: CreateStartUpPageContainer = buildPage(buildView(model(), "de", T0), menuFor(model(), "de"));
    expect((page.imageObject ?? []).length).toBeLessThanOrEqual(4);
    expect((page.textObject ?? []).length).toBeLessThanOrEqual(8);
    expect((page.textObject ?? []).filter((c) => c.isEventCapture === 1).length).toBe(1);
    expect(page.containerTotalNum).toBe(4);
    expect(validateEvenHubPageContainer(page).valid).toBe(true);
  });

  it("changing text only upgrades the containers that changed and never rebuilds", async () => {
    const { bridge, calls } = fakeBridge();
    const a = buildView(model("root"), "de", T0);
    const b = { ...a, footer: "anderer Fußtext" };
    const icon = pixelIconFor(model("root"));
    await updatePage(bridge, a, icon, null);
    calls.length = 0;
    await updatePage(bridge, b, icon, a);
    expect(calls).toEqual(["text:footer"]);
    calls.length = 0;
    await updatePage(bridge, b, icon, b);
    expect(calls).toEqual([]);
  });

  it("a menu change is the one rebuild and carries the menuObject again", async () => {
    const { bridge, calls, rebuilt } = fakeBridge();
    const before = renderStats.rebuilds;
    const spec = menuFor(model("home"), "de");
    const result = await rebuildPage(bridge, buildView(model("home"), "de", T0), pixelIconFor(model("home")), spec);
    expect(result.ok).toBe(true);
    expect(renderStats.rebuilds).toBe(before + 1);
    expect(calls[0]).toBe("rebuild");
    expect(rebuilt()?.menuObject?.menuItems?.length).toBe(spec.items.length);
    expect(rebuilt()?.menuObject?.menuItems?.[0]?.itemID).toBe(MENU.toggle);
  });
});

describe("every view fits", () => {
  it("rows, header and footer stay inside the display in all pages, scenes and languages", () => {
    const scenes: HubReport[] = [
      demoReport(),
      { ...demoReport(), approvals: [{ ...card, title: "Bash: " + "x".repeat(200), detail: "y".repeat(300), suggestions: ["Ja, einmal", "Nein", "Immer"] }] },
      patchAgents(demoReport(), (_a, i) => (i === 0 ? { answer: LONG, busy: false } : { busy: true, activity: "Edit: " + "z".repeat(90) })),
    ];
    for (const report of scenes) {
      for (const locale of ["de", "en"] as const) {
        for (const screen of ["root", "agent", "home", "printer", "inbox"] as const) {
          for (const agentView of ["list", "sessions", "ask"] as const) {
            const view = buildView({ ...model(screen, report), agentView }, locale, T0);
            expect(view.body.length).toBeLessThanOrEqual(MAX_BODY_ROWS);
            expect(view.header.length).toBeLessThanOrEqual(ROW_WIDTH);
            expect(view.footer.length).toBeLessThanOrEqual(ROW_WIDTH);
            for (const row of view.body) expect(row.length).toBeLessThanOrEqual(ROW_WIDTH);
          }
        }
      }
    }
  });
});
