import { describe, it, expect, vi } from "vitest";
import { clampLight, drawMoth, lightBar, mothLine, stateForLight } from "../src/lumen/moth";
import {
  blobFromBase64, describeError, fetchStatus, newQuest, parseStatus, submitPhoto,
} from "../src/lumen/client";
import { buildView, questMeta, windowLabel, wrap } from "../src/glasses/view";
import { EMPTY_DATA, isLocal, maskToken, parseData, validateUrl } from "../src/storage/persist";

/**
 * Copied from a running LUMEN rather than invented, so the field names here
 * are the ones the app will actually meet.
 */
const statusPayload = {
  kreatur: {
    person: "Alfred", name: "Lumen", art: "Falter",
    licht: 72.0, zustand: "wach", geste: "sitzt aufmerksam auf deiner Hand",
    streak: 3, bester_streak: 5, modus: "alltag",
  },
  offene_quests: 5,
  quest: {
    id: 7,
    titel: "Bird's Eye Pattern",
    aufgabe: "Finde ein wiederkehrendes Muster von oben (Acker, Parkplatz).",
    warum: "Suche nach geometrischen Formen",
    pruefbar: null,
    medium: "foto",
    dauer_min: 30,
    geraet: "Sony FX3",
  },
  naechstes_lichtfenster: { art: "golden", start: "18:19", ende: "19:18", in_minuten: 51 },
  kurz: "wach 72%",
};

describe("the moth", () => {
  it("matches LUMEN's own thresholds", () => {
    expect(stateForLight(95)).toBe("leuchtet");
    expect(stateForLight(80)).toBe("leuchtet");
    expect(stateForLight(60)).toBe("wach");
    expect(stateForLight(40)).toBe("matt");
    expect(stateForLight(20)).toBe("schläfrig");
    expect(stateForLight(0)).toBe("eingerollt");
  });

  it("never falls off the bottom — the moth does not die", () => {
    expect(stateForLight(-50)).toBe("eingerollt");
    expect(drawMoth("eingerollt").length).toBeGreaterThan(0);
  });

  it("folds its wings as the light runs out", () => {
    // Thriving is drawn wider than exhausted; the shape carries the state.
    const bright = drawMoth("leuchtet").reduce((w, l) => Math.max(w, l.length), 0);
    const spent = drawMoth("eingerollt").reduce((w, l) => Math.max(w, l.length), 0);
    expect(bright).toBeGreaterThan(spent);
    expect(drawMoth("leuchtet").length).toBeGreaterThan(drawMoth("schläfrig").length);
  });

  it("fits the display", () => {
    for (const state of ["leuchtet", "wach", "matt", "schläfrig", "eingerollt"] as const) {
      for (const line of drawMoth(state)) expect(line.length).toBeLessThanOrEqual(46);
      expect(drawMoth(state).length).toBeLessThanOrEqual(5);
    }
  });

  it("passes LUMEN's own wording through rather than inventing its own", () => {
    expect(mothLine("wach", "sitzt aufmerksam auf deiner Hand"))
      .toContain("sitzt aufmerksam auf deiner Hand");
    expect(mothLine("matt", null)).toBe("matt");
  });

  it("draws a coarse light bar", () => {
    expect(lightBar(100, 10)).toBe("[##########]");
    expect(lightBar(0, 10)).toBe("[----------]");
    expect(lightBar(50, 10)).toBe("[#####-----]");
  });

  it("clamps impossible light values", () => {
    expect(clampLight(999)).toBe(100);
    expect(clampLight(-5)).toBe(0);
    expect(clampLight(Number.NaN)).toBe(0);
  });
});

describe("reading LUMEN's status", () => {
  it("reads moth, quest and light window", () => {
    const status = parseStatus(statusPayload);
    expect(status.moth).toMatchObject({ light: 72, state: "wach" });
    expect(status.quest).toMatchObject({
      id: 7,
      title: "Bird's Eye Pattern",
      task: "Finde ein wiederkehrendes Muster von oben (Acker, Parkplatz).",
      medium: "foto",
      minutes: 30,
    });
    expect(status.window).toEqual({ kind: "golden", minutesAway: 51 });
    expect(status.moth.streak).toBe(3);
  });

  it("derives the state when LUMEN sends only a light value", () => {
    expect(parseStatus({ kreatur: { licht: 20 } }).moth.state).toBe("schläfrig");
  });

  it("copes with no quest", () => {
    const status = parseStatus({ kreatur: { licht: 50 }, quest: null });
    expect(status.quest).toBeNull();
    expect(status.openQuests).toBe(0);
  });

  it("keeps the short name and the instruction apart", () => {
    const quest = parseStatus(statusPayload).quest;
    expect(quest?.title).toBe("Bird's Eye Pattern");
    expect(quest?.task).toContain("Muster von oben");
  });

  it("still reads a quest that carries only a name", () => {
    expect(parseStatus({ quest: { id: 1, titel: "Nur ein Titel" } }).quest?.task).toBeNull();
  });

  it("drops a quest without a usable id, which could not be submitted to", () => {
    expect(parseStatus({ quest: { titel: "kein id" } }).quest).toBeNull();
  });

  it("never throws on an unexpected payload", () => {
    expect(() => parseStatus(null)).not.toThrow();
    expect(() => parseStatus("nonsense")).not.toThrow();
    expect(parseStatus({}).moth.state).toBe("eingerollt");
  });
});

describe("talking to LUMEN", () => {
  const options = { baseUrl: "http://127.0.0.1:8077" };

  it("fetches the status", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://127.0.0.1:8077/api/status");
      return new Response(JSON.stringify(statusPayload), {
        status: 200, headers: { "content-type": "application/json" },
      });
    });
    const outcome = await fetchStatus({ ...options, fetchImpl: fetchImpl as never });
    expect(outcome.error).toBeNull();
    expect(outcome.value?.moth.state).toBe("wach");
  });

  it("says plainly when LUMEN wants a sign-in", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 401 }));
    const outcome = await fetchStatus({ ...options, fetchImpl: fetchImpl as never });
    expect(outcome.error).toContain("not signed in");
  });

  it("asks for a new quest", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain("/api/quest/neu");
      expect(init?.method).toBe("POST");
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    expect((await newQuest({ ...options, fetchImpl: fetchImpl as never })).value).toBe(true);
  });

  it("submits the photo the way LUMEN's own form does", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://127.0.0.1:8077/quest/42/abgeben");
      const body = init?.body as FormData;
      expect(body.get("datei")).toBeInstanceOf(Blob);
      // The boundary must come from the platform; setting it by hand breaks parsing.
      expect((init?.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
      return new Response("", { status: 303 });
    });
    const outcome = await submitPhoto(
      { ...options, fetchImpl: fetchImpl as never },
      42, new Blob(["x"], { type: "image/jpeg" }),
    );
    // A redirect back to the page still means it was accepted.
    expect(outcome.error).toBeNull();
  });

  it("sends the session cookie as a header, not in the URL", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).not.toContain("secret");
      expect((init?.headers as Record<string, string>)["Cookie"]).toBe("lumen=secret");
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    await fetchStatus({ ...options, token: "secret", fetchImpl: fetchImpl as never });
  });

  it("describes failures without leaking internals", () => {
    expect(describeError(new TypeError("Failed to fetch"))).toBe("LUMEN unreachable");
    expect(describeError(new DOMException("x", "AbortError"))).toBe("LUMEN timed out");
  });

  it("turns a camera payload into an uploadable blob", () => {
    const blob = blobFromBase64("aGVsbG8=", "image/jpeg");
    expect(blob.size).toBe(5);
    expect(blob.type).toBe("image/jpeg");
  });

  it("strips a data URI prefix the camera may include", () => {
    expect(blobFromBase64("data:image/jpeg;base64,aGVsbG8=").size).toBe(5);
  });
});

describe("the display", () => {
  const idle = { phase: "idle" as const, result: null, error: null };
  const status = parseStatus(statusPayload);

  it("shows the moth above everything else", () => {
    const view = buildView(status, idle);
    expect(view.body.slice(0, 3).join("")).toMatch(/[\\/=(]/);
  });

  it("shows the instruction, not just the short name", () => {
    const view = buildView(status, idle);
    expect(view.body.join(" ")).toContain("Muster von oben");
    expect(view.footer).toContain("tap = photo");
  });

  it("shows the streak once there is one", () => {
    expect(buildView(status, idle).footer).toContain("3d");
  });

  it("warns up front when a quest wants video, which the glasses cannot supply", () => {
    const videoQuest = parseStatus({
      ...statusPayload,
      quest: { ...statusPayload.quest, medium: "video" },
    });
    expect(buildView(videoQuest, idle).body.join(" ")).toContain("VIDEO");
    expect(questMeta({ medium: "video", minutes: 30 })).toContain("camera");
  });

  it("puts the light window in the footer — the reason to stand up now", () => {
    expect(buildView(status, idle).footer).toContain("golden in 51m");
  });

  it("offers a quest when there is none", () => {
    const without = parseStatus({ kreatur: { licht: 40 } });
    const view = buildView(without, idle);
    expect(view.body.join(" ")).toContain("Hold for a new one");
    expect(view.footer).toContain("hold = quest");
  });

  it("shows the moth while the camera and upload are busy", () => {
    const shooting = buildView(status, { ...idle, phase: "shooting" });
    expect(shooting.body.join(" ")).toContain("phone");
    expect(shooting.body[0]).toMatch(/[\\/]/);
  });

  it("reports the outcome plainly", () => {
    const ok = buildView(status, { ...idle, phase: "result", result: { ok: true, text: "Sent." } });
    expect(ok.header).toBe("Accepted");
    const bad = buildView(status, { ...idle, phase: "result", result: { ok: false, text: "HTTP 500" } });
    expect(bad.header).toBe("Not accepted");
  });

  it("explains a connection problem instead of showing a stale moth", () => {
    const view = buildView(status, { ...idle, error: "LUMEN unreachable" });
    expect(view.body[0]).toBe("LUMEN unreachable");
    expect(view.footer).toContain("retry");
  });

  it("formats light windows readably", () => {
    expect(windowLabel("golden", 42)).toBe("golden in 42m");
    expect(windowLabel("blau", 0)).toBe("blue now");
    expect(windowLabel("golden_frueh", 135)).toBe("golden in 2h 15m");
  });

  it("wraps long quest text", () => {
    expect(wrap("aaa bbb ccc", 7)).toEqual(["aaa bbb", "ccc"]);
  });
});

describe("configuration", () => {
  it("requires a usable address", () => {
    expect(validateUrl("").valid).toBe(false);
    expect(validateUrl("http://127.0.0.1:8077").valid).toBe(true);
    expect(validateUrl("ws://x").valid).toBe(false);
  });

  it("recognises a local address, where nothing leaves the house", () => {
    expect(isLocal("http://127.0.0.1:8077")).toBe(true);
    expect(isLocal("http://192.168.1.5:8077")).toBe(true);
    expect(isLocal("http://lumen.local")).toBe(true);
    expect(isLocal("https://lumen.example.com")).toBe(false);
  });

  it("never reveals the session token", () => {
    expect(maskToken("abcdef")).toBe("set (6 chars)");
    expect(maskToken("abcdef")).not.toContain("abcdef");
  });

  it("falls back cleanly on corrupt storage", () => {
    expect(parseData("{nope")).toEqual(EMPTY_DATA);
    expect(parseData(JSON.stringify({ baseUrl: "ws://bad" })).baseUrl).toBe("");
  });
});
