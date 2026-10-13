#!/usr/bin/env node
/**
 * Builds the PRIVATE builds of the Quietglass apps that talk to your own servers.
 *
 * Why private builds: on a real G2 the network whitelist in app.json needs EXACT origins
 * (https://host:port). Wildcards such as "https://*" work in the simulator but are blocked on
 * the glasses. So for every app this script
 *
 *   1. reads selfhost/config.json (your tailnet addresses, see config.example.json),
 *   2. writes apps/<app>/app.private.json  (app.json + the exact origins of the services it uses;
 *      git-ignored; an existing file is kept once as app.private.json.bak),
 *   3. builds with the matching VITE_* variables (server addresses are then the app's defaults,
 *      nothing to type on the phone),
 *   4. packs release/<app>/<app>-<version>.ehpk (git-ignored) for "Private builds" in the Even Hub.
 *
 * Fail-safe: dist/ is deleted before the build, the build log is checked by exit code (never
 * piped), and the .ehpk only counts if it exists afterwards and is newer than this run.
 *
 *   node selfhost/build-private.mjs --list
 *   node selfhost/build-private.mjs --app nextstop --dry-run     # show only, build nothing, write nothing
 *   node selfhost/build-private.mjs --app nextstop,babel-glass
 *   node selfhost/build-private.mjs                              # every app whose services are configured
 *
 * Options: --app <a[,b]>  --config <file>  --dry-run  --list  --no-install  --help
 * No dependencies; Node 18+.
 */
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, copyFileSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const PLACEHOLDER = /tailnet-name|my-server|example\.com|<[^>]+>/i;

// ---------------------------------------------------------------------------
// What each app needs. `services` are keys of config.services; `required` ones must be configured
// for the app to be built; the rest are optional. `plan()` returns the exact origins to whitelist and
// the VITE_* variables, given the normalised services.
// ---------------------------------------------------------------------------
const wss = (origin) => origin.replace(/^https:/, "wss:");

const APPS = {
  nextstop: {
    summary: "ÖBB live data, voice destination, own routing (all optional)",
    required: [],
    optional: ["oebb", "whisper", "valhalla"],
    plan: (s) => ({
      origins: [s.oebb, s.whisper, s.valhalla].filter(Boolean),
      env: {
        ...(s.whisper ? { VITE_STT_URL: `${s.whisper}/v1/audio/transcriptions` } : {}),
        ...(s.oebb ? { VITE_OEBB_URL: `${s.oebb}/oebb` } : {}),
        ...(s.valhalla ? { VITE_ROUTER_URL: s.valhalla } : {}),
      },
    }),
  },
  "openglance-nav": {
    summary: "own Valhalla routing",
    required: ["valhalla"],
    optional: [],
    plan: (s) => ({ origins: [s.valhalla], env: { VITE_ROUTER_URL: s.valhalla } }),
  },
  "babel-glass": {
    summary: "live captions (Whisper WebSocket) and translation (LLM proxy)",
    required: ["babelWs", "babelLlm"],
    optional: [],
    plan: (s, o) => ({
      origins: [wss(s.babelWs), s.babelLlm],
      env: {
        VITE_BABEL_STT: wss(s.babelWs),
        VITE_BABEL_LLM: `${s.babelLlm}/v1`,
        ...(o.babelModel ? { VITE_BABEL_MODEL: o.babelModel } : {}),
      },
    }),
  },
  "status-glass": {
    summary: "one or more status sources",
    required: ["status"],
    optional: [],
    plan: (s) => ({
      origins: s.status.map((x) => x.origin),
      env: { VITE_STATUS_SOURCES: s.status.map((x) => `${x.name}|${x.url}/status`).join(";") },
    }),
  },
  "shoot-day": { summary: "Shoot Day backend", required: ["shootDay"], optional: [], plan: (s) => ({ origins: [s.shootDay], env: {} }) },
  "klipper-glance": { summary: "Klipper bridge", required: ["klipper"], optional: [], plan: (s) => ({ origins: [s.klipper], env: {} }) },
  "lumen-glass": { summary: "your LUMEN server (separate project)", required: ["lumen"], optional: [], plan: (s) => ({ origins: [s.lumen], env: {} }) },
  "quiet-hub": { summary: "Quiet Hub daemon", required: ["quietHub"], optional: [], plan: (s) => ({ origins: [s.quietHub], env: {} }) },
  "xaventra-hud": { summary: "your Xaventra agent endpoint", required: ["xaventra"], optional: [], plan: (s) => ({ origins: [s.xaventra], env: {} }) },
  "agent-glass": {
    summary: "agent endpoints (https and wss)",
    required: ["agents"],
    optional: [],
    plan: (s) => ({ origins: s.agents.flatMap((o) => [o, wss(o)]), env: {} }),
  },
  "field-log": {
    summary: "dictation through your Whisper (address is typed in the app)",
    required: ["whisper"],
    optional: [],
    plan: (s) => ({ origins: [s.whisper, wss(s.whisper)], env: {} }),
  },
  "rain-lens": {
    summary: "rain radar (RainViewer, private use only) - needs options.rainRadar = true",
    required: [],
    optional: [],
    enabled: (o) => o.rainRadar === true,
    plan: () => ({
      origins: ["https://api.rainviewer.com", "https://tilecache.rainviewer.com"],
      env: { VITE_RADAR: "1" },
    }),
  },
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
class ConfigError extends Error {}

/** "https://host:port[/ignored]" -> "https://host:port". Only https; the glasses cannot use plain http. */
function origin(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new ConfigError(`${label}: address missing`);
  let url;
  try { url = new URL(value.trim()); } catch { throw new ConfigError(`${label}: "${value}" is not a URL`); }
  if (url.protocol !== "https:") throw new ConfigError(`${label}: must start with https:// (got "${value}"). Publish the service with tailscale serve --https=<port>.`);
  if (url.pathname.replace(/\/+$/, "") !== "" || url.search || url.hash) throw new ConfigError(`${label}: give only https://host:port, without a path (got "${value}")`);
  if (/[*]/.test(url.hostname)) throw new ConfigError(`${label}: wildcards are blocked on the glasses (got "${value}")`);
  return url.origin;
}

function loadConfig(file) {
  if (!existsSync(file)) {
    throw new ConfigError(`${relative(ROOT, file)} not found. Copy selfhost/config.example.json to selfhost/config.json and fill in your tailnet addresses.`);
  }
  let raw;
  try { raw = JSON.parse(readFileSync(file, "utf8")); } catch (e) { throw new ConfigError(`${file}: invalid JSON (${e.message})`); }
  const sv = raw.services ?? {};
  const one = (key, label = key) => (sv[key] ? origin(sv[key], `services.${label}`) : undefined);
  const list = (key) => (Array.isArray(sv[key]) ? sv[key] : []);
  const status = list("status").map((entry, i) => {
    const e = typeof entry === "string" ? { url: entry } : entry;
    const url = origin(e?.url, `services.status[${i}]`);
    const name = String(e?.name ?? new URL(url).hostname.split(".")[0]).replace(/[;|\n]/g, " ").trim();
    return { name, url, origin: url };
  });
  const services = {
    quietHub: one("quiet-hub"),
    whisper: one("whisper"),
    babelWs: one("babel-whisper-ws"),
    babelLlm: one("babel-llm"),
    oebb: one("oebb"),
    shootDay: one("shoot-day"),
    klipper: one("klipper"),
    valhalla: one("valhalla"),
    lumen: one("lumen"),
    xaventra: one("xaventra"),
    agents: list("agent-glass").map((u, i) => origin(u, `services.agent-glass[${i}]`)),
    status,
  };
  for (const key of ["agents", "status"]) if (services[key].length === 0) delete services[key];
  for (const key of Object.keys(services)) if (services[key] === undefined) delete services[key];
  return { services, options: raw.options ?? {} };
}

const hasService = (services, key) => services[key] !== undefined;

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------
function readJson(file) { return JSON.parse(readFileSync(file, "utf8")); }

function planApp(name, config) {
  const def = APPS[name];
  const dir = join(ROOT, "apps", name);
  if (!existsSync(join(dir, "app.json"))) throw new ConfigError(`apps/${name}/app.json not found`);
  const appJson = readJson(join(dir, "app.json"));
  const missing = def.required.filter((key) => !hasService(config.services, key));
  const disabled = def.enabled ? !def.enabled(config.options) : false;
  if (disabled || missing.length) return { name, skip: disabled ? "not enabled in config.options" : `service not configured: ${missing.join(", ")}` };
  const { origins, env } = def.plan(config.services, config.options);
  const exact = [...new Set(origins.filter(Boolean))];

  // app.private.json = app.json with the wildcard entries of the network whitelist replaced by the exact origins.
  const privateJson = JSON.parse(JSON.stringify(appJson));
  const perms = Array.isArray(privateJson.permissions) ? privateJson.permissions : (privateJson.permissions = []);
  let net = perms.find((p) => p.name === "network");
  if (!net) { net = { name: "network", desc: "Reach the servers you set up yourself (your own tailnet addresses).", whitelist: [] }; perms.push(net); }
  const kept = (net.whitelist ?? []).filter((entry) => !entry.includes("*"));
  net.whitelist = [...new Set([...kept, ...exact])];
  if (net.whitelist.length === 0) throw new ConfigError(`${name}: empty network whitelist after generation`);

  const sdk = (() => {
    try { return String(readJson(join(dir, "package.json")).dependencies?.["@evenrealities/even_hub_sdk"] ?? "").replace(/^[^\d]*/, ""); } catch { return ""; }
  })() || "0.0.16";
  const version = String(appJson.version);
  const out = join(ROOT, "release", name, `${name}-${version}.ehpk`);
  return { name, dir, version, sdk, privateJson, whitelist: net.whitelist, env, out };
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------
function run(command, args, { cwd, env, logFile }) {
  const fd = openSync(logFile, "a");
  try {
    // shell: true so "npm"/"npx" resolve on Windows (npm.cmd) as well as on Linux/macOS.
    const result = spawnSync(command, args, { cwd, env, stdio: ["ignore", fd, fd], shell: true });
    return result.status === 0 && !result.error;
  } finally {
    closeSync(fd);
  }
}

function build(plan, { install }) {
  const started = Date.now() - 1000;
  const log = join(plan.dir, "build.private.log");
  writeFileSync(log, `# ${new Date().toISOString()} private build ${plan.name} ${plan.version}\n`);

  const target = join(plan.dir, "app.private.json");
  if (existsSync(target) && readFileSync(target, "utf8") !== JSON.stringify(plan.privateJson, null, 2) + "\n" && !existsSync(`${target}.bak`)) {
    copyFileSync(target, `${target}.bak`);
    console.log(`  kept the previous app.private.json as app.private.json.bak`);
  }
  writeFileSync(target, JSON.stringify(plan.privateJson, null, 2) + "\n");
  console.log(`  wrote apps/${plan.name}/app.private.json`);

  if (install && !existsSync(join(plan.dir, "node_modules"))) {
    console.log("  node_modules missing: npm ci ...");
    const cmd = existsSync(join(plan.dir, "package-lock.json")) ? ["ci"] : ["install"];
    if (!run("npm", cmd, { cwd: plan.dir, env: process.env, logFile: log })) throw new Error(`npm ${cmd[0]} failed - see ${relative(ROOT, log)}`);
  }

  rmSync(join(plan.dir, "dist"), { recursive: true, force: true }); // a failed build must not leave an old dist behind
  console.log("  npm run build ...");
  const env = { ...process.env, ...plan.env };
  if (!run("npm", ["run", "build"], { cwd: plan.dir, env, logFile: log })) throw new Error(`build failed - see ${relative(ROOT, log)}`);
  const index = join(plan.dir, "dist", "index.html");
  if (!existsSync(index) || statSync(index).mtimeMs < started) throw new Error(`build produced no fresh dist/index.html - see ${relative(ROOT, log)}`);

  mkdirSync(dirname(plan.out), { recursive: true });
  rmSync(plan.out, { force: true });
  console.log("  evenhub pack ...");
  const pack = ["--no-install", "evenhub", "pack", "app.private.json", "dist", "-o", plan.out, "--sdk-ver", plan.sdk];
  if (!run("npx", pack, { cwd: plan.dir, env: process.env, logFile: log })) throw new Error(`pack failed - see ${relative(ROOT, log)}`);
  if (!existsSync(plan.out) || statSync(plan.out).mtimeMs < started || statSync(plan.out).size === 0) throw new Error(`pack produced no fresh ${relative(ROOT, plan.out)} - see ${relative(ROOT, log)}`);
  console.log(`  OK  ${relative(ROOT, plan.out)}  (${Math.round(statSync(plan.out).size / 1024)} KB)`);
}

function show(plan) {
  console.log(`  version   ${plan.version}   (evenhub --sdk-ver ${plan.sdk})`);
  console.log("  whitelist");
  for (const entry of plan.whitelist) console.log(`    ${entry}`);
  const keys = Object.keys(plan.env);
  console.log(keys.length ? "  build variables" : "  build variables  (none)");
  for (const key of keys) console.log(`    ${key}=${plan.env[key]}`);
  console.log(`  would run   (in apps/${plan.name})  rm -rf dist; npm run build   [VITE_* as above]`);
  console.log(`              npx evenhub pack app.private.json dist -o ${relative(ROOT, plan.out).replace(/\\/g, "/")} --sdk-ver ${plan.sdk}`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { apps: [], dryRun: false, list: false, install: true, help: false, config: join(HERE, "config.json") };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--app") args.apps.push(...String(argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean));
    else if (a.startsWith("--app=")) args.apps.push(...a.slice(6).split(",").map((s) => s.trim()).filter(Boolean));
    else if (a === "--config") args.config = resolve(argv[++i] ?? "");
    else if (a.startsWith("--config=")) args.config = resolve(a.slice(9));
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--list") args.list = true;
    else if (a === "--no-install") args.install = false;
    else if (a === "--help" || a === "-h") args.help = true;
    else throw new ConfigError(`unknown option ${a} (try --help)`);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0].replace(/^\/\*\*\n|^ \* ?/gm, "").trim());
    return 0;
  }
  if (args.list) {
    console.log("Apps this script can build privately:\n");
    for (const [name, def] of Object.entries(APPS)) console.log(`  ${name.padEnd(16)} ${def.summary}${def.required.length ? `   [needs: ${def.required.join(", ")}]` : ""}`);
    return 0;
  }
  const unknown = args.apps.filter((a) => !APPS[a]);
  if (unknown.length) throw new ConfigError(`unknown app: ${unknown.join(", ")}. Known: ${Object.keys(APPS).join(", ")}`);

  const config = loadConfig(args.config);
  const names = args.apps.length ? [...new Set(args.apps)] : Object.keys(APPS);
  const plans = [];
  for (const name of names) {
    const plan = planApp(name, config);
    if (plan.skip) {
      if (args.apps.length) throw new ConfigError(`${name}: ${plan.skip}`);
      console.log(`- ${name}: skipped (${plan.skip})`);
      continue;
    }
    plans.push(plan);
  }
  if (plans.length === 0) { console.log("Nothing to build. Fill services in your config."); return 1; }

  const placeholders = [...new Set(plans.flatMap((p) => [...p.whitelist, ...Object.values(p.env)]).filter((v) => PLACEHOLDER.test(v)))];
  if (placeholders.length && !args.dryRun) {
    throw new ConfigError(`the config still contains placeholder addresses (${placeholders.slice(0, 3).join(", ")}). Put your real tailnet names in ${relative(ROOT, args.config)}.`);
  }

  console.log(args.dryRun ? "DRY RUN - nothing is written or built.\n" : "");
  let failed = 0;
  for (const plan of plans) {
    console.log(`${plan.name}`);
    if (args.dryRun) { show(plan); console.log(); continue; }
    try { build(plan, args); } catch (e) { failed++; console.error(`  FAILED: ${e.message}`); }
    console.log();
  }
  if (!args.dryRun) console.log(failed ? `${failed} of ${plans.length} builds failed.` : `Done: ${plans.length} private build(s) in release/. Upload them under "Private builds" in the Even Hub.`);
  return failed ? 1 : 0;
}

try {
  process.exitCode = main();
} catch (e) {
  console.error(e instanceof ConfigError ? `Error: ${e.message}` : e);
  process.exitCode = 2;
}
