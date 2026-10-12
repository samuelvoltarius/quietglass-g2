#!/usr/bin/env node
/**
 * Quiet Hub approval bridge — a tiny stdio MCP server.
 *
 * The relay starts Claude Code with `--permission-prompt-tool
 * mcp__quiethub__approve`. Every time Claude would ask "may I run/edit this?",
 * it calls the `approve` tool of THIS process. We forward the request to the
 * Quiet Hub daemon (POST /relay/permission), which shows it as a card on the
 * glasses and answers with the wearer's yes/no. No answer in time = deny.
 *
 * Env (set by the relay, never written to disk):
 *   QUIET_HUB_URL, QUIET_HUB_TOKEN, QUIET_HUB_AGENT, QUIET_HUB_APPROVE_TIMEOUT_MS
 *
 * Dependency-free: Node 18+.
 */
import { createInterface } from "node:readline";

const HUB = (process.env.QUIET_HUB_URL ?? "").replace(/\/+$/, "");
const TOKEN = process.env.QUIET_HUB_TOKEN ?? "";
const AGENT = process.env.QUIET_HUB_AGENT ?? "claude";
const TIMEOUT_MS = Number(process.env.QUIET_HUB_APPROVE_TIMEOUT_MS ?? 120_000);

/** One short line describing what is about to happen. */
export function summarize(toolName, input) {
  const i = input && typeof input === "object" ? input : {};
  const pick = i.command ?? i.file_path ?? i.path ?? i.notebook_path ?? i.url ?? i.pattern ?? i.description ?? "";
  const text = typeof pick === "string" ? pick : JSON.stringify(pick);
  return { tool: String(toolName ?? "tool"), summary: text.replace(/\s+/g, " ").trim().slice(0, 140) };
}

export async function decide(args, fetchImpl = globalThis.fetch) {
  const { tool, summary } = summarize(args?.tool_name, args?.input);
  if (HUB === "") return { behavior: "deny", message: "Quiet Hub URL missing" };
  try {
    const res = await fetchImpl(`${HUB}/relay/permission`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ agentId: AGENT, tool, summary, toolUseId: args?.tool_use_id ?? null }),
      signal: AbortSignal.timeout(TIMEOUT_MS + 5_000),
    });
    if (!res.ok) return { behavior: "deny", message: `Quiet Hub HTTP ${res.status}` };
    const data = await res.json();
    if (data.decision === "allow") return { behavior: "allow", updatedInput: args?.input ?? {} };
    return { behavior: "deny", message: "Abgelehnt über die Brille / denied on the glasses" };
  } catch {
    return { behavior: "deny", message: "Quiet Hub nicht erreichbar / unreachable" };
  }
}

const TOOL = {
  name: "approve",
  description: "Ask the wearer of the glasses whether a tool call may run.",
  inputSchema: {
    type: "object",
    properties: {
      tool_name: { type: "string" },
      input: { type: "object", additionalProperties: true },
      tool_use_id: { type: "string" },
    },
    required: ["tool_name", "input"],
  },
};

export function handleMessage(message, reply, fetchImpl) {
  const { id, method, params } = message;
  if (method === "initialize") {
    reply({ jsonrpc: "2.0", id, result: {
      protocolVersion: params?.protocolVersion ?? "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "quiethub", version: "1.0.0" },
    } });
    return Promise.resolve();
  }
  if (method === "tools/list") {
    reply({ jsonrpc: "2.0", id, result: { tools: [TOOL] } });
    return Promise.resolve();
  }
  if (method === "tools/call") {
    return decide(params?.arguments ?? {}, fetchImpl).then((verdict) => {
      reply({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(verdict) }] } });
    });
  }
  if (id !== undefined && method !== undefined && !method.startsWith("notifications/")) {
    reply({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } });
  }
  return Promise.resolve();
}

import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    void handleMessage(message, out);
  });
  rl.on("close", () => process.exit(0));
}
