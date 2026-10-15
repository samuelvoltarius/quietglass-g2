import { describe, expect, it } from "vitest";
import {
  customersUrl, fetchCustomers, orderCustomers, pickBody, pickRows, readCustomers, type CustomerEntry,
} from "../src/companion/customers";
import { menuItemIdFromEvent } from "../src/input/gestures";

// 0.7.0: the start screen's customer list (fictitious names only).
const NOW = new Date(2026, 9, 14, 8, 0);
const entry = (id: string, name: string, date: string | null): CustomerEntry => ({ id, name, company: "", next: date ? { date, name: "P" } : null });

describe("0.7.0 customer list", () => {
  it("builds the proxy URL next to the language model", () => {
    expect(customersUrl("https://proxy.example:8448/v1/")).toBe("https://proxy.example:8448/context/customers");
    expect(customersUrl("https://proxy.example/v1/chat/completions")).toBe("https://proxy.example/context/customers");
  });

  it("reads the proxy answer, skipping rows without id or name", () => {
    expect(readCustomers({ customers: [{ id: "c_1", name: "Alpha", next: { date: "2026-10-14 09:00", name: "Dreh" } }, { name: "ohne id" }, 5] }))
      .toEqual([{ id: "c_1", name: "Alpha", company: "", next: { date: "2026-10-14 09:00", name: "Dreh" } }]);
    expect(readCustomers([{ id: "c_2", company: "Nur Firma" }])?.[0]?.name).toBe("Nur Firma");
    expect(readCustomers({ error: "x" })).toBeNull();
  });

  it("today first (all-day, then by time), then everyone else by name", () => {
    const list = [
      entry("a", "Zeta", "2026-10-14 14:30"), entry("b", "beta", "2099-01-01"), entry("c", "Alpha", null),
      entry("d", "Mitte", "2026-10-14 09:00"), entry("e", "Ganztag", "2026-10-14"), entry("f", "Alt", "2026-10-13 10:00"),
    ];
    expect(orderCustomers(list, NOW).map((e) => e.name)).toEqual(["Ganztag", "Mitte", "Zeta", "Alpha", "Alt", "beta"]);
  });

  it("rows per state; the last row is always 'Ohne Kunde'", () => {
    expect(pickRows({ state: "off" }, NOW).map((r) => r.kind)).toEqual(["none"]);
    expect(pickRows({ state: "failed" }, NOW).map((r) => r.kind)).toEqual(["retry", "none"]);
    expect(pickRows({ state: "ready", entries: [entry("a", "A", null)] }, NOW).map((r) => r.kind)).toEqual(["customer", "none"]);
    const body = pickBody(pickRows({ state: "failed" }, NOW), 1, NOW, "de", 56, 7);
    expect(body).toEqual(["  Kunden nicht erreichbar", "> Ohne Kunde – Übersetzen"]);
  });

  it("long lists scroll so the cursor stays visible; rows fit the width", () => {
    const entries = Array.from({ length: 12 }, (_, i) => entry("c" + i, "Kunde mit einem sehr langen Namen Nummer " + (i + 10), "2026-11-0" + ((i % 9) + 1) + " 10:00"));
    const rows = pickRows({ state: "ready", entries }, NOW);
    const body = pickBody(rows, 12, NOW, "de", 56, 7);
    expect(body).toHaveLength(7);
    expect(body.at(-1)).toBe("> Ohne Kunde – Übersetzen");
    for (const row of body) expect([...row].length).toBeLessThanOrEqual(56);
    expect(body[0]).toMatch(/…/);
  });

  it("fetch: list, quiet failure, timeout", async () => {
    const ok = (async () => ({ ok: true, json: async () => ({ customers: [{ id: "c", name: "N" }] }) })) as unknown as typeof fetch;
    expect(await fetchCustomers({ url: "https://p/v1", fetchImpl: ok })).toHaveLength(1);
    const bad = (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch;
    expect(await fetchCustomers({ url: "https://p/v1", fetchImpl: bad })).toBeNull();
    const hang = (() => new Promise(() => undefined)) as unknown as typeof fetch;
    expect(await fetchCustomers({ url: "https://p/v1", fetchImpl: hang, timeoutMs: 10 })).toBeNull();
  });

  it("side menu clicks are read like in Quiet Hub; item 0 means none", () => {
    expect(menuItemIdFromEvent({ menuItemClickEvent: { itemID: 3 } })).toBe(3);
    expect(menuItemIdFromEvent({ menuItemClickEvent: { itemId: "4" } })).toBe(4);
    expect(menuItemIdFromEvent({ menuItemClickEvent: {} })).toBeNull();
    expect(menuItemIdFromEvent({ sysEvent: { eventType: 1 } })).toBeNull();
  });
});
