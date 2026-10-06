import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeRoot } from "./fake-dom";
import { mountPhoneUi, type PhoneConnection } from "../src/ui/phone";
import { parseStatus, type PrinterStatus } from "../src/printer/status";
import type { Settings } from "../src/storage/persist";

function mount(initial: Settings, connection: PhoneConnection = { kind: "none" }, status: PrinterStatus | null = null) {
  const root = fakeRoot();
  vi.stubGlobal("document", { getElementById: () => root });
  let settings = initial;
  const saved: Settings[] = [];
  mountPhoneUi({
    getSettings: () => settings,
    saveSettings: async (next) => { saved.push(next); settings = next; },
    connection: () => connection,
    status: () => status,
    locale: () => "en",
  });
  return { root, saved };
}

const tick = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

describe("phone page", () => {
  beforeEach(() => { vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined }); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("saves a valid bridge address and keeps an existing token without showing it", async () => {
    const { root, saved } = mount({ bridgeUrl: "", token: "abcdef", invertScroll: false });
    expect(root.innerHTML).toContain("First run");
    expect(root.innerHTML).not.toContain("abcdef");
    root.get("#url").value = "https://bridge.example/";
    root.get("#save").fire("click");
    await tick();
    expect(saved).toEqual([{ bridgeUrl: "https://bridge.example", token: "abcdef", invertScroll: false }]);
  });

  it("refuses an invalid address", async () => {
    const { root, saved } = mount({ bridgeUrl: "", invertScroll: false });
    root.get("#url").value = "file:///etc/passwd";
    root.get("#save").fire("click");
    await tick();
    expect(root.innerHTML).toContain("must start with http");
    expect(saved).toEqual([]);
  });

  it("warns about plain http on the phone and says whether control is allowed", () => {
    const status = parseStatus({ online: true, state: "printing", progress: 3, controllable: false });
    const { root } = mount({ bridgeUrl: "http://192.0.2.4:8898", invertScroll: false }, { kind: "ok" }, status);
    expect(root.innerHTML).toContain("mixed content");
    expect(root.innerHTML).toContain("Display only");
  });

  it("escapes the stored address and an error reason", () => {
    const evil = '"><img src=x onerror=alert(1)>';
    const { root } = mount({ bridgeUrl: "https://b.example/" + evil, invertScroll: false }, { kind: "error", reason: evil });
    expect(root.innerHTML).not.toContain("<img");
    expect(root.get("#url").value).toBe("https://b.example/" + evil);
  });
});
