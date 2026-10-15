/**
 * Demo data: the hub with everything a quiet evening looks like.
 *
 * The demo shapes the real payload — what the daemon returns is the same
 * `HubReport`, so the screenshots show what connected glasses will show.
 * Localized like the rest of the app: the demo must speak both languages,
 * or the English screenshots would show German content.
 */
import type { Locale } from "../i18n";
import type { AgentInfo, Brief, HomeEntity, HomeView, HubApi, HubReport, SessionInfo } from "./types";
import { applyHomeAction } from "../hub/zuhause";

interface DemoDevice {
  readonly id: string;
  readonly label: string;
  readonly kind: "switch" | "climate" | "cover";
  readonly state: string;
  readonly on: boolean;
  readonly writable: boolean;
}

interface DemoStrings {
  readonly questions: readonly string[];
  readonly answers: Record<string, string>;
  /** Follow-up suggestions shown after an answer. */
  readonly suggestions: readonly string[];
  readonly devices: readonly DemoDevice[];
  readonly fallback: string;
}

const STRINGS: Record<Locale, DemoStrings> = {
  de: {
    questions: ["Drucker fertig?", "Was steht heute an?", "Licht im Büro aus"],
    answers: {
      "Drucker fertig?": "Nein, noch 41 Minuten — Schicht 148 von 205.",
      "Was steht heute an?": "14:00 Schnitt-Review mit Sarah, 17:30 RAM-Einbau im Server.",
      "Licht im Büro aus": "Erledigt — Büro ist jetzt dunkel.",
    },
    suggestions: ["Mehr Details", "Kurzfassung", "Als Liste"],
    fallback: "Dazu habe ich nichts gespeichert.",
    devices: [
      { id: "light_office", label: "Büro · Licht", kind: "switch", state: "an", on: true, writable: true },
      { id: "light_living", label: "Wohnzimmer · Licht", kind: "switch", state: "aus", on: false, writable: true },
      { id: "heat_kitchen", label: "Heizung · Küche", kind: "climate", state: "21,5°", on: true, writable: true },
      { id: "shade_office", label: "Jalousie · Büro", kind: "cover", state: "offen", on: false, writable: true },
      { id: "plug_printer", label: "Steckdose · Drucker", kind: "switch", state: "an", on: true, writable: true },
    ],
  },
  en: {
    questions: ["Printer done?", "What's on today?", "Office lights off"],
    answers: {
      "Printer done?": "No, 41 minutes left — layer 148 of 205.",
      "What's on today?": "14:00 edit review with Sarah, 17:30 RAM upgrade in the server.",
      "Office lights off": "Done — the office is dark now.",
    },
    suggestions: ["More detail", "Short version", "As a list"],
    fallback: "Nothing saved on that one.",
    devices: [
      { id: "light_office", label: "Office · Light", kind: "switch", state: "on", on: true, writable: true },
      { id: "light_living", label: "Living room · Light", kind: "switch", state: "off", on: false, writable: true },
      { id: "heat_kitchen", label: "Heating · Kitchen", kind: "climate", state: "21.5°", on: true, writable: true },
      { id: "shade_office", label: "Blinds · Office", kind: "cover", state: "open", on: false, writable: true },
      { id: "plug_printer", label: "Plug · Printer", kind: "switch", state: "on", on: true, writable: true },
    ],
  },
};

/** The "Zuhause" view of the demo: favourites, three areas with groups, sensors and a lock (two-step). */
export function demoHomeView(locale: Locale = "de"): HomeView {
  const de = locale === "de";
  const n = (value: number, unit: string): string => `${String(value).replace(".", de ? "," : ".")} ${unit}`;
  const list: HomeEntity[] = [
    { id: "scene.abend", name: de ? "Abendlicht" : "Evening light", kind: "scene", state: "scening", on: false, available: true },
    { id: "light.buero", name: de ? "Büro Decke" : "Office ceiling", kind: "light", state: "on", on: true, available: true, brightness: 60 },
    { id: "lock.haustuer", name: de ? "Haustür" : "Front door", kind: "lock", state: "locked", on: false, available: true, sensitive: true },
    { id: "sensor.aussen", name: de ? "Außen" : "Outside", kind: "sensor", state: "8.5", on: false, available: true, sensorClass: "temperature", value: n(8.5, "°C") },
    { id: "light.wz_decke", name: de ? "Decke" : "Ceiling", kind: "light", state: "on", on: true, available: true, brightness: 80 },
    { id: "light.wz_lampe", name: de ? "Stehlampe" : "Floor lamp", kind: "light", state: "off", on: false, available: true, brightness: 0 },
    { id: "light.wz_regal", name: de ? "Regal" : "Shelf", kind: "light", state: "off", on: false, available: true, brightness: 0 },
    { id: "cover.wz_links", name: de ? "Rollo links" : "Blind left", kind: "cover", state: "open", on: true, available: true, position: 100 },
    { id: "cover.wz_rechts", name: de ? "Rollo rechts" : "Blind right", kind: "cover", state: "closed", on: false, available: true, position: 0 },
    { id: "sensor.wz_temp", name: de ? "Temperatur" : "Temperature", kind: "sensor", state: "21.5", on: false, available: true, sensorClass: "temperature", value: n(21.5, "°C") },
    { id: "sensor.wz_hum", name: de ? "Feuchte" : "Humidity", kind: "sensor", state: "48", on: false, available: true, sensorClass: "humidity", value: "48 %" },
    { id: "binary_sensor.wz_motion", name: de ? "Bewegung" : "Motion", kind: "motion", state: "on", on: true, available: true },
    { id: "switch.drucker", name: de ? "Drucker" : "Printer", kind: "switch", state: "on", on: true, available: true },
    { id: "sensor.buero_batt", name: de ? "Fensterkontakt Akku" : "Window sensor battery", kind: "sensor", state: "14", on: false, available: true, sensorClass: "battery", value: "14 %" },
    { id: "light.sz", name: de ? "Nachtlicht" : "Night light", kind: "light", state: "off", on: false, available: true, brightness: 0 },
    { id: "cover.sz", name: de ? "Rollo" : "Blind", kind: "cover", state: "closed", on: false, available: true, position: 0 },
    { id: "group:wohnzimmer:light", name: "*lights", kind: "light", state: "1/3", on: true, available: true, group: true, members: ["light.wz_decke", "light.wz_lampe", "light.wz_regal"] },
    { id: "group:wohnzimmer:cover", name: "*covers", kind: "cover", state: "1/2", on: true, available: true, group: true, members: ["cover.wz_links", "cover.wz_rechts"] },
  ];
  return {
    favorites: ["scene.abend", "light.buero", "lock.haustuer", "sensor.aussen"],
    areas: [
      { id: "wohnzimmer", name: de ? "Wohnzimmer" : "Living room", entities: ["group:wohnzimmer:light", "group:wohnzimmer:cover", "light.wz_decke", "light.wz_lampe", "light.wz_regal", "cover.wz_links", "cover.wz_rechts", "sensor.wz_temp", "sensor.wz_hum", "binary_sensor.wz_motion"] },
      { id: "buero", name: de ? "Büro" : "Office", entities: ["light.buero", "switch.drucker", "sensor.buero_batt"] },
      { id: "schlafzimmer", name: de ? "Schlafzimmer" : "Bedroom", entities: ["light.sz", "cover.sz"] },
    ],
    entities: Object.fromEntries(list.map((entity) => [entity.id, entity])),
    sensitive: true,
  };
}

function demoAgents(strings: DemoStrings): AgentInfo[] {
  const base = { error: null, activity: "", lastQuestion: null, suggestions: [] as string[], busy: false };
  return [
    { ...base, id: "hermes-spark", label: "hermes-spark", kind: "hermes", machine: "spark", online: true, mode: "auto",
      answer: strings.answers[strings.questions[0] ?? ""] ?? null, suggestions: [...strings.suggestions] },
    { ...base, id: "claude-win", label: "claude-win", kind: "claude", machine: "windows-pc", online: true, mode: "ask", answer: null },
    { ...base, id: "codex-win", label: "codex-win", kind: "codex", machine: "windows-pc", online: false, mode: "ask", answer: null },
  ];
}

/** Screenshot scenes: `?demo=1&scene=card|busy|long|empty|alerts`. */
export type DemoScene = "default" | "card" | "busy" | "long" | "empty" | "alerts";
export const DEMO_SCENES: readonly DemoScene[] = ["default", "card", "busy", "long", "empty", "alerts"];

export function demoReport(locale: Locale = "de", scene: DemoScene = "default"): HubReport {
  const report = baseDemoReport(locale);
  const de = locale === "de";
  const patchAgent = (id: string, patch: Partial<AgentInfo>) => report.agents.map((a) => (a.id === id ? { ...a, ...patch } : a));
  if (scene === "card") {
    return { ...report, agents: patchAgent("claude-win", { busy: true, activity: "Bash: npm test" }), approvals: [{
      id: "card-1", agentId: "claude-win", tool: "Bash", title: "Bash: npm test -- --run src/hub", detail: "npm test -- --run src/hub",
      createdAt: new Date(0).toISOString(), expiresAt: Date.now() + 120_000,
      ...(() => {
        const options = de
          ? [{ text: "Ja, nur src/hub testen", decision: "allow" as const }, { text: "Erst tsc laufen lassen", decision: "deny" as const }, { text: "Zeig erst den Diff", decision: "deny" as const }]
          : [{ text: "Yes, only src/hub", decision: "allow" as const }, { text: "Run tsc first", decision: "deny" as const }, { text: "Show me the diff first", decision: "deny" as const }];
        return { options, suggestions: options.map((option) => option.text) };
      })(),
    }] };
  }
  if (scene === "busy") {
    return { ...report, agents: patchAgent("claude-win", { busy: true, busySince: Date.now() - 23_000, activity: "Edit: src/hub/model.ts", lastQuestion: de ? "Baue das Menü" : "Build the menu", answer: de ? "Ich lese zuerst model.ts und passe dann die Menüaktionen an." : "I read model.ts first and then adapt the menu actions." }) };
  }
  if (scene === "long") {
    const text = de
      ? "Das Release 0.5.0 bringt eine klarere Übersicht mit Statuszeile, ein natives Kontextmenü pro Seite, die Sitzungsauswahl für jeden Agenten und eine Bestätigung nach der Spracheingabe. Lange Antworten werden in Seiten geteilt: wischen blättert, am Ende folgen die Fragen. Werkzeugaufrufe erscheinen als eine Zeile. Freigaben zeigen Werkzeug und Befehl und werden in einer Liste gewählt und mit zweitem Tippen gesendet. Der Ring öffnet mit 2× die Seitenwahl."
      : "Release 0.5.0 brings a clearer overview with a status line, a native contextual menu per page, a session picker for every agent and a confirmation after voice input. Long answers are split into pages: swiping turns the page, the questions follow at the end. Tool calls show as one line. Approvals show tool and command and are chosen in a list and sent with a second tap. The ring opens the page picker with 2×.";
    return { ...report, agents: patchAgent("hermes-spark", { answer: text, lastQuestion: de ? "Was ist neu?" : "What is new?" }) };
  }
  if (scene === "empty") {
    const { homeView: _none, ...rest } = report;
    void _none;
    return { ...rest, agents: [], agent: { ...report.agent, provider: "Hermes", suggestions: [] }, home: { selected: 0, devices: [] }, printer: { ...report.printer, job: null, state: "ready", progress: 0 }, inbox: { selected: 0, events: [] } };
  }
  if (scene === "alerts") {
    const mk = (id: string, provider: string, status: "done" | "waiting" | "error", title: string, detail: string | null, read: boolean) => ({ id, provider, status, title, detail, createdAt: new Date(0).toISOString(), read, agentId: provider, sessionId: `s-${id}` });
    return { ...report, inbox: { selected: 0, events: [
      mk("a1", "claude-win", "error", de ? "Build fehlgeschlagen" : "Build failed", de ? "tsc: 2 Fehler in model.ts" : "tsc: 2 errors in model.ts", false),
      mk("a2", "codex-win", "done", de ? "Repository-Check fertig" : "Repository check complete", de ? "Tests bestanden" : "Tests passed", false),
      mk("a3", "hermes-spark", "waiting", de ? "Freigabe: Bash: ls" : "Approval: Bash: ls", null, true),
    ] } };
  }
  return report;
}

/** A morning briefing with every block filled (clock times relative to `now`, so it always looks current). */
export function demoBrief(locale: Locale = "de", now = Date.now()): Brief {
  const de = locale === "de";
  const at = (h: number, m = 0): number => { const d = new Date(now); d.setHours(h, m, 0, 0); return d.getTime(); };
  const hhmm = (ms: number): string => new Date(ms).toLocaleTimeString("de-AT", { hour: "2-digit", minute: "2-digit" });
  const event = (title: string, h: number, m: number, minutes: number) => ({ title, allDay: false, startMs: at(h, m), endMs: at(h, m) + minutes * 60_000, start: hhmm(at(h, m)), end: hhmm(at(h, m) + minutes * 60_000) });
  const day = new Date(now);
  return {
    at: now,
    date: `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`,
    calendar: {
      status: "ok",
      total: 4,
      events: [
        { title: de ? "Geburtstag Lena" : "Lena's birthday", allDay: true, startMs: at(0), endMs: at(23, 59), start: "", end: "" },
        event(de ? "Stand-up" : "Stand-up", 9, 0, 15),
        event(de ? "Zahnarzt" : "Dentist", 11, 30, 45),
        event(de ? "Probe Band" : "Band rehearsal", 19, 0, 120),
      ],
    },
    weather: { status: "ok", place: "here", appts: [{ time: "10:30", label: "Musterdorf", tempC: 9, code: 61, pop: 60, mm: 0.8, windKmh: 12 }], tempC: 9, code: 3, minC: 6, maxC: 15, rain: { kind: "later", from: "14:00", until: "16:30", mm: 2.4 } },
    sugar: { status: "ok", current: { mgdl: 118, direction: "Flat", ageMin: 3 }, night: { min: 84, max: 192, belowMin: 0, aboveMin: 25, count: 108 }, low: 70, high: 180 },
    car: { status: "ok", soc: 78, rangeKm: 296, charging: false, chargeDone: true, etaMin: null, locked: true },
    printer: { status: "ok", state: "printing", file: "esp32_gehaeuse", progress: 72, minutesLeft: 41 },
    servers: { status: "ok", machines: [{ name: "Pi", ok: true, newDevices: 0 }, { name: "NAS", ok: true, newDevices: 1 }, { name: "Spark", ok: true, newDevices: 0 }], down: 0, newDevices: 1 },
  };
}

function baseDemoReport(locale: Locale): HubReport {
  const strings = STRINGS[locale];
  const agents = demoAgents(strings);
  return {
    connection: "demo",
    agent: {
      provider: "hermes-spark",
      questions: strings.questions,
      selected: 0,
      answer: agents[0]?.answer ?? null,
      busy: false,
      suggestions: strings.suggestions,
    },
    agents,
    approvals: [],
    home: {
      selected: 0,
      devices: strings.devices,
    },
    homeView: demoHomeView(locale),
    brief: demoBrief(locale),
    printer: {
      job: "esp32_gehaeuse.stl",
      state: "printing",
      layer: 148,
      layers: 205,
      progress: 72,
      etaMin: 41,
      nozzleC: 210,
      bedC: 60,
      selected: 0,
    },
    inbox: {
      selected: 0,
      events: [
        {
          id: "demo-codex-1",
          provider: "Codex",
          status: "done",
          title: locale === "de" ? "Repository-Check fertig" : "Repository check complete",
          detail: locale === "de" ? "Tests bestanden" : "Tests passed",
          createdAt: new Date(0).toISOString(),
          read: false,
        },
      ],
    },
  };
}

/** A demo api whose state moves: asking answers, toggles flip. */
export function createDemoApi(locale: Locale = "de", scene: DemoScene = "default", finishAfterMs: number | null = null): HubApi {
  const strings = STRINGS[locale];
  let report = demoReport(locale, scene);
  let pendingConfirm: { token: string; target: string } | null = null;
  // `?finish=<s>`: the busy demo agents finish on their own (quiet mode screenshots).
  const finishAt = finishAfterMs === null ? null : Date.now() + finishAfterMs;
  const answerFor = (agentId: string, answer: string, question: string): void => {
    report = {
      ...report,
      agents: report.agents.map((a) => a.id === agentId ? { ...a, busy: false, answer, lastQuestion: question } : a),
    };
  };
  return {
    brief: async () => {
      const next = demoBrief(locale);
      report = { ...report, brief: next };
      return next;
    },
    report: async () => {
      if (finishAt !== null && Date.now() >= finishAt) {
        for (const agent of report.agents.filter((entry) => entry.busy)) answerFor(agent.id, strings.fallback, agent.lastQuestion ?? "");
      }
      return report;
    },
    ask: async (question: string, agentId = "hermes-spark") => {
      answerFor(agentId, strings.answers[question] ?? strings.fallback, question);
    },
    voice: async (_wav, agentId = "hermes-spark", ask = true) => {
      const question = strings.questions[1] ?? "";
      if (!ask) return { question, asked: false };
      answerFor(agentId, strings.answers[question] ?? strings.fallback, question);
      return { question, asked: true };
    },
    approve: async (cardId) => {
      report = { ...report, approvals: report.approvals.filter((card) => card.id !== cardId) };
    },
    cancel: async (agentId) => {
      report = { ...report, agents: report.agents.map((a) => a.id === agentId ? { ...a, busy: false, stopped: true } : a) };
    },
    sessions: async (agentId) => {
      const current = report.agents.find((a) => a.id === agentId)?.session?.id ?? null;
      const rows: ReadonlyArray<readonly [string, string, string]> = locale === "de"
        ? [["d-1", "Drucker-Check", "10m"], ["d-2", "Wochenplan", "2h"], ["d-3", "Server-RAM", "3d"]]
        : [["d-1", "Printer check", "10m"], ["d-2", "Weekly plan", "2h"], ["d-3", "Server RAM", "3d"]];
      const sessions: SessionInfo[] = rows.map(([id, title, when]) => ({ id, title, when, current: id === current }));
      return { agentId, supported: true, transport: "demo", sessions };
    },
    newSession: async (agentId) => {
      report = { ...report, agents: report.agents.map((a) => a.id === agentId ? { ...a, answer: null, lastQuestion: null, stopped: false, suggestions: [], session: { id: null, title: "" } } : a) };
    },
    selectSession: async (agentId, sessionId, title) => {
      report = { ...report, agents: report.agents.map((a) => a.id === agentId ? { ...a, stopped: false, session: { id: sessionId, title } } : a) };
    },
    toggle: async (deviceId: string) => {
      report = {
        ...report,
        home: {
          ...report.home,
          devices: report.home.devices.map((d) =>
            d.id === deviceId ? { ...d, on: !d.on, state: !d.on ? "an" : "aus" } : d,
          ),
        },
      };
    },
    homeAction: async (target, action, value) => {
      const view = report.homeView;
      const entity = view?.entities[target];
      if (view === undefined || entity === undefined) return { ok: false };
      // Like the daemon: a lock first hands out a token, the second tap moves it.
      if (entity.sensitive === true) {
        const token = `demo-${target}-${Date.now()}`;
        pendingConfirm = { token, target };
        return { ok: true, confirm: { token, label: `${entity.name}: ${entity.on ? (locale === "de" ? "zusperren" : "lock") : (locale === "de" ? "aufsperren" : "unlock")}`, expiresInMs: 30_000 } };
      }
      report = { ...report, homeView: applyHomeAction(view, target, action, value) };
      return { ok: true };
    },
    homeConfirm: async (token) => {
      const view = report.homeView;
      if (pendingConfirm?.token !== token || view === undefined) return;
      const entity = view.entities[pendingConfirm.target];
      pendingConfirm = null;
      if (entity === undefined) return;
      report = { ...report, homeView: { ...view, entities: { ...view.entities, [entity.id]: { ...entity, on: !entity.on, state: entity.on ? "locked" : "unlocked" } } } };
    },
    printer: async (action) => {
      report = {
        ...report,
        printer: {
          ...report.printer,
          state: action === "cancel" ? "ready" : action === "pause" ? "paused" : "printing",
          job: action === "cancel" ? null : report.printer.job,
        },
      };
    },
    readEvent: async (id) => {
      report = {
        ...report,
        inbox: {
          ...report.inbox,
          events: report.inbox.events.map((event) => event.id === id ? { ...event, read: true } : event),
        },
      };
    },
  };
}
