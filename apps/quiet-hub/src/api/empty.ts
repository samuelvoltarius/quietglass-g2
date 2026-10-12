import type { ConnectionState, HubReport } from "./types";

/**
 * What the app knows before the first real /report: nothing. Deliberately no
 * agents, devices or jobs - invented data on the glasses is worse than a blank
 * page that says why (demo data only exists behind ?demo=1).
 */
export function emptyReport(connection: ConnectionState = "missing"): HubReport {
  return {
    connection,
    agent: { provider: "", questions: [], selected: 0, answer: null, busy: false, suggestions: [] },
    agents: [],
    approvals: [],
    home: { devices: [], selected: 0 },
    printer: { job: null, state: "ready", layer: 0, layers: 0, etaMin: null, nozzleC: 0, bedC: 0, selected: 0 },
    inbox: { events: [], selected: 0 },
  };
}
