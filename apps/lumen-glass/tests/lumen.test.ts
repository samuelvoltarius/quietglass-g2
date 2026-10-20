import { describe, it, expect, vi } from "vitest";
import { clampLight, drawMoth, lightBar, mothLine, stateForLight } from "../src/lumen/moth";
import {
  blobFromBase64, describeError, fetchStatus, newQuest, parseStatus, signIn, signOut, submitPhoto,
  UPLOAD_TIMEOUT,
} from "../src/lumen/client";
import { buildView, questMeta, windowLabel, wrap } from "../src/glasses/view";
import { EMPTY_DATA, isFirstStart, isLocal, maskToken, parseData, validateUrl } from "../src/storage/persist";

/**
 * Copied from a running LUMEN rather than invented, so the field names here
 * are the ones the app will actually meet.
 */
const statusPayload = {
  kreatur: {
    person: "Alex", name: "Lumen", art: "Moth",
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

  const jsonAnswer = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("submits the photo the way LUMEN's own form does and reads its JSON verdict", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://127.0.0.1:8077/quest/42/abgeben?format=json");
      const body = init?.body as FormData;
      expect(body.get("datei")).toBeInstanceOf(Blob);
      const headers = init?.headers as Record<string, string>;
      // The boundary must come from the platform; setting it by hand breaks parsing.
      expect(headers["Content-Type"]).toBeUndefined();
      expect(headers["Accept"]).toBe("application/json");
      expect(init?.mode).toBeUndefined(); // a normal CORS request now, not no-cors
      expect(init?.credentials).toBe("omit");
      return jsonAnswer({ ergebnis: "erledigt", meldung: "Angenommen, 9 Licht und 28 XP", quest_id: 42 });
    });
    const outcome = await submitPhoto(
      { ...options, fetchImpl: fetchImpl as never },
      42, new Blob(["x"], { type: "image/jpeg" }),
    );
    expect(outcome).toEqual({ value: { kind: "done", message: "Angenommen, 9 Licht und 28 XP" }, error: null });
  });

  it("sends the token as Bearer on the upload", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>)["Authorization"]).toBe("Bearer secret");
      return jsonAnswer({ ergebnis: "erledigt", meldung: "ok" });
    });
    await submitPhoto({ ...options, token: "secret", fetchImpl: fetchImpl as never }, 7, new Blob(["x"]));
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("a rejection carries LUMEN's reason", async () => {
    const fetchImpl = vi.fn(async () => jsonAnswer({ ergebnis: "abgelehnt", meldung: "Kein Baum zu sehen." }));
    const outcome = await submitPhoto({ ...options, fetchImpl: fetchImpl as never }, 7, new Blob(["x"]));
    expect(outcome).toEqual({ value: { kind: "rejected", message: "Kein Baum zu sehen." }, error: null });
  });

  it("a 401 means not signed in, a JSON error shows LUMEN's words", async () => {
    const signedOut = vi.fn(async () => jsonAnswer({ ergebnis: "fehler", meldung: "nicht angemeldet" }, 401));
    expect((await submitPhoto({ ...options, fetchImpl: signedOut as never }, 7, new Blob(["x"]))).error)
      .toBe("not signed in to LUMEN");
    const limit = vi.fn(async () => jsonAnswer({ ergebnis: "fehler", meldung: "Heute schon 20 Abgaben. Morgen wieder." }, 429));
    expect((await submitPhoto({ ...options, fetchImpl: limit as never }, 7, new Blob(["x"]))).error)
      .toBe("Heute schon 20 Abgaben. Morgen wieder.");
  });

  it("fallback: an unreadable answer (older LUMEN without CORS) leaves it to the status check", async () => {
    const blocked = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    expect((await submitPhoto({ ...options, fetchImpl: blocked as never }, 7, new Blob(["x"]))).value)
      .toEqual({ kind: "unknown", message: null });
    const redirect = vi.fn(async () => new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } }));
    expect((await submitPhoto({ ...options, fetchImpl: redirect as never }, 7, new Blob(["x"]))).value)
      .toEqual({ kind: "unknown", message: null });
  });

  it("regression: the upload gets far more time than a status request", async () => {
    expect(UPLOAD_TIMEOUT).toBeGreaterThanOrEqual(60_000);
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      let answer!: (value: Response) => void;
      const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        return new Promise<Response>((done) => { answer = done; });
      });
      const pending = submitPhoto({ ...options, fetchImpl: fetchImpl as never }, 7, new Blob(["x"]));
      await vi.advanceTimersByTimeAsync(30_000); // a judged photo, well past the old 8 s
      expect(signal?.aborted).toBe(false);
      answer(jsonAnswer({ ergebnis: "erledigt", meldung: "ok" }));
      expect((await pending).value?.kind).toBe("done");
    } finally {
      vi.useRealTimers();
    }
  });

  it("signs in with name and password and returns only the token", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://127.0.0.1:8077/api/anmelden");
      expect(init?.method).toBe("POST");
      expect(init?.credentials).toBe("omit");
      expect((init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
      expect(JSON.parse(String(init?.body))).toEqual({ name: "Alex", passwort: "pw-12345678" });
      return jsonAnswer({ token: "tok-abc", laeuft_ab: "2026-11-12T10:00:00" });
    });
    const outcome = await signIn({ ...options, fetchImpl: fetchImpl as never }, "Alex", "pw-12345678");
    expect(outcome).toEqual({ value: { kind: "token", token: "tok-abc" }, error: null });
  });

  it("sign-in tells wrong password, open mode and lockout apart", async () => {
    const answer = (status: number, body: unknown) => vi.fn(async () => jsonAnswer(body, status));
    expect((await signIn({ ...options, fetchImpl: answer(401, { fehler: "x" }) as never }, "a", "b")).value).toEqual({ kind: "wrong" });
    expect((await signIn({ ...options, fetchImpl: answer(409, { offen: true }) as never }, "a", "b")).value).toEqual({ kind: "open" });
    expect((await signIn({ ...options, fetchImpl: answer(429, { warte_s: 60 }) as never }, "a", "b")).value).toEqual({ kind: "locked" });
    const down = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    expect((await signIn({ ...options, fetchImpl: down as never }, "a", "b")).error).toBe("LUMEN unreachable");
  });

  it("signs out with the token as Bearer", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://127.0.0.1:8077/api/abmelden");
      expect((init?.headers as Record<string, string>)["Authorization"]).toBe("Bearer tok");
      return new Response(null, { status: 204 });
    });
    await signOut({ ...options, token: "tok", fetchImpl: fetchImpl as never });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("regression: never sends a Cookie header or credentials; a token goes as Bearer", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).not.toContain("secret");
      const headers = init?.headers as Record<string, string>;
      expect(headers["Cookie"]).toBeUndefined();
      expect(headers["Authorization"]).toBe("Bearer secret");
      expect(init?.credentials).toBe("omit");
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    await fetchStatus({ ...options, token: "secret", fetchImpl: fetchImpl as never });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
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

describe("first start (QIS v1.2 no. 7)", () => {
  it("nothing saved and no server in the build is a first start; anything saved or a built-in server is not", () => {
    expect(isFirstStart("", "")).toBe(true);
    expect(isFirstStart("   ", "")).toBe(true);
    expect(isFirstStart("", "https://lumen.private.test")).toBe(false);
    expect(isFirstStart('{"baseUrl":"http://127.0.0.1:8077"}', "")).toBe(false);
  });
});

describe("the display", () => {
  // Pinned: the glasses follow the device language, these assertions read the English text.
  const idle = { phase: "idle" as const, result: null, error: null, locale: "en" as const };
  const status = parseStatus(statusPayload);

  it("shows the quest's short name as the heading, then the instruction (QUS v1: a reading view)", () => {
    const view = buildView(status, idle);
    expect(view.header).toBe("Quest · ● live");
    expect(view.body[0]).toBe(status.quest!.title);
    expect(view.body.join(" ")).toContain("Muster von oben");
    expect(view.footer).toBe("Tap = photo · Hold = quest · 2× = back");
  });

  it("warns up front when a quest wants video, which the glasses cannot supply", () => {
    const videoQuest = parseStatus({
      ...statusPayload,
      quest: { ...statusPayload.quest, medium: "video" },
    });
    expect(buildView(videoQuest, idle).body.join(" ")).toContain("VIDEO");
    expect(questMeta({ medium: "video", minutes: 30 }, "en")).toContain("camera");
  });

  it("offers a quest when there is none", () => {
    const without = parseStatus({ kreatur: { licht: 40 } });
    const view = buildView(without, idle);
    expect(view.body.join(" ")).toContain("No open quest.");
    expect(view.footer).toBe("Hold = quest · 2× = back");
  });

  it("says so while the camera and upload are busy", () => {
    const shooting = buildView(status, { ...idle, phase: "shooting" });
    expect(shooting.body.join(" ")).toContain("phone");
  });

  it("reports the outcome plainly", () => {
    const ok = buildView(status, { ...idle, phase: "result", result: { ok: true, text: "Sent." } });
    expect(ok.header).toBe("Lumen · Accepted");
    const bad = buildView(status, { ...idle, phase: "result", result: { ok: false, text: "HTTP 500" } });
    expect(bad.header).toBe("Lumen · Not accepted");
    // QIS v1.2 no. 8: no HTTP code on the glasses.
    expect(bad.body.join(" ")).not.toMatch(/HTTP|500/);
    expect(bad.body.join(" ")).toContain("LUMEN reported an error");
  });

  it("explains a connection problem instead of showing a stale moth", () => {
    const view = buildView(status, { ...idle, error: "LUMEN unreachable" });
    expect(view.body[0]).toBe("LUMEN unreachable");
    expect(view.footer).toContain("retry");
  });

  it("formats light windows readably", () => {
    expect(windowLabel("golden", 42, "en")).toBe("golden in 42m");
    expect(windowLabel("blau", 0, "en")).toBe("blue now");
    expect(windowLabel("golden_frueh", 135, "en")).toBe("golden in 2h 15m");
  });

  it("does not round a window just under the hour into \"1h 60m\"", () => {
    // Regression: hours were floored and the remainder rounded on its own.
    expect(windowLabel("golden", 119.7, "en")).toBe("golden in 2h 0m");
    expect(windowLabel("golden", 59.6, "en")).toBe("golden in 1h 0m");
    expect(windowLabel("blau", 0.3, "en")).toBe("blue now");
    expect(windowLabel("golden", Number.NaN, "en")).toBe("golden now");
  });

  it("keeps the body within the seven rows the display shows", () => {
    // Regression: a bright moth (4 rows), its line, a spacer, a three-line task and the
    // meta line made 10 rows; even the demo's awake moth ran its meta line into the footer.
    const bright = parseStatus({
      ...statusPayload,
      kreatur: { ...statusPayload.kreatur, licht: 95, zustand: "leuchtet", geste: "kreist unermüdlich und strahlend im allerletzten Abendlicht über dem See" },
      quest: { ...statusPayload.quest, aufgabe: "Finde ein wiederkehrendes Muster von oben, zum Beispiel einen Acker, einen Parkplatz oder ein Dach, und fotografiere es so, dass es das Bild füllt." },
    });
    const view = buildView(bright, idle);
    expect(view.body.length).toBeLessThanOrEqual(7);
    expect(view.body.every((line) => line.length <= 56)).toBe(true);
    expect(view.body.join(" ")).toContain("FOTO");
    const endless = parseStatus({ ...statusPayload, quest: { ...statusPayload.quest, aufgabe: "Wort ".repeat(80) } });
    const cut = buildView(endless, idle);
    expect(cut.body.length).toBeLessThanOrEqual(7);
    expect(cut.body.join(" ")).toContain("…");
    expect(cut.body.at(-1)).toContain("30 min");

    const demo = parseStatus({ kreatur: { licht: 72, zustand: "wach", geste: "circling in the light", streak: 6 }, quest: { id: 1, titel: "Reflected Light", aufgabe: "Photograph a reflection that changes the scene.", medium: "foto", dauer_min: 15 } });
    expect(buildView(demo, idle).body.length).toBeLessThanOrEqual(7);

    const result = buildView(bright, { ...idle, phase: "result", result: { ok: false, text: "x ".repeat(120) } });
    expect(result.body.length).toBeLessThanOrEqual(7);
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
    expect(maskToken("abcdef", "en")).toBe("signed in");
    expect(maskToken("abcdef", "de")).not.toContain("abcdef");
    expect(maskToken("abcdef", "en")).not.toContain("abcdef");
  });

  it("falls back cleanly on corrupt storage", () => {
    expect(parseData("{nope")).toEqual(EMPTY_DATA);
    expect(parseData(JSON.stringify({ baseUrl: "ws://bad" })).baseUrl).toBe("");
  });
});

describe("private build address", () => {
  it("a private build's server replaces an empty or documented default address", async () => {
    const { migrateBaseUrl, defaultBaseUrl, LUMEN_DOC_DEFAULT } = await import("../src/storage/persist");
    const build = "https://lumen.example.net:8454";
    expect(defaultBaseUrl(build)).toBe(build);
    expect(defaultBaseUrl("")).toBe(LUMEN_DOC_DEFAULT);
    expect(migrateBaseUrl("", build)).toBe(build);
    expect(migrateBaseUrl("http://127.0.0.1:8077/", build)).toBe(build);
    expect(migrateBaseUrl("http://lumen.lan:8077", build)).toBe("http://lumen.lan:8077");
    expect(migrateBaseUrl("http://127.0.0.1:8077", "")).toBe("http://127.0.0.1:8077");
    expect(parseData(JSON.stringify({ baseUrl: "http://127.0.0.1:8077" }), build).baseUrl).toBe(build);
    expect(parseData("", build).baseUrl).toBe(build);
  });
});
