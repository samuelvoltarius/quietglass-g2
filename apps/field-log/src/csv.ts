import type { Locale } from "./i18n";

/**
 * The two CSV flavours a spreadsheet export can be written in.
 *
 * - `excel-de`: what German and Austrian Excel expects when a file is opened by
 *   double-click — `;` between fields, a decimal comma, CRLF line endings, a
 *   UTF-8 byte order mark (without it Excel reads umlauts as Windows-1252) and
 *   dates as `07.10.2026 14:05` in local time, which Excel recognises as a date.
 *   The exact time is kept as ISO 8601 (UTC) in an extra last column, so the
 *   file stays machine-readable too.
 * - `standard`: comma, decimal point, LF, no BOM, ISO 8601 in UTC — for other
 *   programs, scripts and English Excel.
 *
 * Text cells are defused against formulas (a leading `=`, `+`, `-`, `@`, tab or
 * CR gets a `'`); number cells are not, so a negative number stays a number.
 */
export type CsvFormat = "excel-de" | "standard";

export function isCsvFormat(value: unknown): value is CsvFormat {
  return value === "excel-de" || value === "standard";
}

/** German users get the Excel variant unless they chose otherwise. */
export function defaultCsvFormat(locale: Locale): CsvFormat {
  return locale === "de" ? "excel-de" : "standard";
}

/** The user's saved choice, or the default for the app language. */
export function csvFormatFor(saved: CsvFormat | undefined, locale: Locale): CsvFormat {
  return saved ?? defaultCsvFormat(locale);
}

function separator(format: CsvFormat): string {
  return format === "excel-de" ? ";" : ",";
}

/** A text cell: formula-guarded, quoted when it holds the separator, a quote or a line break. */
export function textCell(value: string, format: CsvFormat): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? "'" + value : value;
  return safe.includes(separator(format)) || /["\r\n]/.test(safe)
    ? '"' + safe.split('"').join('""') + '"'
    : safe;
}

/** A number cell: never guarded; decimal comma in the Excel variant, no thousands separator. */
export function numberCell(value: number, format: CsvFormat, digits = 0): string {
  if (!Number.isFinite(value)) return "";
  const text = value.toFixed(digits);
  return format === "excel-de" ? text.replace(".", ",") : text;
}

/** `07.10.2026 14:05` in the phone's local time — the form German Excel reads as a date. */
export function localDateTime(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return pad(date.getDate()) + "." + pad(date.getMonth() + 1) + "." + date.getFullYear() +
    " " + pad(date.getHours()) + ":" + pad(date.getMinutes());
}

/** Joins ready-made cells into the file, with the line endings and BOM of the format. */
export function joinCsv(rows: readonly (readonly string[])[], format: CsvFormat): string {
  const newline = format === "excel-de" ? "\r\n" : "\n";
  const body = rows.map((row) => row.join(separator(format))).join(newline) + newline;
  return format === "excel-de" ? "﻿" + body : body;
}
