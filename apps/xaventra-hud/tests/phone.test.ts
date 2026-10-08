import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeRoot } from "./fake-dom";
import { mountPhoneUi, type ConnectionState } from "../src/ui/phone";
import { maskToken, parseSettings, type Settings } from "../src/storage/persist";
import { escapeHtml } from "../src/ui/html";

const TOKEN = "s3cret-token-xyz";

function mount(initial: Settings, connection: ConnectionState = { kind: "none" }, locale: "de" | "en" = "de") {
  const root = fakeRoot();
  vi.stubGlobal("document", { getElementById: () => root });
  let settings = initial;
  const saved: Settings[] = [];
  const ui = mountPhoneUi({
    getSettings: () => settings,
    saveSettings: async (next) => { saved.push(next); settings = next; },
    connection: () => connection,
    locale: () => locale,
  });
  return { root, saved, ui };
}

const tick = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

describe("phone page", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
    vi.stubGlobal("navigator", { language: "de-AT" });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("first run: explains what to do and offers an empty address field", () => {
    const { root } = mount({ serverUrl: "", invertScroll: false });
    expect(root.innerHTML).toContain("Erster Start");
    expect(root.get("#url").value).toBe("");
    expect(root.innerHTML).toContain("Adresse des Xaventra-Endpunkts");
    expect(root.innerHTML).toContain("Token (NOVA_EVEN_G2_TOKEN)");
    expect(root.innerHTML).toContain("tailscale serve --bg --https=8790 http://127.0.0.1:18790");
  });

  it("saves a valid address, keeps the stored token when the field is empty, and never shows it", async () => {
    const { root, saved } = mount({ serverUrl: "https://old.example", token: TOKEN, invertScroll: true });
    expect(root.innerHTML).not.toContain(TOKEN);
    expect(root.innerHTML).toContain("gesetzt (16 Zeichen)");
    root.get("#url").value = "https://xaventra.example:8790/";
    root.get("#save").fire("click");
    await tick();
    expect(saved).toEqual([{ serverUrl: "https://xaventra.example:8790", token: TOKEN, invertScroll: true }]);
    expect(root.innerHTML).toContain("Gespeichert.");
    expect(root.innerHTML).not.toContain(TOKEN);
  });

  it("replaces the token when a new one is typed, and empties the field afterwards", async () => {
    const { root, saved } = mount({ serverUrl: "https://x.example", token: TOKEN, invertScroll: false });
    root.get("#token").value = " new-token ";
    root.get("#save").fire("click");
    await tick();
    expect(saved[0]?.token).toBe("new-token");
    expect(root.get("#token").value).toBe("");
  });

  it("refuses bad addresses and saves nothing", async () => {
    const { root, saved } = mount({ serverUrl: "", invertScroll: false });
    for (const url of ["ftp://x", "https://user:pw@x.example", "https://x.example/?a=1", ""]) {
      root.get("#url").value = url;
      root.get("#save").fire("click");
      await tick();
    }
    expect(saved).toEqual([]);
  });

  it("can clear the token", async () => {
    const { root, saved } = mount({ serverUrl: "https://x.example", token: TOKEN, invertScroll: false });
    root.get("#clear-token").fire("click");
    await tick();
    expect(saved).toEqual([{ serverUrl: "https://x.example", invertScroll: false }]);
  });

  it("warns about plain http but not for a local test address", () => {
    expect(mount({ serverUrl: "http://xaventra.example:18790", invertScroll: false }).root.innerHTML).toContain("Mixed Content");
    expect(mount({ serverUrl: "http://127.0.0.1:18790", invertScroll: false }).root.innerHTML).not.toContain("Mixed Content");
  });

  it("shows the connection state, with the reason for an error", () => {
    expect(mount({ serverUrl: "https://x.example", invertScroll: false }, { kind: "ok" }).root.innerHTML).toContain("Verbunden.");
    expect(mount({ serverUrl: "https://x.example", invertScroll: false }, { kind: "error", reason: "Token abgelehnt (401)" }).root.innerHTML).toContain("Fehler: Token abgelehnt (401)");
  });

  it("escapes everything it prints", () => {
    expect(escapeHtml(`<b onclick="x">&'`)).toBe("&lt;b onclick=&quot;x&quot;&gt;&amp;&#39;");
    const { root } = mount({ serverUrl: "https://x.example/\"><script>", invertScroll: false });
    expect(root.innerHTML).not.toContain("<script>");
  });
});

describe("stored settings", () => {
  it("drops an invalid stored address and a non-string token", () => {
    expect(parseSettings("")).toEqual({ serverUrl: "", invertScroll: false });
    expect(parseSettings("not json")).toEqual({ serverUrl: "", invertScroll: false });
    expect(parseSettings(JSON.stringify({ serverUrl: "https://u:p@x.example", token: 5 }))).toEqual({ serverUrl: "", invertScroll: false });
    expect(parseSettings(JSON.stringify({ serverUrl: "https://x.example", token: "t", invertScroll: true }))).toEqual({ serverUrl: "https://x.example", token: "t", invertScroll: true });
  });

  it("masks a token without revealing it", () => {
    expect(maskToken(undefined, "en")).toBe("none");
    expect(maskToken("abcdefgh", "de")).toBe("gesetzt (8 Zeichen)");
    expect(maskToken("abcdefgh", "en")).not.toContain("abcd");
  });
});
