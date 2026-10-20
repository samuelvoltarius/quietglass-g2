import { describe, expect, it } from "vitest";
import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { EMPTY_STATE, applyEvent, type AgentState } from "../src/terminal/types";
import { showsCockpit } from "../src/glasses/view";
import { COCKPIT_TILES, guardedTileSend } from "../src/glasses/render";
import { routeGesture } from "../src/input/route";
import { cockpitModel, coarseElapsed, modelKey, type CockpitInput } from "../src/cockpit/model";
import { ringStyle, cellBoxes, composeCockpit, headlineLayout } from "../src/cockpit/compose";
import { frameKey } from "../src/screen/frame";
import { createTileSender } from "../src/screen/sender";
import { pixelBackend } from "../src/screen/text";
import { bannerFor, heroInner, isFirstRun, setupInner, TABS } from "../src/ui/phone";
import { DEFAULT_SETTINGS } from "../src/storage/persist";
import { greenPng } from "./green-png";

// QUS v1: the pure parts of the status cockpit - headline, cells, hint, tile diff, and when it is shown.
const NOW = new Date(2026, 9, 17, 14, 5, 12);
const backend = pixelBackend();
const session = { id: "s", title: "Improve dashboard loading state", cwd: "/w", provider: "codex", status: "running", timestamp: NOW };
const working = (patch: Partial<AgentState> = {}): AgentState => ({
  ...EMPTY_STATE, session, controllable: true, busy: true, tool: "Edit", steps: 3, startedAt: new Date(NOW.getTime() - 12_000), text: "I am updating.", ...patch,
});
const input = (patch: Partial<CockpitInput> = {}): CockpitInput => ({
  state: working(), now: NOW, locale: "de", demo: false, offline: false, armed: null, canInterrupt: true, ...patch,
});

describe("cockpit model", () => {
  it("headline: the state; cells: agent, session, time, steps, tool, access", () => {
    const model = cockpitModel(input());
    expect(model.headline).toEqual(["ARBEITET"]);
    expect(model.cells.map((cell) => cell.label)).toEqual(["AGENT", "SITZUNG", "DAUER", "SCHRITTE", "WERKZEUG", "ZUGRIFF"]);
    expect(model.cells.map((cell) => cell.value)).toEqual(["CODEX", "Improve dashboard loading state", "10 s", "3", "Edit", "STEUERN"]);
    expect(model.title).toBe("AGENT");
    expect(model.clock).toBe("14:05");
    expect(model.caption).toBe("Improve dashboard loading state");
    expect(model.mood).toBe("working");
    const en = cockpitModel(input({ locale: "en" }));
    expect(en.headline).toEqual(["WORKING"]);
    expect(en.cells.map((cell) => cell.label)).toEqual(["AGENT", "SESSION", "TIME", "STEPS", "TOOL", "ACCESS"]);
  });

  it("ready, read-only, offline and the armed interrupt say so", () => {
    const idle = cockpitModel(input({ state: working({ busy: false, tool: null, startedAt: null, steps: 0 }) }));
    expect(idle.headline).toEqual(["BEREIT"]);
    expect(idle.cells.map((cell) => cell.value).slice(2, 5)).toEqual(["–", "–", "–"]);
    expect(idle.mood).toBe("idle");
    expect(cockpitModel(input({ state: working({ controllable: false }) })).cells[5]!.value).toBe("NUR LESEN");
    const offline = cockpitModel(input({ offline: true }));
    expect(offline.headline).toEqual(["OFFLINE"]);
    expect(offline.tone).toBe("offline");
    expect(offline.mood).toBe("asleep");
    const armed = cockpitModel(input({ armed: "interrupt" }));
    expect(armed.headline).toEqual(["UNTERBRECHEN?"]);
    expect(armed.hint).toBe("Nochmal tippen = unterbrechen · Wischen/2× = abbrechen");
    expect(armed.tone).toBe("warn");
  });

  it("the steps count tools since the last instruction", () => {
    let state: AgentState = { ...EMPTY_STATE, session };
    state = applyEvent(state, { kind: "user_prompt", text: "go", raw: {} } as never);
    expect(state.steps).toBe(0);
    state = applyEvent(state, { kind: "tool_start", tool: "Read", raw: {} } as never);
    state = applyEvent(state, { kind: "tool_end", raw: {} } as never);
    state = applyEvent(state, { kind: "tool_start", tool: "Edit", raw: {} } as never);
    expect(state.steps).toBe(2);
    state = applyEvent(state, { kind: "user_prompt", text: "again", raw: {} } as never);
    expect(state.steps).toBe(0);
  });

  it("the time is coarse: 5 s steps, then whole minutes", () => {
    const since = new Date(NOW.getTime() - 12_000);
    expect(coarseElapsed(since, NOW)).toBe("10 s");
    expect(coarseElapsed(new Date(NOW.getTime() - 59_000), NOW)).toBe("55 s");
    expect(coarseElapsed(new Date(NOW.getTime() - 61_000), NOW)).toBe("1 min");
    expect(coarseElapsed(new Date(NOW.getTime() - 3_725_000), NOW)).toBe("1 h 02");
    expect(coarseElapsed(null, NOW)).toBe("");
  });

  it("the one hint line keeps the gestures in order and ends with 2× = Ende, within the row, in both languages; demo leads with its hint", () => {
    for (const locale of ["de", "en"] as const) {
      for (const canInterrupt of [true, false]) {
        const hint = cockpitModel(input({ locale, canInterrupt })).hint;
        expect(hint.length).toBeLessThanOrEqual(56);
        expect(hint.endsWith(locale === "de" ? "2× = Ende" : "2× = exit")).toBe(true);
      }
    }
    expect(cockpitModel(input({ canInterrupt: false })).hint).toBe("Tippen = hören · Halten = Liste · 2× = Ende");
    expect(cockpitModel(input({ demo: true })).hint).toBe("Demo · Verbindung am Handy einrichten · 2× = Ende");
    expect(cockpitModel(input({ demo: true })).title).toBe("AGENT · DEMO");
  });

  it("the key changes with a value; the mascot moves in 1.5 s steps", () => {
    const a = cockpitModel(input());
    expect(modelKey(cockpitModel(input()))).toBe(modelKey(a));
    expect(modelKey(cockpitModel(input({ state: working({ steps: 4 }) })))).not.toBe(modelKey(a));
    expect(modelKey(cockpitModel(input({ now: new Date(NOW.getTime() + 200) })))).toBe(modelKey(cockpitModel(input({ now: NOW }))));
  });
});

describe("when the cockpit is shown", () => {
  it("only on the open session without an error or a request; those take the display as text", () => {
    expect(showsCockpit("agent", working(), "status")).toBe(true);
    expect(showsCockpit("agent", working(), "answer")).toBe(false);
    expect(showsCockpit("agent", working({ error: "boom" }), "status")).toBe(false);
    expect(showsCockpit("agent", working({ pending: { kind: "permission", title: "Bash", detail: "ls" } }), "status")).toBe(false);
    expect(showsCockpit("agent", EMPTY_STATE, "status")).toBe(false);
    expect(showsCockpit("sessions", working(), "status")).toBe(false);
    expect(showsCockpit("help", working(), "status")).toBe(false);
  });

  const ctx = (patch: Record<string, unknown> = {}) => ({ screen: "agent" as const, state: working(), selected: 0, sessionCount: 1, decisions: true, demo: false, mode: "status" as const, ...patch });

  it("a swipe on the cockpit opens the answer text, 2× there goes back, 2× on the cockpit asks to leave", () => {
    expect(routeGesture("scrollDown", ctx())).toEqual({ kind: "mode", mode: "answer" });
    expect(routeGesture("scrollUp", ctx())).toEqual({ kind: "mode", mode: "answer" });
    expect(routeGesture("doubleClick", ctx({ mode: "answer" }))).toEqual({ kind: "mode", mode: "status" });
    expect(routeGesture("doubleClick", ctx())).toEqual({ kind: "exit" });
    // The swipe is only a view: it works in the demo too, and the 2x of an armed interrupt cancels it first.
    expect(routeGesture("scrollDown", ctx({ demo: true }))).toEqual({ kind: "mode", mode: "answer" });
    expect(routeGesture("doubleClick", ctx({ mode: "answer", armed: "interrupt" }))).toEqual({ kind: "disarm" });
    // Tap and hold behave as before (replay / arm the interrupt).
    expect(routeGesture("click", ctx())).toEqual({ kind: "replay" });
    expect(routeGesture("longPress", ctx())).toEqual({ kind: "arm", what: "interrupt" });
  });
});

describe("cockpit drawing", () => {
  const frameFor = (patch: Partial<CockpitInput> = {}) => composeCockpit(cockpitModel(input(patch)), backend);

  it("draws a repeatable frame with ink on both halves", () => {
    const frame = frameFor();
    expect(frameKey(frameFor())).toBe(frameKey(frame));
    expect(frame.pixels.some((level, index) => level > 0 && index % frame.width < 288)).toBe(true);
    expect(frame.pixels.some((level, index) => level > 0 && index % frame.width >= 288)).toBe(true);
    expect(frameKey(frameFor({ offline: true }))).not.toBe(frameKey(frame));
    expect(frameKey(frameFor({ state: working({ busy: false, tool: null }) }))).not.toBe(frameKey(frame));
  });

  it("fits a long title, a long tool name and the worst-case headline inside their boxes", () => {
    const long = "sehr_langer_titel_fuer_eine_sitzung_mit_vielen_woertern_und_noch_viel_mehr_text_dahinter";
    const model = cockpitModel(input({ state: working({ session: { ...session, title: long }, tool: "mcp__some_server__a_very_long_tool_name", steps: 99999 }) }));
    expect(headlineLayout(backend, model.headline).lines).toHaveLength(1);
    for (const box of cellBoxes(model.cells)) expect(box.x + box.width).toBeLessThanOrEqual(576);
    expect(composeCockpit(model, backend).pixels.some((level) => level > 0)).toBe(true);
  });

  it("the ring is calm when fine, dashed when it waits for you, faint when offline", () => {
    expect(ringStyle("ok").gap).toBe(0);
    expect(ringStyle("warn").gap).toBeGreaterThan(0);
    expect(ringStyle("offline").level).toBeLessThan(ringStyle("ok").level);
  });

  it("an unchanged state sends no tile again; the mascot step changes the left tile only", async () => {
    const sent: string[] = [];
    const sender = createTileSender(COCKPIT_TILES, async (slot) => { sent.push(slot.name); return true; });
    await sender.push(frameFor());
    expect(sent).toHaveLength(4);
    sent.length = 0;
    await sender.push(frameFor());
    expect(sent).toEqual([]);
    // 1.5 s later: the writing line of the mascot moved (top left); the seconds are coarse, so nothing else differs.
    await sender.push(frameFor({ now: new Date(NOW.getTime() + 1_500) }));
    expect(sent).toEqual(["agent-nw"]);
  });

  it("the guarded write sends nothing while it is not allowed (exit dialog, other page)", async () => {
    let allowed = false;
    const writes: number[] = [];
    const bridge = { updateImageRawData: async () => { writes.push(1); return "success"; } } as unknown as EvenAppBridge;
    const send = guardedTileSend(bridge, () => allowed);
    expect(await send(COCKPIT_TILES[0], new Uint8Array([1]))).toBe(false);
    expect(writes).toEqual([]);
    allowed = true;
    await send(COCKPIT_TILES[0], new Uint8Array([1]));
    expect(writes).toEqual([1]);
  });
});

describe("phone (QUS v1)", () => {
  const paired = { ...DEFAULT_SETTINGS, token: "secret" };

  it("has exactly three tabs", () => {
    expect(TABS.map((tab) => tab.id)).toEqual(["now", "sessions", "settings"]);
  });

  it("the banner says the one thing that counts", () => {
    expect(isFirstRun(DEFAULT_SETTINGS)).toBe(true);
    expect(bannerFor(DEFAULT_SETTINGS, working(), "de").text).toContain("Demo");
    expect(bannerFor(paired, EMPTY_STATE, "de").text).toContain("Keine Sitzung");
    expect(bannerFor(paired, working({ pending: { kind: "permission", title: "Bash", detail: "ls" } }), "de").tone).toBe("warn");
    expect(bannerFor(paired, working({ error: "Hermes bridge unreachable" }), "de").tone).toBe("offline");
    expect(bannerFor(paired, working(), "de")).toEqual({ tone: "ok", text: "Improve dashboard loading state" });
  });

  it("Jetzt: one big word and 2 x 2 key figures", () => {
    const html = heroInner(paired, working(), "de", NOW);
    expect(html).toContain("<strong>Arbeitet</strong>");
    expect(html).toContain("12 s");
    expect(html.match(/<div[ >][^<]*<span>/g)?.length ?? 0).toBe(5); // the hero label and the four figures
    expect(heroInner(paired, working({ busy: false, controllable: false }), "en", NOW)).toContain("<strong>Watch only</strong>");
  });

  it("first run: a checklist with three steps; once paired and a session is open it is done", () => {
    expect(setupInner(DEFAULT_SETTINGS, EMPTY_STATE, "de").match(/<li/g)).toHaveLength(3);
    expect(setupInner(DEFAULT_SETTINGS, EMPTY_STATE, "de")).toContain("Bis dahin läuft die Demo");
    expect(setupInner(paired, working(), "de").match(/class="done"/g)).toHaveLength(3);
  });
});

/**
 * Glasses previews for review (not shipped): the cockpit frame, green on black like the glasses.
 *
 *   QG_PREVIEW=1 npx vitest run tests/cockpit.test.ts
 *
 * writes store/preview-cockpit.png (the agent works) and store/preview-cockpit-warn.png (the interrupt is armed).
 * Node has no canvas, so these use the 5 x 7 pixel font; on the glasses the system font draws the text.
 */
const env = (globalThis as unknown as { process: { env: Record<string, string | undefined>; cwd(): string } }).process;
describe("cockpit previews", () => {
  it.skipIf(env.env["QG_PREVIEW"] === undefined)("writes the preview PNGs to store/", async () => {
    const fs = (await import(/* @vite-ignore */ "node:" + "fs")) as unknown as { writeFileSync(path: string, data: Uint8Array): void };
    const states: [string, CockpitInput][] = [
      ["preview-cockpit.png", input()],
      ["preview-cockpit-warn.png", input({ armed: "interrupt" })],
    ];
    for (const [file, value] of states) fs.writeFileSync(`${env.cwd()}/store/${file}`, await greenPng(composeCockpit(cockpitModel(value), backend)));
  });
});
