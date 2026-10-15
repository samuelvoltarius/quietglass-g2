import { weatherKind, windCompass, type WeatherForecast, type WeatherKind } from "../rain/model";
import type { Frame } from "../screen/frame";
import { localToEpoch, nowcast, rainTotal, type Nowcast, type PrecipSlot } from "./nowcast";
import type { Warning } from "./warnings";

/**
 * What the cockpit shows, in words and numbers, decided without drawing:
 * the headline from the nowcast, the eight cells, the caption, and what goes
 * into the left half. compose.ts only lays this out.
 */

export interface CockpitCell {
  readonly label: string;
  readonly value: string;
  /** Drawn with a frame round it (a warning in force). */
  readonly alert?: boolean;
  /** Columns the cell spans (the warning cell takes two). */
  readonly span?: number;
}

export interface LoopInfo {
  /** Radar frame times, minutes relative to now (≤ 0). */
  readonly frames: readonly number[];
  /** The frame on screen, minutes relative to now; null = no radar (the marker sits at now). */
  readonly shown: number | null;
  /** Precipitation of the next four 15-minute slots, mm. */
  readonly rain: readonly number[];
}

export interface CockpitModel {
  readonly title: string;
  readonly clock: string;
  /** One or two lines, already upper case. */
  readonly headline: readonly string[];
  /** Rows of three columns (spans count). */
  readonly cells: readonly CockpitCell[];
  /** Under the map: "14:05 · Salzburg". */
  readonly caption: string;
  /** The radar picture for the left half (288 x 218), or null for the weather pictogram. */
  readonly map: Frame | null;
  readonly kind: WeatherKind;
  /** Where the wind comes from, degrees; null = calm or unknown. */
  readonly windFrom: number | null;
  /** The dashed range ring on the map. */
  readonly ring: { readonly km: number; readonly radius: number } | null;
  readonly loop: LoopInfo;
}

export type Translate = (key: string, vars?: Record<string, string | number>) => string;

export interface CockpitInput {
  readonly forecast: WeatherForecast;
  readonly now: number;
  readonly t: Translate;
  readonly locale: string;
  /** Set while there is no real forecast yet: the headline says what is going on instead. */
  readonly notice: "glassLoading" | "glassNoLocation" | "glassOffline" | null;
  /** The official warning to show; undefined = warnings not available here. */
  readonly warning: Warning | null | undefined;
  /** "Gust alert from X km/h"; null = off. */
  readonly gustLimit: number | null;
  readonly place: string;
  readonly map?: Frame | null;
  readonly ring?: { readonly km: number; readonly radius: number } | null;
  /** Radar frame times (epoch ms) and the one on screen. */
  readonly frameTimes?: readonly number[];
  readonly shownFrame?: number | null;
}

/** "HH:MM" of an epoch ms in the phone's time (24 h). */
export function hhmm(time: number): string {
  const date = new Date(time);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** The slots the nowcast reads: the 15-minute ones, else the hourly values as 60-minute slots. */
export function precipSlots(forecast: WeatherForecast): PrecipSlot[] {
  if (forecast.minutely && forecast.minutely.length > 0) return [...forecast.minutely];
  const offset = forecast.utcOffsetSeconds ?? 0;
  return forecast.hourly.map((hour) => ({ start: localToEpoch(hour.time, offset), minutes: 60, precipitation: hour.precipitation, weatherCode: hour.weatherCode, local: hour.time.slice(11, 16) }))
    .filter((slot) => Number.isFinite(slot.start));
}

/** The headline lines for a nowcast ("REGEN IN|~25 MIN" → two lines). */
export function headlineLines(cast: Nowcast, t: Translate): string[] {
  const text = cast.kind === "now" ? t(cast.snow ? "cpSnowNow" : "cpRainNow")
    : cast.kind === "soon" ? t(cast.snow ? "cpSnowIn" : "cpRainIn", { min: cast.minutes })
      : cast.kind === "dryUntil" ? t("cpDryUntil", { time: cast.time })
        : cast.kind === "dry" ? t("cpDry") : t("cpUnknown");
  return text.split("|").map((line) => line.trim().toUpperCase()).filter(Boolean);
}

/** Strongest gust expected within the next hour (now and the next full hour), km/h. */
export function nextHourGusts(forecast: WeatherForecast): number {
  const hourly = forecast.hourly.slice(0, 2).map((hour) => hour.windGusts ?? 0);
  return Math.max(forecast.current.windGusts, ...hourly);
}

/** The WARNUNG cell: an official warning first, then the user's own gust alert, else "none" / "–". */
export function warningCell(input: Pick<CockpitInput, "warning" | "gustLimit" | "forecast" | "t">): CockpitCell {
  const { warning, gustLimit, forecast, t } = input;
  const label = t("cpWarning");
  if (warning) return { label, value: `▲ ${t(`warn_${warning.type}`)} (${t(`warnLevel${warning.level}`)})`, alert: true, span: 2 };
  const gusts = nextHourGusts(forecast);
  if (gustLimit !== null && gustLimit > 0 && gusts >= gustLimit) return { label, value: `▲ ${t("cpGustAlert", { speed: Math.round(gusts) })}`, alert: true, span: 2 };
  return { label, value: warning === null ? t("cpNoWarning") : "–", span: 2 };
}

const decimal = (value: number, locale: string): string => (locale === "de" ? value.toFixed(1).replace(".", ",") : value.toFixed(1));

/** The relative minutes of a time, for the loop bar. */
const minutesFrom = (time: number, now: number): number => Math.round((time - now) / 60_000);

export function cockpitModel(input: CockpitInput): CockpitModel {
  const { forecast, now, t, locale } = input;
  const current = forecast.current;
  const live = input.notice === null;
  const slots = precipSlots(forecast);
  const headline = live ? headlineLines(nowcast(slots, now), t) : t(`cp_${input.notice}`).split("|").map((line) => line.toUpperCase());
  const dash = "–";
  const cells: CockpitCell[] = live ? [
    { label: t("cpTemp"), value: `${Math.round(current.temperature)}°` },
    { label: t("cpFeels"), value: `${Math.round(current.feelsLike)}°` },
    { label: t("cpHumidity"), value: `${Math.round(current.humidity)}%` },
    { label: t("cpSky"), value: t(weatherKind(current.weatherCode)).toUpperCase() },
    { label: t("cpWind"), value: `${windCompass(current.windDirection)} ${Math.round(current.windSpeed)}` },
    { label: t("cpGusts"), value: `${Math.round(current.windGusts)}` },
    { label: t("cpRain2h"), value: `${decimal(rainTotal(slots, now), locale)} mm` },
    warningCell(input),
  ] : [
    ...["cpTemp", "cpFeels", "cpHumidity", "cpSky", "cpWind", "cpGusts", "cpRain2h"].map((key) => ({ label: t(key), value: dash })),
    { label: t("cpWarning"), value: dash, span: 2 },
  ];
  const frameTimes = input.frameTimes ?? [];
  const shownTime = input.shownFrame !== undefined && input.shownFrame !== null ? frameTimes[input.shownFrame] : undefined;
  // Under the radar the frame's time; without one the time of the forecast (the clock is top right already).
  const dataTime = /T(\d\d:\d\d)/.exec(current.time)?.[1];
  const captionTime = shownTime !== undefined ? hhmm(shownTime) : live && dataTime ? dataTime : hhmm(now);
  const caption = input.place ? `${captionTime} · ${input.place}` : captionTime;
  const nextHour = slots.filter((slot) => slot.minutes === 15 && slot.start + 15 * 60_000 > now).slice(0, 4).map((slot) => slot.precipitation);
  return {
    title: "RAINLENS",
    clock: hhmm(now),
    headline,
    cells,
    caption,
    map: input.map ?? null,
    kind: weatherKind(current.weatherCode),
    windFrom: live && current.windSpeed >= 1 ? current.windDirection : null,
    ring: input.ring ?? null,
    loop: { frames: frameTimes.map((time) => minutesFrom(time, now)), shown: shownTime === undefined ? null : minutesFrom(shownTime, now), rain: live ? nextHour : [] },
  };
}

/**
 * A tap plays the radar loop once: frame `step` while stepping through the
 * `count` frames, the newest held for one more step, then null (back to the
 * still picture of the newest frame).
 */
export function playFrame(step: number, count: number): number | null {
  if (count <= 0 || step < 0) return null;
  if (step < count) return step;
  return step === count ? count - 1 : null;
}
