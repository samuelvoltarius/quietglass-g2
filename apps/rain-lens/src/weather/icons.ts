import { columnDivider, createBitmap, drawPattern, MAX_LEVEL, type Bitmap } from "../glasses/bitmap";
import { weatherKind, type WeatherForecast, type WeatherKind } from "../rain/model";

const icons: Record<WeatherKind, readonly string[]> = {
  clear: [".....##.....", "..#..##..#..", "...#....#...", "............", ".#...####...#", "....######..", "##..######..", "##..######..", "....######..", ".#...####...#", "...#....#...", "..#..##..#.."],
  cloud: ["............", "............", ".....####...", "...########.", "..##########", ".###########", "############", "############", "############", ".###########", "............", "............"],
  fog: ["............", "...######...", ".##########.", "############", "............", ".##########.", "............", "..########..", "............", ".##########.", "............", "............"],
  rain: ["............", ".....####...", "...########.", ".###########", "############", "############", "............", "..#...#...#.", ".##..##..##..", ".#...#...#...", "#...#...#...", "............"],
  snow: ["............", ".....####...", "...########.", ".###########", "############", "############", "............", ".#...#...#...", "..#.#.#.#...", ".###.###.###.", "..#...#...#.", "............"],
  storm: ["............", ".....####...", "...########.", ".###########", "############", "############", ".....##.....", "....###.....", "...#####....", ".....##.....", "....##......", "...##......."],
};

export const ICONS = { id: 4, name: "weather-icons", x: 0, y: 36, width: 96, height: 144 } as const;

/** What the icon column shows: one large icon for now, six small for the hours, three for the days, or nothing (page -1). */
export function iconKinds(forecast: WeatherForecast, page: number): WeatherKind[] {
  if (page === 0) return [weatherKind(forecast.current.weatherCode)];
  if (page === 1) return forecast.hourly.slice(0, 12).filter((_, index) => index % 3 === 0).map((hour) => weatherKind(hour.weatherCode));
  if (page === 2) return forecast.daily.slice(0, 3).map((day) => weatherKind(day.weatherCode));
  return [];
}

/** Key of the icon column: the image is only sent again when it changes. */
export function iconKey(forecast: WeatherForecast, page: number): string {
  return `${page}:${iconKinds(forecast, page).join(",")}`;
}

export function drawWeatherIcons(forecast: WeatherForecast, page: number): Bitmap {
  const bitmap = createBitmap(ICONS.width, ICONS.height);
  columnDivider(bitmap);
  const kinds = iconKinds(forecast, page);
  if (page === 0) kinds.forEach((kind) => drawPattern(bitmap, icons[kind], 18, 42, 5, MAX_LEVEL));
  // One icon per body row: the hourly view lists every third hour.
  if (page === 1) kinds.forEach((kind, index) => drawPattern(bitmap, icons[kind], 30, 6 + index * 25, 2, MAX_LEVEL));
  if (page === 2) kinds.forEach((kind, index) => drawPattern(bitmap, icons[kind], 36, 4 + index * 25, 2, MAX_LEVEL));
  return bitmap;
}
