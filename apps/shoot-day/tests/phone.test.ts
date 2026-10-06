import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeRoot } from "./fake-dom";
import { mountPhoneUi, type ConnectionState } from "../src/ui/phone";
import { parseSettings, type Settings } from "../src/storage/persist";
import { escapeHtml } from "../src/ui/html";

function mount(initial: Settings, connection: ConnectionState = { kind: "none" }, locale: "de" | "en" = "en") {
  const root = fakeRoot();
  vi.stubGlobal("document", { getElementById: () => root });
  let settings = initial;
  const saved: Settings[] = [];
  const localeChanges: string[] = [];
  const ui = mountPhoneUi({
    getSettings: () => settings,
    saveSettings: async (next) => { saved.push(next); settings = next; },
    connection: () => connection,
    pendingCount: () => 0,
    locale: () => locale,
    onLocaleChange: (next) => { localeChanges.push(next); },
  });
  return { root, saved, ui, localeChanges, settings: () => settings };
}

const tick = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

describe("phone page", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
    vi.stubGlobal("navigator", { language: "en-US" });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("first run: explains what to do and offers an empty address field", () => {
    const { root } = mount({ serverUrl: "", invertScroll: false });
    expect(root.innerHTML).toContain("First run");
    expect(root.get("#url").value).toBe("");
  });

  it("saves a valid address, keeps the stored token when the field is left empty, and never shows it", async () => {
    const { root, saved } = mount({ serverUrl: "https://old.example", token: "s3cret-token", invertScroll: true });
    expect(root.innerHTML).not.toContain("s3cret-token");
    expect(root.innerHTML).toContain("set (12 chars)");
    root.get("#url").value = "https://shoot.example/base/";
    root.get("#save").fire("click");
    await tick();
    expect(saved).toEqual([{ serverUrl: "https://shoot.example/base", token: "s3cret-token", invertScroll: true }]);
    expect(root.innerHTML).toContain("Saved.");
    expect(root.innerHTML).not.toContain("s3cret-token");
  });

  it("refuses an address that is not http(s), carries credentials or a query", async () => {
    const { root, saved } = mount({ serverUrl: "", invertScroll: false });
    for (const [url, text] of [
      ["ftp://x", "must start with http"],
      ["https://user:pw@x.example", "token field"],
      ["https://x.example/?a=1", "without ?"],
      ["", "enter an address"],
    ] as const) {
      root.get("#url").value = url;
      root.get("#save").fire("click");
      await tick();
      expect(root.innerHTML, url).toContain(text);
    }
    expect(saved).toEqual([]);
  });

  it("warns that plain http is blocked on the phone, except for this machine", () => {
    expect(mount({ serverUrl: "http://192.0.2.10:8899", invertScroll: false }).root.innerHTML).toContain("mixed content");
    expect(mount({ serverUrl: "http://127.0.0.1:8899", invertScroll: false }).root.innerHTML).not.toContain("mixed content");
    expect(mount({ serverUrl: "https://shoot.example", invertScroll: false }).root.innerHTML).not.toContain("mixed content");
  });

  it("escapes everything it inserts: stored address, project name and error text", () => {
    const evil = '"><img src=x onerror=alert(1)>';
    const fromAddress = mount({ serverUrl: "https://x.example/" + evil, invertScroll: false }, { kind: "ok", project: evil });
    expect(fromAddress.root.innerHTML).not.toContain("<img");
    expect(fromAddress.root.innerHTML).toContain(escapeHtml(evil));
    expect(fromAddress.root.get("#url").value).toBe("https://x.example/" + evil);
    const fromError = mount({ serverUrl: "https://x.example", invertScroll: false }, { kind: "error", reason: evil });
    expect(fromError.root.innerHTML).not.toContain("<img");
  });

  it("removes the token on request", async () => {
    const { root, saved } = mount({ serverUrl: "https://x.example", token: "t", invertScroll: false });
    root.get("#clear-token").fire("click");
    await tick();
    expect(saved).toEqual([{ serverUrl: "https://x.example", invertScroll: false }]);
  });

  it("switches language and tells the app", () => {
    const view = mount({ serverUrl: "", invertScroll: false });
    const select = view.root.get("#language");
    select.value = "de";
    select.fire("change");
    expect(view.localeChanges).toEqual(["de"]);
    expect(view.root.innerHTML).toContain("Erster Start");
  });

  it("toggles swipe inversion", async () => {
    const { root, saved } = mount({ serverUrl: "https://x.example", invertScroll: false });
    const box = root.get("#invert");
    box.checked = true;
    box.fire("change");
    await tick();
    expect(saved.at(-1)?.invertScroll).toBe(true);
  });

  it("a half-typed address survives a redraw caused elsewhere", () => {
    const { root, ui } = mount({ serverUrl: "", invertScroll: false });
    root.get("#url").value = "https://half";
    ui.refresh();
    expect(root.get("#url").value).toBe("https://half");
  });
});

describe("stored settings", () => {
  it("drop an invalid address and keep the rest", () => {
    expect(parseSettings(JSON.stringify({ serverUrl: "javascript:alert(1)", invertScroll: true }))).toEqual({ serverUrl: "", invertScroll: true });
    expect(parseSettings("{broken")).toEqual({ serverUrl: "", invertScroll: false });
    expect(parseSettings(JSON.stringify({ serverUrl: "https://a.example", token: "x" }))).toEqual({ serverUrl: "https://a.example", token: "x", invertScroll: false });
  });
});

