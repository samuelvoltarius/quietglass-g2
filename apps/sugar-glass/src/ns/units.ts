import type { Locale } from "../i18n";

export type Unit = "mgdl" | "mmol";

/** mg/dL per mmol/L for glucose. */
export const MGDL_PER_MMOL = 18.0182;

export function toMmol(mgdl: number): number {
  return Math.round((mgdl / MGDL_PER_MMOL) * 10) / 10;
}
export function fromMmol(mmol: number): number {
  return Math.round(mmol * MGDL_PER_MMOL);
}

/** A glucose value in the chosen unit: "123" or "6,8" (German) / "6.8". */
export function glucose(mgdl: number, unit: Unit, locale: Locale): string {
  if (unit === "mgdl") return String(Math.round(mgdl));
  const text = toMmol(mgdl).toFixed(1);
  return locale === "de" ? text.replace(".", ",") : text;
}

/** A change with its sign: "+4", "−12", "±0"; mmol with one decimal. */
export function signedDelta(mgdl: number, unit: Unit, locale: Locale): string {
  const value = unit === "mgdl" ? Math.round(mgdl) : Math.round((mgdl / MGDL_PER_MMOL) * 10) / 10;
  if (value === 0) return "±0";
  const body = unit === "mgdl" ? String(Math.abs(value)) : Math.abs(value).toFixed(1);
  return (value > 0 ? "+" : "-") + (locale === "de" ? body.replace(".", ",") : body);
}

export function unitLabel(unit: Unit): string {
  return unit === "mgdl" ? "mg/dL" : "mmol/L";
}

/** Reads a typed value (in the chosen unit) back to mg/dL; null when it is not a sensible glucose value. */
export function parseGlucose(text: string, unit: Unit): number | null {
  const n = Number(text.trim().replace(",", "."));
  if (!Number.isFinite(n) || n <= 0) return null;
  const mgdl = unit === "mgdl" ? Math.round(n) : fromMmol(n);
  return mgdl >= 30 && mgdl <= 450 ? mgdl : null;
}

/** "3,5 E" / "3.5 U". */
export function insulin(units: number, locale: Locale): string {
  const text = (Math.round(units * 100) / 100).toFixed(units >= 10 ? 0 : units >= 1 ? 1 : 2);
  return (locale === "de" ? text.replace(".", ",") : text) + (locale === "de" ? " E" : " U");
}
