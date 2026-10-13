import { describe, expect, it } from "vitest";
import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { demoReport } from "../src/api/demo";
import type { Approval, HubReport } from "../src/api/types";
import { applyMenu, buildView, createModel, decide, menuFor, MENU, mergeReport, type HubModel } from "../src/hub/model";
import { BLANK_ICON, isQuiet, QUIET_VIEW, quietGesture, wake, WAKE_MS } from "../src/hub/quiet";
import { renderStats, updatePage } from "../src/glasses/render";
import { pixelIconFor } from "../src/glasses/icons";
import { normalizeSettings, DEFAULT_SETTINGS } from "../src/setup/settings";
import type { ScreenView } from "../src/glasses/screen";

const T0 = 1_700_000_000_000;

function withBusy(report: HubReport, busy: boolean): HubReport {
  return { ...report, agents: report.agents.map((agent, i) => (i === 0 ? { ...agent, busy, answer: busy ? null : "Fertig: alles erledigt.", activity: busy ? "Bash: npm test" : "", busySince: busy ? T0 - 5000 : null } : { ...agent, busy: false })) };
}

/** The open session of agent 0, quiet mode switched on. */
function session(busy: boolean, quiet = true): HubModel {
  return { ...createModel(withBusy(demoReport(), busy)), screen: "agent", agentView: "ask", agentIndex: 0, quietWhileWorking: quiet };
}

const card: Approval = { id: "c1", agentId: "", title: "Bash: rm -rf build", detail: "", createdAt: "" } as unknown as Approval;

describe("quiet while the agent works (0.6.6)", () => {
  it("working -> quiet -> done -> normal again", () => {
    const working = session(true);
    expect(isQuiet(working, T0)).toBe(true);
    const done = mergeReport(working, withBusy(working.report, false));
    expect(isQuiet(done, T0)).toBe(false);
    expect(buildView(done, "de", T0).body.join(" ")).toContain("Fertig");
  });

  it("is off unless switched on, and the setting defaults to off", () => {
    expect(isQuiet(session(true, false), T0)).toBe(false);
    expect(DEFAULT_SETTINGS.quietWhileWorking).toBe(false);
    expect(normalizeSettings({}).quietWhileWorking).toBe(false);
    expect(normalizeSettings({ quietWhileWorking: true }).quietWhileWorking).toBe(true);
  });

  it("only for the agent on display: overview with a busy agent yes, other pages no", () => {
    const working = session(true);
    expect(isQuiet({ ...working, screen: "root" }, T0)).toBe(true);
    expect(isQuiet({ ...working, screen: "inbox" }, T0)).toBe(false);
    expect(isQuiet({ ...working, agentView: "sessions" }, T0)).toBe(false);
    // Another agent works, the one on display is idle.
    expect(isQuiet({ ...working, agentIndex: 1 }, T0)).toBe(false);
  });

  it("a tap or swipe wakes the display for ~20 s and does nothing else; then quiet again", () => {
    const working = session(true);
    for (const gesture of ["click", "scrollUp", "scrollDown"] as const) {
      const woke = quietGesture(working, gesture, T0);
      expect(woke.consumed).toBe(true);
      expect(woke.model.wakeUntil).toBe(T0 + WAKE_MS);
      expect(woke.model.screen).toBe("agent");
      expect(isQuiet(woke.model, T0 + 1000)).toBe(false);
      // Awake: the progress (tool step) is visible.
      expect(buildView(woke.model, "de", T0 + 1000).header).not.toBe("");
      expect(isQuiet(woke.model, T0 + WAKE_MS + 1)).toBe(true);
    }
  });

  it("while awake gestures work normally and keep it awake", () => {
    const awake = wake(session(true), T0);
    const next = quietGesture(awake, "scrollUp", T0 + 10_000);
    expect(next.consumed).toBe(false);
    expect(next.model.wakeUntil).toBe(T0 + 10_000 + WAKE_MS);
  });

  it("double tap keeps its meaning while quiet: it stops the running agent", () => {
    const working = session(true);
    const q = quietGesture(working, "doubleClick", T0);
    expect(q.consumed).toBe(false);
    const out = decide(q.model, "doubleClick", T0);
    expect(out.effect).toEqual({ kind: "cancel", agentId: working.report.agents[0]!.id });
    expect(isQuiet(out.model, T0)).toBe(false);
  });

  it("hold still starts a voice note while quiet (the mic is untouched), and recording is never quiet", () => {
    const working = session(true);
    const q = quietGesture(working, "longPress", T0);
    expect(q.consumed).toBe(false);
    expect(isQuiet({ ...working, recording: true }, T0)).toBe(false);
    expect(isQuiet({ ...working, voice: { state: "transcribing", agentId: "x" } }, T0)).toBe(false);
  });

  it("a permission card, a message or an alert brings the normal display back at once", () => {
    const working = session(true);
    expect(isQuiet({ ...working, report: { ...working.report, approvals: [card] } }, T0)).toBe(false);
    expect(isQuiet({ ...working, message: { text: "gesendet", until: T0 + 3000 } }, T0)).toBe(false);
    expect(isQuiet({ ...working, message: { text: "gesendet", until: T0 - 1 } }, T0)).toBe(true);
    // A new alert (poll) wakes the display like a gesture.
    expect(isQuiet(wake(working, T0), T0 + 5000)).toBe(false);
    expect(isQuiet({ ...working, cheerUntil: T0 + 4000 }, T0)).toBe(false);
    expect(isQuiet({ ...working, help: true }, T0)).toBe(false);
  });

  it("the glasses menu switches it, with a fixed label (no rebuild) and an effect to persist it", () => {
    const off = session(true, false);
    const items = menuFor(off, "de").items;
    expect(items.map((item) => item.label)).toContain("Ruhe beim Arbeiten an/aus");
    expect(items.length).toBeLessThanOrEqual(6);
    const on = applyMenu(off, MENU.quiet, T0);
    expect(on.effect).toEqual({ kind: "quietSetting", on: true });
    expect(on.model.quietWhileWorking).toBe(true);
    expect(menuFor(on.model, "de").key).toBe(menuFor(off, "de").key);
    // The acknowledgement is readable first, then the display goes quiet.
    expect(isQuiet(on.model, T0)).toBe(false);
    expect(isQuiet(on.model, T0 + 6000)).toBe(true);
    expect(applyMenu(on.model, MENU.quiet, T0).effect).toEqual({ kind: "quietSetting", on: false });
  });
});

describe("quiet on the glasses: brightness in place, no create, no rebuild", () => {
  function fakeBridge() {
    const calls: Array<{ kind: string; name?: string | undefined; textColor?: number | undefined; content?: string | undefined }> = [];
    const bridge = {
      textContainerUpgrade: async (c: { containerName?: string; textColor?: number; content?: string }) => { calls.push({ kind: "text", name: c.containerName, textColor: c.textColor, content: c.content }); return true; },
      updateImageRawData: async () => { calls.push({ kind: "image" }); return "success"; },
      rebuildPageContainer: async () => { calls.push({ kind: "rebuild" }); return true; },
      createStartUpPageContainer: async () => { calls.push({ kind: "create" }); return 0; },
    } as unknown as EvenAppBridge;
    return { bridge, calls };
  }

  /** What main's drawOnce sends for one state. */
  function frame(model: HubModel, now: number): { view: ScreenView; icon: readonly string[]; menuKey: string } {
    const quiet = isQuiet(model, now);
    return { view: quiet ? QUIET_VIEW : buildView(model, "de", now), icon: quiet ? BLANK_ICON : pixelIconFor(model, now), menuKey: menuFor(model, "de").key };
  }

  it("normal -> quiet -> woken -> quiet -> done: only text upgrades, the face blanked", async () => {
    const { bridge, calls } = fakeBridge();
    const creates = renderStats.creates;
    const rebuilds = renderStats.rebuilds;
    const idle = session(false);
    const working = session(true);
    const woken = quietGesture(working, "click", T0).model;
    const done = mergeReport(working, withBusy(working.report, false));
    const states: Array<[HubModel, number]> = [[idle, T0], [working, T0], [working, T0 + 500], [woken, T0 + 600], [woken, T0 + WAKE_MS + 700], [done, T0 + WAKE_MS + 800]];
    const frames = states.map(([model, now]) => frame(model, now));
    // One menu throughout: no rebuild is needed for any of the switches.
    expect(new Set(frames.map((f) => f.menuKey)).size).toBe(1);

    await updatePage(bridge, frames[0]!.view, frames[0]!.icon, null);
    calls.length = 0;
    // -> quiet: all three containers dimmed in place, the face replaced by a black frame.
    await updatePage(bridge, frames[1]!.view, frames[1]!.icon, frames[0]!.view);
    expect(calls.filter((c) => c.kind === "text").map((c) => [c.name, c.textColor])).toEqual([["header", 0], ["body", 0], ["footer", 1]]);
    // The face is swapped for one black (= transparent) frame; while quiet the frame stays the same.
    expect(frames[1]!.icon).toEqual(BLANK_ICON);
    expect(frames[2]!.icon).toEqual(frames[1]!.icon);
    expect(frames[0]!.icon).not.toEqual(BLANK_ICON);
    expect(calls.find((c) => c.name === "footer")?.content).toBe("·");
    calls.length = 0;
    // Quiet stays quiet: no text crosses BLE (and main skips the face timer entirely).
    await updatePage(bridge, frames[2]!.view, frames[2]!.icon, frames[1]!.view);
    expect(calls.filter((c) => c.kind === "text")).toEqual([]);
    // Woken: full brightness and the progress again.
    await updatePage(bridge, frames[3]!.view, frames[3]!.icon, frames[2]!.view);
    expect(calls.filter((c) => c.kind === "text").map((c) => c.textColor)).toEqual([4, 4, 4]);
    expect(frames[3]!.view.dim).toBeUndefined();
    calls.length = 0;
    await updatePage(bridge, frames[4]!.view, frames[4]!.icon, frames[3]!.view);
    expect(frames[4]!.view.dim).toBe(true);
    calls.length = 0;
    // Done: normal display with the answer.
    await updatePage(bridge, frames[5]!.view, frames[5]!.icon, frames[4]!.view);
    expect(calls.filter((c) => c.kind === "text").map((c) => c.textColor)).toEqual([4, 4, 4]);
    expect(frames[5]!.view.body.join(" ")).toContain("Fertig");
    expect(calls.some((c) => c.kind === "create" || c.kind === "rebuild")).toBe(false);
    expect(renderStats.creates).toBe(creates);
    expect(renderStats.rebuilds).toBe(rebuilds);
  });

  it("normal text updates never carry a brightness", async () => {
    const { bridge, calls } = fakeBridge();
    const a = buildView(session(false), "de", T0);
    await updatePage(bridge, a, pixelIconFor(session(false), T0), null);
    calls.length = 0;
    await updatePage(bridge, { ...a, footer: "x" }, pixelIconFor(session(false), T0), a);
    expect(calls.filter((c) => c.kind === "text")).toEqual([{ kind: "text", name: "footer", textColor: undefined, content: "x" }]);
  });
});
