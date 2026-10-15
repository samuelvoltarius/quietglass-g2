import type { Forecast, HourPoint } from "./forecast";

/**
 * `?demo=1`: a night that starts clear, clouds over within the hour, and
 * clears again after midnight-ish - enough to show the chart, the clear-sky
 * window and a "clouds in ~40 min" popup. No network.
 */
export function demoForecast(now: number): Forecast {
  const start = Math.floor(now / 3_600_000) * 3_600_000 - 3_600_000;
  const clouds = [10, 20, 75, 90, 85, 70, 40, 15, 5, 5, 10, 20, 25, 30, 30];
  const hours: HourPoint[] = clouds.map((cloud, i) => ({
    time: start + i * 3_600_000,
    cloud,
    cloudLow: Math.round(cloud * 0.2),
    cloudMid: Math.round(cloud * 0.5),
    cloudHigh: cloud,
    rainProb: i >= 3 && i <= 4 ? 35 : 5,
    rain: 0,
    humidity: 70 + i,
    dewPoint: 2 + i * 0.1,
    temp: 7 - i * 0.3,
    wind: 8 + (i % 3),
    gust: 15 + (i % 4),
  }));
  return { fetchedAt: now, position: { latitude: 47.8, longitude: 13.04 }, hours };
}
