// Builds src/radar/map-data.ts: the offline base map under the radar
// (country borders, coastline, larger lakes, major rivers, places with names) for Europe,
// cut from Natural Earth (public domain, https://www.naturalearthdata.com).
//
//   node scripts/build-map-data.mjs <folder with the Natural Earth GeoJSON files>
//
// Needed files (from github.com/nvkelso/natural-earth-vector, folder geojson/):
//   ne_10m_admin_0_boundary_lines_land.geojson, ne_10m_coastline.geojson,
//   ne_10m_lakes.geojson, ne_10m_rivers_lake_centerlines.geojson,
//   ne_10m_populated_places.geojson
//
// Lines are projected to Web-Mercator pixels at the radar zoom (7), simplified
// to half a pixel and stored as delta-encoded polylines (Google's polyline
// alphabet, characters 63…126, one line per space-separated word). Places keep
// their German and English names and their population.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const folder = process.argv[2];
if (!folder) { console.error("usage: node scripts/build-map-data.mjs <natural-earth-geojson-folder>"); process.exit(1); }
const out = resolve(import.meta.dirname, "../src/radar/map-data.ts");

const ZOOM = 7;
const SIZE = 256 * 2 ** ZOOM;
/** Europe from Portugal to the Black Sea, Sicily to Stockholm. */
const BOX = { west: -11, east: 32, south: 35, north: 61 };
const TOLERANCE = 0.5;

const read = (name) => JSON.parse(readFileSync(join(folder, `${name}.geojson`), "utf8"));
const project = ([lon, lat]) => {
  const r = (lat * Math.PI) / 180;
  return [((lon + 180) / 360) * SIZE, ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * SIZE];
};
const inBox = ([lon, lat], margin = 0.3) => lon >= BOX.west - margin && lon <= BOX.east + margin && lat >= BOX.south - margin && lat <= BOX.north + margin;

/** Runs of a line that lie inside the box (the first point outside is kept so lines reach the edge). */
function clip(coords) {
  const runs = []; let run = [];
  for (const point of coords) {
    if (inBox(point)) run.push(point);
    else if (run.length) { run.push(point); runs.push(run); run = []; }
  }
  if (run.length) runs.push(run);
  return runs;
}

function simplify(points, tolerance) {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length); keep[0] = 1; keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = points[a]; const [bx, by] = points[b];
    const dx = bx - ax; const dy = by - ay; const len = Math.hypot(dx, dy) || 1;
    let worst = -1; let at = -1;
    for (let i = a + 1; i < b; i += 1) {
      const [px, py] = points[i];
      const d = len === 1 && dx === 0 && dy === 0 ? Math.hypot(px - ax, py - ay) : Math.abs(dy * px - dx * py + bx * ay - by * ax) / len;
      if (d > worst) { worst = d; at = i; }
    }
    if (worst > tolerance) { keep[at] = 1; stack.push([a, at], [at, b]); }
  }
  return points.filter((_, i) => keep[i]);
}

const encodeNumber = (value) => {
  let v = value < 0 ? ~(value << 1) : value << 1; let s = "";
  while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
  return s + String.fromCharCode(v + 63);
};

/** Projected, simplified, whole-pixel polylines of a set of lon/lat lines; tiny ones are dropped. */
function lines(coordLists, minExtent) {
  const result = [];
  for (const coords of coordLists) for (const run of clip(coords)) {
    const pixels = simplify(run.map(project), TOLERANCE).map(([x, y]) => [Math.round(x), Math.round(y)])
      .filter((p, i, all) => i === 0 || p[0] !== all[i - 1][0] || p[1] !== all[i - 1][1]);
    if (pixels.length < 2) continue;
    const xs = pixels.map((p) => p[0]); const ys = pixels.map((p) => p[1]);
    if (Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) < minExtent) continue;
    result.push(pixels);
  }
  return result;
}
const encodeLines = (list) => list.map((pixels) => {
  let px = 0; let py = 0; let s = "";
  for (const [x, y] of pixels) { s += encodeNumber(x - px) + encodeNumber(y - py); px = x; py = y; }
  return s;
}).join(" ");

const coordsOf = (geometry) => {
  if (!geometry) return [];
  if (geometry.type === "LineString") return [geometry.coordinates];
  if (geometry.type === "MultiLineString") return geometry.coordinates;
  if (geometry.type === "Polygon") return geometry.coordinates;
  if (geometry.type === "MultiPolygon") return geometry.coordinates.flat();
  return [];
};
const allCoords = (collection, keep = () => true) => collection.features.filter((f) => keep(f.properties ?? {})).flatMap((f) => coordsOf(f.geometry));

const borders = lines(allCoords(read("ne_10m_admin_0_boundary_lines_land")), 2);
const coast = lines(allCoords(read("ne_10m_coastline")), 4);
// Lakes: only the natural and reservoir lakes big enough to read as a shape (about 5 km).
const lakes = lines(allCoords(read("ne_10m_lakes"), (p) => /lake|reservoir/i.test(p.featurecla ?? "")), 6);

// Rivers: the big ones only (Natural Earth scale rank up to 8: Danube, Rhine, Inn, Main, Drau, Mur …).
const rivers = lines(allCoords(read("ne_10m_rivers_lake_centerlines"), (p) => Number(p.scalerank) <= 8), 6);

const places = read("ne_10m_populated_places").features.map((f) => f.properties).filter((p) => inBox([p.LONGITUDE, p.LATITUDE], 0))
  .map((p) => {
    const [x, y] = project([p.LONGITUDE, p.LATITUDE]);
    const de = String(p.NAME_DE || p.NAME).trim(); const en = String(p.NAME_EN || p.NAME).trim();
    return { de, en, x: Math.round(x), y: Math.round(y), pop: Math.max(1, Math.round((p.POP_MAX ?? 0) / 1000)) };
  })
  .filter((p) => p.de && !/[|\n]/.test(p.de + p.en))
  .sort((a, b) => b.pop - a.pop);
const placeText = places.map((p) => [p.de, p.en === p.de ? "" : p.en, p.x, p.y, p.pop].join("|")).join("\n");

const header = `/**
 * Offline base map for the radar page, generated by scripts/build-map-data.mjs
 * from Natural Earth 1:10m (public domain, https://www.naturalearthdata.com):
 * country borders, coastline, larger lakes, major rivers and populated places for Europe
 * (${BOX.west}…${BOX.east} E, ${BOX.south}…${BOX.north} N). Do not edit by hand.
 *
 * Lines are Web-Mercator pixels at zoom ${ZOOM}, delta-encoded in Google's polyline
 * alphabet, one line per space-separated word. Places: "German|English (if
 * different)|x|y|population in thousands", most populous first.
 */
`;
const body = `export const MAP_ZOOM = ${ZOOM};
export const BORDERS = ${JSON.stringify(encodeLines(borders))};
export const COAST = ${JSON.stringify(encodeLines(coast))};
export const LAKES = ${JSON.stringify(encodeLines(lakes))};
export const RIVERS = ${JSON.stringify(encodeLines(rivers))};
export const PLACES = ${JSON.stringify(placeText)};
`;
writeFileSync(out, header + body);
const kb = (s) => (Buffer.byteLength(s) / 1024).toFixed(1);
console.log(`borders ${borders.length} lines ${kb(encodeLines(borders))} KB, coast ${coast.length} ${kb(encodeLines(coast))} KB, lakes ${lakes.length} ${kb(encodeLines(lakes))} KB, rivers ${rivers.length} ${kb(encodeLines(rivers))} KB, places ${places.length} ${kb(placeText)} KB, file ${kb(header + body)} KB`);
