import { describe, expect, it } from "vitest";
import { money, parsePositions, shorten } from "../src/markets/model";
describe("markets", () => { it("normalizes positions", () => expect(parsePositions({ positions: [{ provider: "kalshi", title: "Test", quantity: "2" }] })[0]?.quantity).toBe(2)); it("formats losses", () => expect(money(-1.2)).toBe("-$1.20")); it("shortens titles", () => expect(shorten("abcdefgh", 6)).toBe("abc...")); });
