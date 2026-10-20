import { afterEach, describe, expect, it, vi } from "vitest";
import { bannerFor, heroFor, isFirstRun, lastDays, mountPhoneUi, nowInner, pillFor, setupInner } from "../src/ui/phone";
import { cockpitState, shiftFigures } from "../src/cockpit/model";
import { firstRunData, type ClockData } from "../src/storage/persist";
import { fakeRoot } from "./fake-dom";

// QUS v1 phone: "Jetzt" is a banner, one hero card with a 2 x 2 grid and one button, and a strip of day cards.
const NOW = new Date(2026, 9, 14, 12, 0).getTime(); // a Wednesday
const at = (day: number, h: number, m = 0): number => new Date(2026, 9, day, h, m).getTime();
const entry = (id: string, day: number, from: number, to: number) => ({ id, project: "Arbeit", startedAt: at(day, from), endedAt: at(day, to) });
const base: ClockData = { ...firstRunData("de"), dailyTargetHours: 8, entries: [entry("a", 14, 8, 10), entry("b", 13, 8, 12)] };
const stateOf = (data: ClockData) => {
  const f = shiftFigures(data.open, data.entries, NOW, data.dailyTargetHours);
  return { f, state: cockpitState(f, false) };
};

describe("phone page: Jetzt (QUS v1)", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("hero card: one label, one big value, a side value; 2 x 2 key figures; one primary button; a strip of days", () => {
    const html = nowInner(base, NOW, "de");
    expect(html).toContain('class="banner');
    expect(html).toContain('class="card hero-card"');
    expect([...html.matchAll(/<strong>/g)]).toHaveLength(1);
    expect(html).toContain("<span>Pause</span><strong>2:00</strong>"); // stopped since 10:00
    expect(html).toContain("seit 10:00");
    const stats = html.slice(html.indexOf('<div class="stats">'), html.indexOf('<button id="toggle"'));
    expect([...stats.matchAll(/<b>/g)]).toHaveLength(4);
    for (const label of ["Heute", "Woche", "Start", "Pause"]) expect(stats).toContain(`<span>${label}</span>`);
    expect(stats).toContain("<b>2:00</b>"); // today
    expect(stats).toContain("<b>6:00</b>"); // week: Tuesday 4 h + Wednesday 2 h
    expect(stats).toContain("<b>08:00</b>"); // start
    expect([...html.matchAll(/<button/g)]).toHaveLength(1);
    expect(html).toContain('id="toggle"');
    expect(html).toContain("Schicht starten");
    expect([...html.matchAll(/class="host day/g)]).toHaveLength(7);
  });

  it("the states: running (left), over the target, break, done, idle", () => {
    const running = { ...base, open: { project: "Arbeit", startedAt: at(14, 10, 30) } };
    expect(heroFor(running, stateOf(running).f, stateOf(running).state, "de")).toEqual({ label: "Noch", value: "4:30", side: "Ziel 8 h" });
    expect(nowInner(running, NOW, "en")).toContain("Stop shift");
    const over = { ...base, dailyTargetHours: 3, open: { project: "Arbeit", startedAt: at(14, 10, 30) } };
    expect(heroFor(over, stateOf(over).f, stateOf(over).state, "en")).toMatchObject({ label: "Over", value: "0:30" });
    const pause = stateOf(base);
    expect(pause.state).toBe("pause");
    expect(heroFor(base, pause.f, pause.state, "en")).toMatchObject({ label: "Break", value: "2:00", side: "since 10:00" });
    const done = { ...base, dailyTargetHours: 2 };
    expect(stateOf(done).state).toBe("done");
    expect(heroFor(done, stateOf(done).f, "done", "de")).toMatchObject({ label: "Feierabend", value: "2:00" });
    expect(bannerFor(done, stateOf(done).f, "done", "de")).toEqual({ tone: "ok", text: "Tagesziel erreicht. Schönen Feierabend." });
    const idle = { ...firstRunData("en"), dailyTargetHours: null };
    expect(stateOf(idle).state).toBe("idle");
    expect(heroFor(idle, stateOf(idle).f, "idle", "en")).toMatchObject({ label: "Ready", value: "0:00" });
    expect(pillFor("running", "de")).toEqual({ text: "● läuft", on: true });
    expect(pillFor("pause", "en").on).toBe(false);
  });

  it("the strip lists the last seven days, oldest first, today last", () => {
    const days = lastDays(base, NOW, "en");
    expect(days).toHaveLength(7);
    expect(days[6]).toMatchObject({ today: true, seconds: 2 * 3600 });
    expect(days[5]).toMatchObject({ today: false, seconds: 4 * 3600 });
    expect(days[0]!.seconds).toBe(0);
  });

  it("the one button asks the app to start or stop", () => {
    const root = fakeRoot();
    vi.stubGlobal("document", { getElementById: () => root });
    vi.stubGlobal("navigator", { language: "en-US" });
    const toggleShift = vi.fn();
    mountPhoneUi({ getData: () => firstRunData("en"), setData: async () => undefined, toggleShift });
    root.get("#toggle").fire("click");
    expect(toggleShift).toHaveBeenCalledTimes(1);
  });

  it("first run: Einstellungen come with the three-step checklist; later it is gone", () => {
    const fresh = firstRunData("de");
    expect(isFirstRun(fresh)).toBe(true);
    const html = setupInner(fresh, "de");
    expect([...html.matchAll(/class="num"/g)]).toHaveLength(3);
    expect(html).toContain("✓"); // the ready-made project is step 1, done
    expect(html).toContain("Tagesziel eintragen (optional)");
    expect(isFirstRun({ ...fresh, dailyTargetHours: 8 })).toBe(false);
    expect(isFirstRun({ ...fresh, entries: [entry("a", 14, 8, 9)] })).toBe(false);
    expect(isFirstRun({ ...fresh, open: { project: "Arbeit", startedAt: 1 } })).toBe(false);
    const root = fakeRoot();
    vi.stubGlobal("document", { getElementById: () => root });
    vi.stubGlobal("navigator", { language: "de-AT" });
    mountPhoneUi({ getData: () => fresh, setData: async () => undefined });
    expect(root.innerHTML).toContain("Erste Schritte");
    mountPhoneUi({ getData: () => ({ ...fresh, dailyTargetHours: 8 }), setData: async () => undefined });
    expect(root.innerHTML).not.toContain("Erste Schritte");
  });
});
