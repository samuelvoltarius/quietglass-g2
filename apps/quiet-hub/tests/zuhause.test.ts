import { describe, expect, it, vi } from "vitest";
import { validateEvenHubPageContainer, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { applyMenu, buildView, createModel, decide, menuFor, mergeReport, MENU, statusLine, withHomePending, type HubModel } from "../src/hub/model";
import {
  applyHomeAction, clampZuhause, dimmed, homeViewOf, initialZuhause, listEntries, LIST_CHARS, SIDE_CHARS, type ZuhauseState,
} from "../src/hub/zuhause";
import { createDemoApi, demoHomeView, demoReport } from "../src/api/demo";
import type { HomeEntity, HomeView, HubReport } from "../src/api/types";
import { MAX_BODY_ROWS, ROW_WIDTH } from "../src/glasses/screen";
import { buildPage, SPLIT_X, updatePage } from "../src/glasses/render";
import { sameView } from "../src/glasses/diff";

vi.mock("../src/glasses/pixel", () => ({ ICON_WIDTH: 64, ICON_HEIGHT: 30, renderPixelIcon: async () => new Uint8Array([1, 2, 3]) }));

const T0 = 5_000_000;
const zh = (patch: Partial<ZuhauseState> = {}): ZuhauseState => ({ ...initialZuhause(), ...patch });
const home = (state: Partial<ZuhauseState> = {}, report: HubReport = demoReport()): HubModel => ({ ...createModel(report), screen: "home", zh: zh(state) });
const view = (m: HubModel): HomeView => homeViewOf(m.report) as HomeView;

describe("Zuhause list: favourites first, then areas", () => {
  it("orders the top list and shows the state of the selected row on the right", () => {
    const m = home();
    expect(listEntries(view(m)).map((e) => e.id)).toEqual(["scene.abend", "light.buero", "lock.haustuer", "sensor.aussen", "wohnzimmer", "buero", "schlafzimmer"]);
    const v = buildView(m, "de", T0);
    expect(v.body[0]).toBe("> » Abendlicht");
    expect(v.body[1]).toBe("  ● Büro Decke");
    expect(v.body[4]).toBe("  → Wohnzimmer");
    expect(v.side?.[0]).toBe("Abendlicht");
    expect(v.side).toContain("Tippen = starten");
    expect(v.footer).toBe("Tippen = schalten · Halten = Details · 2× = zurück");
  });

  it("an area row summarises lights, blinds, sensors and motion", () => {
    const side = buildView(home({ index: 4 }), "de", T0).side ?? [];
    expect(side).toEqual(expect.arrayContaining(["Wohnzimmer", "1/3 Lichter an", "1/2 Rollos offen", "21,5 °C", "48 %", "Bewegung", "Tippen = Raum öffnen"]));
    const office = buildView(home({ index: 5 }), "en", T0).side ?? [];
    expect(office).toContain("Battery 14 %");
  });

  it("tap opens an area: groups first; 2× climbs back to the list, then to the overview", () => {
    const opened = decide(home({ index: 4 }), "click", T0).model;
    expect(opened.zh?.level).toBe("area");
    const v = buildView(opened, "de", T0);
    expect(v.body[0]).toBe("> ● Alle Lichter");
    expect(v.body[1]).toBe("  ● Alle Rollos");
    expect(statusLine(opened, "de")).toMatch(/^QUIET HUB · Zuhause · Wohnzimmer/);
    expect(v.side?.[1]).toBe("1/3 an");
    const back = decide(opened, "doubleClick", T0).model;
    expect(back.screen).toBe("home");
    expect(back.zh?.level).toBe("list");
    expect(back.zh?.index).toBe(4);
    expect(decide(back, "doubleClick", T0).model.screen).toBe("root");
  });

  it("swipe wraps around in the list and inside an area", () => {
    expect(decide(home(), "scrollUp", T0).model.zh?.index).toBe(6);
    const area = decide(home({ index: 4 }), "click", T0).model;
    expect(decide(area, "scrollUp", T0).model.zh?.areaIndex).toBe(9);
  });
});

describe("Zuhause actions", () => {
  it("'all lights' with one light on switches all of them off at once (optimistic)", () => {
    const area = decide(home({ index: 4 }), "click", T0).model;
    const out = decide(area, "click", T0);
    expect(out.effect).toEqual({ kind: "homeAction", target: "group:wohnzimmer:light", action: "toggle" });
    const after = view(out.model);
    expect(["light.wz_decke", "light.wz_lampe", "light.wz_regal"].map((id) => after.entities[id]?.on)).toEqual([false, false, false]);
    expect(after.entities["group:wohnzimmer:light"]).toMatchObject({ on: false, state: "0/3" });
    expect(buildView(out.model, "de", T0 + 1).footer).toBe("Alle Lichter: 0/3 an");
  });

  it("a scene runs, a sensor is read-only, a switch toggles", () => {
    expect(decide(home({ index: 0 }), "click", T0).effect).toEqual({ kind: "homeAction", target: "scene.abend", action: "run" });
    const sensor = decide(home({ index: 3 }), "click", T0);
    expect(sensor.effect).toBeUndefined();
    expect(sensor.model.message?.text).toContain("nur Anzeige");
    const office = decide(home({ index: 5 }), "click", T0).model;
    const sw = decide({ ...office, zh: { ...office.zh!, areaIndex: 1 } }, "click", T0);
    expect(sw.effect).toEqual({ kind: "homeAction", target: "switch.drucker", action: "toggle" });
  });

  it("QIS v1.2: hold on a light opens its detail; tap opens Aus · 30 % · 60 % · 100 %, tap runs, 2× closes", () => {
    const detail = decide(home({ index: 1 }), "longPress", T0).model;
    expect(detail.zh).toMatchObject({ level: "detail", detailId: "light.buero" });
    const v = buildView(detail, "de", T0);
    expect(v.body).toContain("[######----] 60 %");
    expect(v.side).toEqual(["Tippen = Auswahl", "2× = zurück"]);
    expect(v.footer).toBe("Tippen = Auswahl · Wischen = Gerät · 2× = zurück");
    // Tap opens the choice list - nothing is sent yet.
    const opened = decide(detail, "click", T0);
    expect(opened.effect).toBeUndefined();
    expect(opened.model.zh?.choice).toBe(0);
    const list = buildView(opened.model, "de", T0);
    expect(list.body.slice(2)).toEqual(["> Aus", "  30 %", "  60 %", "  100 %"]);
    expect(list.footer).toBe("Tippen = ausführen · Wischen = wählen · 2× = zurück");
    expect(list.side).toEqual(["Tippen = ausführen", "Wischen = wählen", "2× = schließen"]);
    // Swipe moves in the list (wraps), still nothing sent.
    const on60 = decide(decide(opened.model, "scrollDown", T0).model, "scrollDown", T0);
    expect(on60.effect).toBeUndefined();
    expect(on60.model.zh?.choice).toBe(2);
    expect(decide(opened.model, "scrollUp", T0).model.zh?.choice).toBe(3);
    // Tap runs the chosen entry with the same call as before (brightness), the list closes.
    const run = decide(on60.model, "click", T0);
    expect(run.effect).toEqual({ kind: "homeAction", target: "light.buero", action: "brightness", value: 60 });
    expect(run.model.zh).toMatchObject({ level: "detail", choice: null });
    expect(decide(opened.model, "click", T0).effect).toEqual({ kind: "homeAction", target: "light.buero", action: "brightness", value: 0 });
    // 2x closes the list without any action, a second 2x leaves the detail.
    const closed = decide(on60.model, "doubleClick", T0);
    expect(closed.effect).toBeUndefined();
    expect(closed.model.zh).toMatchObject({ level: "detail", choice: null });
    expect(decide(closed.model, "doubleClick", T0).model.zh?.level).toBe("list");
  });

  it("a light without a known level (maybe on/off only) also offers An = turn_on", () => {
    const report = demoReport();
    const v0 = report.homeView!;
    const plain = { ...report, homeView: { ...v0, entities: { ...v0.entities, "light.buero": { ...v0.entities["light.buero"]!, brightness: null } } } };
    const opened = decide(decide(home({ index: 1 }, plain), "longPress", T0).model, "click", T0).model;
    expect(buildView(opened, "en", T0).body.slice(2)).toEqual(["> Off", "  30 %", "  60 %", "  100 %", "  On"]);
    const on = decide(decide(opened, "scrollUp", T0).model, "click", T0);
    expect(on.effect).toEqual({ kind: "homeAction", target: "light.buero", action: "turn_on" });
  });

  it("swipe in the detail only moves to the next light / cover of the same room (and the list follows)", () => {
    const area = decide(home({ index: 4 }), "click", T0).model;
    const detail = decide({ ...area, zh: { ...area.zh!, areaIndex: 2 } }, "longPress", T0).model;
    expect(detail.zh?.detailId).toBe("light.wz_decke");
    expect(buildView(detail, "de", T0).side).toEqual(["Tippen = Auswahl", "Wischen = Gerät", "2/6", "2× = zurück"]);
    const next = decide(detail, "scrollDown", T0);
    expect(next.effect).toBeUndefined();
    expect(next.model.zh).toMatchObject({ level: "detail", detailId: "light.wz_lampe", areaIndex: 3 });
    expect(view(next.model)).toEqual(view(detail)); // nothing changed in the house
    const prev = decide(decide(detail, "scrollUp", T0).model, "scrollUp", T0);
    expect(prev.model.zh?.detailId).toBe("cover.wz_rechts"); // wraps past the group to the last blind
    expect(decide(next.model, "doubleClick", T0).model.zh).toMatchObject({ level: "area", areaIndex: 3 });
  });

  it("dimming to 0 switches off; from off one swipe up is 10 %", () => {
    const light = { id: "l", name: "L", kind: "light", state: "off", on: false, available: true, brightness: 0 } as HomeEntity;
    expect(dimmed(light, true)).toBe(10);
    expect(dimmed({ ...light, on: true, brightness: 10 }, false)).toBe(0);
    expect(dimmed({ ...light, on: true, brightness: null }, false)).toBe(90);
  });

  it("cover detail: tap opens Auf · Zu · Stopp; swipe moves, tap runs open / close / stop", () => {
    const area = decide(home({ index: 4 }), "click", T0).model;
    const detail = decide({ ...area, zh: { ...area.zh!, areaIndex: 1 } }, "longPress", T0).model;
    expect(detail.zh?.detailId).toBe("group:wohnzimmer:cover");
    expect(buildView(detail, "de", T0).footer).toBe("Tippen = Auswahl · Wischen = Gerät · 2× = zurück");
    const opened = decide(detail, "click", T0).model;
    expect(buildView(opened, "de", T0).body.slice(2)).toEqual(["> Auf", "  Zu", "  Stopp"]);
    expect(decide(opened, "click", T0).effect).toEqual({ kind: "homeAction", target: "group:wohnzimmer:cover", action: "open" });
    expect(decide(decide(opened, "scrollDown", T0).model, "click", T0).effect).toMatchObject({ action: "close" });
    expect(decide(decide(opened, "scrollUp", T0).model, "click", T0).effect).toMatchObject({ action: "stop" });
    expect(decide(opened, "doubleClick", T0).model.zh).toMatchObject({ level: "detail", choice: null });
    expect(decide(detail, "doubleClick", T0).model.zh?.level).toBe("area");
  });

  it("no swipe on the Zuhause page ever calls Home Assistant (list, area, detail, choice list)", () => {
    const area = decide(home({ index: 4 }), "click", T0).model;
    const starts: HubModel[] = [home(), home({ index: 1 }), area];
    for (let i = 0; i < 10; i += 1) starts.push(decide({ ...area, zh: { ...area.zh!, areaIndex: i } }, "longPress", T0).model);
    for (const m of [...starts]) if (m.zh?.level === "detail") starts.push(decide(m, "click", T0).model);
    expect(starts.filter((m) => typeof m.zh?.choice === "number").length).toBeGreaterThan(3);
    for (const start of starts) {
      let m = start;
      for (let i = 0; i < 12; i += 1) {
        for (const gesture of ["scrollDown", "scrollUp", "scrollDown"] as const) {
          const out = decide(m, gesture, T0);
          expect(out.effect, `${gesture} on ${JSON.stringify(m.zh)}`).toBeUndefined();
          expect(view(out.model)).toEqual(view(start));
          m = out.model;
        }
      }
    }
  });

  it("locks keep their armed two-step confirm (no detail, no choice list)", () => {
    const lock = home({ index: 2 });
    expect(decide(lock, "longPress", T0).model.zh?.level).toBe("list");
    expect(decide(lock, "click", T0).effect).toEqual({ kind: "homeAction", target: "lock.haustuer", action: "toggle" });
  });

  it("hold on a scene or sensor stays the refresh it is everywhere else", () => {
    expect(decide(home({ index: 0 }), "longPress", T0).effect).toEqual({ kind: "refresh" });
    expect(applyMenu(home({ index: 0 }), MENU.detail, T0).effect).toBeUndefined();
    expect(applyMenu(home({ index: 1 }), MENU.detail, T0).model.zh?.level).toBe("detail");
  });
});

describe("Zuhause: lock / alarm / garage need the daemon's second step", () => {
  it("first tap asks for a token, the confirm line counts down, second tap sends the token", () => {
    const first = decide(home({ index: 2 }), "click", T0);
    expect(first.effect).toEqual({ kind: "homeAction", target: "lock.haustuer", action: "toggle" });
    expect(view(first.model).entities["lock.haustuer"]?.on).toBe(false);
    const armed = withHomePending(first.model, "lock.haustuer", { token: "tok-1", label: "Haustür: aufsperren", expiresInMs: 30_000 }, T0);
    const v = buildView(armed, "de", T0 + 1000);
    expect(v.footer).toBe("Nochmal tippen = Haustür: aufsperren · 2× = abbrechen");
    const second = decide(armed, "click", T0 + 2000);
    expect(second.effect).toEqual({ kind: "homeConfirm", token: "tok-1" });
    expect(second.model.zh?.pending).toBeNull();
  });

  it("the token never confirms another row and is dropped by a swipe or 2×", () => {
    const armed = withHomePending(home({ index: 2 }), "lock.haustuer", { token: "tok-1", label: "x", expiresInMs: 30_000 }, T0);
    const other = decide({ ...armed, zh: { ...armed.zh!, index: 1 } }, "click", T0);
    expect(other.effect).toMatchObject({ kind: "homeAction", target: "light.buero" });
    expect(decide(armed, "scrollDown", T0).model.zh?.pending).toBeNull();
    expect(decide(armed, "doubleClick", T0).model.confirm).toBeNull();
  });

  it("the demo api behaves like the daemon: token first, then the lock moves", async () => {
    const api = createDemoApi("de");
    const first = await api.homeAction!("lock.haustuer", "toggle");
    expect(first.confirm?.label).toBe("Haustür: aufsperren");
    expect((await api.report()).homeView?.entities["lock.haustuer"]?.on).toBe(false);
    await api.homeConfirm!(first.confirm!.token);
    expect((await api.report()).homeView?.entities["lock.haustuer"]?.on).toBe(true);
    await api.homeAction!("light.wz_lampe", "brightness", 40);
    expect((await api.report()).homeView?.entities["light.wz_lampe"]).toMatchObject({ on: true, brightness: 40 });
  });
});

describe("Zuhause with new reports and older daemons", () => {
  it("a vanished area or entity falls back to the list", () => {
    const area = decide(home({ index: 4 }), "click", T0).model;
    const gone: HubReport = { ...demoReport(), homeView: { ...demoHomeView(), areas: [] } };
    const merged = mergeReport(area, gone);
    expect(merged.zh?.level).toBe("list");
    expect(merged.zh?.index).toBeLessThan(listEntries(gone.homeView!).length);
    expect(clampZuhause(zh({ level: "detail", detailId: "light.nope" }), demoHomeView()).level).toBe("list");
  });

  it("an older daemon (only home.devices) still switches through /home/toggle", () => {
    const { homeView: _drop, ...legacy } = demoReport();
    void _drop;
    const m = home({ index: 0 }, legacy);
    expect(buildView(m, "de", T0).body[0]).toBe("> ● Büro · Licht");
    expect(decide(m, "click", T0).effect).toEqual({ kind: "toggle", device: "light_office" });
    expect(decide(m, "longPress", T0).effect).toEqual({ kind: "refresh" });
  });

  it("no Home Assistant on the daemon: says so, no fake devices", () => {
    const report = { ...demoReport(), home: { ...demoReport().home, demo: true } };
    expect(buildView(home({}, report), "de", T0).body.join(" ")).toContain("nicht eingerichtet");
  });

  it("applyHomeAction leaves sensitive members alone and recounts groups", () => {
    const v = applyHomeAction(demoHomeView(), "group:wohnzimmer:cover", "close");
    expect(v.entities["cover.wz_links"]).toMatchObject({ on: false, state: "closed", position: 0 });
    expect(v.entities["group:wohnzimmer:cover"]).toMatchObject({ on: false, state: "0/2" });
  });
});

describe("Zuhause layout fits the glasses", () => {
  const long = "Sehr langer Gerätename im Wohnzimmer mit Ümläuten und noch mehr";
  const stress = (): HubReport => {
    const v = demoHomeView();
    const entities = Object.fromEntries(Object.entries(v.entities).map(([id, e]) => [id, { ...e, name: e.group === true ? e.name : `${long} ${id}` }]));
    return { ...demoReport(), homeView: { ...v, entities, areas: v.areas.map((a) => ({ ...a, name: `${long} Raum` })) } };
  };
  const states: Array<Partial<ZuhauseState>> = [
    ...Array.from({ length: 7 }, (_, index) => ({ index })),
    ...Array.from({ length: 10 }, (_, areaIndex) => ({ level: "area" as const, areaId: "wohnzimmer", areaIndex })),
    { level: "detail", detailId: "light.wz_decke", areaId: "wohnzimmer" },
    { level: "detail", detailId: "cover.wz_links", areaId: "wohnzimmer" },
    { level: "detail", detailId: "group:wohnzimmer:cover", areaId: "wohnzimmer" },
  ];

  it("list column, state column, header and footer stay inside their widths in de and en", () => {
    for (const report of [demoReport(), stress()]) {
      for (const locale of ["de", "en"] as const) {
        for (const state of states) {
          const v = buildView(home(state, report), locale, T0);
          expect(v.body.length).toBeLessThanOrEqual(MAX_BODY_ROWS);
          for (const row of v.body) expect(row.length, row).toBeLessThanOrEqual(LIST_CHARS);
          expect(v.side?.length ?? 0).toBeLessThanOrEqual(MAX_BODY_ROWS);
          for (const row of v.side ?? []) expect(row.length, row).toBeLessThanOrEqual(SIDE_CHARS);
          expect(v.header.length).toBeLessThanOrEqual(ROW_WIDTH);
          expect(v.footer.length).toBeLessThanOrEqual(ROW_WIDTH);
          expect(v.footer).toMatch(/2× /);
        }
      }
    }
  });

  it("the split page is a valid SDK page: 5 containers, one capture, columns side by side", () => {
    const m = home();
    const page = buildPage(buildView(m, "de", T0), menuFor(m, "de", true));
    expect(page.containerTotalNum).toBe(5);
    expect(validateEvenHubPageContainer(page).valid).toBe(true);
    const body = page.textObject?.find((c) => c.containerName === "body");
    const side = page.textObject?.find((c) => c.containerName === "side");
    expect(body?.isEventCapture).toBe(1);
    expect(side?.isEventCapture).toBe(0);
    expect((body?.xPosition ?? 0) + (body?.width ?? 0)).toBeLessThanOrEqual(SPLIT_X);
    expect(side?.xPosition).toBe(SPLIT_X);
    expect((side?.xPosition ?? 0) + (side?.width ?? 0)).toBeLessThanOrEqual(576);
    // Other pages keep the 4-container layout.
    expect(buildPage(buildView({ ...m, screen: "printer" }, "de", T0), null).containerTotalNum).toBe(4);
  });

  it("a menu entry for details, within the SDK limits", () => {
    const spec = menuFor(home(), "en", true);
    expect(spec.items.map((i) => i.id)).toContain(MENU.detail);
    for (const item of spec.items) expect(new TextEncoder().encode(item.label).length).toBeLessThanOrEqual(32);
  });

  it("a change in the state column alone is redrawn (and only that container)", async () => {
    const calls: string[] = [];
    const bridge = {
      textContainerUpgrade: async (c: { containerName?: string }) => { calls.push(c.containerName ?? ""); return true; },
      updateImageRawData: async () => "success",
      rebuildPageContainer: async () => true,
      createStartUpPageContainer: async () => 0,
    } as unknown as EvenAppBridge;
    const { rebuildPage } = await import("../src/glasses/render");
    const a = buildView(home({ index: 4 }), "de", T0);
    await rebuildPage(bridge, a, ["#"], menuFor(home(), "de", true));
    const b = { ...a, side: ["anders"] };
    expect(sameView(a, b)).toBe(false);
    calls.length = 0;
    await updatePage(bridge, b, ["#"], a);
    expect(calls).toEqual(["side"]);
  });
});
