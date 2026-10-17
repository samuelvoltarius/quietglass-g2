import { describe, expect, it } from "vitest";
import { validateEvenHubPageContainer } from "@evenrealities/even_hub_sdk";
import { DEMO_FLEET, demoFleetReport } from "../src/monitor/demo";
import { compactLine, describeMetric } from "../src/glasses/host";
import { BODY_ROWS, buildCockpitPage, buildTextPage } from "../src/glasses/page";
import { parseReport, type SourceReport } from "../src/protocol/schema";

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
    expect(describeMetric({ id: "disk:/data", label: "/data", value: 93.4, unit: "%" }, "de")).toBe("Disk /data 93% voll");
    expect(describeMetric({ id: "svc:nginx", label: "nginx", state: "critical", detail: "failed" }, "en")).toBe("Service nginx: failed");
    expect(describeMetric({ id: "tailscale", label: "Tailscale", state: "critical" }, "de")).toBe("Tailscale offline");
    expect(describeMetric({ id: "t", label: "Attic", value: 41.25, unit: "°C" }, "de")).toBe("Attic 41,3°C");
  });

});

describe("pages are valid for the glasses", () => {
  it("text page: full-width header, body and footer, the body owns the input", () => {
    const page = buildTextPage({ header: "h", body: ["a", "b"], footer: "f" });
    expect(validateEvenHubPageContainer(page).valid).toBe(true);
    expect(page.textObject).toHaveLength(3);
    expect(page.imageObject ?? []).toHaveLength(0);
    const body = page.textObject!.find((t) => t.containerID === 2)!;
    expect(body.width).toBe(576);
    expect(body.isEventCapture).toBe(1);
    expect(page.textObject!.filter((t) => t.isEventCapture === 1)).toHaveLength(1);
    expect(page.menuObject).toBeUndefined();
  });

  it("cockpit page: four 288 x 144 tiles covering the display and one input container", () => {
    const page = buildCockpitPage();
    expect(validateEvenHubPageContainer(page).valid).toBe(true);
    expect(page.imageObject).toHaveLength(4);
    for (const image of page.imageObject!) { expect(image.width).toBe(288); expect(image.height).toBe(144); }
    expect(page.imageObject!.map((i) => [i.xPosition, i.yPosition])).toEqual([[0, 0], [288, 0], [0, 144], [288, 144]]);
    expect(page.textObject).toHaveLength(1);
    expect(page.textObject![0]!.isEventCapture).toBe(1);
    expect(page.menuObject).toBeUndefined();
    expect(BODY_ROWS).toBe(5);
  });
});
