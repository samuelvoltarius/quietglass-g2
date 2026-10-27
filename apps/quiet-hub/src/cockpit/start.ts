import { createFrame, type Frame } from "../screen/frame";
import { dashedLine, fillRect, strokeRect } from "../screen/draw";
import { drawText, fitFont, fitText, type TextBackend } from "../screen/text";
import { mascotFrame, type Mood } from "../glasses/mascot";
import { tr, type Locale } from "../i18n";
import { messages } from "../messages";
import type { Brief, HubReport } from "../api/types";
import { trendArrow } from "../hub/brief";
import { homeViewOf } from "../hub/zuhause";
import { AREAS, carBrief, cursorIndex, startEntries, type AreaScreen, type StartEntry } from "../hub/areas";
import { drawPictogram, drawRingAt, drawSegmentsAt, LAMP_OFF, LAMP_ON, PRINTER, W_LEVELS, WEATHER_PATTERNS, weatherKind, type Tone, type WeatherKind } from "./widgets";

/**
 * The start page as one picture (0.13, Alfred: "Animationen und Grafiken fehlen"): six tiles in two rows
 * of three, each a small picture of its area and one big value, the cursor a thick frame. What needs the
 * wearer is the bar on top (it is a row of the cursor too, like before). The agents' tile carries the
 * animated mascot, a charging car pulses, a running print turns.
 *
 *   ┌ ! hermes wartet auf Freigabe ───────────────────── 14:05 ┐
 *   │ [face]  AGENTEN │ ( 57 )  AUTO     │ [lamp]  ZUHAUSE      │
 *   │         6/8     │         176 km   │         2 an         │
 *   │ (ring)  DRUCKER │ (segs)  SERVER   │ [sun]   TAG          │
 *   │         aus     │         4/4      │         14°          │
 *   └ Tippen = öffnen · Wischen = wählen · 2× = Ende ──────────┘
 */

export type TileGraphic =
  | { readonly kind: "mascot"; readonly mood: Mood }
  | { readonly kind: "ring"; readonly percent: number | null; readonly tone: Tone; readonly pulse?: boolean; readonly spin?: boolean }
  | { readonly kind: "segments"; readonly segments: readonly Tone[] }
  | { readonly kind: "icon"; readonly rows: readonly string[]; readonly dim?: boolean };

export interface StartTile {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly sub: string;
  readonly graphic: TileGraphic;
  /** Something wants the wearer here (frame drawn even when not selected). */
  readonly alert?: boolean;
}

export interface StartPicture {
  readonly tiles: readonly StartTile[];
  /** The warning rows (cursor rows above the tiles). */
  readonly warnings: readonly StartEntry[];
  /** Cursor key ("warn:…" or "area:…"). */
  readonly selected: string;
  readonly clock: string;
  readonly hint: string;
  readonly title: string;
}

type T = (key: string, vars?: Record<string, string | number>) => string;

function agentTile(report: HubReport, t: T): StartTile {
  const online = report.agents.filter((agent) => agent.online).length;
  const busy = report.agents.filter((agent) => agent.busy).length;
  const waiting = report.approvals.length;
  const mood: Mood = waiting > 0 ? "waiting" : busy > 0 ? "working" : online === 0 ? "asleep" : "idle";
  const sub = report.agents.length === 0 ? t("tile.none") : waiting > 0 ? t("area.waiting", { n: waiting }) : busy > 0 ? t("area.busy", { n: busy }) : t("tile.online");
  return { key: "area:agent", label: t("tile.agent"), value: `${online}/${report.agents.length}`, sub, graphic: { kind: "mascot", mood }, alert: waiting > 0 };
}

function homeTile(report: HubReport, t: T): StartTile {
  const view = homeViewOf(report);
  if (view === null) return { key: "area:home", label: t("tile.home"), value: "–", sub: t("area.notSet"), graphic: { kind: "icon", rows: LAMP_OFF, dim: true } };
  if (view.error !== null && view.error !== undefined && view.error !== "") return { key: "area:home", label: t("tile.home"), value: "!", sub: t("area.haDown"), graphic: { kind: "icon", rows: LAMP_OFF, dim: true }, alert: true };
  const real = Object.values(view.entities).filter((entity) => entity.group !== true);
  const lights = real.filter((entity) => entity.kind === "light" && entity.on).length;
  const media = real.filter((entity) => entity.kind === "media" && entity.on).map((entity) => entity.name);
  const sub = media.length > 0 ? t("area.mediaOn", { name: media[0] ?? "" }) : t(lights === 1 ? "tile.light1" : "tile.lights");
  return { key: "area:home", label: t("tile.home"), value: lights === 0 ? t("tile.off") : t("tile.on", { n: lights }), sub, graphic: { kind: "icon", rows: lights > 0 ? LAMP_ON : LAMP_OFF, dim: lights === 0 } };
}

function carTile(report: HubReport, brief: Brief | null | undefined, t: T): StartTile {
  const car = carBrief(report, brief)?.car;
  const base = { key: "area:car", label: t("tile.car") };
  if (car === undefined) return { ...base, value: "…", sub: "", graphic: { kind: "ring", percent: null, tone: "offline" } };
  if (car.status !== "ok" && car.stale !== true) return { ...base, value: "–", sub: t(car.status === "off" ? "area.notSet" : "area.unreachable"), graphic: { kind: "ring", percent: null, tone: "offline" } };
  const soc = typeof car.soc === "number" ? car.soc : null;
  const open = car.locked === false;
  const tone: Tone = car.stale === true ? "offline" : soc !== null && soc < 15 ? "critical" : soc !== null && soc < 25 ? "warn" : "ok";
  const sub = [typeof car.rangeKm === "number" ? `${car.rangeKm} km` : "", open ? t("area.unlocked") : car.locked === true ? t("area.locked") : "", car.charging === true ? t("area.charging") : ""].filter(Boolean).join(" · ");
  return { ...base, value: soc === null ? "–" : `${soc} %`, sub, graphic: { kind: "ring", percent: soc, tone, pulse: car.charging === true }, alert: open };
}

function printerTile(report: HubReport, t: T): StartTile {
  const printer = report.printer;
  const base = { key: "area:printer", label: t("tile.printer") };
  if (printer.demo === true) return { ...base, value: "–", sub: t("area.notSet"), graphic: { kind: "icon", rows: PRINTER, dim: true } };
  if (printer.offline === true) return { ...base, value: t("area.printerOff"), sub: "", graphic: { kind: "icon", rows: PRINTER, dim: true } };
  const percent = printer.progress ?? (printer.layers > 0 ? Math.round((printer.layer / printer.layers) * 100) : 0);
  if (printer.state === "printing" || printer.state === "paused") {
    const eta = printer.etaMin !== null && printer.etaMin > 0 ? (printer.etaMin < 60 ? `${printer.etaMin} min` : `${Math.floor(printer.etaMin / 60)}:${String(printer.etaMin % 60).padStart(2, "0")} h`) : "";
    return { ...base, value: `${percent} %`, sub: printer.state === "paused" ? t("tile.paused") : eta, graphic: { kind: "ring", percent, tone: printer.state === "paused" ? "warn" : "ok", spin: printer.state === "printing" } };
  }
  if (printer.state === "error") return { ...base, value: "!", sub: t("area.printerError"), graphic: { kind: "icon", rows: PRINTER }, alert: true };
  return { ...base, value: t("area.ready"), sub: "", graphic: { kind: "icon", rows: PRINTER } };
}

function serverTile(brief: Brief | null | undefined, t: T): StartTile {
  const servers = brief?.servers;
  const base = { key: "area:server", label: t("tile.server") };
  if (servers === undefined) return { ...base, value: "…", sub: "", graphic: { kind: "segments", segments: [] } };
  if (servers.status !== "ok") return { ...base, value: "–", sub: t(servers.status === "off" ? "area.notSet" : "area.unreachable"), graphic: { kind: "segments", segments: [] } };
  const machines = servers.machines ?? [];
  const segments = machines.map((machine): Tone => (!machine.ok ? "critical" : (machine.warn ?? 0) > 0 ? "warn" : "ok"));
  const down = servers.down ?? machines.filter((machine) => !machine.ok).length;
  const ok = machines.filter((machine) => machine.ok).length;
  return { ...base, value: `${ok}/${machines.length}`, sub: down > 0 ? t("area.serversDown", { n: down }) : t("tile.allOk"), graphic: { kind: "segments", segments }, alert: down > 0 };
}

function dayTile(brief: Brief | null | undefined, t: T): StartTile {
  const base = { key: "area:brief", label: t("tile.day") };
  if (brief === null || brief === undefined) return { ...base, value: "…", sub: "", graphic: { kind: "icon", rows: WEATHER_PATTERNS.cloud, dim: true } };
  const weather = brief.weather;
  const kind: WeatherKind = weather.status === "ok" ? weatherKind(weather.code) : "cloud";
  const temp = weather.status === "ok" && typeof weather.tempC === "number" ? `${Math.round(weather.tempC)}°` : "–";
  const n = brief.calendar.status === "ok" ? brief.calendar.total ?? brief.calendar.events?.length ?? 0 : null;
  const current = brief.sugar.status === "ok" ? brief.sugar.current : null;
  const sugar = current !== null && current !== undefined ? `${current.mgdl}${trendArrow(current.direction) ? ` ${trendArrow(current.direction)}` : ""}` : "";
  const appts = n === null ? "" : n === 0 ? t("tile.appts0") : t(n === 1 ? "area.appts1" : "area.apptsN", { n });
  return { ...base, value: temp, sub: [appts, sugar].filter(Boolean).join(" · "), graphic: { kind: "icon", rows: WEATHER_PATTERNS[kind] } };
}

/** The six tiles in AREAS order. */
export function startTiles(report: HubReport, brief: Brief | null | undefined, locale: Locale): StartTile[] {
  const t: T = (key, vars = {}) => tr(messages, locale, key, vars);
  const byArea: Record<AreaScreen, () => StartTile> = {
    agent: () => agentTile(report, t),
    home: () => homeTile(report, t),
    car: () => carTile(report, brief, t),
    printer: () => printerTile(report, t),
    server: () => serverTile(brief, t),
    brief: () => dayTile(brief, t),
  };
  return AREAS.map((area) => byArea[area]());
}

/** Everything the start picture needs, from the hub model's pieces. */
export function startPicture(report: HubReport, brief: Brief | null | undefined, locale: Locale, rootKey: string | null | undefined, rootSelected: number, clock: string, hint: string): StartPicture {
  const entries = startEntries(report, brief, locale);
  const selected = entries[cursorIndex(entries, rootKey, rootSelected)]?.key ?? "area:agent";
  return { tiles: startTiles(report, brief, locale), warnings: entries.filter((entry) => entry.warn), selected, clock, hint, title: tr(messages, locale, "app.title").toUpperCase() };
}

// ---- drawing -------------------------------------------------------------------------------------

const BAR = { top: 0, height: 30 } as const;
const GRID = { top: 34, bottom: 252, columns: 3, rows: 2 } as const;
const TILE_W = 192;
const TILE_H = Math.floor((GRID.bottom - GRID.top) / GRID.rows);
const PIC = 64;
const HINT_Y = 262;

/** Box of tile `index` (row-major). */
export function tileBox(index: number): { x: number; y: number; width: number; height: number } {
  return { x: (index % GRID.columns) * TILE_W, y: GRID.top + Math.floor(index / GRID.columns) * TILE_H, width: TILE_W, height: TILE_H };
}

function drawTileGraphic(frame: Frame, graphic: TileGraphic, x: number, y: number, now: number): void {
  const cx = x + PIC / 2;
  const cy = y + PIC / 2;
  switch (graphic.kind) {
    case "mascot": {
      // 18 x 9 face at 3 px per pixel = 54 x 27, centred in the picture box.
      const rows = mascotFrame(graphic.mood, now);
      const ox = x + Math.floor((PIC - 54) / 2);
      const oy = y + Math.floor((PIC - 27) / 2);
      rows.forEach((row, py) => { for (let px = 0; px < row.length; px += 1) if (row[px] === "#") fillRect(frame, ox + px * 3, oy + py * 3, 3, 3, W_LEVELS.text); });
      return;
    }
    case "ring": drawRingAt(frame, cx, cy, 30, 7, graphic.percent, graphic.tone, now, { pulse: graphic.pulse === true, spin: graphic.spin === true }); return;
    case "segments": drawSegmentsAt(frame, cx, cy, 30, 7, graphic.segments); return;
    case "icon": drawPictogram(frame, graphic.rows, x + 8, y + 8, 4, graphic.dim === true ? W_LEVELS.dim : W_LEVELS.text); return;
  }
}

function drawTile(frame: Frame, backend: TextBackend, tile: StartTile, index: number, selected: boolean, now: number): void {
  const box = tileBox(index);
  if (selected) strokeRect(frame, box.x + 2, box.y + 2, box.width - 4, box.height - 4, W_LEVELS.strong, 3);
  else if (tile.alert === true) strokeRect(frame, box.x + 3, box.y + 3, box.width - 6, box.height - 6, W_LEVELS.label, 1);
  drawTileGraphic(frame, tile.graphic, box.x + 10, box.y + Math.floor((box.height - PIC) / 2), now);
  const tx = box.x + 10 + PIC + 8;
  const room = box.x + box.width - 8 - tx;
  drawText(frame, backend, tile.label, tx, box.y + 12, { size: 13, weight: 700 }, { level: W_LEVELS.label, maxWidth: room });
  const font = fitFont(backend, tile.value, { size: 30, weight: 800 }, [30, 26, 22, 18, 15], room);
  drawText(frame, backend, fitText(backend, tile.value, font, room), tx, box.y + 32, font, { level: W_LEVELS.text });
  if (tile.sub !== "") drawText(frame, backend, fitText(backend, tile.sub, { size: 13, weight: 600 }, box.x + box.width - 8 - (box.x + 10)), box.x + 10, box.y + box.height - 22, { size: 13, weight: 600 }, { level: W_LEVELS.label, maxWidth: box.width - 18 });
}

/** The start page: warning bar (or title), six tiles, the hint line. */
export function composeStart(picture: StartPicture, backend: TextBackend, now: number): Frame {
  const frame = createFrame();
  const warnSelected = picture.warnings.find((warning) => warning.key === picture.selected);
  const warning = warnSelected ?? picture.warnings[0];
  if (warning !== undefined) {
    const more = picture.warnings.length > 1 ? ` (${picture.warnings.indexOf(warning) + 1}/${picture.warnings.length})` : "";
    if (warnSelected !== undefined) strokeRect(frame, 2, BAR.top + 1, 572, BAR.height - 2, W_LEVELS.strong, 3);
    else fillRect(frame, 0, BAR.top, 6, BAR.height, W_LEVELS.strong);
    drawText(frame, backend, `! ${warning.text}${more}`, 12, BAR.top + 5, { size: 18, weight: 800 }, { level: W_LEVELS.text, maxWidth: 480 });
  } else {
    drawText(frame, backend, picture.title, 12, BAR.top + 7, { size: 16, weight: 700 }, { level: W_LEVELS.label, maxWidth: 400 });
  }
  drawText(frame, backend, picture.clock, 568, BAR.top + 6, { size: 18, weight: 700 }, { align: "right", level: W_LEVELS.text });
  dashedLine(frame, 8, GRID.top - 2, 568, GRID.top - 2, W_LEVELS.grid, { dash: 3, gap: 3 });
  // Tile grid lines.
  for (let column = 1; column < GRID.columns; column += 1) dashedLine(frame, column * TILE_W, GRID.top + 6, column * TILE_W, GRID.bottom - 6, W_LEVELS.grid, { dash: 2, gap: 4 });
  dashedLine(frame, 8, GRID.top + TILE_H, 568, GRID.top + TILE_H, W_LEVELS.grid, { dash: 2, gap: 4 });
  picture.tiles.forEach((tile, index) => drawTile(frame, backend, tile, index, tile.key === picture.selected, now));
  dashedLine(frame, 8, GRID.bottom + 4, 568, GRID.bottom + 4, W_LEVELS.grid, { dash: 3, gap: 3 });
  drawText(frame, backend, picture.hint, 12, HINT_Y, { size: 14, weight: 600 }, { level: W_LEVELS.label, maxWidth: 552 });
  return frame;
}

/**
 * A page of up to six tiles with a plain header (Zuhause, its rooms): `selected` is the index in `all`,
 * the page holding it is shown, the header says "2/3" when there is more than one page.
 */
export function composeGrid(all: readonly StartTile[], selected: number, header: string, clock: string, hint: string, backend: TextBackend, now: number): Frame {
  const frame = createFrame();
  const per = GRID.columns * GRID.rows;
  const pages = Math.max(1, Math.ceil(all.length / per));
  const page = Math.max(0, Math.min(pages - 1, Math.floor(selected / per)));
  const shown = all.slice(page * per, page * per + per);
  drawText(frame, backend, pages > 1 ? `${header}  ${page + 1}/${pages}` : header, 12, BAR.top + 7, { size: 16, weight: 700 }, { level: W_LEVELS.label, maxWidth: 420 });
  drawText(frame, backend, clock, 568, BAR.top + 6, { size: 18, weight: 700 }, { align: "right", level: W_LEVELS.text });
  dashedLine(frame, 8, GRID.top - 2, 568, GRID.top - 2, W_LEVELS.grid, { dash: 3, gap: 3 });
  for (let column = 1; column < GRID.columns; column += 1) dashedLine(frame, column * TILE_W, GRID.top + 6, column * TILE_W, GRID.bottom - 6, W_LEVELS.grid, { dash: 2, gap: 4 });
  dashedLine(frame, 8, GRID.top + TILE_H, 568, GRID.top + TILE_H, W_LEVELS.grid, { dash: 2, gap: 4 });
  shown.forEach((tile, index) => drawTile(frame, backend, tile, index, page * per + index === selected, now));
  dashedLine(frame, 8, GRID.bottom + 4, 568, GRID.bottom + 4, W_LEVELS.grid, { dash: 3, gap: 3 });
  drawText(frame, backend, hint, 12, HINT_Y, { size: 14, weight: 600 }, { level: W_LEVELS.label, maxWidth: 552 });
  return frame;
}
