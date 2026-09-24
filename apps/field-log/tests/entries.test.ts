import { describe, it, expect } from "vitest";
import {
  addEntry, attachToLatest, countBySeverity, durationSeconds, finish, nextEntryId,
  removeEntry, setSection, setSeverity, startInspection, toCsv, toMarkdown,
  type Attachment,
} from "../src/log/entries";
import { buildView, severityLabel, truncate, wrap } from "../src/glasses/view";

const photo: Attachment = { dataUri: "data:image/jpeg;base64,AAAA", mimeType: "image/jpeg", size: 2048 };

const started = () => startInspection("i1", "Handover flat 3", 1_000_000);

describe("building a log", () => {
  it("starts empty and open", () => {
    const inspection = started();
    expect(inspection.entries).toEqual([]);
    expect(inspection.finishedAt).toBeNull();
  });

  it("adds entries with a severity", () => {
    const inspection = addEntry(started(), "Scratch on the door", "minor", 1_000_100);
    expect(inspection.entries[0]).toMatchObject({ text: "Scratch on the door", severity: "minor" });
  });

  it("ignores blank speech", () => {
    const inspection = started();
    expect(addEntry(inspection, "   ", "note", 1)).toBe(inspection);
  });

  it("trims whitespace from transcribed text", () => {
    expect(addEntry(started(), "  spaced  ", "note", 1).entries[0]?.text).toBe("spaced");
  });

  it("inherits the current section", () => {
    let inspection = setSection(started(), "Kitchen");
    inspection = addEntry(inspection, "Tap drips", "minor", 1);
    expect(inspection.entries[0]?.section).toBe("Kitchen");
  });

  it("leaves the section off when none is set", () => {
    expect(addEntry(started(), "x", "note", 1).entries[0]?.section).toBeUndefined();
  });

  it("attaches a photo to the entry just spoken", () => {
    let inspection = addEntry(started(), "Cracked tile", "major", 1);
    inspection = attachToLatest(inspection, photo);
    expect(inspection.entries[0]?.attachment?.size).toBe(2048);
  });

  it("ignores a photo when there is nothing to attach it to", () => {
    const inspection = started();
    expect(attachToLatest(inspection, photo)).toBe(inspection);
  });

  it("changes a severity after the fact", () => {
    let inspection = addEntry(started(), "Damp patch", "minor", 1);
    const id = inspection.entries[0]?.id ?? "";
    inspection = setSeverity(inspection, id, "major");
    expect(inspection.entries[0]?.severity).toBe("major");
  });

  it("ignores a severity change for an unknown entry", () => {
    const inspection = addEntry(started(), "x", "note", 1);
    expect(setSeverity(inspection, "gone", "major")).toBe(inspection);
  });

  it("removes an entry", () => {
    let inspection = addEntry(started(), "Wrong", "note", 1);
    inspection = removeEntry(inspection, inspection.entries[0]?.id ?? "");
    expect(inspection.entries).toEqual([]);
  });

  it("hands out unused ids", () => {
    expect(nextEntryId([])).toBe("e1");
  });

  it("finishes once and stays finished", () => {
    const done = finish(started(), 2_000_000);
    expect(done.finishedAt).toBe(2_000_000);
    expect(finish(done, 3_000_000)).toBe(done);
  });

  it("stops the clock when finished", () => {
    const done = finish(started(), 1_060_000);
    expect(durationSeconds(done, 9_000_000)).toBe(60);
    expect(durationSeconds(started(), 1_060_000)).toBe(60);
  });
});

describe("counting", () => {
  it("tallies by severity", () => {
    let inspection = addEntry(started(), "a", "major", 1);
    inspection = addEntry(inspection, "b", "minor", 2);
    inspection = addEntry(inspection, "c", "minor", 3);
    expect(countBySeverity(inspection)).toEqual({ major: 1, minor: 2, note: 0 });
  });
});

describe("markdown export", () => {
  const filled = () => {
    let inspection = setSection(started(), "Kitchen");
    inspection = addEntry(inspection, "Tap drips", "minor", 1_000_100);
    inspection = attachToLatest(inspection, photo);
    inspection = setSection(inspection, "Bathroom");
    inspection = addEntry(inspection, "Mould behind the sink", "major", 1_000_200);
    return finish(inspection, 1_003_600);
  };

  it("titles the report and summarises the counts", () => {
    const md = toMarkdown(filled());
    expect(md).toContain("# Handover flat 3");
    expect(md).toContain("Major: 1");
  });

  it("groups entries under their sections", () => {
    const md = toMarkdown(filled());
    expect(md).toContain("## Kitchen");
    expect(md).toContain("## Bathroom");
  });

  it("marks major findings so they stand out", () => {
    expect(toMarkdown(filled())).toContain("**MAJOR**");
  });

  it("references a photo by size rather than embedding it by default", () => {
    const md = toMarkdown(filled());
    expect(md).toContain("photo attached, 2 kB");
    expect(md).not.toContain("base64");
  });

  it("embeds images only when asked", () => {
    expect(toMarkdown(filled(), true)).toContain("data:image/jpeg;base64");
  });
});

describe("CSV export", () => {
  it("writes a header and one row per entry", () => {
    const inspection = addEntry(setSection(started(), "Hall"), "Loose handle", "minor", 1);
    const lines = toCsv(inspection).trim().split("\n");
    expect(lines[0]).toBe("time,section,severity,text,photo");
    expect(lines[1]).toContain("Hall,minor,Loose handle,no");
  });

  it("quotes text containing a comma", () => {
    const inspection = addEntry(started(), "Cracked, chipped", "note", 1);
    expect(toCsv(inspection)).toContain('"Cracked, chipped"');
  });
});

describe("display", () => {
  const options = {
    phase: "idle" as const,
    severity: "note" as const,
    pending: null,
    status: "idle" as const,
    mock: false,
  };

  it("asks for an inspection when none is running", () => {
    expect(buildView(null, options).body.join(" ")).toContain("phone app");
  });

  it("shows the tally and the last entry while idle", () => {
    const inspection = addEntry(started(), "Cracked tile", "major", 1);
    const view = buildView(inspection, options, 1_060_000);
    expect(view.body[0]).toContain("Cracked tile");
    expect(view.body[1]).toContain("1 major");
  });

  it("says so plainly when nothing has been logged", () => {
    expect(buildView(started(), options).body[0]).toBe("No entries yet.");
  });

  it("shows the microphone indicator while recording", () => {
    const view = buildView(started(), { ...options, phase: "recording" });
    expect(view.footer).toContain("MIC");
  });

  it("marks a mock recogniser", () => {
    const view = buildView(started(), { ...options, phase: "recording", mock: true });
    expect(view.footer).toContain("MOCK");
  });

  it("asks before keeping a transcript, since reports get acted on", () => {
    const view = buildView(started(), { ...options, phase: "review", pending: "Cracked tile" });
    expect(view.header).toBe("Keep this?");
    expect(view.body.join(" ")).toContain("Cracked tile");
    expect(view.footer).toContain("swipe = discard");
  });

  it("offers a photo at the moment the entry is made", () => {
    const view = buildView(started(), { ...options, phase: "review", pending: "x" });
    expect(view.footer).toContain("hold = photo");
  });

  it("uses the section as the header once one is set", () => {
    const inspection = setSection(started(), "Kitchen");
    expect(buildView(inspection, options).header).toBe("Kitchen");
  });
});

describe("text helpers", () => {
  it("wraps and truncates", () => {
    expect(wrap("aaa bbb ccc", 7)).toEqual(["aaa bbb", "ccc"]);
    expect(truncate("much too long here", 10).length).toBeLessThanOrEqual(10);
  });

  it("labels severities", () => {
    expect(severityLabel("major")).toBe("MAJOR");
    expect(severityLabel("note")).toBe("note");
  });
});
