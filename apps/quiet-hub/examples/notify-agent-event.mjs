#!/usr/bin/env node
/**
 * Cross-platform completion hook (Windows, macOS, Linux) for Claude Code,
 * Codex and anything else that can run a command.
 *
 *   HUB_TOKEN=... QUIET_HUB_URL=https://hub node notify-agent-event.mjs claude-win done "Tests finished" "42 passed"
 */
const [provider, status, title, detail = ""] = process.argv.slice(2);
const hub = (process.env.QUIET_HUB_URL ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
if (!provider || !status || !title) {
  console.error("usage: notify-agent-event.mjs <provider> <done|waiting|error> <title> [detail]");
  process.exit(2);
}
if (!process.env.HUB_TOKEN) { console.error("HUB_TOKEN is required"); process.exit(2); }
try {
  const res = await fetch(`${hub}/events`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.HUB_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ provider, status, title, detail }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) { console.error(`hub answered HTTP ${res.status}`); process.exit(1); }
} catch (error) {
  console.error(`hub unreachable: ${error.message}`);
  process.exit(1);
}
