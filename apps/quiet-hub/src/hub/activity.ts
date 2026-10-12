/**
 * Turns a raw tool line from an agent ("Bash: npm test", "web_search query",
 * "exec: git status", "Edit: src/a.ts") into what a person wants to read on
 * the glasses ("Runs tests · npm test") plus a matching status icon.
 */
import type { Locale } from "../i18n";

export type ActivityKind = "think" | "run" | "test" | "git" | "edit" | "read" | "search" | "web" | "memory" | "agent";

const LABELS: Readonly<Record<Locale, Readonly<Record<ActivityKind, string>>>> = {
  de: {
    think: "Denkt nach", run: "Führt Befehl aus", test: "Führt Tests aus", git: "Arbeitet mit git", edit: "Bearbeitet Datei",
    read: "Liest Datei", search: "Durchsucht Dateien", web: "Sucht im Web", memory: "Durchsucht Gedächtnis", agent: "Arbeitet mit Agent",
  },
  en: {
    think: "Thinking", run: "Running a command", test: "Running tests", git: "Using git", edit: "Editing a file",
    read: "Reading a file", search: "Searching files", web: "Searching the web", memory: "Searching memory", agent: "Working with an agent",
  },
};

/** Tool name → kind; checked in order, first match wins. */
const RULES: ReadonlyArray<readonly [RegExp, ActivityKind]> = [
  [/^(web_?search|websearch|webfetch|web_fetch|browser|browse|fetch_url|brave|google|search_web|navigate)/i, "web"],
  [/^(memory|kg_|knowledge|remember|recall|brain|session_search)/i, "memory"],
  [/^(task|agent|delegate|spawn|subagent|send_message)/i, "agent"],
  [/^(edit|write|multiedit|patch|apply_patch|write_file|str_replace|create_file|notebookedit)/i, "edit"],
  [/^(read|read_file|view|cat|open_file)/i, "read"],
  [/^(grep|glob|search|search_files|find|ls|list_files|code_search)/i, "search"],
  [/^(bash|exec|shell|terminal|run|command|execute|process|powershell)/i, "run"],
];

export interface Activity {
  readonly kind: ActivityKind;
  readonly label: string;
  /** The command, file or query, when there is one. */
  readonly detail: string;
}

export function describeActivity(raw: string, locale: Locale): Activity {
  const text = raw.trim();
  if (text === "") return { kind: "think", label: LABELS[locale].think, detail: "" };
  const match = /^([\w.-]+)\s*:?\s*(.*)$/.exec(text);
  const name = match?.[1] ?? text;
  const detail = (match?.[2] ?? "").trim();
  let kind: ActivityKind | null = null;
  for (const [pattern, k] of RULES) if (pattern.test(name)) { kind = k; break; }
  if (kind === "run" || kind === null) {
    if (/\b(test|vitest|jest|pytest|mocha)\b/i.test(detail)) kind = "test";
    else if (/^git\b/i.test(detail)) kind = "git";
  }
  // Unknown tool: keep its own name, it is still more honest than a guess.
  if (kind === null) return { kind: "run", label: name, detail };
  return { kind, label: LABELS[locale][kind], detail };
}

/** "3 s", "1:05", "12 min" — how long the agent has been at it. */
export function elapsedShort(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 600) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  return `${Math.floor(s / 60)} min`;
}

/** Three dots that fill up once per ~2 s while the agent works. */
export function workingDots(now: number): string {
  return ".".repeat(1 + (Math.floor(now / 700) % 3)).padEnd(3, " ");
}
