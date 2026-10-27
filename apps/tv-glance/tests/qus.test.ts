import { describe, expect, it } from "vitest";
import { cockpitModel, headline } from "../src/cockpit/model";
import { cellBoxes, composeCockpit, modelKey } from "../src/cockpit/compose";
import { frameKey } from "../src/screen/frame";
import { pixelBackend } from "../src/screen/text";
import { armedFooter, footer } from "../src/glasses/footer";
import { HEADER_WIDTH, ROW_WIDTH, VISIBLE_ROWS, appsItems, appsView, dpadView, startRows, startView, windowStart, type ViewState } from "../src/glasses/views";
import { locales, type Locale } from "../src/i18n";
import { messages, t } from "../src/messages";
import { DEMO_SOURCES } from "../src/tv/demo";
import { UNKNOWN_STATE, type TvState } from "../src/tv/model";
import { EMPTY_SETTINGS, isConfigured, maskToken, parseSettings } from "../src/storage/persist";
import { TABS, bannerFor, corsInner, nowInner, pillOf, setupInner, tvInner } from "../src/ui/phone";

// QUS v1: the pure parts - start page, lists, footers, cockpit model and frame, phone view models, i18n.
const NOW = new Date(2026, 9, 25, 20, 15).getTime();
const backend = pixelBackend();

const TV: TvState = {
  name: "Living Room TV", power: "on", activity: "playing", app: "Netflix", title: "The Crown", source: "Netflix",
  volume: 23, muted: false, sources: [...DEMO_SOURCES], apps: [],
};

function state(over: Partial<ViewState> = {}): ViewState {
  return {
    locale: "de", demo: false, connection: { kind: "ok" }, tv: TV, dpad: true,
    entries: TV.sources.map((s) => ({ label: s, id: s })), pendingVolume: 0, flash: null, armed: false, now: NOW,
    ...over,
  };
}

const LONG: TvState = { ...TV, app: "A Very Long Streaming Application Name That Goes On", title: "An Extremely Long Episode Title With Many Words In It", source: "HDMI 1 (Game Console In The Living Room)" };

describe("start page", () => {
  it("has at most three entries; the D-pad only when the backend can send it", () => {
    expect(startRows({ dpad: true })).toEqual(["remote", "apps", "dpad"]);
    expect(startRows({ dpad: false })).toEqual(["remote", "apps"]);
    expect(startView(state({ dpad: false }), 0).body).toHaveLength(2);
  });

  it("header, rows and footer in German", () => {
    const view = startView(state(), 0);
    expect(view.header).toBe("TV Glance · ● live");
    expect(view.body).toEqual(["● Fernbedienung · an · Netflix · 23", "  Apps & Eingang", "  Steuerkreuz"]);
    expect(view.footer).toBe("Tippen = öffnen · Wischen = wählen · 2× = Ende");
  });

  it("English, demo, offline, muted and off", () => {
    const en = startView(state({ locale: "en", demo: true }), 1);
    expect(en.header).toBe("TV Glance · DEMO");
    expect(en.body).toContain("● Apps & input");
    expect(en.body).toContain("DEMO · set up your TV on the phone");
    expect(en.footer).toBe("Tap = open · Swipe = choose · 2× = exit");
    expect(startView(state({ connection: { kind: "error", code: "unreachable" }, tv: null }), 0).header).toBe("TV Glance · offline");
    expect(startView(state({ connection: { kind: "error", code: "unreachable" }, tv: null }), 0).body[0]).toBe("● Fernbedienung · nicht erreichbar");
    expect(startView(state({ tv: { ...TV, muted: true } }), 0).body[0]).toBe("● Fernbedienung · an · Netflix · stumm");
    expect(startView(state({ tv: { ...TV, power: "off" } }), 0).body[0]).toBe("● Fernbedienung · aus");
  });

  it("the shown volume includes the swipes still on their way", () => {
    expect(startView(state({ pendingVolume: 3 }), 0).body[0]).toBe("● Fernbedienung · an · Netflix · 26");
    expect(startView(state({ pendingVolume: -50 }), 0).body[0]).toBe("● Fernbedienung · an · Netflix · 0");
  });
});

describe("lists", () => {
  it("apps & input: power first, mute only while on, then the sources; at most five rows in view", () => {
    expect(appsItems(state()).map((i) => i.kind)).toEqual(["power", "mute", "launch", "launch", "launch", "launch", "launch"]);
    expect(appsItems(state({ tv: { ...TV, power: "off" } })).map((i) => i.kind)).toEqual(["power", "launch", "launch", "launch", "launch", "launch"]);
    const view = appsView(state(), 6);
    expect(view.body.filter((row) => row.startsWith("● ") || row.startsWith("  "))).toHaveLength(VISIBLE_ROWS);
    expect(view.body).toContain("● Live TV");
    expect(windowStart(7, 0)).toBe(0);
    expect(windowStart(7, 3)).toBe(1);
    expect(windowStart(7, 6)).toBe(2);
  });

  it("an empty app list says where to add one", () => {
    expect(appsView(state({ entries: [] }), 0).body).toContain("Keine Apps · Liste am Handy anlegen");
  });

  it("the armed switch-off shows its own row and footer", () => {
    const view = appsView(state({ armed: true }), 0);
    expect(view.body).toContain("Ausschalten? Nochmal tippen (4 s)");
    expect(view.footer).toBe("Nochmal tippen = ausschalten · Wischen/2× = abbrechen");
    expect(appsView(state({ armed: true, locale: "en" }), 0).footer).toBe("Tap again = switch off · Swipe/2× = cancel");
  });

  it("the D-pad list in both languages", () => {
    expect(dpadView(state(), 0).body.slice(0, 5)).toEqual(["● Hoch", "  Runter", "  Links", "  Rechts", "  OK"]);
    expect(dpadView(state({ locale: "en" }), 6).body).toContain("● Home");
    expect(dpadView(state(), 0).footer).toBe("Tippen = senden · Wischen = wählen · 2× = zurück");
  });

  it("every view fits the rows with worst-case content, in both languages, and never offers Hold", () => {
    for (const locale of locales) {
      for (const tv of [TV, LONG, { ...TV, power: "off" as const }, null]) {
        const s = state({ locale, tv, flash: t(locale, "g.failed", { reason: t(locale, "g.err.missing") }), entries: [{ label: "A Really Long App Label Here Too", id: "x" }] });
        for (const view of [startView(s, 0), appsView(s, 0), appsView({ ...s, armed: true }, 0), dpadView(s, 3)]) {
          expect(view.header.length, view.header).toBeLessThanOrEqual(HEADER_WIDTH);
          expect(view.footer.length, view.footer).toBeLessThanOrEqual(ROW_WIDTH);
          for (const row of view.body) expect(row.length, row).toBeLessThanOrEqual(ROW_WIDTH);
          expect(view.body.length).toBeLessThanOrEqual(7);
          expect(view.footer + view.body.join("")).not.toMatch(/Halten|Hold/);
        }
      }
    }
  });

  it("the footer helper has no hold at all", () => {
    expect(footer("de", { tap: "x", swipe: "y" }, "back")).toBe("Tippen = x · Wischen = y · 2× = zurück");
    expect(armedFooter("de", "ausschalten")).not.toMatch(/Halten/);
    expect(JSON.stringify(messages)).not.toMatch(/Halten =|Hold =/);
  });
});

describe("remote cockpit", () => {
  it("headline: the app big, the title below; off says AUS and the name", () => {
    expect(headline(state())).toEqual(["NETFLIX", "THE CROWN"]);
    expect(headline(state({ tv: { ...TV, title: null, activity: "paused" } }))).toEqual(["NETFLIX", "PAUSE"]);
    expect(headline(state({ tv: { ...TV, power: "off" } }))).toEqual(["AUS", "LIVING ROOM TV"]);
    expect(headline(state({ tv: null, connection: { kind: "loading" } }))).toEqual(["–", "VERBINDE …"]);
    expect(headline(state({ tv: null, connection: { kind: "error", code: "auth" } }))).toEqual(["–", "KEINE VERBINDUNG"]);
  });

  it("cells: state, sound, source; the graphic is the TV with the volume bar", () => {
    const model = cockpitModel(state());
    expect(model.cells.map((c) => c.label)).toEqual(["Status", "Ton", "Quelle"]);
    expect(model.cells.map((c) => c.value)).toEqual(["SPIELT", "23", "Netflix"]);
    expect(cellBoxes(model.cells).length).toBeLessThanOrEqual(6);
    expect(model.graphic).toMatchObject({ kind: "tv", screen: "playing", volume: 23, muted: false, volumeLabel: "LAUTSTÄRKE", volumeText: "23" });
    expect(cockpitModel(state({ tv: { ...TV, muted: true } })).cells[1]).toMatchObject({ value: "STUMM", alert: true });
    expect(cockpitModel(state({ tv: { ...TV, power: "off" } })).graphic).toMatchObject({ screen: "off", volume: null });
    expect(cockpitModel(state({ tv: null })).graphic).toMatchObject({ screen: "unknown" });
    expect(cockpitModel(state({ pendingVolume: 2 })).graphic).toMatchObject({ volume: 25, volumeText: "25" });
  });

  it("hint: play/pause and volume, or switch on while off; 2x back; never Hold", () => {
    expect(cockpitModel(state()).hint).toBe("Tippen = Play/Pause · Wischen = Lautstärke · 2× = zurück");
    expect(cockpitModel(state({ tv: { ...TV, power: "off" } })).hint).toBe("Tippen = TV an · Wischen = Lautstärke · 2× = zurück");
    expect(cockpitModel(state({ locale: "en" })).hint).toBe("Tap = play/pause · Swipe = volume · 2× = back");
    expect(cockpitModel(state({ flash: "→ YouTube" })).hint).toBe("→ YouTube · Tippen = Play/Pause · Wischen = Lautstärke · 2× = zurück");
  });

  it("demo is labelled in the title and caption", () => {
    const model = cockpitModel(state({ demo: true }));
    expect(model.title).toBe("TV Glance · DEMO");
    expect(model.caption).toBe("DEMO");
  });

  it("draws every state to a non-empty, repeatable frame; a volume change changes the frame", () => {
    for (const s of [state(), state({ tv: { ...TV, power: "off" } }), state({ tv: { ...TV, activity: "paused" } }), state({ tv: { ...TV, activity: "idle", muted: true } }), state({ tv: null }), state({ tv: LONG, locale: "en" })]) {
      const frame = composeCockpit(cockpitModel(s), backend);
      expect(frame.pixels.some((level) => level > 0)).toBe(true);
      expect(frameKey(composeCockpit(cockpitModel(s), backend))).toBe(frameKey(frame));
    }
    const a = composeCockpit(cockpitModel(state()), backend);
    const b = composeCockpit(cockpitModel(state({ pendingVolume: 10 })), backend);
    expect(frameKey(a)).not.toBe(frameKey(b));
    expect(modelKey(cockpitModel(state()))).not.toBe(modelKey(cockpitModel(state({ pendingVolume: 10 }))));
  });
});

describe("phone view models", () => {
  const ha = parseSettings(JSON.stringify({ backend: "ha", haUrl: "https://ha.example:8123", haToken: "abc", entityId: "media_player.tv", remoteId: "remote.tv" }));

  it("exactly three tabs", () => {
    expect(TABS.map((tab) => tab.id)).toEqual(["now", "tv", "settings"]);
  });

  it("banner and pill follow the connection", () => {
    expect(bannerFor(state(), { kind: "demo" }, EMPTY_SETTINGS).text).toContain("DEMO");
    expect(bannerFor(state(), { kind: "error", reason: "Fehler (HTTP 503)" }, ha).text).toBe("Fernseher nicht erreichbar: Fehler (HTTP 503)");
    expect(bannerFor(state({ tv: { ...TV, power: "off" } }), { kind: "ok" }, ha).text).toBe("Verbunden – der Fernseher ist aus.");
    expect(bannerFor(state(), { kind: "demo" }, { ...ha, devices: [] }).tone).toBe("warn");
    expect(pillOf(state(), { kind: "ok" })).toEqual({ text: "an", on: true });
    expect(pillOf(state(), { kind: "demo" }).text).toBe("DEMO");
  });

  it("Jetzt shows what runs, the volume and the backend", () => {
    const html = nowInner(state(), { kind: "ok" }, ha);
    expect(html).toContain("Netflix");
    expect(html).toContain("The Crown");
    expect(html).toContain("<b>23</b>");
    expect(html).toContain("Home Assistant");
  });

  it("Fernseher: the picker only for Home Assistant, the remote choice, the app list", () => {
    const html = tvInner(ha, "de", { players: [{ id: "media_player.tv", name: "Wohnzimmer", state: "on" }], remotes: [{ id: "remote.tv", name: "Wohnzimmer", state: "on" }] }, "");
    expect(html).toContain('data-player="media_player.tv"');
    expect(html).toContain('<option value="remote.tv" selected>');
    expect(html).toContain('id="apps"');
    expect(tvInner({ ...ha, backend: "bridge" }, "de", null, "")).toContain("nur mit Home Assistant");
  });

  it("the CORS note shows the real origin and never a made-up one", () => {
    expect(corsInner("http://127.0.0.1:41234", "en")).toContain("    - http://127.0.0.1:41234");
    expect(corsInner("", "de")).toContain("Herkunft unbekannt");
    expect(corsInner("null", "de")).toContain("Herkunft unbekannt");
  });

  it("setup checklist, settings parsing and token masking", () => {
    expect(setupInner(EMPTY_SETTINGS, false, "de")).toContain("Verbindung wählen");
    expect(isConfigured(EMPTY_SETTINGS)).toBe(false);
    expect(isConfigured(ha)).toBe(true);
    expect(isConfigured({ ...ha, haToken: undefined } as never)).toBe(false);
    expect(isConfigured(parseSettings(JSON.stringify({ backend: "bridge", bridgeUrl: "http://192.168.1.20:8477" })))).toBe(true);
    expect(parseSettings(JSON.stringify({ backend: "ha", haUrl: "not a url", entityId: "light.x", remoteId: "x" }))).toMatchObject({ haUrl: "", devices: [] });
    expect(parseSettings("{broken")).toEqual(EMPTY_SETTINGS);
    expect(maskToken("abcdef", "de")).toBe("gesetzt (6 Zeichen)");
    expect(maskToken(undefined, "en")).toBe("none");
  });
});

describe("i18n", () => {
  it("German and English have the same keys and no empty text", () => {
    const de = Object.keys(messages.de).sort();
    const en = Object.keys(messages.en).sort();
    expect(de).toEqual(en);
    for (const locale of locales as readonly Locale[]) for (const [key, value] of Object.entries(messages[locale])) expect(value.trim(), key).not.toBe("");
  });

  it("every glasses error code has a text", () => {
    for (const code of ["timeout", "unreachable", "auth", "http", "bad-reply", "missing", "unsupported"]) {
      for (const locale of locales) expect(t(locale, "g.err." + code)).not.toBe("g.err." + code);
    }
  });

  it("an unknown key falls back to English, then to the key", () => {
    expect(t("de", "nope.nope")).toBe("nope.nope");
    expect(UNKNOWN_STATE.power).toBe("unknown");
  });
});
