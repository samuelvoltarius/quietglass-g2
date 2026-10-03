export interface RainPoint { readonly time: string; readonly mm: number; }
export interface RainWindow { readonly points: readonly RainPoint[]; readonly source: "live" | "demo"; }
export function parseOpenMeteo(value: unknown): RainWindow {
  const root = value as { minutely_15?: { time?: unknown; precipitation?: unknown } };
  const times = root?.minutely_15?.time; const rain = root?.minutely_15?.precipitation;
  if (!Array.isArray(times) || !Array.isArray(rain)) throw new Error("forecast has no 15-minute precipitation data");
  const points: RainPoint[] = [];
  for (let index = 0; index < Math.min(times.length, rain.length, 12); index += 1) { const time = times[index]; const mm = Number(rain[index]); if (typeof time === "string" && Number.isFinite(mm)) points.push({ time, mm }); }
  if (points.length === 0) throw new Error("forecast is empty");
  return { points, source: "live" };
}
export function demoRain(): RainWindow { const values = [0, 0.1, 0.4, 1.2, 2.4, 1.7, 0.8, 0.2, 0, 0, 0.3, 0.7]; return { source: "demo", points: values.map((mm, index) => ({ time: new Date(Date.now() + index * 900_000).toISOString(), mm })) }; }
export function rainBar(mm: number): string { const count = Math.min(12, Math.max(0, Math.round(mm * 4))); return `${"#".repeat(count)}${".".repeat(12 - count)}`; }
export function rainSummary(points: readonly RainPoint[], dry = "Trocken in den naechsten 3 Stunden", rain = "Regen ab {time} · Spitze {peak} mm", locale = "de-AT"): string { const first = points.find((point) => point.mm >= 0.1); if (!first) return dry; const peak = points.reduce((best, point) => point.mm > best.mm ? point : best, points[0] ?? first); return rain.replace("{time}", clock(first.time, locale)).replace("{peak}", peak.mm.toFixed(1)); }
export function clock(iso: string, locale = "de-AT"): string { const date = new Date(iso); return Number.isNaN(date.valueOf()) ? "--:--" : date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }); }
