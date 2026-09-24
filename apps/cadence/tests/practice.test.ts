import { describe, it, expect } from "vitest";
import {
  addSession, bestTempoByItem, durationSeconds, formatDuration, nextSessionId,
  sessionsToday, toCsv, totalsByItem, totalSeconds, type PracticeSession,
} from "../src/practice/log";
import { parseData, EMPTY_DATA, addItem, removeItem } from "../src/storage/persist";
import { buildView, beatRow, signatureLabel } from "../src/glasses/view";
import { createState, start, type MetronomeSettings } from "../src/metronome/engine";

const session = (over: Partial<PracticeSession> = {}): PracticeSession => ({
  id: "p1", item: "Scales", bpm: 100, startedAt: 1_000_000, endedAt: 1_060_000, ...over,
});

describe("practice sessions", () => {
  it("measures duration in whole seconds", () => {
    expect(durationSeconds(session())).toBe(60);
    expect(durationSeconds(session({ endedAt: 1_000_000 }))).toBe(0);
  });

  it("never reports a negative duration", () => {
    expect(durationSeconds(session({ endedAt: 0 }))).toBe(0);
  });

  it("sums total time", () => {
    expect(totalSeconds([session(), session({ id: "p2" })])).toBe(120);
  });

  it("bounds the stored log so storage cannot grow forever", () => {
    let sessions: PracticeSession[] = [];
    for (let i = 0; i < 12; i++) sessions = addSession(sessions, session({ id: "p" + i }), 10);
    expect(sessions).toHaveLength(10);
    expect(sessions[0]?.id).toBe("p2");
  });

  it("hands out unused ids", () => {
    expect(nextSessionId([])).toBe("p1");
    expect(nextSessionId([session({ id: "p1" }), session({ id: "p2" })])).toBe("p3");
  });
});

describe("summaries", () => {
  const sessions = [
    session({ id: "a", item: "Scales", bpm: 100, startedAt: 0, endedAt: 60_000 }),
    session({ id: "b", item: "Scales", bpm: 120, startedAt: 0, endedAt: 120_000 }),
    session({ id: "c", item: "Study", bpm: 80, startedAt: 0, endedAt: 30_000 }),
  ];

  it("totals time per item, largest first", () => {
    expect(totalsByItem(sessions)).toEqual([
      { item: "Scales", seconds: 180 },
      { item: "Study", seconds: 30 },
    ]);
  });

  it("reports the fastest tempo actually held per item", () => {
    expect(bestTempoByItem(sessions)[0]).toEqual({ item: "Scales", bpm: 120 });
  });

  it("ignores a brief burst when recording a best tempo", () => {
    // Ten seconds at 200 bpm is not a tempo you can play; it must not count.
    const withBurst = [...sessions, session({ id: "d", item: "Scales", bpm: 200, startedAt: 0, endedAt: 10_000 })];
    expect(bestTempoByItem(withBurst).find((b) => b.item === "Scales")?.bpm).toBe(120);
  });

  it("filters to the current day", () => {
    const now = Date.now();
    const today = session({ id: "t", startedAt: now - 1000, endedAt: now });
    const old = session({ id: "o", startedAt: now - 5 * 86_400_000, endedAt: now - 5 * 86_400_000 + 1000 });
    expect(sessionsToday([old, today], now).map((s) => s.id)).toEqual(["t"]);
  });
});

describe("CSV export", () => {
  it("writes a header and one row per session", () => {
    const lines = toCsv([session()]).trim().split("\n");
    expect(lines[0]).toBe("date,item,bpm,seconds");
    expect(lines[1]).toContain("Scales,100,60");
  });

  it("quotes fields containing a comma or quote", () => {
    const csv = toCsv([session({ item: 'Bar 34, "slow"' })]);
    expect(csv).toContain('"Bar 34, ""slow"""');
  });
});

describe("formatting", () => {
  it("scales the unit to the length", () => {
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(90)).toBe("1m 30s");
    expect(formatDuration(3700)).toBe("1h 1m");
  });
});

describe("storage", () => {
  it("falls back cleanly on corrupt data", () => {
    expect(parseData("{nope")).toEqual(EMPTY_DATA);
  });

  it("drops malformed sessions but keeps good ones", () => {
    const parsed = parseData(JSON.stringify({
      sessions: [{ id: "x" }, { id: "y", startedAt: 1, endedAt: 2, bpm: 90, item: "A" }],
    }));
    expect(parsed.sessions).toHaveLength(1);
    expect(parsed.sessions[0]?.id).toBe("y");
  });

  it("clamps a stored tempo that is out of range", () => {
    const parsed = parseData(JSON.stringify({ settings: { bpm: 9000 } }));
    expect(parsed.settings.bpm).toBe(240);
  });

  it("rejects a nonsense time signature", () => {
    const parsed = parseData(JSON.stringify({ settings: { signature: { beats: 0, unit: 7 } } }));
    expect(parsed.settings.signature).toEqual({ beats: 1, unit: 4 });
  });

  it("repairs an active item that is not in the list", () => {
    const parsed = parseData(JSON.stringify({ items: ["A"], activeItem: "ghost" }));
    expect(parsed.activeItem).toBe("A");
  });

  it("adds and removes items without duplicates", () => {
    let data = addItem(EMPTY_DATA, "Scales");
    data = addItem(data, "Scales");
    expect(data.items).toEqual(["Scales"]);
    expect(data.activeItem).toBe("Scales");

    data = addItem(data, "Study");
    data = removeItem(data, "Scales");
    expect(data.items).toEqual(["Study"]);
    expect(data.activeItem).toBe("Study");
  });

  it("ignores a blank item", () => {
    expect(addItem(EMPTY_DATA, "   ")).toBe(EMPTY_DATA);
  });
});

describe("beat display", () => {
  const settings: MetronomeSettings = { bpm: 120, signature: { beats: 4, unit: 4 }, mark: "beat" };

  it("draws one marker per beat", () => {
    expect(beatRow(settings, 1, false).split("  ")).toHaveLength(4);
  });

  it("gives the downbeat its own shape when it is current", () => {
    expect(beatRow(settings, 1, true).startsWith("◆")).toBe(true);
  });

  it("fills the current beat", () => {
    expect(beatRow(settings, 2, true).split("  ")[1]).toBe("●");
  });

  it("marks nothing while stopped", () => {
    expect(beatRow(settings, 2, false)).not.toContain("●");
  });

  it("marks only the downbeat in bar mode", () => {
    const barMode: MetronomeSettings = { ...settings, mark: "bar" };
    expect(beatRow(barMode, 2, true)).not.toContain("●");
    expect(beatRow(barMode, 1, true)).toContain("◆");
  });

  it("labels the signature", () => {
    expect(signatureLabel(settings)).toBe("4/4");
  });

  it("shows tempo, signature and bar in the body", () => {
    const view = buildView(start(createState(), 0), settings, {}, 0);
    expect(view.body[1]).toContain("120 bpm");
    expect(view.body[1]).toContain("4/4");
    expect(view.body[1]).toContain("bar 1");
  });

  it("names the practised item in the header", () => {
    const view = buildView(createState(), settings, { item: "Scales" }, 0);
    expect(view.header).toBe("Scales");
  });

  it("states the transport in the footer", () => {
    expect(buildView(createState(), settings, {}, 0).footer).toContain("tap = start");
    expect(buildView(start(createState(), 0), settings, {}, 0).footer).toContain("tap = pause");
  });
});
