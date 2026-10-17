import { describe, expect, it } from "vitest";
import { NET_DEVICES_MAX, readNetwork, reportFromValue, type NetworkInfo, type SourceReport } from "../src/protocol/schema";
import {
  NET_NEW_PREFIX, acknowledge, applyReport, createSource, netNewMetric, problems, type SourceStatus,
} from "../src/monitor/dashboard";
import { describeMetric, networkLine } from "../src/glasses/host";
import { hostTone, overviewCells, statusLines } from "../src/cockpit/model";
import { devicesUrl, markDeviceKnown } from "../src/protocol/fetcher";
import { networkHtml } from "../src/ui/phone";

// Fixtures only, made-up 10.x addresses.
const NOW = 1_800_000_000_000;

function device(n: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { mac: "aa:bb:cc:00:00:" + n.toString(16).padStart(2, "0"), ip: `10.0.0.${n}`, online: true, known: true, new: false, ...extra };
}

function network(devices: Record<string, unknown>[]): NetworkInfo {
  const parsed = readNetwork({ devices });
  if (!parsed) throw new Error("no network");
  return parsed;
}

function machine(net: NetworkInfo | undefined, name = "Spark"): SourceStatus {
  const report: SourceReport = {
    name,
    metrics: [{ id: "cpu", label: "CPU", value: 12, unit: "%", warn: 85, critical: 95 }],
    ...(net ? { network: net } : {}),
  };
  return applyReport(createSource(name.toLowerCase(), name), report, NOW);
}

describe("the network block of the protocol", () => {
  it("reads devices defensively: bad or repeated MACs go, texts are cut, a known device is never new", () => {
    const parsed = readNetwork({
      total: 4,
      online: 3,
      new: 1,
      devices: [
        device(1, { name: "router" }),
        device(2, { mac: "AA:BB:CC:00:00:02", new: true, known: false, name: "x".repeat(200) }),
        device(3, { mac: "not-a-mac" }),
        device(4, { mac: "aa:bb:cc:00:00:01" }),
        device(5, { new: true, known: true }),
        null,
      ],
    });
    expect(parsed?.total).toBe(4);
    expect(parsed?.devices.map((d) => d.mac)).toEqual(["aa:bb:cc:00:00:01", "aa:bb:cc:00:00:02", "aa:bb:cc:00:00:05"]);
    expect(parsed?.devices[1]?.name).toHaveLength(64);
    expect(parsed?.devices[2]?.new).toBe(false);
  });

  it("counts from the devices when the source gives no numbers, and ignores rubbish", () => {
    const parsed = readNetwork({ devices: [device(1), device(2, { online: false }), device(3, { new: true, known: false })] });
    expect(parsed).toMatchObject({ total: 3, online: 2, new: 1 });
    expect(readNetwork(null)).toBeNull();
    expect(readNetwork([])).toBeNull();
    expect(readNetwork({})).toBeNull();
    expect(readNetwork({ devices: Array.from({ length: 600 }, (_, i) => ({ mac: `aa:bb:cc:00:${(i >> 8).toString(16).padStart(2, "0")}:${(i & 255).toString(16).padStart(2, "0")}` })) })?.devices)
      .toHaveLength(NET_DEVICES_MAX);
  });

  it("is part of a report when sent, and absent otherwise", () => {
    const withNet = reportFromValue({ name: "spark", metrics: [{ id: "cpu", value: 1 }], network: { devices: [device(1)] } });
    expect(withNet.report?.network?.total).toBe(1);
    const without = reportFromValue({ name: "spark", metrics: [{ id: "cpu", value: 1 }] });
    expect(without.report).not.toHaveProperty("network");
  });
});

describe("new devices on the glasses", () => {
  const twoNew = network([device(1), device(2, { new: true, known: false, name: "android-5f3c" }), device(3, { new: true, known: false })]);
  const oneNew = network([device(1), device(2, { new: true, known: false, name: "android-5f3c" }), device(3)]);

  it("become one warning naming the device, in both languages", () => {
    const source = machine(oneNew);
    const list = problems([source], NOW);
    expect(list).toHaveLength(1);
    expect(list[0]?.state).toBe("warn");
    expect(list[0]?.metric.id.startsWith(NET_NEW_PREFIX)).toBe(true);
    expect(describeMetric(list[0]!.metric, "de")).toBe("Neues Gerät im Netz: android-5f3c");
    expect(describeMetric(list[0]!.metric, "en")).toBe("New device on the network: android-5f3c");
    expect(describeMetric(netNewMetric(twoNew)!, "de")).toBe("2 neue Geräte im Netz");
  });

  it("stay seen once acknowledged, but a further newcomer shouts again", () => {
    let source = machine(oneNew);
    const id = problems([source], NOW)[0]!.metric.id;
    source = acknowledge(source, id);
    expect(problems([source], NOW)[0]?.acknowledged).toBe(true);
    source = applyReport(source, { ...source.report!, network: oneNew }, NOW + 1);
    expect(problems([source], NOW)[0]?.acknowledged).toBe(true);
    source = applyReport(source, { ...source.report!, network: twoNew }, NOW + 2);
    expect(problems([source], NOW)[0]?.acknowledged).toBe(false);
    // Once nothing is new the acknowledgement is dropped.
    source = applyReport(source, { ...source.report!, network: network([device(1)]) }, NOW + 3);
    expect(source.acknowledged.some((a) => a.startsWith(NET_NEW_PREFIX))).toBe(false);
    expect(problems([source], NOW + 3)).toHaveLength(0);
  });

  it("raise the headline of the cockpit and mark the machine", () => {
    const sources = [machine(oneNew, "Spark"), machine(undefined, "Pi5")];
    expect(hostTone(sources[0]!, NOW)).toBe("warn");
    expect(hostTone(sources[1]!, NOW)).toBe("ok");
    expect(statusLines(sources, NOW, "de")).toEqual(["1 PROBLEM"]);
    expect(statusLines([sources[1]!], NOW, "de")).toEqual(["ALLES OK"]);
    expect(overviewCells(sources, NOW, "de").slice(0, 3).map((cell) => cell.value)).toEqual(["1", "1", "0"]);
  });

  it("say 'Netz: 23 Geräte · 1 NEU'", () => {
    const many = network([...Array.from({ length: 22 }, (_, i) => device(i + 1)), device(99, { new: true, known: false })]);
    expect(networkLine({ name: "x", metrics: [], network: many }, "de")).toBe("Netz: 23 Geräte · 1 NEU");
    expect(networkLine({ name: "x", metrics: [], network: many }, "en")).toBe("Network: 23 devices · 1 NEW");
    expect(networkLine({ name: "x", metrics: [], network: network([device(1), device(2, { online: false })]) }, "de")).toBe("Netz: 2 Geräte · 1 online");
    expect(networkLine({ name: "x", metrics: [] }, "de")).toBeNull();
    const first = problems([machine(many)], NOW)[0]!;
    expect(describeMetric(first.metric, "de")).toBe("Neues Gerät im Netz: 10.0.0.99");
  });
});

describe("marking a device as known", () => {
  it("posts mac and known to <status url>/devices with the source's token", async () => {
    expect(devicesUrl("https://host.example:8451/status")).toBe("https://host.example:8451/devices");
    expect(devicesUrl("http://10.0.0.5:8099/status?x=1")).toBe("http://10.0.0.5:8099/devices");
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const outcome = await markDeviceKnown("http://10.0.0.5:8099/status", "aa:bb:cc:00:00:02", true, { token: "t0k", fetchImpl });
    expect(outcome).toEqual({ ok: true, error: null });
    expect(calls[0]?.url).toBe("http://10.0.0.5:8099/devices");
    expect(calls[0]?.init.method).toBe("POST");
    expect((calls[0]?.init.headers as Record<string, string>)["Authorization"]).toBe("Bearer t0k");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ mac: "aa:bb:cc:00:00:02", known: true });
  });

  it("reports a refusal or an unreachable server", async () => {
    const refused = (async () => new Response("{}", { status: 403 })) as unknown as typeof fetch;
    expect(await markDeviceKnown("http://10.0.0.5:8099/status", "aa:bb:cc:00:00:02", true, { fetchImpl: refused }))
      .toEqual({ ok: false, error: "HTTP 403" });
    const down = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    expect(await markDeviceKnown("http://10.0.0.5:8099/status", "aa:bb:cc:00:00:02", true, { fetchImpl: down }))
      .toEqual({ ok: false, error: "unreachable" });
  });
});

describe("the device list on the phone", () => {
  it("shows the summary per machine, new devices with a button, known ones without", () => {
    const net = network([device(1, { name: "router" }), device(2, { new: true, known: false, name: "<b>evil</b>" })]);
    const html = networkHtml([{ sourceId: "spark", name: "Spark", network: net }], "de");
    expect(html).toContain("Spark · Netz: 2 Geräte · 1 NEU");
    expect(html).toContain("als bekannt markieren");
    expect(html).toContain('data-mac="aa:bb:cc:00:00:02"');
    expect(html).not.toContain('data-mac="aa:bb:cc:00:00:01"');
    expect(html).toContain("bekannt");
    expect(html).toContain("&lt;b&gt;evil&lt;/b&gt;");
    expect(html).not.toContain("<b>evil");
    expect(networkHtml([{ sourceId: "spark", name: "Spark", network: net }], "en")).toContain("mark as known");
  });

  it("explains how to switch the watch on when no source reports a network", () => {
    expect(networkHtml([], "de")).toContain("STATUS_NETWATCH=1");
    expect(networkHtml([], "en")).toContain("STATUS_NETWATCH=1");
  });
});
