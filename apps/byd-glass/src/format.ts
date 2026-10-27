import type { Locale } from "./i18n";
import { t } from "./messages";
import type { CarWarning } from "./car/model";

/** Numbers the way the locale writes them: "15,8" in German, "15.8" in English. */
export function dec(value: number | null, digits: number, locale: Locale): string {
  if (value === null) return "–";
  const text = value.toFixed(digits);
  return locale === "de" ? text.replace(".", ",") : text;
}

export const pct = (value: number | null): string => (value === null ? "–" : `${Math.round(value)} %`);
export const km = (value: number | null): string => (value === null ? "– km" : `${Math.round(value)} km`);
export const kw = (value: number | null, locale: Locale): string => (value === null ? "– kW" : `${dec(value, value >= 10 || value <= -10 ? 0 : 1, locale)} kW`);
export const deg = (value: number | null, locale: Locale): string => (value === null ? "– °C" : `${dec(value, 0, locale)} °C`);
export const volt = (value: number | null, locale: Locale): string => (value === null ? "– V" : `${dec(value, 1, locale)} V`);

/** Tyre pressure: the car reports kPa, people read bar. 252 kPa -> "2,5 bar". */
export function bar(kpa: number | null, locale: Locale): string {
  return kpa === null ? "– bar" : `${dec(kpa / 100, 1, locale)} bar`;
}

/** "49 min", "1 h 05". */
export function duration(minutes: number | null): string {
  if (minutes === null) return "–";
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")}`;
}

/** "vor 3 min" / "3 min ago" from an age in seconds. */
export function ageText(locale: Locale, seconds: number | null): string {
  if (seconds === null) return t(locale, "g.unknown");
  const minutes = Math.max(0, Math.floor(seconds / 60));
  if (minutes < 1) return t(locale, "g.age.now");
  if (minutes < 60) return t(locale, "g.age.min", { n: minutes });
  return t(locale, "g.age.h", { h: Math.floor(minutes / 60), m: String(minutes % 60).padStart(2, "0") });
}

const KNOWN = new Set(["tyre_leak", "tyre_low", "door_open", "trunk_open", "hood_open", "v12_low", "unlocked", "soc_low", "charge_done"]);

function vars(locale: Locale, w: CarWarning, long: boolean): Record<string, string | number> {
  return {
    wheel: w.wheel ? t(locale, (long ? "g.wheelLong." : "g.wheel.") + w.wheel) : "?",
    bar: bar(w.kpa, locale),
    volt: volt(w.volt, locale),
    minutes: w.minutes ?? "?",
    soc: pct(w.soc),
    code: w.code,
  };
}

/** One line for the header: "REIFEN HR VERLIERT DRUCK 1,7 bar". */
export function warningShort(locale: Locale, w: CarWarning): string {
  const key = KNOWN.has(w.code) ? "g.w." + w.code : "g.w.other";
  return t(locale, key, vars(locale, w, false));
}

/** A sentence for the warning overlay: "Reifen hinten rechts: Druckverlust (1,7 bar) – anhalten, prüfen". */
export function warningLong(locale: Locale, w: CarWarning): string {
  const key = KNOWN.has(w.code) ? "g.wl." + w.code : "g.wl.other";
  return t(locale, key, vars(locale, w, true));
}
