import { afterEach, describe, expect, it, vi } from "vitest";
import { bannerFor, isFirstRun, mountPhoneUi, nowInner, sessionsInner, setupInner, summarize, TABS, type ConnView, type PhoneState } from "../src/ui/phone";
import { createModel } from "../src/hub/model";
import { demoReport } from "../src/api/demo";

// QUS v1 phone page: exactly three tabs (Jetzt / Sitzungen / Einstellungen), the Rain Lens look.
const conn = (connected: boolean, configured = true): ConnView => ({ configured, connected, host: "pi.example", lastOkAt: null, problem: connected || !configured ? null : "unreachable", lastErrorAt: null, fails: 0 });
const state = (connected: boolean, serverUrl = "https://pi.example:8443"): PhoneState => ({
  model: createModel(demoReport()),
  locale: "de",
  settings: { serverUrl, token: "x", autoOpenNotifications: true, invertScroll: false, voiceAutoSend: false, speakAnswers: false, quietWhileWorking: false },
  conn: conn(connected, serverUrl !== ""),
  speech: "off",
});

function render(s: PhoneState): string {
  let html = "";
  const root = { set innerHTML(v: string) { html = v; }, get innerHTML() { return html; }, querySelector: () => null, querySelectorAll: () => [] };
  vi.stubGlobal("document", { getElementById: () => root });
  mountPhoneUi(root as unknown as HTMLElement, () => s, { onLocale() {}, onSettings: async () => ({ ok: true, persisted: true, problem: null }), onTest: async () => ({ ok: true, problem: null, ms: 1 }), onScanQr: async () => s.settings, onSpeechActivate() {} });
  return html;
}

describe("phone page tabs (QUS v1)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("has exactly three tabs in one row: Jetzt, Sitzungen, Einstellungen", () => {
    expect(TABS.map((tab) => tab.id)).toEqual(["now", "sessions", "settings"]);
    const html = render(state(true));
    const bar = html.slice(html.indexOf('<nav class="tabbar"'));
    expect([...bar.matchAll(/data-tab-go="(\w+)"/g)].map((m) => m[1])).toEqual(["now", "sessions", "settings"]);
    expect(bar).toContain("Jetzt");
    expect(bar).toContain("Sitzungen");
    expect(bar).toContain("Einstellungen");
    const bodies = [...html.slice(0, html.indexOf('<nav class="tabbar"')).matchAll(/class="tab" data-tab="(\w+)"/g)].map((m) => m[1]);
    expect(bodies).toEqual(["now", "sessions", "settings"]);
  });

  it("has the head: kicker, title, status pill", () => {
    const html = render(state(true));
    expect(html).toContain("QUIETGLASS / AGENTEN");
    expect(html).toContain("<h1>Quiet Hub</h1>");
    expect(html).toContain('id="pill" class="chip on">● verbunden');
    expect(render(state(false))).toContain('id="pill" class="chip">offline');
  });

  it("Jetzt: banner, hero card with one big value, 2x2 figures, one button, a card strip of sessions", () => {
    const model = createModel(demoReport());
    const html = nowInner(model, conn(true), "de");
    expect(html).toContain('class="banner');
    expect(html).toContain('class="card hero-card"');
    expect(html.match(/<strong>/g)).toHaveLength(1);
    expect(html.slice(html.indexOf('class="stats"'), html.indexOf("</section>")).match(/<b>/g)).toHaveLength(4);
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toContain('id="refresh"');
    expect(html).toContain('class="strip"');
    expect(html.match(/class="host /g)).toHaveLength(model.report.agents.length);
    expect(summarize(model).total).toBe(model.report.agents.length);
  });

  it("the banner carries the one message that counts", () => {
    const model = createModel(demoReport());
    expect(bannerFor({ ...model, setupHint: true }, conn(true), "de").text).toContain("Demo-Daten");
    expect(bannerFor(model, conn(false), "de")).toMatchObject({ tone: "offline" });
    const waiting = { ...model, report: { ...model.report, approvals: [{ id: "c", agentId: "claude-win", tool: "Bash", title: "x", detail: "x", createdAt: "", expiresAt: 0 }] } };
    expect(bannerFor(waiting, conn(true), "de")).toMatchObject({ tone: "warn" });
  });

  it("Sitzungen lists a card per agent; an empty hub says so", () => {
    const model = createModel(demoReport());
    expect(sessionsInner(model, "de").match(/<section class="card server/g)).toHaveLength(model.report.agents.length);
    expect(sessionsInner({ ...model, report: { ...model.report, agents: [] } }, "de")).toContain("Noch keine Agenten");
  });

  it("Einstellungen keeps every control; the server card is folded once connected and open on a first start", () => {
    const html = render(state(true));
    for (const id of ["server", "token", "save", "test", "scan", "auto-open", "invert-scroll", "voice-auto", "quiet", "speak", "language", "brief-morning", "brief-reload"]) expect(html).toContain(`id="${id}"`);
    expect(html).toContain('<details class="fold card">');
    expect(html).not.toContain('class="card setup"');
    const first = render(state(false, ""));
    expect(first).toContain('class="card setup"');
    expect(first).toContain('<details class="fold card" open>');
  });

  it("the first-run checklist has three steps and ticks them off", () => {
    const model = createModel(demoReport());
    const s = state(false, "");
    expect(isFirstRun(s.settings)).toBe(true);
    const none = setupInner(s.settings, conn(false, false), model, "de");
    expect(none.match(/<li/g)).toHaveLength(3);
    expect(none).not.toContain("✓");
    expect(none).toContain("Demo");
    const added = { ...s.settings, serverUrl: "https://hub.test" };
    expect(setupInner(added, conn(false), model, "de").match(/✓/g)).toHaveLength(1);
    expect(setupInner(added, conn(true), model, "de").match(/✓/g)).toHaveLength(3);
  });

  it("lists the controls in the order Tippen, Wischen, Halten, 2×", () => {
    const html = render(state(true));
    const t = html.slice(html.indexOf("Bedienung der Brille"));
    const order = ["Tippen", "Wischen", "Halten", "2×"].map((w) => t.indexOf(`<td>${w}</td>`));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});
