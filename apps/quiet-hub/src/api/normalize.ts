import type { AgentInfo, HubReport } from "./types";

/**
 * Older daemons only know the single `agent` snapshot. Fill in `agents` and
 * `approvals` so the rest of the app can rely on them being present.
 */
export function normalizeReport(raw: HubReport): HubReport {
  const legacy: AgentInfo = {
    id: raw.agent.provider.toLowerCase(),
    label: raw.agent.provider,
    kind: "hermes",
    machine: "",
    online: raw.connection !== "missing" && raw.connection !== "error",
    busy: raw.agent.busy,
    mode: "auto",
    activity: "",
    error: null,
    answer: raw.agent.answer,
    lastQuestion: null,
    suggestions: raw.agent.suggestions,
  };
  return {
    ...raw,
    agents: Array.isArray(raw.agents) ? raw.agents : [legacy],
    approvals: Array.isArray(raw.approvals) ? raw.approvals : [],
  };
}
