import { weatherKind, type WeatherForecast, type WeatherKind } from "../rain/model";

const icons: Record<WeatherKind, readonly string[]> = {
  clear: [".....##.....", "..#..##..#..", "...#....#...", "............", ".#...####...#", "....######..", "##..######..", "##..######..", "....######..", ".#...####...#", "...#....#...", "..#..##..#.."],
  cloud: ["............", "............", ".....####...", "...########.", "..##########", ".###########", "############", "############", "############", ".###########", "............", "............"],
  fog: ["............", "...######...", ".##########.", "############", "............", ".##########.", "............", "..########..", "............", ".##########.", "............", "............"],
  rain: ["............", ".....####...", "...########.", ".###########", "############", "############", "............", "..#...#...#.", ".##..##..##..", ".#...#...#...", "#...#...#...", "............"],
  snow: ["............", ".....####...", "...########.", ".###########", "############", "############", "............", ".#...#...#...", "..#.#.#.#...", ".###.###.###.", "..#...#...#.", "............"],
  storm: ["............", ".....####...", "...########.", ".###########", "############", "############", ".....##.....", "....###.....", "...#####....", ".....##.....", "....##......", "...##......."],
};

function drawIcon(ctx: CanvasRenderingContext2D, kind: WeatherKind, x: number, y: number, scale: number): void {
  const pattern = icons[kind]; ctx.fillStyle = "#fff";
  pattern.forEach((row, rowIndex) => { for (let column = 0; column < row.length; column += 1) if (row[column] === "#") ctx.fillRect(x + column * scale, y + rowIndex * scale, scale, scale); });
}

export async function renderWeatherIcons(forecast: WeatherForecast, page: number, width = 96, height = 144): Promise<Uint8Array> {
  const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height; const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("2d canvas unavailable");
  ctx.imageSmoothingEnabled = false; ctx.fillStyle = "#000"; ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#555"; for (let y = 4; y < height; y += 8) ctx.fillRect(width - 2, y, 1, 3);
  if (page === 0) drawIcon(ctx, weatherKind(forecast.current.weatherCode), 18, 42, 5);
  if (page === 1) forecast.hourly.slice(0, 6).forEach((hour, index) => drawIcon(ctx, weatherKind(hour.weatherCode), 36, index * 24, 2));
  if (page === 2) forecast.daily.slice(0, 3).forEach((day, index) => drawIcon(ctx, weatherKind(day.weatherCode), 30, 8 + index * 48, 3));
  const blob: Blob = await new Promise((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("PNG encode failed")), "image/png"));
  return new Uint8Array(await blob.arrayBuffer());
}
