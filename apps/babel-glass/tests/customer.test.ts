import { describe, expect, it } from "vitest";
import {
  customerIdleRow, customerPhoneLine, customerRows, customerUrl, fetchCustomer, readCustomer, type CustomerContext,
} from "../src/companion/customer";
import { buildView, BODY_ROWS, POPUP_WIDTH, sheetNext, sheetPageCount, type ViewOptions } from "../src/glasses/view";
import { ROW_WIDTH } from "../src/glasses/footer";
import { createBuffer } from "../src/captions/buffer";
import { conversationInner } from "../src/ui/phone";

const chars = (text: string): number => [...text].length;
const sample: CustomerContext = {
  name: "Beispiel Café", project: "Imagefilm Frühstück", date: "2026-10-14", place: "Beispielgasse 1",
  ideas: ["Latte-Art in Zeitlupe", "Mehlstaub im Gegenlicht"], storyboards: [{ title: "Morgenroutine", scenes: ["Ankunft", "Siebträger"] }],
  slogans: ["Dein Morgen beginnt hier"],
};

describe("0.6.2 Shoot Day customer", () => {
  it("builds the proxy URL next to the language model", () => {
    expect(customerUrl("https://h.example:8448/v1")).toBe("https://h.example:8448/context/customer?full=1");
    expect(customerUrl("https://h.example/v1/chat/completions/")).toBe("https://h.example/context/customer?full=1");
  });

  it("reads only an enabled answer with a name", () => {
    expect(readCustomer({ enabled: false, name: "X" })).toBeNull();
    expect(readCustomer({ enabled: true, name: "" })).toBeNull();
    expect(readCustomer(null)).toBeNull();
    const c = readCustomer({ enabled: true, name: "Beispiel Café", ideas: ["a", 3, ""], storyboards: [{ title: "", scenes: ["s"] }, 5], slogans: ["x"] })!;
    expect(c.ideas).toEqual(["a"]);
    expect(c.storyboards).toEqual([{ title: "Storyboard", scenes: ["s"] }]);
    // An older proxy (counts only) still gives the name, with empty lists.
    expect(readCustomer({ enabled: true, name: "N", ideas: 4, storyboards: 1 })!.ideas).toEqual([]);
  });

  it("the idle row always fits the width, the name is shortened first", () => {
    for (const locale of ["de", "en"] as const) {
      expect(customerIdleRow(sample, locale, POPUP_WIDTH)).toBe(locale === "de" ? "Kunde: Beispiel Café · 2 Ideen" : "Customer: Beispiel Café · 2 ideas");
      const long = { ...sample, name: "Sehr langer Kundenname ".repeat(6) };
      const row = customerIdleRow(long, locale, POPUP_WIDTH);
      expect(chars(row)).toBeLessThanOrEqual(POPUP_WIDTH);
      expect(row).toMatch(/…· 2 (Ideen|ideas)$|… · 2 (Ideen|ideas)$/);
      expect(chars(customerIdleRow(long, locale, 20))).toBeLessThanOrEqual(20);
    }
  });

  it("popup rows: who, project, ideas, storyboard scenes, slogans; all within the width", () => {
    const rows = customerRows(sample, "de", POPUP_WIDTH);
    expect(rows[0]).toBe("Kunde: Beispiel Café");
    expect(rows).toContain("· Latte-Art in Zeitlupe");
    expect(rows).toContain("STORYBOARD: Morgenroutine");
    expect(rows.join("\n")).toContain("2. Siebträger");
    expect(rows).toContain("· Dein Morgen beginnt hier");
    for (const row of rows) expect(chars(row)).toBeLessThanOrEqual(POPUP_WIDTH);
  });

  it("fetch: answers, fails quietly, and gives up after the timeout", async () => {
    const ok = (async () => ({ ok: true, json: async () => ({ enabled: true, name: "Beispiel Café" }) })) as unknown as typeof fetch;
    expect((await fetchCustomer({ url: "https://h/v1", fetchImpl: ok }))?.name).toBe("Beispiel Café");
    const broken = (async () => { throw new Error("down"); }) as unknown as typeof fetch;
    expect(await fetchCustomer({ url: "https://h/v1", fetchImpl: broken })).toBeNull();
    const denied = (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch;
    expect(await fetchCustomer({ url: "https://h/v1", fetchImpl: denied })).toBeNull();
    const hang = (() => new Promise(() => undefined)) as unknown as typeof fetch;
    const start = Date.now();
    expect(await fetchCustomer({ url: "https://h/v1", fetchImpl: hang, timeoutMs: 30 })).toBeNull();
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("sends the key as bearer token", async () => {
    let auth = "";
    const spy = (async (_url: string, init: RequestInit) => {
      auth = (init.headers as Record<string, string>)["Authorization"] ?? "";
      return { ok: true, json: async () => ({ enabled: true, name: "N" }) };
    }) as unknown as typeof fetch;
    await fetchCustomer({ url: "https://h/v1", apiKey: "k1", fetchImpl: spy });
    expect(auth).toBe("Bearer k1");
  });

  it("0.8.1: the idle screen is always the customer list; no stale swipe-for-help screen is left", () => {
    const base: ViewOptions = { mode: "conversation", listening: false, status: "ready", translating: false, offset: 0, mock: false, locale: "de" };
    const view = buildView(createBuffer(), { ...base, picker: { rows: ["> Beispiel Café · heute 09:00", "  Ohne Kunde – Übersetzen"] } });
    expect(view.header).toBe("BABEL · Kunde wählen");
    expect(view.body).toEqual(["> Beispiel Café · heute 09:00", "  Ohne Kunde – Übersetzen"]);
    // Without the side menu the hold opens the help again; the swipe hint makes way for it (one row only).
    expect(view.footer).toBe("Tippen = Start · Halten = Hilfe · 2× = Ende");
    expect(view.body.length).toBeLessThanOrEqual(BODY_ROWS);
    for (const locale of ["de", "en"] as const) {
      const idle = buildView(createBuffer(), { ...base, locale });
      expect(idle.body.join(" ")).not.toMatch(/Hilfe|help/i);
      expect(idle.footer).toMatch(locale === "de" ? /Halten = Hilfe/ : /Hold = help/);
      expect(idle.footer).not.toMatch(/Seitenmenü|side menu|Menü|menu/);
      expect(chars(idle.footer)).toBeLessThanOrEqual(ROW_WIDTH);
    }
  });

  it("paged popup: Seite x/y, the last page ends with 'Ende', a swipe past it closes", () => {
    const base: ViewOptions = { mode: "conversation", listening: false, status: "ready", translating: false, offset: 0, mock: false, locale: "de" };
    const rows = customerRows({ ...sample, ideas: Array.from({ length: 12 }, (_, i) => "Idee " + i) }, "de", POPUP_WIDTH);
    const pages = sheetPageCount(rows, "de");
    expect(pages).toBeGreaterThan(1);
    const first = buildView(createBuffer(), { ...base, help: { rows, page: 0, title: "Kunde" } });
    expect(first.header).toBe("BABEL · Kunde");
    expect(first.footer).toBe(`Seite 1/${pages} · Wischen = blättern · 2× = zurück`);
    const last = buildView(createBuffer(), { ...base, help: { rows, page: pages - 1, title: "Kunde" } });
    expect(last.footer).toBe(`Seite ${pages}/${pages} · Tippen = schließen · 2× = zurück`);
    expect(last.body.at(-1)).toBe("— Ende · Tippen = schließen —");
    let page: number | null = 0;
    const visited: number[] = [];
    while (page !== null) { visited.push(page); page = sheetNext(page, rows, "de"); }
    expect(visited).toEqual(Array.from({ length: pages }, (_, i) => i));
  });

  it("phone: one line in the conversation card", () => {
    expect(customerPhoneLine(sample, "de")).toBe("Kunde (Shoot Day): Beispiel Café – 2 Ideen, 1 Storyboards");
    const html = conversationInner({ log: [], pending: null, summary: null, insights: [], canSummarize: false, customerLine: customerPhoneLine(sample, "de") }, "de");
    expect(html).toContain("Kunde (Shoot Day): Beispiel Café – 2 Ideen, 1 Storyboards");
    expect(conversationInner({ log: [], pending: null, summary: null, insights: [], canSummarize: false }, "de")).not.toContain("Shoot Day");
  });
});
