import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";
import type { Departure, Stop } from "../transit/types";
import type { Destination, Journey } from "../route/journey";
import type { StepOverride } from "../route/guide";

/**
 * What NextStop was doing: the guide that is running, the bus being followed,
 * the stop picked on the board. The Even app unloads NextStop after the phone
 * was locked for a while; the next start carries on from here instead of
 * dropping the passenger back on an empty board in the middle of a journey.
 *
 * Kept on the phone only (the Even app's per-app storage), like the places.
 */
export const SESSION_KEY = "quietglass.nextstop.session.v1";
/** A followed bus or an open page older than this is history, not a session. */
export const SESSION_MAX_AGE_MS = 2 * 60 * 60 * 1000;
/** A guide stays restorable until this long after its planned arrival. */
export const GUIDE_GRACE_MS = 30 * 60 * 1000;

export type SavedScreen = "board" | "places" | "guide";

export interface SavedSession {
  readonly savedAt: number;
  readonly screen: SavedScreen;
  readonly stopId: string | null;
  readonly follow: { readonly departure: Departure; readonly stop: Stop } | null;
  readonly guide: {
    readonly journey: Journey;
    readonly target: Destination;
    readonly override: StepOverride | null;
  } | null;
}

/**
 * Where the passenger stood when the route was planned is not kept: a walking
 * leg's start becomes its end (nothing outside the demo reads the start).
 * What remains are stops, times and the destination — no position.
 */
export function withoutPosition(journey: Journey): Journey {
  return { ...journey, legs: journey.legs.map((leg) => (leg.kind === "walk" ? { ...leg, fromLat: leg.toLat, fromLon: leg.toLon } : leg)) };
}

/** Dates travel as `{"$d": ms}`, so they come back as Dates and nothing else does. */
export function encodeSession(session: SavedSession): string {
  const clean: SavedSession = session.guide ? { ...session, guide: { ...session.guide, journey: withoutPosition(session.guide.journey) } } : session;
  return JSON.stringify(clean, function replacer(this: Record<string, unknown>, key: string, value: unknown) {
    const raw = this[key];
    return raw instanceof Date ? { $d: raw.getTime() } : value;
  });
}

export function decodeSession(raw: string, now = Date.now()): SavedSession | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw, (_key, item: unknown) => {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const keys = Object.keys(item);
        const ms = (item as { $d?: unknown }).$d;
        if (keys.length === 1 && typeof ms === "number" && Number.isFinite(ms)) return new Date(ms);
      }
      return item;
    });
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<SavedSession> & Record<string, unknown>;
  if (typeof v.savedAt !== "number" || now - v.savedAt > SESSION_MAX_AGE_MS || v.savedAt > now + 60_000) return null;
  const screen: SavedScreen = v.screen === "guide" || v.screen === "places" ? v.screen : "board";
  const stopId = typeof v.stopId === "string" ? v.stopId : null;

  let guide: SavedSession["guide"] = null;
  const g = v.guide as SavedSession["guide"] | undefined;
  if (g && isJourney(g.journey) && isDestination(g.target) && g.journey.end.getTime() + GUIDE_GRACE_MS > now) {
    const o = g.override as StepOverride | null | undefined;
    const override = o && typeof o.index === "number" && typeof o.autoAtSet === "number" ? { index: o.index, autoAtSet: o.autoAtSet } : null;
    guide = { journey: g.journey, target: g.target, override };
  }

  let follow: SavedSession["follow"] = null;
  const f = v.follow as SavedSession["follow"] | undefined;
  if (f && isDeparture(f.departure) && isStop(f.stop)) follow = { departure: f.departure, stop: f.stop };

  return { savedAt: v.savedAt, screen: screen === "guide" && !guide ? "board" : screen, stopId, follow, guide };
}

export async function loadSession(bridge: EvenAppBridge): Promise<SavedSession | null> {
  return decodeSession((await bridge.getLocalStorage(SESSION_KEY).catch(() => "")) ?? "");
}

export async function saveSession(bridge: EvenAppBridge, session: SavedSession): Promise<void> {
  await bridge.setLocalStorage(SESSION_KEY, encodeSession(session));
}

function isDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function isDestination(value: unknown): value is Destination {
  const d = value as Destination | undefined;
  return !!d && typeof d.name === "string" && typeof d.lat === "number" && typeof d.lon === "number";
}

function isJourney(value: unknown): value is Journey {
  const j = value as Journey | undefined;
  return !!j && Array.isArray(j.legs) && j.legs.length > 0 && isDate(j.start) && isDate(j.end) && isDestination(j.destination)
    && j.legs.every((leg) => !!leg && (leg.kind === "walk" ? isDate(leg.start) && isDate(leg.end) : leg.kind === "transit" && Array.isArray(leg.stops)));
}

function isStop(value: unknown): value is Stop {
  const s = value as Stop | undefined;
  return !!s && typeof s.id === "string" && typeof s.name === "string" && typeof s.lat === "number" && typeof s.lon === "number";
}

function isDeparture(value: unknown): value is Departure {
  const d = value as Departure | undefined;
  return !!d && typeof d.tripId === "string" && isDate(d.expected) && isDate(d.scheduled);
}
