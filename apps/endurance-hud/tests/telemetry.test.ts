import { describe, expect, it } from "vitest";
import { elapsed, pace, parseTelemetry } from "../src/telemetry/model";
describe("telemetry", () => { it("normalizes a Garmin-style payload", () => expect(parseTelemetry({ sport: "run", speedKph: "12.5", powerWatts: 301 }).powerWatts).toBe(301)); it("formats pace", () => expect(pace(305)).toBe("5:05")); it("formats elapsed time", () => expect(elapsed(3661)).toBe("1:01:01")); });
