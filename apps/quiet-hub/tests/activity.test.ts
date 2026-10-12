import { describe, expect, it } from "vitest";
import { describeActivity, elapsedShort, workingDots } from "../src/hub/activity";
import { workingLine } from "../src/hub/model";
import type { AgentInfo } from "../src/api/types";

describe("readable agent activity", () => {
  it("maps raw tool lines of Claude, Codex and Hermes to plain words", () => {
    expect(describeActivity("Bash: npm test", "de")).toMatchObject({ kind: "test", label: "Führt Tests aus", detail: "npm test" });
    expect(describeActivity("exec: git status", "de")).toMatchObject({ kind: "git", detail: "git status" });
    expect(describeActivity("Edit: src/a.ts", "en")).toMatchObject({ kind: "edit", label: "Editing a file" });
    expect(describeActivity("web_search Wetter Salzburg", "de")).toMatchObject({ kind: "web", label: "Sucht im Web", detail: "Wetter Salzburg" });
    expect(describeActivity("memory", "de").kind).toBe("memory");
    expect(describeActivity("", "de")).toMatchObject({ kind: "think", label: "Denkt nach" });
    expect(describeActivity("frobnicate x", "de")).toMatchObject({ label: "frobnicate", detail: "x" });
  });

  it("shows elapsed time and animated dots", () => {
    expect(elapsedShort(23_400)).toBe("23 s");
    expect(elapsedShort(65_000)).toBe("1:05");
    expect(elapsedShort(13 * 60_000)).toBe("13 min");
    expect(new Set([0, 700, 1400].map(workingDots)).size).toBe(3);
    const agent = { busy: true, busySince: 1_000, activity: "Bash: npm test" } as AgentInfo;
    expect(workingLine(agent, "de", 24_000)).toMatch(/^» Führt Tests aus\.{1,3} *· 23 s · npm test$/);
  });
});
