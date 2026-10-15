import { formatDistance, formatEta } from "../geo/geometry";
import type { ManeuverType } from "../routing/provider";
import type { Progress } from "../nav/navigator";
import { tr, type Locale } from "../i18n";
import { messages } from "../messages";
import { overLimit, type SpeedReading } from "../nav/speed";
import type { BatteryEstimate, BatteryRange } from "../car/byd";
import { sugarChip, type SugarDisplay } from "../sugar/glucose";
import { arrivalDelta, arrivalText } from "../appointments/appointments";
import type { BrakeHint } from "../nav/brake";
import type { SpeedingWarning } from "../nav/speeding";
import { cameraText, type CameraAhead } from "../nav/cameras";
import { detourText, trafficText, TRAFFIC_NEAR_M, type TrafficAhead } from "../traffic/traffic";
import { armedStopFooter } from "./footer";
import { clip, roadLabel, type NavView } from "./view";

/**
 * The HUD layout for driving (default since 0.14.0, phone setting
 * "HUD-Layout: neu/klassisch"), in the style of a car head-up display:
 *
 * ```
 * 14:32 · 23 km · 128→            ┌────────┐
 * Akku 72% → 41% · 180 km         │  ARROW │  200 × 200, right
 *  (50)   limit sign              │        │
 *                ZU SCHNELL 58 / 50 (only when too fast, centre)
 * 52 km/h                         └────────┘
 *                                  250 m
 *                                  Vogelweiderstraße
 *            ▼ 50 in 300 m – vom Gas      <- ONE alert line, bottom centre
 * ```
 *
 * The middle stays empty unless the wearer is too fast. Only the arrow and
 * the limit sign are images; they change with the manoeuvre type and the
 * limit. All else is text, the cheap `textContainerUpgrade` path.
 */

/** Text boxes of the HUD page (x, y, width, height on the 576 × 288 display). */
export const HUD_BOXES = {
  status: { x: 0, y: 0, width: 336, height: 62 },
  center: { x: 120, y: 110, width: 248, height: 34 },
  distance: { x: 368, y: 200, width: 208, height: 30 },
  street: { x: 248, y: 226, width: 328, height: 30 },
  alert: { x: 0, y: 256, width: 576, height: 32 },
} as const;

/**
 * Image boxes: the arrow in two halves on the right, the limit sign and the
 * speed in large digits on the left (the glasses have one text size only, so
 * large digits must be a picture).
 */
export const HUD_IMAGES = {
  // Sides in multiples of 8 (0.17.10 with 200 × 100 and 184 × 62 was refused on the glasses; see render.ts).
  arrowTop: { x: 376, y: 0, width: 192, height: 96 },
  arrowBottom: { x: 376, y: 96, width: 192, height: 96 },
  limit: { x: 24, y: 70, width: 96, height: 96 },
  speed: { x: 0, y: 168, width: 184, height: 64 },
} as const;

/**
 * Average advance of the glasses font in px per character, derived from the
 * Quietglass row budget (56 characters across 576 px, with padding). Used to
 * size every line to its box; a wide character mix stays inside because the
 * budget is taken a little generously (10.5 instead of ~10.1).
 */
export const HUD_CHAR_PX = 10.5;
const PADDING = 4;

/** Characters that fit one line of a box. */
export function hudChars(width: number): number {
  return Math.floor((width - 2 * PADDING) / HUD_CHAR_PX);
}

export const HUD_WIDTH = {
  status: hudChars(HUD_BOXES.status.width),
  center: hudChars(HUD_BOXES.center.width),
  distance: hudChars(HUD_BOXES.distance.width),
  street: hudChars(HUD_BOXES.street.width),
  alert: hudChars(HUD_BOXES.alert.width),
} as const;

/** What the HUD page shows; text fields go out as text, `arrow` and `limit` pick the two pictures. */
export interface HudContent {
  readonly status: string;
  readonly speed: string;
  readonly center: string;
  readonly distance: string;
  readonly street: string;
  readonly alert: string;
  /** Manoeuvre of the arrow image; null = no arrow (blank). */
  readonly arrow: ManeuverType | null;
  /** Limit on the sign; null = no sign. */
  readonly limit: number | null;
  /** The speed in large digits (an image); null = blank. */
  readonly speedBig?: SpeedBig | null;
  /** Which alert owns the line (null = none, or a navigation state): a tap acts on the detour only while it is shown. */
  readonly alertKind?: AlertKind | null;
}

export interface HudOptions {
  readonly locale?: Locale;
  readonly mock?: boolean;
  /** Distance to the turn now (dead reckoned between fixes); the progress value when absent. */
  readonly distanceToTurn?: number;
  readonly speed?: SpeedReading | null;
  readonly battery?: BatteryEstimate | null;
  readonly range?: BatteryRange | null;
  readonly sugar?: SugarDisplay | null;
  readonly brake?: BrakeHint | null;
  readonly speeding?: SpeedingWarning | null;
  readonly charger?: string | null;
  readonly appointment?: { readonly startMs: number; readonly title: string } | null;
  /** The next jam/closure/roadworks ahead on the route (own traffic service). */
  readonly traffic?: TrafficAhead | null;
  /** A fixed enforcement point ahead (already filtered: setting on, not in Germany). */
  readonly camera?: CameraAhead | null;
  /** Another way that saves this many minutes; a tap takes it. */
  readonly detour?: { readonly savesMin: number } | null;
  /**
   * A navigation state that would otherwise need another page (a rebuild costs
   * seconds on the glasses): it takes the alert line, the armed stop also the centre.
   */
  readonly state?: HudState | null;
}

export type HudState = "armed" | "offRoute" | "rerouting" | "waitingFix";

const STATE_KEY: Readonly<Record<Exclude<HudState, "armed">, string>> = {
  offRoute: "h.offRoute",
  rerouting: "g.rerouting",
  waitingFix: "g.waitingFix",
};

export type AlertKind =
  | "sugarLowFalling" | "brake" | "sugarLow" | "trafficNear" | "camera" | "detour" | "trafficFar"
  | "lowBattery" | "appointment" | "charger";

/**
 * Which alert owns the one line, highest first: glucose low AND falling
 * stays above everything; then the brake hint - unless the wearer is already
 * too fast for the CURRENT limit, when the speeding warning in the centre
 * speaks and the line falls through to the next one; then glucose low; a
 * jam or closure less than TRAFFIC_NEAR_M ahead; the speed hint before a
 * fixed enforcement point; a detour offer; traffic further ahead; a low
 * arrival battery, the appointment arrival, the next charger.
 */
export const ALERT_ORDER: readonly AlertKind[] = [
  "sugarLowFalling", "brake", "sugarLow", "trafficNear", "camera", "detour", "trafficFar", "lowBattery", "appointment", "charger",
];

function t(locale: Locale, key: string, vars: Record<string, string | number> = {}): string {
  return tr(messages, locale, key, vars);
}

/** The alert line candidates present right now, in priority order. */
export function alertCandidates(progress: Progress, options: HudOptions, now: number): { kind: AlertKind; text: string }[] {
  const locale = options.locale ?? "en";
  const out: { kind: AlertKind; text: string }[] = [];
  const sugar = options.sugar;
  for (const kind of ALERT_ORDER) {
    switch (kind) {
      case "sugarLowFalling":
        if (sugar?.warning === "lowFalling") out.push({ kind, text: t(locale, "g.sugarLowFalling", { v: sugarChip(sugar) }) });
        break;
      case "brake": {
        const brake = options.brake;
        if (brake && !options.speeding) out.push({ kind, text: brakeText(brake, locale) });
        break;
      }
      case "sugarLow":
        if (sugar?.warning === "low") out.push({ kind, text: t(locale, "g.sugarLow", { v: sugarChip(sugar) }) });
        break;
      case "trafficNear":
        if (options.traffic && options.traffic.distance < TRAFFIC_NEAR_M) out.push({ kind, text: trafficText(options.traffic, locale) });
        break;
      case "camera":
        if (options.camera) out.push({ kind, text: cameraText(options.camera, locale) });
        break;
      case "detour":
        if (options.detour) out.push({ kind, text: detourText(options.detour.savesMin, locale) });
        break;
      case "trafficFar":
        if (options.traffic && options.traffic.distance >= TRAFFIC_NEAR_M) out.push({ kind, text: trafficText(options.traffic, locale) });
        break;
      case "lowBattery":
        if (options.battery?.low) out.push({ kind, text: t(locale, "g.lowArrival", { arr: options.battery.arrival }) });
        break;
      case "appointment": {
        const appt = options.appointment;
        if (appt && Number.isFinite(progress.secondsRemaining) && progress.secondsRemaining >= 0) {
          const delta = arrivalDelta(now + progress.secondsRemaining * 1000, appt.startMs);
          out.push({ kind, text: arrivalText(formatEta(progress.secondsRemaining, now), delta, locale) });
        }
        break;
      }
      case "charger":
        if (options.charger) out.push({ kind, text: options.charger });
        break;
    }
  }
  return out;
}

/** `▼ 50 in 300 m – vom Gas`, `BREMSEN · 50 in 120 m`, `BREMSEN · 50 jetzt`. */
export function brakeText(hint: BrakeHint, locale: Locale): string {
  if (hint.phase === "coast") return t(locale, "h.coast", { v: hint.target, d: formatDistance(hint.distance, locale) });
  if (hint.distance < 20) return t(locale, "h.brakeNow", { v: hint.target });
  return t(locale, "h.brake", { v: hint.target, d: formatDistance(hint.distance, locale) });
}

/** `ZU SCHNELL  58 / 50`. */
export function speedingText(warning: SpeedingWarning, locale: Locale): string {
  return t(locale, "h.tooFast", { v: warning.kmh, l: warning.limit });
}

/** Centres `text` in a line of `width` characters with leading spaces (the font cannot be aligned). */
export function centre(text: string, width: number): string {
  const cut = clip(text, width);
  return " ".repeat(Math.max(0, Math.floor((width - cut.length) / 2))) + cut;
}

/** `Akku 72% → 41% · 180 km` / `≈180 km` for an estimate; parts give way to fit `width`. */
export function batteryLine(battery: BatteryEstimate | null | undefined, range: BatteryRange | null | undefined, locale: Locale, width: number): string {
  const km = range ? (range.estimated ? "≈" : "") + range.km + " km" : null;
  // Values from the BYD cloud (the car itself is silent) carry a short mark, kept as long as anything fits.
  const cloud = battery?.cloud || range?.cloud ? " · Cloud" : "";
  const candidates: string[] = [];
  if (battery) {
    const base = t(locale, "h.batt", { soc: battery.soc, arr: battery.arrival });
    if (km) candidates.push(base + " · " + km + cloud);
    candidates.push(base + cloud);
    if (cloud) candidates.push("Cloud " + t(locale, "h.batt", { soc: battery.soc, arr: battery.arrival }));
  } else if (km) candidates.push(t(locale, "h.range", { km }) + cloud);
  for (const line of candidates) if (line.length <= width) return line;
  return candidates.length ? clip(candidates[candidates.length - 1]!, width) : "";
}

/** The two small lines top left: arrival, distance left, glucose; battery and range. */
export function statusLines(progress: Progress, options: HudOptions, now: number): string {
  const locale = options.locale ?? "en";
  const width = HUD_WIDTH.status;
  const parts = [formatEta(progress.secondsRemaining, now), formatDistance(progress.distanceRemaining, locale)];
  if (options.sugar) parts.push(sugarChip(options.sugar));
  if (options.mock) parts.push(t(locale, "g.demoTag"));
  let first = parts.join(" · ");
  // Glucose stays when it does not fit with the tag; the tag goes first.
  if (first.length > width && options.mock) first = parts.slice(0, -1).join(" · ");
  const second = batteryLine(options.battery, options.range, locale, width);
  return [clip(first, width), second].filter((line) => line !== "").join("\n");
}

/** What the large speed digits show: the value, inverted when too fast, a small `gps` when the car link fell back to the phone. */
export interface SpeedBig {
  readonly kmh: number | null;
  readonly fast: boolean;
  readonly gps: boolean;
}

export function speedBig(reading: SpeedReading | null | undefined): SpeedBig | null {
  if (!reading) return null;
  return { kmh: reading.kmh, fast: overLimit(reading.kmh, reading.limit), gps: reading.source === "gps" };
}

/** Changes exactly when the speed picture would look different. */
export function speedBigKey(value: SpeedBig | null | undefined): string {
  return value ? `${value.kmh ?? "-"}|${value.fast ? 1 : 0}|${value.gps ? 1 : 0}` : "blank";
}

/** `52 km/h`, `!57! km/h` over the limit, `— km/h` unknown; a second line `GPS` when the car link fell back to the phone. */
export function hudSpeed(reading: SpeedReading | null | undefined): string {
  if (!reading) return "";
  const fast = overLimit(reading.kmh, reading.limit);
  const value = reading.kmh === null ? "—" : fast ? `!${reading.kmh}!` : String(reading.kmh);
  return value + " km/h" + (reading.source === "gps" ? "\nGPS" : "");
}

/** The whole HUD for a progress on a route (not arrived, not off route: those keep the text page). */
export function buildHud(progress: Progress, options: HudOptions, now = Date.now()): HudContent {
  const locale = options.locale ?? "en";
  const maneuver = progress.maneuver;
  const distanceM = options.distanceToTurn ?? progress.distanceToManeuver;
  let distance = formatDistance(distanceM, locale);
  if (maneuver?.type === "roundabout" && maneuver.exitNumber) distance += " · " + t(locale, "g.exit", { n: maneuver.exitNumber });
  const candidates = alertCandidates(progress, options, now);
  // Glucose low and falling stays first; a navigation state comes right after it, before every hint.
  const state = options.state ? (options.state === "armed" ? armedStopFooter(locale) : t(locale, STATE_KEY[options.state])) : null;
  const top = candidates[0]?.kind === "sugarLowFalling" || !state ? candidates[0] ?? null : null;
  const alert = (top ? top.text : state) ?? "";
  const center = options.state === "armed"
    ? t(locale, "g.armed.short")
    : options.speeding ? speedingText(options.speeding, locale) : "";
  if (options.state === "waitingFix") distance = "--";
  return {
    status: statusLines(progress, options, now),
    speed: hudSpeed(options.speed),
    center: center ? centre(center, HUD_WIDTH.center) : "",
    distance: clip(distance, HUD_WIDTH.distance),
    street: clip(roadLabel(maneuver?.street, maneuver?.instruction), HUD_WIDTH.street),
    alert: alert ? centre(alert, HUD_WIDTH.alert) : "",
    arrow: maneuver?.type ?? "straight",
    limit: options.speed?.limit ?? null,
    speedBig: speedBig(options.speed),
    alertKind: top?.kind ?? null,
  };
}

/** The HUD as a NavView, so the usual diff decides whether anything goes out. */
export function hudView(content: HudContent): NavView {
  return { header: content.status, body: [], footer: content.alert, speed: content.speed, hud: content };
}
