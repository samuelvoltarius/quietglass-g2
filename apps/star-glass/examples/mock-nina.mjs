#!/usr/bin/env node
/**
 * A stand-in for N.I.N.A. + Advanced API (v2) for testing the bridge without
 * an imaging PC: a running sequence on M 42 (frame 4 of 10, 60 s exposures),
 * a cooled camera, a tracking mount, a guider, three frames in the history and
 * a small PNG for the newest frame. Shapes follow what Advanced API 2.2.15
 * returns (trimmed to what the bridge reads).
 *
 *   node mock-nina.mjs            # http://127.0.0.1:1889/v2/api
 */
import { createServer } from "node:http";
import { encodePngGray } from "./star-bridge.mjs";

const PORT = Number(process.env["PORT"] ?? 1889);
const HOST = process.env["HOST"] ?? "127.0.0.1";
const started = Date.now();

const ok = (response) => ({ Response: response, Error: "", StatusCode: 200, Success: true, Type: "API" });

function sequence() {
  return [
    { GlobalTriggers: [] },
    { Name: "Start_Container", Status: "FINISHED", Conditions: [], Triggers: [], Items: [] },
    {
      Name: "Targets_Container", Status: "RUNNING", Conditions: [], Triggers: [],
      Items: [{
        Name: "M 42_Container", Status: "RUNNING", Target: { TargetName: "M 42", InputCoordinates: {} }, Conditions: [], Triggers: [],
        Items: [{
          Name: "Smart Exposure_Container", Status: "RUNNING", Triggers: [],
          Conditions: [{ Name: "Loop For Iterations_Condition", Status: "RUNNING", Iterations: 10, CompletedIterations: 3 }],
          Items: [
            { Name: "Switch Filter", Status: "FINISHED" },
            { Name: "Take Exposure", Status: "RUNNING", ExposureTime: 60, ImageType: "LIGHT" },
          ],
        }],
      }],
    },
    { Name: "End_Container", Status: "CREATED", Conditions: [], Triggers: [], Items: [] },
  ];
}

const frame = (i, hfr) => ({
  ExposureTime: 60, ImageType: "LIGHT", Filter: "L", RmsText: "", Temperature: -10, CameraName: "Mock Camera",
  TargetName: "M 42", Gain: 100, Offset: 10, Date: new Date(started - (3 - i) * 61000).toISOString(),
  TelescopeName: "Mock", FocalLength: 400, StDev: 10, Mean: 900, Median: 880, Stars: 900 + i * 10, HFR: hfr,
  IsBayered: false, Min: 0, Max: 65535, HFRStDev: 0.3, Filename: `mock_${i}.fits`,
});

function picture() {
  const width = 64, height = 48, pixels = new Uint8Array(width * height).fill(20);
  for (let i = 0; i < 40; i++) pixels[(i * 37) % pixels.length] = 250;
  return encodePngGray({ width, height, pixels });
}

/** After a stop, N.I.N.A. shows the unfinished items as not running any more. */
const halt = (node) => ({ ...node, ...(node.Status === "RUNNING" ? { Status: "CREATED" } : {}), ...(Array.isArray(node.Items) ? { Items: node.Items.map(halt) } : {}) });

let running = true;
const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  const path = url.pathname.replace(/^\/v2\/api/, "");
  const json = (body, code = 200) => { response.writeHead(code, { "Content-Type": "application/json" }); response.end(JSON.stringify(body)); };
  const end = new Date(Date.now() + 25_000).toISOString();
  switch (path) {
    case "/version": return json(ok("2.2.15.2"));
    case "/equipment/camera/info": return json(ok({
      Connected: true, Name: "Mock Camera", DisplayName: "Mock Camera", Temperature: -9.8, TemperatureSetPoint: -10, TargetTemp: -10,
      CanSetTemperature: true, CoolerOn: true, CoolerPower: 41, AtTargetTemp: true, IsExposing: running, ExposureEndTime: end, Gain: 100, XSize: 640, YSize: 480,
    }));
    case "/equipment/mount/info": return json(ok({
      Connected: true, TrackingEnabled: true, AtPark: false, Slewing: false, Altitude: 41.26, Azimuth: 160.4, TimeToMeridianFlip: 0.2,
      SideOfPier: "pierEast", SiteLatitude: 1.2345, SiteLongitude: 6.789, SiteElevation: 500,
    }));
    case "/equipment/focuser/info": return json(ok({ Connected: true, Position: 12000, Temperature: 6.25, IsMoving: false }));
    case "/equipment/filterwheel/info": return json(ok({ Connected: true, SelectedFilter: { Name: "L", Id: 0 } }));
    case "/equipment/guider/info": return json(ok({
      Connected: true, State: "Guiding", PixelScale: 2,
      RMSError: { RA: { Pixel: 0.2, Arcseconds: 0.4 }, Dec: { Pixel: 0.25, Arcseconds: 0.5 }, Total: { Pixel: 0.32, Arcseconds: 0.64 } },
    }));
    case "/sequence/state": return json(ok(running ? sequence() : sequence().map(halt)));
    case "/sequence/stop": running = false; return json(ok("Sequence stopped"));
    case "/sequence/start": running = true; return json(ok("Sequence started"));
    case "/event-history": return json(ok([
      { Event: "SEQUENCE-STARTING", Time: new Date(started - 200_000).toISOString() },
      { Event: "IMAGE-SAVE", Time: new Date(started - 5_000).toISOString() },
    ]));
    case "/image-history": return json(ok([frame(0, 2.4), frame(1, 2.2), frame(2, 2.31)]));
    default:
      if (/^\/image\/\d+$/.test(path)) {
        response.writeHead(200, { "Content-Type": "image/png" });
        response.end(picture());
        return undefined;
      }
      return json({ Response: "", Error: "Unknown endpoint", StatusCode: 404, Success: false, Type: "API" }, 404);
  }
});

server.listen(PORT, HOST, () => console.log(`mock N.I.N.A. on http://${HOST}:${PORT}/v2/api`));
