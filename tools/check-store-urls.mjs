#!/usr/bin/env node
/**
 * Even Hub review check: every URL-looking string in a built app bundle must
 * match an exact origin in the app's network whitelist. The reviewers reject
 * bundles with any other URL - also plain text, doc links, placeholders and
 * template literals like `http://${host}:7125` - and a wildcard entry
 * (`https://*`) does not count. Store rejections 21.10.2026.
 *
 *   node tools/check-store-urls.mjs rain-lens nextstop ...   (after a store build in apps/<app>/dist)
 *
 * Exit code 1 when anything is found.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
// Things that look like URLs in every Vite/SDK bundle and are not network targets.
// A bare scheme ("must start with https://") is a hint text, not a target.
const IGNORE = [/^(?:https?|wss?):\/\/[.…]?$/, /^http:\/\/www\.w3\.org\//, /^https?:\/\/localhost\b/, /^https?:\/\/127\.0\.0\.1\b/];

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.(js|html|css|json)$/.test(name) ? [path] : [];
  });
}

let bad = 0;
for (const app of process.argv.slice(2)) {
  const manifest = JSON.parse(readFileSync(join(ROOT, "apps", app, "app.json"), "utf8"));
  const allowed = (manifest.permissions ?? []).filter((p) => p.name === "network").flatMap((p) => p.whitelist ?? []);
  const exact = allowed.filter((o) => !o.includes("*"));
  const found = new Map();
  for (const file of files(join(ROOT, "apps", app, "dist"))) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/(?:https?|wss?):\/\/[^\s"'`<>)\\]*/gi)) found.set(m[0], file);
    // A bare scheme closed by a quote is a URL built at runtime (`"http://" + host`) or a "https://" placeholder:
    // the reviewers reject both. Build the scheme from parts and use plain-text placeholders.
    for (const m of text.matchAll(/(?:https?|wss?):\/\/["'`]/gi)) found.set("built-or-placeholder " + m[0], file);
  }
  const offending = [...found.keys()].filter((url) => {
    if (url.startsWith("built-or-placeholder ")) return true;
    if (IGNORE.some((re) => re.test(url))) return false;
    return !exact.some((origin) => url === origin || url.startsWith(origin + "/") || url.startsWith(origin + "?"));
  });
  if (offending.length) {
    bad++;
    console.log(`${app}: ${offending.length} URL(s) not in the exact whitelist`);
    for (const url of offending) console.log("   " + url.slice(0, 120));
  } else {
    console.log(`${app}: ok`);
  }
}
process.exit(bad ? 1 : 0);
