import { afterEach, describe, expect, it, vi } from "vitest";
import { mountPhoneUi, type PhoneState } from "../src/ui/phone";
import { createModel } from "../src/hub/model";
import { demoReport } from "../src/api/demo";

const state = (connected: boolean): PhoneState => ({
  model: createModel(demoReport()),
  locale: "de",
  settings: { serverUrl: "https://pi.example:8443", token: "x", autoOpenNotifications: true, invertScroll: false, voiceAutoSend: false, speakAnswers: false, quietWhileWorking: false },
  conn: { configured: true, connected, host: "pi.example", lastOkAt: null, problem: connected ? null : "unreachable", lastErrorAt: null, fails: 0 },
  speech: "off",
});

function render(s: PhoneState): string {
  let html = "";
  const root = { set innerHTML(v: string) { html = v; }, get innerHTML() { return html; }, querySelector: () => null, querySelectorAll: () => [] };
  vi.stubGlobal("document", { getElementById: () => root });
  mountPhoneUi(root as unknown as HTMLElement, () => s, { onLocale() {}, onSettings: async () => ({ ok: true, persisted: true, problem: null }), onTest: async () => ({ ok: true, problem: null, ms: 1 }), onScanQr: async () => s.settings, onSpeechActivate() {} });
  return html;
}

describe("phone page tabs", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("has a tab bar, a status chip and keeps every control", () => {
    const html = render(state(true));
    expect(html).toContain('<nav class="tabbar"');
    for (const id of ["connect", "home", "glasses", "more"]) {
      expect(html).toContain(`data-tab="${id}"`);
      expect(html).toContain(`data-tab-go="${id}"`);
    }
    expect(html).toContain('class="chip on">verbunden');
    for (const id of ["server", "token", "save", "test", "auto-open", "invert-scroll", "voice-auto", "quiet", "speak", "language"]) expect(html).toContain(`id="${id}"`);
  });

  it("has a Zuhause tab with the same favourites and areas and says where they are set", () => {
    const html = render(state(true));
    const tab = html.slice(html.indexOf('data-tab="home"'), html.indexOf('data-tab="glasses"'));
    expect(tab).toContain("Favoriten");
    expect(tab).toContain("» Abendlicht");
    expect(tab).toContain("● Büro Decke</td><td>an · 60 %");
    expect(tab).toContain("Haustür <span class=\"hint\">(zweites Tippen nötig)</span>");
    expect(tab).toContain("<h3>Wohnzimmer</h3>");
    expect(tab).toContain("Alle Lichter");
    expect(tab).toContain("HA_FAVORITES");
    expect(tab).toContain("Token bleibt auf dem Daemon");
  });

  it("has a Tagesstart tab with the same blocks, the morning setting and a reload button", () => {
    const html = render(state(true));
    const tab = html.slice(html.indexOf('data-tab="brief"'), html.indexOf('data-tab="home"'));
    expect(html).toContain('data-tab-go="brief"');
    expect(tab).toContain('id="brief-morning"');
    expect(tab).toContain("Tagesstart als Startseite bis 11:00");
    expect(tab).toContain('id="brief-reload"');
    expect(tab).toContain("<strong>Termine · 4 heute");
    expect(tab).toContain("Zucker · 118 mg/dL →");
    expect(tab).toContain("keine Therapieentscheidungen");
  });

  it("orders the tabs [content] · Brille · Verbindung · Mehr (QIS v1)", () => {
    const html = render(state(true));
    const bar = html.slice(html.indexOf('<nav class="tabbar"'));
    const order = [...bar.matchAll(/data-tab-go="(\w+)"/g)].map((m) => m[1]);
    expect(order).toEqual(["brief", "home", "glasses", "connect", "more"]);
    // the page bodies follow the same order
    const bodies = [...html.slice(0, html.indexOf('<nav class="tabbar"')).matchAll(/class="tab" data-tab="(\w+)"/g)].map((m) => m[1]);
    expect(bodies).toEqual(order);
  });

  it("shows the offline chip and keeps the setup in the Verbindung tab", () => {
    const html = render(state(false));
    expect(html).toContain('class="chip">offline');
    expect(html.indexOf('data-tab="connect"')).toBeLessThan(html.indexOf('id="server"'));
    expect(html.indexOf('id="server"')).toBeLessThan(html.indexOf('data-tab="more"'));
  });

  it("lists the controls in QIS order: Tippen, Wischen, Halten, 2×", () => {
    const html = render(state(true));
    const t = html.slice(html.indexOf("<h2>Brillensteuerung"));
    const order = ["Tippen", "Wischen", "Halten", "2×"].map((w) => t.indexOf(`<td>${w}</td>`));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});
