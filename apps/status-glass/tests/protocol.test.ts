import { describe, it, expect } from "vitest";
import {
  formatMetric, metricState, parseReport, reportFromValue, worstState, type Metric,
} from "../src/protocol/schema";
import {
  acknowledge, applyError, applyReport, clearRecovered, createSource, isStale,
  overallState, problems, sourceState, STALE_AFTER_MS, unacknowledgedProblems,
} from "../src/monitor/dashboard";

const metric = (over: Partial<Metric> = {}): Metric => ({ id: "cpu", label: "CPU", ...over });

describe("parsing reports", () => {
  it("reads a minimal report", () => {
    const { report, errors } = parseReport('{"name":"nas","metrics":[{"id":"cpu","label":"CPU","value":34}]}');
    expect(errors).toEqual([]);
    expect(report?.name).toBe("nas");
    expect(report?.metrics[0]).toMatchObject({ id: "cpu", value: 34 });
  });

  it("rejects non-JSON and non-objects without throwing", () => {
    expect(parseReport("not json").report).toBeNull();
    expect(parseReport("[1,2,3]").report).toBeNull();
    expect(parseReport('"text"').report).toBeNull();
  });

  it("requires a metrics array", () => {
    const { report, errors } = parseReport('{"name":"nas"}');
    expect(report).toBeNull();
    expect(errors.join(" ")).toContain("metrics");
  });

  it("names an unnamed source from the fallback", () => {
    expect(parseReport('{"metrics":[]}', "pi").report?.name).toBe("pi");
  });

  it("invents ids and labels so a sloppy source still works", () => {
    const { report } = reportFromValue({ metrics: [{ value: 1 }] });
    expect(report?.metrics[0]).toMatchObject({ id: "m1", label: "m1", value: 1 });
  });

  it("drops a metric with neither value nor state but keeps the rest", () => {
    const { report, errors } = reportFromValue({
      metrics: [{ id: "a", label: "A" }, { id: "b", label: "B", value: 2 }],
    });
    expect(report?.metrics).toHaveLength(1);
    expect(errors.join(" ")).toContain("neither");
  });

  it("ignores an invalid state rather than trusting it", () => {
    const { report } = reportFromValue({ metrics: [{ id: "a", label: "A", state: "exploded", value: 1 }] });
    expect(report?.metrics[0]?.state).toBeUndefined();
  });
});

describe("judging metrics", () => {
  it("compares against thresholds, higher being worse by default", () => {
    expect(metricState(metric({ value: 50, warn: 80, critical: 95 }))).toBe("ok");
    expect(metricState(metric({ value: 85, warn: 80, critical: 95 }))).toBe("warn");
    expect(metricState(metric({ value: 99, warn: 80, critical: 95 }))).toBe("critical");
  });

  it("inverts the comparison for metrics where low is bad", () => {
    const free = metric({ id: "free", value: 5, warn: 20, critical: 10, lowerIsWorse: true });
    expect(metricState(free)).toBe("critical");
    expect(metricState({ ...free, value: 15 })).toBe("warn");
    expect(metricState({ ...free, value: 50 })).toBe("ok");
  });

  it("lets an explicit state win over thresholds", () => {
    expect(metricState(metric({ value: 1, warn: 80, state: "critical" }))).toBe("critical");
  });

  it("is unknown without a value or state", () => {
    expect(metricState(metric({}))).toBe("unknown");
  });

  it("is ok when no thresholds are given", () => {
    expect(metricState(metric({ value: 9999 }))).toBe("ok");
  });

  it("ranks critical above warn above unknown above ok", () => {
    expect(worstState(["ok", "warn", "critical"])).toBe("critical");
    expect(worstState(["ok", "unknown"])).toBe("unknown");
    expect(worstState(["ok", "ok"])).toBe("ok");
    expect(worstState([])).toBe("ok");
  });
});

describe("formatting", () => {
  it("appends the unit and rounds sensibly", () => {
    expect(formatMetric(metric({ value: 34.56, unit: "%" }))).toBe("CPU 34.6%");
    expect(formatMetric(metric({ value: 1234.5, unit: "MB" }))).toBe("CPU 1235MB");
  });

  it("shows only the label for a state-only metric", () => {
    expect(formatMetric(metric({ label: "Web", state: "ok" }))).toBe("Web");
  });
});

describe("source health", () => {
  const report = { name: "nas", metrics: [metric({ value: 10, warn: 80 })] };

  it("is ok when fresh and healthy", () => {
    const source = applyReport(createSource("s1", "nas"), report, 1000);
    expect(sourceState(source, 1000)).toBe("ok");
  });

  it("goes unknown when stale — silence must never look like health", () => {
    const source = applyReport(createSource("s1", "nas"), report, 0);
    expect(isStale(source, STALE_AFTER_MS + 1)).toBe(true);
    expect(sourceState(source, STALE_AFTER_MS + 1)).toBe("unknown");
  });

  it("goes unknown on a transport error, not ok", () => {
    const source = applyError(createSource("s1", "nas"), "timeout", 1000);
    expect(sourceState(source, 1000)).toBe("unknown");
  });

  it("is unknown before it has ever answered", () => {
    expect(sourceState(createSource("s1", "nas"), 1000)).toBe("unknown");
  });

  it("takes the worst metric as the source state", () => {
    const mixed = { name: "nas", metrics: [metric({ value: 10, warn: 80 }), metric({ id: "d", label: "Disk", value: 99, warn: 80, critical: 95 })] };
    expect(sourceState(applyReport(createSource("s1", "nas"), mixed, 0), 0)).toBe("critical");
  });

  it("takes the worst source as the overall state", () => {
    const good = applyReport(createSource("a", "a"), report, 0);
    const bad = applyError(createSource("b", "b"), "down", 0);
    expect(overallState([good, bad], 0)).toBe("unknown");
    expect(overallState([], 0)).toBe("unknown");
  });
});

describe("problems", () => {
  const unhealthy = {
    name: "nas",
    metrics: [
      metric({ id: "cpu", label: "CPU", value: 10, warn: 80 }),
      metric({ id: "disk", label: "Disk", value: 99, warn: 80, critical: 95 }),
      metric({ id: "ram", label: "RAM", value: 85, warn: 80, critical: 95 }),
    ],
  };

  it("lists only what is not healthy, worst first", () => {
    const source = applyReport(createSource("s1", "nas"), unhealthy, 0);
    const list = problems([source], 0);
    expect(list.map((p) => p.metric.id)).toEqual(["disk", "ram"]);
  });

  it("stays empty when everything is fine", () => {
    const healthy = { name: "nas", metrics: [metric({ value: 1, warn: 80 })] };
    expect(problems([applyReport(createSource("s1", "nas"), healthy, 0)], 0)).toEqual([]);
  });

  it("reports an unreachable source as a problem", () => {
    const source = applyError(createSource("s1", "nas"), "connection refused", 0);
    expect(problems([source], 0)[0]?.metric.label).toBe("connection refused");
  });

  it("reports a stale source as having no data", () => {
    const source = applyReport(createSource("s1", "nas"), { name: "nas", metrics: [] }, 0);
    expect(problems([source], STALE_AFTER_MS + 1)[0]?.metric.id).toBe("__stale");
  });

  it("pushes acknowledged problems to the end without hiding them", () => {
    let source = applyReport(createSource("s1", "nas"), unhealthy, 0);
    source = acknowledge(source, "disk");

    const list = problems([source], 0);
    expect(list).toHaveLength(2);
    expect(list[0]?.metric.id).toBe("ram");
    expect(list[1]?.acknowledged).toBe(true);
    expect(unacknowledgedProblems([source], 0).map((p) => p.metric.id)).toEqual(["ram"]);
  });

  it("lets a recovered metric shout again", () => {
    let source = applyReport(createSource("s1", "nas"), unhealthy, 0);
    source = acknowledge(source, "disk");
    expect(source.acknowledged).toContain("disk");

    const recovered = { name: "nas", metrics: [metric({ id: "disk", label: "Disk", value: 10, warn: 80 })] };
    source = applyReport(source, recovered, 1000);
    expect(source.acknowledged).not.toContain("disk");
  });

  it("does not acknowledge the same metric twice", () => {
    const source = acknowledge(acknowledge(createSource("s1", "nas"), "x"), "x");
    expect(source.acknowledged).toEqual(["x"]);
  });

  it("leaves acknowledgements alone when there is no report", () => {
    const source = acknowledge(createSource("s1", "nas"), "x");
    expect(clearRecovered(source)).toBe(source);
  });
});
