/**
 * QIS v1.2 (docs/BEDIENSTANDARD.md, "QIS v1.2 rulings"): what changed in Quiet Hub 0.9.0
 * apart from the Zuhause detail (tests/zuhause.test.ts).
 *  #2 2x on a recording / transcript goes back and keeps the voice note; discarding is armed.
 *  #3 the destructive menu item is armed (first click arms, second click or tap discards).
 *  #7 first start without a server = demo with the hint line.
 *  #8 no HTTP codes on the glasses.
 *  #9 phone texts use the glossary.
 */
import { describe, expect, it } from "vitest";
import {
  applyMenu, buildView, CONFIRM_MS, createModel, decide, menuFor, MENU, withSessions, withVoiceHeard, type HubModel,
} from "../src/hub/model";
import { demoReport } from "../src/api/demo";
import { buildPage } from "../src/glasses/render";
import { messages } from "../src/messages";
import { ROW_WIDTH } from "../src/glasses/screen";
import phoneSource from "../src/ui/phone.ts?raw";
import mainSource from "../src/main.ts?raw";

const T0 = 7_000_000;
const AGENT = "hermes-spark";
const report = { ...demoReport(), approvals: [] };
/** The open conversation of the first agent, its session list loaded (as after sessions -> ask). */
const ask = (): HubModel => withSessions({ ...createModel(report), screen: "agent", agentView: "ask", agentIndex: 0 }, AGENT, { status: "ready", items: [], transport: "" });
const recording = (): HubModel => decide(ask(), "longPress", T0).model;
const heard = (): HubModel => withVoiceHeard(decide(recording(), "longPressRelease", T0).model, AGENT, "Licht im Büro aus", false, T0);

describe("QIS v1.2 #2: 2× never discards a recording", () => {
  it("2× while recording ends the recording, keeps it and goes back to the sessions", () => {
    const out = decide(recording(), "doubleClick", T0 + 10);
    expect(out.effect).toEqual({ kind: "recordStop", agentId: AGENT });
    expect(out.model.recording).toBe(false);
    expect(out.model.screen).toBe("agent");
    expect(out.model.agentView).toBe("sessions");
    expect(out.model.voice).toMatchObject({ state: "transcribing", agentId: AGENT, parked: true });
    expect(buildView(out.model, "de", T0 + 20).footer).toBe("Sprachnotiz bleibt · im Gespräch senden");
  });

  it("the ring 2× behaves the same; from an alert it goes back to the overview", () => {
    expect(decide(recording(), "ringDoubleClick", T0).effect).toEqual({ kind: "recordStop", agentId: AGENT });
    const fromAlert = decide({ ...recording(), origin: "inbox" }, "doubleClick", T0).model;
    expect(fromAlert.screen).toBe("root");
    expect(fromAlert.voice?.parked).toBe(true);
  });

  it("a transcript arriving after 2× waits in its conversation and comes back there; tap sends it", () => {
    const back = decide(recording(), "doubleClick", T0).model;
    const arrived = withVoiceHeard(back, AGENT, "Licht im Büro aus", false, T0 + 500);
    expect(arrived.voice).toMatchObject({ state: "confirm", text: "Licht im Büro aus", parked: true });
    // Elsewhere the page works as usual: the sessions list, no transcript overlay.
    expect(buildView(arrived, "de", T0 + 600).body.join("\n")).not.toContain("Verstanden:");
    // Opening the conversation again shows it; tap sends.
    const reopened = decide({ ...arrived, sessionIndex: 1 }, "click", T0 + 700).model;
    expect(reopened.agentView).toBe("ask");
    expect(buildView(reopened, "de", T0 + 700).body).toContain("Verstanden:");
    const sent = decide(reopened, "click", T0 + 800);
    expect(sent.effect).toEqual({ kind: "ask", agentId: AGENT, question: "Licht im Büro aus" });
    expect(sent.model.voice).toBeNull();
  });

  it("2× on the transcript goes back and keeps it; a new hold does not overwrite it", () => {
    const back = decide(heard(), "doubleClick", T0);
    expect(back.effect).toBeUndefined();
    expect(back.model.agentView).toBe("sessions");
    expect(back.model.voice).toMatchObject({ text: "Licht im Büro aus", parked: true });
    const hold = decide(back.model, "longPress", T0 + 10);
    expect(hold.effect).toBeUndefined();
    expect(hold.model.recording).toBe(false);
    expect(hold.model.message?.text).toBe("Sprachnotiz wartet · erst senden/verwerfen");
  });
});

describe("QIS v1.2 #3: discarding the voice note is armed", () => {
  it("the menu on the transcript is Verwerfen + Hilfe", () => {
    expect(menuFor(heard(), "de", true).items.map((i) => i.id)).toEqual([MENU.discardVoice, MENU.help]);
    for (const item of menuFor(heard(), "en", true).items) expect(new TextEncoder().encode(item.label).length).toBeLessThanOrEqual(32);
  });

  it("first click arms (footer says so), a second click within 4 s discards", () => {
    const armed = applyMenu(heard(), MENU.discardVoice, T0);
    expect(armed.effect).toBeUndefined();
    expect(armed.model.voice).not.toBeNull();
    expect(buildView(armed.model, "de", T0 + 1).footer).toBe("Nochmal tippen = verwerfen · Wischen/2× = abbrechen");
    const gone = applyMenu(armed.model, MENU.discardVoice, T0 + 1000);
    expect(gone.model.voice).toBeNull();
    expect(gone.effect).toBeUndefined();
    expect(gone.model.message?.text).toBe("Verworfen");
  });

  it("armed: the next tap discards and never sends", () => {
    const armed = applyMenu(heard(), MENU.discardVoice, T0).model;
    const out = decide(armed, "click", T0 + 500);
    expect(out.effect).toBeUndefined();
    expect(out.model.voice).toBeNull();
  });

  it("swipe, 2× or the timeout disarm; then a tap sends as usual", () => {
    const armed = applyMenu(heard(), MENU.discardVoice, T0).model;
    const swiped = decide(armed, "scrollDown", T0 + 100).model;
    expect(swiped.confirm).toBeNull();
    const doubled = decide(armed, "doubleClick", T0 + 100).model;
    expect(doubled.confirm).toBeNull();
    expect(doubled.voice?.parked).toBeUndefined(); // the first 2× only disarms, it stays on the transcript
    expect(decide(armed, "click", T0 + CONFIRM_MS + 1).effect).toMatchObject({ kind: "ask" });
    // A second menu click after the timeout only arms again.
    expect(applyMenu(armed, MENU.discardVoice, T0 + CONFIRM_MS + 1).model.voice).not.toBeNull();
  });
});

describe("no side menu while its clicks do not arrive on the real glasses (step log 15.10.)", () => {
  it("the start page has no Hilfe row (QUS v1); the menu code is kept", () => {
    const body = buildView(createModel(report), "de", T0).body;
    expect(body.join("\n")).not.toMatch(/Hilfe/);
    expect(menuFor(createModel(report), "de", true).items.at(-1)?.id).toBe(MENU.help);
  });

  it("pages carry no menuObject on any screen (also with a voice note on screen)", () => {
    for (const screen of ["root", "agent", "home", "printer", "inbox", "brief"] as const) {
      const m = { ...createModel(report), screen };
      expect(menuFor(m, "de").items).toEqual([]);
      expect(buildPage(buildView(m, "de", T0), menuFor(m, "de")).menuObject).toBeUndefined();
    }
    expect(buildPage(buildView(heard(), "de", T0), menuFor(heard(), "de")).menuObject).toBeUndefined();
    // the menu key never changes, so a page change never rebuilds for a menu
    expect(new Set((["root", "agent", "home"] as const).map((screen) => menuFor({ ...createModel(report), screen }, "de").key)).size).toBe(1);
  });

  it("the help overlay (only reachable through the side menu code) is closed by any gesture", () => {
    const helped = applyMenu(createModel(report), MENU.help, T0).model;
    expect(helped.help).toBe(true);
    expect(buildView(helped, "de", T0).body.join("\n")).toContain("Bedienung");
    expect(decide(helped, "doubleClick", T0).model.help).toBe(false);
  });

  it("a hold on the transcript arms the discard, one tap discards and never sends", () => {
    const armed = decide(heard(), "longPress", T0 + 10);
    expect(armed.effect).toBeUndefined();
    expect(armed.model.voice).not.toBeNull();
    expect(buildView(heard(), "de", T0).footer).toBe("Tippen = senden · Halten = verwerfen · 2× = zurück");
    expect(buildView(armed.model, "de", T0 + 11).footer).toBe("Nochmal tippen = verwerfen · Wischen/2× = abbrechen");
    const gone = decide(armed.model, "click", T0 + 500);
    expect(gone.effect).toBeUndefined();
    expect(gone.model.voice).toBeNull();
    expect(gone.model.message?.text).toBe("Verworfen");
  });

  it("the release of the hold changes nothing; swipe, 2×, a second hold or the timeout cancel", () => {
    const armed = decide(heard(), "longPress", T0).model;
    expect(decide(armed, "longPressRelease", T0 + 50).model.confirm).not.toBeNull();
    expect(decide(armed, "scrollDown", T0 + 100).model.confirm).toBeNull();
    const doubled = decide(armed, "doubleClick", T0 + 100).model;
    expect(doubled.confirm).toBeNull();
    expect(doubled.voice?.parked).toBeUndefined();
    expect(decide(armed, "longPress", T0 + 100).model.confirm).toBeNull();
    expect(decide(armed, "click", T0 + CONFIRM_MS + 1).effect).toMatchObject({ kind: "ask" });
  });
});

describe("QIS v1.2 #7: first start = demo with the hint", () => {
  it("the overview shows the hint line, in one row, de and en", () => {
    const m: HubModel = { ...createModel(demoReport()), setupHint: true };
    const de = buildView(m, "de", T0).body;
    expect(de).toContain("  Demo · Verbindung am Handy einrichten");
    expect(buildView(m, "en", T0).body.join("\n")).toContain("Demo · set up the connection on the phone");
    for (const row of [...de, ...buildView(m, "en", T0).body]) expect(row.length).toBeLessThanOrEqual(ROW_WIDTH);
    expect(buildView({ ...m, setupHint: false }, "de", T0).body.join("\n")).not.toContain("Handy einrichten");
  });

  it("main starts the demo when no server is set (and only ?demo=1 hides the hint)", () => {
    expect(mainSource).toMatch(/let demoMode = DEMO \|\| unconfigured\(\);/);
    expect(mainSource).toMatch(/setupHint: !DEMO/);
  });
});

describe("QIS v1.2 #8 / #9: words", () => {
  it("no glasses text carries an HTTP status", () => {
    for (const locale of ["de", "en"] as const) {
      for (const [key, text] of Object.entries(messages[locale] ?? {})) {
        expect(text, key).not.toMatch(/\{status\}|HTTP|\b[45]\d\d\b/);
      }
    }
    expect(mainSource).not.toMatch(/effect\.failedHttp"[^)]*status/);
  });

  it("Zuhause hints use '=' like the footers, no colons", () => {
    for (const locale of ["de", "en"] as const) {
      for (const [key, text] of Object.entries(messages[locale] ?? {})) {
        if (key.startsWith("zh.hint") || key.startsWith("zh.hold") || key.startsWith("zh.detail") || key.startsWith("zh.choice")) {
          expect(text, key).not.toMatch(/^(Tippen|Halten|Wischen|Tap|Hold|Swipe):/);
        }
      }
    }
  });

  it("phone texts use the glossary (2×, never Doppeltippen / double tap)", () => {
    expect(phoneSource).not.toMatch(/Doppeltipp|Doppelklick|double[- ]tap|\b2x\b/i);
    expect(phoneSource).toContain("2× = Seitenwahl");
    expect(phoneSource).not.toContain("2× = verwerfen");
  });
});
