/**
 * Demo data: the hub with everything a quiet evening looks like.
 *
 * The demo shapes the real payload — what the daemon returns is the same
 * `HubReport`, so the screenshots show what connected glasses will show.
 * Localized like the rest of the app: the demo must speak both languages,
 * or the English screenshots would show German content.
 */
import type { Locale } from "../i18n";
import type { AgentInfo, HubApi, HubReport } from "./types";

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

function demoAgents(strings: DemoStrings): AgentInfo[] {
  const base = { error: null, activity: "", lastQuestion: null, suggestions: [] as string[], busy: false };
  return [
    { ...base, id: "hermes-spark", label: "hermes-spark", kind: "hermes", machine: "spark", online: true, mode: "auto",
      answer: strings.answers[strings.questions[0] ?? ""] ?? null, suggestions: [...strings.suggestions] },
    { ...base, id: "claude-win", label: "claude-win", kind: "claude", machine: "windows-pc", online: true, mode: "ask", answer: null },
    { ...base, id: "codex-win", label: "codex-win", kind: "codex", machine: "windows-pc", online: false, mode: "ask", answer: null },
  ];
}

export function demoReport(locale: Locale = "de"): HubReport {
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
export function createDemoApi(locale: Locale = "de"): HubApi {
  const strings = STRINGS[locale];
  let report = demoReport(locale);
  const answerFor = (agentId: string, answer: string, question: string): void => {
    report = {
      ...report,
      agents: report.agents.map((a) => a.id === agentId ? { ...a, busy: false, answer, lastQuestion: question } : a),
    };
  };
  return {
    report: async () => report,
    ask: async (question: string, agentId = "hermes-spark") => {
      answerFor(agentId, strings.answers[question] ?? strings.fallback, question);
    },
    voice: async (_wav, agentId = "hermes-spark") => {
      const question = strings.questions[1] ?? "";
      answerFor(agentId, strings.answers[question] ?? strings.fallback, question);
      return { question };
    },
    approve: async (cardId) => {
      report = { ...report, approvals: report.approvals.filter((card) => card.id !== cardId) };
    },
    cancel: async (agentId) => {
      report = { ...report, agents: report.agents.map((a) => a.id === agentId ? { ...a, busy: false } : a) };
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
