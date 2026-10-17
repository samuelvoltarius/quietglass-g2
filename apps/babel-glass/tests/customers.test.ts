import { describe, expect, it } from "vitest";
import {
  customerListRow, customersUrl, fetchCustomers, orderCustomers, readCustomers, type CustomerEntry,
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

  it("a row shows the name and the next project's day; the name is shortened first", () => {
    expect(customerListRow(entry("a", "Alpha", "2026-10-14 09:00"), NOW, "de", 56)).toBe("Alpha · heute 09:00");
    expect(customerListRow(entry("a", "Alpha", null), NOW, "en", 56)).toBe("Alpha");
    const long = customerListRow(entry("a", "Kunde mit einem sehr langen Namen Nummer 12", "2026-11-02 10:00"), NOW, "de", 30);
    expect([...long].length).toBeLessThanOrEqual(30);
    expect(long).toMatch(/…/);
    expect(long.endsWith("02.11. 10:00")).toBe(true);
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
