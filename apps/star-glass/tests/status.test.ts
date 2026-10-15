import { describe, expect, it } from "vitest";
import { alerts } from "../src/nina/alerts";
import { createDemoNina, type DemoScene } from "../src/nina/demo";
import { availableCommands, clock, decimal, parseStatus, progressNow, remainingNow, type OnlineStatus } from "../src/nina/status";
import { buildUrl, effectiveUrl, parseSettings } from "../src/storage/persist";

const base = async (scene: DemoScene = "run"): Promise<OnlineStatus> => {
  const status = await createDemoNina(() => 0, scene).status();
  if (!status.online) throw new Error("demo offline");
  return status;
};

describe("reading the bridge status", () => {
  it("survives garbage and keeps what makes sense", () => {
    expect(parseStatus(null)).toEqual({ online: false, reason: "unknown", controllable: false });
    expect(parseStatus({ online: false, reason: "nina-silent" })).toMatchObject({ online: false, reason: "nina-silent" });
    const s = parseStatus({ online: true, sequence: { state: "weird", frame: "3" }, exposure: { progress: 140 }, history: { hfr: [1, "x", 2] }, events: [{ name: "" }, { name: "GUIDER-STOP", ageSeconds: 4 }] });
    if (!s.online) throw new Error("expected online");
    expect(s.sequence.state).toBe("none");
    expect(s.sequence.frame).toBeNull();
    expect(s.exposure.progress).toBe(100);
    expect(s.history.hfr).toEqual([1, 2]);
    expect(s.events).toEqual([{ name: "GUIDER-STOP", ageSeconds: 4 }]);
    expect(s.camera.connected).toBe(false);
  });

  it("counts the exposure down locally between readings", async () => {
    const s = await base();
    expect(s.exposure.total).toBe(180);
    expect(remainingNow(s, 0)).toBeCloseTo(63, 0);
    expect(remainingNow(s, 10)).toBeCloseTo(53, 0);
    expect(remainingNow(s, 999)).toBe(0);
    expect(progressNow(s, 0)).toBe(65);
    expect(progressNow(s, 999)).toBe(100);
    expect(remainingNow(null, 0)).toBeNull();
  });

  it("only offers commands the bridge allows and the sequence can take", async () => {
    expect(availableCommands(await base())).toEqual(["stop"]);
    expect(availableCommands({ ...(await base()), controllable: false })).toEqual([]);
    const demo = createDemoNina(() => 0);
    await demo.command("stop");
    expect(availableCommands(await demo.status())).toEqual(["start"]);
    expect(availableCommands(await base("done"))).toEqual([]);
  });

  it("formats clocks and decimals per language", () => {
    expect(clock(63)).toBe("1:03");
    expect(clock(5)).toBe("0:05");
    expect(clock(3725)).toBe("1 h 02");
    expect(decimal(0.625, 2, "de")).toBe("0,63");
    expect(decimal(0.625, 2, "en")).toBe("0.63");
  });
});

describe("alerts", () => {
  it("a calm night raises nothing", async () => {
    expect(alerts(await base())).toEqual([]);
    expect(alerts(null)).toEqual([]);
  });

  it("names each problem, worst first", async () => {
    expect(alerts(await base("flip")).map((a) => a.kind)).toEqual(["flipSoon"]);
    expect(alerts(await base("lost")).map((a) => a.kind)).toEqual(["guidingLost"]);
    expect(alerts(await base("warm")).map((a) => a.kind)).toEqual(["coolingOff"]);
    expect(alerts(await base("done")).map((a) => a.kind)).toEqual(["seqDone"]);
    const both = { ...(await base("flip")), guider: { connected: true, guiding: false, rms: 2, ra: 1, dec: 1 } };
    expect(alerts(both).map((a) => a.kind)).toEqual(["guidingLost", "flipSoon"]);
  });

  it("cooling drift, lost devices, old events and errors", async () => {
    const s = await base();
    expect(alerts({ ...s, camera: { ...s.camera, temp: -5 } }).map((a) => a.kind)).toEqual(["coolingDrift"]);
    expect(alerts({ ...s, camera: { ...s.camera, connected: false } }).map((a) => a.kind)).toEqual(["cameraLost"]);
    expect(alerts({ ...s, events: [{ name: "ERROR-PLATESOLVE", ageSeconds: 30 }] })[0]).toMatchObject({ kind: "error", vars: { name: "PLATESOLVE" } });
    expect(alerts({ ...s, events: [{ name: "ERROR-AF", ageSeconds: 99_999 }] })).toEqual([]);
    expect(alerts({ ...s, mount: { ...s.mount, flipMinutes: 0 } }).map((a) => a.kind)).toEqual(["flipNow"]);
    // A guider that stopped and was started again is fine.
    expect(alerts({ ...s, events: [{ name: "GUIDER-STOP", ageSeconds: 300 }, { name: "GUIDER-START", ageSeconds: 200 }] })).toEqual([]);
  });
});

describe("settings", () => {
  it("a private build's address is the default; typed addresses win", () => {
    expect(buildUrl("https://bridge.example:8460/")).toBe("https://bridge.example:8460");
    expect(buildUrl("not a url")).toBe("");
    expect(buildUrl(undefined)).toBe("");
    expect(effectiveUrl(parseSettings(""), "https://built.example")).toBe("https://built.example");
    expect(effectiveUrl(parseSettings(JSON.stringify({ bridgeUrl: "https://mine.example" })), "https://built.example")).toBe("https://mine.example");
    expect(parseSettings("{oops")).toEqual({ bridgeUrl: "", invertScroll: false, weather: { enabled: true, thresholds: { cloud: 60, rainProb: 40, dewSpread: 2, wind: 30 } } });
  });
});
