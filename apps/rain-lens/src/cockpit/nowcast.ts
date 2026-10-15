/**
 * The cockpit's headline answer - "will it rain, and when?" - from
 * Open-Meteo's 15-minute precipitation (`minutely_15`, real 15-minute model
 * data in Central Europe, interpolated elsewhere), falling back to hourly
 * values. Pure: slots in, answer out.
 *
 * Open-Meteo sends local wall-clock times without an offset (`timezone=auto`)
 * plus `utc_offset_seconds`; slots carry both the real instant (for "in 25
 * min") and the place's own HH:MM (for "dry until 18:00").
 */

export interface PrecipSlot {
  /** Start of the slot, epoch ms. */
  readonly start: number;
  /** Length of the slot in minutes (15 or 60). */
  readonly minutes: number;
  /** Precipitation in the slot, mm. */
  readonly precipitation: number;
  readonly weatherCode: number;
  /** Start as the place's local "HH:MM". */
  readonly local: string;
}

export type Nowcast =
  | { readonly kind: "now"; readonly snow: boolean }
  | { readonly kind: "soon"; readonly snow: boolean; readonly minutes: number }
  | { readonly kind: "dryUntil"; readonly snow: boolean; readonly time: string }
  | { readonly kind: "dry" }
  | { readonly kind: "unknown" };

/** 0.1 mm in 15 minutes counts as rain (a light shower; less is a stray model drop). */
export const RAIN_PER_15_MIN = 0.1;
/** Rain further away than this is told as "dry until HH:MM" instead of "in ~N min". */
export const SOON_MINUTES = 90;
/** How far ahead the headline looks. */
export const HORIZON_MINUTES = 12 * 60;

/** The threshold for a slot of `minutes`: 0.1 mm per 15 min, a bit lower per hour (hourly totals smooth showers out). */
export function wetThreshold(minutes: number): number {
  return minutes <= 15 ? RAIN_PER_15_MIN : Math.round(RAIN_PER_15_MIN * (minutes / 15) * 0.75 * 100) / 100;
}

/** WMO codes for snow (snowfall, snow grains, snow showers). */
export function isSnowCode(code: number): boolean {
  return (code >= 71 && code <= 77) || code === 85 || code === 86;
}

export const isWet = (slot: PrecipSlot): boolean => slot.precipitation >= wetThreshold(slot.minutes) - 1e-9;

/** Rounds "minutes until" for the headline: steps of 5, at least 5. */
export function roundMinutes(minutes: number): number {
  return Math.max(5, Math.round(minutes / 5) * 5);
}

export function nowcast(slots: readonly PrecipSlot[], now: number, horizonMinutes = HORIZON_MINUTES): Nowcast {
  const sorted = [...slots].filter((slot) => Number.isFinite(slot.start) && Number.isFinite(slot.precipitation)).sort((a, b) => a.start - b.start);
  const end = (slot: PrecipSlot): number => slot.start + slot.minutes * 60_000;
  const ahead = sorted.filter((slot) => end(slot) > now);
  if (ahead.length === 0) return { kind: "unknown" };
  const current = ahead.find((slot) => slot.start <= now);
  if (current && isWet(current)) return { kind: "now", snow: isSnowCode(current.weatherCode) };
  const limit = now + horizonMinutes * 60_000;
  const next = ahead.find((slot) => slot.start > now && slot.start <= limit && isWet(slot));
  if (!next) return { kind: "dry" };
  const minutes = (next.start - now) / 60_000;
  const snow = isSnowCode(next.weatherCode);
  return minutes <= SOON_MINUTES ? { kind: "soon", snow, minutes: roundMinutes(minutes) } : { kind: "dryUntil", snow, time: next.local };
}

/** Precipitation expected from now over the next `minutes` (the slot under way counts in full), mm. */
export function rainTotal(slots: readonly PrecipSlot[], now: number, minutes = 120): number {
  const limit = now + minutes * 60_000;
  const sum = slots.filter((slot) => slot.start + slot.minutes * 60_000 > now && slot.start < limit).reduce((total, slot) => total + Math.max(0, slot.precipitation), 0);
  return Math.round(sum * 10) / 10;
}

/** "2026-10-13T21:30" at `offsetSeconds` from UTC → epoch ms; NaN when malformed. */
export function localToEpoch(time: string, offsetSeconds: number): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(time);
  if (!match) return Number.NaN;
  const [, y, mo, d, h, mi] = match;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi)) - offsetSeconds * 1000;
}

const toNumber = (value: unknown): number => (typeof value === "number" ? value : Number.NaN);

/** Slots from Open-Meteo arrays (`minutely_15` or `hourly`); entries with missing values are left out. */
export function parseSlots(times: unknown, precipitation: unknown, codes: unknown, offsetSeconds: number, minutes: number): PrecipSlot[] {
  if (!Array.isArray(times) || !Array.isArray(precipitation)) return [];
  const codeList = Array.isArray(codes) ? codes : [];
  const slots: PrecipSlot[] = [];
  times.forEach((time, index) => {
    if (typeof time !== "string") return;
    const start = localToEpoch(time, offsetSeconds); const amount = toNumber(precipitation[index]);
    if (!Number.isFinite(start) || !Number.isFinite(amount)) return;
    const code = toNumber(codeList[index]);
    slots.push({ start, minutes, precipitation: amount, weatherCode: Number.isFinite(code) ? code : 0, local: time.slice(11, 16) });
  });
  return slots;
}
