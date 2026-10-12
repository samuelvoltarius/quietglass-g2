import { describe, expect, it } from "vitest";
import { ApiError, classifyError, createClient, insecureServer, serverHost } from "../src/api/client";
import { emptyReport } from "../src/api/empty";
import { buildView, createModel, decide, linkBlocks, mergeReport, withLink } from "../src/hub/model";
import { demoReport } from "../src/api/demo";
import { parseSetupQr } from "../src/setup/qr";
import { DEFAULT_SETTINGS, loadSettings, saveSettings, SETTINGS_KEY, type SettingsBridge } from "../src/setup/settings";

const T0 = 1_000_000;
const text = (m: ReturnType<typeof createModel>, locale: "de" | "en" = "de"): string => { const v = buildView(m, locale, T0); return [v.header, ...v.body, v.footer].join("\n"); };
const missing = () => withLink(createModel(emptyReport()), { problem: "missing", host: "", fails: 1, hadData: false });

describe("no demo data when disconnected", () => {
  it("empty report has no agents, devices, printer job or events", () => {
    const r = emptyReport();
    expect(r.agents).toEqual([]);
    expect(r.home.devices).toEqual([]);
    expect(r.printer.job).toBeNull();
    expect(r.inbox.events).toEqual([]);
  });

  it("no server: every page says not connected and shows the QR instruction", () => {
    for (const screen of ["root", "agent", "home", "printer", "inbox"] as const) {
      const out = text({ ...missing(), screen });
      expect(out).toContain("Nicht verbunden · Server fehlt");
      expect(out).toContain("QR scannen");
      expect(out).not.toMatch(/online|Licht|druckt|Demo/);
    }
  });

  it.each([
    ["unreachable", "Server nicht erreichbar"],
    ["unauthorized", "Token falsch"],
    ["timeout", "Zeitüberschreitung"],
    ["insecure", "Server muss https sein"],
  ] as const)("%s shows the exact reason and the host", (problem, title) => {
    const out = text(withLink(createModel(emptyReport()), { problem, host: "pi.example:8787", fails: 2, hadData: false }));
    expect(out).toContain(title);
    expect(out).toContain("pi.example:8787");
  });

  it("insecure hint names the https form", () => {
    expect(text(withLink(createModel(emptyReport()), { problem: "insecure", host: "100.2.3.4:8787", fails: 1, hadData: false }))).toContain("ts.net:8443");
  });

  it("a single blip on a working link keeps the data, two in a row block it", () => {
    const live = createModel(demoReport());
    const blip = withLink(live, { problem: "timeout", host: "h", fails: 1, hadData: true });
    expect(linkBlocks(blip.link)).toBe(false);
    expect(text(blip)).toContain("2/3 online");
    expect(blip.report.connection).toBe("error");
    expect(linkBlocks(withLink(live, { problem: "timeout", host: "h", fails: 2, hadData: true }).link)).toBe(true);
  });

  it("tap while blocked retries; a successful report clears the notice", () => {
    const out = decide(missing(), "click", T0);
    expect(out.effect).toEqual({ kind: "refresh" });
    const healed = mergeReport(missing(), demoReport());
    expect(healed.link).toBeNull();
    expect(text(healed)).toContain("2/3 online");
  });

  it("daemon stand-in home/printer data is shown as not set up, not as fake items", () => {
    const report = { ...demoReport(), home: { ...demoReport().home, demo: true }, printer: { ...demoReport().printer, demo: true } };
    const home = text({ ...createModel(report), screen: "home" });
    const printer = text({ ...createModel(report), screen: "printer" });
    expect(home).toContain("nicht eingerichtet");
    expect(printer).toContain("nicht eingerichtet");
    expect(home + printer).not.toMatch(/DEMO/);
  });
});

describe("client errors", () => {
  const fail = (impl: typeof fetch) => createClient({ baseUrl: "http://h:1", token: "t", fetchImpl: impl, timeoutMs: 30 });
  it("classifies network, 401 and timeout", async () => {
    const net = await fail((async () => { throw new TypeError("Failed to fetch"); }) as typeof fetch).report().catch((e) => e);
    expect(classifyError(net)).toBe("unreachable");
    const auth = await fail((async () => new Response("{}", { status: 401 })) as typeof fetch).report().catch((e) => e);
    expect(classifyError(auth)).toBe("unauthorized");
    const slow = await fail(((_u: string, init: RequestInit) => new Promise((_r, rej) => init.signal?.addEventListener("abort", () => rej(new Error("aborted"))))) as unknown as typeof fetch).report().catch((e) => e);
    expect(slow).toBeInstanceOf(ApiError);
    expect(classifyError(slow)).toBe("timeout");
    expect(classifyError(new ApiError("HTTP 500", 500))).toBe("error");
  });
  it("host never contains credentials; https page blocks http servers", () => {
    expect(serverHost("http://100.1.2.3:8787/x")).toBe("100.1.2.3:8787");
    expect(serverHost("")).toBe("");
    expect(insecureServer("http://pi:8787", "https:")).toBe(true);
    expect(insecureServer("https://pi.ts.net:8443", "https:")).toBe(false);
    expect(insecureServer("http://localhost:8787", "http:")).toBe(false);
  });
});

describe("QR import persists through the SDK store", () => {
  const sdk = (ok = true) => {
    const store = new Map<string, string>();
    const bridge: SettingsBridge = {
      getLocalStorage: async (k) => store.get(k) ?? "",
      setLocalStorage: async (k, v) => { if (ok) store.set(k, v); return ok; },
    };
    return { bridge, store };
  };
  const mirror = () => { const m = new Map<string, string>(); return { setItem: (k: string, v: string) => void m.set(k, v), getItem: (k: string) => m.get(k) ?? null, m }; };

  it("a scanned QR is written to the SDK store and read back", async () => {
    const parsed = parseSetupQr("https://pi.ts.net:8444/#server=https%3A%2F%2Fpi.ts.net%3A8443&token=abc", true);
    const settings = { ...parsed, invertScroll: false, voiceAutoSend: false };
    const { bridge, store } = sdk();
    const web = mirror();
    expect(await saveSettings(bridge, settings, web)).toEqual({ persisted: true });
    expect(JSON.parse(store.get(SETTINGS_KEY)!).serverUrl).toBe("https://pi.ts.net:8443");
    // A fresh WebView origin has an empty window.localStorage but the same SDK store.
    expect((await loadSettings(bridge, mirror())).token).toBe("abc");
  });
  it("reports persisted=false when the SDK store refuses", async () => {
    expect(await saveSettings(sdk(false).bridge, DEFAULT_SETTINGS, mirror())).toEqual({ persisted: false });
  });
});
