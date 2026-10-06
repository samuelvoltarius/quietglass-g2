import { describe, it, expect, vi } from "vitest";
import {
  activeScript, DEFAULT_SETTINGS, EMPTY_DATA, load, nextScriptId, parseData,
  removeScript, save, setSettings, upsertScript, type PromptFlowData, type StoredScript,
} from "../src/storage/persist";
import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";

function makeBridge(stored: Record<string, string> = {}): EvenAppBridge {
  const db = { ...stored };
  return {
    setLocalStorage: vi.fn(async (k: string, v: string) => { db[k] = v; }),
    getLocalStorage: vi.fn(async (k: string) => db[k] ?? ""),
  } as unknown as EvenAppBridge;
}

const script = (over: Partial<StoredScript> = {}): StoredScript => ({
  id: "s1", title: "Talk", source: "# Talk", updatedAt: 1, ...over,
});

const dataWith = (...scripts: StoredScript[]): PromptFlowData => ({
  scripts, activeId: scripts[0]?.id ?? null, settings: DEFAULT_SETTINGS,
});

describe("storage round-trip", () => {
  it("saves and loads scripts and settings", async () => {
    const bridge = makeBridge();
    const data = setSettings(dataWith(script()), { wpm: 150 });
    await save(bridge, data);

    const loaded = await load(makeBridge({
      "quietglass.promptflow.v1": (bridge.setLocalStorage as any).mock.calls[0][1],
    }));
    expect(loaded.scripts).toHaveLength(1);
    expect(loaded.settings.wpm).toBe(150);
  });

  it("installs the sample script on a first run rather than starting blank", async () => {
    const loaded = await load(makeBridge());
    expect(loaded.scripts).toHaveLength(1);
    expect(loaded.scripts[0]?.id).toBe("sample");
    expect(loaded.activeId).toBe("sample");
  });

  it("parses empty storage as empty data", () => {
    expect(parseData("")).toEqual(EMPTY_DATA);
  });
});

describe("parseData resilience", () => {
  it("falls back on malformed JSON", () => {
    expect(parseData("{not json")).toEqual(EMPTY_DATA);
  });

  it("drops entries missing an id or source", () => {
    const parsed = parseData(JSON.stringify({ scripts: [{ id: "a" }, { source: "x" }, script()] }));
    expect(parsed.scripts).toHaveLength(1);
    expect(parsed.scripts[0]?.id).toBe("s1");
  });

  it("repairs an activeId that points nowhere", () => {
    expect(parseData(JSON.stringify({ scripts: [script()], activeId: "gone" })).activeId).toBe("s1");
  });

  it("fills in missing settings with the defaults", () => {
    const parsed = parseData(JSON.stringify({ scripts: [], settings: { wpm: 99 } }));
    expect(parsed.settings.wpm).toBe(99);
    expect(parsed.settings.mode).toBe(DEFAULT_SETTINGS.mode);
  });

  it("rejects an unknown mode", () => {
    const parsed = parseData(JSON.stringify({ settings: { mode: "hyperspeed" } }));
    expect(parsed.settings.mode).toBe(DEFAULT_SETTINGS.mode);
  });
});

describe("script collection", () => {
  it("adds and replaces scripts in place", () => {
    const one = upsertScript(EMPTY_DATA, script());
    expect(one.activeId).toBe("s1");

    const edited = upsertScript(one, script({ title: "Renamed" }));
    expect(edited.scripts).toHaveLength(1);
    expect(edited.scripts[0]?.title).toBe("Renamed");
  });

  it("moves the selection when the active script is removed", () => {
    const data = dataWith(script(), script({ id: "s2" }));
    expect(removeScript(data, "s1").activeId).toBe("s2");
    expect(removeScript(dataWith(script()), "s1").activeId).toBeNull();
  });

  it("resolves the active script, falling back to the first", () => {
    expect(activeScript(dataWith(script(), script({ id: "s2" })))?.id).toBe("s1");
    expect(activeScript({ ...dataWith(script()), activeId: "gone" })?.id).toBe("s1");
    expect(activeScript(EMPTY_DATA)).toBeNull();
  });

  it("hands out unused ids", () => {
    expect(nextScriptId(EMPTY_DATA)).toBe("s1");
    expect(nextScriptId(dataWith(script(), script({ id: "s2" })))).toBe("s3");
  });
});
