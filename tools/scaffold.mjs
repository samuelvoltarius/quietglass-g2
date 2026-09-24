#!/usr/bin/env node
/**
 * Creates the shared skeleton for one Aigner Labs app.
 *
 * Conventions are shared by COPYING, never by importing: each app must stay
 * independently releasable, so there is no cross-app runtime dependency.
 *
 *   node tools/scaffold.mjs <dir> "<Display Name>" <devPort> "<description>"
 */
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const [dir, displayName, devPort, description] = process.argv.slice(2);

if (!dir || !displayName || !devPort) {
  console.error('usage: scaffold.mjs <dir> "<Display Name>" <devPort> "<description>"');
  process.exit(1);
}

const app = join(ROOT, "apps", dir);
const slug = dir.replace(/-/g, "");
const write = (rel, content) => {
  const target = join(app, rel);
  mkdirSync(dirname(target), { recursive: true });
  if (existsSync(target)) { console.log(`  kept    ${rel}`); return; }
  writeFileSync(target, content, "utf8");
  console.log(`  created ${rel}`);
};

write("package.json", JSON.stringify({
  name: `@aigner-labs/${dir}`,
  version: "0.1.0",
  description: `Aigner Labs ${displayName} — ${description ?? ""}`.trim(),
  author: "Aigner Labs",
  license: "MIT",
  private: false,
  type: "module",
  scripts: {
    dev: "vite",
    build: "tsc --noEmit && vite build",
    typecheck: "tsc --noEmit",
    test: "vitest run",
    "test:watch": "vitest",
    sim: `evenhub-simulator --automation-port ${Number(devPort) + 4700} http://127.0.0.1:${devPort}`,
    pack: "evenhub pack app.json dist -o",
  },
  dependencies: { "@evenrealities/even_hub_sdk": "0.0.16" },
  devDependencies: {
    "@evenrealities/evenhub-cli": "0.1.14",
    "@evenrealities/evenhub-simulator": "0.9.5",
    typescript: "^5.6.0",
    vite: "^5.4.0",
    vitest: "^2.1.0",
  },
}, null, 2) + "\n");

write("tsconfig.json", JSON.stringify({
  compilerOptions: {
    target: "ES2022",
    lib: ["ES2022", "DOM", "DOM.Iterable"],
    module: "ESNext",
    moduleResolution: "bundler",
    types: ["vite/client"],
    strict: true,
    noUncheckedIndexedAccess: true,
    noImplicitOverride: true,
    noFallthroughCasesInSwitch: true,
    noUnusedLocals: true,
    noUnusedParameters: true,
    exactOptionalPropertyTypes: true,
    verbatimModuleSyntax: true,
    skipLibCheck: true,
    isolatedModules: true,
    noEmit: true,
  },
  include: ["src", "tests"],
}, null, 2) + "\n");

write("vite.config.ts", `import { defineConfig } from "vite";

export default defineConfig({
  server: { host: "127.0.0.1", port: ${devPort} },
  build: { target: "es2022", outDir: "dist" },
});
`);

write("app.json", JSON.stringify({
  package_id: `labs.aigner.${slug}`,
  edition: "202601",
  name: displayName,
  version: "0.1.0",
  min_app_version: "2.0.0",
  min_sdk_version: "0.0.16",
  entrypoint: "index.html",
  permissions: [],
  supported_languages: ["en"],
}, null, 2) + "\n");

write("index.html", `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>${displayName} — Aigner Labs</title>
    <link rel="stylesheet" href="/src/ui/phone.css" />
  </head>
  <body>
    <main id="app"></main>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
`);

write("LICENSE", `MIT License

Copyright (c) 2026 Aigner Labs

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`);

console.log(`\n${displayName}: skeleton ready in apps/${dir}\n`);

// Shared convention files are copied in, not imported, so each app ships alone.
import { readFileSync } from "node:fs";
for (const [from, to] of [["shared/gestures.ts", "src/input/gestures.ts"], ["shared/phone.css", "src/ui/phone.css"]]) {
  write(to, readFileSync(join(ROOT, from), "utf8"));
}
