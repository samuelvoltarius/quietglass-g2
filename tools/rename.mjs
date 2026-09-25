#!/usr/bin/env node
/**
 * One-off rename: Quietglass -> Quietglass.
 *
 * Touches identifiers as well as prose: npm scope, Even Hub package_id,
 * per-app storage keys and the FlowList pack format marker. Those are
 * versioned strings other code matches on, so they have to change together
 * with everything else rather than being left behind.
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";

const ROOT = "F:/quietglass";
const SKIP = new Set(["node_modules", "dist", ".git", ".sim", ".verify"]);

const RULES = [
  // Identifiers first, so the prose rules cannot corrupt them.
  [/@quietglass\//g, "@quietglass/"],
  [/labs\.aigner\./g, "glass.quiet."],
  [/aignerlabs\./g, "quietglass."],
  [/quietglass\/flowlist@1/g, "quietglass/flowlist@1"],
  [/quietglass-g2/g, "quietglass-g2"],
  [/Quietglass/g, "Quietglass"],
  [/quietglass/g, "quietglass"],
];

let changed = 0;
const touched = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const path = join(dir, entry);
    const info = statSync(path);
    if (info.isDirectory()) {
      walk(path);
      continue;
    }
    if (!/\.(ts|tsx|js|mjs|json|md|html|css|ps1|py|yml|yaml)$/.test(entry)) continue;

    const before = readFileSync(path, "utf8");
    let after = before;
    for (const [pattern, replacement] of RULES) after = after.replace(pattern, replacement);
    if (after !== before) {
      writeFileSync(path, after, "utf8");
      changed++;
      touched.push(path.split(sep).join("/").replace(ROOT + "/", ""));
    }
  }
}

walk(ROOT);
console.log("Dateien geaendert: " + changed);
for (const f of touched.slice(0, 12)) console.log("  " + f);
if (touched.length > 12) console.log("  ... und " + (touched.length - 12) + " weitere");
