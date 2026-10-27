import { describe, expect, it, vi } from "vitest";
import { discoverHub, discoveryOwns, hubCandidates, probeOrder } from "../src/api/discover";
import { areaLine, cursorIndex, startEntries, warnings } from "../src/hub/areas";
import { carRows, serverRows } from "../src/hub/status-pages";
import { buildView, createModel, decide, type HubModel } from "../src/hub/model";
import { detailChoices, initialZuhause } from "../src/hub/zuhause";
import { demoReport } from "../src/api/demo";
import type { Brief, HomeEntity, HubReport } from "../src/api/types";
import { ROW_WIDTH } from "../src/glasses/screen";

vi.mock("../src/glasses/pixel", () => ({ ICON_WIDTH: 64, ICON_HEIGHT: 30, renderPixelIcon: async () => new Uint8Array([1, 2, 3]) }));

const NOW = 1_793_118_098_634;
const PI = "https://pi.example.ts.net:8443";
const OTHER = "https://other.example.ts.net:8443";

const brief = (patch: Partial<Brief> = {}): Brief => ({
  at: NOW - 120_000, date: "2026-10-27",
  calendar: { status: "ok", events: [], total: 2 },
  weather: { status: "ok", tempC: 14.4, code: 1, rain: { kind: "none", from: "", until: "", mm: 0 } },
  car: { status: "ok", soc: 60, rangeKm: 188, charging: false, chargeDone: false, etaMin: null, locked: true, mode: "parked" },
  sugar: { status: "ok", current: { mgdl: 114, direction: "Flat", ageMin: 2 }, low: 70, high: 180 },
  printer: { status: "ok", state: "standby" },
  servers: { status: "ok", machines: [{ name: "Pi5", ok: true, newDevices: null, warn: 0 }, { name: "ns1", ok: true, newDevices: null, warn: 0 }], down: 0, newDevices: 0 },
  ...patch,
});
const quiet = (report: HubReport = demoReport()): HubReport => ({ ...report, approvals: [], inbox: { selected: 0, events: [] } });

describe("self-discovery of the hub", () => {
  it("reads the private candidate list, Pi first, without duplicates or trailing slashes", () => {
    expect(hubCandidates(` ${PI}/ ,${OTHER},${PI}`)).toEqual([PI, OTHER]);
    expect(hubCandidates(undefined)).toEqual([]);
    expect(hubCandidates("")).toEqual([]);
  });

  it("tries the address that worked last first, then the list", () => {
    expect(probeOrder([PI, OTHER], OTHER)).toEqual([OTHER, PI]);
    expect(probeOrder([PI, OTHER], "")).toEqual([PI, OTHER]);
    expect(probeOrder([PI, OTHER], "https://typed.example:1")).toEqual([PI, OTHER]);
  });

  it("never replaces an address set on the phone", () => {
    expect(discoveryOwns("", [PI])).toBe(true);
    expect(discoveryOwns(`${PI}/`, [PI])).toBe(true);
    expect(discoveryOwns("https://typed.example:1", [PI])).toBe(false);
    expect(discoveryOwns("", [])).toBe(false);
  });

  it("takes the first candidate that answers, in order", async () => {
    const asked: string[] = [];
    const found = await discoverHub([PI, OTHER], async (url) => { asked.push(url); if (url === PI) throw new Error("Load failed"); return true; });
    expect(found).toBe(OTHER);
    expect(asked).toEqual([PI, OTHER]);
    expect(await discoverHub([PI], async () => false)).toBeNull();
  });
});

describe("start page areas", () => {
  it("one live row per area from the report and the briefing", () => {
    const report = quiet();
    const b = brief();
    expect(areaLine("car", report, b, "de")).toBe("Auto · 60 % · 188 km · zu");
    expect(areaLine("server", report, b, "de")).toBe("Server · 2/2 ok");
    expect(areaLine("brief", report, b, "de")).toBe("Tag · 14° · 2 Termine · 114 →");
    expect(areaLine("car", report, null, "de")).toBe("Auto · …");
    expect(areaLine("car", report, brief({ car: { status: "off" } }), "de")).toBe("Auto · nicht eingerichtet");
    expect(areaLine("car", report, brief({ car: { ...b.car, charging: true, stale: true } }), "en")).toBe("Car · 60 % · 188 km · charging · locked · old");
    expect(areaLine("printer", { ...report, printer: { ...report.printer, offline: true } }, b, "de")).toBe("Drucker · aus");
    for (const entry of startEntries(report, b, "de")) expect(entry.text.length + 4).toBeLessThanOrEqual(ROW_WIDTH);
  });

  it("warnings come first: server down, car open, sugar out of range, printer fault - an offline printer is no warning", () => {
    const report = quiet();
    expect(warnings(report, brief(), "de")).toEqual([]);
    const bad = brief({
      servers: { status: "ok", machines: [{ name: "ns1", ok: false, newDevices: null }, { name: "Pi5", ok: true, newDevices: null }], down: 1 },
      car: { ...brief().car, locked: false },
      sugar: { status: "ok", current: { mgdl: 62, direction: "SingleDown", ageMin: 3 }, low: 70, high: 180 },
    });
    expect(warnings(report, bad, "de").map((w) => w.text)).toEqual(["Server aus: ns1", "Auto ist nicht zugesperrt", "Zucker niedrig 62 ↓"]);
    // Only two warning rows on the page; the rest is in the area rows.
    expect(startEntries(report, bad, "de").filter((e) => e.warn)).toHaveLength(2);
    // Old sugar values or a stale car never warn.
    expect(warnings(report, brief({ sugar: { status: "ok", current: { mgdl: 62, direction: "Flat", ageMin: 40 } }, car: { ...brief().car, locked: false, stale: true } }), "de")).toEqual([]);
    expect(warnings({ ...report, printer: { ...report.printer, state: "error", offline: true } }, brief(), "de")).toEqual([]);
    expect(warnings({ ...report, printer: { ...report.printer, state: "error", offline: false } }, brief(), "de").map((w) => w.screen)).toEqual(["printer"]);
  });

  it("Panoptes' car state wins over the old bridge: locked there = no 'open' warning", () => {
    const report: HubReport = { ...quiet(), car: { status: "ok", soc: 57, rangeKm: 176, locked: true, at: NOW } };
    const oldBridge = brief({ car: { ...brief().car, locked: false } });
    expect(warnings(report, oldBridge, "de")).toEqual([]);
    expect(areaLine("car", report, oldBridge, "de")).toBe("Auto · 57 % · 176 km · zu");
  });

  it("the cursor is a key; a gone key falls back to the row number", () => {
    const entries = startEntries(quiet(), brief(), "de");
    expect(cursorIndex(entries, "area:server", 0)).toBe(4);
    expect(cursorIndex(entries, "warn:approval", 2)).toBe(2);
    expect(cursorIndex(entries, null, 99)).toBe(entries.length - 1);
  });
});

describe("Auto and Server pages (read-only)", () => {
  const on = (screen: "car" | "server"): HubModel => ({ ...createModel(quiet()), screen, brief: brief() });

  it("the car page shows battery, lock, charging and state - and says it only shows", () => {
    const rows = carRows(brief(), "de", NOW);
    expect(rows).toEqual(["Akku · 60 % · 188 km", "Schloss · zugesperrt", "Laden · nein", "Zustand · geparkt", "", "Stand vor 2 min", "nur Anzeige · steuern noch nicht freigegeben"]);
    expect(carRows(brief({ car: { ...brief().car, charging: true, etaMin: 40 } }), "en", NOW)[2]).toBe("Charging · charging · full in 40 min");
    expect(carRows(null, "de", NOW)).toEqual(["Lädt …"]);
  });

  it("the server page lists the machines", () => {
    const rows = serverRows(brief({ servers: { status: "ok", machines: [{ name: "Pi5", ok: true, newDevices: 1, warn: 2 }, { name: "ns1", ok: false, newDevices: null }], down: 1 } }), "de", NOW);
    expect(rows[0]).toBe("● Pi5 · 2 Hinweise · 1 neues Gerät");
    expect(rows[1]).toBe("○ ns1 · nicht erreichbar");
  });

  it("tap refreshes, swipe does nothing, 2x goes back - no gesture can steer the car", () => {
    for (const screen of ["car", "server"] as const) {
      const m = on(screen);
      expect(decide(m, "click", NOW, "de").effect).toEqual({ kind: "brief", refresh: true });
      expect(decide(m, "scrollDown", NOW, "de").effect).toBeUndefined();
      expect(decide(m, "longPress", NOW, "de").effect).toEqual({ kind: "brief", refresh: true });
      const back = decide(m, "doubleClick", NOW, "de");
      expect(back.model.screen).toBe("root");
      expect(back.effect).toBeUndefined();
      const view = buildView(m, "de", NOW);
      expect(view.header).toMatch(screen === "car" ? /^Auto · / : /^Server · /);
      expect(view.footer).toBe("Tippen = aktualisieren · 2× = zurück");
    }
  });
});

describe("Zuhause: TV / projector as one remote", () => {
  const tv: HomeEntity = { id: "media_player.wohnzimmer", name: "TV", kind: "media", state: "on", on: true, available: true, volume: 20, muted: false, value: "Netflix", remote: "remote.wohnzimmer" };
  const beamer: HomeEntity = { id: "media_player.miprojm05", name: "Beamer", kind: "media", state: "off", on: false, available: true };
  const withTv = (): HubModel => {
    const base = demoReport();
    const view = base.homeView!;
    const report: HubReport = { ...base, homeView: { ...view, favorites: [tv.id, beamer.id, ...view.favorites], entities: { ...view.entities, [tv.id]: tv, [beamer.id]: beamer } } };
    return { ...createModel(report), screen: "home", zh: initialZuhause() };
  };

  it("a tap opens the remote; volume steps keep the list open (tap, tap, tap)", () => {
    const m = withTv();
    expect(buildView(m, "de", NOW).body[0]).toBe("> ● TV");
    const opened = decide(m, "click", NOW, "de").model;
    expect(opened.zh).toMatchObject({ level: "detail", detailId: tv.id, choice: 0 });
    expect(detailChoices(tv, "de").map((c) => c.label)).toEqual(["Lauter", "Leiser", "Stumm", "Play / Pause", "Aus"]);
    const louder = decide(opened, "click", NOW, "de");
    expect(louder.effect).toEqual({ kind: "homeAction", target: tv.id, action: "volume_up" });
    expect(louder.model.zh?.choice).toBe(0);
    expect(louder.model.message?.text).toBe("TV: Lauter");
    expect(decide(louder.model, "click", NOW + 300, "de").effect).toEqual({ kind: "homeAction", target: tv.id, action: "volume_up" });
    // "Aus" closes the list.
    const off = decide({ ...opened, zh: { ...opened.zh!, choice: 4 } }, "click", NOW, "de");
    expect(off.effect).toEqual({ kind: "homeAction", target: tv.id, action: "turn_off" });
    expect(off.model.zh?.choice).toBeNull();
  });

  it("a projector that is off offers only 'An'; the area row names what is on", () => {
    expect(detailChoices(beamer, "de").map((c) => c.action)).toEqual(["turn_on"]);
    expect(areaLine("home", withTv().report, null, "de")).toMatch(/^Zuhause · .* · TV an/);
  });
});

describe("Auto page with Panoptes pairing (carControl)", () => {
  const paired = (): HubModel => ({ ...createModel({ ...quiet(), carControl: true }), screen: "car", brief: brief() });

  it("shows two status rows and the four commands - no horn, lights or alarm", () => {
    const body = buildView(paired(), "de", NOW).body;
    expect(body.slice(0, 2)).toEqual(["60 % · 188 km · zugesperrt", "Stand vor 2 min"]);
    expect(body.slice(3)).toEqual(["> Zusperren", "  Vorheizen 21° · 15 min", "  Klima aus", "  Aufsperren"]);
    expect(body.join(" ")).not.toMatch(/Hupe|Licht|Blinker|Alarm|finden/);
    expect(buildView(paired(), "de", NOW).footer).toBe("Tippen = ausführen · Wischen = wählen · 2× = zurück");
  });

  it("every command needs a second tap; unlock is armed with its own loud label", () => {
    const first = decide(paired(), "click", NOW, "de");
    expect(first.effect).toBeUndefined();
    expect(buildView(first.model, "de", NOW).footer).toMatch(/^Nochmal tippen = zusperren/);
    expect(decide(first.model, "click", NOW + 500, "de").effect).toEqual({ kind: "car", aktion: "zusperren" });
    // Too late: arms again instead of sending.
    expect(decide(first.model, "click", NOW + 10_000, "de").effect).toBeUndefined();
    let m = paired();
    for (let i = 0; i < 3; i += 1) m = decide(m, "scrollDown", NOW, "de").model;
    const armed = decide(m, "click", NOW, "de");
    expect(armed.effect).toBeUndefined();
    expect(buildView(armed.model, "de", NOW).footer).toMatch(/^Nochmal tippen = AUFSPERREN/);
    // A swipe or 2x in between disarms: nothing is sent.
    expect(decide(decide(armed.model, "scrollUp", NOW, "de").model, "click", NOW + 100, "de").effect).toBeUndefined();
    expect(decide(armed.model, "click", NOW + 300, "de").effect).toEqual({ kind: "car", aktion: "aufsperren" });
    const heat = decide(decide(decide(paired(), "scrollDown", NOW, "de").model, "click", NOW, "de").model, "click", NOW + 100, "de");
    expect(heat.effect).toEqual({ kind: "car", aktion: "klima_an", tempC: 21, minuten: 15 });
  });

  it("without pairing the page stays read-only", () => {
    const m: HubModel = { ...createModel(quiet()), screen: "car", brief: brief() };
    expect(decide(m, "click", NOW, "de").effect).toEqual({ kind: "brief", refresh: true });
    expect(buildView(m, "de", NOW).body.join(" ")).not.toMatch(/Aufsperren/);
  });
});
