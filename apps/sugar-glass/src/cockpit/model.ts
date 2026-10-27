import type { Locale } from "../i18n";
import { t } from "../messages";
import { isCritical, type Alert } from "../ns/alerts";
import { delta, type Direction, type PumpStatus } from "../ns/model";
import { glucose, insulin, signedDelta, unitLabel } from "../ns/units";
import { footer } from "../glasses/footer";
import { PAGES, ageShort, ageText, currentAlerts, type Page, type ViewState } from "../glasses/views";
import { hhmm, type CockpitBar, type CockpitCell, type CockpitGraphic, type CockpitModel, type Tone } from "./compose";

/**
 * What the cockpit shows, in words and numbers, decided without drawing
 * (QUS v1): the headline, the label/value cells, the graphic for the left
 * half, the caption and the hint line. compose.ts only lays this out.
 *
 * Two pages: the glucose (big value, curve with the target band) and the pump.
 */

const DASH = "–";
/** The curve shows this many hours. */
export const CURVE_HOURS = 3;
/** A sensor lasts about a week; the bar counts the hours left against it. */
const SENSOR_HOURS = 168;

/** Where the trend arrow points: 0 = up, 90 = right, 180 = down. */
export function arrowAngle(direction: Direction): number | undefined {
  switch (direction) {
    case "TripleUp": case "DoubleUp": case "SingleUp": return 0;
    case "FortyFiveUp": return 45;
    case "Flat": return 90;
    case "FortyFiveDown": return 135;
    case "SingleDown": case "DoubleDown": case "TripleDown": return 180;
    default: return undefined;
  }
}

function trendWord(direction: Direction, locale: Locale): string {
  const angle = arrowAngle(direction);
  if (angle === undefined) return t(locale, "g.trend.none");
  return t(locale, angle < 60 ? "g.trend.up" : angle > 120 ? "g.trend.down" : "g.trend.flat");
}

/** The state of the glucose page: stale or no data is offline, a critical alert critical, a failed refresh a warning. */
export function glucoseTone(state: ViewState, list: readonly Alert[]): Tone {
  if (!state.data || state.data.readings.length === 0 || list.some((alert) => alert.kind === "stale")) return "offline";
  if (isCritical(list)) return "critical";
  return state.connection.kind === "error" ? "warn" : "ok";
}

/** The second headline line: the worst alert as a word, otherwise the trend. */
export function statusWord(state: ViewState, list: readonly Alert[]): string {
  const { locale } = state;
  if (!state.data) return t(locale, state.connection.kind === "error" ? "g.state.noServer" : "g.state.loading");
  if (state.data.readings.length === 0) return t(locale, "g.state.noData");
  const worst = list.find((alert) => alert.kind !== "noData");
  if (worst) return t(locale, "g.label." + worst.kind);
  return trendWord(state.data.readings[0]!.direction, locale);
}

/** The six cells of the glucose page; the pump cells only when a pump reports. */
export function glucoseCells(state: ViewState, list: readonly Alert[]): CockpitCell[] {
  const { locale, unit } = state;
  const readings = state.data?.readings ?? [];
  const newest = readings[0];
  const stale = list.some((alert) => alert.kind === "stale");
  const change = stale ? null : delta(readings);
  const pump = state.data?.pump ?? null;
  const out = list.map((alert) => alert.kind);
  const low = glucose(state.limits.targetLow, unit, locale);
  const high = glucose(state.limits.targetHigh, unit, locale);
  const outOfRange = out.includes("low") || out.includes("urgentLow") || out.includes("high");
  const cells: CockpitCell[] = [
    { label: t(locale, "g.cp.trend"), value: change === null ? DASH : signedDelta(change, unit, locale), ...(out.includes("fallingFast") ? { alert: true } : {}) },
    { label: t(locale, "g.cp.time"), value: newest ? ageShort(locale, state.now - newest.at) : DASH, ...(stale ? { alert: true } : {}) },
    { label: t(locale, "g.cp.target"), value: `${low}–${high}`, ...(outOfRange ? { alert: true } : {}) },
  ];
  if (pump) {
    cells.push(
      { label: t(locale, "g.cp.iob"), value: pump.iob === null ? DASH : insulin(pump.iob, locale) },
      { label: t(locale, "g.cp.reservoir"), value: pump.reservoir === null ? DASH : insulin(pump.reservoir, locale) },
      { label: t(locale, "g.cp.sensor"), value: sensorShort(pump, locale) },
    );
  }
  return cells;
}

/** "4 T" / "9 h": the time left of the sensor. */
export function sensorShort(pump: PumpStatus, locale: Locale): string {
  const hours = pump.sensorHours;
  if (hours === null) return DASH;
  return hours >= 24 ? t(locale, "g.pump.sensorLeft", { d: Math.floor(hours / 24) }) : t(locale, "g.pump.sensorHours", { h: Math.round(hours) });
}

/** The curve of the last three hours, oldest first, in mg/dL. */
export function curvePoints(state: ViewState): number[] {
  const readings = state.data?.readings ?? [];
  const newest = readings[0];
  if (!newest) return [];
  return readings.filter((reading) => newest.at - reading.at <= CURVE_HOURS * 3_600_000).map((reading) => reading.mgdl).reverse();
}

/** The hint line: the page indicator in front, only the gestures that do something here. */
export function cockpitHint(locale: Locale, page: Page): string {
  const index = PAGES.indexOf(page) + 1;
  return footer(locale, { tap: t(locale, "g.f.reload"), swipe: t(locale, page === "glucose" ? "g.f.toPump" : "g.f.toValue") }, "back", `${index}/${PAGES.length}`);
}

/**
 * Numbers on the curve (Alfred 22.10.2026: "only a line that says little"): the target band's values, the highest
 * and lowest reading of the window, and hour marks under the curve once it covers most of the three hours (the
 * points are spread by index, so marks on a short or gappy curve would lie).
 */
export function curveLabels(state: ViewState): NonNullable<Extract<CockpitGraphic, { kind: "spark" }>["labels"]> {
  const { unit, locale } = state;
  const points = curvePoints(state);
  const readings = state.data?.readings ?? [];
  const newest = readings[0];
  const inWindow = newest ? readings.filter((reading) => newest.at - reading.at <= CURVE_HOURS * 3_600_000) : [];
  const span = inWindow.length > 1 ? newest!.at - inWindow[inWindow.length - 1]!.at : 0;
  const steady = inWindow.length >= 24; // about one reading per 5 min over 2 h and more
  const ticks = span >= 2.5 * 3_600_000 && steady
    ? ["-3h", "-2h", "-1h", t(locale, "g.cp.now")]
    : undefined;
  return {
    bandLow: glucose(state.limits.targetLow, unit, locale),
    bandHigh: glucose(state.limits.targetHigh, unit, locale),
    ...(points.length > 2 ? { max: glucose(Math.max(...points), unit, locale), min: glucose(Math.min(...points), unit, locale) } : {}),
    ...(ticks ? { ticks } : {}),
  };
}

export function glucoseModel(state: ViewState): CockpitModel {
  const { locale, unit } = state;
  const list = currentAlerts(state);
  const newest = state.data?.readings[0];
  const tone = glucoseTone(state, list);
  const age = newest ? ageText(locale, state.now - newest.at) : "";
  const arrow = newest ? arrowAngle(newest.direction) : undefined;
  const graphic: CockpitGraphic = {
    kind: "spark",
    points: curvePoints(state),
    band: { low: state.limits.targetLow, high: state.limits.targetHigh },
    ...(arrow === undefined || tone === "offline" ? {} : { arrow }),
    top: unitLabel(unit),
    bottom: t(locale, "g.cp.hours"),
    tone,
    labels: curveLabels(state),
  };
  return {
    title: t(locale, "g.app").toUpperCase(),
    clock: hhmm(state.now),
    headline: [newest ? glucose(newest.mgdl, unit, locale) : DASH, statusWord(state, list)],
    cells: glucoseCells(state, list),
    graphic,
    caption: newest ? (state.demo || state.demoHint ? t(locale, "g.cp.demo", { age }) : age) : "",
    hint: cockpitHint(locale, "glucose"),
    tone,
  };
}

function percent(value: number | null): { value: number | null; text: string } {
  return value === null ? { value: null, text: DASH } : { value: Math.max(0, Math.min(100, value)), text: `${Math.round(value)}%` };
}

/** Pump battery, phone battery and the sensor's time left as bars. */
export function pumpBars(pump: PumpStatus | null, locale: Locale): CockpitBar[] {
  const bar = (label: string, value: number | null, text?: string): CockpitBar => {
    const p = percent(value);
    return { label, value: p.value, text: text ?? p.text, tone: p.value === null ? "offline" : p.value < 20 ? "warn" : "ok" };
  };
  const sensor = pump?.sensorHours ?? null;
  return [
    bar(t(locale, "g.cp.barPump"), pump?.battery ?? null),
    bar(t(locale, "g.cp.barPhone"), pump?.uploaderBattery ?? null),
    bar(t(locale, "g.cp.barSensor"), sensor === null ? null : (sensor / SENSOR_HOURS) * 100, pump ? sensorShort(pump, locale) : DASH),
  ];
}

export function pumpModel(state: ViewState): CockpitModel {
  const { locale } = state;
  const pump = state.data?.pump ?? null;
  const treatments = state.data?.treatments;
  const base = { title: t(locale, "g.app").toUpperCase(), clock: hhmm(state.now), hint: cockpitHint(locale, "pump") };
  if (!pump) {
    return {
      ...base,
      headline: [DASH, t(locale, "g.pump.none")],
      cells: [],
      graphic: { kind: "bars", bars: pumpBars(null, locale) },
      caption: "",
      tone: "offline",
    };
  }
  const meal = treatments?.lastCarbs ?? null;
  const bolus = treatments?.lastBolus ?? null;
  const sensorAlert = pump.sensorState !== null && !["NO_ERROR_MESSAGE", "WARM_UP"].includes(pump.sensorState);
  return {
    ...base,
    headline: [pump.iob === null ? DASH : insulin(pump.iob, locale), t(locale, "g.mode." + (pump.mode ?? "unknown"))],
    cells: [
      { label: t(locale, "g.cp.reservoir"), value: pump.reservoir === null ? DASH : insulin(pump.reservoir, locale) },
      { label: t(locale, "g.cp.sensor"), value: sensorShort(pump, locale), ...(sensorAlert ? { alert: true } : {}) },
      { label: t(locale, "g.cp.stand"), value: pump.at === null ? DASH : ageShort(locale, state.now - pump.at) },
      { label: t(locale, "g.cp.meal"), value: meal ? `${Math.round(meal.grams)} g` : DASH },
      { label: t(locale, "g.cp.bolus"), value: bolus ? insulin(bolus.units, locale) : DASH },
      { label: t(locale, "g.cp.time"), value: bolus ? ageShort(locale, state.now - bolus.at) : DASH },
    ],
    graphic: { kind: "bars", bars: pumpBars(pump, locale) },
    caption: pump.device ?? "",
    tone: sensorAlert ? "warn" : "ok",
  };
}

export function cockpitModel(state: ViewState): CockpitModel {
  return state.page === "pump" ? pumpModel(state) : glucoseModel(state);
}
