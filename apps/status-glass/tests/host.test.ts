import { describe, expect, it } from "vitest";
import { validateEvenHubPageContainer } from "@evenrealities/even_hub_sdk";
import { applyError, applyReport, createSource } from "../src/monitor/dashboard";
import { MetricHistory } from "../src/monitor/history";
import { DEMO_FLEET, demoFleetReport } from "../src/monitor/demo";
import { compactLine, describeMetric, detailLines, pack, uptimeText } from "../src/glasses/host";
import { DETAIL_ROWS, detailPage, detailSeries } from "../src/glasses/detail";
import { HEADER_WIDTH, LINE_WIDTH } from "../src/glasses/view";
import { buildPage, BODY_ROWS } from "../src/glasses/render";
import { parseReport, type SourceReport } from "../src/protocol/schema";
import { locales } from "../src/i18n";

const NOW = 10_000_000;

const spark = (): SourceReport => demoFleetReport(DEMO_FLEET[0]!, 11);

describe("machine figures", () => {
  it("reads the optional detail text and ignores it when empty", () => {
    const { report } = parseReport(JSON.stringify({ metrics: [
      { id: "memory", label: "RAM", value: 45, detail: " 54/119 GB " },
      { id: "x", label: "X", value: 1, detail: "" },
      { id: "y", label: "Y", value: 1, detail: "z".repeat(500) },
    ] }));
    expect(report!.metrics[0]!.detail).toBe("54/119 GB");
    expect(report!.metrics[1]!.detail).toBeUndefined();
    expect(report!.metrics[2]!.detail!.length).toBe(160);
  });

  it("packs CPU, RAM, fullest disk and temperature into one compact line", () => {
    expect(compactLine(spark(), "de")).toMatch(/^CPU \d+%  RAM \d+%  Disk 71%  \d+°C$/);
    // Without a cpu metric the load stands in.
    expect(compactLine({ name: "x", metrics: [{ id: "load", label: "Load", value: 33.3, unit: "%" }] }, "en")).toBe("CPU 33%");
    expect(compactLine({ name: "x", metrics: [{ id: "door", label: "Door", state: "ok" }] }, "en")).toBeNull();
  });

  it("says failed services, full disks, stopped services and a lost tailnet in words", () => {
    expect(describeMetric({ id: "failed", label: "Failed units", value: 5 }, "de")).toBe("5 Dienste fehlgeschlagen");
    expect(describeMetric({ id: "disk:/data", label: "/data", value: 93.4, unit: "%" }, "de")).toBe("Platte /data 93% voll");
    expect(describeMetric({ id: "svc:nginx", label: "nginx", state: "critical", detail: "failed" }, "en")).toBe("Service nginx: failed");
    expect(describeMetric({ id: "tailscale", label: "Tailscale", state: "critical" }, "de")).toBe("Tailscale offline");
    expect(describeMetric({ id: "t", label: "Attic", value: 41.25, unit: "°C" }, "de")).toBe("Attic 41,3°C");
  });

  it("writes uptime in days and hours", () => {
    expect(uptimeText(5, "de")).toBe("5 h");
    expect(uptimeText(345, "de")).toBe("14 T 9 h");
    expect(uptimeText(345, "en")).toBe("14 d 9 h");
  });

  it("packs items into lines of the display width", () => {
    expect(pack(["a", "b", "c"], 5)).toEqual(["a · b", "c"]);
    expect(pack(["x".repeat(80)]).every((l) => l.length <= LINE_WIDTH)).toBe(true);
  });
});

describe("detail page", () => {
  it("puts warnings first, the names of failed units below them, then every value", () => {
    const report = demoFleetReport(DEMO_FLEET[1]!, 11);
    const lines = detailLines(applyReport(createSource("pi5", "Pi5"), report, NOW), "de", NOW);
    // Warnings on top (RAM 88 % and the failed unit), the unit's name right below it.
    const failed = lines.indexOf("· 1 Dienst fehlgeschlagen");
    expect(failed).toBeGreaterThanOrEqual(0);
    expect(failed).toBeLessThan(3);
    expect(lines[failed + 1]).toBe("  systemd-networkd-wait-online");
    expect(lines.findIndex((l) => l.startsWith("CPU"))).toBeGreaterThan(failed);
    const text = lines.join("\n");
    for (const part of ["CPU", "Last", "RAM", "Swap", "Disk /", "Temp", "Netz RX", "Tailscale online · 13/18 Geräte", "läuft seit 14 T 9 h"]) {
      expect(text, part).toContain(part);
    }
  });

  it("fits every line, both languages, and pages by five", () => {
    for (const locale of locales) {
      for (const machine of DEMO_FLEET) {
        const source = applyReport(createSource(machine.id, machine.name + "-with-a-very-long-hostname-indeed"), demoFleetReport(machine, 11), NOW);
        const lines = detailLines(source, locale, NOW);
        for (const line of lines) expect(line.length, line).toBeLessThanOrEqual(LINE_WIDTH);
        const first = detailPage(source, 0, locale, NOW);
        expect(first.view.header.length).toBeLessThanOrEqual(HEADER_WIDTH);
        expect(first.view.footer.length).toBeLessThanOrEqual(LINE_WIDTH);
        expect(first.view.body.length).toBeLessThanOrEqual(DETAIL_ROWS);
        expect(first.pages).toBe(Math.ceil(lines.length / DETAIL_ROWS));
        // Turning past the last page wraps to the first.
        expect(detailPage(source, first.pages, locale, NOW).page).toBe(0);
        expect(detailPage(source, -1, locale, NOW).page).toBe(first.pages - 1);
      }
    }
  });

  it("names the page and the state in the header", () => {
    const source = applyReport(createSource("spark", "Spark"), spark(), NOW);
    const page = detailPage(source, 1, "de", NOW);
    expect(page.view.header).toMatch(/^Spark · ok · 2\/\d$/);
    const offline = applyError(source, "unreachable", NOW);
    expect(detailPage(offline, 0, "de", NOW).view.header).toMatch(/^Spark · offline/);
    expect(detailPage(offline, 0, "de", NOW).view.body[0]).toBe("! nicht erreichbar");
  });

  it("draws CPU, RAM and GPU, or the temperature on a machine without a GPU", () => {
    const history = new MetricHistory();
    for (let step = 0; step < 12; step += 1) {
      history.record("spark", demoFleetReport(DEMO_FLEET[0]!, step));
      history.record("pi5", demoFleetReport(DEMO_FLEET[1]!, step));
    }
    const sparkSource = applyReport(createSource("spark", "Spark"), spark(), NOW);
    const piSource = applyReport(createSource("pi5", "Pi5"), demoFleetReport(DEMO_FLEET[1]!, 11), NOW);
    expect(detailSeries(sparkSource, history).map((s) => s.label)).toEqual(["CPU", "RAM", "GPU"]);
    expect(detailSeries(piSource, history).map((s) => s.label)).toEqual(["CPU", "RAM", "TEMP"]);
    expect(detailSeries(sparkSource, history)[0]!.values).toHaveLength(12);
  });

  it("records one CPU point per report even when cpu and load both come", () => {
    const history = new MetricHistory();
    history.record("x", { name: "x", metrics: [{ id: "cpu", label: "CPU", value: 10 }, { id: "load", label: "Load", value: 90 }] });
    expect(history.series("x", { name: "x", metrics: [{ id: "cpu", label: "CPU", value: 10 }] })[0]!.values).toEqual([10]);
  });

  it("is a valid page: sign top right, five full-width rows, three sparklines", () => {
    const page = buildPage({ header: "h", body: ["a", "b"], footer: "f" }, "detail");
    expect(validateEvenHubPageContainer(page).valid).toBe(true);
    expect(page.imageObject).toHaveLength(4);
    const body = page.textObject!.find((t) => t.containerID === 2)!;
    expect(body.width).toBe(576);
    expect(body.isEventCapture).toBe(1);
    expect(BODY_ROWS.detail).toBe(5);
    const sign = page.imageObject!.find((i) => i.containerName === "sign")!;
    expect((sign.xPosition ?? 0) + (sign.width ?? 0)).toBe(576);
  });
});
