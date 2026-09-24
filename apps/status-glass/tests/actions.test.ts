import { describe, it, expect, vi } from "vitest";
import { reportFromValue, type Action } from "../src/protocol/schema";
import { actionUrl, runAction } from "../src/protocol/fetcher";
import { availableActions, buildActionsView } from "../src/glasses/actions-view";
import { applyReport, createSource } from "../src/monitor/dashboard";

const report = (actions: unknown) => ({
  name: "home",
  metrics: [{ id: "t", label: "Temp", value: 21 }],
  actions,
});

const sourceWith = (actions: readonly Action[]) =>
  applyReport(createSource("s1", "home"), {
    name: "home",
    metrics: [],
    actions,
  }, 0);

describe("parsing actions", () => {
  it("reads id, label and confirm", () => {
    const { report: parsed } = reportFromValue(report([
      { id: "light", label: "Kitchen light" },
      { id: "door", label: "Front door", confirm: true },
    ]));
    expect(parsed?.actions).toEqual([
      { id: "light", label: "Kitchen light" },
      { id: "door", label: "Front door", confirm: true },
    ]);
  });

  it("leaves actions absent for a read-only source", () => {
    expect(reportFromValue({ name: "n", metrics: [] }).report?.actions).toBeUndefined();
  });

  it("falls back to the id as the label", () => {
    const { report: parsed } = reportFromValue(report([{ id: "x" }]));
    expect(parsed?.actions?.[0]?.label).toBe("x");
  });

  it("drops an action without an id, which could not be run anyway", () => {
    const { report: parsed, errors } = reportFromValue(report([{ label: "nameless" }]));
    expect(parsed?.actions).toBeUndefined();
    expect(errors.join(" ")).toContain("without an id");
  });

  it("drops a duplicate id, which would run the wrong thing", () => {
    const { report: parsed, errors } = reportFromValue(report([
      { id: "same", label: "First" },
      { id: "same", label: "Second" },
    ]));
    expect(parsed?.actions).toHaveLength(1);
    expect(parsed?.actions?.[0]?.label).toBe("First");
    expect(errors.join(" ")).toContain("Duplicate");
  });

  it("only treats an explicit true as needing confirmation", () => {
    const { report: parsed } = reportFromValue(report([
      { id: "a", label: "A", confirm: "yes" },
      { id: "b", label: "B", confirm: false },
    ]));
    expect(parsed?.actions?.[0]?.confirm).toBeUndefined();
    expect(parsed?.actions?.[1]?.confirm).toBeUndefined();
  });

  it("ignores a non-array actions field", () => {
    expect(reportFromValue(report("nonsense")).report?.actions).toBeUndefined();
  });
});

describe("action endpoint", () => {
  it("replaces the last path segment with action", () => {
    expect(actionUrl("https://h/status")).toBe("https://h/action");
    expect(actionUrl("https://h:8100/api/status")).toBe("https://h:8100/api/action");
  });

  it("drops any query string", () => {
    expect(actionUrl("https://h/status?token=abc")).toBe("https://h/action");
  });

  it("sends the id in the body, never in the URL", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).not.toContain("light.kitchen");
      expect(JSON.parse(String(init?.body))).toEqual({ id: "light.kitchen" });
      expect(init?.method).toBe("POST");
      return new Response("{}", { status: 200 });
    });
    const outcome = await runAction("https://h/status", "light.kitchen", { fetchImpl: fetchImpl as never });
    expect(outcome.ok).toBe(true);
  });

  it("sends the token as a header", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>)["Authorization"]).toBe("Bearer secret");
      return new Response("{}", { status: 200 });
    });
    await runAction("https://h/status", "x", { token: "secret", fetchImpl: fetchImpl as never });
  });

  it("reports a refusal without throwing", async () => {
    const fetchImpl = vi.fn(async () => new Response("no", { status: 403 }));
    const outcome = await runAction("https://h/status", "x", { fetchImpl: fetchImpl as never });
    expect(outcome).toEqual({ ok: false, error: "HTTP 403" });
  });

  it("reports an unreachable source without leaking internals", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    const outcome = await runAction("https://h/status", "x", { fetchImpl: fetchImpl as never });
    expect(outcome.error).toBe("unreachable");
  });
});

describe("collecting actions across sources", () => {
  it("gathers every action with its source", () => {
    const a = sourceWith([{ id: "x", label: "X" }]);
    const b = applyReport(createSource("s2", "nas"), {
      name: "nas", metrics: [], actions: [{ id: "y", label: "Y" }],
    }, 0);

    expect(availableActions([a, b]).map((e) => [e.sourceName, e.action.id]))
      .toEqual([["home", "x"], ["nas", "y"]]);
  });

  it("returns nothing when every source is read-only", () => {
    expect(availableActions([applyReport(createSource("s1", "n"), { name: "n", metrics: [] }, 0)]))
      .toEqual([]);
  });
});

describe("actions screen", () => {
  const base = { cursor: 0, pendingId: null, result: null, busy: false };
  const actions = availableActions([sourceWith([
    { id: "light", label: "Kitchen light" },
    { id: "door", label: "Front door", confirm: true },
  ])]);

  it("explains that sources are read-only by default when there are none", () => {
    const view = buildActionsView([], base);
    expect(view.body.join(" ")).toContain("read-only");
  });

  it("lists actions with their source", () => {
    const view = buildActionsView(actions, base);
    expect(view.body[0]).toContain("home Kitchen light");
  });

  it("marks actions that need confirmation before they are selected", () => {
    const view = buildActionsView(actions, base);
    expect(view.body[1]).toContain("!");
  });

  it("offers a direct run for a harmless action", () => {
    expect(buildActionsView(actions, base).footer).toContain("tap = run");
  });

  it("demands a confirmation first for a consequential one", () => {
    expect(buildActionsView(actions, { ...base, cursor: 1 }).footer).toContain("confirm first");
  });

  it("asks plainly once confirmation is pending", () => {
    const view = buildActionsView(actions, { ...base, cursor: 1, pendingId: "door" });
    expect(view.body[1]).toContain("CONFIRM:");
    expect(view.footer).toContain("tap again = run");
    expect(view.footer).toContain("swipe = cancel");
  });

  it("shows progress and the outcome", () => {
    expect(buildActionsView(actions, { ...base, busy: true }).header).toBe("Running…");
    expect(buildActionsView(actions, { ...base, result: { label: "Kitchen light", ok: true } }).header)
      .toBe("Done");
    expect(buildActionsView(actions, { ...base, result: { label: "HTTP 403", ok: false } }).header)
      .toBe("Failed");
  });

  it("keeps the selection on screen in a long list", () => {
    const many = availableActions([sourceWith(
      Array.from({ length: 12 }, (_, i) => ({ id: "a" + i, label: "Action " + i })),
    )]);
    const view = buildActionsView(many, { ...base, cursor: 10, maxRows: 3 });
    expect(view.body.some((l) => l.startsWith("> "))).toBe(true);
    expect(view.body).toHaveLength(3);
  });

  it("clamps an out-of-range cursor", () => {
    expect(buildActionsView(actions, { ...base, cursor: 99 }).body.some((l) => l.startsWith("> ")))
      .toBe(true);
  });
});
