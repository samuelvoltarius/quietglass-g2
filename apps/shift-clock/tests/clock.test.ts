import { describe, it, expect } from "vitest";
import {
  addEntry, entriesOnDay, entrySeconds, formatClock, formatHours, isRunning,
  MIN_ENTRY_SECONDS, nextEntryId, openSeconds, startOfDay, startProject, stop,
  secondsOnDay, STOPPED, toCsv, totalSeconds, totalsByProject, type TimeEntry,
} from "../src/tracking/clock";
import { parseData, EMPTY_DATA, addProject, removeProject } from "../src/storage/persist";
import { buildView } from "../src/glasses/view";

const ids = () => {
  let n = 0;
  return () => "e" + ++n;
};

const entry = (over: Partial<TimeEntry> = {}): TimeEntry => ({
  id: "e1", project: "Client A", startedAt: 0, endedAt: 3_600_000, ...over,
});

describe("starting and stopping", () => {
  it("starts a project", () => {
    const { state, closed } = startProject(STOPPED, "Client A", 1000, ids());
    expect(state).toEqual({ project: "Client A", startedAt: 1000 });
    expect(closed).toBeNull();
    expect(isRunning(state)).toBe(true);
  });

  it("closes the open entry when stopping", () => {
    const started = startProject(STOPPED, "Client A", 0, ids()).state;
    const { state, closed } = stop(started, 60_000, ids());
    expect(state).toEqual(STOPPED);
    expect(closed).toMatchObject({ project: "Client A", startedAt: 0, endedAt: 60_000 });
  });

  it("switches project in one move, closing the old entry", () => {
    const started = startProject(STOPPED, "Client A", 0, ids()).state;
    const { state, closed } = startProject(started, "Client B", 60_000, ids());

    expect(closed?.project).toBe("Client A");
    expect(state).toEqual({ project: "Client B", startedAt: 60_000 });
  });

  it("leaves no gap when switching", () => {
    const started = startProject(STOPPED, "A", 0, ids()).state;
    const switched = startProject(started, "B", 60_000, ids());
    expect(switched.closed?.endedAt).toBe(switched.state.startedAt);
  });

  it("discards a fumble rather than recording it", () => {
    const started = startProject(STOPPED, "A", 0, ids()).state;
    const { closed } = stop(started, (MIN_ENTRY_SECONDS - 1) * 1000, ids());
    expect(closed).toBeNull();
  });

  it("records an entry at exactly the minimum", () => {
    const started = startProject(STOPPED, "A", 0, ids()).state;
    expect(stop(started, MIN_ENTRY_SECONDS * 1000, ids()).closed).not.toBeNull();
  });

  it("stopping when already stopped closes nothing", () => {
    expect(stop(STOPPED, 1000, ids()).closed).toBeNull();
  });

  it("reports the open duration", () => {
    const started = startProject(STOPPED, "A", 1000, ids()).state;
    expect(openSeconds(started, 6000)).toBe(5);
    expect(openSeconds(STOPPED, 6000)).toBe(0);
  });
});

describe("entries", () => {
  it("measures and sums durations", () => {
    expect(entrySeconds(entry())).toBe(3600);
    expect(totalSeconds([entry(), entry({ id: "e2" })])).toBe(7200);
  });

  it("totals per project, largest first", () => {
    const entries = [
      entry({ id: "a", project: "A", startedAt: 0, endedAt: 3_600_000 }),
      entry({ id: "b", project: "B", startedAt: 0, endedAt: 1_800_000 }),
      entry({ id: "c", project: "A", startedAt: 0, endedAt: 1_800_000 }),
    ];
    expect(totalsByProject(entries)).toEqual([
      { project: "A", seconds: 5400 },
      { project: "B", seconds: 1800 },
    ]);
  });

  it("filters to one calendar day", () => {
    const now = Date.now();
    const day = startOfDay(now);
    const todayEntry = entry({ id: "t", startedAt: day + 3_600_000, endedAt: day + 7_200_000 });
    const yesterday = entry({ id: "y", startedAt: day - 3_600_000, endedAt: day - 1000 });
    expect(entriesOnDay([yesterday, todayEntry], day).map((e) => e.id)).toEqual(["t"]);
  });

  it("bounds the log so storage cannot grow forever", () => {
    let entries: TimeEntry[] = [];
    for (let i = 0; i < 12; i++) entries = addEntry(entries, entry({ id: "e" + i }), 10);
    expect(entries).toHaveLength(10);
  });

  it("hands out unused ids", () => {
    expect(nextEntryId([])).toBe("e1");
    expect(nextEntryId([entry({ id: "e1" })])).toBe("e2");
  });
});

describe("formatting", () => {
  it("omits hours until there are any", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(83)).toBe("1:23");
    expect(formatClock(7500)).toBe("2:05:00");
  });

  it("gives decimal hours for invoicing", () => {
    expect(formatHours(3600)).toBe("1.00");
    expect(formatHours(5400)).toBe("1.50");
  });

  it("never formats negative time", () => {
    expect(formatClock(-10)).toBe("0:00");
  });
});

describe("CSV export", () => {
  it("writes a header and one row per entry", () => {
    const lines = toCsv([entry()]).trim().split("\n");
    expect(lines[0]).toBe("date,project,start,end,seconds,hours");
    expect(lines[1]).toContain("Client A");
    expect(lines[1]).toContain("3600,1.00");
  });

  it("quotes a project name containing a comma", () => {
    expect(toCsv([entry({ project: "Smith, John" })])).toContain('"Smith, John"');
  });
});

describe("storage", () => {
  it("falls back cleanly on corrupt data", () => {
    expect(parseData("{nope")).toEqual(EMPTY_DATA);
  });

  it("keeps a running clock across a restart", () => {
    const parsed = parseData(JSON.stringify({ open: { project: "A", startedAt: 1000 } }));
    expect(parsed.open).toEqual({ project: "A", startedAt: 1000 });
  });

  it("discards a half-open entry, which has no duration", () => {
    expect(parseData(JSON.stringify({ open: { project: "A" } })).open).toEqual(EMPTY_DATA.open);
    expect(parseData(JSON.stringify({ open: { startedAt: 5 } })).open).toEqual(EMPTY_DATA.open);
  });

  it("drops an entry that ends before it starts", () => {
    const parsed = parseData(JSON.stringify({
      entries: [{ id: "bad", project: "A", startedAt: 100, endedAt: 50 }],
    }));
    expect(parsed.entries).toHaveLength(0);
  });

  it("adds and removes projects without duplicates", () => {
    let data = addProject(EMPTY_DATA, "A");
    data = addProject(data, "A");
    expect(data.projects).toEqual(["A"]);
    expect(removeProject(data, "A").projects).toEqual([]);
  });
});

describe("display", () => {
  const projects = ["Client A", "Client B"];

  it("asks for a project when none exist", () => {
    expect(buildView(STOPPED, [], {}, 0).body.join(" ")).toContain("phone app");
  });

  it("shows the picker while choosing", () => {
    const view = buildView(STOPPED, [], { projects, selecting: "Client B" }, 0);
    expect(view.body).toContain("> Client B");
    expect(view.footer).toContain("tap = start");
  });

  it("shows the running clock and the project", () => {
    const started = startProject(STOPPED, "Client A", 0, ids()).state;
    const view = buildView(started, [], { projects }, 65_000);
    expect(view.header).toBe("Client A");
    expect(view.body[0]).toBe("1:05");
    expect(view.footer).toContain("tap = stop");
  });

  it("includes the running entry in today's total", () => {
    const day = startOfDay(Date.now());
    const earlier = entry({ startedAt: day, endedAt: day + 60_000 });
    const started = startProject(STOPPED, "Client A", day + 120_000, ids()).state;

    const view = buildView(started, [earlier], { projects }, day + 180_000);
    // 60s recorded + 60s still running
    expect(view.footer).toContain("2:00");
  });

  it("states plainly when nothing is being tracked", () => {
    const view = buildView(STOPPED, [], { projects }, 0);
    expect(view.body).toContain("stopped");
    expect(view.footer).toContain("tap = choose project");
  });
});

describe("days and midnight", () => {
  const at = (y: number, m: number, d: number, h: number, min = 0): number => new Date(y, m - 1, d, h, min).getTime();

  it("regression: a shift across midnight counts each part on its own day", () => {
    const night = entry({ startedAt: at(2026, 3, 9, 22), endedAt: at(2026, 3, 10, 2) });
    expect(secondsOnDay([night], startOfDay(at(2026, 3, 9, 12)))).toBe(2 * 3600);
    expect(secondsOnDay([night], startOfDay(at(2026, 3, 10, 12)))).toBe(2 * 3600);
    expect(entriesOnDay([night], startOfDay(at(2026, 3, 10, 12)))).toHaveLength(1);
  });

  it("regression: after midnight, today's total counts only today's part of the running entry", () => {
    const started = startProject(STOPPED, "Client A", at(2026, 3, 9, 23), ids()).state;
    const view = buildView(started, [], { projects: ["Client A"] }, at(2026, 3, 10, 1));
    expect(view.body[0]).toBe("2:00:00");
    expect(view.footer).toContain("today 1:00:00");
  });

  it("regression: a day is a calendar day, not 24 hours, across a DST change", () => {
    // Whatever the zone, the day after a day start is the next local midnight.
    for (const day of [at(2026, 3, 29, 12), at(2026, 10, 25, 12)]) {
      const start = startOfDay(day);
      const late = entry({ startedAt: start + 23.5 * 3_600_000 - 1, endedAt: start + 23.5 * 3_600_000 });
      const endsToday = new Date(late.startedAt).getDate() === new Date(day).getDate();
      expect(entriesOnDay([late], start).length).toBe(endsToday ? 1 : 0);
    }
  });

  it("regression: the CSV date is the local calendar date of the start", () => {
    const early = entry({ startedAt: at(2026, 3, 10, 0, 30), endedAt: at(2026, 3, 10, 1, 30) });
    const row = toCsv([early]).trim().split("\n")[1] ?? "";
    expect(row.startsWith("2026-03-10,")).toBe(true);
  });

  it("regression: a project name cannot smuggle a formula into the CSV", () => {
    for (const name of ["=HYPERLINK(\"http://x\")", "+cmd", "-1", "@SUM(A1)"]) {
      const row = toCsv([entry({ project: name })]).trim().split("\n")[1] ?? "";
      expect(row.split(",")[1]?.replace(/^"/, "").startsWith("'")).toBe(true);
    }
  });

  it("regression: a carriage return in a project name is quoted", () => {
    expect(toCsv([entry({ project: "A\rB" })])).toContain('"A\rB"');
  });
});

describe("display budget", () => {
  it("regression: a long project list keeps the picker within seven rows and the choice visible", () => {
    const many = Array.from({ length: 12 }, (_, i) => "Project " + i);
    const view = buildView(STOPPED, [], { projects: many, selecting: "Project 10" }, 0);
    expect(view.body.length).toBeLessThanOrEqual(7);
    expect(view.body).toContain("> Project 10");
  });

  it("regression: a long project name is cut to the line", () => {
    const name = "Very long client name with a job number and a task ".repeat(2);
    const picker = buildView(STOPPED, [], { projects: [name], selecting: name }, 0);
    for (const row of picker.body) expect(row.length).toBeLessThanOrEqual(38);
    const running = buildView(startProject(STOPPED, name, 0, ids()).state, [], { projects: [name] }, 1000);
    expect(running.header.length).toBeLessThanOrEqual(46);
  });
});
