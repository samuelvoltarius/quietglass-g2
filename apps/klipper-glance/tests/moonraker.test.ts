import { describe, expect, it } from "vitest";
import { createMoonrakerClient, findPrinter, gcodeLayers, isMoonrakerUrl, normalizeAddress, shapeStatus } from "../src/printer/moonraker";

const QUERY_REPLY = {
  result: {
    status: {
      print_stats: { state: "printing", filename: "halter.gcode", print_duration: 600, message: "", info: { current_layer: 12, total_layer: 120 } },
      display_status: { progress: 0.25 },
      extruder: { temperature: 219.6, target: 220 },
      heater_bed: { temperature: 59.8, target: 60 },
      gcode_move: { speed_factor: 1, gcode_position: [10, 20, 3.456, 0] },
    },
  },
};

const reply = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("direct mode (Moonraker, no bridge)", () => {
  it("normalises what the user types", () => {
    expect(normalizeAddress(" 192.168.1.50 ")).toBe("http://192.168.1.50:7125");
    expect(normalizeAddress("k1.local:7125")).toBe("http://k1.local:7125");
    expect(normalizeAddress("https://drucker.example.ts.net:8898/")).toBe("https://drucker.example.ts.net:8898");
    expect(normalizeAddress("")).toBe("");
  });

  it("tells a Moonraker address from a bridge", () => {
    expect(isMoonrakerUrl("http://192.168.1.50:7125")).toBe(true);
    expect(isMoonrakerUrl("https://pi.example.ts.net:8898")).toBe(false);
  });

  it("shapes Moonraker's object query like the bridge does", () => {
    const shaped = shapeStatus(QUERY_REPLY, false);
    expect(shaped).toMatchObject({ online: true, state: "printing", file: "halter.gcode", progress: 25, layer: 12, layers: 120, minutesLeft: 30, z: 3.46, controllable: false });
    expect(shaped["nozzle"]).toEqual({ now: 220, target: 220 });
  });

  it("reads the status straight from Moonraker and refuses commands unless allowed", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => { calls.push(String(input)); return reply(QUERY_REPLY); }) as typeof fetch;
    const api = createMoonrakerClient({ baseUrl: "http://192.0.2.7:7125", fetchImpl });
    const status = await api.status();
    expect(status.online && status.progress).toBe(25);
    expect(calls[0]).toContain("http://192.0.2.7:7125/printer/objects/query?");
    await expect(api.command("pause")).rejects.toMatchObject({ code: "refused" });
    expect(calls).toHaveLength(1);
  });

  it("sends pause only when control is switched on", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => { calls.push((init?.method ?? "GET") + " " + String(input)); return reply({ result: "ok" }); }) as typeof fetch;
    const api = createMoonrakerClient({ baseUrl: "http://192.0.2.7:7125", fetchImpl, allowControl: true });
    await api.command("pause");
    expect(calls).toEqual(["POST http://192.0.2.7:7125/printer/print/pause"]);
  });

  it("builds the same layer model as the bridge from G-code", () => {
    const parser = gcodeLayers();
    for (const line of ["G90", "M82", "G1 Z0.2", "G1 X0 Y0", "G1 X10 Y0 E1", "G1 X10 Y10 E2", "G1 Z0.4", "G1 X0 Y10 E3"]) parser.line(line);
    const model = parser.done() as { z: number[]; layersTotal: number; bounds: number[]; segs: string };
    expect(model.layersTotal).toBe(2);
    expect(model.z).toEqual([0.2, 0.4]);
    expect(model.bounds).toEqual([0, 0, 0.2, 10, 10, 0.4]);
    expect(typeof model.segs).toBe("string");
  });

  it("finds the printer on the home network", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (String(input) === "http://192.168.1.42:7125/printer/info") return reply({ result: { state: "ready" } });
      throw new TypeError("unreachable");
    }) as typeof fetch;
    const seen: string[] = [];
    expect(await findPrinter(fetchImpl, ["192.168.0", "192.168.1"], (net) => seen.push(net), 50)).toBe("http://192.168.1.42:7125");
    expect(seen).toEqual(["192.168.0", "192.168.1"]);
  });
});
