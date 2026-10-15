/**
 * The speed display: how fast you go (from the phone's GPS) and, when the
 * router knows it, the speed limit of the road you are on.
 *
 * Both are pure: the GPS speed is smoothed here, the limits come as spans of
 * route shape indices from Valhalla's `trace_attributes` (the same request
 * that already brings the street names, see overview/route-streets.ts), and
 * the text for the glasses is built from the two numbers.
 */

/** A speed older than this is not shown any more ("—"): the GPS has gone quiet. */
export const SPEED_STALE_MS = 5_000;
/** Weight of a new reading in the smoothed speed; the rest is the previous value. */
export const SPEED_SMOOTHING = 0.5;
/** More than this many km/h over the limit is shown as "too fast". */
export const OVER_LIMIT_KMH = 5;

/**
 * Smoothed GPS speed in km/h. Readings arrive as m/s with the location; a
 * negative or missing value means "not known" (iOS reports -1), never 0.
 */
export class SpeedMeter {
  private value: number | null = null;
  private at = 0;

  push(speedMs: unknown, at: number): void {
    if (typeof speedMs !== "number" || !Number.isFinite(speedMs) || speedMs < 0) {
      this.value = null;
      return;
    }
    const kmh = speedMs * 3.6;
    // After a gap the old value says nothing about now: start afresh.
    this.value = this.value === null || at - this.at > SPEED_STALE_MS ? kmh : this.value + SPEED_SMOOTHING * (kmh - this.value);
    this.at = at;
  }

  /** Whole km/h, or null when unknown or older than {@link SPEED_STALE_MS}. */
  kmh(now: number): number | null {
    if (this.value === null || now - this.at > SPEED_STALE_MS) return null;
    return Math.round(this.value);
  }

  reset(): void {
    this.value = null;
    this.at = 0;
  }
}

/** The speed limit on the route between two shape indices; null = none posted or unknown. */
export interface SpeedLimitSpan {
  readonly from: number;
  readonly to: number;
  readonly limit: number | null;
}

/**
 * Edges of a trace_attributes answer → limit spans over the route shape.
 * `speed_limit` is km/h (the request asks for kilometres); Valhalla writes
 * "unlimited" for roads without one (German motorways) and leaves the field
 * out when it does not know. Neighbouring edges with the same limit are
 * joined. Null when the answer has no edges.
 */
export function parseSpeedLimits(value: unknown, shapeLength: number): SpeedLimitSpan[] | null {
  const edges = (value as { edges?: unknown } | null)?.edges;
  if (!Array.isArray(edges)) return null;
  const spans: SpeedLimitSpan[] = [];
  for (const raw of edges) {
    const e = raw as { speed_limit?: unknown; begin_shape_index?: unknown; end_shape_index?: unknown } | null;
    const from = e?.begin_shape_index, to = e?.end_shape_index;
    if (typeof from !== "number" || typeof to !== "number" || !(to > from) || to >= shapeLength) continue;
    const limit = typeof e?.speed_limit === "number" && e.speed_limit > 0 && e.speed_limit < 200 ? Math.round(e.speed_limit) : null;
    const last = spans[spans.length - 1];
    if (last && last.limit === limit && last.to === from) spans[spans.length - 1] = { ...last, to };
    else spans.push({ from, to, limit });
  }
  return spans;
}

/** The limit where the route position lies on segment `index` (shape[index] → shape[index + 1]). */
export function limitAt(spans: readonly SpeedLimitSpan[], index: number): number | null {
  for (const span of spans) if (index >= span.from && index < span.to) return span.limit;
  return null;
}

export function overLimit(kmh: number | null, limit: number | null): boolean {
  return kmh !== null && limit !== null && kmh > limit + OVER_LIMIT_KMH;
}

export interface SpeedReading {
  /** Smoothed km/h, null when unknown. */
  readonly kmh: number | null;
  /** Limit of the road, null when unknown or none. */
  readonly limit: number | null;
  /**
   * With a car link (private build): "car" = the car's own speed, "gps" = the
   * phone's GPS because the car value is not fresh. Absent = no car link.
   */
  readonly source?: "car" | "gps";
}

/**
 * The speed box beside the turn arrow: a narrow column (about five
 * characters), so speed and limit go on separate lines. Too fast: the speed
 * is framed by "!" — the display is green only, emphasis has to be text.
 */
export function speedColumn(reading: SpeedReading): string {
  const fast = overLimit(reading.kmh, reading.limit);
  const speed = reading.kmh === null ? "—" : fast ? `!${reading.kmh}!` : String(reading.kmh);
  // The GPS fallback is marked in the otherwise blank row, so the column keeps its width.
  const gps = reading.source === "gps";
  const lines = [speed, "km/h"];
  if (reading.limit !== null) lines.push(gps ? "GPS" : "", `[${reading.limit}]`);
  else if (gps) lines.push("GPS");
  return lines.join("\n");
}

/** One line for the map: "52 | 50 km/h", "!57! | 50 km/h" when too fast, "— km/h" when unknown. */
export function speedLine(reading: SpeedReading): string {
  const fast = overLimit(reading.kmh, reading.limit);
  const speed = reading.kmh === null ? "—" : fast ? `!${reading.kmh}!` : String(reading.kmh);
  const unit = reading.source === "gps" ? "km/h·GPS" : "km/h";
  return reading.limit !== null ? `${speed} | ${reading.limit} ${unit}` : `${speed} ${unit}`;
}
