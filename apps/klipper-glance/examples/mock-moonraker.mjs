#!/usr/bin/env node
/**
 * A stand-in for a Klipper printer, for trying the bridge without one: it
 * answers the Moonraker endpoints the bridge uses and lets a print advance
 * slowly. Pause, resume and cancel change its state.
 *
 *   node mock-moonraker.mjs                     # http://127.0.0.1:7125
 *   KL_MOONRAKER=http://127.0.0.1:7125 KL_ALLOW_CONTROL=1 node klipper-bridge.mjs
 *
 * Environment: PORT (default 7125), HOST (default 127.0.0.1),
 * PRINT_SECONDS (length of the simulated print, default 600).
 */
import { createServer } from "node:http";

const PORT = Number(process.env["PORT"] ?? 7125);
const HOST = process.env["HOST"] ?? "127.0.0.1";
const PRINT_SECONDS = Number(process.env["PRINT_SECONDS"] ?? 600);

const started = Date.now();
let state = "printing";
let pausedAt = 0;
let pausedTotal = 0;
const commands = [];
/** A 2 x 2 grey PNG, served as the slicer preview of the mock print. */
/** A small square tower, 20 layers of 0.2 mm: the mock print's G-code. */
function mockGcode() {
  const lines = ["G90", "M83", "G1 Z0.2 F600"];
  for (let layer = 1; layer <= 20; layer += 1) {
    const z = (layer * 0.2).toFixed(2);
    lines.push(";LAYER_CHANGE", "G1 Z" + z, "G0 X100 Y100");
    lines.push("G1 X120 Y100 E1.2", "G1 X120 Y120 E1.2", "G1 X100 Y120 E1.2", "G1 X100 Y100 E1.2");
  }
  return lines.join("\n") + "\n";
}
const GCODE = mockGcode();

const PREVIEW_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAAAAABX3VL4AAAADklEQVR4nGP4z8DAwMAAA/4BA8A2VrQAAAAASUVORK5CYII=", "base64");

const seconds = () => ((state === "paused" ? pausedAt : Date.now()) - started - pausedTotal) / 1000;

createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  response.setHeader("Content-Type", "application/json");
  if (url.pathname === "/printer/info") {
    response.end(JSON.stringify({ result: { state: "ready", hostname: "mock-printer" } }));
    return;
  }
  if (url.pathname === "/printer/objects/query") {
    const s = seconds();
    const progress = Math.min(0.999, s / PRINT_SECONDS);
    response.end(JSON.stringify({ result: { status: {
      print_stats: {
        state, filename: "bracket_v3.gcode", print_duration: s, message: "",
        info: { current_layer: Math.floor(progress * 180) + 1, total_layer: 180 },
      },
      display_status: { progress },
      virtual_sdcard: { progress },
      extruder: { temperature: state === "printing" ? 219.4 + Math.sin(s / 5) : 180, target: state === "printing" ? 220 : 0 },
      heater_bed: { temperature: 59.8, target: 60 },
      gcode_move: { speed_factor: 1.0, gcode_position: [110, 110, Math.round((progress * 20 + 0.5)) * 0.2, 0] },
    } } }));
    return;
  }
  if (request.method === "POST" && url.pathname.startsWith("/printer/print/")) {
    const what = url.pathname.slice("/printer/print/".length);
    commands.push(what);
    if (what === "pause" && state === "printing") { state = "paused"; pausedAt = Date.now(); }
    if (what === "resume" && state === "paused") { state = "printing"; pausedTotal += Date.now() - pausedAt; }
    if (what === "cancel") state = "cancelled";
    response.end(JSON.stringify({ result: "ok" }));
    return;
  }
  if (url.pathname === "/server/files/metadata") {
    const known = url.searchParams.get("filename") === "bracket_v3.gcode";
    if (!known) { response.statusCode = 404; response.end("{}"); return; }
    response.end(JSON.stringify({ result: { filename: "bracket_v3.gcode", slicer: "OrcaSlicer", thumbnails: [
      { width: 32, height: 32, size: 900, relative_path: ".thumbs/bracket_v3-32x32.png" },
      { width: 300, height: 300, size: PREVIEW_PNG.length, relative_path: ".thumbs/bracket_v3-300x300.png" },
    ] } }));
    return;
  }
  if (url.pathname === "/server/files/gcodes/.thumbs/bracket_v3-300x300.png") {
    response.setHeader("Content-Type", "image/png");
    response.end(PREVIEW_PNG);
    return;
  }
  if (url.pathname === "/server/files/gcodes/bracket_v3.gcode") {
    response.setHeader("Content-Type", "text/plain");
    response.end(GCODE);
    return;
  }
  if (url.pathname === "/server/spoolman/spool_id") {
    response.end(JSON.stringify({ result: { spool_id: 7 } }));
    return;
  }
  if (url.pathname === "/server/spoolman/proxy" && request.method === "POST") {
    response.end(JSON.stringify({ result: {
      id: 7, remaining_weight: 412.4, remaining_length: 138250,
      filament: { name: "Galaxy Black", material: "PLA", vendor: { name: "Prusament" } },
    } }));
    return;
  }
  // For tests: which commands arrived.
  if (url.pathname === "/mock/commands") { response.end(JSON.stringify({ commands })); return; }
  response.statusCode = 404;
  response.end("{}");
}).listen(PORT, HOST, () => console.log("mock Moonraker on http://" + HOST + ":" + PORT));
