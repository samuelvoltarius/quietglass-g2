import { describe, expect, it, vi } from "vitest";
import { deriveRaw } from "../src/car/derive";
import { demoTelemetry } from "../src/car/demo";
import { parseState, type CarState } from "../src/car/model";
import { createClient, parseReply } from "../src/car/client";
import { buildView, HEADER_WIDTH, ROW_WIDTH, ROWS, type ViewState } from "../src/glasses/views";
import { CONFIRM_WINDOW_MS, INITIAL_CONTROL, type ControlState } from "../src/pages";
import type { Locale } from "../src/i18n";
import { controlCard } from "../src/ui/phone";

// The control page (0.7.0, Alfred 23.10.2026): lock, unlock, preheat 10/20/30, two taps, the bridge's words.

const CONTROL = { enabled: true, lock: true, unlock: true, preheat: true, preheat_minutes: [10, 15, 20, 25, 30], car_off: true, arm_s: 8 };

const car = (over: Record<string, unknown> = {}): CarState => parseState({
  ...deriveRaw(demoTelemetry("parked", 1_000), 1, {}),
  rev: 1,
  control: CONTROL,
  ...over,
});

const view = (locale: Locale, c: CarState, control: ControlState = INITIAL_CONTROL, now = 10_000, extra: Partial<ViewState> = {}) =>
  buildView({ locale, demo: false, connection: { kind: "ok" }, car: c, page: "control", overlay: null, control, now, ...extra });

const all = (v: ReturnType<typeof buildView>): string => [v.header, ...v.body, v.footer].join("\n");

describe("control page", () => {
  it("lists exactly lock, unlock, preheat 10/20/30 with the cursor; no climate off, no temperature", () => {
    const v = view("de", car());
    expect(v.layout).toBe("plain");
    expect(v.header).toBe("BYD · STEUERN · Auto aus");
    expect(v.body.slice(0, 5)).toEqual(["● Zusperren", "   Aufsperren", "   Vorheizen 10 min", "   Vorheizen 20 min", "   Vorheizen 30 min"]);
    expect(all(v)).not.toMatch(/Klima aus|°C|Temperatur/);
    expect(v.footer).toBe("Tippen = Zusperren · Wischen = Eintrag · 2× = Ende");
    expect(view("en", car(), { ...INITIAL_CONTROL, cursor: 4 }).footer).toBe("Tap = Preheat 30 min · Swipe = entry · 2× = exit");
  });

  it("only the entries the bridge accepts", () => {
    const v = view("de", car({ control: { ...CONTROL, unlock: false, preheat: false } }));
    expect(v.body[0]).toBe("● Zusperren");
    expect(all(v)).not.toMatch(/Aufsperren|Vorheizen/);
  });

  it("car on: the header and the line say so", () => {
    const v = view("de", car({ control: { ...CONTROL, car_off: false } }));
    expect(v.header).toBe("BYD · STEUERN · nur bei Auto aus");
    expect(v.body.join(" ")).toContain("Auto ist an – am Display bedienen");
  });

  it("armed: the footer asks for the second tap, never offers hold", () => {
    const armed: ControlState = { ...INITIAL_CONTROL, cursor: 1, armed: { item: "unlock", token: "t", until: 10_000 + CONFIRM_WINDOW_MS } };
    const v = view("de", car(), armed);
    expect(v.footer).toBe("Nochmal tippen = Aufsperren · Wischen/2× = abbrechen");
    expect(v.body.join(" ")).toContain("Aufsperren? Nochmal tippen (4 s)");
    expect(view("en", car(), armed).footer).toBe("Tap again = Unlock · Swipe/2× = cancel");
    // Past the window: back to the plain footer.
    expect(view("de", car(), armed, 10_001 + CONFIRM_WINDOW_MS).footer).toMatch(/^Tippen = Aufsperren/);
  });

  it("shows the bridge's refusal text as it is", () => {
    const refused: ControlState = { ...INITIAL_CONTROL, result: { item: "lock", kind: "refused", code: "car_on", message: { de: "Auto ist an – am Display bedienen", en: "Car is on – use the car's screen" }, at: 9_000 } };
    expect(view("de", car(), refused).body.join(" ")).toContain("Auto ist an – am Display bedienen");
    expect(view("en", car(), refused).body.join(" ")).toContain("Car is on – use the car's screen");
  });

  it("sent, then confirmed / not confirmed / error - only from the bridge's command with that id", () => {
    const sent: ControlState = { ...INITIAL_CONTROL, result: { item: "lock", kind: "sent", id: "c7", at: 9_000 } };
    const line = (status: string | null, id = "c7"): string =>
      view("de", car(status ? { command: { id, action: "lock", value: null, status, at: 9_000 } } : {}), sent).body.join(" ");
    expect(line(null)).toContain("Zusperren: gesendet – warte auf das Auto …");
    expect(line("sent")).toContain("Zusperren: gesendet");
    expect(line("confirmed")).toContain("Zusperren: bestätigt");
    expect(line("not_confirmed")).toContain("Zusperren: nicht bestätigt");
    expect(line("error")).toContain("Zusperren: nicht ausgeführt");
    // Another command's success never confirms this one.
    expect(line("confirmed", "c8")).not.toContain("bestätigt");
    // An unknown status is never read as success.
    expect(line("ok")).not.toContain("bestätigt");
  });

  it("no answer to the second tap: unclear until the bridge's record says", () => {
    const unknown: ControlState = { ...INITIAL_CONTROL, result: { item: "unlock", kind: "unknown", at: 9_000 } };
    expect(view("de", car(), unknown).body.join(" ")).toContain("unklar, ob gesendet");
    const c = car({ command: { id: "c9", action: "unlock", value: null, status: "confirmed", at: 9_100 } });
    expect(view("de", c, unknown).body.join(" ")).toContain("Aufsperren: bestätigt");
  });

  it("every state fits the display in both languages", () => {
    const states: ControlState[] = [
      INITIAL_CONTROL,
      { ...INITIAL_CONTROL, cursor: 4, armed: { item: "preheat30", token: "t", until: 20_000 } },
      { ...INITIAL_CONTROL, busy: { item: "preheat30", step: "confirm" } },
      { ...INITIAL_CONTROL, result: { item: "preheat30", kind: "failed", reason: "unreachable", at: 9_000 } },
      { ...INITIAL_CONTROL, result: { item: "preheat30", kind: "lapsed", at: 9_000 } },
      { ...INITIAL_CONTROL, result: { item: "unlock", kind: "refused", code: "notify_failed", message: { de: "Aufsperren: Telegram-Meldung ging nicht", en: "Unlock: Telegram message failed" }, at: 9_000 } },
    ];
    for (const locale of ["de", "en"] as const) {
      for (const s of states) {
        for (const c of [car(), car({ control: { ...CONTROL, car_off: false } }), car({ command: { id: "c1", action: "preheat", value: 30, status: "not_confirmed", at: 1 } })]) {
          const v = view(locale, c, s, 10_000, { connection: { kind: "error", code: "unreachable" } });
          expect(v.header.length).toBeLessThanOrEqual(HEADER_WIDTH);
          expect(v.footer.length).toBeLessThanOrEqual(ROW_WIDTH);
          expect(v.body.length).toBeLessThanOrEqual(ROWS.plain);
          for (const row of v.body) expect(row.length).toBeLessThanOrEqual(ROW_WIDTH);
          expect(v.footer).not.toMatch(/Halten|Hold/);
        }
      }
    }
  });
});

describe("command client", () => {
  const reply = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

  it("arm and confirm are simple requests: POST, a text body, no custom header", async () => {
    const fetchImpl = reply(200, { ok: true, armed: "tok", ttl_s: 8 });
    const api = createClient({ baseUrl: "https://car.example:8471/", fetchImpl });
    const armed = await api.arm("preheat", 20);
    expect(armed).toEqual({ ok: true, error: null, message: null, armed: "tok", id: null });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://car.example:8471/command");
    expect(init.method).toBe("POST");
    expect(init.headers).toBeUndefined();
    expect(JSON.parse(String(init.body))).toEqual({ action: "preheat", minutes: 20, step: "arm" });
    const confirmImpl = reply(202, { ok: true, command: { id: "c1", status: "sent" } });
    const sent = await createClient({ baseUrl: "https://car.example:8471", fetchImpl: confirmImpl }).confirm("lock", null, "tok");
    expect(sent).toEqual({ ok: true, error: null, message: null, armed: null, id: "c1" });
    expect(JSON.parse(String((confirmImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ action: "lock", confirm: "tok" });
  });

  it("a refusal carries the bridge's code and text; 403 is a refusal, not a sign-in problem", async () => {
    const api = createClient({ baseUrl: "https://car.example:8471", fetchImpl: reply(403, { ok: false, error: "car_on", message: { de: "Auto ist an – am Display bedienen", en: "Car is on – use the car's screen" } }) });
    const r = await api.arm("lock", null);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("car_on");
    expect(r.message?.de).toBe("Auto ist an – am Display bedienen");
    expect(r.armed).toBeNull();
    await expect(createClient({ baseUrl: "https://x", fetchImpl: reply(401, { error: "unauthorized" }) }).arm("lock", null)).rejects.toMatchObject({ code: "auth" });
    await expect(createClient({ baseUrl: "https://x", fetchImpl: vi.fn(async () => { throw new TypeError("Failed to fetch"); }) }).confirm("lock", null, "t")).rejects.toMatchObject({ code: "unreachable" });
  });

  it("anything odd is a refusal, never a success", () => {
    expect(parseReply({ ok: true, armed: "t" }, 500).ok).toBe(false);
    expect(parseReply({ ok: "yes" }, 200).ok).toBe(false);
    expect(parseReply(null, 202)).toEqual({ ok: false, error: "other", message: null, armed: null, id: null });
  });
});

describe("phone control card", () => {
  it("says what the bridge allows and how the last command ended; read only when control is off", () => {
    const on = controlCard(car({ command: { id: "c1", action: "preheat", value: 20, status: "not_confirmed", at: 1 } }), "de");
    expect(on).toContain("Steuern");
    expect(on).toContain("10 / 20 / 30 min");
    expect(on).toContain("Vorheizen 20 min: nicht bestätigt");
    expect(on).toContain("Telegram");
    expect(on).not.toContain("<button");
    const off = controlCard(car({ control: { enabled: false } }), "de");
    expect(off).toContain("Nur Anzeige");
    expect(off).not.toContain("Zusperren");
  });
});
